import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PoolSshBody } from '../src/components/pools/PoolSshSection';
import { I18nProvider } from '../src/i18n';
import type { PoolSsh, PoolSshConnection } from '../src/native/types';
import { LEASE_GRACE_MS, connectionWords, spreadExample, sshBlocker } from '../src/services/poolSsh';

const ssh = (fields: Partial<PoolSsh> = {}): PoolSsh => ({
  host: 'arbor-builds',
  commandReady: true,
  includeLine: 'Include ~/.arbor/ssh/pools.conf',
  included: true,
  user: 'casey',
  members: [
    { machine: 'casey-mbp', readiness: 'ready' },
    { machine: 'lab-box', readiness: 'noHostKey' },
    { machine: 'cedar-02', readiness: 'otherUser' },
  ],
  connections: [],
  ...fields,
});

const connection = (fields: Partial<PoolSshConnection>): PoolSshConnection => ({ name: 'arbor-builds', machine: 'casey-mbp', open: 0, idleSinceMs: null, ...fields });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim();
const render = (value: PoolSsh | null, error: string | null = null) => text(renderToStaticMarkup(<I18nProvider><PoolSshBody ssh={value} error={error} /></I18nProvider>));

describe('pools over SSH', () => {
  it('names the first thing in the way of connecting', () => {
    expect(sshBlocker(ssh({ commandReady: false, included: false }))).toBe('command');
    expect(sshBlocker(ssh({ included: false }))).toBe('include');
    expect(sshBlocker(ssh({ members: [{ machine: 'lab-box', readiness: 'noHostKey' }] }))).toBe('members');
    expect(sshBlocker(ssh())).toBeNull();
  });

  it('words a host name by its open connections, or the minutes it keeps its machine', () => {
    expect(connectionWords(connection({ open: 1 }), 0)).toEqual({ key: 'pools.ssh.connection.open.one', values: { count: 1 } });
    expect(connectionWords(connection({ open: 3 }), 0).key).toBe('pools.ssh.connection.open.other');
    const closed = connection({ idleSinceMs: 1_000_000 });
    expect(connectionWords(closed, 1_000_000 + 4 * 60_000).values).toEqual({ minutes: 6 });
    expect(connectionWords(closed, 1_000_000 + LEASE_GRACE_MS + 5_000).values).toEqual({ minutes: 1 });
    expect(spreadExample('arbor-builds')).toBe('arbor-builds-b');
  });

  it('shows the host to open, each machine’s readiness and where each host name went', () => {
    const page = render(ssh({ connections: [connection({ open: 2 }), connection({ name: 'arbor-builds-b', machine: 'lab-box', idleSinceMs: Date.now() })] }));
    expect(page).toContain('ssh arbor-builds');
    expect(page).toContain('Machines, connected to as casey');
    expect(page).toContain('Connect to it over SSH once, so this Mac saves its host key');
    expect(page).toContain('Reached as another user than casey');
    expect(page).toContain('2 connections open');
    expect(page).toContain('Closed, keeps its machine 10 more min');
    expect(page).toContain('like arbor-builds-b');
    expect(page).not.toContain('Add to SSH config');
  });

  it('offers the Include line until ~/.ssh/config has it, and the command before anything else', () => {
    expect(render(ssh({ included: false }))).toContain('Add to SSH config Or add this line yourself: Include ~/.arbor/ssh/pools.conf');
    const noCommand = render(ssh({ commandReady: false, included: false }));
    expect(noCommand).toContain('Install the arbor command');
    expect(noCommand).not.toContain('ssh arbor-builds');
    expect(noCommand).not.toContain('Add to SSH config');
    expect(render(ssh({ connections: [] }))).toContain('Nothing has connected lately.');
    expect(render(null, 'That pool was removed')).toContain('That pool was removed');
  });
});
