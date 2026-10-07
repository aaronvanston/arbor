import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArchiveX, Bell, CalendarRange, ChevronRight, CirclePause, CirclePlay, CloudAlert, ExternalLink, Flame, Gauge, HardDrive, Hourglass, Layers, MessageSquareMore, MonitorCheck, RotateCcw, Send, ServerCog, Settings2, ShieldQuestionMark, Smartphone, TimeSchedule, Trash2, TriangleAlert, Unplug, type AppIcon, FolderGit2 } from '../components/ui/icons';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { MachineText } from '../components/identity/MachineText';
import { MachineCrumb } from '../components/layout/MachineCrumb';
import { SettingsSection } from '../components/layout/settings';
import { Button } from '../components/ui/button';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { MenuGroupLabel, MenuItem, MenuRadioGroup, MenuRadioItem } from '../components/ui/menu';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { StatusDot } from '../components/ui/status-dot';
import { toast } from '../components/ui/toast';
import { alertDestinationView, openAlertDestination } from '../alertNavigation';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatDate, formatTime } from '../lib/format';
import { whenWindowInFront } from '../lib/windowVisibility';
import { cn } from '../lib/utils';
import { canOpenView, type AppView } from '../navigation';
import {
  ALERT_CATEGORIES,
  ALERT_HISTORY_DAYS,
  alertCategory,
  alertDestination,
  alertMachines,
  alertsByDay,
  alertsOn,
  clearAlertHistory,
  getAlertHistory,
  isUnreadAlert,
  markAlertsSeen,
  restoreAlerts,
  startOfDay,
  useAlertHistory,
  type AlertCategory,
  type AlertDestination,
  type AlertRecord,
} from '../services/alertHistory';
import { alertMentions } from '../services/machineMentions';
import { machineName } from '../services/machineNames';
import type { AlertKind } from '../services/phoneAlerts';
import { useQuotaClock } from '../services/quotaTime';

type Tone = 'warning' | 'error' | 'success' | 'info' | 'muted';
const KIND_LOOK: Record<AlertKind, { icon: AppIcon; tone: Tone }> = {
  limitWarning: { icon: Gauge, tone: 'warning' },
  limitCritical: { icon: Gauge, tone: 'error' },
  limitRecovered: { icon: Gauge, tone: 'success' },
  resetReady: { icon: RotateCcw, tone: 'info' },
  expiring: { icon: Hourglass, tone: 'warning' },
  accountPaused: { icon: CirclePause, tone: 'warning' },
  accountResumed: { icon: CirclePlay, tone: 'success' },
  heavySession: { icon: Flame, tone: 'warning' },
  agentPermission: { icon: ShieldQuestionMark, tone: 'warning' },
  agentWaiting: { icon: MessageSquareMore, tone: 'info' },
  archiveAway: { icon: HardDrive, tone: 'warning' },
  archiveFailing: { icon: ArchiveX, tone: 'error' },
  machineDown: { icon: Unplug, tone: 'error' },
  machineUp: { icon: MonitorCheck, tone: 'success' },
  setupChanged: { icon: Layers, tone: 'info' },
  setupRepo: { icon: FolderGit2, tone: 'warning' },
  setupAuto: { icon: Layers, tone: 'muted' },
  setupAutoFailed: { icon: Layers, tone: 'error' },
  setupWaiting: { icon: Layers, tone: 'info' },
  setupBehind: { icon: Layers, tone: 'warning' },
  setupScanFailing: { icon: Layers, tone: 'warning' },
  automationFailed: { icon: TimeSchedule, tone: 'error' },
  outage: { icon: CloudAlert, tone: 'warning' },
  proxySettings: { icon: ServerCog, tone: 'error' },
  digest: { icon: CalendarRange, tone: 'info' },
  test: { icon: Send, tone: 'muted' },
};
const TONE_CLASS: Record<Tone, string> = {
  warning: 'text-warning-foreground',
  error: 'text-error-foreground',
  success: 'text-success-foreground',
  info: 'text-info-foreground',
  muted: 'text-muted-foreground',
};
const FILTER_LABEL: Record<AlertCategory | 'all', MessageKey> = {
  all: 'alerts.filter.all',
  limits: 'alerts.filter.limits',
  sessions: 'alerts.filter.sessions',
  machines: 'alerts.filter.machines',
  outages: 'alerts.filter.outages',
  digests: 'alerts.filter.digests',
};

