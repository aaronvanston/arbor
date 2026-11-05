import { authFileAvailability, parseAuthFilePriority } from './authFiles';
import { resolveAccountProfile, type AccountProfile } from './accountProfiles';
import type { PausedAccount } from './accountReserves';
import { getReservePolicies, reservePolicyFor, setReservePolicy, type ModelAccessState, type ReservePolicy } from './extraModelHold';
import { modelClaims, modelReserves, reserveAccounts, type AccountReserve, type ModelClaim } from './modelReserves';
import { applyRoutingPlan, getRoutingAuto, setRoutingAuto } from './quotaRouting';
import { fileName, providerForFile, quotaKey, type AuthFile, type QuotaProvider, type QuotaState } from './quotaService';
import { markActed, type RoutingLogEntry } from './routingLog';

/*
 * Accounts › Routing: where every account stands for routing right now, the claims extra models make on them, and
 * what each of Arbor's own routing changes can be met with.
 */

/**
 * Where an account stands for routing.
 * - `shared`: takes everyday requests; `reserved` does too, above a reserve it keeps for an extra model.
 * - `fenced`: at its reserve, serving only its models; `lending`: lending its reserve, as every other account is out.
 * - `out`: at a limit, or all but out of it. `paused`: turned off at its cap. `off`: turned off. `signin`: signed out.
 * - `unread`: no limit reading yet.
 */
export type RoutingStanding = 'shared' | 'reserved' | 'fenced' | 'lending' | 'out' | 'paused' | 'off' | 'signin' | 'unread';

export type OverviewAccount = {
  key: string;
  fileName: string;
  name: string;
  /** The core's priority; the highest usable one takes requests first. */
  priority: number;
  /** The share of its longest limit window left. */
  remaining: number | null;
  resetAtMs?: number;
  standing: RoutingStanding;
  reserve?: AccountReserve;
};

export type OverviewProvider = {
  provider: QuotaProvider;
  /** Whether automatic account order is on for it. */
  auto: boolean;
  accounts: OverviewAccount[];
  claims: ModelClaim[];
};

/**
 * Every provider's accounts in the order the core tries them (highest priority first), with where each stands and the
 * reserves its extra models claim. `files` is the core's listing, turned-off accounts included.
 */
export function routingOverview({ files, quotas, profiles, state, policies, paused, auto, nowMs }: {
  files: AuthFile[];
  quotas: Record<string, QuotaState>;
  profiles: Record<string, AccountProfile | undefined>;
  state: ModelAccessState;
  policies: Record<string, ReservePolicy>;
  /** Accounts turned off at their cap, by quota key. */
  paused: Record<string, PausedAccount>;
  auto: Record<string, boolean>;
  nowMs: number;
}): OverviewProvider[] {
  const byProvider = new Map<QuotaProvider, AuthFile[]>();
  files.forEach((file) => {
    const provider = providerForFile(file);
    if (provider) byProvider.set(provider, [...(byProvider.get(provider) ?? []), file]);
  });
  return [...byProvider].sort(([a], [b]) => a.localeCompare(b)).map(([provider, providerFiles]) => {
    const readings = reserveAccounts(providerFiles, quotas, nowMs);
    const byName = new Map(readings.map((reading) => [reading.name, reading]));
    const reserves = modelReserves(state, policies, provider, readings, nowMs);
    const accounts = providerFiles.map((file): OverviewAccount => {
      const key = quotaKey(file);
      const name = fileName(file);
      const reading = byName.get(name);
      const reserve = reserves.get(name);
      const availability = authFileAvailability(file, nowMs).kind;
      const standing: RoutingStanding = paused[key] ? 'paused'
        : availability === 'disabled' ? 'off'
          : availability === 'signin' ? 'signin'
            : reserve?.state === 'fenced' ? 'fenced'
              : reserve?.state === 'lending' ? 'lending'
                : reading?.out ? 'out'
                  : reading?.remaining === null || reading === undefined ? 'unread'
                    : reserve ? 'reserved' : 'shared';
      return {
        key,
        fileName: name,
        name: resolveAccountProfile(key, name, profiles[key]).name,
        priority: parseAuthFilePriority(file.priority) ?? 0,
        remaining: reading?.remaining ?? null,
        ...(reading?.resetAtMs !== undefined ? { resetAtMs: reading.resetAtMs } : {}),
        standing,
        ...(reserve ? { reserve } : {}),
      };
    }).sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
    return { provider, auto: auto[provider] ?? false, accounts, claims: modelClaims(state, policies, provider, readings, nowMs) };
  });
}

/** What a decision in the log can be met with, if anything. */
export type LogAction = 'stopReserving' | 'keepReserve' | 'putBack';

export function logActionFor(entry: RoutingLogEntry): LogAction | null {
  if (entry.acted) return null;
  if (entry.kind === 'fenced') return 'stopReserving';
  if (entry.kind === 'opened') return entry.why === 'lending' ? 'keepReserve' : null;
  return entry.changes.length > 0 ? 'putBack' : null;
}

/**
 * Takes a decision's action, and returns what undoes it.
 * - `stopReserving`: its models keep no reserve, so the account takes everyday requests again.
 * - `keepReserve`: its models keep their reserve even when every other account is out.
 * - `putBack`: the priorities as they were, with automatic order turned off so it doesn't change them again.
 */
export async function takeLogAction(entry: RoutingLogEntry, apply: typeof applyRoutingPlan = applyRoutingPlan): Promise<() => Promise<void>> {
  const action = logActionFor(entry);
  if (!action) return async () => {};
  if (entry.kind === 'order') {
    const wasAuto = getRoutingAuto()[entry.provider] ?? false;
    setRoutingAuto(entry.provider, false);
    await apply(entry.changes.map((change) => ({ fileName: change.fileName, suggested: change.from })));
    markActed(entry.id, true);
    return async () => {
      markActed(entry.id, false);
      // Back on, automatic order applies its own priorities again straight away.
      if (wasAuto) setRoutingAuto(entry.provider, true);
      else await apply(entry.changes.map((change) => ({ fileName: change.fileName, suggested: change.to })));
    };
  }
  const before = entry.models.map((model) => [model, reservePolicyFor(getReservePolicies(), entry.provider, model)] as const);
  entry.models.forEach((model) => setReservePolicy(entry.provider, model, action === 'stopReserving' ? { mode: 'never' } : { lend: 'hold' }));
  markActed(entry.id, true);
  return async () => {
    markActed(entry.id, false);
    before.forEach(([model, policy]) => setReservePolicy(entry.provider, model, policy));
  };
}
