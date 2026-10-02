import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import {
  machineNotifications,
  nextMachineNotifications,
  sleptBetween,
  sshFailure,
  unreachableReason,
  type MachineAlert,
} from '../src/services/machineAlerts';
import { phoneAlertFor } from '../src/services/notify';
import type { MachineHealth } from '../src/native/types';

const MINUTE = 60_000;
const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);

const machine = (name: string, fields: Partial<MachineHealth> = {}): MachineHealth => ({
  machine: name,
  host: { machine: name, endpoint: name, port: 22, enabled: true, source: 'manual' },
  local: false, status: 'healthy', score: 90, reason: null, facts: null, latest: null, points: [],
  error: null, lastOkAt: 0, lastAttemptAt: 0, pingTarget: null, path: null,
  agents: { claude: null, codex: null, checkedAt: 0, error: null, updating: [], reporter: { installed: false, homes: [] }, t3: null, orca: null },
  ...fields,
});
const REFUSED = (name: string) => `ssh: connect to host ${name} port 22: Connection refused`;
const down = (name: string, lastOkAt: number | null, error = REFUSED(name), lastAttemptAt = 0) => machine(name, {
  status: 'unreachable', score: null, error, lastOkAt, lastAttemptAt,
});
const kinds = (alerts: MachineAlert[]) => alerts.map((alert) => `${alert.kind}:${alert.machine}`);

