import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invokeCommand } from '../native/commands';
import { Check, Copy, RotateCcw, TriangleAlert } from './ui/icons';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { useI18n } from '../i18n';
import { buildErrorReport, describeError } from '../services/errorReport';
import { monitorCrashStreak, monitorRetryDelay } from '../services/monitorRetry';
import { reportException } from '../services/productAnalytics';
import { useMacTitleBar } from '../services/windowChrome';
import { Button } from './ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyMedia, EmptyTitle } from './ui/empty';

/** A caught render error, with what a report needs about it. */
export type Crash = { error: unknown; at: Date; componentStack: string };

// The page last on screen, so a crash outside the pages can still say where the user was.
let shownPageId: string | null = null;
export const lastShownPageId = () => shownPageId;

/** Stamps a crash with its component stack once React hands it over in componentDidCatch. */
export const withComponentStack = (info: ErrorInfo) => (state: { crash: Crash | null }) =>
  state.crash ? { crash: { ...state.crash, componentStack: info.componentStack ?? '' } } : null;

type PageErrorBoundaryProps = {
  pageId: string;
  /** Starts the page over when it changes, as choosing the page again does. */
  resetKey?: unknown;
  children: ReactNode;
};
type PageErrorBoundaryState = { crash: Crash | null; pageId: string; resetKey: unknown };

/** Keeps a crash on one page to that page: the sidebar and background work carry on, and another page starts fresh. */
export class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  override state: PageErrorBoundaryState = { crash: null, pageId: this.props.pageId, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: PageErrorBoundaryProps, state: PageErrorBoundaryState): Partial<PageErrorBoundaryState> | null {
    if (props.pageId === state.pageId && props.resetKey === state.resetKey) return null;
    return { crash: null, pageId: props.pageId, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: unknown): Partial<PageErrorBoundaryState> {
    return { crash: { error, at: new Date(), componentStack: '' } };
  }

  override componentDidMount() {
    shownPageId = this.props.pageId;
  }

  override componentDidUpdate() {
    shownPageId = this.props.pageId;
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`Arbor page ${this.props.pageId} failed to render`, error, info.componentStack);
    reportException('page', error, this.props.pageId);
    this.setState(withComponentStack(info));
  }

  override render() {
    const { crash } = this.state;
    if (!crash) return this.props.children;
    return <PageErrorFallback crash={crash} pageId={this.state.pageId} onRetry={() => this.setState({ crash: null })} />;
  }
}

function PageErrorFallback({ crash, pageId, onRetry }: { crash: Crash; pageId: string; onRetry: () => void }) {
  const { t } = useI18n();
  const macTitleBar = useMacTitleBar();
  const { message } = describeError(crash.error);
  return (
    // The crashed page's top bar went with it, so the Mac window drags by the page's background. `true`, not `deep`:
    // only a press on the background itself drags, so Retry and Copy report still click.
    <div className="flex h-full items-center justify-center" data-tauri-drag-region={macTitleBar ? 'true' : undefined}>
      <Empty>
        <EmptyMedia>
          <TriangleAlert />
        </EmptyMedia>
        <div>
          <EmptyTitle>{t('error.page.title')}</EmptyTitle>
          <EmptyDescription>{t('error.page.description')}</EmptyDescription>
        </div>
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={onRetry}>
              <RotateCcw />
              {t('error.page.retry')}
            </Button>
            <CopyReportButton crash={crash} pageId={pageId} />
          </div>
          {message ? <p className="line-clamp-3 font-mono text-xs break-all text-muted-foreground" title={message}>{message}</p> : null}
        </EmptyContent>
      </Empty>
    </div>
  );
}

type MonitorBoundaryProps = {
  /** Named in the console when it crashes. */
  name: string;
  onCrash?: () => void;
  children: ReactNode;
};

/**
 * Keeps a crash in one background monitor from taking the app down with it. The monitor goes quiet, its error goes
 * to the console, and it starts again after a wait that grows while it keeps crashing, so the automation resumes.
 */
export class MonitorBoundary extends Component<MonitorBoundaryProps, { crashed: boolean }> {
  override state = { crashed: false };
  private crashes = 0;
  private startedAt = Date.now();
  private retryAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    this.crashes = monitorCrashStreak(this.crashes, Date.now() - this.startedAt);
    const delay = monitorRetryDelay(this.crashes);
    console.error(`Arbor ${this.props.name} crashed; starting it again in ${Math.round(delay / 1_000)} s`, error, info.componentStack);
    this.props.onCrash?.();
    reportException('monitor', error, shownPageId);
    this.retryAt = Date.now() + delay;
    this.scheduleRetry();
  }

  // StrictMode's practice unmount right after a crash on first mount clears the timer, so pick the wait back up.
  override componentDidMount() {
    if (this.state.crashed) this.scheduleRetry();
  }

  override componentWillUnmount() {
    clearTimeout(this.retryTimer);
  }

  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.startedAt = Date.now();
      this.setState({ crashed: false });
    }, Math.max(0, this.retryAt - Date.now()));
  }

  override render() {
    return this.state.crashed ? null : this.props.children;
  }
}

// Read when the fallback appears, so copying stays inside the click the clipboard needs.
function useReportVersions() {
  const [versions, setVersions] = useState<{ appVersion: string | null; coreVersion: string | null }>({ appVersion: null, coreVersion: null });
  useEffect(() => {
    let disposed = false;
    void Promise.all([
      getVersion().catch(() => null),
      invokeCommand('get_core_status').then((status) => status?.currentVersion ?? null).catch(() => null),
    ]).then(([appVersion, coreVersion]) => {
      if (!disposed) setVersions({ appVersion, coreVersion });
    });
    return () => {
      disposed = true;
    };
  }, []);
  return versions;
}

/**
 * Copies a plain-text report of the crash, and says so on the button for a moment. On the button rather than in a
 * toast, as a crash outside the pages takes the toasts down with it.
 */
export function CopyReportButton({ crash, pageId }: { crash: Crash; pageId: string | null }) {
  const { t } = useI18n();
  const versions = useReportVersions();
  const { copy, copied, failed } = useCopyToClipboard({ inline: true });

  return (
    <Button variant="outline" onClick={() => void copy(buildErrorReport({ ...versions, ...crash, pageId }), { id: 'report' })}>
      {copied ? <Check /> : <Copy />}
      {copied ? t('error.report.copied') : failed ? t('common.copyFailed') : t('error.report.copy')}
    </Button>
  );
}
