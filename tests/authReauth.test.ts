import { describe, expect, it } from 'bun:test';
import {
  completeReauth,
  listingAfterSignIn,
  matchReauthCredential,
  mergeReauthCredential,
  renamedCredentials,
  settleSignIn,
  type ReauthApi,
} from '../src/services/authReauth';
import type { AccountKeyRename } from '../src/services/accountKeys';
import { snapshotAuthFiles } from '../src/services/authFiles';
import type { ManagementJson } from '../src/services/managementApi';

const target = { name: 'CX-W1-casey.json', type: 'codex', email: 'casey@example.com', account_id: 'acct-1', priority: 10 };

/** `listings` is either one listing, or one per successive GET (the last repeats). */
const fast = { attempts: 3, pollMs: 0, sleep: async () => {} };

const fakeApi = (
  listings: Record<string, unknown>[] | Record<string, unknown>[][],
  contents: Record<string, Record<string, unknown>>,
) => {
  const pages = (Array.isArray(listings[0]) ? listings : [listings]) as Record<string, unknown>[][];
  const calls: { method: string; path: string; name?: string; text?: string }[] = [];
  let listCount = 0;
  const api: ReauthApi = {
    get: async (path, query) => {
      calls.push({ method: 'GET', path, name: query?.name });
      if (path === '/auth-files') {
        const files = pages[Math.min(listCount, pages.length - 1)];
        listCount += 1;
        return { files } as ManagementJson;
      }
      if (path === '/auth-files/download') return contents[query?.name ?? ''] as ManagementJson;
      return null;
    },
    delete: async (path, options) => {
      calls.push({ method: 'DELETE', path, name: options?.query?.name });
      return { ok: true };
    },
    uploadAuthFileText: async (name, text) => {
      calls.push({ method: 'UPLOAD', path: '/auth-files', name, text });
      return { status: 'ok' };
    },
  };
  return { api, calls };
};

