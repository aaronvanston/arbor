import { useCallback, useEffect, useRef, useState } from 'react';
import { invokeCommand } from '../native/commands';
import { listen } from '@tauri-apps/api/event';
import { Shrink } from '../components/ui/icons';
import { InlineNotice, useAppNotice } from '../appNotice';
import { useConfirmation } from '../components/ConfirmationDialog';
import { SettingsBlock, SettingsRow, SettingsSection } from '../components/layout/settings';
import { StatBlock } from '../components/layout/stats';
import { Button } from '../components/ui/button';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '../components/ui/spinner';
import { useI18n } from '../i18n';
import { formatDate, formatNumber } from '../lib/format';
import { formatBytes } from '../services/machineHealth';
import {
  compactionSpaceNeeded,
  describeRetentionChange,
  retentionOptions,
  usageDatabaseBytes,
} from '../services/usageStorage';
import type { UsageStorageInfo } from '../native/types';

/** Settings › Data: how much space usage history takes, how long it is kept, and compaction. */
export function UsageStorageSection() {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const feedback = useAppNotice();
  const [info, setInfo] = useState<UsageStorageInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  // The retention being previewed or saved. The select shows it until the change is confirmed or canceled.
  const [pendingRetention, setPendingRetention] = useState<number | null>(null);
  const [compacting, setCompacting] = useState(false);
  const busy = pendingRetention !== null || compacting;
  const retentionTriggerRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    try {
      setInfo(await invokeCommand('get_usage_storage_info'));
      setLoadError('');
    } catch (error) {
      setLoadError(String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // New records and the hourly retention pass both change these numbers. Events can arrive several
  // a second, so gather them into one refresh; a retention change or compaction refreshes when it ends.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let timer: number | undefined;
    const scheduleRefresh = () => {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        if (!disposed && !document.hidden && !busyRef.current) void refresh();
      }, 2_000);
    };
    listen('usage-records-updated', scheduleRefresh)
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refresh]);

  const retentionLabel = (days: number) =>
    days > 0 ? t('usage.storage.retention.days', { count: formatNumber(days) }) : t('usage.storage.retention.forever');

  const changeRetention = async (days: number) => {
    if (!info || busy || days === info.retentionDays) return;
    setPendingRetention(days);
    feedback.clearNotice();
    try {
      const preview = await invokeCommand('set_usage_retention', { retentionDays: days, dryRun: true });
      const change = describeRetentionChange(days, preview.recordsAffected);
      const confirmed = await askConfirmation(
        change.kind === 'delete'
          ? {
              title: t('usage.storage.retention.deleteTitle'),
              message: t('usage.storage.retention.deleteMessage', { count: formatNumber(change.count), days: formatNumber(days) }),
              confirmText: t('usage.storage.retention.deleteConfirm'),
              variant: 'danger',
            }
          : {
              title: t('usage.storage.retention.changeTitle'),
              message:
                change.kind === 'forever'
                  ? t('usage.storage.retention.foreverMessage')
                  : t('usage.storage.retention.keepMessage', { days: formatNumber(days) }),
              confirmText: t('common.save'),
            },
      );
      if (!confirmed) return;
      const saved = await invokeCommand('set_usage_retention', { retentionDays: days, dryRun: false });
      // Show the saved value straight away; the refresh below fills in the new counts.
      setInfo((current) => (current ? { ...current, retentionDays: saved.retentionDays } : current));
      if (saved.retentionDays <= 0) {
        feedback.showNotice({ key: 'usage.storage.retention.savedForever' });
      } else if (saved.recordsAffected > 0) {
        feedback.showNotice({
          key: 'usage.storage.retention.savedDeleted',
          variables: { count: formatNumber(saved.recordsAffected), days: formatNumber(saved.retentionDays) },
        });
      } else {
        feedback.showNotice({ key: 'usage.storage.retention.saved', variables: { days: formatNumber(saved.retentionDays) } });
      }
    } catch (error) {
      feedback.showNotice({ key: 'usage.storage.retention.failed', variables: { error: String(error) } }, 'error');
    } finally {
      setPendingRetention(null);
      // The option picked is gone by the time the confirmation closes, so focus would drop to the page.
      if (document.activeElement === document.body) retentionTriggerRef.current?.focus();
      await refresh();
    }
  };

  const compact = async () => {
    if (!info || busy) return;
    feedback.clearNotice();
    const confirmed = await askConfirmation({
      title: t('usage.storage.compact.confirmTitle'),
      message: t('usage.storage.compact.confirmMessage'),
      details: [
        { label: t('usage.storage.databaseSize'), value: formatBytes(usageDatabaseBytes(info)) },
        { label: t('usage.storage.reclaimable'), value: formatBytes(info.freeBytes) },
        { label: t('usage.storage.compact.spaceNeeded'), value: formatBytes(compactionSpaceNeeded(info)) },
      ],
      warning: t('usage.storage.compact.pauseWarning'),
      confirmText: t('usage.storage.compact.run'),
    });
    if (!confirmed) return;
    setCompacting(true);
    try {
      const result = await invokeCommand('compact_usage_database');
      feedback.showNotice({
        key: result.shrinkPending ? 'usage.storage.compact.donePending' : 'usage.storage.compact.done',
        variables: { before: formatBytes(result.bytesBefore), after: formatBytes(result.bytesAfter) },
      });
    } catch (error) {
      feedback.showNotice({ key: 'usage.storage.compact.failed', variables: { error: String(error) } }, 'error');
    } finally {
      setCompacting(false);
      await refresh();
    }
  };

  const stat = (value: (current: UsageStorageInfo) => string) =>
    info ? value(info) : loadError ? '—' : <Skeleton className="mt-1.5 h-5 w-16" />;
  const oldest = (current: UsageStorageInfo) => {
    const date = current.oldestTimestamp ? new Date(current.oldestTimestamp) : null;
    if (!date) return '—';
    if (Number.isNaN(date.getTime())) return current.oldestTimestamp ?? '—';
    return formatDate(date, { year: 'always' });
  };
  const selectedRetention = pendingRetention ?? info?.retentionDays ?? 0;

  return (
    <>
      <SettingsSection title={t('usage.storage.title')} description={t('usage.storage.description')} className="max-w-4xl">
        <div className="grid grid-cols-4 divide-x divide-border/60">
          <StatBlock label={t('usage.storage.databaseSize')} value={stat((current) => formatBytes(usageDatabaseBytes(current)))} />
          <StatBlock
            label={t('usage.storage.reclaimable')}
            value={stat((current) => formatBytes(current.freeBytes))}
            hint={t('usage.storage.reclaimableHint')}
          />
          <StatBlock label={t('usage.storage.records')} value={stat((current) => formatNumber(current.recordCount))} />
          <StatBlock label={t('usage.storage.oldest')} value={stat(oldest)} />
        </div>
        <SettingsRow
          settingId="data.retention"
          title={t('usage.storage.retention.title')}
          description={t('usage.storage.retention.description')}
          control={
            <>
              {pendingRetention !== null ? <Spinner className="text-muted-foreground" /> : null}
              {/* Stays enabled while a change is pending so it can take focus back; changeRetention ignores
                  picks until that change finishes. */}
              <Select
                value={String(selectedRetention)}
                disabled={!info || compacting}
                onValueChange={(value) => {
                  if (value !== null && value !== undefined) void changeRetention(Number(value));
                }}
              >
                <SelectTrigger
                  ref={retentionTriggerRef}
                  size="sm"
                  className="w-auto min-w-36"
                  aria-label={t('usage.storage.retention.title')}
                >
                  <SelectValue>{retentionLabel(selectedRetention)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end">
                  {retentionOptions(info?.retentionDays ?? 0).map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      {retentionLabel(days)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </>
          }
        />
        <SettingsRow
          settingId="data.compact"
          title={t('usage.storage.compact.title')}
          description={t('usage.storage.compact.description')}
          control={
            <Button variant="outline" size="sm" onClick={() => void compact()} disabled={!info || busy}>
              {compacting ? <Spinner /> : <Shrink />}
              {compacting ? t('usage.storage.compact.running') : t('usage.storage.compact.run')}
            </Button>
          }
        />
        {loadError || feedback.notice ? (
          <SettingsBlock className="flex flex-col gap-2">
            {loadError ? (
              <div className="flex items-start gap-2">
                <InlineNotice
                  className="flex-1"
                  notice={{ owner: 'usage-storage', message: { key: 'usage.storage.loadFailed', variables: { error: loadError } }, tone: 'error' }}
                />
                <Button variant="outline" size="sm" onClick={() => void refresh()}>
                  {t('common.retry')}
                </Button>
              </div>
            ) : null}
            <InlineNotice key={feedback.revision} notice={feedback.notice} onDismiss={feedback.clearNotice} />
          </SettingsBlock>
        ) : null}
      </SettingsSection>
    </>
  );
}
