import { useState, type ReactElement, type ReactNode } from 'react';
import { ArrowLeft, ArrowUpCircle, Bell, Clock, Server, Settings } from '../ui/icons';
import { alertDestinationView, openAlertDestination } from '../../alertNavigation';
import { useCoreRuntime } from '../../coreRuntime';
import { useI18n } from '../../i18n';
import { formatAgo } from '../../lib/format';
import { useScrollFade } from '../../hooks/useScrollFade';
import { cn } from '../../lib/utils';
import type { AppView } from '../../navigation';
import { alertDestination, isUnreadAlert, markAlertRead, markAlertsSeen, useAlertHistory } from '../../services/alertHistory';
import type { SidebarCoreState } from '../../services/coreLock';
import { alertMentions } from '../../services/machineMentions';
import type { ReleaseNotesView } from '../../services/releaseNotes';
import type { ShortcutId } from '../../services/shortcuts';
import { usePaletteActions } from '../CommandPaletteActions';
import { MachineText } from '../identity/MachineText';
import { ShortcutKbd, WithShortcut } from '../ShortcutKbd';
import { UpdatePillNotes } from '../UpdateReleaseNotes';
import { Button } from '../ui/button';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '../ui/menu';
import { Popover, PopoverPopup, PopoverTrigger } from '../ui/popover';
import { StatusDot } from '../ui/status-dot';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip';

/** T3's footer icon button: 32px, in the sidebar's icon color until hovered. */
const UTILITY_BUTTON = 'relative text-[var(--sidebar-icon-color)] [--control-icon-color:currentColor] hover:bg-sidebar-row-hover hover:text-sidebar-foreground data-popup-open:bg-sidebar-row-hover data-popup-open:text-sidebar-foreground';
/** A dot on a footer icon's corner, ringed in the sidebar color so it reads over the glyph. */
const CORNER_DOT = 'absolute top-1.5 right-1.5 size-1.5 rounded-full ring-2 ring-sidebar';

/** Most alerts the bell's popover lists; the rest are on the Alerts page. */
const ALERTS_IN_POPOVER = 8;

function UtilityTooltip({ label, shortcut, trigger, children }: { label: string; shortcut?: ShortcutId; trigger: ReactElement; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={trigger}>{children}</TooltipTrigger>
      <TooltipPopup side="top">{shortcut ? <WithShortcut id={shortcut}>{label}</WithShortcut> : label}</TooltipPopup>
    </Tooltip>
  );
}

