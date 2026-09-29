import { describe, expect, it } from 'bun:test';
import type { AppPreferences } from '../src/appPreferences';
import { deliverPhoneAlerts, movePhoneAlertSecrets, NO_PHONE_ALERT_SECRETS, PHONE_ALERT_TOPICS, phoneAlertRoute, phoneAlertSendRoute, phoneTakes, randomNtfyTopic, readPhoneAlertSettings, storedPhoneAlertSettings, topicRaisedHere, withPhoneTopic, type PhoneAlert, type PhoneAlertSettings } from '../src/services/phoneAlerts';
import type { PhoneAlertRoute, PhoneAlertSecret } from '../src/native/types';

const settings: PhoneAlertSettings = {
  service: 'off',
  ntfyServer: 'https://ntfy.sh',
  ntfyTopic: '',
  telegramChatId: '',
  mutedTopics: [],
};
const alert = (title: string): PhoneAlert => ({ title, body: `${title} body`, kind: 'test', urgent: false });
const KEY = 'cpa-gui.phone-alerts.v1';

/** The window's storage, as a map. */
function memoryStorage(initial?: Record<string, unknown>) {
  const items = new Map<string, string>(initial ? [[KEY, JSON.stringify(initial)]] : []);
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    stored: () => (items.has(KEY) ? JSON.parse(items.get(KEY)!) : null),
  };
}

/** Settings as a version before the move kept them, secrets and all. */
const earlier = {
  service: 'telegram',
  ntfyServer: 'https://ntfy.sh',
  ntfyTopic: 'arbor-x',
  ntfyToken: '',
  pushoverUserKey: 'u-key',
  pushoverAppToken: '',
  telegramBotToken: '123:secret',
  telegramChatId: '42',
  webhookUrl: 'https://hooks.example/T0/secret',
};

