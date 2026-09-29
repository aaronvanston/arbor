import { MoreHorizontal } from '../ui/icons';
import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import { foldedActionCount } from '../../services/topbarActions';
import { useMacTitleBar } from '../../services/windowChrome';
import { Button } from '../ui/button';
import { Menu, MenuPopup, MenuSeparator, MenuTrigger } from '../ui/menu';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip';

/**
 * One column per kind of page: main pages fill the window up to 1400px and center past it, settings
 * keep a narrower column for reading. The top bar and the body share it, so the title lines up with
 * the content under it.
 */
export type PageWidth = 'main' | 'readable' | 'full';

const PAGE_MAX_WIDTH: Record<PageWidth, string> = {
  main: '87.5rem',
  readable: '56rem',
  // A page that is one table, edge to edge (see TablePage).
  full: '100%',
};

/**
 * Pads the top bar out to the body's centered column: its max width plus the same 1.25rem gutter. While the sidebar is
 * hidden the shell sets `--topbar-start`, the room its button and the Mac window buttons take at the start of the bar.
 */
const TOPBAR_GUTTER =
  'pr-[max(1.25rem,calc((100%_-_var(--page-width))/2_+_1.25rem))] pl-[max(var(--topbar-start,1.25rem),calc((100%_-_var(--page-width))/2_+_1.25rem))]';

/** Full-height page shell: fixed top bar, scrollable body, both on the page's column. */
export function Page({ children, className, width = 'readable' }: { children: ReactNode; className?: string; width?: PageWidth }) {
  return (
    <div
      className={cn('flex h-full min-h-0 flex-col', className)}
      style={{ '--page-width': PAGE_MAX_WIDTH[width] } as CSSProperties}
      data-slot="page"
      data-width={width}
    >
      {children}
    </div>
  );
}

/**
 * An action the top bar moves into its ⋯ menu when the room runs out: how it looks in the bar, and the menu rows that
 * stand in for it there (a picker, like Sync's machine to compare with, becomes a group of ticked choices, a button a
 * row).
 */
export type TopbarAction = { id: string; bar: ReactNode; menu: ReactNode };

/**
 * 52px page top bar shared by every page. On the Mac it's also the window's title bar: it drags the window.
 * `collapsible` actions come first and fold into ⋯, the last first, when they don't fit; `actions` stay in the bar,
 * last, so refresh keeps its place at the end.
 */
export function PageTopbar({ children, className, actions, collapsible }: {
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
  collapsible?: ReadonlyArray<TopbarAction | null | false>;
}) {
  const macTitleBar = useMacTitleBar();
  const folding = (collapsible ?? []).filter((action): action is TopbarAction => Boolean(action));
  const hasActions = Boolean(actions) || folding.length > 0;
  return (
    <header
      className={cn('flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3', TOPBAR_GUTTER, className)}
      data-slot="page-topbar"
      // `deep`: anywhere in the bar drags except buttons, links, fields and other controls.
      data-tauri-drag-region={macTitleBar ? 'deep' : undefined}
    >
      {/* The title keeps its width (up to 60%) and the actions get the rest, so they give way first. */}
      <div className={cn('flex min-w-0 items-center gap-3', hasActions ? 'max-w-[60%] shrink-0' : 'flex-1')}>{children}</div>
      {hasActions ? <PageTopbarActions collapsible={folding} pinned={actions} /> : null}
    </header>
  );
}

/** The gap between actions (gap-2) and the ⋯ button's width (size-7), which the fold makes room for. */
const ACTION_GAP = 8;
const MORE_WIDTH = 28;

/**
 * The actions, right-aligned in the room the title leaves. The ones that don't fit go into a ⋯ menu before the pinned
 * ones instead of scrolling sideways or being cut off (§6.3). A folded action stays laid out, out of sight and out of
 * reach, so its width is known when the window grows again. The 4px padding keeps focus rings inside the clipped row.
 */
