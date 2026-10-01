import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { Lock, MonitorPlus, Search, UserPlus, type AppIcon } from '../ui/icons';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import { accountSignInsView, canOpenView, type AppView } from '../../navigation';
import { addAccount } from '../../services/addAccount';
import { buildChannelLabel, useBuildChannel } from '../../services/buildChannel';
import { typedPaletteQuery } from '../../services/commandPalette';
import type { PageBadge } from '../../services/pageBadges';
import type { ShortcutId } from '../../services/shortcuts';
import type { AppColor } from '../../services/appColor';
import { sidebarArtInk, type SidebarArt as SidebarArtChoice } from '../../services/sidebarArt';
import type { AppTheme } from '../../theme';
import { ShortcutKbd, WithShortcut } from '../ShortcutKbd';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip';
import { SidebarArt } from './SidebarArt';

/**
 * T3's title row: 52px, a drag region, the artwork behind it and the wordmark at the title content inset, past the Mac
 * window buttons and the sidebar button (which is fixed to the window, not in here).
 */
export function SidebarHeader({ art, theme, color, macTitleBar, onHome }: { art: SidebarArtChoice; theme: AppTheme; color: AppColor; macTitleBar: boolean; onHome: () => void }) {
  const { t } = useI18n();
  const ink = sidebarArtInk(art, theme, color);
  const build = useBuildChannel();
  const buildLabel = buildChannelLabel(build);
  return (
    <div className="relative flex h-[var(--workspace-topbar-height)] shrink-0 items-center" data-tauri-drag-region={macTitleBar ? 'deep' : undefined}>
      <SidebarArt art={art} theme={theme} color={color} />
      <button
        type="button"
        className={cn('relative z-10 -mx-1 ml-[calc(var(--workspace-titlebar-content-left)-0.25rem)] flex h-7 cursor-pointer items-center rounded-md px-1 text-lg font-semibold tracking-tight text-sidebar-foreground outline-none ring-ring focus-visible:ring-2 [-webkit-app-region:no-drag]', ink && 'art-halo')}
        style={ink ? { color: ink } : undefined}
        onClick={onHome}
      >
        {t('app.brandName')}
      </button>
      {buildLabel ? (
        <Badge
          variant={build === 'dev' ? 'info' : 'warning'}
          className="relative z-10 ms-1.5 [-webkit-app-region:no-drag]"
          title={t(build === 'dev' ? 'app.build.devHint' : 'app.build.nightlyHint')}
        >
          {t(buildLabel)}
        </Badge>
      ) : null}
    </div>
  );
}

/** T3's 28px ghost icon buttons beside the search field, in the sidebar's icon color until hovered. */
const HEADER_ICON_BUTTON = 'relative size-7 shrink-0 text-[var(--sidebar-icon-color)] [--control-icon-color:currentColor] hover:bg-sidebar-row-hover hover:text-sidebar-foreground';

/** The group under the title row that holds the search row, over the artwork's fade. */
export function SidebarSearchGroup({ children }: { children: ReactNode }) {
  return <div className="relative z-[1] shrink-0 px-2 pt-5 pb-2" data-slot="sidebar-search">{children}</div>;
}

/**
 * T3's search row, borderless and fixed under the title row. It opens the search palette: a click, Enter or Space opens
 * it empty, and typing opens it with what was typed. Beside it are the two commonest things to add, an account and a
 * machine.
 */
export function SidebarSearchRow({ coreReady, lockedHint, onSearch, onNavigate, onAddMachine }: {
  coreReady: boolean;
  lockedHint: string;
  onSearch: (query: string) => void;
  onNavigate: (view: AppView) => void;
  onAddMachine: () => void;
}) {
  const { t } = useI18n();
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const query = typedPaletteQuery(event);
    if (query === null) return;
    event.preventDefault();
    onSearch(query);
  };
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="group/search flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-sidebar-muted-foreground outline-none ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2"
        aria-haspopup="dialog"
        onClick={() => onSearch('')}
        onKeyDown={onKeyDown}
      >
        <Search aria-hidden="true" className="size-4 shrink-0 text-[var(--sidebar-icon-color)] group-hover/search:text-sidebar-foreground" />
        <span className="min-w-0 flex-1 truncate">{t('palette.open')}</span>
        {/* Once the sidebar is 240px or wider, as T3 shows its hints. */}
        <ShortcutKbd id="palette.toggle" className="hidden bg-transparent text-sidebar-muted-foreground @min-[15rem]/sidebar:inline-flex dark:bg-transparent" />
      </button>
      <div className="flex shrink-0 items-center">
        <HeaderIconButton
          label={t('accounts.add')}
          disabledReason={canOpenView(accountSignInsView(), coreReady) ? undefined : lockedHint}
          onClick={() => addAccount(onNavigate)}
        >
          <UserPlus />
        </HeaderIconButton>
        <HeaderIconButton label={t('machines.hosts.add')} onClick={onAddMachine}>
          <MonitorPlus />
        </HeaderIconButton>
      </div>
    </div>
  );
}

/**
 * A 28px icon button with its name in a tooltip. One that can't be used now stays focusable, shows why in the tooltip,
 * and has the reason as its description, so a screen reader says it too.
 */
