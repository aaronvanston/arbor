import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import { phoneAlertSecretsProblem, readPhoneAlertSecrets, savePhoneAlertSecret } from '../src/services/phoneAlerts';

const DAMAGED = 'The saved alert secrets in /Users/cam/.agent-app/phone-alert-secrets.json can’t be read.';
const NONE = { ntfyToken: false, pushoverUserKey: false, pushoverAppToken: false, telegramBotToken: false, webhookUrl: false };

// The commands are answered as the mock answers them, which wants a window to hang its answers on.
let originalWindow: PropertyDescriptor | undefined;
beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
});
afterEach(() => {
  clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('the phone alert secrets’ health', () => {
  it('is known once the secrets are read, before any is saved, and clears when they read again', async () => {
    mockCommands({ get_phone_alert_secrets: () => { throw DAMAGED; } });
    await expect(readPhoneAlertSecrets()).rejects.toBe(DAMAGED);
    expect(phoneAlertSecretsProblem()).toBe(DAMAGED);

    mockCommands({ get_phone_alert_secrets: () => NONE });
    await readPhoneAlertSecrets();
    expect(phoneAlertSecretsProblem()).toBe('');
  });

  it('clears once a secret is saved, which writes the file afresh', async () => {
    mockCommands({ get_phone_alert_secrets: () => { throw DAMAGED; } });
    await readPhoneAlertSecrets().catch(() => undefined);
    expect(phoneAlertSecretsProblem()).toBe(DAMAGED);

    mockCommands({ set_phone_alert_secret: () => ({ ...NONE, ntfyToken: true }) });
    await savePhoneAlertSecret('ntfyToken', 'tk_made_up');
    expect(phoneAlertSecretsProblem()).toBe('');
  });
});
