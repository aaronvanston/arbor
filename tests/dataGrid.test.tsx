import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createColumnHelper } from '@tanstack/react-table';
import { renderToStaticMarkup } from 'react-dom/server';
import { DataGrid, opensRow, useDataGrid, type DataGridColumnDef, type DataGridFeatures } from '../src/components/ui/data-grid/data-grid';
import { applyPreset, gridLayout, matchingPreset, sanitizeGridLayout } from '../src/components/ui/data-grid/data-grid-layout';
import { I18nProvider } from '../src/i18n';
import { RequestDetail, RequestsView } from '../src/pages/UsageRequestsGrid';
import type { UsageEventPage, UsageRecord, UsageRequestOrder } from '../src/native/types';
import {
  REQUEST_COLUMNS,
  REQUEST_PRESETS,
  REQUESTS_GRID_KEY,
  defaultRequestsLayout,
  legacyRequestsLayout,
  loadRequestOrder,
  requestJson,
  saveRequestOrder,
  readableFailureBody,
  requestOrderFor,
  requestSortColumn,
  steppedRecord,
} from '../src/services/usageRequestsGrid';

const columns = [{ id: 'a' }, { id: 'b', minSize: 50 }, { id: 'c' }, { id: 'd' }];
const storage = (entries: Record<string, unknown>) => ({
  getItem: (key: string) => (key in entries ? JSON.stringify(entries[key]) : null),
});

describe('grid layout', () => {
  it('shows the chosen columns first, in that order, and hides the rest after them', () => {
    expect(gridLayout(columns, ['c', 'a', 'zz'], ['a'])).toEqual({
      visibility: { a: true, b: false, c: true, d: false },
      order: ['c', 'a', 'b', 'd'],
      pinning: { start: ['a'], end: [] },
      sizing: {},
    });
  });

  it('keeps what it can of a saved layout and fills in the rest', () => {
    const fallback = gridLayout(columns, ['a', 'b', 'c', 'd']);
    const saved = {
      visibility: { a: false, b: true, gone: true },
      order: ['b', 'gone', 'a', 'b'],
      pinning: { start: ['b', 'gone'], end: ['b', 'c'] },
      sizing: { a: 120.4, b: 20, c: 'wide' },
    };
    // d is new since it was saved: it shows, as it does by default, and goes last.
    expect(sanitizeGridLayout(saved, columns, fallback)).toEqual({
      visibility: { a: false, b: true, c: true, d: true },
      order: ['b', 'a', 'c', 'd'],
      pinning: { start: ['b'], end: ['c'] },
      sizing: { a: 120 },
    });
  });

  it('never keeps a layout that hides every column, or one that isn’t a layout', () => {
    const fallback = gridLayout(columns, ['a']);
    expect(sanitizeGridLayout({ visibility: { a: false, b: false, c: false, d: false } }, columns, fallback)).toBe(fallback);
    expect(sanitizeGridLayout('nonsense', columns, fallback)).toBe(fallback);
  });

  it('applies a column set without losing pins or widths, and knows which set is showing', () => {
    const presets = [{ id: 'small', label: 'Small', columns: ['d', 'a'] }];
    const layout = { ...gridLayout(columns, ['a', 'b'], ['a']), sizing: { b: 90 } };
    const applied = applyPreset(layout, columns, presets[0]!);
    expect(applied.order.slice(0, 2)).toEqual(['d', 'a']);
    expect(applied.visibility).toEqual({ a: true, b: false, c: false, d: true });
    expect(applied.pinning).toEqual(layout.pinning);
    expect(applied.sizing).toEqual({ b: 90 });
    expect(matchingPreset(applied, presets)?.id).toBe('small');
    expect(matchingPreset(layout, presets)).toBeUndefined();
  });
});

