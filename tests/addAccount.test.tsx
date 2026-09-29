import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountsEmpty } from '../src/components/AccountsEmpty';
import { SidebarLimits } from '../src/components/SidebarLimits';
import { I18nProvider } from '../src/i18n';
import { accountsGap, getAccountsSnapshot, hasNoAccounts, loadAccountFiles, resetAccountsStore, type AccountsGap } from '../src/services/accountsStore';
import type { AuthFile } from '../src/services/quotaService';
import { coreReply, mockCommands } from '../src/dev/mock/answers';

let originalWindow: PropertyDescriptor | undefined;
let listing: AuthFile[] | 'offline';

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  listing = [];
  mockCommands({
    management_request: ({ request }) => {
      if (request.path !== '/auth-files') throw 'offline';
      if (listing === 'offline') throw 'The core didn’t answer';
      return coreReply({ files: listing });
    },
  });
});

afterEach(() => {
  resetAccountsStore();
  clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

const sidebar = () => renderToStaticMarkup(<I18nProvider><SidebarLimits onOpen={() => {}} onAddAccount={() => {}} /></I18nProvider>);
const card = (gap: Exclude<AccountsGap, 'loading'>, error?: string) => renderToStaticMarkup(
  <I18nProvider>
    <AccountsEmpty gap={gap} icon={null} description="Sign in to a provider to see its limits here." error={error} onRetry={() => {}} onNavigate={() => {}} />
  </I18nProvider>,
);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const empty = { loaded: true, error: '', files: [], disabled: [] };
const paused = { name: 'work.json', provider: 'claude', source: 'file', account_type: 'oauth', disabled: true } as AuthFile;
const on = { name: 'home.json', provider: 'codex', source: 'file', account_type: 'oauth', disabled: false } as AuthFile;

describe('adding an account', () => {
  it('is offered only once the core has listed no account, on or off', () => {
    expect(hasNoAccounts(empty)).toBe(true);
    expect(hasNoAccounts({ ...empty, loaded: false })).toBe(false);
    expect(hasNoAccounts({ ...empty, error: 'offline' })).toBe(false);
    expect(hasNoAccounts({ ...empty, disabled: [paused] })).toBe(false);
  });

  it('takes the sidebar’s limits slot while there are no accounts', async () => {
    expect(sidebar()).toBe('');
    await loadAccountFiles();
    expect(sidebar()).toContain('Add account');
  });

  it('isn’t offered when the list failed to load, or every account is turned off', async () => {
    listing = 'offline';
    await loadAccountFiles();
    expect(sidebar()).toBe('');
    listing = [paused];
    await loadAccountFiles();
    expect(sidebar()).toBe('');
  });
});

describe('a list of account limits with nothing to show', () => {
  it('says why: still loading, every account off, the list failed, or no account at all', () => {
    expect(accountsGap({ ...empty, loaded: false })).toBe('loading');
    expect(accountsGap(empty)).toBe('none');
    expect(accountsGap({ ...empty, disabled: [paused] })).toBe('off');
    expect(accountsGap({ ...empty, error: 'offline' })).toBe('failed');
    // Accounts an earlier listing found are still known when a later one fails.
    expect(accountsGap({ ...empty, error: 'offline', disabled: [paused] })).toBe('off');
    expect(accountsGap({ ...empty, files: [on], disabled: [paused] })).toBeNull();
    expect(accountsGap({ ...empty, loaded: false, files: [on] })).toBeNull();
  });

  it('reads the store the same way after each listing', async () => {
    listing = 'offline';
    await loadAccountFiles();
    expect(accountsGap(getAccountsSnapshot())).toBe('failed');
    listing = [paused];
    await loadAccountFiles();
    expect(accountsGap(getAccountsSnapshot())).toBe('off');
    listing = [];
    await loadAccountFiles();
    expect(accountsGap(getAccountsSnapshot())).toBe('none');
  });

  it('offers Add account only when there are none', () => {
    expect(text(card('none'))).toBe('No accounts yet Sign in to a provider to see its limits here. Add account');
    for (const html of [card('off'), card('failed', 'The core didn’t answer')]) {
      expect(html).not.toContain('No accounts yet');
      expect(html).not.toContain('Add account');
    }
  });

  it('points to Accounts, which lists the accounts that are off, when every account is off', () => {
    const html = text(card('off'));
    expect(html).toContain('Every account is off');
    expect(html).toContain('Turn one back on from Accounts');
    expect(html).toContain('Open Accounts');
  });

  it('says why the list didn’t load, with Try again', () => {
    expect(text(card('failed', 'The core didn’t answer'))).toBe('Accounts didn’t load The core didn’t answer Try again');
    // Where the page already shows the error, just the title and Try again.
    expect(text(card('failed'))).toBe('Accounts didn’t load Try again');
  });
});
