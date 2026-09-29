import { useSyncExternalStore } from 'react';
import { invokeCommand } from '../native/commands';
import { listen } from '@tauri-apps/api/event';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import type { MachineTelemetry, SettingsEdit, Spend, SpendGroup, TelemetryStatus } from '../native/types';
import { machineName } from './machineNames';
import { savedStore } from './savedStore';

/**
 * Claude Code's own telemetry, received by Arbor (see `telemetry.rs`): what each session spends by skill, plugin, MCP
 * server and subagent. Only metrics are asked for, so only names and counts arrive.
 */

export const AGENT_TELEMETRY_UPDATED_EVENT = 'agent-telemetry-updated';
export const DEFAULT_TELEMETRY_PORT = 8319;

export const getAgentTelemetry = () => invokeCommand('get_agent_telemetry');
export const setAgentTelemetry = (enabled: boolean, port: number) => invokeCommand('set_agent_telemetry', { enabled, port });
/** Sets Claude Code up to send its metrics to Arbor on every home of a machine, or takes that away. A plan only says what would change. */
export const setMachineTelemetry = (machine: string, enabled: boolean, plan = false) =>
  invokeCommand('set_machine_telemetry', { machine, enabled, plan });
export const getTelemetryBreakdown = (fromMs: number, toMs: number, machine: string | null) =>
  invokeCommand('get_agent_telemetry_breakdown', { fromMs, toMs, machine });

// ---------------------------------------------------------------------------
// One status for every page that shows it
// ---------------------------------------------------------------------------

type Snapshot = { status: TelemetryStatus | null; error: string | null };
let snapshot: Snapshot = { status: null, error: null };
const listeners = new Set<() => void>();
let started = false;

const publish = (next: Snapshot) => {
  snapshot = next;
  for (const listener of listeners) listener();
};

/** Reads the receiver's status again. */
export async function reloadAgentTelemetry() {
  try {
    publish({ status: await getAgentTelemetry(), error: null });
  } catch (error) {
    publish({ status: snapshot.status, error: String(error) });
  }
}

/** Takes a status a command already returned. */
export const takeAgentTelemetry = (status: TelemetryStatus) => publish({ status, error: null });

function start() {
  if (started) return;
  started = true;
  void reloadAgentTelemetry();
  void listen(AGENT_TELEMETRY_UPDATED_EVENT, () => void reloadAgentTelemetry()).catch(() => undefined);
}

