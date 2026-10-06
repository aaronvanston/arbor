import type { useI18n } from '../i18n';
import { homeLook } from '../services/setupInventory';

// Kept apart from SetupPage, which brings every Sync view with it, so a machine's page can link to a comparison without
// loading them.

const REFERENCE_KEY = 'arbor.setup.reference.v1';
const HOME_KEY = 'arbor.setup.home.v1';

const readStored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Choices are remembered where storage allows.
  }
};

/** The machine Checks compares the others with, as it was last picked there. */
export const storedSetupReference = () => readStored(REFERENCE_KEY);
/** The agent home whose table Checks shows, as it was last picked there. */
export const storedSetupHome = () => readStored(HOME_KEY);
export const storeSetupReference = (machine: string) => store(REFERENCE_KEY, machine);
export const storeSetupHome = (key: string) => store(HOME_KEY, key);

/** What the next Checks to open shows in its table; only for that one visit, so it's not stored. */
let pendingShow: string | null = null;

/**
 * Sets what Checks opens on, as picking them there would: the machine it compares with and the agent home whose table
 * it shows. For a link from elsewhere (a machine's page) that opens Checks on a comparison. `show` is one thing to
 * show in that table, as its Show in the table does: searched for, with matching copies too, and scrolled to.
 */
export function rememberSetupComparison({ reference, home, show }: { reference?: string | null; home?: string | null; show?: string }) {
  if (reference) storeSetupReference(reference);
  if (home) storeSetupHome(home);
  pendingShow = show ?? null;
}

/** The thing a link asked Checks to show, once. */
export function takeSetupShow() {
  const name = pendingShow;
  pendingShow = null;
  return name;
}

type Translate = ReturnType<typeof useI18n>['t'];

/** An agent home as Sync names it: Claude Code's, Codex's or the shared one, else its path. */
export function homeLabel(key: string, t: Translate) {
  const look = homeLook(key);
  switch (look.id) {
    case 'claude': return t('setup.home.claude');
    case 'codex': return t('setup.home.codex');
    case 'shared': return t('setup.home.shared');
    default: return look.path;
  }
}
