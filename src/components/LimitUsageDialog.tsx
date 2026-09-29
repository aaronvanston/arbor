import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import { formatCount, formatDate, formatDateTime, formatMoney, formatPercent, formatTime } from '../lib/format';
import { cn } from '../lib/utils';
import {
  limitUsage,
  limitWindowOptions,
  loadLimitCycles,
  loadLimitSessions,
  type LimitScope,
  type LimitWindowOption,
} from '../services/limitUsage';
import type { ResolvedProfile } from '../services/accountProfiles';
import type { QuotaRow } from '../services/quotaService';
import { useQuotaClock } from '../services/quotaTime';
import { AccountAvatar } from './AccountAvatar';
import { SessionLabel } from './SessionLabel';
import { StatusDot } from './ui/status-dot';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from './ui/dialog';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './ui/select';
import { Spinner } from './ui/spinner';
import type { LimitCycle, UsageSessionPage } from '../native/types';

export type LimitUsageTarget = {
  /** The account's key in the limit history. */
  account: string;
  authIndex: string;
  accountName: string;
  profile: ResolvedProfile;
  row: QuotaRow;
  scope: LimitScope;
};

/** Enough to see what used most of a window; the rest are summed up. */
const SHOWN_SESSIONS = 10;
const DAY = 86_400_000;
const familyName = (family: string) => family.charAt(0).toUpperCase() + family.slice(1);

/** Which sessions used an account's limit window, the running one or an earlier one from the limit history. */
export function LimitUsageDialog({ target, onClose, onOpenSession }: { target: LimitUsageTarget | null; onClose: () => void; onOpenSession?: (id: string) => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {target ? (
        <DialogPopup className="max-w-xl">
          <LimitUsageBody key={`${target.account}\n${target.row.label}`} target={target} onClose={onClose} onOpenSession={onOpenSession} />
        </DialogPopup>
      ) : null}
    </Dialog>
  );
}

