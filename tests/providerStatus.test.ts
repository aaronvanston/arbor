import { beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { translate } from '../src/i18n';
import {
  activeStatus,
  claudeStatusFrom,
  codexStatusFrom,
  componentIndicator,
  dismissProviderStatus,
  getDismissedStatuses,
  getProviderStatuses,
  refreshProviderStatuses,
  retainProviderStatuses,
  statusSignature,
  STATUS_STALE_AFTER_MS,
  worstIndicator,
  type ProviderStatus,
} from '../src/services/providerStatus';
import { statusSummary } from '../src/services/providerStatusText';

const NOW = Date.parse('2030-01-10T00:00:00Z');
const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);

const claudePage = (overrides: { components?: Record<string, string>; incidents?: unknown[]; scheduled_maintenances?: unknown[] } = {}) => ({
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [
    ['c-web', 'claude.ai'],
    ['c-console', 'Claude Console (platform.claude.com)'],
    ['c-api', 'Claude API (api.anthropic.com)'],
    ['c-code', 'Claude Code'],
    ['c-gov', 'Claude for Government'],
  ].map(([id, name]) => ({ id, name, status: overrides.components?.[id!] ?? 'operational', group: false })),
  incidents: overrides.incidents ?? [],
  scheduled_maintenances: overrides.scheduled_maintenances ?? [],
});
const incident = (overrides: Record<string, unknown> = {}) => ({
  id: 'inc-1', name: 'Elevated errors for multiple models', status: 'investigating', impact: 'major',
  shortlink: 'https://stspg.io/abc', updated_at: '2030-01-09T23:48:00Z', components: [{ id: 'c-api' }], ...overrides,
});

const openaiPage = (overrides: { affected?: unknown[]; incidents?: unknown[]; maintenances?: unknown[]; groups?: unknown[] } = {}) => ({
  summary: {
    affected_components: overrides.affected ?? [],
    ongoing_incidents: overrides.incidents ?? [],
    scheduled_maintenances: overrides.maintenances ?? [],
    structure: {
      items: overrides.groups ?? [
        { group: { id: 'g-apis', name: 'APIs', hidden: false, components: [{ component_id: 'responses', name: 'Responses' }, { component_id: 'sora', name: 'Sora' }] } },
        {
          group: {
            id: 'g-codex', name: 'Codex', hidden: false, components: [
              { component_id: 'web', name: 'Codex Web', hidden: false },
              { component_id: 'cli', name: 'CLI', hidden: false },
              { component_id: 'retired', name: 'Old surface', hidden: true },
            ],
          },
        },
        { component: { component_id: 'fedramp', name: 'FedRAMP', hidden: false } },
      ],
    },
  },
});

beforeEach(() => retainProviderStatuses([]));

describe('status severity', () => {
  it('maps component statuses and ranks them the way CodexBar does', () => {
    expect(['operational', 'degraded_performance', 'partial_outage', 'major_outage', 'full_outage', 'under_maintenance', 'bogus', '']
      .map(componentIndicator)).toEqual(['none', 'minor', 'major', 'critical', 'critical', 'maintenance', 'unknown', 'none']);
    expect(worstIndicator([])).toBe('none');
    expect(worstIndicator(['maintenance', 'minor'])).toBe('minor');
    expect(worstIndicator(['critical', 'major', 'unknown'])).toBe('critical');
    expect(worstIndicator(['none', 'maintenance'])).toBe('maintenance');
  });
});