describe('phone alerts', () => {
  it('makes a route of the settings once the chosen service has what it needs', () => {
    const none = NO_PHONE_ALERT_SECRETS;
    const all = { ntfyToken: true, pushoverUserKey: true, pushoverAppToken: true, telegramBotToken: true, webhookUrl: true };
    expect(phoneAlertRoute(settings, all)).toBeNull();
    expect(phoneAlertRoute({ ...settings, service: 'ntfy' }, all)).toBeNull();
    // ntfy's token is optional, so it works with nothing saved.
    expect(phoneAlertRoute({ ...settings, service: 'ntfy', ntfyServer: ' ', ntfyTopic: ' arbor-x ' }, none))
      .toEqual({ service: 'ntfy', server: 'https://ntfy.sh', topic: 'arbor-x' });
    expect(phoneAlertRoute({ ...settings, service: 'pushover' }, { ...none, pushoverUserKey: true })).toBeNull();
    expect(phoneAlertRoute({ ...settings, service: 'pushover' }, { ...none, pushoverUserKey: true, pushoverAppToken: true }))
      .toEqual({ service: 'pushover' });
    expect(phoneAlertRoute({ ...settings, service: 'telegram', telegramChatId: ' 42 ' }, none)).toBeNull();
    expect(phoneAlertRoute({ ...settings, service: 'telegram', telegramChatId: ' ' }, all)).toBeNull();
    expect(phoneAlertRoute({ ...settings, service: 'telegram', telegramChatId: ' 42 ' }, { ...none, telegramBotToken: true }))
      .toEqual({ service: 'telegram', chatId: '42' });
    expect(phoneAlertRoute({ ...settings, service: 'webhook' }, none)).toBeNull();
    expect(phoneAlertRoute({ ...settings, service: 'webhook' }, { ...none, webhookUrl: true })).toEqual({ service: 'webhook' });
    // Another service's secrets don't count.
    expect(phoneAlertRoute({ ...settings, service: 'webhook' }, { ...all, webhookUrl: false })).toBeNull();
  });

  it('still sends when the app can’t say which secrets it holds, so its reason is recorded', () => {
    // A damaged secrets file: the app reports why each send fails instead of alerts going nowhere unseen.
    expect(phoneAlertSendRoute({ ...settings, service: 'pushover' }, null)).toEqual({ service: 'pushover' });
    expect(phoneAlertSendRoute({ ...settings, service: 'telegram', telegramChatId: '42' }, null)).toEqual({ service: 'telegram', chatId: '42' });
    expect(phoneAlertSendRoute({ ...settings, service: 'webhook' }, null)).toEqual({ service: 'webhook' });
    // Once the app has said, only what's saved counts, and settings that aren't secret are still needed.
    expect(phoneAlertSendRoute({ ...settings, service: 'webhook' }, NO_PHONE_ALERT_SECRETS)).toBeNull();
    expect(phoneAlertSendRoute({ ...settings, service: 'telegram', telegramChatId: ' ' }, null)).toBeNull();
    expect(phoneAlertSendRoute(settings, null)).toBeNull();
  });

  it('reads only the settings that aren’t secret from storage, and keeps the rest of it when saving', () => {
    const raw = JSON.stringify(earlier);
    expect(readPhoneAlertSettings(raw)).toEqual({ service: 'telegram', ntfyServer: 'https://ntfy.sh', ntfyTopic: 'arbor-x', telegramChatId: '42', mutedTopics: [] });
    expect(readPhoneAlertSettings(JSON.stringify({ service: 'pager' }))).toEqual({ ...settings, service: 'off' });
    expect(readPhoneAlertSettings('not json')).toEqual(settings);
    expect(readPhoneAlertSettings(null)).toEqual(settings);
    // Secrets not yet handed to the app aren't lost when a setting changes.
    const next = { ...readPhoneAlertSettings(raw), telegramChatId: '43' };
    expect(JSON.parse(storedPhoneAlertSettings(raw, next))).toEqual({ ...earlier, telegramChatId: '43', mutedTopics: [] });
    expect(JSON.parse(storedPhoneAlertSettings(null, next))).toEqual(next);
  });

  it('hands secrets in storage to the app once, then drops them from storage', async () => {
    const storage = memoryStorage(earlier);
    const saved: [PhoneAlertSecret, string][] = [];
    const save = async (secret: PhoneAlertSecret, value: string) => void saved.push([secret, value]);

    expect(await movePhoneAlertSecrets(storage, save)).toEqual(['pushoverUserKey', 'telegramBotToken', 'webhookUrl']);
    // Empty ones aren't handed over, so they can't clear what the app has.
    expect(saved).toEqual([['pushoverUserKey', 'u-key'], ['telegramBotToken', '123:secret'], ['webhookUrl', 'https://hooks.example/T0/secret']]);
    expect(storage.stored()).toEqual({ service: 'telegram', ntfyServer: 'https://ntfy.sh', ntfyTopic: 'arbor-x', telegramChatId: '42' });

    // Running again changes nothing.
    expect(await movePhoneAlertSecrets(storage, save)).toEqual([]);
    expect(saved).toHaveLength(3);
    expect(storage.stored()).toEqual({ service: 'telegram', ntfyServer: 'https://ntfy.sh', ntfyTopic: 'arbor-x', telegramChatId: '42' });

    // Nothing stored, or storage that isn't settings, is left alone.
    const empty = memoryStorage();
    expect(await movePhoneAlertSecrets(empty, save)).toEqual([]);
    expect(empty.stored()).toBeNull();
    const damaged = memoryStorage();
    damaged.setItem(KEY, 'not json');
    expect(await movePhoneAlertSecrets(damaged, save)).toEqual([]);
    expect(damaged.getItem(KEY)).toBe('not json');
    expect(saved).toHaveLength(3);
  });

  it('leaves storage as it was when the app can’t take a secret, so the move is tried again', async () => {
    const storage = memoryStorage(earlier);
    let fail = true;
    const saved: PhoneAlertSecret[] = [];
    const save = async (secret: PhoneAlertSecret) => {
      if (fail && secret === 'telegramBotToken') throw 'Couldn’t save the alert secrets';
      saved.push(secret);
    };
    await expect(movePhoneAlertSecrets(storage, save)).rejects.toBe('Couldn’t save the alert secrets');
    expect(storage.stored()).toEqual(earlier);

    fail = false;
    expect(await movePhoneAlertSecrets(storage, save)).toEqual(['pushoverUserKey', 'telegramBotToken', 'webhookUrl']);
    expect(saved).toEqual(['pushoverUserKey', 'pushoverUserKey', 'telegramBotToken', 'webhookUrl']);
    expect(storage.stored()).not.toHaveProperty('telegramBotToken');
  });

  it('keeps a setting changed while the app was saving the secrets', async () => {
    const storage = memoryStorage(earlier);
    const save = async () => {
      storage.setItem(KEY, storedPhoneAlertSettings(storage.getItem(KEY), { ...readPhoneAlertSettings(storage.getItem(KEY)), service: 'webhook' }));
    };
    await movePhoneAlertSecrets(storage, save);
    expect(storage.stored()).toEqual({ service: 'webhook', ntfyServer: 'https://ntfy.sh', ntfyTopic: 'arbor-x', telegramChatId: '42', mutedTopics: [] });
  });

  it('sends alerts in order and carries on past one that fails', async () => {
    const route: PhoneAlertRoute = { service: 'webhook' };
    const sent: string[] = [];
    const send = async (_route: PhoneAlertRoute, item: PhoneAlert) => {
      sent.push(item.title);
      if (item.title === 'second') throw 'The webhook refused the alert (HTTP 500)';
    };
    let clock = 100;
    const results: [number, string | null][] = [];
    const last = await deliverPhoneAlerts(route, [alert('first'), alert('second'), alert('third')], send, () => clock++, (index, error) => results.push([index, error]));
    expect(sent).toEqual(['first', 'second', 'third']);
    expect(last).toEqual({ atMs: 102, error: null });
    // Each one's outcome, for the alert history.
    expect(results).toEqual([[0, null], [1, 'The webhook refused the alert (HTTP 500)'], [2, null]]);
    expect(await deliverPhoneAlerts(route, [alert('second')], send, () => 7))
      .toEqual({ atMs: 7, error: 'The webhook refused the alert (HTTP 500)' });
    expect(await deliverPhoneAlerts(route, [], send)).toBeNull();
  });

  it('sends the phone every kind of alert unless its topic is turned off', () => {
    expect(phoneTakes({ mutedTopics: [] }, 'agentWaiting')).toBe(true);
    expect(phoneTakes({ mutedTopics: ['needsYou'] }, 'agentWaiting')).toBe(false);
    expect(phoneTakes({ mutedTopics: ['needsYou'] }, 'agentPermission')).toBe(false);
    expect(phoneTakes({ mutedTopics: ['needsYou'] }, 'machineDown')).toBe(true);
    expect(phoneTakes({ mutedTopics: ['limits'] }, 'limitRecovered')).toBe(false);
    expect(phoneTakes({ mutedTopics: ['caps'] }, 'accountResumed')).toBe(false);
    // A test send always goes, whatever is off.
    expect(phoneTakes({ mutedTopics: [...PHONE_ALERT_TOPICS] }, 'test')).toBe(true);

    expect(withPhoneTopic([], 'digest', false)).toEqual(['digest']);
    expect(withPhoneTopic(['digest', 'heavy'], 'digest', true)).toEqual(['heavy']);
    expect(withPhoneTopic(['digest'], 'digest', false)).toEqual(['digest']);
  });

  it('reads which topics are off the phone, keeping only ones it knows', () => {
    expect(readPhoneAlertSettings(JSON.stringify({ mutedTopics: ['digest', 'somethingNew', 'limits', 'digest', 3] })).mutedTopics).toEqual(['limits', 'digest']);
    expect(readPhoneAlertSettings(JSON.stringify({ mutedTopics: 'digest' })).mutedTopics).toEqual([]);
    // Settings from before topics existed send everything, as they did.
    expect(readPhoneAlertSettings(JSON.stringify(earlier)).mutedTopics).toEqual([]);
  });

  it('knows which topics this Mac doesn’t raise at all', () => {
    const preferences = {
      limitNotifications: true,
      resetNotifications: true,
      expiringNotifications: false,
      reserveAlerts: true,
      heavySessionTokens: 0,
      archiveAlerts: true,
      providerStatus: false,
      outageNotifications: true,
      machineNotifications: true,
      setupChangeAlerts: false,
      agentPermissionAlerts: false,
      agentWaitingAlerts: true,
      weeklyDigest: false,
    } as AppPreferences;
    expect(PHONE_ALERT_TOPICS.filter((topic) => !topicRaisedHere(topic, preferences))).toEqual(['capacity', 'heavy', 'incidents', 'setup', 'digest']);
  });

  it('makes ntfy topics nobody would guess, within ntfy’s rules', () => {
    expect(randomNtfyTopic((bytes) => bytes.map((_, index) => index * 7))).toBe('arbor-ahov29gnu18fmt07');
    expect(randomNtfyTopic()).toMatch(/^arbor-[a-z0-9]{16}$/);
    expect(randomNtfyTopic()).not.toBe(randomNtfyTopic());
  });
});
