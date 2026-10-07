import { raisedAnywhere, type MachineOverrideMap, type MachineScopedKey, type ProjectOverrideMap } from './machineSettings';
import { invokeCommand } from '../native/commands';
import type { AppPreferences } from '../appPreferences';
import { savedStore, sharedStore } from './savedStore';
import type { PhoneAlert as NativePhoneAlert, PhoneAlertRoute, PhoneAlertSecret, PhoneAlertSecretStatus } from '../native/types';

export type PhoneService = 'off' | 'ntfy' | 'pushover' | 'telegram' | 'webhook';
export const PHONE_SERVICES: readonly PhoneService[] = ['off', 'ntfy', 'pushover', 'telegram', 'webhook'];
export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';

/** Where alerts go besides this Mac, kept with the window's preferences. The secrets are kept by the app instead. */
export type PhoneAlertSettings = {
  service: PhoneService;
  ntfyServer: string;
  /** Not a secret: you need to see it to subscribe. */
  ntfyTopic: string;
  telegramChatId: string;
  /** The topics kept off the phone. What's off is kept, not what's on, so a topic added later reaches the phone like the rest. */
  mutedTopics: PhoneAlertTopic[];
};

/**
 * The settings that are secrets. Webhook URLs count, since they usually carry a token.
 * The app keeps them in a file of its own; the window can save and clear them but only ever learns which are saved.
 */
export const PHONE_ALERT_SECRETS = ['ntfyToken', 'pushoverUserKey', 'pushoverAppToken', 'telegramBotToken', 'webhookUrl'] as const satisfies readonly PhoneAlertSecret[];
export const NO_PHONE_ALERT_SECRETS: PhoneAlertSecretStatus = {
  ntfyToken: false,
  pushoverUserKey: false,
  pushoverAppToken: false,
  telegramBotToken: false,
  webhookUrl: false,
};
const ALL_PHONE_ALERT_SECRETS: PhoneAlertSecretStatus = {
  ntfyToken: true,
  pushoverUserKey: true,
  pushoverAppToken: true,
  telegramBotToken: true,
  webhookUrl: true,
};

/** What raised an alert. Webhooks receive it as `kind`. */
export type AlertKind =
  | 'limitWarning'
  | 'limitCritical'
  | 'limitRecovered'
  | 'resetReady'
  | 'expiring'
  | 'heavySession'
  | 'outage'
  | 'machineDown'
  | 'machineUp'
  | 'setupChanged'
  | 'automationFailed'
  | 'archiveAway'
  | 'archiveFailing'
  | 'agentPermission'
  | 'agentWaiting'
  | 'accountPaused'
  | 'accountResumed'
  | 'digest'
  | 'proxySettings'
  | 'test';

/** An alert as the window sends it: the native side takes any kind, and the window only ever sends these. */
export type PhoneAlert = Omit<NativePhoneAlert, 'kind'> & { kind: AlertKind };

/** The kinds of alert, as the settings let each on or off the phone. */
export type PhoneAlertTopic = 'limits' | 'resets' | 'capacity' | 'caps' | 'heavy' | 'archive' | 'incidents' | 'proxy' | 'machines' | 'setup' | 'needsYou' | 'digest';
export const PHONE_ALERT_TOPICS: readonly PhoneAlertTopic[] = ['limits', 'resets', 'capacity', 'caps', 'heavy', 'archive', 'incidents', 'proxy', 'machines', 'setup', 'needsYou', 'digest'];
const TOPIC: Record<AlertKind, PhoneAlertTopic | null> = {
  limitWarning: 'limits',
  limitCritical: 'limits',
  limitRecovered: 'limits',
  resetReady: 'resets',
  expiring: 'capacity',
  accountPaused: 'caps',
  accountResumed: 'caps',
  heavySession: 'heavy',
  archiveAway: 'archive',
  archiveFailing: 'archive',
  outage: 'incidents',
  proxySettings: 'proxy',
  machineDown: 'machines',
  machineUp: 'machines',
  setupChanged: 'setup',
  automationFailed: 'machines',
  agentPermission: 'needsYou',
  agentWaiting: 'needsYou',
  digest: 'digest',
  // Test sends always go: they're how you check the phone gets anything.
  test: null,
};

