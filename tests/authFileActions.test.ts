import { describe, expect, it } from 'bun:test';
import { authFileActions, primaryAuthFileAction, type AuthFileActions } from '../src/services/authFileActions';
import type { AuthFileAvailability } from '../src/services/authFiles';

const now = Date.parse('2026-09-16T07:20:00Z');
const codex = { name: 'codex-cam.json', provider: 'codex', source: 'file', account_type: 'oauth' };
const ready: AuthFileAvailability = { kind: 'ready' };

/** The row's actions as `id` or `id: reason`, the menu's groups split by `|`. */
const read = ({ primary, menu }: AuthFileActions) => ({
  primary: primary?.id ?? null,
  menu: menu.map((group) => group.map((item) => (item.unavailable ? `${item.id}: ${item.unavailable}` : item.id)).join(', ')).join(' | '),
});

describe('the fix a credential row offers up front', () => {
  it('is Sign In Again only for a rejected token, and Refresh Now while the core retries', () => {
    expect(primaryAuthFileAction(codex, { kind: 'signin', message: 'invalid_grant', reason: 'invalid_grant' })).toBe('reauth');
    expect(primaryAuthFileAction(codex, { kind: 'retrying', message: 'token expired', reason: 'token_expired' })).toBe('refresh');
    for (const availability of [
      { kind: 'ready' }, { kind: 'disabled' }, { kind: 'limit', retryAtMs: now + 60_000 },
      { kind: 'access', message: 'payment_required' }, { kind: 'unavailable', message: 'request failed' },
    ] as AuthFileAvailability[]) {
      expect(primaryAuthFileAction(codex, availability)).toBeNull();
    }
  });

  it('needs an OAuth credential file, and a provider the app can sign in to', () => {
    const signin: AuthFileAvailability = { kind: 'signin', message: 'unauthorized', reason: 'unauthorized' };
    const retrying: AuthFileAvailability = { kind: 'retrying', message: '' };
    for (const file of [
      { ...codex, runtime_only: true },
      { ...codex, account_type: 'api_key' },
      { ...codex, source: 'memory', path: '/auths/codex-cam.json' },
    ]) {
      expect(primaryAuthFileAction(file, signin)).toBeNull();
      expect(primaryAuthFileAction(file, retrying)).toBeNull();
    }
    const gemini = { name: 'gemini-ops.json', provider: 'gemini', source: 'file' };
    expect(primaryAuthFileAction(gemini, signin)).toBeNull();
    expect(primaryAuthFileAction(gemini, retrying)).toBe('refresh');
  });
});

describe('a credential row’s actions', () => {
  it('put reading the limits up front on a working account, with everything else in the menu and Delete last', () => {
    expect(read(authFileActions(codex, ready))).toEqual({
      primary: 'check-limits',
      menu: 'priority, cap | models, exclude-models, copy-name | reauth | disable, delete',
    });
  });

  it('put the fix up front when the credential needs one, and keep reading the limits in the menu', () => {
    expect(read(authFileActions(codex, { kind: 'signin', message: 'invalid_grant', reason: 'invalid_grant' }))).toEqual({
      primary: 'reauth',
      menu: 'check-limits, priority, cap | models, exclude-models, copy-name | disable, delete',
    });
    expect(read(authFileActions(codex, { kind: 'retrying', message: '' })).primary).toBe('refresh-credential');
  });

  it('put Enable up front on an account that’s off, and say why the rest wait for it', () => {
    expect(read(authFileActions({ ...codex, disabled: true }, { kind: 'disabled' }))).toEqual({
      primary: 'enable',
      menu: 'priority: authFiles.priority.disabledHint, cap'
        + ' | models: authFiles.menu.enableFirst, exclude-models: authFiles.menu.enableFirst, copy-name'
        + ' | reauth | delete',
    });
  });

  it('keep what a file the core only holds in memory can’t do, saying why, rather than leave it out', () => {
    const runtime = { name: 'runtime-gemini', provider: 'gemini', source: 'memory', runtime_only: true, account_type: 'api_key' };
    expect(read(authFileActions(runtime, ready))).toEqual({
      primary: null,
      menu: 'priority: authFiles.menu.fileOnly | models, exclude-models: authFiles.menu.fileOnly, copy-name'
        + ' | disable: authFiles.menu.fileOnly, delete: authFiles.menu.runtimeDelete',
    });
  });

  it('say a file that left the disk is on its way out', () => {
    const removed = { ...codex, source: 'memory', path: '/auths/codex-cam.json' };
    expect(read(authFileActions(removed, ready))).toEqual({
      primary: null,
      menu: 'check-limits: authFiles.menu.removed, priority: authFiles.menu.removed'
        + ' | models, exclude-models: authFiles.menu.removed, copy-name'
        + ' | disable: authFiles.menu.removed, delete: authFiles.menu.removed',
    });
  });

  it('offer no limits or cap for a provider without limits to read', () => {
    const gemini = { name: 'gemini-ops.json', provider: 'gemini', source: 'file' };
    expect(read(authFileActions(gemini, ready))).toEqual({
      primary: null,
      menu: 'priority | models, exclude-models, copy-name | disable, delete',
    });
  });
});