describe('requests grid', () => {
  it('starts with the default set and Time pinned', () => {
    const layout = legacyRequestsLayout(storage({}));
    expect(layout).toEqual(defaultRequestsLayout());
    expect(layout.order.filter((id) => layout.visibility[id])).toEqual(REQUEST_PRESETS.default);
    expect(layout.pinning.start).toEqual(['time']);
  });

  it('moves the old saved columns and widths over', () => {
    const layout = legacyRequestsLayout(
      storage({
        'arbor.usage-events-visible-cols.v3': ['time', 'model', 'total', 'unknown'],
        'arbor.usage-events-col-widths.v1': { model: 260, total: 10, time: 164 },
      }),
    );
    expect(layout.order.filter((id) => layout.visibility[id])).toEqual(['time', 'model', 'total']);
    // A width under the column's minimum is dropped.
    expect(layout.sizing).toEqual({ model: 260, time: 164 });
  });

  it('adds Machine and Client for someone coming from before they were columns', () => {
    const layout = legacyRequestsLayout(storage({ 'arbor.usage-events-visible-cols.v2': ['time', 'model'] }));
    expect(layout.order.filter((id) => layout.visibility[id])).toEqual(['machine', 'client', 'time', 'model']);
  });

  it('has a size and a set for every column it names', () => {
    const ids = REQUEST_COLUMNS.map((column) => column.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const set of Object.values(REQUEST_PRESETS)) expect(set.every((id) => ids.includes(id))).toBe(true);
  });
});

describe('requests grid view', () => {
  const saved = new Map<string, string>();
  const global = globalThis as { localStorage?: unknown };
  let previous: unknown;
  beforeEach(() => {
    previous = global.localStorage;
    saved.clear();
    global.localStorage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) };
  });
  afterEach(() => {
    global.localStorage = previous;
  });

  const record: UsageRecord = {
    machine: 'ci-01',
    pool: '',
    user_agent: 'codex_cli_rs/0.149.1 (Mac OS 26.5.2; arm64)',
    client_ip: '10.0.0.4',
    x_forwarded_for: null,
    id: 'r1',
    timestamp: '2026-09-26T02:11:08Z',
    latency_ms: 2380,
    ttft_ms: 420,
    source: 'codex',
    source_display: 'Codex · ci',
    failed: true,
    canceled: false,
    failure_status: 429,
    failure_body: '{"error":{"message":"Rate limited"}}',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    alias: '',
    reasoning_effort: 'high',
    endpoint: '/v1/responses',
    api_key_hash: '',
    api_key_display: 'sk-…abcd',
    api_key_remark: 'CI runner',
    auth_index: '',
    service_tier: '',
    response_service_tier: '',
    executor_type: '',
    auth_type: '',
    request_id: '',
    tokens: { input_tokens: 4000, output_tokens: 800, reasoning_tokens: 0, cache_read_tokens: 3000, cache_creation_tokens: 0, total_tokens: 7800 },
  };
  const page: UsageEventPage = { items: [record], total: 1, page: 1, pageSize: 50, totalPages: 1 };
  const render = (order: UsageRequestOrder | null = null, failedOnly = false) =>
    renderToStaticMarkup(
      <I18nProvider>
        <RequestsView
          events={page}
          filters={null}
          failedOnly={failedOnly}
          summary={failedOnly ? <p>1 failed of 40</p> : null}
          pageSize={50}
          order={order}
          empty={<p>Nothing</p>}
          onPage={() => {}}
          onPageSizeChange={() => {}}
          onOrderChange={() => {}}
        />
      </I18nProvider>,
    );
  const detail = (changes: Partial<UsageRecord> = {}) =>
    renderToStaticMarkup(
      <I18nProvider>
        <RequestDetail record={{ ...record, ...changes }} onClose={() => {}} />
      </I18nProvider>,
    );
  const headers = (html: string) => [...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((match) => match[1]!.replace(/<[^>]+>/g, ''));
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  it('draws the default columns with Time first, and each cell on one line', () => {
    const html = render();
    expect(headers(html)).toEqual(['Time', 'Machine', 'Client', 'Model', 'Input', 'Output', 'Cache', 'Cache rate', 'Total', 'Speed', 'First token', 'Duration', 'Result', 'Source']);
    expect(text(html)).toContain('gpt-5.6-sol high');
    expect(text(html)).toContain('Failed 429');
    expect(text(html)).toContain('75%');
    expect(text(html)).toContain('2.38 s');
    expect(html).toContain('style="left:var(--pin-time)"');
  });

  it('follows the saved layout: its columns, its order and its pins', () => {
    saved.set(REQUESTS_GRID_KEY, JSON.stringify({ ...gridLayout(REQUEST_COLUMNS, ['model', 'result', 'key'], ['result']) }));
    const html = render();
    // Pinned columns come first.
    expect(headers(html)).toEqual(['Result', 'Model', 'API key']);
    expect(text(html)).toContain('CI runner');
  });

  it('starts Failed on the failure columns, with what the provider said, and keeps its layout apart', () => {
    saved.set(REQUESTS_GRID_KEY, JSON.stringify({ ...gridLayout(REQUEST_COLUMNS, ['model'], []) }));
    const html = render(null, true);
    expect(headers(html)).toEqual(['Time', 'Result', 'What went wrong', 'Provider', 'Model', 'Client', 'Machine', 'API key']);
    expect(text(html)).toContain('Rate limited');
    expect(text(html)).toContain('1 failed of 40');
    expect(html).toContain('aria-label="Failed requests"');
  });

  it('marks the column the server sorted by, and nothing when it lists newest first', () => {
    expect(render()).not.toContain('aria-sort');
    const html = render({ by: 'total', descending: true });
    expect(html.match(/aria-sort="[a-z]+"/g)).toEqual(['aria-sort="descending"']);
    expect(html).toContain('aria-label="High to low"');
    // Rows open their detail, so each one can take focus.
    expect(html).toMatch(/<tr [^>]*tabindex="0"/);
  });

  it('opens a failed request with what the provider said, exact token counts and its ids', () => {
    const html = text(detail({ request_id: 'req_123', auth_index: '7' }));
    expect(html).toContain('Failed 429');
    expect(html).toContain('HTTP status 429');
    expect(html).toContain('&quot;message&quot;: &quot;Rate limited&quot;');
    expect(html).toContain('Input 4,000');
    expect(html).toContain('Total 7,800');
    expect(html).toContain('req_123');
    expect(html).toContain('Account index 7');
  });

  it('copies a request as JSON in the proxy\'s own field names', () => {
    const json = JSON.parse(requestJson({ ...record, request_id: 'req_9' })) as Record<string, unknown>;
    expect(json.request_id).toBe('req_9');
    expect(json.failure_status).toBe(429);
    expect(json.api_key_display).toBe('sk-…abcd');
    expect(detail()).toContain('aria-label="Copy request as JSON"');
  });

  it('says so when a failure came back empty, and shows no failure for a request that worked', () => {
    expect(text(detail({ failure_body: ' ' }))).toContain('The provider sent nothing back.');
    const worked = text(detail({ failed: false, failure_status: 0, failure_body: '' }));
    expect(worked).toContain('Success');
    expect(worked).not.toContain('Why it failed');
    expect(worked).not.toContain('What the provider said');
    expect(worked).not.toContain('HTTP status');
  });

  it('steps to the request above or below the open one, and stops at the ends of the page', () => {
    const rows = ['a', 'b', 'c'].map((id) => ({ ...record, id }));
    expect(steppedRecord(rows, 'b', 1)?.id).toBe('c');
    expect(steppedRecord(rows, 'b', -1)?.id).toBe('a');
    expect(steppedRecord(rows, 'c', 1)).toBeUndefined();
    expect(steppedRecord(rows, 'a', -1)).toBeUndefined();
    expect(steppedRecord(rows, 'gone', 1)).toBeUndefined();
  });
});