/** Whether an alert of this kind goes to the phone: all do unless their topic is turned off. */
export function phoneTakes(settings: Pick<PhoneAlertSettings, 'mutedTopics'>, kind: AlertKind) {
  const topic = TOPIC[kind];
  return topic === null || !settings.mutedTopics.includes(topic);
}

/** Turns one topic on or off for the phone. */
export function withPhoneTopic(muted: readonly PhoneAlertTopic[], topic: PhoneAlertTopic, on: boolean): PhoneAlertTopic[] {
  const rest = muted.filter((item) => item !== topic);
  return on ? rest : [...rest, topic];
}

/**
 * Whether this Mac raises a topic's alerts at all, by its switches on Notifications. One that's off there doesn't
 * reach the phone either, whatever the phone's own switch says.
 */
export function topicRaisedHere(topic: PhoneAlertTopic, preferences: AppPreferences, overrides: MachineOverrideMap = {}, projects: ProjectOverrideMap = {}) {
  const anywhere = (key: MachineScopedKey) => raisedAnywhere(preferences, overrides, key, projects);
  switch (topic) {
    case 'limits': return preferences.limitNotifications;
    case 'resets': return preferences.resetNotifications;
    case 'capacity': return preferences.expiringNotifications;
    case 'caps': return preferences.reserveAlerts;
    case 'heavy': return anywhere('heavySessionTokens');
    case 'archive': return preferences.archiveAlerts;
    case 'incidents': return preferences.providerStatus && preferences.outageNotifications;
    // Nothing turns these off on this Mac: without the proxy's settings right, the rest of Arbor goes quiet.
    case 'proxy': return true;
    case 'machines': return anywhere('machineNotifications');
    case 'setup': return anywhere('setupChangeAlerts');
    case 'needsYou': return anywhere('agentPermissionAlerts') || anywhere('agentWaitingAlerts');
    case 'digest': return preferences.weeklyDigest;
  }
}

/** The route the settings describe, or null while phone alerts are off or something the service needs isn't there. */
export function phoneAlertRoute(settings: PhoneAlertSettings, saved: PhoneAlertSecretStatus): PhoneAlertRoute | null {
  const field = (key: 'ntfyServer' | 'ntfyTopic' | 'telegramChatId') => settings[key].trim();
  switch (settings.service) {
    case 'ntfy':
      return field('ntfyTopic') ? { service: 'ntfy', server: field('ntfyServer') || DEFAULT_NTFY_SERVER, topic: field('ntfyTopic') } : null;
    case 'pushover':
      return saved.pushoverUserKey && saved.pushoverAppToken ? { service: 'pushover' } : null;
    case 'telegram':
      return saved.telegramBotToken && field('telegramChatId') ? { service: 'telegram', chatId: field('telegramChatId') } : null;
    case 'webhook':
      return saved.webhookUrl ? { service: 'webhook' } : null;
    default:
      return null;
  }
}

/**
 * The route alerts are sent by. While the app can't say which secrets it holds, such as when their file is
 * damaged, they're taken as saved: the send is tried, and the app's reason it failed is recorded like any
 * other, rather than the alert going nowhere without a trace.
 */
export function phoneAlertSendRoute(settings: PhoneAlertSettings, saved: PhoneAlertSecretStatus | null): PhoneAlertRoute | null {
  return phoneAlertRoute(settings, saved ?? ALL_PHONE_ALERT_SECRETS);
}

