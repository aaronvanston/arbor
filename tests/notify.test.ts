import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import { getAlertHistory, resetAlertHistory } from '../src/services/alertHistory';
import { notify, presentAlertsInApp, type InAppAlert, type SystemNotification } from '../src/services/notify';
import { setPhoneAlertSetting } from '../src/services/phoneAlerts';
import { itemAt } from './support/items';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

/** What reached the Mac's notifications, the phone, and Arbor's own window. */
let shownOnMac: string[] = [];
let sentToPhone: string[] = [];
let shownInApp: InAppAlert[] = [];
let stopInApp: (() => void) | null = null;

/** The window as the page sees it: showing or hidden, with focus or without. */
function windowIs({ visible, focused }: { visible: boolean; focused: boolean }) {
  Object.defineProperty(globalThis, 'document', {
    value: { visibilityState: visible ? 'visible' : 'hidden', hasFocus: () => focused },
    writable: true,
    configurable: true,
  });
}

class FakeNotification {
  static permission = 'granted';
  static requestPermission = async () => 'granted';
  constructor(title: string) {
    shownOnMac.push(title);
  }
}

const waiting: SystemNotification = {
  title: 'Codex is waiting for you',
  body: 'api · main on cedar-02',
  kind: 'agentWaiting',
  subject: { session: 's1', machine: 'cedar-02' },
};
const down: SystemNotification = { title: 'ci-01 is unreachable', body: 'No answer for 6m.', kind: 'machineDown', urgent: true, subject: { machine: 'ci-01' } };
const digest: SystemNotification = { title: 'Your week with Claude and Codex', body: '4.2B tokens.', kind: 'digest' };

/** Lets the phone sends, which run on their own, finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  shownOnMac = [];
  sentToPhone = [];
  shownInApp = [];
  Object.defineProperty(globalThis, 'window', { value: { Notification: FakeNotification }, writable: true, configurable: true });
  mockCommands({
    get_phone_alert_secrets: () => ({ ntfyToken: false, pushoverUserKey: false, pushoverAppToken: false, telegramBotToken: false, webhookUrl: false }),
    send_phone_alert: ({ alert }) => {
      sentToPhone.push(alert.title);
      return null;
    },
  });
  setPhoneAlertSetting('service', 'ntfy');
  setPhoneAlertSetting('ntfyTopic', 'arbor-test');
  stopInApp = presentAlertsInApp((alerts) => shownInApp.push(...alerts));
});

afterEach(() => {
  stopInApp?.();
  setPhoneAlertSetting('service', 'off');
  setPhoneAlertSetting('ntfyTopic', '');
  setPhoneAlertSetting('mutedTopics', []);
  resetAlertHistory();
  clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
});

describe('where alerts show', () => {
  it('shows them in Arbor’s window while it’s in front, and still sends them to the phone', async () => {
    windowIs({ visible: true, focused: true });
    await notify([waiting, down]);
    await settle();
    expect(shownInApp.map((alert) => alert.title)).toEqual([waiting.title, down.title]);
    // Each with its entry in the history, so its toast can be replaced by a repeat's.
    expect(shownInApp.map((alert) => alert.id)).toEqual(getAlertHistory().entries.map((entry) => entry.id));
    expect(shownOnMac).toEqual([]);
    expect(sentToPhone).toEqual([waiting.title, down.title]);
    expect(getAlertHistory().entries.map((entry) => [entry.mac, entry.phone])).toEqual([['app', null], ['app', null]]);
  });

  it('sends them to the Mac while the window is in the background, hidden, or can’t show them', async () => {
    windowIs({ visible: true, focused: false });
    await notify([waiting]);
    windowIs({ visible: false, focused: true });
    await notify([down]);
    windowIs({ visible: true, focused: true });
    stopInApp?.();
    await notify([digest]);
    expect(shownInApp).toEqual([]);
    expect(shownOnMac).toEqual([waiting.title, down.title, digest.title]);
    expect(getAlertHistory().entries.map((entry) => entry.mac)).toEqual(['shown', 'shown', 'shown']);
  });

  it('falls back to the Mac when the window fails to show them', async () => {
    windowIs({ visible: true, focused: true });
    stopInApp?.();
    stopInApp = presentAlertsInApp(() => {
      throw new Error('toasts are down');
    });
    await notify([down]);
    expect(shownOnMac).toEqual([down.title]);
    expect(getAlertHistory().entries.map((entry) => entry.mac)).toEqual(['shown']);
  });

  it('sends the phone only the kinds it’s set to take', async () => {
    windowIs({ visible: true, focused: false });
    setPhoneAlertSetting('mutedTopics', ['needsYou', 'digest']);
    await notify([waiting, down, digest]);
    await settle();
    expect(sentToPhone).toEqual([down.title]);
    expect(shownOnMac).toEqual([waiting.title, down.title, digest.title]);
    // Kept off the phone reads like phone alerts being off: nothing noted.
    expect(getAlertHistory().entries.map((entry) => entry.phone)).toEqual([undefined, null, undefined]);
  });

  it('counts a repeat in the history without showing or sending it again', async () => {
    windowIs({ visible: true, focused: true });
    await notify([down]);
    await notify([{ ...down, body: 'No answer for 8m.' }]);
    windowIs({ visible: true, focused: false });
    await notify([down]);
    await settle();
    expect(shownInApp.map((alert) => alert.title)).toEqual([down.title]);
    expect(shownOnMac).toEqual([]);
    expect(sentToPhone).toEqual([down.title]);
    expect(getAlertHistory().entries).toHaveLength(1);
    expect(itemAt(getAlertHistory().entries, 0)).toMatchObject({ count: 3, mac: 'app', phone: null });
  });

  it('shows and sends every alert of an agent that needs you, however close together', async () => {
    windowIs({ visible: true, focused: true });
    const elsewhere: SystemNotification = { ...waiting, body: 'web · main on cedar-02', subject: { machine: 'cedar-02' } };
    await notify([elsewhere]);
    await notify([{ ...elsewhere, body: 'docs · main on cedar-02' }]);
    await settle();
    expect(shownInApp.map((alert) => alert.body)).toEqual(['web · main on cedar-02', 'docs · main on cedar-02']);
    expect(sentToPhone).toEqual([waiting.title, waiting.title]);
    expect(getAlertHistory().entries).toHaveLength(2);
  });
});
