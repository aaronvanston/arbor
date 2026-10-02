import type { MessageKey } from '../i18n/resources';
import type { HarnessSetup, MachineAgents } from '../native/types';

/**
 * The harnesses a pool's run could be handed to on a machine, from its agents check (`agents.rs`): T3 Code and Orca,
 * each once it's found there, and the agents' own command lines as the last resort when neither is running. Arbor
 * hands a run over and links to it; the harness runs it.
 */

export type HarnessKind = 't3' | 'orca' | 'headless';

export type HarnessSetupRow = {
  id: string;
  /** Its own name, or null to show the driver's. */
  name: string | null;
  driver: MessageKey | null;
  /** The driver as the harness spells it, for one Arbor has no name for. */
  rawDriver: string;
  enabled: boolean;
};

export type MachineHarness = {
  kind: HarnessKind;
  version: string | null;
  /** Null for the agents' command lines, which run whenever they're called. */
  running: boolean | null;
  setups: HarnessSetupRow[];
};

export const HARNESS_LABEL: Record<HarnessKind, MessageKey> = {
  t3: 'harness.kind.t3',
  orca: 'harness.kind.orca',
  headless: 'harness.kind.headless',
};

/** T3 Code's drivers and Orca's agent ids, by the product each starts. */
const DRIVER_LABEL: Record<string, MessageKey> = {
  codex: 'harness.driver.codex',
  claudeAgent: 'harness.driver.claude',
  claude: 'harness.driver.claude',
  cursor: 'harness.driver.cursor',
  grok: 'harness.driver.grok',
  opencode: 'harness.driver.opencode',
  antigravity: 'harness.driver.antigravity',
  gemini: 'harness.driver.gemini',
};

const setupRow = (setup: Pick<HarnessSetup, 'id' | 'driver' | 'name' | 'enabled'>): HarnessSetupRow => ({
  id: setup.id, name: setup.name, driver: DRIVER_LABEL[setup.driver] ?? null, rawDriver: setup.driver, enabled: setup.enabled,
});

/** Every harness found on a machine, running ones first, then the agents' command lines when an agent is installed. */
export function machineHarnesses(agents: MachineAgents): MachineHarness[] {
  const found: MachineHarness[] = [];
  if (agents.t3) found.push({ kind: 't3', version: agents.t3.version, running: agents.t3.running, setups: agents.t3.setups.map(setupRow) });
  if (agents.orca) {
    found.push({
      kind: 'orca', version: agents.orca.version, running: agents.orca.running,
      setups: agents.orca.agents.map((agent) => setupRow({ id: agent, driver: agent, name: null, enabled: true })),
    });
  }
  found.sort((a, b) => Number(b.running) - Number(a.running));
  const headless = [agents.claude ? 'claude' : null, agents.codex ? 'codex' : null].filter((agent): agent is string => agent !== null);
  if (headless.length) {
    found.push({ kind: 'headless', version: null, running: null, setups: headless.map((agent) => setupRow({ id: agent, driver: agent, name: null, enabled: true })) });
  }
  return found;
}

/** Whether any harness on the machine could take a run now, the command lines aside. */
export const harnessReady = (harnesses: readonly MachineHarness[]) => harnesses.some((harness) => harness.kind !== 'headless' && harness.running);