describe('reading status.claude.com', () => {
  it('watches only the Claude API and Claude Code', () => {
    const status = claudeStatusFrom(claudePage({ components: { 'c-web': 'major_outage', 'c-gov': 'partial_outage' } }), NOW);
    expect(status.indicator).toBe('none');
    expect(status.components.map((component) => component.name)).toEqual(['Claude API (api.anthropic.com)', 'Claude Code']);
    expect(status.checkedAt).toBe(NOW);
  });

  it('takes the worst of the components and the incidents still being worked on', () => {
    const status = claudeStatusFrom(claudePage({
      components: { 'c-code': 'degraded_performance' },
      incidents: [
        incident(),
        incident({ id: 'inc-web', name: 'claude.ai is slow', components: [{ id: 'c-web' }] }),
        incident({ id: 'inc-billing', name: 'Issues with Google Play subscriptions', impact: 'none', components: [] }),
        incident({ id: 'inc-broad', name: 'Elevated errors across products', impact: 'minor', components: [] }),
      ],
    }), NOW);
    expect(status.indicator).toBe('major');
    expect(status.incidents.map((item) => [item.id, item.indicator, item.url])).toEqual([
      ['inc-1', 'major', 'https://stspg.io/abc'],
      ['inc-broad', 'minor', 'https://stspg.io/abc'],
    ]);
  });

  it('lists an incident being monitored without letting it raise the status', () => {
    const status = claudeStatusFrom(claudePage({ incidents: [incident({ status: 'monitoring', shortlink: null })] }), NOW);
    expect(status.indicator).toBe('none');
    expect(status.incidents).toEqual([{
      id: 'inc-1', name: 'Elevated errors for multiple models', status: 'monitoring', indicator: 'major',
      updatedAt: '2030-01-09T23:48:00Z', url: 'https://status.claude.com/incidents/inc-1',
    }]);
    expect(activeStatus(status, NOW)).toBeNull();
  });

  it('reports maintenance that is under way, not maintenance that is scheduled', () => {
    const maintenance = (status: string) => ({ id: `m-${status}`, name: 'Database maintenance', status, impact: 'maintenance', components: [{ id: 'c-api' }] });
    const status = claudeStatusFrom(claudePage({ scheduled_maintenances: [maintenance('in_progress'), maintenance('scheduled')] }), NOW);
    expect(status.indicator).toBe('maintenance');
    expect(status.incidents.map((item) => item.id)).toEqual(['m-in_progress']);
  });

  it('rejects replies it cannot read', () => {
    expect(() => claudeStatusFrom('nope', NOW)).toThrow();
    expect(() => claudeStatusFrom({ components: [{ id: 'x', name: 'Something else', status: 'operational' }] }, NOW)).toThrow();
  });
});

describe('reading status.openai.com', () => {
  it('watches only the visible components in the Codex group', () => {
    const status = codexStatusFrom(openaiPage({ affected: [{ component_id: 'sora', status: 'full_outage' }] }), NOW);
    expect(status.indicator).toBe('none');
    expect(status.components).toEqual([
      { id: 'web', name: 'Codex Web', indicator: 'none' },
      { id: 'cli', name: 'CLI', indicator: 'none' },
    ]);
  });

  it('reads Codex components and the incidents that touch them', () => {
    const status = codexStatusFrom(openaiPage({
      affected: [{ component_id: 'cli', status: 'partial_outage' }],
      incidents: [
        { id: 'i-cli', name: 'CLI requests failing', status: 'identified', current_worst_impact: 'partial_outage', last_update_at: '2030-01-09T23:30:00Z', affected_components: [{ component_id: 'cli' }] },
        { id: 'i-sora', name: 'Sora unavailable', status: 'investigating', current_worst_impact: 'full_outage', affected_components: [{ component_id: 'sora' }] },
        { id: 'i-named', name: 'Codex cloud tasks delayed', status: 'investigating' },
        { id: 'i-done', name: 'Codex Web errors', status: 'resolved', affected_components: [{ component_id: 'web' }] },
        { name: '' },
        'junk',
      ],
    }), NOW);
    expect(status.indicator).toBe('major');
    expect(status.incidents.map((item) => [item.id, item.status, item.indicator, item.url])).toEqual([
      ['i-cli', 'identified', 'major', 'https://status.openai.com/incidents/i-cli'],
      ['i-named', 'investigating', 'none', 'https://status.openai.com/incidents/i-named'],
    ]);
    expect(status.incidents[0]?.updatedAt).toBe('2030-01-09T23:30:00Z');
  });

  it('falls back to the component statuses for an incident without an overall impact', () => {
    const status = codexStatusFrom(openaiPage({
      incidents: [{ id: 'i', name: 'Latency', status: 'investigating', component_impacts: [{ component_id: 'web', status: 'degraded_performance' }] }],
    }), NOW);
    expect(status.indicator).toBe('minor');
    expect(status.incidents[0]?.indicator).toBe('minor');
  });

  it('rejects a page without a Codex group', () => {
    expect(() => codexStatusFrom(openaiPage({ groups: [{ group: { id: 'g', name: 'APIs', components: [] } }] }), NOW)).toThrow();
    expect(() => codexStatusFrom({ summary: {} }, NOW)).toThrow();
  });
});