/** Settings, ⌘,. */
export function SettingsUtility({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();
  const label = t('app.nav.settings');
  return (
    <UtilityTooltip label={label} shortcut="settings.open" trigger={<Button variant="ghost-muted" size="icon" className={UTILITY_BUTTON} aria-label={label} onClick={onOpen} />}>
      <Settings />
    </UtilityTooltip>
  );
}

/**
 * The alert history's bell. It's a log, so it's in the footer rather than among the pages: a dot in the accent color
 * says something's unread, and the popover lists the newest unread, each opening what it's about. The Alerts page is
 * still ⌘7.
 */
export function AlertsUtility({ current, onNavigate }: { current: boolean; onNavigate: (view: AppView) => void }) {
  const { t } = useI18n();
  const history = useAlertHistory();
  // Held here so opening an alert, or the Alerts page, closes the popover rather than leaving it over what opened.
  const [open, setOpen] = useState(false);
  // The list fades at an edge with more past it, so an alert cut by its bottom edge reads as more to scroll.
  const [listRef, listFade] = useScrollFade<HTMLUListElement>();
  const unread = history.entries.filter((entry) => isUnreadAlert(entry, history.seenAtMs));
  const label = unread.length ? t(unread.length === 1 ? 'alerts.unread.one' : 'alerts.unread.other', { count: unread.length }) : t('app.nav.alerts');
  const shown = unread.slice(0, ALERTS_IN_POPOVER);
  const now = Date.now();
  const openAlerts = () => {
    setOpen(false);
    onNavigate({ kind: 'main', page: 'alerts' });
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <UtilityTooltip
        label={label}
        shortcut="go.alerts"
        trigger={
          <PopoverTrigger
            render={<Button variant="ghost-muted" size="icon" className={cn(UTILITY_BUTTON, current && 'bg-sidebar-row-selected text-sidebar-foreground')} aria-label={label} />}
          />
        }
      >
        <Bell />
        {unread.length ? <span aria-hidden="true" className={cn(CORNER_DOT, 'bg-primary')} /> : null}
      </UtilityTooltip>
      <PopoverPopup side="top" align="start" sideOffset={8} padding="none" className="w-80" aria-label={t('app.nav.alerts')}>
        <div className="flex items-center justify-between gap-3 px-3 pt-2.5 pb-1.5">
          <span className="text-sm font-medium">{t('app.nav.alerts')}</span>
          {unread.length ? <Button variant="ghost" size="xs" className="-me-1.5" onClick={() => markAlertsSeen()}>{t('sidebar.alerts.markRead')}</Button> : null}
        </div>
        {shown.length ? (
          <ul ref={listRef} style={listFade} className="flex max-h-80 flex-col overflow-y-auto px-1.5">
            {shown.map((entry) => {
              const destination = alertDestination(entry);
              const opens = destination !== null && (destination.kind === 'url' || alertDestinationView(destination) !== null);
              const mentions = alertMentions(entry);
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-1.5 py-1.5 text-left outline-none ring-ring hover:bg-accent focus-visible:ring-2"
                    onClick={() => {
                      markAlertRead(entry.id);
                      if (!destination || !opens) {
                        openAlerts();
                        return;
                      }
                      setOpen(false);
                      openAlertDestination(destination, onNavigate);
                    }}
                  >
                    <span className="flex w-full items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium"><MachineText parts={mentions.title} size="md" /></span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatAgo(entry.atMs, now)}</span>
                    </span>
                    {entry.body ? <span className="line-clamp-2 text-xs text-muted-foreground"><MachineText parts={mentions.body} /></span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-3 pt-1 pb-3 text-sm text-muted-foreground">{t('sidebar.alerts.none')}</p>
        )}
        {unread.length > shown.length ? (
          <p className="px-3 pt-1 text-xs text-muted-foreground">{t('sidebar.alerts.more', { count: unread.length - shown.length })}</p>
        ) : null}
        <div className="mt-1.5 flex border-t border-border/60 p-1.5">
          <Button variant="ghost" size="sm" className="w-full justify-between" onClick={openAlerts}>
            {t('sidebar.alerts.seeAll')}
            <ShortcutKbd id="go.alerts" />
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The core, from any page: a dot for its state, and a menu with what the search palette can do to it (start, restart,
 * stop, copy what clients connect with), each asking first, and the way to its settings.
 */
export function CoreUtility({ state, onNavigate }: { state: SidebarCoreState; onNavigate: (view: AppView) => void }) {
  const { t } = useI18n();
  const { status } = useCoreRuntime();
  const { actions } = usePaletteActions({ onNavigate, confirmCore: true });
  const pick = (ids: string[]) => actions.filter((action) => ids.includes(action.id));
  const process = pick(['action:start-core', 'action:restart-core', 'action:stop-core']);
  const copies = pick(['action:copy-base-url', 'action:copy-api-key']);
  const stateLabel = t(state.label);
  const label = t('sidebar.core.label', { state: stateLabel });
  const details = status?.currentVersion && status.processId ? t('sidebar.core.details', { version: status.currentVersion, pid: status.processId }) : status?.currentVersion ?? '';
  return (
    <Menu>
      <UtilityTooltip label={label} trigger={<MenuTrigger render={<Button variant="ghost-muted" size="icon" className={UTILITY_BUTTON} aria-label={label} />} />}>
        <Server />
        <StatusDot tone={state.tone} pulse={state.tone === 'warning'} className={CORNER_DOT} />
      </UtilityTooltip>
      <MenuPopup side="top" align="start" sideOffset={8} className="w-64">
        <div className="flex flex-col gap-0.5 px-2 py-1.5">
          <span className="flex items-center gap-2 text-sm">
            <StatusDot tone={state.tone} />
            <span className="font-medium">{t('app.nav.kernel')}</span>
            <span className="text-muted-foreground">{stateLabel}</span>
          </span>
          {details ? <span className="ps-4 font-mono text-xs text-muted-foreground">{details}</span> : null}
        </div>
        <MenuSeparator />
        {process.map((action) => (
          <MenuItem key={action.id} disabledReason={action.disabledReason} onClick={() => void action.run?.()}>{action.label}</MenuItem>
        ))}
        <MenuSeparator />
        {copies.map((action) => (
          <MenuItem key={action.id} disabledReason={action.disabledReason} onClick={() => void action.run?.()}>{action.label}</MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onClick={() => onNavigate({ kind: 'settings', page: 'general' })}>{t('sidebar.core.proxySettings')}</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/**
 * The one urgent state that takes a whole footer row: the core stopped, with Start (which asks first), or not
 * installed, with Install on Settings › Updates.
 */
export function CoreDownRow({ state, onNavigate }: { state: SidebarCoreState; onNavigate: (view: AppView) => void }) {
  const { t } = useI18n();
  const { down } = state;
  const { actions } = usePaletteActions({ onNavigate, confirmCore: true });
  const start = actions.find((action) => action.id === 'action:start-core');
  return (
    <div className="flex min-h-8 items-center gap-2 px-2.5 py-1 text-sm" data-slot="sidebar-core-down">
      {/* Red for missing too: the Core button's dot is gray then, but this row is here because nothing is proxied. */}
      <StatusDot tone="error" />
      {/* It wraps rather than truncates: at the narrowest sidebar "Core not installed" doesn't fit beside Install, and
          this row is the one that has to be read. */}
      <span className="min-w-0 flex-1 leading-tight font-medium text-balance break-words text-sidebar-foreground">{t(down === 'stopped' ? 'sidebar.core.down.stopped' : 'sidebar.core.down.missing')}</span>
      {down === 'missing' ? (
        <Button variant="outline" size="xs" onClick={() => onNavigate({ kind: 'settings', page: 'updates' })}>{t('sidebar.core.install')}</Button>
      ) : (
        <Button variant="outline" size="xs" disabledReason={start?.disabledReason} onClick={() => void start?.run?.()}>{t('sidebar.core.start')}</Button>
      )}
    </div>
  );
}

/**
 * T3's round update icon at the footer's end, shown only while an update is there: a press opens Settings › Updates,
 * and hovering or focusing it shows what the Arbor update changes. A clock while it waits for agents to go idle.
 */
export function UpdateUtility({ state, current, label, detail, notes, enabled, releaseUrl, releasesUrl, onOpen }: {
  state: 'available' | 'waiting' | 'processing';
  current: boolean;
  label: string;
  /** The lines under the label: what's available, what's waiting. */
  detail: string[];
  notes: ReleaseNotesView;
  enabled: boolean;
  releaseUrl: (version: string) => string;
  releasesUrl: string;
  onOpen: () => void;
}) {
  const Icon = state === 'waiting' ? Clock : ArrowUpCircle;
  const title = [label, ...detail].join('\n');
  return (
    <UpdatePillNotes
      view={notes}
      enabled={enabled}
      releaseUrl={releaseUrl}
      releasesUrl={releasesUrl}
      header={
        <div className="leading-tight">
          <div className="text-sm font-medium text-foreground">{label}</div>
          {detail.map((line) => <div key={line} className="mt-0.5 text-xs text-muted-foreground">{line}</div>)}
        </div>
      }
      button={
        <button
          type="button"
          // The glyph is the update's accent mark; its hover and current fills are the neutral washes every footer
          // button uses, since the accent never marks the open page.
          className={cn(
            'relative ms-auto flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-primary outline-none ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 data-popup-open:bg-sidebar-row-hover',
            current && 'bg-sidebar-row-selected',
          )}
          aria-label={title}
          title={notes.sections.length ? undefined : title}
          onClick={onOpen}
        >
          <Icon aria-hidden="true" className={cn('size-4', state === 'processing' && 'motion-safe:animate-status-pulse')} />
          {/* While it waits for the agents to go idle, a ring turns around it. How long that takes can't be known, so
              the ring doesn't fill. */}
          {state === 'waiting' ? (
            <svg aria-hidden="true" viewBox="0 0 32 32" className="pointer-events-none absolute inset-0 size-8 motion-safe:animate-spin motion-safe:[animation-duration:2.4s]" data-slot="update-waiting-ring">
              <circle cx="16" cy="16" r="14.5" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.5" />
              <circle cx="16" cy="16" r="14.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="20 72" />
            </svg>
          ) : null}
        </button>
      }
    />
  );
}

/** Settings' foot: back to the page that was open before, T3's full-width Back (Esc). */
export function SettingsBack({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const label = t('app.nav.back');
  return (
    <UtilityTooltip
      label={label}
      shortcut="settings.leave"
      trigger={
        <button
          type="button"
          className="group/back flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[var(--control-radius)] px-2.5 text-left text-sm font-medium text-sidebar-muted-foreground outline-none ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2"
          onClick={onBack}
        />
      }
    >
      <ArrowLeft aria-hidden="true" className="size-4 shrink-0 text-[var(--sidebar-icon-color)] group-hover/back:text-sidebar-foreground" />
      <span className="truncate">{label}</span>
    </UtilityTooltip>
  );
}