/** Every alert Arbor sent, newest first and by day, each opening what it was about. */
export function AlertsPage({ coreReady, onNavigate }: { coreReady: boolean; onNavigate: (view: AppView) => void }) {
  const { t } = useI18n();
  const history = useAlertHistory();
  const now = useQuotaClock();
  const [filter, setFilter] = useState<AlertCategory | 'all'>('all');
  const [machine, setMachine] = useState('');
  const machines = useMemo(
    () => [...new Set(history.entries.flatMap(alertMachines))].sort((left, right) => machineName(left).localeCompare(machineName(right))),
    [history.entries],
  );
  // What was new when the page opened stays marked while it's open; the sidebar stops counting it straight away.
  const [seenBefore] = useState(() => getAlertHistory().seenAtMs);
  // Only once it's looked at: closed on this page, the window is only hidden, and what comes in meanwhile has to stay
  // unread for the count on the tray icon.
  useEffect(() => whenWindowInFront(() => markAlertsSeen()), [history.entries]);

  const shown = useMemo(
    () => alertsOn(history.entries, machine).filter((entry) => filter === 'all' || alertCategory(entry.kind) === filter),
    [history.entries, filter, machine],
  );
  const days = useMemo(() => alertsByDay(shown), [shown]);
  const today = startOfDay(now);
  const dayLabel = (dayMs: number) => (dayMs === today
    ? t('alerts.day.today')
    : dayMs === startOfDay(today - 1) ? t('alerts.day.yesterday') : formatDate(dayMs, { weekday: 'long', month: 'long', now }));

  const open = (destination: AlertDestination) => openAlertDestination(destination, onNavigate);

  // Nothing leaves the Mac or the phone, and Undo puts every alert back, so this doesn't ask first. It clears what the
  // filter and the machine picked show, as the button sits beside them. Clear goes once the list empties, so focus
  // moves to Undo, and back to Clear after it.
  const clearButton = useRef<HTMLButtonElement>(null);
  const refocusClear = useRef(false);
  useLayoutEffect(() => {
    if (!refocusClear.current) return;
    refocusClear.current = false;
    clearButton.current?.focus();
  }, [history.entries]);
  const clear = () => {
    const cleared = clearAlertHistory(filter === 'all' ? null : filter, machine);
    const count = cleared.entries.length;
    if (!count) return;
    toast({
      title: t(count === 1 ? 'alerts.cleared.one' : 'alerts.cleared.other', { count }),
      description: t('alerts.cleared.description'),
      action: {
        label: t('common.undo'),
        onClick: () => {
          refocusClear.current = true;
          restoreAlerts(cleared);
        },
      },
      focusAction: true,
    });
  };

  return (
    <Page width="main">
      <PageTopbar
        collapsible={history.entries.length ? [
          {
            id: 'filter',
            bar: (
              <Select value={filter} onValueChange={(value) => setFilter((value ?? 'all') as AlertCategory | 'all')}>
                <SelectTrigger size="sm" className="w-auto min-w-36" aria-label={t('alerts.filter.label')}>
                  <SelectValue>{t(FILTER_LABEL[filter])}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {(['all', ...ALERT_CATEGORIES] as const).map((category) => (
                    <SelectItem key={category} value={category}>{t(FILTER_LABEL[category])}</SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ),
            menu: (
              <MenuRadioGroup value={filter} onValueChange={(value: AlertCategory | 'all') => setFilter(value)}>
                <MenuGroupLabel>{t('alerts.filter.label')}</MenuGroupLabel>
                {(['all', ...ALERT_CATEGORIES] as const).map((category) => (
                  <MenuRadioItem key={category} value={category} closeOnClick>{t(FILTER_LABEL[category])}</MenuRadioItem>
                ))}
              </MenuRadioGroup>
            ),
          },
          shown.length ? {
            id: 'clear',
            bar: (
              <Button ref={clearButton} variant="ghost-muted" size="sm" onClick={clear}>
                <Trash2 />
                {t('alerts.clear')}
              </Button>
            ),
            menu: (
              <MenuItem onClick={clear}>
                <Trash2 />
                {t('alerts.clear')}
              </MenuItem>
            ),
          } : null,
        ] : undefined}
      >
        <PageBreadcrumb segments={history.entries.length
          ? [t('alerts.title'), <MachineCrumb key="machine" machine={machine} machines={machines} onChange={setMachine} />]
          : [t('alerts.title')]}
        />
      </PageTopbar>
      <PageBody gap="gap-6">
        {!history.entries.length ? (
          <Empty>
            <EmptyMedia><Bell /></EmptyMedia>
            <EmptyTitle>{t('alerts.empty.title')}</EmptyTitle>
            <EmptyDescription>{t('alerts.empty.description')}</EmptyDescription>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => onNavigate({ kind: 'settings', page: 'notifications' })}>
              <Settings2 />
              {t('alerts.empty.settings')}
            </Button>
          </Empty>
        ) : !shown.length ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{t('alerts.empty.filtered', { days: ALERT_HISTORY_DAYS })}</p>
        ) : (
          <>
            {days.map((day) => (
              <SettingsSection key={day.dayMs} title={dayLabel(day.dayMs)}>
                {day.entries.map((entry) => (
                  <AlertRow key={entry.id} entry={entry} unread={isUnreadAlert(entry, seenBefore)} coreReady={coreReady} onOpen={open} />
                ))}
              </SettingsSection>
            ))}
            <p className="text-center text-xs text-muted-foreground">{t('alerts.kept', { days: ALERT_HISTORY_DAYS })}</p>
          </>
        )}
      </PageBody>
    </Page>
  );
}

function AlertRow({ entry, unread, coreReady, onOpen }: {
  entry: AlertRecord;
  unread: boolean;
  coreReady: boolean;
  onOpen: (destination: AlertDestination) => void;
}) {
  const { t } = useI18n();
  const { icon: Icon, tone } = KIND_LOOK[entry.kind];
  const destination = alertDestination(entry);
  const view = destination ? alertDestinationView(destination) : null;
  const locked = view !== null && !canOpenView(view, coreReady);
  const mentions = alertMentions(entry);
  const problems = [
    entry.mac === 'off' ? t('alerts.mac.off') : entry.mac === 'failed' ? t('alerts.mac.failed') : '',
    typeof entry.phone === 'string' ? t('alerts.phone.failed', { error: entry.phone }) : '',
  ].filter(Boolean);

  const content = (
    <>
      <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background dark:bg-input/32 [&_svg]:size-3.5', TONE_CLASS[tone])}>
        <Icon aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-foreground"><MachineText parts={mentions.title} size="md" /></span>
          {entry.count && entry.count > 1 ? (
            <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground" title={t('alerts.repeated.label', { count: entry.count })}>
              <span aria-hidden="true">{t('alerts.repeated.count', { count: entry.count })}</span>
              <span className="sr-only">{t('alerts.repeated.label', { count: entry.count })}</span>
            </span>
          ) : null}
          {unread ? (
            <>
              <StatusDot tone="primary" />
              <span className="sr-only">{t('alerts.new')}</span>
            </>
          ) : null}
          <span className="ms-auto flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
            {entry.phone === null ? (
              <span className="inline-flex" title={t('alerts.phone.sent')}>
                <Smartphone aria-hidden="true" className="size-3.5 text-muted-foreground/70" />
                <span className="sr-only">{t('alerts.phone.sent')}</span>
              </span>
            ) : null}
            {formatTime(entry.atMs)}
          </span>
        </span>
        <span className="mt-0.5 block whitespace-pre-line text-xs leading-[1.45] text-muted-foreground"><MachineText parts={mentions.body} /></span>
        {problems.map((problem) => (
          <span key={problem} className="mt-1 flex items-start gap-1.5 text-xs text-warning-foreground">
            <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            {problem}
          </span>
        ))}
      </span>
    </>
  );

  if (!destination || locked) {
    return (
      <div className="flex items-start gap-3 px-4 py-3" title={locked ? t('alerts.locked') : undefined}>
        {content}
      </div>
    );
  }
  const Go = destination.kind === 'url' ? ExternalLink : ChevronRight;
  return (
    <button
      type="button"
      className="group flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent"
      onClick={() => onOpen(destination)}
    >
      {content}
      <Go aria-hidden="true" className="mt-1.5 size-3.5 shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
}
