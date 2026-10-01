import { use, useMemo, type ReactNode } from 'react';
import { CodeView, type CodeViewItem, type CodeViewReactOptions } from '@pierre/diffs/react';
import { useI18n } from '../i18n';
import { buildFileDiff, FOLD_STEP } from '../services/fileDiff';
import { useDiffStyle } from '../services/fileView';
import { highlightLanguage } from '../services/highlightLanguages';
import { useAppliedTheme } from '../theme';
import { arborCSS, HIGHLIGHTER, highlightersReady, labelFolds, THEMES } from './CodeDiff';

/** One file's two copies; a null side hasn't the file. */
export type ChangedFile = { path: string; before: string | null; after: string | null };

/**
 * Several files' changes one after another, diffshub's way: each under a header naming it with its counts, drawn as
 * they scroll into view, so a commit of many files stays quick. `renderActions` adds controls to a file's header.
 * Changes that only touch line endings are left out.
 */
export function CodeChanges({ files, renderActions, header }: {
  files: readonly ChangedFile[];
  renderActions?: (path: string) => ReactNode;
  /** Shown above the first file, and scrolled with them. */
  header?: ReactNode;
}) {
  const { t } = useI18n();
  const theme = useAppliedTheme();
  const style = useDiffStyle();
  const items = useMemo(() => files.flatMap((file): CodeViewItem<undefined>[] => {
    const built = buildFileDiff(file.path, file.before, file.after);
    if (built.kind === 'same') return [];
    return [{ id: file.path, type: 'diff', fileDiff: { ...built.diff, lang: highlightLanguage(file.path) } }];
  }), [files]);
  const options = useMemo((): CodeViewReactOptions<undefined, undefined> => ({
    diffStyle: style,
    theme: THEMES,
    themeType: theme,
    preferredHighlighter: HIGHLIGHTER,
    diffIndicators: 'classic',
    lineDiffType: 'word-alt',
    overflow: 'wrap',
    expansionLineCount: FOLD_STEP,
    stickyHeaders: true,
    layout: { paddingTop: 0, paddingBottom: 12, gap: 12 },
    unsafeCSS: arborCSS(t),
    onPostRender: (host: HTMLElement) => labelFolds(host, t),
  }), [style, theme, t]);
  // Every file's language is loaded before the first draws, as one diff's is.
  use(highlightersReady(files.map((file) => file.path)));
  return (
    <CodeView
      items={items}
      options={options}
      className="h-full"
      renderHeaderMetadata={renderActions ? (item) => renderActions(item.id) : undefined}
      renderCodeViewHeader={header ? () => header : undefined}
    />
  );
}
