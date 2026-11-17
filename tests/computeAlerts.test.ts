import { describe, expect, it } from 'bun:test';
import { alertDestinationView } from '../src/alertNavigation';
import { computeScenarioSnapshot, type ComputeScenario } from '../src/dev/mock/computeScenarios';
import { translate } from '../src/i18n';
import { computeSandboxView, computeView } from '../src/navigation';
import type { ComputeProviderSnapshot, ComputeSandbox, ComputeSnapshot } from '../src/native/types';
import { alertCategory, alertDestination } from '../src/services/alertHistory';
import {
  computeAlertNotification,
  computeProblemKey,
  computeProblems,
  nextComputeAlerts,
  parseComputeSandboxSubject,
  type ComputeProblem,
} from '../src/services/computeAlerts';
import { phoneTakes } from '../src/services/phoneAlerts';
import { present } from './support/items';

const NOW = Date.parse('2026-11-17T15:52:00Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const scenario = (name: ComputeScenario) => computeScenarioSnapshot(name, NOW);
const keys = (snapshot: ComputeSnapshot, now = NOW) => computeProblems(snapshot, now).map(computeProblemKey).sort();
const boat = (snapshot: ComputeSnapshot) => present(snapshot.providers[0]);
const withBoat = (snapshot: ComputeSnapshot, change: (provider: ComputeProviderSnapshot) => ComputeProviderSnapshot): ComputeSnapshot =>
  ({ providers: [change(boat(snapshot))] });
const withSandbox = (snapshot: ComputeSnapshot, name: string, change: (sandbox: ComputeSandbox) => ComputeSandbox) =>
  withBoat(snapshot, (provider) => ({ ...provider, sandboxes: provider.sandboxes.map((sandbox) => (sandbox.name === name ? change(sandbox) : sandbox)) }));
/** Plan hours' key, which names the period they reset at. */
const HOURS = `boat:planHours:${present(present(scenario('typical').providers[0]).periodEndMs)}`;
const t = (key: Parameters<typeof translate>[0], variables?: Parameters<typeof translate>[1]) => translate(key, variables);

describe('Compute’s alert rules', () => {
  it('raises plan hours running out, a forgotten sandbox and one degraded five minutes, on a typical afternoon', () => {
    expect(keys(scenario('typical'))).toEqual(['boat:degraded:bx_n3c2x8ws', 'boat:forgotten:bx_t9v6h2rk', HOURS]);
  });

  it('raises blocked starts, and plan hours 80% used even when they’d last the period', () => {
    expect(keys(scenario('blocked'))).toContain('boat:startsBlocked');
    const slow = withBoat(scenario('near'), (provider) => ({ ...provider, runOutAtMs: null }));
    expect(keys(slow)).toContain(HOURS);
    const fine = withBoat(scenario('typical'), (provider) => ({ ...provider, runOutAtMs: null }));
    expect(keys(fine)).not.toContain(HOURS);
  });

  it('raises running sandboxes at 80% of the maximum', () => {
    const full = withBoat(scenario('empty'), (provider) => ({
      ...provider,
      limits: provider.limits.map((limit) => (limit.kind === 'activeSandboxes' ? { ...limit, used: 80, max: 100 } : limit)),
    }));
    expect(keys(full)).toEqual(['boat:activeNearMax']);
  });

  it('raises a degraded sandbox only after five minutes, and one in error at once', () => {
    const fresh = withSandbox(scenario('typical'), 'ci-01-build', (sandbox) => ({ ...sandbox, issueSinceMs: NOW - 4 * MINUTE }));
    expect(keys(fresh)).not.toContain('boat:degraded:bx_n3c2x8ws');
    const failed = withSandbox(scenario('typical'), 'cam-mbp-docs', (sandbox) => ({ ...sandbox, state: 'error' }));
    expect(keys(failed)).toContain('boat:sandboxError:bx_e5y8b4mz');
  });

  it('raises nothing for a stopped sandbox or a teammate’s', () => {
    let snapshot = withSandbox(scenario('typical'), 'ci-01-perf', (sandbox) => ({ ...sandbox, state: 'stopped' }));
    snapshot = withSandbox(snapshot, 'ci-01-build', (sandbox) => ({ ...sandbox, mine: false }));
    snapshot = withSandbox(snapshot, 'cam-mbp-docs', (sandbox) => ({ ...sandbox, mine: false, state: 'error' }));
    expect(keys(snapshot)).toEqual([HOURS]);
  });

  it('raises a refused or expired key, and a week before it expires, judging nothing else while the key is refused', () => {
    expect(keys(scenario('refused'))).toEqual(['boat:key']);
    const soon = withBoat(scenario('empty'), (provider) => ({ ...provider, keyExpiresAtMs: NOW + 6 * DAY }));
    expect(keys(soon)).toEqual(['boat:keyExpiring']);
    const later = withBoat(scenario('empty'), (provider) => ({ ...provider, keyExpiresAtMs: NOW + 8 * DAY }));
    expect(keys(later)).toEqual([]);
    // The mock's provider that reports expiry has its key five days out.
    expect(keys(scenario('readonlykey'))).toContain('boat:keyExpiring');
    const gone = withBoat(scenario('empty'), (provider) => ({ ...provider, keyExpiresAtMs: NOW - MINUTE }));
    const [problem] = computeProblems(gone, NOW);
    expect(problem).toEqual({ kind: 'key', provider: 'boat', expired: true });
  });

  it('alerts each problem once while it lasts, again once it cleared and came back', () => {
    const first = nextComputeAlerts([], scenario('typical'), NOW);
    expect(first.alert).toHaveLength(3);
    const second = nextComputeAlerts(first.alerted, scenario('typical'), NOW + MINUTE);
    expect(second.alert).toEqual([]);
    expect(second.alerted.sort()).toEqual(first.alerted.sort());

    const cleared = withSandbox(scenario('typical'), 'ci-01-perf', (sandbox) => ({ ...sandbox, forgotten: null }));
    const third = nextComputeAlerts(second.alerted, cleared, NOW + 2 * MINUTE);
    expect(third.alert).toEqual([]);
    expect(third.alerted).not.toContain('boat:forgotten:bx_t9v6h2rk');

    const back = nextComputeAlerts(third.alerted, scenario('typical'), NOW + 3 * MINUTE);
    expect(back.alert.map(computeProblemKey)).toEqual(['boat:forgotten:bx_t9v6h2rk']);
  });

  it('keeps what it alerted while a provider isn’t answering, so nothing repeats when it’s back', () => {
    const first = nextComputeAlerts([], scenario('typical'), NOW);
    const away = nextComputeAlerts(first.alerted, scenario('unreachable'), NOW + MINUTE);
    expect(away.alert).toEqual([]);
    expect(away.alerted.sort()).toEqual(first.alerted.sort());
    expect(nextComputeAlerts(away.alerted, scenario('typical'), NOW + 2 * MINUTE).alert).toEqual([]);
    // A key that can't read limits keeps the limits' alerts and judges the sandboxes.
    const scoped = nextComputeAlerts(first.alerted, scenario('limits'), NOW + MINUTE);
    expect(scoped.alert).toEqual([]);
    expect(scoped.alerted).toContain(HOURS);
  });

  it('alerts nothing again after a restart: a provider not read yet since launch judges nothing', () => {
    const first = nextComputeAlerts([], scenario('typical'), NOW);
    expect(first.alert).toHaveLength(3);
    // What Rust reports until its first round since launch: `ok`, never checked, nothing listed.
    const notYetRead = withBoat(scenario('typical'), (provider) => ({
      ...provider,
      checkedAtMs: null,
      limits: [],
      canStart: null,
      planHoursPerHour: null,
      runOutAtMs: null,
      periodEndMs: null,
      sandboxes: [],
    }));
    const launched = nextComputeAlerts(first.alerted, notYetRead, NOW + MINUTE);
    expect(launched.alert).toEqual([]);
    expect(launched.alerted.sort()).toEqual(first.alerted.sort());
    expect(nextComputeAlerts(launched.alerted, scenario('typical'), NOW + 2 * MINUTE).alert).toEqual([]);
  });

  it('judges a provider asking to slow down over CPU and memory reads alone, and carries everything once the list is old', () => {
    const rateLimited = (checkedAgoMs: number) => withBoat(scenario('typical'), (provider) => ({ ...provider, status: 'rateLimited', checkedAtMs: NOW - checkedAgoMs }));
    // The list was read this round: every alert still works.
    expect(keys(rateLimited(MINUTE))).toEqual(keys(scenario('typical')));
    const failed = withSandbox(rateLimited(MINUTE), 'cam-mbp-docs', (sandbox) => ({ ...sandbox, state: 'error' }));
    expect(nextComputeAlerts([], failed, NOW).alert.map(computeProblemKey)).toContain('boat:sandboxError:bx_e5y8b4mz');
    // Kept from the list a while: the figures are an earlier read's, so nothing is judged and what was alerted stays.
    const first = nextComputeAlerts([], scenario('typical'), NOW);
    const held = nextComputeAlerts(first.alerted, withBoat(rateLimited(10 * MINUTE), (provider) => ({ ...provider, sandboxes: [] })), NOW);
    expect(held.alert).toEqual([]);
    expect(held.alerted.sort()).toEqual(first.alerted.sort());
  });

  it('alerts a run-out once a period, however often the sandboxes stop and start again', () => {
    const idle = withBoat(scenario('typical'), (provider) => ({
      ...provider,
      sandboxes: provider.sandboxes.map((sandbox) => ({ ...sandbox, state: 'stopped' as const })),
      planHoursPerHour: 0,
      runOutAtMs: null,
    }));
    const running = nextComputeAlerts([], scenario('typical'), NOW);
    expect(running.alert.map(computeProblemKey)).toContain(HOURS);
    // Nothing running says nothing new about plan hours: what was alerted stays.
    const stopped = nextComputeAlerts(running.alerted, idle, NOW + MINUTE);
    expect(stopped.alerted).toContain(HOURS);
    const again = nextComputeAlerts(stopped.alerted, scenario('typical'), NOW + 2 * MINUTE);
    expect(again.alert.map(computeProblemKey)).not.toContain(HOURS);

    // A known run-out after the reset ends it, so a later one alerts again.
    const slow = withBoat(scenario('typical'), (provider) => ({ ...provider, runOutAtMs: present(provider.periodEndMs) + DAY }));
    const fine = nextComputeAlerts(again.alerted, slow, NOW + 3 * MINUTE);
    expect(fine.alerted).not.toContain(HOURS);
    expect(nextComputeAlerts(fine.alerted, scenario('typical'), NOW + 4 * MINUTE).alert.map(computeProblemKey)).toContain(HOURS);

    // A new period is a new run-out: one alerted in the last period doesn't silence it, idle spell or not.
    const nextPeriod = (snapshot: ComputeSnapshot) => withBoat(snapshot, (provider) => ({
      ...provider,
      periodEndMs: present(provider.periodEndMs) + 30 * DAY,
      limits: provider.limits.map((limit) => (limit.kind === 'planHours' ? { ...limit, used: 10, resetsAtMs: present(provider.periodEndMs) + 30 * DAY } : limit)),
      runOutAtMs: NOW + DAY,
    }));
    const reset = nextComputeAlerts(stopped.alerted, withBoat(nextPeriod(idle), (provider) => ({ ...provider, runOutAtMs: null })), NOW + 30 * DAY);
    expect(reset.alerted).not.toContain(HOURS);
    const fresh = nextComputeAlerts(reset.alerted, nextPeriod(scenario('typical')), NOW + 30 * DAY + MINUTE);
    expect(fresh.alert.map((problem) => problem.kind)).toContain('planHours');
  });

  it('forgets a provider’s alerts once it’s disconnected', () => {
    const first = nextComputeAlerts([], scenario('typical'), NOW);
    expect(nextComputeAlerts(first.alerted, { providers: [] }, NOW).alerted).toEqual([]);
  });
});

describe('Compute’s alerts as they’re sent', () => {
  const sent = (problem: ComputeProblem) => computeAlertNotification(problem, t, NOW);
  const problem = (snapshot: ComputeSnapshot, key: string) => present(computeProblems(snapshot, NOW).find((entry) => computeProblemKey(entry) === key), key);

  it('names the sandbox and its trouble, about the sandbox, on the machine that started it', () => {
    const forgotten = sent(problem(scenario('typical'), 'boat:forgotten:bx_t9v6h2rk'));
    expect(forgotten.title).toBe('ci-01-perf looks forgotten');
    expect(forgotten.body).toBe('Its session ended 41m ago and it’s still running.');
    expect(forgotten.kind).toBe('computeSandbox');
    expect(forgotten.subject).toEqual({ sandbox: 'boat/bx_t9v6h2rk', on: 'ci-01' });
    expect(parseComputeSandboxSubject('boat/bx_t9v6h2rk')).toEqual({ provider: 'boat', sandbox: 'bx_t9v6h2rk' });
    expect(parseComputeSandboxSubject('boat')).toBeNull();

    const degraded = sent(problem(scenario('typical'), 'boat:degraded:bx_n3c2x8ws'));
    expect(degraded.body).toBe('It has reported disk pressure for 7m.');
  });

  it('puts the provider’s name in as a parameter, and the key alert is urgent and opens Settings › Compute', () => {
    const key = sent(problem(scenario('refused'), 'boat:key'));
    expect(key.title).toBe('Boat turned down Arbor’s key');
    expect(key.urgent).toBe(true);
    expect(key.kind).toBe('computeKey');
    const destination = present(alertDestination({ kind: key.kind, subject: key.subject }));
    expect(destination).toEqual({ kind: 'setting', setting: 'compute.providers' });
    expect(alertDestinationView(destination)).toEqual({ kind: 'settings', page: 'compute' });
  });

  it('opens a sandbox’s alert on its page, and a limit’s on the provider’s sandboxes', () => {
    const forgotten = sent(problem(scenario('typical'), 'boat:forgotten:bx_t9v6h2rk'));
    expect(alertDestinationView(present(alertDestination({ kind: forgotten.kind, subject: forgotten.subject })))).toEqual(computeSandboxView('boat', 'bx_t9v6h2rk'));
    const hours = sent(problem(scenario('typical'), HOURS));
    expect(hours.title).toMatch(/^Boat plan hours run out /);
    expect(alertDestinationView(present(alertDestination({ kind: hours.kind, subject: hours.subject })))).toEqual(computeView('boat'));
    // One whose provider Arbor no longer knows opens Compute.
    expect(alertDestinationView({ kind: 'compute', provider: 'gone', sandbox: 'x' })).toEqual(computeView());
  });

  it('files them with the fleet’s alerts, and sends them to the phone under Compute', () => {
    for (const kind of ['computeLimit', 'computeSandbox', 'computeKey'] as const) {
      expect(alertCategory(kind)).toBe('machines');
      expect(phoneTakes({ mutedTopics: [] }, kind)).toBe(true);
      expect(phoneTakes({ mutedTopics: ['compute'] }, kind)).toBe(false);
    }
  });

  it('carries no provider text: bodies hold names, counts, times and words of their own', () => {
    for (const name of ['typical', 'blocked', 'near', 'refused'] as const) {
      for (const entry of computeProblems(scenario(name), NOW)) {
        const alert = sent(entry);
        expect(alert.title).not.toContain('{');
        expect(alert.body).not.toContain('{');
      }
    }
  });
});
