import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import { nextOutageNotifications, outageNotification, type OutageAlert } from '../src/services/outageAlerts';
import type { ProviderStatus, StatusIncident } from '../src/services/providerStatus';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);

const incident = (id: string, fields: Partial<StatusIncident> = {}): StatusIncident => ({
  id, name: `Incident ${id}`, status: 'investigating', indicator: 'major', url: 'https://status.claude.com/', ...fields,
});
const status = (incidents: StatusIncident[]): ProviderStatus => ({ indicator: 'major', components: [], incidents, checkedAt: 0 });
const ids = (alerts: OutageAlert[]) => alerts.map((alert) => `${alert.provider}:${alert.incident.id}`);

describe('outage alerts', () => {
  it('announces each open incident once, leaving maintenance and no-impact ones out', () => {
    const now = 1_000 * HOUR;
    const first = nextOutageNotifications({}, {
      claude: status([incident('a'), incident('m', { indicator: 'maintenance' }), incident('n', { indicator: 'none' })]),
      codex: null,
    }, now);
    expect(ids(first.fresh)).toEqual(['claude:a']);
    expect(first.notified).toEqual({ 'claude:a': now });

    // Still open an hour on, now being monitored: nothing new. The same id on the other page is its own incident.
    const again = nextOutageNotifications(first.notified, {
      claude: status([incident('a', { status: 'monitoring' })]),
      codex: status([incident('a')]),
    }, now + HOUR);
    expect(ids(again.fresh)).toEqual(['codex:a']);
    expect(again.notified['claude:a']).toBe(now);

    // Closed incidents are remembered for a week; open ones for as long as they run.
    expect(nextOutageNotifications(again.notified, {}, now + 2 * DAY).changed).toBe(false);
    expect(nextOutageNotifications(again.notified, {}, now + 8 * DAY)).toMatchObject({ notified: {}, fresh: [], changed: true });
    const longRunning = nextOutageNotifications(again.notified, { claude: status([incident('a')]) }, now + 8 * DAY);
    expect(longRunning.fresh).toEqual([]);
    expect(Object.keys(longRunning.notified)).toEqual(['claude:a']);
  });

  it('names the provider, the incident and how far along it is', () => {
    expect(outageNotification({ provider: 'claude', incident: incident('a', { name: 'Elevated errors for multiple models' }) }, t)).toEqual({
      title: 'Claude incident',
      body: 'Elevated errors for multiple models · Investigating',
      kind: 'outage',
      urgent: true,
      subject: { url: 'https://status.claude.com/' },
    });
    // A minor incident isn't urgent, and a state without a label is left off.
    expect(outageNotification({ provider: 'codex', incident: incident('b', { name: 'Increased latency in Codex CLI', status: 'postmortem', indicator: 'minor' }) }, t)).toEqual({
      title: 'Codex incident',
      body: 'Increased latency in Codex CLI',
      kind: 'outage',
      urgent: false,
      subject: { url: 'https://status.claude.com/' },
    });
  });
});
