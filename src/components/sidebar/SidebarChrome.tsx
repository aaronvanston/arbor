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
import { HEADER_ICON_BUTTON, ROW_CLASS, ROW_ICON_CLASS, SEARCH_GROUP_CLASS, SEARCH_KBD_CLASS, SEARCH_ROW_CLASS, SIDEBAR_HEADER_CLASS, WORDMARK_CLASS } from './shellParts';

/**
 * The build tag sits on the sidebar art, where the badge's see-through tint is unreadable, so it gets an opaque pill: the
 * sidebar's own color with the tint mixed in.
 */
const BUILD_PILL_DEV = 'border-info/30 bg-[color-mix(in_srgb,var(--info)_14%,var(--sidebar))] dark:bg-[color-mix(in_srgb,var(--info)_28%,var(--sidebar))]';
const BUILD_PILL_NIGHTLY = 'border-warning/35 bg-[color-mix(in_srgb,var(--warning)_16%,var(--sidebar))] dark:bg-[color-mix(in_srgb,var(--warning)_26%,var(--sidebar))]';

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
    <div className={SIDEBAR_HEADER_CLASS} data-tauri-drag-region={macTitleBar ? 'deep' : undefined}>
      <SidebarArt art={art} theme={theme} color={color} />
      <button
        type="button"
        className={cn(WORDMARK_CLASS, ink && 'art-halo')}
        style={ink ? { color: ink } : undefined}
        onClick={onHome}
      >
        {t('app.brandName')}
      </button>
      {buildLabel ? (
        <Badge
          variant={build === 'dev' ? 'info' : 'warning'}
          className={cn('relative z-10 ms-1.5 rounded-full shadow-xs [-webkit-app-region:no-drag]', build === 'dev' ? BUILD_PILL_DEV : BUILD_PILL_NIGHTLY)}
          title={t(build === 'dev' ? 'app.build.devHint' : 'app.build.nightlyHint')}
        >
          {t(buildLabel)}
        </Badge>
      ) : null}
    </div>
  );
}


/** The group under the title row that holds the search row, over the artwork's fade. */
export function SidebarSearchGroup({ children }: { children: ReactNode }) {
  return <div className={SEARCH_GROUP_CLASS} data-slot="sidebar-search">{children}</div>;
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
        className={SEARCH_ROW_CLASS}
        aria-haspopup="dialog"
        onClick={() => onSearch('')}
        onKeyDown={onKeyDown}
      >
        <Search aria-hidden="true" className="size-4 shrink-0 text-[var(--sidebar-icon-color)] group-hover/search:text-sidebar-foreground" />
        <span className="min-w-0 flex-1 truncate">{t('palette.open')}</span>
        {/* Once the sidebar is 240px or wider, as T3 shows its hints. */}
        <ShortcutKbd id="palette.toggle" className={SEARCH_KBD_CLASS} />
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
 * A page in the sidebar: the main pages in the tree under the search row, and Settings' pages in Settings. One that
 * needs the core while it's down shows a lock and says why, in its tooltip and as its description, and stays in the
 * Tab order so the keyboard reaches the reason too; otherwise its tooltip names its shortcut, which shows in place of
 * the badge while ⌘ is held. `current` marks the open page whose view is lit under it rather than the row itself, and
 * `rowProps` are data attributes: the tree's keyboard, and the page whose code loads as the row is pointed at.
 */
export function SidebarRow({ icon: Icon, label, active, current = false, locked, lockedHint, onClick, badge = null, badgeLink = null, shortcut, hint = false, className, rowProps }: {
  icon: AppIcon;
  label: string;
  active: boolean;
  current?: boolean;
  locked: boolean;
  lockedHint: string;
  onClick: () => void;
  badge?: PageBadge | null;
  /**
   * Makes the badge a button of its own, beside the row rather than in it, that opens what it counts. `end` is its
   * distance from the row's end, past a chevron there. The row's parent places it, so it must be positioned.
   */
  badgeLink?: { place: string; onOpen: () => void; end: 'chevron' | 'edge' } | null;
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
        className={ROW_ICON_CLASS}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {locked ? (
        <>
          <Lock aria-hidden="true" className="size-3 shrink-0 text-[var(--sidebar-icon-color)]" />
          <span id={reasonId} hidden>{lockedHint}</span>
        </>
      ) : hint && shortcut ? (
        <ShortcutKbd id={shortcut} />
      ) : badge && badgeLink ? (
        // Keeps the badge's room in the row, so the label truncates the same; the badge itself is laid over it.
        <span aria-hidden="true" className="invisible"><PageBadgeMark badge={badge} label="" /></span>
      ) : badge ? (
        <PageBadgeMark badge={badge} label={t(badge.label, { count: badge.count ?? 0 })} />
      ) : null}
    </button>
  );
  const what = badge ? t(badge.label, { count: badge.count ?? 0 }) : '';
  const link = badge && badgeLink && !locked && !(hint && shortcut) ? (
    <Tooltip>
      <TooltipTrigger
        render={(
          <button
            type="button"
            aria-label={`${what}. ${t('sidebar.badge.opens', { place: badgeLink.place })}`}
            className={cn(
              'absolute top-1 flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-1 outline-none ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2',
              badgeLink.end === 'chevron' ? 'right-7' : 'right-1.5',
            )}
            onClick={badgeLink.onOpen}
          />
        )}
      >
        <PageBadgeMark badge={badge} label="" />
      </TooltipTrigger>
      <TooltipPopup side="right" className="flex flex-col gap-0.5">
        <span>{what}</span>
        <span className="text-muted-foreground">{t('sidebar.badge.opens', { place: badgeLink.place })}</span>
      </TooltipPopup>
    </Tooltip>
  ) : null;
  // The row is its own tooltip's trigger, so focus shows the tooltip as hovering does. It's kept in the tooltip even
  // with nothing to show, so the row isn't remounted, dropping the focus, as the core stops and starts.
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={row} disabled={!locked && !shortcut} />
        {locked || shortcut ? (
          <TooltipPopup side="right">{locked ? lockedHint : shortcut ? <WithShortcut id={shortcut}>{label}</WithShortcut> : label}</TooltipPopup>
        ) : null}
      </Tooltip>
      {link}
    </>
  );
}

function PageBadgeMark({ badge, label }: { badge: PageBadge; label: string }) {
  if (badge.count) {
    return (
      <span className="shrink-0 text-xs font-medium tabular-nums text-warning-foreground">
        <span aria-hidden="true">{badge.count}</span>
        {label ? <span className="sr-only">{label}</span> : null}
      </span>
    );
  }
  return (
    <span className={cn('size-1.5 shrink-0 rounded-full', badge.tone === 'error' ? 'bg-error' : 'bg-warning')}>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
