import {
  columnOrderingFeature,
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  functionalUpdate,
  metaHelper,
  tableFeatures,
  useTable,
  type Column,
  type ColumnDef,
  type Header,
  type ReactTable,
  type RowData,
  type Updater,
} from '@tanstack/react-table';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, EyeOff, Pin, PinOff, RotateCcw, X } from '../icons';
import { Fragment, memo, useEffect, useRef, useState, type CSSProperties, type Dispatch, type KeyboardEvent, type MouseEvent, type ReactNode, type SetStateAction } from 'react';
import { useI18n } from '../../../i18n';
import { cn } from '../../../lib/utils';
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '../menu';
import { TABLE_HEAD_SURFACE, TABLE_NUMERIC_CLASS, type TableSurface } from '../data-table';
import { loadGridLayout, saveGridLayout, type DataGridLayout, type DataGridLayoutColumn } from './data-grid-layout';

/**
 * A table of records whose columns can be shown, hidden, moved, pinned and resized, each change remembered. Built on
 * TanStack Table v9 with only the column features it uses, and styled after ReUI's data grid (MIT): a sticky header,
 * hairline rows and no box. Paging, filtering and sorting belong to whoever feeds it rows, like the server that pages
 * requests: the grid only offers a sort in the columns that can have one and says which is in use.
 */

export type DataGridColumnMeta = {
  /** The column's full name, for its menu and the Columns list, when its header says it shorter. */
  label: string;
  /** More about what the column says, in its header's tooltip. */
  description?: string;
  /** Numbers sit at the end, so their digits line up down the column. */
  numeric?: boolean;
  cellClassName?: string;
  /** The column can be sorted, and how its two ways read: oldest or newest first, or low or high first. */
  sort?: 'time' | 'number';
  /**
   * A row's own controls, like its actions menu: no header menu, no width to drag and no place in the Columns list,
   * so it can't be hidden or moved away from the rows it acts on. Give it `enableResizing: false` too.
   */
  fixed?: boolean;
};

/** The column rows are sorted by, and which way. */
export type DataGridSort = { column: string; descending: boolean };

/** What a grid's owner does with a sort picked from a column's menu, and a row opened by a click. */
type GridActions<TData> = {
  sorting?: DataGridSort | null;
  /** A sort picked from a column's menu, or null when it's cleared. */
  onSortingChange?: (sorting: DataGridSort | null) => void;
  /** A row clicked, or picked with Enter; rows only take focus and a pointer when this is given. */
  onRowClick?: (row: TData) => void;
  /** The open row, marked as selected. */
  activeRowId?: string | null;
  /** A row's own look, like one listed under another. */
  rowClassName?: (row: TData) => string | undefined;
};

export const dataGridFeatures = tableFeatures({
  columnVisibilityFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  // Needs columnSizingFeature, above.
  columnResizingFeature,
  columnMeta: metaHelper<DataGridColumnMeta>(),
});

export type DataGridFeatures = typeof dataGridFeatures;
type Features = DataGridFeatures;
type Selected = { resizing: false | string };
type GridTable<TData extends RowData> = ReactTable<Features, TData, Selected>;

export type DataGridColumnDef<TData extends RowData> = ColumnDef<Features, TData, unknown>;

export type DataGrid<TData extends RowData> = {
  table: GridTable<TData>;
  layout: DataGridLayout;
  setLayout: Dispatch<SetStateAction<DataGridLayout>>;
  /** The grid's columns, for checking or rebuilding a layout. */
  layoutColumns: DataGridLayoutColumn[];
};

/**
 * A grid over `data`, its layout read from `storageKey` (or `initialLayout()` the first time) and saved as it changes.
 * Every column needs an `id`.
 */