describe('request order', () => {
  it('turns a column sort into the order the server takes, with newest first as no order at all', () => {
    expect(requestOrderFor({ column: 'latency', descending: true })).toEqual({ by: 'latency', descending: true });
    expect(requestOrderFor({ column: 'time', descending: false })).toEqual({ by: 'time', descending: false });
    expect(requestOrderFor({ column: 'time', descending: true })).toBeNull();
    // Speed is worked out from two columns, so it has no order of its own.
    expect(requestOrderFor({ column: 'speed', descending: true })).toBeNull();
    expect(requestOrderFor(null)).toBeNull();
  });

  it('lays out a JSON failure one field to a line and leaves anything else as sent', () => {
    expect(readableFailureBody(' {"error":{"code":429}} ')).toBe('{\n  "error": {\n    "code": 429\n  }\n}');
    expect(readableFailureBody('{"cut off')).toBe('{"cut off');
    expect(readableFailureBody('upstream timed out')).toBe('upstream timed out');
  });

  it('remembers a sort, and forgets newest first and anything it no longer takes', () => {
    const kept = new Map<string, string>();
    const store = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    };
    saveRequestOrder(store, { by: 'latency', descending: true });
    expect(loadRequestOrder(store)).toEqual({ by: 'latency', descending: true });
    saveRequestOrder(store, null);
    expect(kept.size).toBe(0);
    expect(loadRequestOrder(store)).toBeNull();
    for (const bad of ['{"by":"speed","descending":true}', '{"by":"total"}', '{"by":"time","descending":true}', 'nope']) {
      kept.set('arbor.usage-requests-order.v1', bad);
      expect(loadRequestOrder(store)).toBeNull();
    }
  });

  it('keeps a sort with Failed on apart from All', () => {
    const kept = new Map<string, string>();
    const store = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
      removeItem: (key: string) => void kept.delete(key),
    };
    saveRequestOrder(store, { by: 'time', descending: false }, true);
    expect(loadRequestOrder(store, true)).toEqual({ by: 'time', descending: false });
    expect(loadRequestOrder(store)).toBeNull();
    saveRequestOrder(store, { by: 'total', descending: true });
    expect(loadRequestOrder(store, true)).toEqual({ by: 'time', descending: false });
    saveRequestOrder(store, null, true);
    expect(loadRequestOrder(store, true)).toBeNull();
    expect(loadRequestOrder(store)).toEqual({ by: 'total', descending: true });
  });

  it('shows an order on the column it sorts', () => {
    expect(requestSortColumn({ by: 'cache', descending: false })).toEqual({ column: 'cache', descending: false });
    expect(requestSortColumn({ by: 'time', descending: true })).toBeNull();
    expect(requestSortColumn(null)).toBeNull();
  });
});

