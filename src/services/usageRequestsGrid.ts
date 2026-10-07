import { gridLayout, type DataGridLayout } from '../components/ui/data-grid/data-grid-layout';
import type { UsageRecord, UsageRequestOrder, UsageRequestSortKey } from '../native/types';

/** The columns of Usage › Requests. */
export type RequestColumnId =
  | 'time'
  | 'machine'
  | 'client'
  | 'model'
  | 'input'
  | 'output'
  | 'cache'
  | 'cacheRate'
  | 'total'
  | 'speed'
  | 'ttft'
  | 'latency'
  | 'result'
  | 'source'
  | 'provider'
  | 'key'
  | 'reasoning'
  | 'clientIp'
  | 'forwardedIp'
  | 'message';

/** Every column in its default order, the width it starts at and the narrowest it goes. */
export const REQUEST_COLUMNS: readonly { id: RequestColumnId; size: number; minSize: number }[] = [
  { id: 'time', size: 150, minSize: 96 },
  { id: 'machine', size: 140, minSize: 90 },
  { id: 'client', size: 150, minSize: 90 },
  { id: 'model', size: 220, minSize: 120 },
  { id: 'input', size: 80, minSize: 60 },
  { id: 'output', size: 80, minSize: 60 },
  { id: 'cache', size: 80, minSize: 60 },
  { id: 'cacheRate', size: 110, minSize: 80 },
  { id: 'total', size: 84, minSize: 60 },
  { id: 'speed', size: 96, minSize: 70 },
  { id: 'ttft', size: 112, minSize: 70 },
  { id: 'latency', size: 96, minSize: 70 },
  { id: 'result', size: 120, minSize: 90 },
  { id: 'source', size: 160, minSize: 80 },
  { id: 'provider', size: 120, minSize: 80 },
  { id: 'key', size: 180, minSize: 95 },
  { id: 'reasoning', size: 88, minSize: 60 },
  { id: 'clientIp', size: 130, minSize: 90 },
  { id: 'forwardedIp', size: 150, minSize: 90 },
  { id: 'message', size: 320, minSize: 120 },
];

export type RequestPresetId = 'default' | 'tokens' | 'speed' | 'failures';

/**
 * The column sets on offer. The model's cell carries its provider's mark, so Provider is only a column of its own where
 * failures are being read.
 */
export const REQUEST_PRESETS: Record<RequestPresetId, RequestColumnId[]> = {
  default: ['time', 'machine', 'client', 'model', 'input', 'output', 'cache', 'cacheRate', 'total', 'speed', 'ttft', 'latency', 'result', 'source'],
  tokens: ['time', 'client', 'model', 'input', 'output', 'reasoning', 'cache', 'cacheRate', 'total', 'result'],
  speed: ['time', 'machine', 'model', 'output', 'speed', 'ttft', 'latency', 'result'],
  failures: ['time', 'result', 'message', 'provider', 'model', 'client', 'machine', 'key'],
};

export const REQUEST_PRESET_IDS = Object.keys(REQUEST_PRESETS) as RequestPresetId[];

export const REQUESTS_GRID_KEY = 'arbor.usage-requests-grid.v4';
/** Failed on keeps a layout of its own, which starts on the failure columns: what went wrong is what it's read for. */
export const FAILED_REQUESTS_GRID_KEY = 'arbor.usage-failed-requests-grid.v1';
const VISIBLE_KEY = 'arbor.usage-events-visible-cols.v3';
// Before Machine and Client were columns; they show for anyone moving on from it.
const OLDER_VISIBLE_KEY = 'arbor.usage-events-visible-cols.v2';
const WIDTHS_KEY = 'arbor.usage-events-col-widths.v1';

const PINNED: RequestColumnId[] = ['time'];

export const defaultRequestsLayout = (): DataGridLayout => gridLayout(REQUEST_COLUMNS, REQUEST_PRESETS.default, PINNED);
export const defaultFailedRequestsLayout = (): DataGridLayout => gridLayout(REQUEST_COLUMNS, REQUEST_PRESETS.failures, PINNED);

const read = (storage: Pick<Storage, 'getItem'>, key: string): unknown => {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
};

/**
 * The layout the table had before it was a grid: the columns chosen then (in the order they showed) and any widths
 * dragged, with Time pinned. The default layout when nothing was saved. The old keys are left alone, so an older Arbor
 * still finds them.
 */
