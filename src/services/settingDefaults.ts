import { APP_PREFERENCE_DEFAULTS, setAppPreference, type AppPreferences } from '../appPreferences';
import type { MessageKey } from '../i18n/resources';

/**
 * What the core uses for a setting its config.yaml leaves out, as Arbor reads that file (src-tauri/src/core_config/
 * yaml.rs, and the DEFAULT_ constants in main.rs). Only these are offered a reset: a setting whose default Arbor
 * doesn't know for sure (a session's affinity time, which the core decides) has none. Nor has usage statistics: left
 * out, the core keeps them off, which stops Usage, so going back to that is no reset to offer.
 */
export const CORE_CONFIG_DEFAULTS = {
  host: '127.0.0.1',
  port: 8317,
  proxyUrl: '',
  debug: false,
  commercialMode: false,
  loggingToFile: false,
  logsMaxTotalSizeMb: 0,
  errorLogsMaxFiles: 10,
  redisUsageQueueRetentionSeconds: 60,
  routingStrategy: 'round-robin',
  routingSessionAffinity: false,
  disableCooling: false,
  requestRetry: 3,
  maxRetryCredentials: 0,
  maxRetryInterval: 30,
  streamingBootstrapRetries: 0,
  tlsEnabled: false,
} as const;

/** The app's own settings on Settings › Software, as a new install has them (GuiConfigFile::default in main.rs). */
export const SOFTWARE_DEFAULTS = {
  closeBehavior: 'ask',
  autostartEnabled: false,
  startCoreOnLaunch: true,
  silentStartEnabled: false,
} as const;

type Value = string | number | boolean;

/**
 * Whether a setting's value differs from its default. A field's text counts by what it says: `" 3"` and `"03"` are
 * 3, and an empty number field isn't any number.
 */
export function differsFromDefault(value: Value, fallback: Value): boolean {
  if (typeof fallback === 'number') {
    if (typeof value === 'number') return value !== fallback;
    const text = String(value).trim();
    return text === '' || Number(text) !== fallback;
  }
  if (typeof fallback === 'string') return String(value).trim() !== fallback;
  return value !== fallback;
}

/** How many of a group's settings differ from their defaults, each given as its value and its default. */
export const changedFromDefaults = (settings: readonly (readonly [Value, Value])[]) =>
  settings.filter(([value, fallback]) => differsFromDefault(value, fallback)).length;

/** A reset a row offers: the default as it reads, for its tooltip, and what putting it back does. */
export type ResetOffer = { value: string; onReset: () => void; disabled?: boolean; /** In place of "Default: …", for a reset to something else (All machines' value). */ tooltip?: string };

/** The reset to offer while a value differs from its default; none while it's at it. */
export function resetOffer(value: Value, fallback: Value, label: string, onReset: () => void, disabled = false): ResetOffer | undefined {
  return differsFromDefault(value, fallback) ? { value: label, onReset, disabled } : undefined;
}

/** The reset for one of the app's preferences, which puts it back at once. */
export function preferenceReset<K extends keyof AppPreferences>(
  preferences: AppPreferences,
  key: K,
  label: (value: AppPreferences[K]) => string,
): ResetOffer | undefined {
  const fallback = APP_PREFERENCE_DEFAULTS[key];
  return resetOffer(preferences[key], fallback, label(fallback), () => setAppPreference(key, fallback));
}

/** How a switch's default reads in a reset's tooltip. */
export const onOffLabel = (t: (key: MessageKey) => string) => (on: boolean) => t(on ? 'settings.reset.on' : 'settings.reset.off');
