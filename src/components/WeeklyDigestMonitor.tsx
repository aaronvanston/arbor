import { useEffect, useRef } from 'react';
import { useAppPreferences } from '../appPreferences';
import { useI18n } from '../i18n';
import { getAccountLimitPrefs } from '../services/accountLimits';
import { getAccountOrder } from '../services/accountOrder';
import { getAccountProfiles } from '../services/accountProfiles';
import { getAccountsSnapshot } from '../services/accountsStore';
import { capacityReport, longLimitWindows } from '../services/capacityReport';
import { notify } from '../services/notify';
import { getPlanCosts } from '../services/planCosts';
import { getQuotaCacheSnapshot } from '../services/quotaCache';
import { quotaKey } from '../services/quotaService';
import { digestNotification, dueDigestWeek, lastDigestSent, loadWeeklyDigest, markDigestSent, weeklyDigest } from '../services/weeklyDigest';

/** How often it looks at the clock. The digest itself is only loaded when it's due. */
const CHECK_INTERVAL_MS = 15 * 60_000;
/**
 * Right after the app starts the accounts' limits are still loading, and the digest's limits come from them. A due
 * digest waits for them, looking again this often, for this long at most.
 */
const LIMITS_RETRY_MS = 30_000;
const LIMITS_WAIT_MS = 10 * 60_000;

/** Whether every account has reported its limits, or failed to. */
const limitsLoaded = () => {
  const { loaded, error, files } = getAccountsSnapshot();
  if (!loaded || error) return false;
  const quotas = getQuotaCacheSnapshot();
  return files.every((file) => {
    const status = quotas[quotaKey(file)]?.status;
    return status === 'success' || status === 'error';
  });
};

/**
 * Headless: when the weekly digest is on, sends the week before's on Monday morning, or at the first check after
 * when the app wasn't running then. A week missed entirely is skipped: only the latest goes out.
 */
export function WeeklyDigestMonitor() {
  const { t } = useI18n();
  const { weeklyDigest: enabled } = useAppPreferences();
  const textRef = useRef({ t });
  textRef.current = { t };

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let timer: number | undefined;
    // When the digest was first found due without the limits loaded.
    let waitingSinceMs: number | null = null;
    const checkIn = (ms: number) => {
      if (!disposed) timer = window.setTimeout(() => void check(), ms);
    };
    const check = async () => {
      const nowMs = Date.now();
      const week = dueDigestWeek(nowMs, lastDigestSent());
      if (!week) {
        waitingSinceMs = null;
        checkIn(CHECK_INTERVAL_MS);
        return;
      }
      waitingSinceMs ??= nowMs;
      if (!limitsLoaded() && nowMs - waitingSinceMs < LIMITS_WAIT_MS) {
        checkIn(LIMITS_RETRY_MS);
        return;
      }
      try {
        const quotas = getQuotaCacheSnapshot();
        const data = await loadWeeklyDigest(week, longLimitWindows(quotas));
        if (disposed) return;
        const providers = data.capacity
          ? capacityReport({
              data: data.capacity,
              files: getAccountsSnapshot().files,
              quotas,
              profiles: getAccountProfiles(),
              prefs: getAccountLimitPrefs(),
              order: getAccountOrder(),
              costs: getPlanCosts(),
              nowMs,
            })
          : [];
        const { t: translate } = textRef.current;
        const message = digestNotification(weeklyDigest(data, providers, nowMs), translate);
        // Marked first: a notification that fails to show isn't worth a second copy on the phone.
        markDigestSent(week.startMs);
        await notify([{ ...message, kind: 'digest' }]);
      } catch (error) {
        console.warn('Failed to send the weekly digest', error);
      }
      waitingSinceMs = null;
      checkIn(CHECK_INTERVAL_MS);
    };
    void check();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [enabled]);

  return null;
}
