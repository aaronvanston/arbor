import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PoolSshBody } from '../src/components/pools/PoolConnect';
import { I18nProvider } from '../src/i18n';
import { formatDate } from '../src/lib/format';
import type { PoolSsh, PoolSshConnection } from '../src/native/types';
import { connectionWords, forgetBlocker, spreadExample, sshBlocker } from '../src/services/poolSsh';

const ssh = (fields: Partial<PoolSsh> = {}): PoolSsh => ({
  host: 'arbor-builds',
  commandReady: true,
  includeLine: 'Include ~/.arbor/ssh/pools.conf',
  included: true,
  user: 'cam',
  members: [
    { machine: 'cam-mbp', readiness: 'ready' },
    { machine: 'lab-box', readiness: 'noHostKey' },
    { machine: 'cedar-02', readiness: 'otherUser' },
    { machine: 'home-mini', readiness: 'thisMac' },
  ],
  connections: [],
  ...fields,
});

const PICKED = Date.UTC(2026, 2, 14, 12);
const connection = (fields: Partial<PoolSshConnection>): PoolSshConnection => ({ name: 'arbor-builds', machine: 'cam-mbp', open: 0, pickedAtMs: PICKED, ...fields });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ').trim();
const render = (value: PoolSsh | null, error: string | null = null) => text(renderToStaticMarkup(<I18nProvider><PoolSshBody poolId="p1" ssh={value} error={error} /></I18nProvider>));

describe('pools over SSH', () => {
  it('names the first thing in the way of connecting', () => {
    expect(sshBlocker(ssh({ commandReady: false, included: false }))).toBe('command');
    expect(sshBlocker(ssh({ included: false }))).toBe('include');
    expect(sshBlocker(ssh({ members: [{ machine: 'lab-box', readiness: 'noHostKey' }, { machine: 'home-mini', readiness: 'thisMac' }] }))).toBe('members');
    expect(sshBlocker(ssh())).toBeNull();
  });

  it('words a host name by its open connections, and forgets it only once none is open', () => {
    expect(connectionWords(connection({ open: 1 }))).toEqual({ key: 'pools.ssh.connection.open.one', values: { count: 1 } });
    expect(connectionWords(connection({ open: 3 })).key).toBe('pools.ssh.connection.open.other');
    expect(connectionWords(connection({})).key).toBe('pools.ssh.connection.closed');
    expect(forgetBlocker(connection({ open: 2 }))).toBe('pools.ssh.forget.open');
    expect(forgetBlocker(connection({}))).toBeNull();
    expect(spreadExample('arbor-builds')).toBe('arbor-builds-b');
  });

  it('shows the host to open, each machine’s readiness and where each host name is pinned', () => {
    const page = render(ssh({ connections: [connection({ open: 2 }), connection({ name: 'arbor-builds-b', machine: 'lab-box' })] }));
    expect(page).toContain('ssh arbor-builds');
    expect(page).toContain('Machines, connected to as cam');
    expect(page).toContain('Connect to it over SSH once, so this Mac saves its host key');
    expect(page).toContain('Reached as another user than cam');
    expect(page).toContain('This Mac. The host is opened from here, so it’s never picked');
    expect(page).toContain('2 connections open');
    expect(page).toContain(`Not connected now · Pinned ${formatDate(PICKED)}`);
    expect(page).toContain('Forget');
    expect(page).toContain('like arbor-builds-b');
    expect(page).not.toContain('Add to SSH config');
  });

  it('offers the Include line until ~/.ssh/config has it, and the command before anything else', () => {
    expect(render(ssh({ included: false }))).toContain('Add to SSH config Or add this line yourself: Include ~/.arbor/ssh/pools.conf');
    const noCommand = render(ssh({ commandReady: false, included: false }));
    expect(noCommand).toContain('Install the arbor command');
    expect(noCommand).not.toContain('ssh arbor-builds');
    expect(noCommand).not.toContain('Add to SSH config');
    expect(render(ssh({ connections: [] }))).toContain('No host name has connected yet.');
    expect(render(null, 'That pool was removed')).toContain('That pool was removed');
  });
});
