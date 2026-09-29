import { Component, lazy, Suspense, type ReactNode } from 'react';
import { Columns2, Eye, FileCode, Rows2 } from './ui/icons';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { canPreview, setDiffStyle, useDiffStyle, type DiffStyle, type FileView } from '../services/fileView';
import { Skeleton } from './ui/skeleton';
import { Toggle, ToggleGroup } from './ui/toggle-group';

type ChunkWindow = Window & { __mockChunkDelayMs?: number; __mockChunkFail?: string };

// The browser mock's `?chunks=slow` holds the viewers back, so the placeholder shown while they load can be seen, and
// its `?chunks=fail` has them fail to load, so what shows in their place can be.
const mockable = <T,>(load: () => Promise<T>) => () => {
  const mock = import.meta.env.DEV ? (window as ChunkWindow) : null;
  if (mock?.__mockChunkFail) return Promise.reject(new TypeError(mock.__mockChunkFail));
  const delay = mock?.__mockChunkDelayMs ?? 0;
  return delay ? new Promise<void>((resolve) => window.setTimeout(resolve, delay)).then(load) : load();
};

// Both bring in large libraries (the highlighter, the markdown parser), so they load the first time a file is shown.
const CodeDiff = lazy(mockable(() => import('./CodeDiff').then((module) => ({ default: module.CodeDiff }))));
const MarkdownPreview = lazy(mockable(() => import('./MarkdownPreview').then((module) => ({ default: module.MarkdownPreview }))));

const isDiffStyle = (value: unknown): value is DiffStyle => value === 'unified' || value === 'split';
const isFileView = (value: unknown): value is FileView => value === 'source' || value === 'preview';

/** One column or side by side, for every diff at once. */
export function DiffStyleToggle() {
  const { t } = useI18n();
  const style = useDiffStyle();
  return (
    <ToggleGroup
      value={[style]}
      aria-label={t('fileView.diffStyle')}
      onValueChange={(values) => {
        const next = values[0];
        if (isDiffStyle(next)) setDiffStyle(next);
      }}
    >
      <Toggle value="unified" title={t('fileView.unifiedTitle')} aria-label={t('fileView.unified')}>
        <Rows2 aria-hidden="true" />
      </Toggle>
      <Toggle value="split" title={t('fileView.splitTitle')} aria-label={t('fileView.split')}>
        <Columns2 aria-hidden="true" />
      </Toggle>
    </ToggleGroup>
  );
}

/** Source changes or the rendered copies, for a file that can be previewed. */
export function FileViewToggle({ value, onChange }: { value: FileView; onChange: (view: FileView) => void }) {
  const { t } = useI18n();
  return (
    <ToggleGroup
      value={[value]}
      aria-label={t('fileView.label')}
      onValueChange={(values) => {
        const next = values[0];
        if (isFileView(next)) onChange(next);
      }}
    >
      <Toggle value="preview" title={t('fileView.previewTitle')}>
        <Eye aria-hidden="true" />
        {t('fileView.preview')}
      </Toggle>
      <Toggle value="source" title={t('fileView.sourceTitle')}>
        <FileCode aria-hidden="true" />
        {t('fileView.source')}
      </Toggle>
    </ToggleGroup>
  );
}

/** What each copy is called over it: a machine's pill, a home, or that it hasn't the file. */
export type CopyLabels = { before: ReactNode; after: ReactNode };

/**
 * Which color is which copy, then the controls: Preview and Source when `path` is a file that can be previewed,
 * and the layout for every diff.
 */
export function ChangesHeader({ before, after, path, view, onView }: CopyLabels & {
  path?: string;
  view?: FileView;
  onView?: (view: FileView) => void;
}) {
  const { t } = useI18n();
  // A screen reader hears each line as removed or added, so the copies are named the same way.
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden="true" className="font-mono text-error-foreground">−</span>
        <span className="truncate"><span className="sr-only">{t('fileView.line.removed')}</span>{before}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden="true" className="font-mono text-success-foreground">+</span>
        <span className="truncate"><span className="sr-only">{t('fileView.line.added')}</span>{after}</span>
      </span>
      <div className="ms-auto flex items-center gap-2">
        {path && view && onView && canPreview(path) ? <FileViewToggle value={view} onChange={onView} /> : null}
        <DiffStyleToggle />
      </div>
    </div>
  );
}

/** Stands in for a viewer while its code loads. */
export function ViewerSkeleton() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 px-3 py-3" role="status" aria-label={t('fileView.loading')}>
      {['w-2/3', 'w-5/6', 'w-1/2', 'w-3/4'].map((width) => <Skeleton key={width} className={cn('h-3', width)} />)}
    </div>
  );
}

function ViewerFailed({ error }: { error: unknown }) {
  const { t } = useI18n();
  return <p className="text-xs text-error-foreground" role="alert">{t('fileView.failed', { error: String(error) })}</p>;
}

/** A viewer that fails to load or draw says so in its place, rather than taking the page with it. */
class ViewerBoundary extends Component<{ children: ReactNode }, { failure: { error: unknown } | null }> {
  override state: { failure: { error: unknown } | null } = { failure: null };

  static getDerivedStateFromError(error: unknown) {
    return { failure: { error } };
  }

  override render() {
    return this.state.failure ? <ViewerFailed error={this.state.failure.error} /> : this.props.children;
  }
}

/**
 * A file's changes from `before` to `after` (null for a copy that isn't there), or with `view` of `preview`, each
 * copy rendered, side by side in the split layout. Contents are passed in and kept only while it's shown.
 */
export function FileChanges({ path, before, after, labels, view = 'source' }: {
  path: string;
  before: string | null;
  after: string | null;
  labels: CopyLabels;
  view?: FileView;
}) {
  const style = useDiffStyle();
  const previewing = view === 'preview' && canPreview(path);
  const copies = [
    { side: 'before' as const, label: labels.before, text: before },
    { side: 'after' as const, label: labels.after, text: after },
  ].filter((copy): copy is { side: 'before' | 'after'; label: ReactNode; text: string } => copy.text !== null);
  return (
    <ViewerBoundary key={`${path}:${previewing ? 'preview' : 'source'}`}>
      <Suspense fallback={<ViewerSkeleton />}>
        {previewing ? (
          <div className="@container">
            <div className={cn('grid gap-3', style === 'split' && copies.length > 1 && '@2xl:grid-cols-2')}>
              {copies.map((copy) => (
                <section key={copy.side} className="min-w-0 overflow-hidden rounded-lg border border-border/60 bg-background">
                  <h4 className="flex items-center gap-1.5 border-b border-border/50 px-3 py-1.5 text-xs font-normal text-muted-foreground">
                    <span aria-hidden="true" className={cn('font-mono', copy.side === 'before' ? 'text-error-foreground' : 'text-success-foreground')}>
                      {copy.side === 'before' ? '−' : '+'}
                    </span>
                    <span className="truncate">{copy.label}</span>
                  </h4>
                  <div className="px-4 py-3">
                    <MarkdownPreview source={copy.text} />
                  </div>
                </section>
              ))}
            </div>
          </div>
        ) : (
          <CodeDiff path={path} before={before} after={after} style={style} />
        )}
      </Suspense>
    </ViewerBoundary>
  );
}
