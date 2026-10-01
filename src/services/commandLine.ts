import type { MessageKey } from '../i18n/resources';
import type { CliActivity, CliInstall } from '../native/types';

/** Adds Arbor to Claude Code as an MCP server, through the arbor command. */
export const CLI_MCP_COMMAND = 'claude mcp add arbor -- arbor mcp';

/** What Settings says about the arbor link, and the button that fixes it when one can. */
export type CliInstallNote = { message: MessageKey; action: MessageKey | null; pathHint: boolean };

export function cliInstallNote(install: CliInstall): CliInstallNote {
  switch (install.state) {
    case 'installed':
      return { message: 'cli.install.installed', action: null, pathHint: true };
    case 'missing':
      return { message: 'cli.install.missing', action: 'cli.install.add', pathHint: false };
    case 'elsewhere':
      return { message: 'cli.install.elsewhere', action: 'cli.install.relink', pathHint: false };
    case 'taken':
      return { message: 'cli.install.taken', action: null, pathHint: false };
    case 'unavailable':
      return { message: 'cli.install.unavailable', action: null, pathHint: false };
  }
}

const OUTCOME: Record<CliActivity['outcome'], { label: MessageKey; tone: 'success' | 'warning' | 'error' | 'muted' }> = {
  ok: { label: 'cli.activity.outcome.ok', tone: 'success' },
  plan: { label: 'cli.activity.outcome.plan', tone: 'muted' },
  failed: { label: 'cli.activity.outcome.failed', tone: 'error' },
  canceled: { label: 'cli.activity.outcome.canceled', tone: 'muted' },
  core: { label: 'cli.activity.outcome.core', tone: 'error' },
  unsupported: { label: 'cli.activity.outcome.unsupported', tone: 'warning' },
  unavailable: { label: 'cli.activity.outcome.unavailable', tone: 'warning' },
};

/** How many of the latest requests Settings lists. */
const SHOWN = 8;

export type CliActivityRow = {
  key: string;
  at: number;
  client: MessageKey;
  method: string;
  outcome: MessageKey;
  tone: 'success' | 'warning' | 'error' | 'muted';
};

/** The latest requests as Settings lists them: when, from what, which command and how it went. */
export const cliActivityRows = (activity: CliActivity[]): CliActivityRow[] =>
  activity.slice(0, SHOWN).map((entry, index) => ({
    key: `${entry.at}-${index}`,
    at: entry.at,
    client: entry.client === 'mcp' ? 'cli.activity.client.mcp' : 'cli.activity.client.cli',
    method: entry.method.replace(/_/g, '-'),
    outcome: OUTCOME[entry.outcome].label,
    tone: OUTCOME[entry.outcome].tone,
  }));
