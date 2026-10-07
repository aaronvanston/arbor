import { useEffect, useMemo, useRef } from 'react';
import { invokeCommand } from '../native/commands';
import { useI18n } from '../i18n';
import { useAppPreferences } from '../appPreferences';
import { recordLimitReadings, unrecordedLimitReadings } from '../services/accountLimitHistory';
import { freshQuotas, partialHeadline, useAccountLimitPrefs, type PaceTone } from '../services/accountLimits';
import { useAccountReserves } from '../services/accountReserves';
import { resolveAccountProfile, useAccountProfiles } from '../services/accountProfiles';
import { useAccountOrder } from '../services/accountOrder';
import { ensureAccountsLoaded, getAccountsSnapshot, loadAccountFiles, refreshAccountQuotas, useAccountsStore } from '../services/accountsStore';
import { expiringCapacity, nextExpiringNotifications, type ExpiringCapacity } from '../services/expiringCapacity';
import { recordLimitSample } from '../services/limitsHistory';
import { notify } from '../services/notify';
import { nextOutageNotifications, outageNotification } from '../services/outageAlerts';
import { formatResetCountdown, providerLabel, providerLimits, type ProviderLimit } from '../services/providerLimits';
import {
  activeStatus,
  isStatusProvider,
  refreshProviderStatuses,
  retainProviderStatuses,
  STATUS_POLL_INTERVAL_MS,
  useProviderStatuses,
  worstIndicator,
  type StatusIndicator,
  type StatusProvider,
} from '../services/providerStatus';
import { statusSummary } from '../services/providerStatusText';
import { useQuotaCache } from '../services/quotaCache';
import { applyRoutingPlan, routingCandidates, routingPlan, useRoutingAuto } from '../services/quotaRouting';
import { fileName, providerForFile, quotaKey, type QuotaProvider } from '../services/quotaService';
import { useQuotaClock } from '../services/quotaTime';
import { formatDateTime, formatWhen } from '../lib/format';
import type { TrayDot, TrayRow } from '../native/types';
import { publishTrayRows } from '../services/trayMenu';
import { pushToTray } from '../services/bootMode';
import { nextResetNotifications, type ResetReady } from '../services/resetReadiness';

const NOTIFIED_KEY = 'arbor.limits-notified.v1';
const RESET_NOTIFIED_KEY = 'arbor.reset-notified.v1';
const EXPIRING_NOTIFIED_KEY = 'arbor.expiring-notified.v1';
const OUTAGE_NOTIFIED_KEY = 'arbor.outage-notified.v1';
/** More at once would be noise; the banner names them all. */
const MAX_OUTAGE_NOTIFICATIONS = 3;
const TRAY_SUMMARY_MAX = 64;
/** A provider's status line in the tray takes the icon dot's color: red for an outage, amber for trouble, gray for maintenance. */
const STATUS_DOT: Record<StatusIndicator, TrayDot> = { none: 'green', minor: 'amber', unknown: 'amber', major: 'red', critical: 'red', maintenance: 'gray' };
const severity: Record<PaceTone, number> = { muted: 0, success: 1, warning: 2, error: 3 };

const readStored = <T,>(key: string): Record<string, T> => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, T>;
  } catch {
    return {};
  }
};
const writeStored = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* keep in memory */
  }
};

const lowerFirst = (value: string) => value.charAt(0).toLowerCase() + value.slice(1);
const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

/** Decides whether a pace change deserves a notification: crossing into amber/red, or headroom coming back. */
export function notificationKind(previous: PaceTone | undefined, next: PaceTone): 'warning' | 'error' | 'recovered' | null {
  if (previous === undefined || next === 'muted' || previous === next) return null;
  if (next === 'error') return 'error';
  if (next === 'warning' && severity[previous] < severity.warning) return 'warning';
  if (next === 'success' && severity[previous] >= severity.warning) return 'recovered';
  return null;
}

type PaceNotice = ReturnType<typeof notificationKind>;

/**
 * What a provider's pace does now. `saved` is the level it last settled on, `lastFresh` the pace of the accounts
 * still read at the previous look and `next` their pace now. `held` is the pace with the limits held over from
 * before a failed check, while those still hold (see `staleHoldMs`), else null.
 *
 * Leaving out a held-over account can only make the pace look better, so while one holds the pace doesn't come
 * down past what the held-over limits show: no "back on track" from a failed check. A rise among the accounts
 * still read is measured from their own last pace rather than the held level, so a new run on another account
 * still notifies.
 *
 * `regrouped` is set when the accounts counted changed since the last look: one turned off or on, by hand or at a cap,
 * signed in or removed. The pooled pace then moves because of who's counted, not how fast limits run down, so it
 * settles on the new pace without a word.
 */