function HeaderIconButton({ label, disabledReason, onClick, children }: { label: string; disabledReason?: string; onClick: () => void; children: ReactNode }) {
  const reasonId = useId();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-sm"
            className={HEADER_ICON_BUTTON}
            aria-label={label}
            aria-describedby={disabledReason ? reasonId : undefined}
            disabled={Boolean(disabledReason)}
            focusableWhenDisabled
            onClick={onClick}
          />
        }
      >
        {children}
        {disabledReason ? <span id={reasonId} hidden>{disabledReason}</span> : null}
      </TooltipTrigger>
      <TooltipPopup side="top">{disabledReason ?? label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * T3's menu row: 32px, 14px medium, a 16px icon, muted until it's hovered or the current page. The current page's wash
 * and label color are too close to a hovered row's to tell apart by color alone (under 3:1), so its label is also
 * semibold, as T3 marks its open thread by weight. A page whose open view is lit under it (`data-current`) keeps the
 * full label color without the wash, as T3's project row does over its open thread.
 */
const ROW_CLASS = cn(
  'group/row relative flex h-8 w-full cursor-pointer items-center gap-2 rounded-[var(--control-radius)] px-2.5 text-left text-sm font-medium text-sidebar-muted-foreground outline-none ring-ring transition-colors',
  'hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 active:bg-sidebar-row-active',
  // A locked page stays hoverable and focusable, so its reason shows; it just doesn't respond.
  'aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-sidebar-muted-foreground aria-disabled:active:bg-transparent',
  'data-[current=true]:text-sidebar-foreground',
  'data-[active=true]:bg-sidebar-row-selected data-[active=true]:font-semibold data-[active=true]:text-sidebar-foreground data-[active=true]:shadow-xs/5 dark:data-[active=true]:shadow-none',
);

/**
 * A page in the sidebar: the main pages in the tree under the search row, and Settings' pages in Settings. One that
 * needs the core while it's down shows a lock and says why, in its tooltip and as its description, and stays in the
 * Tab order so the keyboard reaches the reason too; otherwise its tooltip names its shortcut, which shows in place of
 * the badge while ⌘ is held. `current` marks the open page whose view is lit under it rather than the row itself, and
 * `rowProps` are for the tree's keyboard (data attributes) and a chevron's room at the end.
 */
export function SidebarRow({ icon: Icon, label, active, current = false, locked, lockedHint, onClick, badge = null, shortcut, hint = false, className, rowProps }: {
  icon: AppIcon;
  label: string;
  active: boolean;
  current?: boolean;
  locked: boolean;
  lockedHint: string;
  onClick: () => void;
  badge?: PageBadge | null;
  shortcut?: ShortcutId;
  hint?: boolean;
  className?: string;
  rowProps?: Record<`data-${string}`, string>;
}) {
  const { t } = useI18n();
  const reasonId = useId();
  const row = (
    <button
      type="button"
      className={cn(ROW_CLASS, className)}
      aria-disabled={locked || undefined}
      aria-describedby={locked ? reasonId : undefined}
      aria-current={active ? 'page' : undefined}
      data-active={active}
      data-current={current || undefined}
      onClick={locked ? undefined : onClick}
      {...rowProps}
    >
      {/* The open page's icon turns duotone in the theme's teal, whether the row or a view under it is lit. */}
      <Icon
        aria-hidden="true"
        selected={active || current}
        className="size-4 shrink-0 text-[var(--sidebar-icon-color)] group-hover/row:text-sidebar-foreground group-data-[active=true]/row:text-primary group-data-[current=true]/row:text-primary"
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {locked ? (
        <>
          <Lock aria-hidden="true" className="size-3 shrink-0 text-[var(--sidebar-icon-color)]" />
          <span id={reasonId} hidden>{lockedHint}</span>
        </>
      ) : hint && shortcut ? (
        <ShortcutKbd id={shortcut} />
      ) : badge ? (
        <PageBadgeMark badge={badge} label={t(badge.label, { count: badge.count ?? 0 })} />
      ) : null}
    </button>
  );
  // The row is its own tooltip's trigger, so focus shows the tooltip as hovering does. It's kept in the tooltip even
  // with nothing to show, so the row isn't remounted, dropping the focus, as the core stops and starts.
  return (
    <Tooltip>
      <TooltipTrigger render={row} disabled={!locked && !shortcut} />
      {locked || shortcut ? (
        <TooltipPopup side="right">{locked ? lockedHint : shortcut ? <WithShortcut id={shortcut}>{label}</WithShortcut> : label}</TooltipPopup>
      ) : null}
    </Tooltip>
  );
}

function PageBadgeMark({ badge, label }: { badge: PageBadge; label: string }) {
  if (badge.count) {
    return (
      <span className="shrink-0 text-xs font-medium tabular-nums text-warning-foreground">
        <span aria-hidden="true">{badge.count}</span>
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span className={cn('size-1.5 shrink-0 rounded-full', badge.tone === 'error' ? 'bg-error' : 'bg-warning')}>
      <span className="sr-only">{label}</span>
    </span>
  );
}