function LimitUsageBody({ target, onClose, onOpenSession }: { target: LimitUsageTarget; onClose: () => void; onOpenSession?: (id: string) => void }) {
  const { t } = useI18n();
  const now = useQuotaClock();
  const [cycles, setCycles] = useState<LimitCycle[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<UsageSessionPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { account, authIndex, row, scope } = target;

  useEffect(() => {
    let live = true;
    loadLimitCycles(account, row.label)
      .then((next) => { if (live) setCycles(next); })
      // Earlier windows are a bonus; the running one doesn't need the history.
      .catch(() => { if (live) setCycles([]); });
    return () => { live = false; };
  }, [account, row.label]);

  const options = useMemo(
    () => limitWindowOptions(row, authIndex, cycles ?? [], scope.durationMs, now),
    [row, authIndex, cycles, scope.durationMs, now],
  );
  const option = options.find((item) => item.key === selected) ?? options[0] ?? null;
  const optionKey = option?.key;
  const optionAuthIndex = option?.authIndex;
  const optionStart = option?.span.startMs;
  // Nothing is recorded after now, so the reset bounds the running window without moving with the clock.
  const optionEnd = option ? (option.current ? option.span.resetAtMs : option.span.endMs) : undefined;

  useEffect(() => {
    if (!optionKey || !optionAuthIndex || optionStart === undefined || optionEnd === undefined) return;
    let live = true;
    setLoading(true);
    setError('');
    loadLimitSessions(optionAuthIndex, optionStart, optionEnd, scope.modelFamily)
      .then((next) => { if (live) setPage(next); })
      .catch((reason: unknown) => {
        if (!live) return;
        setPage(null);
        setError(String(reason));
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [optionKey, optionAuthIndex, optionStart, optionEnd, scope.modelFamily]);

  const usage = page ? limitUsage(page, SHOWN_SESSIONS) : null;
  const withTime = scope.durationMs < DAY;
  const startText = (ms: number) => (withTime ? formatDateTime(ms, { now }) : formatDate(ms, { now }));
  const shareText = (share: number) => (share > 0 && share < 0.005 ? t('limitUsage.shareBelow') : formatPercent(share));
  const spanText = (item: LimitWindowOption) => {
    const start = startText(item.span.startMs);
    if (item.current) return t('limitUsage.window.current', { start });
    const sameDay = new Date(item.span.startMs).toDateString() === new Date(item.span.endMs).toDateString();
    const end = withTime && sameDay ? formatTime(item.span.endMs) : startText(item.span.endMs);
    return t('limitUsage.window.span', { start, end });
  };
  const usedText = (item: LimitWindowOption) => {
    if (item.usedPercent === null) return '';
    const percent = Math.round(item.usedPercent);
    return percent >= 100 ? t('limitUsage.window.hitLimit') : t('limitUsage.window.used', { percent });
  };
  const optionText = (item: LimitWindowOption) => [spanText(item), usedText(item)].filter(Boolean).join(' · ');
  const openSession = onOpenSession
    ? (id: string) => {
      onClose();
      onOpenSession(id);
    }
    : undefined;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('limitUsage.title')}</DialogTitle>
        <DialogDescription className="flex min-w-0 items-center gap-2">
          <AccountAvatar profile={target.profile} size="xs" />
          <span className="min-w-0 truncate">{t('limitUsage.description', { account: target.accountName, window: row.label })}</span>
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-col gap-3 px-6 pb-4">
        {option && options.length > 1 ? (
          <Select value={option.key} onValueChange={(next) => setSelected(typeof next === 'string' ? next : null)}>
            <SelectTrigger size="sm" className="w-full" aria-label={t('limitUsage.window.pick')}>
              <SelectValue className="truncate">{optionText(option)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {options.map((item) => (
                <SelectItem key={item.key} value={item.key}>{optionText(item)}</SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : option ? (
          <p className="text-sm text-foreground">{optionText(option)}</p>
        ) : null}

        {error ? <Alert variant="error"><AlertDescription>{t('limitUsage.error', { error })}</AlertDescription></Alert> : null}

        {!option ? (
          cycles === null ? (
            <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner />{t('limitUsage.loading')}</div>
          ) : (
            <p className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">{t('limitUsage.noWindow')}</p>
          )
        ) : !page ? (
          loading ? <div className="flex h-32 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner />{t('limitUsage.loading')}</div> : null
        ) : page.total === 0 ? (
          <p className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">{t('limitUsage.empty')}</p>
        ) : usage ? (
          <div className={cn('flex min-h-0 flex-col gap-3 transition-opacity', loading && 'opacity-60')}>
            <dl className="grid grid-cols-3 gap-2 rounded-lg border border-border/60 px-3 py-2.5 text-xs">
              <div className="min-w-0">
                <dt className="text-muted-foreground">{t('limitUsage.stat.cost')}</dt>
                <dd className="text-sm font-semibold tabular-nums text-foreground">{formatMoney(page.summary.estimatedCost)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">{t('limitUsage.stat.sessions')}</dt>
                <dd className="text-sm font-semibold tabular-nums text-foreground">{formatCount(page.summary.sessions)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">{t('limitUsage.stat.requests')}</dt>
                <dd className="text-sm font-semibold tabular-nums text-foreground">{formatCount(page.summary.requests)}</dd>
              </div>
            </dl>
            <div className="max-h-[45vh] min-h-0 overflow-y-auto rounded-lg border border-border/60">
              <div className="flex items-center justify-between gap-3 border-b border-border/50 bg-muted/40 px-3 py-1.5 text-2xs font-medium text-muted-foreground dark:bg-input/10">
                <span>{t('limitUsage.column.session')}</span>
                <span title={t(usage.measure === 'cost' ? 'limitUsage.column.shareCostTitle' : 'limitUsage.column.shareTokensTitle')}>
                  {t(usage.measure === 'cost' ? 'limitUsage.column.shareCost' : 'limitUsage.column.shareTokens')}
                </span>
              </div>
              <ul className="divide-y divide-border/50">
                {usage.sessions.map(({ session, share }) => (
                  <li key={session.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm outline-none transition-colors enabled:cursor-pointer enabled:hover:bg-accent focus-visible:bg-accent"
                      onClick={openSession ? () => openSession(session.id) : undefined}
                      disabled={!openSession}
                      aria-label={t('limitUsage.openSession', { name: session.transcript?.title || session.id })}
                    >
                      {session.active ? <StatusDot tone="success" pulse className="shrink-0" /> : null}
                      <SessionLabel session={session} machine className="flex-1" />
                      <span className="flex w-32 shrink-0 flex-col items-end gap-1">
                        <span className="text-xs tabular-nums text-foreground">
                          {usage.measure === 'cost' ? formatMoney(session.pricedRequests ? session.estimatedCost : null) : formatCount(session.totalTokens)}
                        </span>
                        <span className="flex w-full items-center gap-2">
                          <span className="h-1 flex-1 overflow-hidden rounded-full bg-input/60 dark:bg-input">
                            <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, share * 100))}%` }} />
                          </span>
                          <span className="w-9 text-right text-2xs tabular-nums text-muted-foreground">{shareText(share)}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {usage.rest.sessions > 0 ? (
                <p className="border-t border-border/50 px-3 py-2 text-xs text-muted-foreground">
                  {t(usage.rest.sessions === 1 ? 'limitUsage.rest.one' : 'limitUsage.rest.other', { count: usage.rest.sessions, share: shareText(usage.rest.share) })}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {scope.modelFamily ? <li>{t('limitUsage.note.family', { family: familyName(scope.modelFamily) })}</li> : null}
          {page && page.summary.untrackedRequests > 0 ? (
            <li>{t(page.summary.untrackedRequests === 1 ? 'limitUsage.note.untracked.one' : 'limitUsage.note.untracked.other', { count: page.summary.untrackedRequests })}</li>
          ) : null}
          <li>{t('limitUsage.note.onlyArbor')}</li>
        </ul>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
      </DialogFooter>
    </>
  );
}