const subscribe = (listener: () => void) => {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The receiver's status, kept current while anything shows it. */
export const useAgentTelemetry = () => useSyncExternalStore(subscribe, () => snapshot);

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

/** A machine that hasn't sent anything for this long, while set up, is worth a look. */
export const TELEMETRY_QUIET_MS = 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// How far back Sync › Cost counts it
// ---------------------------------------------------------------------------

/** The days Sync › Cost can count Claude Code's spend over: a day, a week or a month. */
export const TELEMETRY_SPANS = [1, 7, 30] as const;
export type TelemetrySpan = (typeof TELEMETRY_SPANS)[number];
const DEFAULT_SPAN: TelemetrySpan = 7;
const DAY_MS = 86_400_000;

export const isTelemetrySpan = (value: unknown): value is TelemetrySpan => TELEMETRY_SPANS.some((span) => span === value);

/**
 * The times a span counts between: its days up to now, and an hour past it, so a send that lands while the page is
 * open is counted without waiting for the clock to catch up.
 */
export const telemetryWindow = (span: TelemetrySpan, nowMs: number) => ({ fromMs: nowMs - span * DAY_MS, toMs: nowMs + 60 * 60_000 });

/** The span last picked, or a week. */
export const parseTelemetrySpan = (raw: string | null): TelemetrySpan => {
  const saved = Number(raw);
  return isTelemetrySpan(saved) ? saved : DEFAULT_SPAN;
};

const span = savedStore<TelemetrySpan>({ key: 'cpa-gui.setup.cost-span.v1', parse: parseTelemetrySpan, fallback: DEFAULT_SPAN, serialize: String });

export const useTelemetrySpan = span.useValue;
export const setTelemetrySpan = span.set;

/**
 * - `off`: not set up.
 * - `waiting`: set up, nothing received yet (Claude Code sends once a minute while a session runs).
 * - `receiving`: something arrived in the last day.
 * - `quiet`: nothing for a day, which is fine when nobody used it.
 * - `stopped`: set up, but the receiver is off.
 */
export type MachineTelemetryState = 'off' | 'waiting' | 'receiving' | 'quiet' | 'stopped';

export function machineTelemetryState(status: TelemetryStatus | null, machine: string, nowMs: number): { state: MachineTelemetryState; entry: MachineTelemetry | null } {
  const entry = status?.machines.find((candidate) => candidate.machine === machine) ?? null;
  if (!status || !entry) return { state: 'off', entry };
  if (!status.enabled) return { state: 'stopped', entry };
  if (entry.lastMs === null) return { state: 'waiting', entry };
  return { state: nowMs - entry.lastMs <= TELEMETRY_QUIET_MS ? 'receiving' : 'quiet', entry };
}

/** A machine set up that has to be set up again before Arbor can use what it sends, or get it at all. */
export const telemetryNeedsSetup = (entry: MachineTelemetry | null) => Boolean(entry && (entry.cumulative || entry.stalePort !== null));

export const totalTokens = (spend: Spend) => spend.inputTokens + spend.outputTokens + spend.cacheReadTokens + spend.cacheCreationTokens;

export type SpendDimension = 'skills' | 'plugins' | 'mcpServers' | 'agents' | 'sources' | 'models' | 'machines' | 'versions';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/**
 * The words Claude Code puts in place of a name it keeps back. Without its tool-detail switch, which Arbor leaves off,
 * the user's own MCP servers and subagents arrive as `custom` and plugins from other marketplaces as `third-party`.
 */
const STAND_INS: Partial<Record<SpendDimension, Record<string, MessageKey>>> = {
  skills: { 'third-party': 'telemetry.name.thirdPartySkills' },
  plugins: { 'third-party': 'telemetry.name.thirdPartyPlugins' },
  mcpServers: { custom: 'telemetry.name.customServers' },
  agents: { custom: 'telemetry.name.customAgents' },
  sources: { main: 'telemetry.name.main', subagent: 'telemetry.name.subagent', auxiliary: 'telemetry.name.auxiliary', '': 'telemetry.name.unknown' },
};

/** What a group is called on the page, and whether that's a name Claude Code kept back. */
export function spendName(dimension: SpendDimension, name: string, t: Translate): { text: string; hidden: boolean } {
  const key = STAND_INS[dimension]?.[name];
  if (key) return { text: t(key), hidden: dimension !== 'sources' };
  if (dimension === 'machines' && name) return { text: machineName(name), hidden: false };
  return { text: name || t('telemetry.name.unknown'), hidden: false };
}

/** Each group's share of the total cost, 0 to 1, or of tokens when nothing was priced. */
export function spendShares(groups: SpendGroup[], total: Spend): number[] {
  const byCost = total.cost > 0;
  const whole = byCost ? total.cost : totalTokens(total);
  return groups.map((group) => (whole > 0 ? Math.min(1, (byCost ? group.cost : totalTokens(group)) / whole) : 0));
}

/** What setting a machine up, or taking it away, does to one settings file. */
export function telemetryPlanText(file: SettingsEdit, enabled: boolean, t: Translate) {
  if (file.error) return t('telemetry.plan.error', { error: file.error });
  if (file.change === 'none') return t(enabled ? 'telemetry.plan.none' : 'telemetry.plan.nothing');
  if (!enabled) return t('telemetry.plan.remove');
  return t(file.change === 'create' ? 'telemetry.plan.create' : 'telemetry.plan.add');
}