/** A topic nobody would guess, since anyone who knows a topic on ntfy.sh can read it. */
export function randomNtfyTopic(random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return `arbor-${[...random(new Uint8Array(16))].map((byte) => alphabet[byte % alphabet.length]).join('')}`;
}

/** Whether the last alert got through, for the settings page. */
export type PhoneAlertDelivery = { atMs: number; error: string | null };

/** Hears how each alert went, by its place in the list: the error, or null once it got there. */
export type PhoneAlertResult = (index: number, error: string | null) => void;

type Send = (route: PhoneAlertRoute, alert: PhoneAlert) => Promise<void>;

/**
 * Sends the alerts one after another, so they arrive in order, and carries on past one that fails.
 * Returns how the last one went.
 */
export async function deliverPhoneAlerts(
  route: PhoneAlertRoute,
  alerts: PhoneAlert[],
  send: Send,
  now = Date.now,
  onResult?: PhoneAlertResult,
): Promise<PhoneAlertDelivery | null> {
  let delivery: PhoneAlertDelivery | null = null;
  for (const [index, alert] of alerts.entries()) {
    try {
      await send(route, alert);
      delivery = { atMs: now(), error: null };
    } catch (error) {
      console.warn('Failed to send an alert to the phone', error);
      delivery = { atMs: now(), error: String(error) };
    }
    onResult?.(index, delivery.error);
  }
  return delivery;
}

const STORAGE_KEY = 'arbor.phone-alerts.v1';
const defaults: PhoneAlertSettings = {
  service: 'off',
  ntfyServer: DEFAULT_NTFY_SERVER,
  ntfyTopic: '',
  telegramChatId: '',
  mutedTopics: [],
};
const TEXT_SETTINGS = ['service', 'ntfyServer', 'ntfyTopic', 'telegramChatId'] as const;

type Stored = Record<string, unknown>;
const parseStored = (raw: string | null): Stored => {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Stored) : {};
  } catch {
    return {};
  }
};

/** The settings in the window's storage. Secrets an earlier version kept there aren't among them. */
export function readPhoneAlertSettings(raw: string | null): PhoneAlertSettings {
  const stored = parseStored(raw);
  const next = { ...defaults };
  TEXT_SETTINGS.forEach((key) => {
    const value = stored[key];
    if (typeof value === 'string') (next as Record<string, unknown>)[key] = value;
  });
  const muted = stored.mutedTopics;
  // Only topics this version knows, once each and in the settings' order.
  next.mutedTopics = Array.isArray(muted) ? PHONE_ALERT_TOPICS.filter((topic) => muted.includes(topic)) : [];
  return PHONE_SERVICES.includes(next.service) ? next : { ...next, service: 'off' };
}

/** What goes back in storage for these settings. Anything else there, such as secrets not yet handed to the app, stays. */
export function storedPhoneAlertSettings(raw: string | null, settings: PhoneAlertSettings): string {
  return JSON.stringify({ ...parseStored(raw), ...settings });
}

type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;
type SaveSecret = (secret: PhoneAlertSecret, value: string) => Promise<unknown>;

/**
 * Hands secrets an earlier version kept in the window's storage to the app, then drops them from storage.
 * Storage is only rewritten once the app has them all, so a move that fails is tried again next time.
 * Returns the secrets it handed over.
 */
export async function movePhoneAlertSecrets(storage: SettingsStorage, save: SaveSecret): Promise<PhoneAlertSecret[]> {
  const stored = parseStored(storage.getItem(STORAGE_KEY));
  const present = PHONE_ALERT_SECRETS.filter((secret) => secret in stored);
  if (!present.length) return [];
  const moved: PhoneAlertSecret[] = [];
  for (const secret of present) {
    const value = stored[secret];
    // An empty one isn't handed over, so it can't clear one the app already has.
    if (typeof value !== 'string' || !value.trim()) continue;
    await save(secret, value);
    moved.push(secret);
  }
  // Read again: the settings may have changed while the app was saving. Only the secrets go.
  const current = parseStored(storage.getItem(STORAGE_KEY));
  PHONE_ALERT_SECRETS.forEach((secret) => delete current[secret]);
  storage.setItem(STORAGE_KEY, JSON.stringify(current));
  return moved;
}

