import { ChevronLeft, ChevronRight } from './icons';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { formatCount } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Button } from './button';
import { Skeleton } from './skeleton';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './select';
import { Tooltip, TooltipPopup, TooltipTrigger } from './tooltip';

/**
 * Arbor's one table look, in two frames. A table is either a page's whole subject (Usage › Requests), filling the
 * window's width with its toolbar held at the top and its pager at the bottom while the rows scroll between, or one
 * part of a page (Sync › Library by machine), in a card with its title and toolbar in the card's head and a footer when it pages.
 * Both frames take either engine: the plain `Table` for a table that shows what it's given, or `DataGrid` for one
 * whose columns can be picked, moved, pinned and resized. Rows, headers and numbers look the same in all four.
 */

/** Where a table sits, which sets its header's surface and how far in its first and last columns start. */
export type TableSurface = 'page' | 'card';

/**
 * The first and last cells line up with what's around the table: the page's 20px gutter or the card's 16px inset. The
 * cells between keep 12px each side.
 */
export const TABLE_EDGE: Record<TableSurface, string> = {
  page: 'first:ps-5 last:pe-5',
  card: 'first:ps-4 last:pe-4',
};

/** A header cell: 40px, the column's name in sentence case, quiet. Opaque, as rows scroll under it. */
export const TABLE_HEAD_CLASS = 'h-10 whitespace-nowrap px-3 text-start align-middle text-xs font-normal text-muted-foreground';
/** A body cell: 40px at least, room for a second line when a cell has one. */
export const TABLE_CELL_CLASS = 'h-10 whitespace-nowrap px-3 py-2.5 align-middle';
/** Hairlines between rows, none under the last, and a fill on hover. */
export const TABLE_ROW_CLASS = 'border-b border-border/50 transition-colors last:border-0 hover:bg-muted/50 dark:hover:bg-input/16';
/** Numbers end-aligned in the regular font, their digits lining up down the column. */
export const TABLE_NUMERIC_CLASS = 'text-end tabular-nums';
/** The header's surface: the page's under a page table, the card's in a card. */
export const TABLE_HEAD_SURFACE: Record<TableSurface, string> = {
  page: 'bg-background',
  card: 'bg-card',
};

/**
 * A table that is one part of a page: a card whose head holds the title, how many rows there are and the table's own
 * controls (search, a filter, Columns), with the table under it and, when it pages or shows more, a footer.
 */
export function TableCard({ title, count, nav, toolbar, footer, children, className }: {
  title: ReactNode;
  /** How many rows, as words: "6 skills", "1,684 requests". */
  count?: ReactNode;
  /** A switch between the table's main sets of rows, beside the title. */
  nav?: ReactNode;
  /** The table's own controls, at the end of the head. */
  toolbar?: ReactNode;
  /** A pager, a Show all, or a total. */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs/5', className)} data-slot="table-card">
      <header className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/50 px-4 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="truncate text-sm font-medium text-foreground">{title}</h2>
          {count != null ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span> : null}
        </div>
        {nav}
        {toolbar ? <div className="ms-auto flex flex-wrap items-center gap-2">{toolbar}</div> : null}
      </header>
      {children}
      {footer ? <footer className="flex min-h-11 items-center gap-3 border-t border-border/50 px-4 py-2">{footer}</footer> : null}
    </section>
  );
}

/**
 * A table that is the page: it takes the whole body, edge to edge. The toolbar stays at the top and the footer at the
 * bottom; only the rows scroll, under a header that stays put. Put it in a `PageBody fill`.
 */