export function useDataGrid<TData extends RowData>({ data, columns, getRowId, storageKey, initialLayout }: {
  data: TData[];
  columns: DataGridColumnDef<TData>[];
  getRowId: (row: TData) => string;
  storageKey: string;
  initialLayout: () => DataGridLayout;
}): DataGrid<TData> {
  const layoutColumns = columns.map((column) => ({ id: column.id ?? '', minSize: column.minSize }));
  const [layout, setLayout] = useState(() => loadGridLayout(storageKey, layoutColumns, initialLayout));
  const change = <K extends keyof DataGridLayout>(key: K) => (updater: Updater<DataGridLayout[K]>) =>
    setLayout((current) => ({ ...current, [key]: functionalUpdate(updater, current[key]) }));
  const table = useTable(
    {
      features: dataGridFeatures,
      data,
      columns,
      getRowId,
      // Widths follow the pointer; the rows don't redraw while they do (see GridBody).
      columnResizeMode: 'onChange',
      state: { columnVisibility: layout.visibility, columnOrder: layout.order, columnPinning: layout.pinning, columnSizing: layout.sizing },
      onColumnVisibilityChange: change('visibility'),
      onColumnOrderChange: change('order'),
      onColumnPinningChange: change('pinning'),
      onColumnSizingChange: change('sizing'),
    },
    (state): Selected => ({ resizing: state.columnResizing.isResizingColumn }),
  );
  const resizing = table.state.resizing;
  // A drag is saved once, when it's let go.
  useEffect(() => {
    if (!resizing) saveGridLayout(storageKey, layout);
  }, [storageKey, layout, resizing]);
  return { table, layout, setLayout, layoutColumns };
}

type GridColumn<TData extends RowData> = Column<Features, TData, unknown>;

/** Where a pinned column sticks, from the offsets DataGrid sets on the table. */
function pinStyle<TData extends RowData>(column: GridColumn<TData>): CSSProperties | undefined {
  const pinned = column.getIsPinned();
  if (!pinned) return undefined;
  return pinned === 'start' ? { left: `var(--pin-${column.id})` } : { right: `var(--pin-${column.id})` };
}

/** The line between pinned columns and the ones scrolling under them. */
function edgeClass<TData extends RowData>(column: GridColumn<TData>, lastStart: string | undefined, firstEnd: string | undefined) {
  if (column.id === lastStart) return 'shadow-[inset_-1px_0_0_var(--border)]';
  if (column.id === firstEnd) return 'shadow-[inset_1px_0_0_var(--border)]';
  return undefined;
}

// Opaque: rows scrolling under a see-through header read as a second, garbled header.
const HEAD_CLASS = 'group/head sticky top-0 z-[2] h-10 border-b border-border/60 px-1.5 text-start align-middle font-normal';
const CELL_CLASS = 'h-10 overflow-hidden text-ellipsis whitespace-nowrap border-b border-border/50 px-3 align-middle';
// A pinned cell covers what scrolls under it, so it's opaque, and takes the row's hover from a layer under its content.
const PINNED_CELL_CLASS =
  'sticky z-[1] after:pointer-events-none after:absolute after:inset-0 after:-z-10 group-hover/row:after:bg-muted/60 dark:group-hover/row:after:bg-input/16';

// The first column starts on the page's gutter or the card's inset, and the last ends on it.
const EDGE_START: Record<TableSurface, string> = { page: 'ps-5', card: 'ps-4' };
const EDGE_END: Record<TableSurface, string> = { page: 'pe-5', card: 'pe-4' };
const HEAD_EDGE_START: Record<TableSurface, string> = { page: 'ps-4', card: 'ps-3' };

