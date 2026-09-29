import { useState } from 'react';
import { Download, Play, ServerCog } from './ui/icons';
import { useCoreRuntime } from '../coreRuntime';
import { useI18n } from '../i18n';
import { CORE_LOCK_PAGE, type CoreLock } from '../services/coreLock';
import { runCoreProcess } from '../services/coreProcess';
import { Page, PageBreadcrumb, PageTopbar, type PageWidth } from './layout/page';
import { Button } from './ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyMedia, EmptyTitle } from './ui/empty';
import { RefreshIcon } from './ui/refresh-icon';
import { Spinner } from './ui/spinner';

/**
 * Shown in place of a page that needs the core while the core isn't answering: which page, why it can't show, and the
 * one thing that gets it going. Start core goes through the same service as the Home page's button and the search
 * palette. The page keeps its place in the history, so it opens right here once the core answers.
 */
export function CoreLockedPage({ lock, statusError, segments, page, width, onInstall }: {
  lock: CoreLock;
  /** Why the core's status couldn't be read, for `unreadable`. */
  statusError: string;
  /** The page's breadcrumb, as it reads once the page opens. */
  segments: string[];
  /** The page's name, for the title. */
  page: string;
  width: PageWidth;
  /** Opens Settings › Updates, where the core is installed. */
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const { publishStatus, refreshStatus } = useCoreRuntime();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { title, description, action } = CORE_LOCK_PAGE[lock];

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      setError((await runCoreProcess('start_core_process', { publishStatus, refreshStatus })) ?? '');
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    setBusy(true);
    try {
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page width={width}>
      <PageTopbar>
        <PageBreadcrumb segments={segments} />
      </PageTopbar>
      {/* Lifted by the top bar's height, so it sits in the middle of the window rather than of the area under the bar. */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto pb-[var(--workspace-topbar-height)]" data-slot="core-locked">
        <Empty>
          <EmptyMedia>{action === null ? <Spinner /> : <ServerCog />}</EmptyMedia>
          <div>
            <EmptyTitle>{t(title, { page })}</EmptyTitle>
            <EmptyDescription>{t(description, { page, error: statusError })}</EmptyDescription>
          </div>
          {action ? (
            <EmptyContent>
              {action === 'start' ? (
                <Button onClick={() => void start()} disabled={busy}>
                  {busy ? <Spinner /> : <Play />}
                  {busy ? t('app.coreLocked.starting') : t('app.coreLocked.start')}
                </Button>
              ) : action === 'install' ? (
                <Button onClick={onInstall}>
                  <Download />
                  {t('app.coreLocked.install')}
                </Button>
              ) : (
                <Button variant="outline" onClick={() => void check()} disabled={busy}>
                  <RefreshIcon refreshing={busy} />
                  {busy ? t('app.coreLocked.checking') : t('app.coreLocked.check')}
                </Button>
              )}
              {error ? <p role="alert" className="text-error-foreground">{t('app.coreLocked.startFailed', { error })}</p> : null}
            </EmptyContent>
          ) : null}
        </Empty>
      </div>
    </Page>
  );
}