export function TablePage({ toolbar, footer, children, label }: {
  /** Filters and the table's controls, above the header. */
  toolbar: ReactNode;
  /** The pager, held at the bottom of the window. */
  footer?: ReactNode;
  /** The table, which scrolls in the room left between them. */
  children: ReactNode;
  label: string;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={label} data-slot="table-page">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pb-3">{toolbar}</div>
      <div className="relative flex min-h-0 flex-1 flex-col border-t border-border/60">{children}</div>
      {footer ? (
        <footer className="flex min-h-12 shrink-0 items-center gap-3 border-t border-border/60 bg-background/95 px-5 py-2 backdrop-blur">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}

const PAGE_SIZES = [20, 50, 100, 200];

/**
 * Which rows these are, of how many, then rows per page and the page you're on: a footer's content, for a list the
 * server pages. `first`, `last` and `total` count rows; `page` and `totalPages` count pages.
 */
export function TablePager({ first, last, total, page, totalPages, pageSize, onPage, onPageSizeChange }: {
  first: number;
  last: number;
  total: number;
  page: number;
  totalPages: number;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <p className="me-auto text-xs tabular-nums text-muted-foreground">
        {t('dataTable.range', { first: formatCount(first), last: formatCount(last), total: formatCount(total) })}
      </p>
      <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
        <SelectTrigger size="sm" className="w-auto min-w-0" aria-label={t('usage.events.pageSize', { size: pageSize })}>
          <SelectValue>{t('usage.events.pageSize', { size: pageSize })}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" side="top">
          {PAGE_SIZES.map((size) => (
            <SelectItem key={size} value={String(size)}>{t('usage.events.pageSize', { size })}</SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost-muted" size="icon-sm" disabled={page <= 1} focusableWhenDisabled onClick={() => onPage(page - 1)} aria-label={t('dataGrid.previous')} />}>
            <ChevronLeft />
          </TooltipTrigger>
          <TooltipPopup>{t('dataGrid.previous')}</TooltipPopup>
        </Tooltip>
        <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
          {t('dataGrid.page', { page, total: Math.max(totalPages, 1) })}
        </span>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost-muted" size="icon-sm" disabled={page >= totalPages} focusableWhenDisabled onClick={() => onPage(page + 1)} aria-label={t('dataGrid.next')} />}>
            <ChevronRight />
          </TooltipTrigger>
          <TooltipPopup>{t('dataGrid.next')}</TooltipPopup>
        </Tooltip>
      </div>
    </>
  );
}

/** Nothing to list, in the table's place: a line saying why and, when there's something to do about it, a button. */
export function TableEmpty({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-4 py-12 text-center', className)} data-slot="table-empty">
      <p className="text-sm text-muted-foreground">{children}</p>
      {action}
    </div>
  );
}

/**
 * A header with a second line under its name, like a home's path or what it holds. The name stays the header's quiet
 * 12px; the line under it is smaller.
 */
export function TableHeadLabel({ children, detail, mono = false }: { children: ReactNode; detail?: ReactNode; mono?: boolean }) {
  return (
    <span className="flex flex-col leading-tight">
      <span>{children}</span>
      {detail ? <span className={cn('text-2xs text-muted-foreground', mono && 'font-mono')}>{detail}</span> : null}
    </span>
  );
}

/**
 * A card's footer for a list that shows its first few rows: how many of how many, and a button to show them all or
 * fewer again.
 */
export function TableShowAll({ shown, total, expanded, onToggle }: { shown: number; total: number; expanded: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <p className="me-auto text-xs tabular-nums text-muted-foreground">
        {t('dataTable.shown', { shown: formatCount(shown), total: formatCount(total) })}
      </p>
      <Button variant="ghost-muted" size="sm" onClick={onToggle}>
        {expanded ? t('dataTable.showFewer') : t('dataTable.showAll', { total: formatCount(total) })}
      </Button>
    </>
  );
}

/** Rows of gray bars where a table's first page will be. */
export function TableSkeleton({ surface = 'card', rows = 12 }: { surface?: TableSurface; rows?: number }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col" aria-busy="true" aria-label={t('dataTable.loading')}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={cn('flex h-10 items-center gap-6 border-b border-border/50 last:border-0', surface === 'page' ? 'px-5' : 'px-4')}>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-4 w-16 rounded-full" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-40" />
          <Skeleton className="ms-auto h-3 w-12" />
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-3 w-14" />
        </div>
      ))}
    </div>
  );
}