describe('a row’s own controls in a grid', () => {
  type Row = { id: string; name: string };
  const helper = createColumnHelper<DataGridFeatures, Row>();
  const gridColumns: DataGridColumnDef<Row>[] = [
    helper.display({ id: 'name', header: 'Name', size: 200, cell: ({ row }) => row.original.name, meta: { label: 'Name' } }),
    helper.display({ id: 'actions', header: 'Actions', size: 52, enableResizing: false, cell: () => <button type="button">More</button>, meta: { label: 'Actions', fixed: true } }),
  ];
  function Grid() {
    const grid = useDataGrid({
      data: [{ id: '1', name: 'Sentry watch' }],
      columns: gridColumns,
      getRowId: (row) => row.id,
      storageKey: 'arbor.test-fixed-grid',
      initialLayout: () => ({ ...gridLayout(gridColumns.map((column) => ({ id: column.id ?? '' })), ['name', 'actions']), pinning: { start: [], end: ['actions'] } }),
    });
    return <DataGrid grid={grid} label="Rows" surface="card" rowClassName={(row) => (row.id === '1' ? 'row-under' : undefined)} />;
  }

  it('has no header menu or width to drag, only its name for screen readers', () => {
    const html = renderToStaticMarkup(<I18nProvider><Grid /></I18nProvider>);
    const heads = [...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((match) => match[1] ?? '');
    expect(heads).toHaveLength(2);
    expect(heads[0]).toContain('aria-haspopup');
    expect(heads[1]).toBe('<span class="sr-only">Actions</span>');
    expect(html).toContain('style="right:var(--pin-actions)"');
    expect(html).toMatch(/<tr[^>]*class="[^"]*row-under/);
  });
});

describe('row clicks', () => {
  // Stand-ins for DOM nodes: tests have no DOM, and the guard only asks where a click landed.
  const node = (matches: string[] = []) => ({ closest: (selector: string) => (matches.some((match) => selector.includes(match)) ? {} : null) });
  const cell = node();
  const link = node(['a,']);
  const menuItem = node(['[role="menuitem"]']);
  const inRow = new Set<unknown>([cell, link]);
  const row = { contains: (target: unknown) => inRow.has(target) };
  const collapsed = { isCollapsed: true, anchorNode: null };

  it('opens the row from a plain cell', () => {
    expect(opensRow(cell as unknown as EventTarget, row, collapsed)).toBe(true);
  });

  it("leaves a click on the cell's own link alone", () => {
    expect(opensRow(link as unknown as EventTarget, row, collapsed)).toBe(false);
  });

  it("doesn't open the row from a portaled menu item, whose click React bubbles to the row", () => {
    expect(opensRow(menuItem as unknown as EventTarget, row, collapsed)).toBe(false);
    inRow.add(menuItem);
    expect(opensRow(menuItem as unknown as EventTarget, row, collapsed)).toBe(false);
  });
});