describe('checking the status pages', () => {
  const reply = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('keeps the last good status, marked with the error, when a check fails', async () => {
    const outage = claudePage({ components: { 'c-api': 'partial_outage' } });
    await refreshProviderStatuses(['claude'], () => reply(outage), () => NOW);
    expect(getProviderStatuses().claude?.indicator).toBe('major');

    await refreshProviderStatuses(['claude'], () => reply({}, 503), () => NOW + 60_000);
    expect(getProviderStatuses().claude).toMatchObject({ indicator: 'major', checkedAt: NOW, error: 'HTTP 503' });

    await refreshProviderStatuses(['claude'], () => reply(claudePage()), () => NOW + 120_000);
    expect(getProviderStatuses().claude).toMatchObject({ indicator: 'none', checkedAt: NOW + 120_000 });
    expect(getProviderStatuses().claude?.error).toBeUndefined();
  });

  it('records nothing when the first check fails, and forgets providers it stops checking', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    await refreshProviderStatuses(['codex'], () => Promise.reject(new Error('offline')), () => NOW);
    expect(getProviderStatuses().codex).toBeUndefined();
    warn.mockRestore();

    await refreshProviderStatuses(['claude', 'codex'], (url) => reply(url.includes('claude') ? claudePage() : openaiPage()), () => NOW);
    expect(Object.keys(getProviderStatuses()).sort()).toEqual(['claude', 'codex']);
    retainProviderStatuses(['codex']);
    expect(Object.keys(getProviderStatuses())).toEqual(['codex']);
  });

  it('stops showing a status once it is too old to trust', () => {
    const status = claudeStatusFrom(claudePage({ components: { 'c-api': 'partial_outage' } }), NOW);
    expect(activeStatus(status, NOW + STATUS_STALE_AFTER_MS)).toBe(status);
    expect(activeStatus(status, NOW + STATUS_STALE_AFTER_MS + 1)).toBeNull();
  });

  it('keeps a dismissed banner closed until the problem changes, and forgets it after recovery', async () => {
    const dismissed = () => getDismissedStatuses().claude;
    const outage = claudePage({ components: { 'c-api': 'partial_outage' }, incidents: [incident()] });
    await refreshProviderStatuses(['claude'], () => reply(outage), () => NOW);
    const status = getProviderStatuses().claude!;
    dismissProviderStatus('claude', status);
    expect(dismissed()).toBe(statusSignature(status));

    const worse = claudeStatusFrom(claudePage({ components: { 'c-api': 'major_outage' }, incidents: [incident()] }), NOW);
    expect(statusSignature(worse)).not.toBe(statusSignature(status));
    const followUp = claudeStatusFrom(claudePage({ components: { 'c-api': 'partial_outage' }, incidents: [incident({ status: 'identified' })] }), NOW);
    expect(statusSignature(followUp)).toBe(statusSignature(status));

    await refreshProviderStatuses(['claude'], () => reply(claudePage()), () => NOW);
    expect(dismissed()).toBeUndefined();
  });
});

describe('describing a status', () => {
  const status = (overrides: Partial<ProviderStatus>): ProviderStatus => ({ indicator: 'major', components: [], incidents: [], checkedAt: NOW, ...overrides });

  it('names the incident still being worked on, else the worst component, else the overall state', () => {
    expect(statusSummary(status({
      incidents: [
        { id: 'a', name: 'Recovering', status: 'monitoring', indicator: 'critical', url: 'https://x' },
        { id: 'b', name: 'Elevated errors', status: 'investigating', indicator: 'minor', url: 'https://x' },
      ],
    }), t)).toBe('Elevated errors');
    expect(statusSummary(status({
      components: [{ id: 'a', name: 'Claude API', indicator: 'minor' }, { id: 'b', name: 'Claude Code', indicator: 'major' }],
    }), t)).toBe('Claude Code: Partial outage');
    expect(statusSummary(status({ indicator: 'maintenance' }), t)).toBe('Under maintenance');
  });
});
