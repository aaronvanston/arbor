import type { CliCommands } from '../../native/cli';
import type { CliActivity, CliInstall, CliInstallState, CliSettings, SavedStoreSnapshot } from '../../native/types';
import type { CommandAnswers } from './answers';
import { freshInstall, hours, mockLog, params } from './scenario';

/**
 * `?cli=` picks where the arbor command stands: `missing` (not linked yet, the default on a fresh install),
 * `elsewhere` (linked to an Arbor that has moved), `taken` (something else is at ~/.local/bin/arbor), `dev` (a
 * development build, which can't be linked), `off` (command line control turned off) or `readonly` (changes turned off).
 */
const cliScenario = params.get('cli') ?? (freshInstall ? 'missing' : 'installed');

const EXECUTABLE = '/Applications/Arbor.app/Contents/MacOS/Arbor';
const LINK = '/Users/casey/.local/bin/arbor';

let installState: CliInstallState =
  cliScenario === 'missing' || cliScenario === 'elsewhere' || cliScenario === 'taken' ? cliScenario
    : cliScenario === 'dev' ? 'unavailable'
      : 'installed';

let cliSettings: CliSettings = { enabled: cliScenario !== 'off', changes: cliScenario !== 'readonly' };

const install = (): CliInstall => ({
  state: installState,
  linkPath: LINK,
  target: installState === 'installed' ? EXECUTABLE : installState === 'elsewhere' ? '/Users/casey/Downloads/Arbor.app/Contents/MacOS/Arbor' : null,
  executable: installState === 'unavailable' ? null : EXECUTABLE,
});

const activity = (): CliActivity[] => (freshInstall || installState !== 'installed' ? [] : [
  { at: hours(0.05), client: 'mcp', method: 'get_live_sessions', access: 'read', outcome: 'ok', ms: 14 },
  { at: hours(0.1), client: 'mcp', method: 'stop_core_process', access: 'confirm', outcome: 'plan', ms: 2 },
  { at: hours(0.4), client: 'cli', method: 'accounts.list', access: 'read', outcome: 'ok', ms: 380 },
  { at: hours(1.2), client: 'cli', method: 'get_machine_health', access: 'read', outcome: 'ok', ms: 21 },
  { at: hours(3), client: 'cli', method: 'saved_store_set', access: 'write', outcome: 'ok', ms: 6 },
]);

/** The app's copy of the window's settings is localStorage here, so the mock's seeds and `?fresh=1` work as before. */
const savedSnapshot = (): SavedStoreSnapshot => {
  const values: Record<string, string> = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    const value = key === null ? null : window.localStorage.getItem(key);
    if (key?.startsWith('arbor.') && value !== null) values[key] = value;
  }
  return { values, migrated: true };
};

export const cliAnswers: CommandAnswers<CliCommands> = {
  saved_store_snapshot: savedSnapshot,
  saved_store_set: ({ name, value }) => {
    if (value === null || value === undefined) window.localStorage.removeItem(name);
    else window.localStorage.setItem(name, value);
    return null;
  },
  saved_store_migrate: savedSnapshot,
  cli_bridge_ready: ({ actions }) => { mockLog('cli_bridge_ready', actions.map((action) => action.name)); return null; },
  cli_respond: (args) => { mockLog('cli_respond', args); return null; },
  get_cli_overview: () => ({ settings: cliSettings, install: install(), activity: activity() }),
  save_cli_settings: ({ settings }) => {
    mockLog('save_cli_settings', settings);
    cliSettings = settings;
    return cliSettings;
  },
  install_cli_link: () => {
    if (installState === 'unavailable') throw 'Only an installed Arbor, opened from Applications, can add the arbor command.';
    if (installState === 'taken') throw `Something else is already at ${LINK}, so Arbor left it alone.`;
    mockLog('install_cli_link', LINK);
    installState = 'installed';
    return { install: install() };
  },
};
