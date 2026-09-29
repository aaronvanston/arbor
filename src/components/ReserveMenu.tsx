import { Gauge, TriangleAlert } from './ui/icons';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { useAccountLimitPrefs } from '../services/accountLimits';
import {
  RESERVE_CAPS,
  resumesWithCap,
  setAccountReserve,
  useAccountReserves,
  useReserveFailures,
  type PausedAccount,
} from '../services/accountReserves';
import { formatResetCountdown } from '../services/providerLimits';
import { useQuotaCache } from '../services/quotaCache';
import { useQuotaClock } from '../services/quotaTime';
import { chipVariants } from './ui/chip';
import { Menu, MenuGroupLabel, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuSubTrigger, MenuTrigger } from './ui/menu';

/**
 * An account's cap, whether Arbor failed to act on it, and how long until the limit resets when it was turned back on
 * early, which Arbor leaves it on for.
 */
function useReserve(accountKey: string) {
  const now = useQuotaClock();
  const reserves = useAccountReserves();
  const failure = useReserveFailures()[accountKey];
  const cap = reserves.caps[accountKey] ?? null;
  const skipUntilMs = reserves.skipUntil[accountKey];
  const skipped = skipUntilMs !== undefined ? formatResetCountdown(skipUntilMs, now) : '';
  return { cap, failure, skipped };
}

/**
 * How much of each limit the proxy may use before Arbor pauses the account until that limit resets, as a chip in the
 * account's name line. On an account that's paused it marks the choices that bring it straight back. Without a cap it
 * shows nothing unless `always`; the account's ⋯ menu sets one.
 */
export function ReserveMenu({ accountKey, name, paused, always = false }: {
  accountKey: string;
  name: string;
  /** Set while Arbor has the account paused at its cap. */
  paused?: PausedAccount;
  /** Shows the chip without a cap too, as just its icon. */
  always?: boolean;
}) {
  const { t } = useI18n();
  const { cap, failure, skipped } = useReserve(accountKey);
  if (cap === null && !failure && !always) return null;
  const hint = failure
    ? t('reserves.failed', { error: failure })
    : cap === null
      ? t('reserves.set', { name })
      : [t('reserves.capHint', { percent: cap }), skipped ? t('reserves.skipped', { time: skipped }) : ''].filter(Boolean).join(' ');
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            className={chipVariants({ tone: failure ? 'warning' : 'default' })}
            aria-label={cap === null ? t('reserves.set', { name }) : t('reserves.change', { name, percent: cap })}
            title={hint}
          />
        }
      >
        {failure ? <TriangleAlert /> : <Gauge />}
        {cap !== null ? t('reserves.chip', { percent: cap }) : null}
      </MenuTrigger>
      <MenuPopup className="w-72">
        <ReserveChoices accountKey={accountKey} paused={paused} />
      </MenuPopup>
    </Menu>
  );
}

/** The cap as an item of another menu, saying what it's set to, with the choices in a menu of its own to the side. */
export function ReserveSubmenu({ accountKey, paused }: { accountKey: string; paused?: PausedAccount }) {
  const { t } = useI18n();
  const { cap, failure } = useReserve(accountKey);
  return (
    <MenuSub>
      <MenuSubTrigger>
        {failure ? <TriangleAlert className="text-warning-foreground" /> : <Gauge />}
        <span className="min-w-0 flex-1 truncate">{t('authFiles.menu.cap')}</span>
        <span className={cn('shrink-0 text-xs', failure ? 'text-warning-foreground' : 'text-muted-foreground')}>
          {cap === null ? t('reserves.none') : t('reserves.cap', { percent: cap })}
        </span>
      </MenuSubTrigger>
      <MenuPopup className="w-72" side="inline-end" align="start" sideOffset={6}>
        <ReserveChoices accountKey={accountKey} paused={paused} />
      </MenuPopup>
    </MenuSub>
  );
}

/** The cap's choices, then what the account's cap is doing and what a cap does. */
function ReserveChoices({ accountKey, paused }: { accountKey: string; paused?: PausedAccount }) {
  const { t } = useI18n();
  const now = useQuotaClock();
  const { cap, failure, skipped } = useReserve(accountKey);
  const quota = useQuotaCache()[accountKey];
  const { hidden } = useAccountLimitPrefs();
  const resumes = (option: number | null) =>
    paused !== undefined && option !== cap && resumesWithCap(paused, quota, option, hidden[paused.provider] ?? [], now);
  return (
    <>
      <MenuRadioGroup value={cap} onValueChange={(option: number | null) => setAccountReserve(accountKey, option)}>
        <MenuGroupLabel>{t('reserves.menu.title')}</MenuGroupLabel>
        {[null, ...RESERVE_CAPS].map((option) => (
          <MenuRadioItem key={option ?? 'off'} value={option} closeOnClick>
            <span className="min-w-0 flex-1 truncate">{option === null ? t('reserves.menu.off') : t('reserves.menu.option', { percent: option })}</span>
            {resumes(option) ? <span className="shrink-0 text-xs text-muted-foreground">{t('reserves.menu.resumes')}</span> : null}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      {failure ? <p className="px-2 pt-1.5 text-xs text-warning-foreground">{t('reserves.failed', { error: failure })}</p> : null}
      {paused ? (
        <p className="px-2 pt-1.5 text-xs text-foreground">
          {t('reserves.menu.paused', { window: paused.window.charAt(0).toLowerCase() + paused.window.slice(1) })}
        </p>
      ) : skipped && cap !== null ? (
        <p className="px-2 pt-1.5 text-xs text-foreground">{t('reserves.skipped', { time: skipped })}</p>
      ) : null}
      <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('reserves.menu.hint')}</p>
    </>
  );
}
