import { describe, expect, test } from 'bun:test';
import { translate } from '../src/i18n';
import {
  activeUsageFilters,
  chippedUsageFilters,
  clearAllUsageFilters,
  clearUsageFilter,
  hasFailedToggle,
  isUsageFilterSet,
  noUsageFilters,
  offeredUsageFilters,
  usageFilterChange,
  usageFilterChips,
  usageFilterHasMenu,
  usageFilterValueText,
  type UsageFilters,
} from '../src/services/usageFilters';

const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);
const filters = (fields: Partial<UsageFilters> = {}): UsageFilters => ({ ...noUsageFilters, ...fields });

describe('which filters a page offers', () => {
  test('Usage narrows requests by what they are, where they came from and how they ended, and by a session', () => {
    expect(offeredUsageFilters('usage', 'events', filters())).toEqual(['model', 'provider', 'source', 'apiKeyHash', 'machine', 'result', 'session']);
    expect(offeredUsageFilters('usage', 'overview', filters())).toEqual(offeredUsageFilters('usage', 'events', filters()));
  });

  test('Requests’ Failed toggle stands for Result: Failed, so that pick has no chip there, and Clear all leaves it on', () => {
    expect(hasFailedToggle('usage', 'events')).toBe(true);
    expect(hasFailedToggle('usage', 'overview')).toBe(false);
    expect(hasFailedToggle('sessions', 'sessions')).toBe(false);
    const offered = offeredUsageFilters('usage', 'events', filters());
    expect(chippedUsageFilters('usage', 'events', filters({ result: 'failed' }), offered)).not.toContain('result');
    // Result's other picks, and Failed on a page without the toggle, still get their chip.
    expect(chippedUsageFilters('usage', 'events', filters({ result: 'success' }), offered)).toContain('result');
    expect(chippedUsageFilters('usage', 'overview', filters({ result: 'failed' }), offered)).toContain('result');
    expect(clearAllUsageFilters(true)).toEqual({ ...clearAllUsageFilters(), result: 'failed' });
    expect(clearAllUsageFilters().result).toBe('all');
  });

  test('Accounts’ Value and Weekly have none', () => {
    expect(offeredUsageFilters('value', 'capacity', filters())).toEqual([]);
    expect(offeredUsageFilters('usage', 'digest', filters())).toEqual([]);
  });

  test('Sessions leads with what a session is, and offers a branch only within a project', () => {
    expect(offeredUsageFilters('sessions', 'sessions', filters())).toEqual([
      'project', 'machine', 'client', 'pullRequests', 'model', 'provider', 'source', 'apiKeyHash', 'result',
    ]);
    expect(offeredUsageFilters('sessions', 'projects', filters({ project: 'arbor' })).slice(0, 3)).toEqual(['project', 'branch', 'machine']);
  });

  test('Machines picks its machine in the breadcrumb, which opens that machine’s page, so it offers no filters', () => {
    expect(offeredUsageFilters('machines', 'overview', filters())).toEqual([]);
    // A request filter left over from elsewhere has no chip there.
    const leftover = filters({ model: 'grok-4', result: 'failed', machine: 'ci-01' });
    expect(usageFilterChips(leftover, offeredUsageFilters('machines', 'overview', leftover), t)).toEqual([]);
  });

  test('Pricing narrows requests like Usage, without a session', () => {
    expect(offeredUsageFilters('pricing', 'pricing', filters())).toEqual(['model', 'provider', 'source', 'apiKeyHash', 'machine', 'result']);
  });
});

