import { useEffect, useRef } from 'react';
import { useAppPreferences } from '../appPreferences';
import { useI18n } from '../i18n';
import { getAccountLimitPrefs, useAccountLimitPrefs } from '../services/accountLimits';
import { resolveAccountProfile, useAccountProfiles } from '../services/accountProfiles';
import {
  applyReserveSteps,
  capOf,
  getAccountReserves,
  RESERVE_WATCH_INTERVAL_MS,
  reserveNotifications,
  reservePlan,
  reserveReadingDue,
  useAccountReserves,
} from '../services/accountReserves';
import { getAccountsSnapshot, loadAccountFiles, refreshAccountQuotas, useAccountsStore } from '../services/accountsStore';
import { notify } from '../services/notify';
import { holdingReload } from '../services/reloadHolds';
import { getQuotaCacheSnapshot, useQuotaCache } from '../services/quotaCache';
import { fileName, providerForFile, quotaKey } from '../services/quotaService';
import { useQuotaClock } from '../services/quotaTime';

/**
 * Headless: keeps each account with a cap under it. An account whose limit reaches its cap is turned off in the
 * core until that limit resets, then turned back on, with an alert each way. Accounts near their cap have their
 * limits read every couple of minutes so they stop close to it. It carries on while the window is hidden.
 */
export function AccountReservesMonitor({ coreReady }: { coreReady: boolean }) {
  const { t } = useI18n();
  const { reserveAlerts } = useAppPreferences();
  const { files, disabled, loaded, error } = useAccountsStore();
  const quotas = useQuotaCache();
  const profiles = useAccountProfiles();
  const reserves = useAccountReserves();
  const { hidden } = useAccountLimitPrefs();
  // Ticks every minute, for limits that have reset.
  const clock = useQuotaClock();
  const busyRef = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;
  const alertsRef = useRef(reserveAlerts);
  alertsRef.current = reserveAlerts;

  useEffect(() => {
    if (!coreReady || !loaded || error || busyRef.current) return;
    if (!Object.keys(reserves.caps).length && !Object.keys(reserves.paused).length) return;
    const steps = reservePlan({
      state: reserves,
      enabled: files,
      disabled,
      quotas,
      hidden,
      nameFor: (key, file) => resolveAccountProfile(key, fileName(file), profiles[key]).name,
      nowMs: Date.now(),
    });
    if (!steps.length) return;
    busyRef.current = true;
    // An account is turned off in the core before its pause is saved, so the window doesn't reload between the two.
    void holdingReload('caps', () => applyReserveSteps(steps))
      .then(async ({ done, failed }) => {
        failed.forEach(({ step, error: reason }) => console.warn(`Failed to ${step.kind} an account for its cap`, reason));
        if (alertsRef.current) void notify(reserveNotifications(done, tRef.current, Date.now()));
        if (!done.some((step) => step.kind === 'pause' || step.kind === 'resume')) return;
        await loadAccountFiles();
        // An account back in use starts from a new reading.
        const resumed = new Set(done.flatMap((step) => (step.kind === 'resume' ? [step.key] : [])));
        const back = getAccountsSnapshot().files.filter((file) => resumed.has(quotaKey(file)));
        if (back.length) void refreshAccountQuotas(back);
      })
      .catch((reason) => console.warn('Failed to keep accounts under their cap', reason))
      .finally(() => {
        busyRef.current = false;
      });
  }, [coreReady, loaded, error, files, disabled, quotas, profiles, reserves, hidden, clock]);

  useEffect(() => {
    if (!coreReady) return;
    const timer = window.setInterval(() => {
      const state = getAccountReserves();
      const { caps, paused, skipUntil } = state;
      if (!Object.keys(caps).length) return;
      const nowMs = Date.now();
      const snapshot = getQuotaCacheSnapshot();
      const hiddenNow = getAccountLimitPrefs().hidden;
      const due = getAccountsSnapshot().files.filter((file) => {
        const key = quotaKey(file);
        const provider = providerForFile(file);
        const cap = capOf(state, key);
        return cap !== null && provider !== null && !paused[key] && (skipUntil[key] ?? 0) <= nowMs
          && reserveReadingDue(snapshot[key], cap, hiddenNow[provider] ?? [], nowMs);
      });
      if (due.length) void refreshAccountQuotas(due);
    }, RESERVE_WATCH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [coreReady]);

  return null;
}
