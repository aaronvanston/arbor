import { Component, type ErrorInfo, type ReactNode } from 'react';
import { TriangleAlert } from './components/ui/icons';
import { useI18n } from './i18n';
import { Button } from './components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyMedia, EmptyTitle } from './components/ui/empty';
import { CopyReportButton, lastShownPageId, withComponentStack, type Crash } from './components/ErrorBoundaries';
import { describeError } from './services/errorReport';
import { reportException } from './services/productAnalytics';
import { useMacTitleBar } from './services/windowChrome';

type Props = { children: ReactNode };
type State = { crash: Crash | null; pageId: string | null };

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { crash: null, pageId: null };

  static getDerivedStateFromError(error: unknown): State {
    return { crash: { error, at: new Date(), componentStack: '' }, pageId: lastShownPageId() };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Arbor render failure', error, info.componentStack);
    reportException('app', error, this.state.pageId);
    this.setState(withComponentStack(info));
  }

  override render() {
    if (!this.state.crash) return this.props.children;
    return <AppErrorFallback crash={this.state.crash} pageId={this.state.pageId} />;
  }
}

/** Everything under the app is gone, background monitors included, so it says what has stopped. */
export function AppErrorFallback({ crash, pageId }: { crash: Crash; pageId: string | null }) {
  const { t } = useI18n();
  const macTitleBar = useMacTitleBar();
  const message = describeError(crash.error).message || t('error.unknown');
  return (
    // With the sidebar and top bars gone, the Mac window drags by its background.
    <main className="flex h-full items-center justify-center bg-background text-foreground" data-tauri-drag-region={macTitleBar ? 'true' : undefined}>
      <Empty>
        <EmptyMedia>
          <TriangleAlert />
        </EmptyMedia>
        <div>
          <EmptyTitle>{t('error.render.title')}</EmptyTitle>
          <EmptyDescription>{t('error.app.description')}</EmptyDescription>
        </div>
        <EmptyContent>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => window.location.reload()}>{t('error.reload')}</Button>
            <CopyReportButton crash={crash} pageId={pageId} />
          </div>
          <p className="line-clamp-3 font-mono text-xs break-all text-muted-foreground" title={message}>{message}</p>
        </EmptyContent>
      </Empty>
    </main>
  );
}