export function DataGrid<TData extends RowData>({ grid, label, surface = 'page', className, sorting = null, onSortingChange, onRowClick, activeRowId = null, rowClassName }: GridActions<TData> & {
  grid: DataGrid<TData>;
  /** What the table is, for screen readers. */
  label: string;
  /** A page's whole subject, lined up with its gutter, or a part of one in a card. */
  surface?: TableSurface;
  /** Its height: the grid scrolls inside it, with the header and pinned columns staying put. */
  className?: string;
}) {
  const { table } = grid;
  const scroller = useRef<HTMLDivElement>(null);
  // A row opened from the keyboard can be past the fold; bring it into view, under the sticky header, and take the
  // focus with it when it was on a row, so Enter and the next arrow start from the open one.
  useEffect(() => {
    const row = activeRowId ? scroller.current?.querySelector<HTMLElement>('tbody tr[data-active]') : null;
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    if (document.activeElement?.closest('tbody') && scroller.current?.contains(document.activeElement)) row.focus({ preventScroll: true });
  }, [activeRowId]);
  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const startColumns = table.getStartVisibleLeafColumns();
  const lastStart = startColumns[startColumns.length - 1]?.id;
  const endColumns = table.getEndVisibleLeafColumns();
  const firstEnd = endColumns[0]?.id;
  // Keeps every column at its own width when they don't fill the grid, by taking up what's left before the end pins.
  const fillerAt = headers.length - endColumns.length;

  // Widths and pin offsets as variables on the table, so dragging a width restyles the header alone, not every row.
  const vars: Record<string, string> = {};
  for (const header of headers) {
    const { column } = header;
    vars[`--col-${column.id}`] = `${column.getSize()}px`;
    const pinned = column.getIsPinned();
    if (pinned) vars[`--pin-${column.id}`] = `${pinned === 'start' ? column.getStart('start') : column.getAfter('end')}px`;
  }

  return (
    <div ref={scroller} className={cn('relative overflow-auto [scrollbar-width:thin] scroll-pt-10', className)} data-slot="data-grid" data-surface={surface}>
      <table
        aria-label={label}
        className="table-fixed border-separate border-spacing-0 text-sm"
        style={{ ...vars, width: `max(100%, ${table.getTotalSize()}px)` } as CSSProperties}
      >
        <thead>
          <tr>
            {headers.map((header, index) => (
              <Fragment key={header.id}>
                {index === fillerAt ? <th aria-hidden="true" className={cn(HEAD_CLASS, TABLE_HEAD_SURFACE[surface])} /> : null}
                <GridHead
                  header={header}
                  table={table}
                  surface={surface}
                  first={index === 0}
                  edge={edgeClass(header.column, lastStart, firstEnd)}
                  sorting={sorting}
                  onSortingChange={onSortingChange}
                />
              </Fragment>
            ))}
            {fillerAt === headers.length ? <th aria-hidden="true" className={cn(HEAD_CLASS, TABLE_HEAD_SURFACE[surface], EDGE_END[surface])} /> : null}
          </tr>
        </thead>
        <GridBody
          table={table}
          data={table.options.data}
          frozen={Boolean(table.state.resizing)}
          surface={surface}
          fillerAt={fillerAt}
          lastStart={lastStart}
          firstEnd={firstEnd}
          onRowClick={onRowClick}
          activeRowId={activeRowId}
          rowClassName={rowClassName}
        />
      </table>
    </div>
  );
}

type BodyProps<TData extends RowData> = {
  table: GridTable<TData>;
  /** Only compared: the rows redraw during a drag only if they changed. */
  data: readonly TData[];
  /** A column is being dragged wider. */
  frozen: boolean;
  surface: TableSurface;
  fillerAt: number;
  lastStart: string | undefined;
  firstEnd: string | undefined;
  onRowClick: ((row: TData) => void) | undefined;
  activeRowId: string | null;
  rowClassName: ((row: TData) => string | undefined) | undefined;
};

/** A click on something of the cell's own, like a link, or the end of selecting a cell's text, doesn't open the row. */
function opensRow(event: MouseEvent<HTMLTableRowElement>) {
  if (event.target instanceof Element && event.target.closest('a, button, input')) return false;
  const selection = window.getSelection();
  return !selection || selection.isCollapsed || !event.currentTarget.contains(selection.anchorNode);
}

