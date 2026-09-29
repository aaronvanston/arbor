import { describe, expect, test } from 'bun:test';
import { usageViewScopeKey, type UsageViewScope } from '../src/services/usageViewScope';

const allModelsScope: UsageViewScope = {
  tab: 'overview',
  range: '24h',
  customStart: '',
  customEnd: '',
  machine: '',
  model: '',
  provider: '',
  source: '',
  apiKeyHash: '',
  result: 'all',
};

describe('usage view scope', () => {
  test('invalidates a filtered snapshot when switching back to all models', () => {
    const grokScope = usageViewScopeKey({ ...allModelsScope, model: 'grok-4' });
    const currentScope = usageViewScopeKey(allModelsScope);

    expect(currentScope).not.toBe(grokScope);
  });

  test('invalidates snapshots when a session is picked or cleared', () => {
    const session = usageViewScopeKey({ ...allModelsScope, session: '3f2a8c1e-0000-4000-8000-000000000000' });
    expect(session).not.toBe(usageViewScopeKey(allModelsScope));
    expect(usageViewScopeKey({ ...allModelsScope, session: '' })).toBe(usageViewScopeKey(allModelsScope));
  });

  test('invalidates snapshots for tab changes', () => {
    expect(usageViewScopeKey({ ...allModelsScope, tab: 'events' })).not.toBe(usageViewScopeKey(allModelsScope));
  });

  test('keeps the snapshot while paging, so the current rows stay up until the next page arrives', () => {
    const paged: UsageViewScope & { page: number; pageSize: number } = { ...allModelsScope, page: 2, pageSize: 100 };

    expect(usageViewScopeKey(paged)).toBe(usageViewScopeKey(allModelsScope));
  });

  test('invalidates snapshots when the machine filter changes', () => {
    const base = usageViewScopeKey(allModelsScope);
    const machineScope = usageViewScopeKey({ ...allModelsScope, machine: 'casey-mbp' });

    expect(machineScope).not.toBe(base);
    expect(usageViewScopeKey({ ...allModelsScope, machine: '__unassigned__' })).not.toBe(machineScope);
  });

  test('invalidates snapshots when a Sessions menu changes, but not while searching', () => {
    const base = usageViewScopeKey({ ...allModelsScope, tab: 'sessions' });
    expect(usageViewScopeKey({ ...allModelsScope, tab: 'sessions', project: 'arbor' })).not.toBe(base);
    expect(usageViewScopeKey({ ...allModelsScope, tab: 'sessions', project: 'arbor', branch: 'main' }))
      .not.toBe(usageViewScopeKey({ ...allModelsScope, tab: 'sessions', project: 'arbor' }));
    expect(usageViewScopeKey({ ...allModelsScope, tab: 'sessions', client: 'Claude Code' })).not.toBe(base);
    expect(usageViewScopeKey({ ...allModelsScope, tab: 'sessions', pullRequests: 'with' })).not.toBe(base);
    const searching: UsageViewScope & { search: string } = { ...allModelsScope, tab: 'sessions', search: 'login' };
    expect(usageViewScopeKey(searching)).toBe(base);
  });

  test('keeps adjacent filter values from colliding', () => {
    expect(usageViewScopeKey({ ...allModelsScope, machine: 'a', model: '' }))
      .not.toBe(usageViewScopeKey({ ...allModelsScope, machine: '', model: 'a' }));
  });
});