const storageText = () => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const settings = savedStore<PhoneAlertSettings>({
  key: STORAGE_KEY,
  parse: readPhoneAlertSettings,
  fallback: defaults,
  serialize: (next) => storedPhoneAlertSettings(storageText(), next),
});
/** Which secrets the app holds, or null until it has said. */
const saved = sharedStore<PhoneAlertSecretStatus | null>(null);
const delivery = sharedStore<PhoneAlertDelivery | null>(null);
/**
 * Why the app couldn't say which secrets it holds (its secrets file is damaged, say), empty when it could: learned when
 * it's read, so the page says so on opening rather than only once a secret is saved.
 */
const secretsProblem = sharedStore('');

export const usePhoneAlertSettings = settings.useValue;
export const usePhoneAlertSecrets = saved.useValue;
export const usePhoneAlertSecretsProblem = secretsProblem.useValue;
export const phoneAlertSecretsProblem = secretsProblem.get;
export const usePhoneAlertDelivery = delivery.useValue;

export function setPhoneAlertSetting<K extends keyof PhoneAlertSettings>(key: K, value: PhoneAlertSettings[K]) {
  settings.set({ ...settings.get(), [key]: value });
}

/** Saves happen one at a time, and sends wait for them, so a test straight after typing uses what was typed. */
let secretWrites: Promise<unknown> = Promise.resolve();

/** Saves a secret in the app, or clears it when the value is empty. */
export function savePhoneAlertSecret(secret: PhoneAlertSecret, value: string): Promise<void> {
  const write = secretWrites
    .then(() => invokeCommand('set_phone_alert_secret', { secret, value }))
    .then((status) => {
      saved.set(status);
      secretsProblem.set('');
    });
  secretWrites = write.catch(() => undefined);
  return write;
}

let preparing: Promise<void> | null = null;

/**
 * Hands any secrets still in the window's storage to the app and learns which it holds.
 * Runs at startup; after a failure it's tried again next time it's asked for.
 */
export function preparePhoneAlerts(): Promise<void> {
  preparing ??= (async () => {
    let done = true;
    try {
      if (typeof localStorage !== 'undefined') await movePhoneAlertSecrets(localStorage, savePhoneAlertSecret);
    } catch (error) {
      console.warn('Failed to move the phone alert secrets to the app', error);
      done = false;
    }
    try {
      saved.set(await invokeCommand('get_phone_alert_secrets'));
      secretsProblem.set('');
    } catch (error) {
      console.warn('Failed to read which phone alert secrets are saved', error);
      secretsProblem.set(String(error));
      done = false;
    }
    if (!done) preparing = null;
  })();
  return preparing;
}

/** Sends one alert. The app adds the secrets, once any being saved are in. */
export const sendPhoneAlert: Send = async (route, alert) => {
  await secretWrites;
  await invokeCommand('send_phone_alert', { route, alert });
};

export function recordPhoneAlertDelivery(next: PhoneAlertDelivery | null) {
  if (next) delivery.set(next);
}

/** Whether an alert of this kind goes to the phone, by the settings now. */
export const phoneWants = (kind: AlertKind) => phoneTakes(settings.get(), kind);

/** Sends alerts to the phone as well, when that's set up. */
export async function sendPhoneAlerts(alerts: PhoneAlert[], onResult?: PhoneAlertResult) {
  if (!alerts.length || settings.get().service === 'off') return;
  await preparePhoneAlerts();
  const route = phoneAlertSendRoute(settings.get(), saved.get());
  if (!route) return;
  recordPhoneAlertDelivery(await deliverPhoneAlerts(route, alerts, sendPhoneAlert, Date.now, onResult));
}