// While a column is dragged wider only the widths change, and they're variables on the table, so the rows stay as
// they are until it's let go.
const GridBody = memo(function GridBody<TData extends RowData>({ table, surface, fillerAt, lastStart, firstEnd, onRowClick, activeRowId, rowClassName }: BodyProps<TData>) {
  return (
    <tbody>
      {table.getRowModel().rows.map((row) => {
        const cells = row.getVisibleCells();
        const active = row.id === activeRowId;
        const open = onRowClick ? () => onRowClick(row.original) : undefined;
        return (
        <tr
          key={row.id}
          data-active={active || undefined}
          aria-selected={onRowClick ? active : undefined}
          tabIndex={open ? 0 : undefined}
          onClick={open ? (event) => opensRow(event) && open() : undefined}
          onKeyDown={open ? (event: KeyboardEvent<HTMLTableRowElement>) => {
            if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
            event.preventDefault();
            open();
          } : undefined}
          className={cn(
            // No color transition: the pinned cell's hover layer can't share it, and a fade here lags behind that cell.
            'group/row hover:bg-muted/60 dark:hover:bg-input/16',
            open && 'cursor-pointer outline-none focus-visible:bg-muted/60 dark:focus-visible:bg-input/16',
            // The open row keeps the accent's tint while its detail is beside it.
            active && 'bg-primary/8 hover:bg-primary/10 dark:bg-primary/12 dark:hover:bg-primary/14',
            rowClassName?.(row.original),
          )}
        >
          {cells.map((cell, index) => {
            const { column } = cell;
            const meta = column.columnDef.meta;
            return (
              <Fragment key={cell.id}>
                {index === fillerAt ? <td aria-hidden="true" className={CELL_CLASS} /> : null}
                <td
                  style={pinStyle(column)}
                  className={cn(
                    CELL_CLASS,
                    index === 0 && EDGE_START[surface],
                    meta?.numeric && TABLE_NUMERIC_CLASS,
                    column.getIsPinned() && [PINNED_CELL_CLASS, TABLE_HEAD_SURFACE[surface], active && 'after:bg-primary/8 group-hover/row:after:bg-primary/10 dark:after:bg-primary/12 dark:group-hover/row:after:bg-primary/14'],
                    edgeClass(column, lastStart, firstEnd),
                    meta?.cellClassName,
                  )}
                >
                  <table.FlexRender cell={cell} />
                </td>
              </Fragment>
            );
          })}
          {fillerAt === cells.length ? <td aria-hidden="true" className={cn(CELL_CLASS, EDGE_END[surface])} /> : null}
        </tr>
        );
      })}
    </tbody>
  );
}, (previous, next) => next.frozen && previous.data === next.data && previous.activeRowId === next.activeRowId) as <TData extends RowData>(props: BodyProps<TData>) => ReactNode;

function GridHead<TData extends RowData>({ header, table, surface, first, edge, sorting, onSortingChange }: Pick<GridActions<TData>, 'onSortingChange'> & {
  sorting: DataGridSort | null;
  header: Header<Features, TData, unknown>;
  table: GridTable<TData>;
  surface: TableSurface;
  /** The first column, which lines up with the page's gutter or the card's inset. */
  first: boolean;
  edge: string | undefined;
}) {
  const { column } = header;
  const pinned = column.getIsPinned();
  const sorted = sorting?.column === column.id ? sorting : null;
  return (
    <th
      scope="col"
      aria-sort={sorted ? (sorted.descending ? 'descending' : 'ascending') : undefined}
      style={{ width: `var(--col-${column.id})`, ...pinStyle(column) }}
      // The header's label is a button with 4px of its own, so the cell gives up that much of the edge.
      className={cn(HEAD_CLASS, TABLE_HEAD_SURFACE[surface], first && HEAD_EDGE_START[surface], pinned && 'z-[3]', edge)}
    >
      {column.columnDef.meta?.fixed
        ? <span className="sr-only">{column.columnDef.meta.label}</span>
        : <ColumnMenu header={header} table={table} sorted={sorted} onSortingChange={onSortingChange} />}
      {column.getCanResize() && !column.columnDef.meta?.fixed ? <ResizeHandle header={header} /> : null}
    </th>
  );
}