describe('re-authenticating an existing credential', () => {
  it('matches the fresh credential by account id before falling back to email', () => {
    const byId = { name: 'codex-1.json', account_id: 'acct-1', email: 'other@example.com' };
    const byEmail = { name: 'codex-2.json', account_id: 'acct-9', email: 'CASEY@example.com' };
    expect(matchReauthCredential(target, [byEmail, byId])).toBe(byId);
    expect(matchReauthCredential(target, [byEmail])).toBe(byEmail);
    expect(matchReauthCredential(target, [{ name: 'codex-3.json', email: 'nobody@example.com' }])).toBeNull();
  });

  it('keeps user settings from the existing file while taking the new tokens', () => {
    const merged = mergeReauthCredential(
      { type: 'codex', access_token: 'old', refresh_token: 'old-r', priority: 10, disabled: true, excluded_models: ['x'], note: 'keep' },
      { type: 'codex', access_token: 'new', refresh_token: 'new-r', id_token: 'id', priority: 0, expired: '2027-01-01' },
    );
    expect(merged).toEqual({
      type: 'codex', access_token: 'new', refresh_token: 'new-r', id_token: 'id', expired: '2027-01-01',
      priority: 10, disabled: true, excluded_models: ['x'], note: 'keep',
    });
  });

  it('copies a differently named login into the existing file and removes the duplicate', async () => {
    const before = snapshotAuthFiles([target]);
    const fresh = { name: 'codex-abc-casey@example.com-pro.json', type: 'codex', email: 'casey@example.com', account_id: 'acct-1' };
    const { name: _targetName, ...targetContent } = target;
    const { name: _freshName, ...freshContent } = fresh;
    const { api, calls } = fakeApi([target, fresh], {
      [target.name]: { ...targetContent, access_token: 'old', excluded_models: ['gpt-x'] },
      [fresh.name]: { ...freshContent, access_token: 'new', refresh_token: 'new-r' },
    });
    const outcome = await completeReauth(target, 'codex', before, api, fast);
    expect(outcome).toEqual({ kind: 'transplanted', name: target.name, from: fresh.name });
    const upload = calls.find((call) => call.method === 'UPLOAD');
    expect(upload?.name).toBe(target.name);
    expect(JSON.parse(upload?.text ?? '{}')).toEqual({
      type: 'codex', email: 'casey@example.com', account_id: 'acct-1',
      access_token: 'new', refresh_token: 'new-r', priority: 10, excluded_models: ['gpt-x'],
    });
    expect(calls.find((call) => call.method === 'DELETE')?.name).toBe(fresh.name);
  });

  it('reports an in-place update without touching files when the core overwrote the same name', async () => {
    const before = snapshotAuthFiles([target]);
    const { api, calls } = fakeApi([{ ...target, last_refresh: 'now' }], {});
    expect(await completeReauth(target, 'codex', before, api, fast)).toEqual({ kind: 'in-place', name: target.name });
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('leaves everything alone when the sign-in belongs to a different account', async () => {
    const before = snapshotAuthFiles([target]);
    const stranger = { name: 'codex-zzz-someone@example.com-pro.json', type: 'codex', email: 'someone@example.com', account_id: 'acct-2' };
    const { api, calls } = fakeApi([target, stranger], {});
    expect(await completeReauth(target, 'codex', before, api, fast)).toEqual({ kind: 'mismatch', name: target.name, signedInAs: ['someone@example.com'] });
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('ignores the core\u2019s own status churn on the target and still moves the duplicate', async () => {
    // The listing entry for a rate-limited account changes constantly. The target
    // must not match itself, report success and orphan the new file.
    const before = snapshotAuthFiles([target]);
    const churned = {
      ...target,
      status: 'error',
      status_message: 'rate limit',
      unavailable: true,
      cooldowns: [{ reason: 'quota', retry_at: '2026-09-19T08:51:05Z' }],
      quota: { observed_at: '2026-09-17T07:50:00Z' },
    };
    const fresh = { name: 'claude-5772b8d7-casey@example.com.json', type: 'codex', email: 'casey@example.com', account_id: 'acct-1' };
    const { name: _freshName, ...freshContent } = fresh;
    const { name: _targetName, ...targetContent } = target;
    const { api, calls } = fakeApi([churned, fresh], {
      [target.name]: { ...targetContent, access_token: 'old' },
      [fresh.name]: { ...freshContent, access_token: 'new' },
    });
    expect(await completeReauth(target, 'codex', before, api, fast))
      .toEqual({ kind: 'transplanted', name: target.name, from: fresh.name });
    expect(calls.find((call) => call.method === 'DELETE')?.name).toBe(fresh.name);
  });

  it('waits for the core to finish writing the new credential', async () => {
    const before = snapshotAuthFiles([target]);
    const fresh = { name: 'codex-abc-casey@example.com-pro.json', type: 'codex', email: 'casey@example.com', account_id: 'acct-1' };
    const { name: _freshName, ...freshContent } = fresh;
    const { name: _targetName, ...targetContent } = target;
    const { api } = fakeApi([[target], [target], [target, fresh]], {
      [target.name]: { ...targetContent, access_token: 'old' },
      [fresh.name]: { ...freshContent, access_token: 'new' },
    });
    expect(await completeReauth(target, 'codex', before, api, fast))
      .toEqual({ kind: 'transplanted', name: target.name, from: fresh.name });
  });

  it('reports when no credential changed', async () => {
    const before = snapshotAuthFiles([target]);
    const { api } = fakeApi([target], {});
    expect(await completeReauth(target, 'codex', before, api, fast)).toEqual({ kind: 'none', name: target.name });
  });

  // The core lists no account ids, so these credentials only have an email, like real listings.
  const work = { name: 'codex-casey-work.json', type: 'codex', email: 'casey@example.com', modtime: 1 };
  const personal = { name: 'codex-casey-personal.json', type: 'codex', email: 'casey@example.com', modtime: 1 };

  it('never folds a same-email credential into a target the sign-in rewrote in place', async () => {
    // A second workspace for the same email refreshed its token meanwhile. It
    // must not be taken for the new login, with its tokens copied into the
    // target and its file deleted.
    const before = snapshotAuthFiles([work, personal]);
    const { api, calls } = fakeApi([{ ...work, modtime: 2 }, { ...personal, modtime: 2 }], {});
    expect(await completeReauth(work, 'codex', before, api, fast)).toEqual({ kind: 'in-place', name: work.name });
    expect(calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('prefers a file the sign-in created over an existing same-email credential that changed', async () => {
    const before = snapshotAuthFiles([work, personal]);
    const fresh = { name: 'codex-9f1e-casey@example.com-team.json', type: 'codex', email: 'casey@example.com', modtime: 2 };
    const { api, calls } = fakeApi([work, { ...personal, modtime: 2 }, fresh], {
      [work.name]: { type: 'codex', access_token: 'old' },
      [fresh.name]: { type: 'codex', access_token: 'new' },
    });
    expect(await completeReauth(work, 'codex', before, api, fast)).toEqual({ kind: 'transplanted', name: work.name, from: fresh.name });
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.name)).toEqual([fresh.name]);
  });

  it('keeps waiting while only unrelated credentials changed', async () => {
    const other = { name: 'codex-team.json', type: 'codex', email: 'team@example.com', modtime: 1 };
    const before = snapshotAuthFiles([target, other]);
    const fresh = { name: 'codex-abc-casey@example.com-pro.json', type: 'codex', email: 'casey@example.com', modtime: 2 };
    const { name: _freshName, ...freshContent } = fresh;
    const { name: _targetName, ...targetContent } = target;
    const refreshed = { ...other, modtime: 2 };
    const { api, calls } = fakeApi([[target, refreshed], [target, refreshed, fresh]], {
      [target.name]: { ...targetContent, access_token: 'old' },
      [fresh.name]: { ...freshContent, access_token: 'new' },
    });
    expect(await completeReauth(target, 'codex', before, api, fast)).toEqual({ kind: 'transplanted', name: target.name, from: fresh.name });
    expect(calls.filter((call) => call.path === '/auth-files' && call.method === 'GET')).toHaveLength(2);
  });

  it('keeps waiting for the login’s own file while a same-email credential changed first', async () => {
    // Taking the sibling at the first listing would copy its tokens into the
    // target and delete it, while the real login lands a moment later.
    const before = snapshotAuthFiles([work, personal]);
    const fresh = { name: 'codex-9f1e-casey@example.com-team.json', type: 'codex', email: 'casey@example.com', modtime: 2 };
    const refreshed = { ...personal, modtime: 2 };
    const { api, calls } = fakeApi([[work, refreshed], [work, refreshed, fresh]], {
      [work.name]: { type: 'codex', access_token: 'old' },
      [fresh.name]: { type: 'codex', access_token: 'new' },
    });
    expect(await completeReauth(work, 'codex', before, api, fast)).toEqual({ kind: 'transplanted', name: work.name, from: fresh.name });
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.name)).toEqual([fresh.name]);
  });

  it('takes an existing file the login rewrote only once the wait ends with nothing new', async () => {
    // An earlier sign-in already left a copy under the core's own name for the account.
    const listedTarget = { name: target.name, type: 'codex', email: 'casey@example.com', priority: 10, modtime: 1 };
    const canonical = { name: 'codex-abc-casey@example.com-pro.json', type: 'codex', email: 'casey@example.com', modtime: 1 };
    const before = snapshotAuthFiles([listedTarget, canonical]);
    const { api, calls } = fakeApi([listedTarget, { ...canonical, modtime: 2 }], {
      [target.name]: { type: 'codex', account_id: 'acct-1', access_token: 'old', priority: 10 },
      [canonical.name]: { type: 'codex', account_id: 'acct-1', access_token: 'new' },
    });
    expect(await completeReauth(listedTarget, 'codex', before, api, fast))
      .toEqual({ kind: 'transplanted', name: target.name, from: canonical.name });
    expect(calls.filter((call) => call.path === '/auth-files' && call.method === 'GET')).toHaveLength(fast.attempts);
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.name)).toEqual([canonical.name]);
  });

  it('skips a same-email credential from another workspace that changed alongside the account’s own file', async () => {
    // The account's file under the core's name existed already, and the other
    // workspace's file sorts ahead of it.
    const listedTarget = { name: target.name, type: 'codex', email: 'casey@example.com', modtime: 1 };
    const team = { name: 'codex-0000-casey@example.com-team.json', type: 'codex', email: 'casey@example.com', modtime: 1 };
    const canonical = { name: 'codex-abc-casey@example.com-pro.json', type: 'codex', email: 'casey@example.com', modtime: 1 };
    const before = snapshotAuthFiles([listedTarget, team, canonical]);
    const { api, calls } = fakeApi([listedTarget, { ...team, modtime: 2 }, { ...canonical, modtime: 2 }], {
      [target.name]: { type: 'codex', account_id: 'acct-1', access_token: 'old' },
      [team.name]: { type: 'codex', account_id: 'ws-team', access_token: 'team' },
      [canonical.name]: { type: 'codex', account_id: 'acct-1', access_token: 'new' },
    });
    expect(await completeReauth(listedTarget, 'codex', before, api, fast))
      .toEqual({ kind: 'transplanted', name: target.name, from: canonical.name });
    expect(JSON.parse(calls.find((call) => call.method === 'UPLOAD')?.text ?? '{}').access_token).toBe('new');
    expect(calls.filter((call) => call.method === 'DELETE').map((call) => call.name)).toEqual([canonical.name]);
  });

  it('keeps a login to another workspace or organization of the same email as its own file', async () => {
    // The listing cannot tell them apart; the files record the workspace or organization.
    const fresh = { name: 'codex-9f1e-casey@example.com-team.json', type: 'codex', email: 'casey@example.com', modtime: 2 };
    for (const [existing, signedIn] of [
      [{ account_id: 'ws-work' }, { account_id: 'ws-team' }],
      [{ account_uuid: 'uuid-1', organization_uuid: 'org-work' }, { account_uuid: 'uuid-1', organization_uuid: 'org-team' }],
    ]) {
      const { api, calls } = fakeApi([work, fresh], {
        [work.name]: { type: 'codex', ...existing, access_token: 'old' },
        [fresh.name]: { type: 'codex', ...signedIn, access_token: 'new' },
      });
      expect(await completeReauth(work, 'codex', snapshotAuthFiles([work]), api, fast))
        .toEqual({ kind: 'other-workspace', name: work.name, saved: fresh.name });
      expect(calls.some((call) => call.method === 'UPLOAD' || call.method === 'DELETE')).toBe(false);
    }
  });
});

describe('credentials the core saved under a new name', () => {
  // Core 7.2.158+ saves Claude logins as claude-<hash>-<email>.json, carries the
  // old file's settings over and deletes the old file itself.
  const legacy = {
    name: 'claude-casey.json', type: 'claude', email: 'casey@example.com', account_uuid: 'uuid-1',
    auth_index: 'idx-old', source: 'file', path: '/auths/claude-casey.json', priority: 10,
  };
  const canonical = {
    name: 'claude-5772b8d7-casey@example.com.json', type: 'claude', email: 'casey@example.com', account_uuid: 'uuid-1',
    auth_index: 'idx-new', source: 'file', path: '/auths/claude-5772b8d7-casey@example.com.json', priority: 10,
  };
  const recording = () => {
    const renames: AccountKeyRename[][] = [];
    return { renames, options: { ...fast, migrateKeys: (next: AccountKeyRename[]) => { renames.push(next); } } };
  };

  it('reports the rename without copying files back, and moves the app’s per-account state', async () => {
    const before = snapshotAuthFiles([legacy]);
    const { api, calls } = fakeApi([canonical], {});
    const { renames, options } = recording();
    expect(await completeReauth(legacy, 'claude', before, api, options))
      .toEqual({ kind: 'renamed', name: canonical.name, from: legacy.name });
    expect(calls.map((call) => call.method)).toEqual(['GET']);
    expect(renames).toEqual([[{ from: 'claude-casey.json::idx-old', to: `${canonical.name}::idx-new` }]]);
  });

  it('still reports a rename while the deleted file lingers in the listing from memory', async () => {
    // The old fingerprint changes (source file -> memory), which must not read
    // as an in-place update and leave the new file unnoticed.
    const before = snapshotAuthFiles([legacy]);
    const { api, calls } = fakeApi([{ ...legacy, source: 'memory' }, canonical], {});
    const { renames, options } = recording();
    expect(await completeReauth(legacy, 'claude', before, api, options))
      .toEqual({ kind: 'renamed', name: canonical.name, from: legacy.name });
    expect(calls.some((call) => call.method !== 'GET')).toBe(false);
    expect(renames).toHaveLength(1);
  });

  it('says the target is missing when it vanished and nothing for its account appeared', async () => {
    const before = snapshotAuthFiles([legacy]);
    const stranger = { ...canonical, name: 'claude-0000-someone@example.com.json', email: 'someone@example.com', account_uuid: 'uuid-9' };
    for (const listing of [[], [stranger]]) {
      const { api, calls } = fakeApi(listing, {});
      const { renames, options } = recording();
      expect(await completeReauth(legacy, 'claude', before, api, options)).toEqual({ kind: 'missing', name: legacy.name });
      expect(calls.every((call) => call.method === 'GET')).toBe(true);
      expect(renames).toEqual([]);
    }
  });

  it('pairs a vanished file with the new file for the same account after a plain sign-in', () => {
    const other = { name: 'codex-team.json', type: 'codex', email: 'team@example.com', source: 'file', path: '/auths/codex-team.json' };
    const secondClaude = { ...legacy, name: 'claude-work.json', email: 'work@example.com', account_uuid: 'uuid-2', auth_index: 'idx-work', path: '/auths/claude-work.json' };
    const before = [legacy, secondClaude, other];
    expect(renamedCredentials(before, [{ ...legacy, source: 'memory' }, secondClaude, canonical, other], 'claude'))
      .toEqual([{ from: legacy, to: canonical }]);
    expect(renamedCredentials(before, [secondClaude, canonical, other], 'anthropic'))
      .toEqual([{ from: legacy, to: canonical }]);
    // Old file still on disk, a different account, or another provider: not a rename.
    expect(renamedCredentials(before, [legacy, secondClaude, canonical, other], 'claude')).toEqual([]);
    expect(renamedCredentials(before, [secondClaude, { ...canonical, email: 'x@example.com', account_uuid: 'uuid-x' }, other], 'claude')).toEqual([]);
    expect(renamedCredentials(before, [legacy, secondClaude, canonical], 'codex')).toEqual([]);
  });

  it('waits for the renamed file even while another credential changed first', async () => {
    // A credential the core refreshed during the sign-in must not end the wait
    // and turn a real rename into "missing", leaving the app's state behind.
    const other = { ...legacy, name: 'claude-work.json', email: 'work@example.com', account_uuid: 'uuid-2', auth_index: 'idx-work', path: '/auths/claude-work.json', modtime: 1 };
    const before = snapshotAuthFiles([legacy, other]);
    const lingering = { ...legacy, source: 'memory' };
    const refreshed = { ...other, modtime: 2 };
    const { api } = fakeApi([[lingering, refreshed], [lingering, refreshed, canonical]], {});
    const { renames, options } = recording();
    expect(await completeReauth(legacy, 'claude', before, api, options))
      .toEqual({ kind: 'renamed', name: canonical.name, from: legacy.name });
    expect(renames).toEqual([[{ from: 'claude-casey.json::idx-old', to: `${canonical.name}::idx-new` }]]);
  });

  it('prefers the new file when a same-email credential also changed during a plain sign-in', () => {
    // As listed by the core: no account ids, so both candidates match by email.
    const { account_uuid: _legacyId, ...listedLegacy } = legacy;
    const { account_uuid: _canonicalId, ...listedCanonical } = canonical;
    const sibling = { ...listedLegacy, name: 'claude-1111-casey@example.com.json', auth_index: 'idx-sibling', path: '/auths/claude-1111.json', modtime: 1 };
    expect(renamedCredentials([listedLegacy, sibling], [{ ...sibling, modtime: 2 }, listedCanonical], 'claude'))
      .toEqual([{ from: listedLegacy, to: listedCanonical }]);
  });

  it('polls a plain sign-in until the replaced file’s successor is listed', async () => {
    const lingering = { ...legacy, source: 'memory' };
    const { api, calls } = fakeApi([[legacy], [lingering], [lingering, canonical]], {});
    expect(await listingAfterSignIn([legacy], 'claude', api, fast)).toEqual([lingering, canonical]);
    expect(calls).toHaveLength(3);
  });

  it('keeps polling a plain sign-in past a same-email file that merely changed', async () => {
    // As listed by the core: no account ids, so the sibling matches by email too.
    const { account_uuid: _legacyId, ...listedLegacy } = legacy;
    const { account_uuid: _canonicalId, ...listedCanonical } = canonical;
    const sibling = { ...listedLegacy, name: 'claude-1111-casey@example.com.json', auth_index: 'idx-sibling', path: '/auths/claude-1111.json', modtime: 1 };
    const lingering = { ...listedLegacy, source: 'memory' };
    const refreshed = { ...sibling, modtime: 2 };
    const { api, calls } = fakeApi([[lingering, refreshed], [lingering, refreshed, listedCanonical]], {});
    const after = await listingAfterSignIn([listedLegacy, sibling], 'claude', api, fast);
    expect(after).toEqual([lingering, refreshed, listedCanonical]);
    expect(calls).toHaveLength(2);
    expect(renamedCredentials([listedLegacy, sibling], after, 'claude')).toEqual([{ from: listedLegacy, to: listedCanonical }]);
  });

  it('stops at the first listing that shows a new credential, and gives up after the attempts', async () => {
    const fresh = { ...canonical, name: 'claude-2222-new@example.com.json', email: 'new@example.com' };
    const first = fakeApi([[legacy, fresh], [legacy]], {});
    expect(await listingAfterSignIn([legacy], 'claude', first.api, fast)).toEqual([legacy, fresh]);
    expect(first.calls).toHaveLength(1);
    const never = fakeApi([legacy], {});
    expect(await listingAfterSignIn([legacy], 'claude', never.api, fast)).toEqual([legacy]);
    expect(never.calls).toHaveLength(fast.attempts);
  });
});

describe('following up a sign-in from Add account', () => {
  const home = {
    name: 'claude-home.json', type: 'claude', email: 'home@example.com', account_uuid: 'uuid-home', auth_index: 'idx-home',
    source: 'file', path: '/auths/claude-home.json', priority: 10, modtime: 1,
  };
  const settle = (listings: Record<string, unknown>[][], setPriority: (name: string) => Promise<unknown> = async () => {}) => {
    const renames: AccountKeyRename[][] = [];
    const prioritized: string[] = [];
    const { api } = fakeApi(listings, {});
    const result = settleSignIn([home], 'claude', api, {
      ...fast,
      migrateKeys: (batch) => renames.push(batch),
      setPriority: (name) => { prioritized.push(name); return setPriority(name); },
    });
    return { result, renames, prioritized };
  };

  it('reports a new account as added, in the default priority tier', async () => {
    const work = { name: 'claude-work.json', type: 'claude', email: 'work@example.com', account_uuid: 'uuid-work', auth_index: 'idx-work', source: 'file', modtime: 1 };
    const { result, renames, prioritized } = settle([[home, work]]);
    const { added, refreshed, priorityError } = await result;
    expect(added).toEqual(['claude-work.json']);
    expect(refreshed).toEqual([]);
    expect(priorityError).toBeUndefined();
    expect(prioritized).toEqual(['claude-work.json']);
    expect(renames).toEqual([[]]);
  });

  it('counts an account the core moved to a new file name as signed in again, and keeps its state and priority', async () => {
    const moved = { ...home, name: 'claude-5772b8d7-home@example.com.json', path: '/auths/claude-5772b8d7-home@example.com.json', auth_index: 'idx-moved', modtime: 2 };
    const { result, renames, prioritized } = settle([[{ ...home, source: 'memory' }, moved]]);
    const { added, refreshed } = await result;
    expect(added).toEqual([]);
    expect(refreshed).toEqual(['claude-5772b8d7-home@example.com.json']);
    expect(renames.flat()).toHaveLength(1);
    expect(prioritized).toEqual([]);
  });

  it('keeps the sign-in when a priority couldn’t be set, and says why', async () => {
    const work = { name: 'claude-work.json', type: 'claude', email: 'work@example.com', account_uuid: 'uuid-work', source: 'file', modtime: 1 };
    const { result } = settle([[home, work]], async () => { throw new Error('core busy'); });
    const { added, priorityError } = await result;
    expect(added).toEqual(['claude-work.json']);
    expect(priorityError).toContain('core busy');
  });
});
