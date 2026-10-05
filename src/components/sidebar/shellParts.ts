import { cn } from '../../lib/utils';
import type { MainPageId } from '../../navigation';
import { Bell, ChartNoAxesColumn, House, Layers, MessagesSquare, Monitor, Network, TimeSchedule, Users, type AppIcon } from '../ui/icons';

/**
 * The shell's look, shared by the real shell (App.tsx and the sidebar's parts) and the static first screen that
 * index.html carries (src/boot/BootShell.tsx), so the two draw the same boxes. Nothing in here may touch the window,
 * a store or a Tauri API: the build renders BootShell from it before any of those exist.
 */

/** Each main page's icon, in the tree and the search palette. */
export const PAGE_ICONS: Record<MainPageId, AppIcon> = {
  home: House,
  machines: Monitor,
  pools: Network,
  sessions: MessagesSquare,
  automations: TimeSchedule,
  setup: Layers,
  accounts: Users,
  usage: ChartNoAxesColumn,
  alerts: Bell,
};

/** The window's frame: the sidebar beside the page. */
export const SHELL_CLASS = 'relative flex h-full w-full bg-background text-foreground';

/** Where the one sidebar button sits, fixed to the window beside the Mac window buttons. */
export const TOGGLE_SLOT_CLASS = 'pointer-events-none fixed top-0 left-[var(--workspace-controls-left)] z-50 flex h-[var(--workspace-topbar-height)] items-center';

export const SIDEBAR_CLASS = 'surface-grain @container/sidebar relative flex w-[var(--sidebar-width)] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground';

/** T3's title row: 52px, with the wordmark at the title content inset. */
export const SIDEBAR_HEADER_CLASS = 'relative flex h-[var(--workspace-topbar-height)] shrink-0 items-center';
export const WORDMARK_CLASS = 'relative z-10 -mx-1 ml-[calc(var(--workspace-titlebar-content-left)-0.25rem)] flex h-7 cursor-pointer items-center rounded-md px-1 text-lg font-semibold tracking-tight text-sidebar-foreground outline-none ring-ring focus-visible:ring-2 [-webkit-app-region:no-drag]';
/** The artwork's layer, raised 6px from T3's placement; its height comes from the scene. */
export const SIDEBAR_ART_CLASS = 'pointer-events-none absolute inset-x-0 -top-1.5 z-0 overflow-hidden select-none';
export const sidebarArtHeight = (rows: number) => `calc(var(--workspace-topbar-height) + ${(rows - 52) / 16}rem)`;

export const SEARCH_GROUP_CLASS = 'relative z-[1] shrink-0 px-2 pt-5 pb-2';
export const SEARCH_ROW_CLASS = 'group/search flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-sidebar-muted-foreground outline-none ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2';
/** T3's 28px ghost icon buttons beside the search field, in the sidebar's icon color until hovered. */
export const HEADER_ICON_BUTTON = 'relative size-7 shrink-0 text-[var(--sidebar-icon-color)] [--control-icon-color:currentColor] hover:bg-sidebar-row-hover hover:text-sidebar-foreground';
export const SEARCH_KBD_CLASS = 'hidden bg-transparent text-sidebar-muted-foreground @min-[15rem]/sidebar:inline-flex dark:bg-transparent';

export const TREE_NAV_CLASS = 'relative z-[1] flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-1 pb-2';
export const treeSectionClass = (index: number) => cn('flex shrink-0 flex-col', index > 0 && 'mt-3');
export const TREE_SECTION_LABEL_CLASS = 'flex h-7 items-center px-2.5 text-xs font-medium text-sidebar-muted-foreground';
export const TREE_CHEVRON_CLASS = 'absolute top-1 right-1 flex size-6 cursor-pointer items-center justify-center rounded-md text-[var(--sidebar-icon-color)] outline-none ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2';

/**
 * T3's menu row: 32px, 14px medium, a 16px icon, muted until it's hovered or the current page. The current page's wash
 * and label color are too close to a hovered row's to tell apart by color alone (under 3:1), so its label is also
 * semibold, as T3 marks its open thread by weight. A page whose open view is lit under it (`data-current`) keeps the
 * full label color without the wash, as T3's project row does over its open thread.
 */
export const ROW_CLASS = cn(
  'group/row relative flex h-8 w-full cursor-pointer items-center gap-2 rounded-[var(--control-radius)] px-2.5 text-left text-sm font-medium text-sidebar-muted-foreground outline-none ring-ring transition-colors',
  'hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 active:bg-sidebar-row-active',
  // A locked page stays hoverable and focusable, so its reason shows; it just doesn't respond.
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-sidebar-muted-foreground aria-disabled:active:bg-transparent',
  'data-[current=true]:text-sidebar-foreground',
  'data-[active=true]:bg-sidebar-row-selected data-[active=true]:font-semibold data-[active=true]:text-sidebar-foreground data-[active=true]:shadow-xs/5 dark:data-[active=true]:shadow-none',
);
export const ROW_ICON_CLASS = 'size-4 shrink-0 text-[var(--sidebar-icon-color)] group-hover/row:text-sidebar-foreground group-data-[active=true]/row:text-primary group-data-[current=true]/row:text-primary';

export const SIDEBAR_FOOTER_CLASS = 'flex shrink-0 flex-col gap-2 px-2 pt-1 pb-2';
export const FOOTER_UTILITIES_CLASS = 'flex items-center gap-0.5';
/** T3's footer icon button: 32px, in the sidebar's icon color until hovered. */
export const UTILITY_BUTTON = 'relative text-[var(--sidebar-icon-color)] [--control-icon-color:currentColor] hover:bg-sidebar-row-hover hover:text-sidebar-foreground data-popup-open:bg-sidebar-row-hover data-popup-open:text-sidebar-foreground';

export const MAIN_CLASS = 'relative flex min-w-0 flex-1 flex-col overflow-hidden';