export function legacyRequestsLayout(storage: Pick<Storage, 'getItem'>): DataGridLayout {
  const current = read(storage, VISIBLE_KEY);
  const saved = current ?? read(storage, OLDER_VISIBLE_KEY);
  const known = new Set<string>(REQUEST_COLUMNS.map((column) => column.id));
  const chosen = Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string' && known.has(id)) : [];
  const visible = chosen.length ? (current ? chosen : ['machine', 'client', ...chosen]) : REQUEST_PRESETS.default;
  const layout = gridLayout(REQUEST_COLUMNS, visible, PINNED);

  const widths = read(storage, WIDTHS_KEY);
  if (widths && typeof widths === 'object') {
    for (const column of REQUEST_COLUMNS) {
      const width = (widths as Record<string, unknown>)[column.id];
      if (typeof width === 'number' && Number.isFinite(width) && width >= column.minSize) layout.sizing[column.id] = Math.round(width);
    }
  }
  return layout;
}

/**
 * The columns the server can order requests by: the ones stored as they're shown. Speed and Cache rate are worked out
 * from two columns each, so they don't sort; the rest are words, which don't sort usefully.
 */
export const REQUEST_SORT_KEYS: Partial<Record<RequestColumnId, UsageRequestSortKey>> = {
  time: 'time',
  input: 'input',
  output: 'output',
  cache: 'cache',
  reasoning: 'reasoning',
  total: 'total',
  ttft: 'ttft',
  latency: 'latency',
};

/** The column a request order sorts, for showing it in the grid's header. Newest first is no sort at all. */
export function requestSortColumn(order: UsageRequestOrder | null): { column: RequestColumnId; descending: boolean } | null {
  if (!order || (order.by === 'time' && order.descending)) return null;
  const column = (Object.keys(REQUEST_SORT_KEYS) as RequestColumnId[]).find((id) => REQUEST_SORT_KEYS[id] === order.by);
  return column ? { column, descending: order.descending } : null;
}

/** The request order for a sort picked in a column's menu, or none (newest first) when it's cleared. */
export function requestOrderFor(sort: { column: string; descending: boolean } | null): UsageRequestOrder | null {
  if (!sort) return null;
  const by = REQUEST_SORT_KEYS[sort.column as RequestColumnId];
  if (!by || (by === 'time' && sort.descending)) return null;
  return { by, descending: sort.descending };
}

/** What a provider sent back with a failure, laid out when it's JSON so its fields read one to a line; else as sent. */
export function readableFailureBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed;
  try {
    return JSON.stringify(JSON.parse(trimmed) as unknown, null, 2);
  } catch {
    return trimmed;
  }
}

/** The record next to the open one on this page, or none at either end or once the open one has left the page. */
export function steppedRecord(records: readonly UsageRecord[], id: string, step: 1 | -1): UsageRecord | undefined {
  const index = records.findIndex((record) => record.id === id);
  return index < 0 ? undefined : records[index + step];
}

/** The provider's own error message out of a JSON failure body when there is one; else the body as sent. */
export function failureSummary(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const pick = (value: unknown): string | null => {
      if (!value || typeof value !== 'object') return null;
      const record = value as Record<string, unknown>;
      if (typeof record.message === 'string') return record.message;
      if (typeof record.error === 'string') return record.error;
      if (record.error && typeof record.error === 'object') return pick(record.error);
      if (typeof record.detail === 'string') return record.detail;
      return null;
    };
    return pick(parsed) ?? trimmed;
  } catch {
    return trimmed;
  }
}

const ORDER_KEY = 'arbor.usage-requests-order.v1';
// Failed on has columns of its own, so it keeps its own sort too: All's could be on a column it doesn't show.
const FAILED_ORDER_KEY = 'arbor.usage-failed-requests-order.v1';

/** The sort picked on Requests (or with Failed on) last time, if it's one the server still takes; newest first otherwise. */
export function loadRequestOrder(storage: Pick<Storage, 'getItem'>, failedOnly = false): UsageRequestOrder | null {
  const saved = read(storage, failedOnly ? FAILED_ORDER_KEY : ORDER_KEY);
  if (!saved || typeof saved !== 'object') return null;
  const { by, descending } = saved as Record<string, unknown>;
  const known: readonly unknown[] = Object.values(REQUEST_SORT_KEYS);
  if (!known.includes(by) || typeof descending !== 'boolean') return null;
  const key = by as UsageRequestSortKey;
  // Newest first is no order at all.
  return key === 'time' && descending ? null : { by: key, descending };
}

/** Keeps the sort for next time; newest first is the default, so it's kept as nothing. */
export function saveRequestOrder(storage: Pick<Storage, 'setItem' | 'removeItem'>, order: UsageRequestOrder | null, failedOnly = false) {
  const key = failedOnly ? FAILED_ORDER_KEY : ORDER_KEY;
  try {
    if (order) storage.setItem(key, JSON.stringify(order));
    else storage.removeItem(key);
  } catch {
    // Storage full or blocked: the sort still applies, it just isn't remembered.
  }
}

/** A request as JSON to paste into an issue or a chat: what the grid and sheet show, in the proxy's own field names. */
export function requestJson(record: UsageRecord): string {
  return JSON.stringify(record, null, 2);
}
