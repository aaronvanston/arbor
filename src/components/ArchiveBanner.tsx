import { useEffect, useState } from 'react';
import { ArchiveX, HardDrive } from './ui/icons';
import { useI18n } from '../i18n';
import { formatWhen } from '../lib/format';
import { archiveStateKey, archiveTrouble, getSessionArchiveStatus } from '../services/sessionArchive';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Button } from './ui/button';
import type { ArchiveStatus } from '../native/types';

const REFRESH_MS = 30_000;

/**
 * The Sessions page's sign that the archive has stopped keeping them: its drive is away, another folder is where it
 * was, or it's failing. Shown only then, since sessions deleted meanwhile are gone for good.
 */
export function ArchiveBanner({ onOpen }: { onOpen?: () => void }) {
  const [status, setStatus] = useState<ArchiveStatus | null>(null);

  useEffect(() => {
    let canceled = false;
    const refresh = () => {
      getSessionArchiveStatus().then(
        (next) => !canceled && setStatus(next),
        (error) => console.warn('Failed to read the session archive’s status', error),
      );
    };
    refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, REFRESH_MS);
    return () => {
      canceled = true;
      window.clearInterval(timer);
    };
  }, []);

  return status ? <ArchiveBannerView status={status} onOpen={onOpen} /> : null;
}

export function ArchiveBannerView({ status, onOpen }: { status: ArchiveStatus; onOpen?: () => void }) {
  const { t } = useI18n();
  const trouble = archiveTrouble(status);
  if (!trouble) return null;
  const time = trouble.since !== null ? formatWhen(trouble.since) : null;
  const description = time === null
    ? t(`sessionArchive.stateDetail.${status.state}`)
    : trouble.kind === 'failing'
      ? t('sessionArchive.banner.failing', { time, error: status.lastError ?? t(archiveStateKey(status.state)) })
      : t(trouble.kind === 'away' ? 'sessionArchive.banner.away' : 'sessionArchive.banner.foreign', { time });
  return (
    <Alert
      variant={trouble.kind === 'away' ? 'warning' : 'error'}
      icon={trouble.kind === 'away' ? <HardDrive /> : <ArchiveX />}
      action={onOpen ? <Button variant="outline" size="xs" onClick={onOpen}>{t('sessionArchive.banner.open')}</Button> : undefined}
    >
      <AlertTitle>{t('sessionArchive.banner.title')}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
    </Alert>
  );
}