/** The header is a button: its menu pins, moves, resets or hides the column. */
function ColumnMenu<TData extends RowData>({ header, table, sorted, onSortingChange }: {
  header: Header<Features, TData, unknown>;
  table: GridTable<TData>;
  sorted: DataGridSort | null;
  onSortingChange: ((sorting: DataGridSort | null) => void) | undefined;
}) {
  const { t } = useI18n();
  const { column } = header;
  const meta = column.columnDef.meta;
  const label = meta?.label ?? column.id;
  const pinned = column.getIsPinned();
  // Moves step past what's shown: trading places with a hidden or pinned column would move nothing you can see.
  const center = table.getCenterVisibleLeafColumns();
  const index = pinned ? -1 : center.findIndex((candidate) => candidate.id === column.id);
  const before = index > 0 ? center[index - 1] : undefined;
  const after = index >= 0 ? center[index + 1] : undefined;
  const lastShown = table.getVisibleLeafColumns().length <= 1;
  const resized = column.columnDef.size !== undefined && column.getSize() !== column.columnDef.size;
  const shortened = typeof column.columnDef.header === 'string' && column.columnDef.header !== label;
  const sortKind = onSortingChange ? meta?.sort : undefined;
  const SortArrow = sorted?.descending ? ArrowDown : ArrowUp;

  const moveBeside = (neighbor: string, side: 'before' | 'after') =>
    table.setColumnOrder((order) => {
      const rest = order.filter((id) => id !== column.id);
      const at = rest.indexOf(neighbor) + (side === 'after' ? 1 : 0);
      return [...rest.slice(0, at), column.id, ...rest.slice(at)];
    });

  return (
    <Menu>
      <MenuTrigger
        className={cn(
          'flex h-7 w-full min-w-0 cursor-pointer items-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground',
          meta?.numeric && 'flex-row-reverse',
        )}
        title={[shortened ? label : '', meta?.description ?? ''].filter(Boolean).join(' · ') || undefined}
      >
        <span className="truncate">
          <table.FlexRender header={header} />
        </span>
        {sorted ? (
          <SortArrow className="size-3 shrink-0 text-foreground" aria-label={t(meta?.sort === 'time'
            ? (sorted.descending ? 'dataGrid.sort.newest' : 'dataGrid.sort.oldest')
            : (sorted.descending ? 'dataGrid.sort.highest' : 'dataGrid.sort.lowest'))} />
        ) : null}
        {pinned ? <Pin className="size-3 shrink-0" aria-label={t('dataGrid.pinned')} /> : null}
        {/* A sorted column's arrow already marks the header as one to press. */}
        {sorted ? null : (
          <ChevronDown
            aria-hidden="true"
            className="size-3 shrink-0 opacity-0 transition-opacity group-hover/head:opacity-100 group-focus-within/head:opacity-100"
          />
        )}
      </MenuTrigger>
      <MenuPopup align={meta?.numeric ? 'end' : 'start'} className="min-w-44">
        <MenuGroup>
          <MenuGroupLabel>{label}</MenuGroupLabel>
        </MenuGroup>
        {sortKind && onSortingChange ? (
          <>
            <MenuRadioGroup
              value={sorted ? (sorted.descending ? 'descending' : 'ascending') : ''}
              onValueChange={(value) => onSortingChange({ column: column.id, descending: value === 'descending' })}
            >
              <MenuRadioItem value="ascending" closeOnClick>
                {t(sortKind === 'time' ? 'dataGrid.sort.oldest' : 'dataGrid.sort.lowest')}
              </MenuRadioItem>
              <MenuRadioItem value="descending" closeOnClick>
                {t(sortKind === 'time' ? 'dataGrid.sort.newest' : 'dataGrid.sort.highest')}
              </MenuRadioItem>
            </MenuRadioGroup>
            {sorted ? (
              <MenuItem onClick={() => onSortingChange(null)}>
                <X />
                {t('dataGrid.sort.clear')}
              </MenuItem>
            ) : null}
            <MenuSeparator />
          </>
        ) : null}
        <MenuGroup>
          <MenuItem onClick={() => column.pin(pinned ? false : 'start')}>
            {pinned ? <PinOff /> : <Pin />}
            {pinned ? t('dataGrid.unpin') : t('dataGrid.pin')}
          </MenuItem>
          <MenuItem disabled={!before} onClick={() => before && moveBeside(before.id, 'before')}>
            <ArrowLeft />
            {t('dataGrid.moveLeft')}
          </MenuItem>
          <MenuItem disabled={!after} onClick={() => after && moveBeside(after.id, 'after')}>
            <ArrowRight />
            {t('dataGrid.moveRight')}
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        {resized ? (
          <MenuItem onClick={() => column.resetSize()}>
            <RotateCcw />
            {t('dataGrid.resetWidth')}
          </MenuItem>
        ) : null}
        <MenuItem disabled={lastShown} onClick={() => column.toggleVisibility(false)}>
          <EyeOff />
          {t('dataGrid.hide')}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function ResizeHandle<TData extends RowData>({ header }: { header: Header<Features, TData, unknown> }) {
  const { t } = useI18n();
  const { column } = header;
  const startResize = header.getResizeHandler();
  return (
    <span
      aria-hidden="true"
      title={t('dataGrid.resize')}
      onMouseDown={startResize}
      onTouchStart={startResize}
      onDoubleClick={() => column.resetSize()}
      className={cn(
        'absolute inset-y-0 end-0 z-[1] flex w-2.5 cursor-col-resize touch-none select-none justify-end before:my-2.5 before:w-px before:rounded-full before:transition-colors',
        column.getIsResizing() ? 'before:w-0.5 before:bg-primary' : 'before:bg-border group-hover/head:before:bg-foreground/20 hover:before:bg-primary/70',
      )}
    />
  );
}