describe('machine alerts', () => {
  it('announces a machine once its checks have failed for five minutes, and again when it is back', () => {
    const start = 1_000 * MINUTE;
    // It last answered long ago, but this is the first failure seen: the count starts now, not at its last
    // answer, which after this Mac sleeps would be hours old and alert at once.
    const first = nextMachineNotifications({}, [down('ci-01', start - 45 * MINUTE), machine('cedar-01')], start);
    expect(first.alerts).toEqual([]);
    expect(first.state).toEqual({ 'ci-01': { downSinceMs: start, notified: false } });
    expect(nextMachineNotifications(first.state, [down('ci-01', start - 45 * MINUTE)], start + 4 * MINUTE).alerts).toEqual([]);

    const due = nextMachineNotifications(first.state, [down('ci-01', start - 45 * MINUTE)], start + 5 * MINUTE);
    expect(due.alerts).toEqual([{ machine: 'ci-01', kind: 'down', downSinceMs: start, error: REFUSED('ci-01'), failure: 'refused' }]);

    // Once is enough while it stays down, and a check that hasn't run since a change keeps what was known.
    const still = nextMachineNotifications(due.state, [down('ci-01', start - 45 * MINUTE)], start + 30 * MINUTE);
    expect(still).toMatchObject({ alerts: [], changed: false });
    expect(nextMachineNotifications(due.state, [machine('ci-01', { status: 'pending' })], start + 31 * MINUTE).state).toEqual(due.state);

    const back = nextMachineNotifications(due.state, [machine('ci-01', { status: 'critical' })], start + 40 * MINUTE);
    expect(back.alerts).toEqual([{ machine: 'ci-01', kind: 'up', downSinceMs: start, error: null, failure: null }]);
    expect(back.state).toEqual({});
  });

  it('announces a host key that changed or a login turned down at the first failed check', () => {
    const now = 1_000 * MINUTE;
    const next = nextMachineNotifications({}, [
      down('ci-01', now - MINUTE, 'Host key verification failed.'),
      down('lab-box', now - MINUTE, 'ci@lab-box: Permission denied (publickey).'),
      down('cedar-02', now - MINUTE, 'ssh: Could not resolve hostname cedar-02: nodename nor servname provided, or not known'),
    ], now);
    expect(next.alerts.map((alert) => `${alert.machine}:${alert.failure}`)).toEqual(['ci-01:hostKey', 'lab-box:auth']);
    expect(next.state).toEqual({
      'ci-01': { downSinceMs: now, notified: true },
      'lab-box': { downSinceMs: now, notified: true },
      'cedar-02': { downSinceMs: now, notified: false },
    });
    // One that was counting down is announced as soon as its failure turns into one that needs fixing.
    const fixing = nextMachineNotifications(next.state, [down('cedar-02', now - MINUTE, 'Host key verification failed.')], now + MINUTE);
    expect(fixing.alerts).toMatchObject([{ machine: 'cedar-02', failure: 'hostKey', downSinceMs: now }]);
  });

  it('keeps quiet while this Mac is offline or its network is coming back', () => {
    const woke = 1_000 * MINUTE;
    const stored = { 'ci-01': { downSinceMs: woke - 3 * MINUTE, notified: false }, 'lab-box': { downSinceMs: woke - 60 * MINUTE, notified: true } };
    const failing = (at: number) => [down('ci-01', 0, REFUSED('ci-01'), at), down('cedar-02', 0, 'Host key verification failed.', at), down('lab-box', 0, REFUSED('lab-box'), at)];

    // Offline, failures start nothing and end nothing: each keeps what it had.
    const offline = nextMachineNotifications(stored, failing(woke), woke, { offline: true, resumedAtMs: null });
    expect(offline).toMatchObject({ state: stored, alerts: [], changed: false });

    // In the first minute after waking, the same.
    const settling = nextMachineNotifications(stored, failing(woke + 30_000), woke + 30_000, { offline: false, resumedAtMs: woke });
    expect(settling).toMatchObject({ state: stored, alerts: [], changed: false });

    // After it, checks that ran before the wake still don't count.
    const staleCheck = nextMachineNotifications(stored, failing(woke - MINUTE), woke + 2 * MINUTE, { offline: false, resumedAtMs: woke });
    expect(staleCheck).toMatchObject({ state: stored, alerts: [], changed: false });

    // Fresh ones do. ci-01's count from before the sleep starts over rather than alerting at once; one
    // already announced keeps its time for the "back" alert; one that needs fixing is announced now.
    const after = woke + 2 * MINUTE;
    const fresh = nextMachineNotifications(stored, failing(after), after, { offline: false, resumedAtMs: woke });
    expect(kinds(fresh.alerts)).toEqual(['down:cedar-02']);
    expect(fresh.state).toEqual({
      'ci-01': { downSinceMs: after, notified: false },
      'cedar-02': { downSinceMs: after, notified: true },
      'lab-box': { downSinceMs: woke - 60 * MINUTE, notified: true },
    });
    expect(nextMachineNotifications(fresh.state, failing(after + 4 * MINUTE), after + 4 * MINUTE, { offline: false, resumedAtMs: woke }).alerts).toEqual([]);
    expect(kinds(nextMachineNotifications(fresh.state, failing(after + 5 * MINUTE), after + 5 * MINUTE, { offline: false, resumedAtMs: woke }).alerts))
      .toEqual(['down:ci-01']);

    // A machine answering is good news whenever it comes.
    const back = nextMachineNotifications(stored, [machine('lab-box', { lastAttemptAt: woke + 10_000 })], woke + 10_000, { offline: false, resumedAtMs: woke });
    expect(kinds(back.alerts)).toEqual(['up:lab-box']);
  });

  it('tells a sleep from ticks that are merely late', () => {
    const at = 1_000 * MINUTE;
    expect(sleptBetween(at, at + 10_000, 10_000)).toBe(false);
    expect(sleptBetween(at, at + 65_000, 10_000)).toBe(false);
    expect(sleptBetween(at, at + 71_000, 10_000)).toBe(true);
    expect(sleptBetween(at, at + 8 * 60 * MINUTE, 10_000)).toBe(true);
  });

  it('leaves out this Mac, machines without an address and ones no longer checked', () => {
    const now = 1_000 * MINUTE;
    const first = nextMachineNotifications({}, [
      down('casey-mbp', null),
      machine('lab-box', { status: 'unconfigured' }),
      down('cedar-02', null),
    ].map((item) => (item.machine === 'casey-mbp' ? { ...item, local: true } : item)), now);
    // Never seen answering: it counts from the first failed check.
    expect(first.state).toEqual({ 'cedar-02': { downSinceMs: now, notified: false } });
    expect(nextMachineNotifications(first.state, [down('cedar-02', null)], now + 4 * MINUTE).alerts).toEqual([]);
    const due = nextMachineNotifications(first.state, [down('cedar-02', null)], now + 5 * MINUTE);
    expect(kinds(due.alerts)).toEqual(['down:cedar-02']);
    // Removed or disabled: forgotten without a "back" alert.
    expect(nextMachineNotifications(due.state, [], now + 6 * MINUTE)).toMatchObject({ state: {}, alerts: [], changed: true });
  });

  it('sorts SSH errors into what they come down to', () => {
    const cases: [string | null, ReturnType<typeof sshFailure>][] = [
      ['Host key verification failed.', 'hostKey'],
      ['@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @', 'hostKey'],
      ['No ED25519 host key is known for ci-01 and you have requested strict checking.', 'hostKey'],
      ['ci@ci-01: Permission denied (publickey).', 'auth'],
      ['casey@lab-box: Permission denied (publickey,password).', 'auth'],
      ['Received disconnect from 10.0.0.2 port 22:2: Too many authentication failures', 'auth'],
      ['ssh: Could not resolve hostname ci-01: nodename nor servname provided, or not known', 'dns'],
      ['ssh: Could not resolve hostname ci-01: Temporary failure in name resolution', 'dns'],
      ['ssh: connect to host ci-01 port 22: Connection refused', 'refused'],
      ['ssh: connect to host ci-01 port 22: Operation timed out', 'timeout'],
      ['Connection timed out during banner exchange', 'timeout'],
      ['Timed out after 12s', 'timeout'],
      ['ssh: connect to host ci-01 port 22: No route to host', 'other'],
      ['kex_exchange_identification: read: Connection reset by peer', 'other'],
      // A script's own permission error isn't SSH turning the login down.
      ['cat: /sys/class/thermal/thermal_zone0/temp: Permission denied', 'other'],
      ['missing arch', 'other'],
      [null, 'other'],
    ];
    expect(cases.map(([error]) => sshFailure(error))).toEqual(cases.map(([, failure]) => failure));
  });

  it('says why on the Machines page, keeping the error when there is nothing plainer', () => {
    expect(unreachableReason('Host key verification failed.', t)).toBe('Its SSH host key changed.');
    expect(unreachableReason(REFUSED('ci-01'), t)).toBe('It refused the SSH connection.');
    expect(unreachableReason('ssh: connect to host ci-01 port 22: No route to host', t)).toBe('ssh: connect to host ci-01 port 22: No route to host');
    expect(unreachableReason(null, t)).toBeNull();
  });

  it('says which machines went down, need fixing or came back, together when several do', () => {
    const now = 1_000 * MINUTE;
    const alert = (name: string, kind: 'down' | 'up', minutesAgo: number, error: string | null = null): MachineAlert =>
      ({ machine: name, kind, downSinceMs: now - minutesAgo * MINUTE, error, failure: kind === 'up' ? null : sshFailure(error) });

    expect(machineNotifications([alert('ci-01', 'down', 6, REFUSED('ci-01'))], now, t)).toEqual([{
      title: 'ci-01 is down',
      body: 'It refused the SSH connection. Checks have failed for 6m. ssh: connect to host ci-01 port 22: Connection refused',
      phoneBody: 'It refused the SSH connection. Checks have failed for 6m.',
      kind: 'machineDown',
      urgent: true,
      subject: { machine: 'ci-01' },
    }]);
    expect(machineNotifications([alert('ci-01', 'down', 0, 'Host key verification failed.')], now, t)).toEqual([{
      title: 'ci-01 needs fixing',
      body: 'Its SSH host key changed. Checks will fail until that’s fixed. Host key verification failed.',
      phoneBody: 'Its SSH host key changed. Checks will fail until that’s fixed.',
      kind: 'machineDown',
      urgent: true,
      subject: { machine: 'ci-01' },
    }]);
    expect(machineNotifications([
      alert('ci-01', 'down', 6),
      alert('cedar-02', 'down', 5),
      alert('ci-02', 'down', 0, 'ci@ci-02: Permission denied (publickey).'),
      alert('ci-03', 'down', 0, 'Host key verification failed.'),
      alert('lab-box', 'up', 72),
    ], now, t)).toEqual([
      {
        title: '2 machines need fixing',
        // One has a changed host key, which is this Mac turning it down, so the reason is left to the Machines page.
        body: 'ci-02 and ci-03 can’t be checked over SSH until they’re fixed. The Machines page says why.',
        kind: 'machineDown',
        urgent: true,
        subject: { machines: ['ci-02', 'ci-03'] },
      },
      {
        title: '2 machines are down',
        body: 'ci-01 and cedar-02 have failed their health checks for a few minutes.',
        kind: 'machineDown',
        urgent: true,
        subject: { machines: ['ci-01', 'cedar-02'] },
      },
      { title: 'lab-box is back', body: 'It answers its health checks again after 1h 12m.', kind: 'machineUp', subject: { machine: 'lab-box' } },
    ]);
    expect(machineNotifications([alert('a', 'up', 9), alert('b', 'up', 9), alert('c', 'up', 9)], now, t)).toEqual([
      { title: '3 machines are back', body: 'a, b and c answer their health checks again.', kind: 'machineUp', subject: { machines: ['a', 'b', 'c'] } },
    ]);
    // An error with no plainer reason, or none at all, isn't followed by a sentence that only says the checks failed.
    expect(machineNotifications([alert('ci-01', 'down', 5, 'ssh: connect to host ci-01 port 22: No route to host')], now, t)).toEqual([{
      title: 'ci-01 is down',
      body: 'Its health checks have failed for 5m. ssh: connect to host ci-01 port 22: No route to host',
      phoneBody: 'Its health checks have failed for 5m.',
      kind: 'machineDown',
      urgent: true,
      subject: { machine: 'ci-01' },
    }]);
    expect(machineNotifications([alert('ci-01', 'down', 5)], now, t)[0]!.body).toBe('Its health checks have failed for 5m.');
    expect(machineNotifications([alert('ci-01', 'down', 5, 'ssh: Could not resolve hostname ci-01: nodename nor servname provided, or not known')], now, t)[0]!.phoneBody)
      .toBe('This Mac can’t find the machine’s address. Checks have failed for 5m.');
    const long = machineNotifications([alert('ci-01', 'down', 6, 'x'.repeat(400))], now, t)[0]!.body;
    expect(long.endsWith('x…')).toBe(true);
    expect(long.length).toBeLessThan(260);
    expect(machineNotifications([], now, t)).toEqual([]);
  });

  it('sends the phone the plain reason and never the error', () => {
    const now = 1_000 * MINUTE;
    const error = 'casey@ci-01.tailc0ffee.ts.net: Permission denied (publickey).';
    const [message] = machineNotifications([{ machine: 'ci-01', kind: 'down', downSinceMs: now, error, failure: sshFailure(error) }], now, t);
    const phone = phoneAlertFor(message!);
    expect(phone).toEqual({
      title: 'ci-01 needs fixing',
      body: 'It won’t let this Mac log in over SSH. Checks will fail until that’s fixed.',
      kind: 'machineDown',
      urgent: true,
    });
    expect(JSON.stringify(phone)).not.toContain('tailc0ffee');
    // This Mac, and the alert history, keep the error.
    expect(message!.body).toContain(error);
    // Alerts without a separate phone body go as they are.
    expect(phoneAlertFor({ title: 'ci-01 is back', body: 'It answers again.', kind: 'machineUp' }))
      .toEqual({ title: 'ci-01 is back', body: 'It answers again.', kind: 'machineUp', urgent: false });
  });
});