function PageTopbarActions({ collapsible, pinned }: { collapsible: TopbarAction[]; pinned: ReactNode }) {
  const { t } = useI18n();
  const rowRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const [folded, setFolded] = useState(0);
  const ids = collapsible.map((action) => action.id).join('\n');

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const order = ids ? ids.split('\n') : [];
    const measure = () => {
      const style = getComputedStyle(row);
      const room = row.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      const widths = order.map((id) => itemRefs.current.get(id)?.getBoundingClientRect().width ?? 0);
      const pinnedWidth = pinnedRef.current?.getBoundingClientRect().width ?? 0;
      setFolded(foldedActionCount(widths, room, { pinned: pinnedWidth, gap: ACTION_GAP, more: MORE_WIDTH }));
    };
    measure();
    // The row for the window's width; the actions for their own, which change with a label ("Scanning…") or a view.
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    if (pinnedRef.current) observer.observe(pinnedRef.current);
    for (const element of itemRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [ids]);

  const shown = Math.max(0, collapsible.length - folded);
  const inMenu = collapsible.slice(shown);
  const more = t('page.actions.more');
  return (
    <div ref={rowRef} className="-m-1 flex min-w-0 flex-1 overflow-hidden p-1" data-slot="page-topbar-actions">
      <div className="relative ml-auto flex shrink-0 items-center gap-2">
        {collapsible.map((action, index) => {
          const away = index >= shown;
          return (
            <div
              key={action.id}
              ref={(element) => {
                if (!element) return undefined;
                itemRefs.current.set(action.id, element);
                return () => { itemRefs.current.delete(action.id); };
              }}
              className={cn('flex w-max shrink-0 items-center gap-2', away && 'pointer-events-none invisible absolute top-0 right-0')}
              inert={away || undefined}
              aria-hidden={away || undefined}
              data-slot="page-topbar-action"
              data-folded={away || undefined}
            >
              {action.bar}
            </div>
          );
        })}
        {inMenu.length ? (
          <Menu>
            <Tooltip>
              <TooltipTrigger render={<MenuTrigger render={<Button variant="ghost-muted" size="icon-sm" aria-label={more} />} />}>
                <MoreHorizontal />
              </TooltipTrigger>
              <TooltipPopup>{more}</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end" className="min-w-48">
              {inMenu.map((action, index) => (
                <Fragment key={action.id}>
                  {index > 0 ? <MenuSeparator /> : null}
                  {action.menu}
                </Fragment>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
        <div ref={pinnedRef} className={cn('flex shrink-0 items-center gap-2', !pinned && 'hidden')} data-slot="page-topbar-pinned">{pinned}</div>
      </div>
    </div>
  );
}

/**
 * T3's breadcrumb: the section, then the view or object open in it (`Usage / Requests`, `Settings / Proxy`,
 * `Sessions / Fix the login loop`). Pages have no tabs, as the sidebar tree picks the view, so this is where the view
 * is named. Every item is medium weight; the ones before the last are muted and keep their width, the last truncates.
 * A "/" separates them.
 */
export function PageBreadcrumb({ segments, className }: { segments: ReactNode[]; className?: string }) {
  return (
    <h1 className={cn('flex min-w-0 items-center gap-3 text-sm font-medium', className)}>
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        return (
          <Fragment key={index}>
            {index > 0 ? <span aria-hidden="true" className="shrink-0 text-icon-muted">/</span> : null}
            {/* Trimmed to the capitals and the baseline so it centers optically, as T3's; the padding gives descenders
                back the room the trim takes, or the truncating last item would clip them. */}
            <span className={cn('[text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1.5', last ? 'truncate text-foreground' : 'shrink-0 whitespace-nowrap text-muted-foreground')}>{segment}</span>
          </Fragment>
        );
      })}
    </h1>
  );
}

export function PageBody({ children, className, gap = 'gap-8', fill = false }: {
  children: ReactNode;
  className?: string;
  gap?: string;
  /**
   * The body doesn't scroll, and what's in it fills the window edge to edge: for a page that is one table (TablePage),
   * whose rows scroll between a toolbar and a pager that stay put. What sits above the table brings its own gutter.
   */
  fill?: boolean;
}) {
  if (fill) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col" data-slot="page-scroll" data-fill="">
        <div className={cn('flex min-h-0 w-full flex-1 flex-col pt-4', gap, className)} data-slot="page-body">
          {children}
        </div>
      </div>
    );
  }
  return (
    // Relative so it's the containing block for what's absolutely positioned inside, like sr-only labels. Without it
    // they're placed against the window, and one far down the page makes the document taller than the window: jumping
    // to it then scrolls the whole window, title bar and all, where nothing can scroll it back.
    <div className="relative min-h-0 flex-1 overflow-y-auto" data-slot="page-scroll">
      <div className={cn('mx-auto flex w-full max-w-(--page-width) flex-col px-5 pt-4 pb-12', gap, className)} data-slot="page-body">
        {children}
      </div>
    </div>
  );
}
