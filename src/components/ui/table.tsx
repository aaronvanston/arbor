import { createContext, useContext } from 'react';
import type * as React from 'react';
import { cn } from '../../lib/utils';
import { TABLE_CELL_CLASS, TABLE_EDGE, TABLE_HEAD_CLASS, TABLE_HEAD_SURFACE, TABLE_ROW_CLASS, type TableSurface } from './data-table';

/**
 * How dense a table is. `default` is the 40px row every table has. `compact` is for a small table inside an opened
 * row's detail: 32px rows in 12px text, which reads as part of the row it opened from.
 */
export type TableDensity = 'default' | 'compact';

type TableSettings = { surface: TableSurface; density: TableDensity; stickyHeader: boolean };

const TableContext = createContext<TableSettings>({ surface: 'card', density: 'default', stickyHeader: false });

const COMPACT_HEAD = 'h-8 px-2.5';
const COMPACT_CELL = 'h-8 px-2.5 py-1.5 text-xs';
const COMPACT_EDGE = 'first:ps-3 last:pe-3';

/**
 * A plain table in Arbor's table look (see data-table.tsx). It sits in a card by default, its first and last columns
 * on the card's 16px inset; `surface="page"` lines them up with a page's 20px gutter instead. `stickyHeader` keeps the
 * header in view while the table's container scrolls, on the surface's own color.
 */
function Table({ className, containerClassName, surface = 'card', density = 'default', stickyHeader = false, ...props }: React.ComponentProps<'table'> & {
  containerClassName?: string;
  surface?: TableSurface;
  density?: TableDensity;
  stickyHeader?: boolean;
}) {
  return (
    <TableContext.Provider value={{ surface, density, stickyHeader }}>
      <div data-slot="table-container" className={cn('relative w-full overflow-x-auto', containerClassName)}>
        <table data-slot="table" className={cn('w-full caption-bottom', density === 'compact' ? 'text-xs' : 'text-sm', className)} {...props} />
      </div>
    </TableContext.Provider>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  const { surface, stickyHeader } = useContext(TableContext);
  return (
    <thead
      data-slot="table-header"
      className={cn(
        '[&_tr]:border-b [&_tr]:border-border/60 [&_tr]:hover:bg-transparent dark:[&_tr]:hover:bg-transparent',
        stickyHeader && ['sticky top-0 z-20', TABLE_HEAD_SURFACE[surface]],
        className,
      )}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return <tr data-slot="table-row" className={cn(TABLE_ROW_CLASS, className)} {...props} />;
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  const { surface, density } = useContext(TableContext);
  const compact = density === 'compact';
  return <th data-slot="table-head" className={cn(TABLE_HEAD_CLASS, compact ? [COMPACT_HEAD, COMPACT_EDGE] : TABLE_EDGE[surface], className)} {...props} />;
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  const { surface, density } = useContext(TableContext);
  const compact = density === 'compact';
  // A cell that sets no padding of its own (an opened row's full-width detail) keeps none.
  const flush = typeof className === 'string' && /(?:^|\s)p-0(?:\s|$)/.test(className);
  return (
    <td
      data-slot="table-cell"
      className={cn(TABLE_CELL_CLASS, compact && COMPACT_CELL, !flush && (compact ? COMPACT_EDGE : TABLE_EDGE[surface]), className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
