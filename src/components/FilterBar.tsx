import { FilterX, ListFilter, X } from './ui/icons';
import { useEffect, useRef, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { MachinePill } from './identity/Identity';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { MiddleTruncate } from './ui/middle-truncate';
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from './ui/popover';

export type FilterChip<Id extends string = string> = {
  id: Id;
  label: string;
  value: string;
  /** The machine the filter picks, shown as its pill rather than as `value`'s words. */
  machine?: string;
};

/**
 * A page's filters beyond its time range and search: one Filters button whose popover holds them, and a chip beside
 * it for each one that's set, so what narrows the page stays in view without a row of menus. A chip's × drops its
 * filter and Clear all drops them all. It sits in the page's own row of controls.
 */
export function FilterBar<Id extends string>({ chips, onRemove, onClearAll, children }: {
  chips: readonly FilterChip<Id>[];
  onRemove: (id: Id) => void;
  onClearAll: () => void;
  /** The popover's fields, each a FilterField. */
  children: ReactNode;
}) {
  const { t } = useI18n();
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Removing a chip takes the focused × with it; the next chip's × gets focus, or Filters once none are left.
  const focusAfterRemove = useRef<number | null>(null);
  useEffect(() => {
    const index = focusAfterRemove.current;
    if (index === null) return;
    focusAfterRemove.current = null;
    const removes = rowRef.current?.querySelectorAll<HTMLButtonElement>('[data-filter-chip-remove]') ?? [];
    (removes[Math.min(index, removes.length - 1)] ?? triggerRef.current)?.focus();
  }, [chips]);
  const count = chips.length;

  return (
    <div ref={rowRef} className="contents" data-slot="filter-bar">
      <Popover>
        <PopoverTrigger
          ref={triggerRef}
          render={<Button variant="outline" size="sm" className={cn(count > 0 && 'border-primary/40')} />}
          aria-label={count > 0 ? t('filters.buttonActive', { count }) : undefined}
        >
          <ListFilter className={count > 0 ? 'text-primary' : undefined} />
          {t('filters.button')}
          {count > 0 ? <Badge variant="primary" size="sm" aria-hidden="true">{count}</Badge> : null}
        </PopoverTrigger>
        <PopoverPopup width="lg" align="start">
          <PopoverTitle>{t('filters.button')}</PopoverTitle>
          <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2" data-slot="filter-fields">
            {children}
          </div>
        </PopoverPopup>
      </Popover>
      {chips.map((chip, index) => (
        <span
          key={chip.id}
          className="inline-flex h-7 min-w-0 max-w-72 items-center gap-1 rounded-lg border border-primary/40 bg-primary/6 ps-2.5 pe-0.5 text-sm dark:bg-primary/12"
          data-slot="filter-chip"
        >
          <span className="shrink-0 text-muted-foreground">{chip.label}</span>
          {/* Both ends, so fix/cache-main-20260918 keeps the date that tells it from its neighbors. */}
          {chip.machine
            ? <MachinePill name={chip.machine} className="min-w-0" />
            : <MiddleTruncate value={chip.value} className="font-medium text-foreground" />}
          <Button
            variant="ghost-muted"
            size="icon-micro"
            className="ms-0.5"
            onClick={() => {
              focusAfterRemove.current = index;
              onRemove(chip.id);
            }}
            aria-label={t('filters.remove', { filter: chip.label })}
            data-filter-chip-remove
          >
            <X />
          </Button>
        </span>
      ))}
      {count > 0 ? (
        <Button
          variant="ghost-muted"
          size="sm"
          onClick={() => {
            onClearAll();
            triggerRef.current?.focus();
          }}
        >
          <FilterX />
          {t('filters.clearAll')}
        </Button>
      ) : null}
    </div>
  );
}

/** One filter in the Filters popover: its name, and the menu that picks it (whose trigger has the id `htmlFor` names). */
export function FilterField({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <>
      <Label htmlFor={htmlFor} className="font-normal text-muted-foreground">{label}</Label>
      <div className="min-w-0">{children}</div>
    </>
  );
}
