/**
 * What someone changed about a grid's columns: which show, their order, which are pinned and how wide they are. Kept
 * in localStorage under the grid's own key, so each grid remembers its own.
 */
export type DataGridLayout = {
  visibility: Record<string, boolean>;
  order: string[];
  pinning: { start: string[]; end: string[] };
  sizing: Record<string, number>;
};

/** What the layout is checked against: the grid's columns, in their default order, and how narrow each may go. */
export type DataGridLayoutColumn = { id: string; minSize?: number };

/** A named set of columns in the order they show, like "Tokens" or "Failures". */
export type DataGridPreset = { id: string; label: string; columns: string[] };

const unique = (ids: string[]) => [...new Set(ids)];

/**
 * A layout that shows `visible` in that order, first, then the rest hidden in their default order, with `pinned` at the
 * start. Widths start empty: each column's own size.
 */
export function gridLayout(columns: readonly DataGridLayoutColumn[], visible: readonly string[], pinned: readonly string[] = []): DataGridLayout {
  const known = columns.map((column) => column.id);
  const shown = unique(visible.filter((id) => known.includes(id)));
  return {
    visibility: Object.fromEntries(known.map((id) => [id, shown.includes(id)])),
    order: [...shown, ...known.filter((id) => !shown.includes(id))],
    pinning: { start: pinned.filter((id) => known.includes(id)), end: [] },
    sizing: {},
  };
}

/** Applies a preset: its columns show in its order, the rest hide; pins and widths stay as they are. */
export function applyPreset(layout: DataGridLayout, columns: readonly DataGridLayoutColumn[], preset: DataGridPreset): DataGridLayout {
  const next = gridLayout(columns, preset.columns);
  return { ...layout, visibility: next.visibility, order: next.order };
}

/** The preset the layout is showing exactly, same columns in the same order, if any. */
export function matchingPreset(layout: DataGridLayout, presets: readonly DataGridPreset[]): DataGridPreset | undefined {
  const shown = layout.order.filter((id) => layout.visibility[id]).join(',');
  return presets.find((preset) => preset.columns.join(',') === shown);
}

/**
 * A saved layout made safe to use: columns the grid no longer has are dropped, new ones take their default visibility
 * and go at the end, widths below a column's minimum are ignored and at least one column always shows.
 */
export function sanitizeGridLayout(raw: unknown, columns: readonly DataGridLayoutColumn[], fallback: DataGridLayout): DataGridLayout {
  if (!raw || typeof raw !== 'object') return fallback;
  const saved = raw as Partial<Record<keyof DataGridLayout, unknown>>;
  const known = new Set(columns.map((column) => column.id));
  const ids = (value: unknown) => (Array.isArray(value) ? unique(value.filter((id): id is string => typeof id === 'string' && known.has(id))) : []);

  const savedVisibility = saved.visibility && typeof saved.visibility === 'object' ? (saved.visibility as Record<string, unknown>) : {};
  const visibility = Object.fromEntries(
    columns.map((column) => {
      const value = savedVisibility[column.id];
      return [column.id, typeof value === 'boolean' ? value : fallback.visibility[column.id] ?? false];
    }),
  );
  if (!Object.values(visibility).some(Boolean)) return fallback;

  const savedOrder = ids(saved.order);
  const order = [...savedOrder, ...fallback.order.filter((id) => known.has(id) && !savedOrder.includes(id))];

  const savedPinning = saved.pinning && typeof saved.pinning === 'object' ? (saved.pinning as Record<string, unknown>) : {};
  const start = ids(savedPinning.start);
  const end = ids(savedPinning.end).filter((id) => !start.includes(id));

  const savedSizing = saved.sizing && typeof saved.sizing === 'object' ? (saved.sizing as Record<string, unknown>) : {};
  const sizing: Record<string, number> = {};
  for (const column of columns) {
    const width = savedSizing[column.id];
    if (typeof width === 'number' && Number.isFinite(width) && width >= (column.minSize ?? 0)) sizing[column.id] = Math.round(width);
  }

  return { visibility, order, pinning: { start, end }, sizing };
}

/** The layout saved under `storageKey`, made safe, or `initial()` when there isn't one (or it can't be read). */
export function loadGridLayout(storageKey: string, columns: readonly DataGridLayoutColumn[], initial: () => DataGridLayout): DataGridLayout {
  const fallback = initial();
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? sanitizeGridLayout(JSON.parse(raw) as unknown, columns, fallback) : fallback;
  } catch {
    return fallback;
  }
}

export function saveGridLayout(storageKey: string, layout: DataGridLayout) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(layout));
  } catch {
    // Private mode or a full disk: the layout lasts until the page closes.
  }
}