export function paceStep(
  saved: PaceTone | undefined,
  lastFresh: PaceTone | undefined,
  next: PaceTone,
  held: PaceTone | null,
  regrouped = false,
): { saved: PaceTone | undefined; kind: PaceNotice } {
  if (next === 'muted') return { saved, kind: null };
  if (saved === undefined || regrouped) return { saved: next, kind: null };
  const rose = held !== null && lastFresh !== undefined && severity[next] > severity[lastFresh] ? notificationKind(lastFresh, next) : null;
  if (severity[next] > severity[saved]) return { saved: next, kind: notificationKind(saved, next) };
  if (next === saved || (held !== null && severity[next] < severity[held])) return { saved, kind: rose };
  return { saved: next, kind: notificationKind(saved, next) };
}

/**
 * How long held-over limits keep a provider's pace from coming down and its sparkline from moving: a check or two,
 * the flaky stretch they are kept for. Past that the accounts still read decide.
 */
export const staleHoldMs = (refreshIntervalMinutes: number) => 2 * (refreshIntervalMinutes > 0 ? refreshIntervalMinutes : 15) * 60_000;

/** Whether a provider's held-over limits still hold, by when the latest of them started failing. */
export const staleHolds = (stale: ProviderLimit['stale'], nowMs: number, holdMs: number) =>
  stale !== null && nowMs - stale.latestSinceMs < holdMs;

/**
 * Headless companion to the sidebar: polls limits and the providers' status pages in the background,
 * mirrors both into the tray menu, records history for the sparklines and each account's limits, keeps
 * the suggested routing priorities applied where that is switched on, and raises native notifications on
 * pace changes, when a reset can get an account past a limit, when capacity is about to reset unused and
 * when a status page reports a new incident.
 */