describe('what is set', () => {
  test('an empty value and All Results are no filter', () => {
    expect(isUsageFilterSet(filters(), 'result')).toBe(false);
    expect(isUsageFilterSet(filters({ result: 'failed' }), 'result')).toBe(true);
    expect(isUsageFilterSet(filters({ model: '' }), 'model')).toBe(false);
  });

  test('lists the set filters in the order they are offered, leaving out ones the tab does not offer', () => {
    const set = filters({ result: 'canceled', machine: 'casey-mbp', model: 'grok-4', client: 'Codex' });
    expect(activeUsageFilters(set, offeredUsageFilters('usage', 'events', set))).toEqual(['model', 'machine', 'result']);
    expect(activeUsageFilters(set, offeredUsageFilters('machines', 'overview', set))).toEqual([]);
    expect(activeUsageFilters(set, offeredUsageFilters('sessions', 'sessions', set))).toEqual(['machine', 'client', 'model', 'result']);
  });

  test('only a session has no menu; its chip is how it is seen and dropped', () => {
    expect(offeredUsageFilters('usage', 'events', filters()).filter(usageFilterHasMenu)).not.toContain('session');
    expect(offeredUsageFilters('sessions', 'sessions', filters()).every(usageFilterHasMenu)).toBe(true);
  });
});

describe('chips', () => {
  const names = {
    model: [{ key: 'grok-4', label: 'Grok 4' }],
    apiKeyHash: [{ key: 'a1b2c3', label: 'sk-…9f2e (laptop)' }],
  };

  test('name each set filter and say what it picks, as its menu does', () => {
    const set = filters({
      model: 'grok-4',
      apiKeyHash: 'a1b2c3',
      machine: '__unassigned__',
      result: 'failed',
      session: '3f2a8c1e-0000-4000-8000-000000000000',
    });
    expect(usageFilterChips(set, offeredUsageFilters('usage', 'events', set), t, names)).toEqual([
      { id: 'model', label: 'Model', value: 'Grok 4' },
      { id: 'apiKeyHash', label: 'API key', value: 'sk-…9f2e (laptop)' },
      { id: 'machine', label: 'Machine', value: 'Unassigned' },
      { id: 'result', label: 'Request result', value: 'Failed' },
      { id: 'session', label: 'Session', value: '3f2a8c1e' },
    ]);
  });

  test('show what is picked before the names load', () => {
    expect(usageFilterValueText(filters({ provider: 'xai' }), 'provider', t)).toBe('xai');
  });

  test('read a pull request pick as the menu does', () => {
    expect(usageFilterValueText(filters({ pullRequests: 'with' }), 'pullRequests', t)).toBe('With a PR');
    expect(usageFilterValueText(filters({ pullRequests: 'without' }), 'pullRequests', t)).toBe('Without a PR');
  });

  test('none when nothing is set', () => {
    expect(usageFilterChips(filters(), offeredUsageFilters('sessions', 'sessions', filters()), t)).toEqual([]);
  });
});

describe('changing and clearing', () => {
  test('a new project drops the branch, which belonged to the old one', () => {
    expect(usageFilterChange('project', 'proxy')).toEqual({ project: 'proxy', branch: '' });
    expect(clearUsageFilter('project')).toEqual({ project: '', branch: '' });
  });

  test('picks that are not choices read as no filter', () => {
    expect(usageFilterChange('result', 'failed')).toEqual({ result: 'failed' });
    expect(usageFilterChange('result', 'maybe')).toEqual({ result: 'all' });
    expect(usageFilterChange('pullRequests', 'without')).toEqual({ pullRequests: 'without' });
    expect(usageFilterChange('pullRequests', 'sometimes')).toEqual({ pullRequests: '' });
  });

  test('removing a chip clears just its filter', () => {
    expect(clearUsageFilter('machine')).toEqual({ machine: '' });
    expect(clearUsageFilter('result')).toEqual({ result: 'all' });
    expect(clearUsageFilter('session')).toEqual({ session: '' });
  });

  test('Clear all clears every filter, including ones the tab does not show', () => {
    const cleared = { ...filters({ model: 'grok-4', machine: 'casey-mbp', result: 'failed' }), ...clearAllUsageFilters() };
    expect(cleared).toEqual(noUsageFilters);
    expect(activeUsageFilters(cleared, offeredUsageFilters('sessions', 'sessions', cleared))).toEqual([]);
  });
});