export function LimitsMonitor({ coreReady }: { coreReady: boolean }) {
  const { t } = useI18n();
  const preferences = useAppPreferences();
  const { files, loaded, error: accountsError } = useAccountsStore();
  const quotas = useQuotaCache();
  const profiles = useAccountProfiles();
  const order = useAccountOrder();
  const prefs = useAccountLimitPrefs();
  const statuses = useProviderStatuses();
  const routingAuto = useRoutingAuto();
  const reserves = useAccountReserves();
  const now = useQuotaClock();
  const lastRefreshRef = useRef(0);
  const notifiedRef = useRef<Record<string, PaceTone>>(typeof localStorage === 'undefined' ? {} : readStored<PaceTone>(NOTIFIED_KEY));
  const resetNotifiedRef = useRef<Record<string, true>>(typeof localStorage === 'undefined' ? {} : readStored<true>(RESET_NOTIFIED_KEY));
  const expiringNotifiedRef = useRef<Record<string, number>>(typeof localStorage === 'undefined' ? {} : readStored<number>(EXPIRING_NOTIFIED_KEY));
  const outageNotifiedRef = useRef<Record<string, number>>(typeof localStorage === 'undefined' ? {} : readStored<number>(OUTAGE_NOTIFIED_KEY));

  const limits = useMemo(() => providerLimits(files, quotas, profiles, prefs, now, order), [files, quotas, profiles, prefs, now, order]);
  // What alerts and routing act on: limits held over from before a failed check read as unknown.
  const freshCache = useMemo(() => freshQuotas(quotas), [quotas]);
  const freshLimits = useMemo(() => providerLimits(files, freshCache, profiles, prefs, now, order), [files, freshCache, profiles, prefs, now, order]);

  // Background polling. While the window is hidden it carries on only for the tray menu, notifications,
  // automatic routing and account caps, which use the limits without the window; otherwise it pauses and
  // catches up when the window is shown.
  const pollWhileHidden = preferences.trayLimits || preferences.limitNotifications || preferences.resetNotifications
    || preferences.expiringNotifications || Object.values(routingAuto).some(Boolean) || Object.keys(reserves.caps).length > 0;
  useEffect(() => {
    const intervalMs = preferences.refreshIntervalMinutes * 60_000;
    if (!coreReady || intervalMs <= 0) return;
    void ensureAccountsLoaded();
    const refresh = () => {
      if (document.visibilityState !== 'visible' && !pollWhileHidden) return;
      lastRefreshRef.current = Date.now();
      const { files: listed, disabled } = getAccountsSnapshot();
      // Turned-off accounts are only shown, never acted on, so they're read only while the window is.
      void refreshAccountQuotas(document.visibilityState === 'visible' ? [...listed, ...disabled] : listed);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRefreshRef.current >= intervalMs) refresh();
    };
    lastRefreshRef.current = Date.now();
    const timer = setInterval(refresh, intervalMs);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [coreReady, preferences.refreshIntervalMinutes, pollWhileHidden]);

  // Status pages for the providers that have accounts. They are public and don't go through the core.
  const statusKey = useMemo(
    () => [...new Set(files.map(providerForFile).filter(isStatusProvider))].sort().join(','),
    [files],
  );
  useEffect(() => {
    const providers = preferences.providerStatus && statusKey ? (statusKey.split(',') as StatusProvider[]) : [];
    retainProviderStatuses(providers);
    if (!providers.length) return;
    void refreshProviderStatuses(providers);
    const timer = setInterval(() => void refreshProviderStatuses(providers), STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [preferences.providerStatus, statusKey]);

  // Providers whose figure includes held-over limits that still hold, with the pace those give it.
  const holdMs = staleHoldMs(preferences.refreshIntervalMinutes);
  const heldPaces = limits.filter((limit) => staleHolds(limit.stale, now, holdMs)).map((limit) => `${limit.provider}:${limit.pace.tone}`).join(',');

  // History samples for the sparklines, of the accounts still read. While held-over limits hold, a provider waits
  // for a good check rather than record the jump from leaving an account out.
  useEffect(() => {
    const held = new Set(heldPaces.split(',').map((item) => item.split(':')[0]));
    freshLimits.forEach((limit) => {
      if (!limit.loading && !held.has(limit.provider)) recordLimitSample(limit.provider, limit.headline.percent);
    });
  }, [freshLimits, heldPaces]);

  // Each account's limits after every refresh, kept for the capacity report.
  const recordedLimitsRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const { readings, recorded } = unrecordedLimitReadings(files, quotas, recordedLimitsRef.current);
    recordedLimitsRef.current = recorded;
    void recordLimitReadings(readings);
  }, [files, quotas]);

  // Tray menu rows. A provider mid-refresh keeps its last published row so the menu never shows a half-pooled figure.
  const trayRowRef = useRef<Partial<Record<string, TrayRow>>>({});
  const trayRows = useMemo((): TrayRow[] => {
    if (!preferences.trayLimits) return [];
    return limits.flatMap((limit) => {
      const held = trayRowRef.current[limit.provider];
      if (limit.loading) return held ? [held] : [];
      if (limit.headline.percent === null) {
        delete trayRowRef.current[limit.provider];
        return [];
      }
      // Absolute reset times stay correct in the tray while the window is hidden for hours.
      const resetAt = limit.headline.nextResetMs ? formatDateTime(limit.headline.nextResetMs) : '';
      const text = [
        t('tray.limitLine', { provider: providerLabel[limit.provider], percent: Math.round(limit.headline.percent) }),
        partialHeadline(limit.headline) ? t('accounts.headline.reporting', { reporting: limit.headline.reporting, total: limit.headline.total }) : '',
        resetAt ? t('tray.resetsAt', { time: resetAt }) : '',
        limit.pace.tone === 'error' ? t('tray.pace.critical') : limit.pace.tone === 'warning' ? t('tray.pace.ahead') : '',
        limit.stale ? t('tray.asOf', { time: formatWhen(limit.stale.asOfMs, { now }) }) : '',
      ].filter(Boolean).join(' · ');
      const dot: TrayDot = limit.stale ? 'gray' : limit.pace.tone === 'error' ? 'red' : limit.pace.tone === 'warning' ? 'amber' : 'green';
      const row = { text, dot };
      trayRowRef.current[limit.provider] = row;
      return [row];
    });
  }, [limits, preferences.trayLimits, now, t]);
  const activeStatuses = useMemo(() => {
    if (!preferences.providerStatus) return [];
    return (['claude', 'codex'] as const).flatMap((provider) => {
      const status = activeStatus(statuses[provider], now);
      return status ? [{ provider, status }] : [];
    });
  }, [preferences.providerStatus, statuses, now]);
  const statusRows = activeStatuses.map(({ provider, status }): TrayRow => ({
    text: t('tray.status', { provider: providerLabel[provider], summary: truncate(statusSummary(status, t), TRAY_SUMMARY_MAX) }),
    dot: STATUS_DOT[status.indicator],
  }));
  const trayKey = JSON.stringify([...trayRows, ...statusRows]);
  useEffect(() => {
    publishTrayRows('limits', JSON.parse(trayKey) as TrayRow[]);
  }, [trayKey]);
  const trayIndicator = worstIndicator(activeStatuses.map(({ status }) => status.indicator));
  useEffect(() => {
    pushToTray('status', trayIndicator === 'none', () => {
      invokeCommand('set_tray_status', { indicator: trayIndicator }).catch((error) => console.warn('Failed to update the tray icon', error));
    });
  }, [trayIndicator]);

  // Native notifications on pace transitions.
  const freshPaceRef = useRef<Record<string, PaceTone>>({});
  // Which accounts each provider's pace counted at the last look, so a change in who's counted isn't news.
  const countedRef = useRef<Record<string, string>>({});
  useEffect(() => {
    if (!preferences.limitNotifications) return;
    const pending: { id: string; provider: string; kind: 'warning' | 'error' | 'recovered'; percent: number; reporting: string; countdown: string }[] = [];
    let changed = false;
    const held = new Map(heldPaces ? heldPaces.split(',').map((item) => item.split(':') as [string, PaceTone]) : []);
    freshLimits.forEach((limit) => {
      if (limit.loading || limit.headline.percent === null) return;
      const previous = notifiedRef.current[limit.provider];
      const next = limit.pace.tone;
      const counted = limit.accounts.map((account) => account.key).sort().join('\n');
      const regrouped = countedRef.current[limit.provider] !== undefined && countedRef.current[limit.provider] !== counted;
      countedRef.current[limit.provider] = counted;
      const { saved, kind } = paceStep(previous, freshPaceRef.current[limit.provider], next, held.get(limit.provider) ?? null, regrouped);
      if (next !== 'muted') freshPaceRef.current[limit.provider] = next;
      if (saved !== undefined && saved !== previous) {
        notifiedRef.current[limit.provider] = saved;
        changed = true;
      }
      if (kind) {
        pending.push({
          id: limit.provider,
          provider: providerLabel[limit.provider],
          kind,
          percent: Math.round(limit.headline.percent),
          reporting: partialHeadline(limit.headline) ? t('accounts.headline.reporting', { reporting: limit.headline.reporting, total: limit.headline.total }) : '',
          countdown: formatResetCountdown(limit.headline.nextResetMs, now),
        });
      }
    });
    if (changed) writeStored(NOTIFIED_KEY, notifiedRef.current);
    void notify(pending.map((item) => {
      const reset = item.countdown ? `${t('accounts.resetsIn', { time: item.countdown })}.` : '';
      return {
        title: t(`notifications.${item.kind}.title`, { provider: item.provider }),
        body: [t(`notifications.${item.kind}.body`, { provider: item.provider, percent: item.percent }), item.reporting ? `${item.reporting}.` : '', reset].filter(Boolean).join(' '),
        kind: item.kind === 'error' ? 'limitCritical' : item.kind === 'warning' ? 'limitWarning' : 'limitRecovered',
        urgent: item.kind === 'error',
        // Each kind has its own title, so the provider is what makes "back on track" news between two warnings.
        subject: { provider: item.id },
      };
    }));
  }, [freshLimits, heldPaces, preferences.limitNotifications, now, t]);

  // Native notifications when an account reaches a limit that a reset can refill, once per stretch at the limit.
  // Waiting for a refresh round to finish lets accounts that get there together share one notification per provider.
  useEffect(() => {
    if (!preferences.resetNotifications) return;
    if (files.some((file) => quotas[quotaKey(file)]?.status === 'loading')) return;
    const accounts = files.map((file) => ({ key: quotaKey(file), file, quota: quotas[quotaKey(file)] }));
    const { notified, ready, changed } = nextResetNotifications(resetNotifiedRef.current, accounts, loaded && !accountsError);
    if (!changed) return;
    resetNotifiedRef.current = notified;
    writeStored(RESET_NOTIFIED_KEY, notified);
    const byProvider = new Map<ResetReady['provider'], typeof ready>();
    ready.forEach((item) => byProvider.set(item.provider, [...(byProvider.get(item.provider) ?? []), item]));
    void notify([...byProvider].map(([provider, items]) => {
      const names = items.map((item) => resolveAccountProfile(item.key, fileName(item.file), profiles[item.key]).name);
      if (names.length > 1) {
        const accounts = t('quota.service.list', { items: names.slice(0, -1).join(', '), last: names[names.length - 1]! });
        return {
          title: t('notifications.resetReady.titleMany', { provider: providerLabel[provider] }),
          body: t(provider === 'codex' ? 'notifications.resetReady.manualMany' : 'notifications.resetReady.bankedMany', { accounts }),
          kind: 'resetReady',
          subject: { accounts: items.map((item) => item.key) },
        };
      }
      const [item] = items;
      const account = names[0]!;
      const limit = item!.limit ? lowerFirst(item!.limit) : '';
      return {
        title: t('notifications.resetReady.title', { provider: providerLabel[provider] }),
        body: provider === 'codex'
          ? t('notifications.resetReady.manual', { account, limit })
          : limit ? t('notifications.resetReady.bankedLimit', { account, limit }) : t('notifications.resetReady.banked', { account }),
        kind: 'resetReady',
        subject: { account: item!.key },
      };
    }));
  }, [files, quotas, loaded, accountsError, profiles, preferences.resetNotifications, t]);

  // Suggested routing priorities, for the providers set to apply them automatically. Each provider is
  // looked at once per refresh round (the newest limit reading), so a failing update waits for the next round.
  const routedRoundRef = useRef<Record<string, number>>({});
  const routingRef = useRef(false);
  useEffect(() => {
    if (!coreReady || !loaded || accountsError || routingRef.current || freshLimits.some((limit) => limit.loading)) return;
    const due = freshLimits.flatMap((limit) => {
      if (!routingAuto[limit.provider]) {
        // Switching it back on applies straight away rather than at the next refresh.
        delete routedRoundRef.current[limit.provider];
        return [];
      }
      const providerFiles = files.filter((file) => providerForFile(file) === limit.provider);
      const round = Math.max(0, ...providerFiles.map((file) => freshCache[quotaKey(file)]?.fetchedAt ?? 0));
      if (!round || routedRoundRef.current[limit.provider] === round) return [];
      routedRoundRef.current[limit.provider] = round;
      return routingPlan(routingCandidates(providerFiles, freshCache, profiles), limit.headline.label, Date.now())?.changes ?? [];
    });
    if (!due.length) return;
    routingRef.current = true;
    void applyRoutingPlan(due)
      .catch((error) => console.warn('Failed to apply the suggested routing priorities', error))
      .finally(() => {
        routingRef.current = false;
        void loadAccountFiles();
      });
  }, [coreReady, loaded, accountsError, freshLimits, files, freshCache, profiles, routingAuto]);

  // Native notifications when an account is about to reset with much of its headline limit unused, once per reset.
  useEffect(() => {
    if (!preferences.expiringNotifications || freshLimits.some((limit) => limit.loading)) return;
    const { notified, fresh, changed } = nextExpiringNotifications(expiringNotifiedRef.current, expiringCapacity(freshLimits, now), now);
    if (!changed) return;
    expiringNotifiedRef.current = notified;
    writeStored(EXPIRING_NOTIFIED_KEY, notified);
    const byProvider = new Map<QuotaProvider, ExpiringCapacity[]>();
    fresh.forEach((item) => byProvider.set(item.provider, [...(byProvider.get(item.provider) ?? []), item]));
    void notify([...byProvider].map(([provider, items]) => {
      const title = t('notifications.expiring.title', { provider: providerLabel[provider] });
      const window = lowerFirst(items[0]!.window);
      if (items.length === 1) {
        const [item] = items;
        return {
          title,
          body: t('notifications.expiring.body', { account: item!.name, percent: Math.round(item!.percent), window, time: formatResetCountdown(item!.resetAtMs, now) }),
          kind: 'expiring',
          subject: { account: item!.key },
        };
      }
      const names = items.map((item) => t('notifications.expiring.account', { account: item.name, percent: Math.round(item.percent) }));
      const accounts = t('quota.service.list', { items: names.slice(0, -1).join(', '), last: names[names.length - 1]! });
      return { title, body: t('notifications.expiring.bodyMany', { accounts, window }), kind: 'expiring', subject: { accounts: items.map((item) => item.key) } };
    }));
  }, [freshLimits, now, preferences.expiringNotifications, t]);

  // Native notifications for each new incident on a status page, once. Statuses too old to trust are left out.
  useEffect(() => {
    if (!preferences.providerStatus || !preferences.outageNotifications) return;
    const current = { claude: activeStatus(statuses.claude, now), codex: activeStatus(statuses.codex, now) };
    const { notified, fresh, changed } = nextOutageNotifications(outageNotifiedRef.current, current, now);
    if (!changed) return;
    outageNotifiedRef.current = notified;
    writeStored(OUTAGE_NOTIFIED_KEY, notified);
    void notify(fresh.slice(0, MAX_OUTAGE_NOTIFICATIONS).map((item) => outageNotification(item, t)));
  }, [statuses, now, preferences.providerStatus, preferences.outageNotifications, t]);

  return null;
}
