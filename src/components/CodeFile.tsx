import { use, useMemo } from 'react';
import { Editor } from '@pierre/diffs/edit';
import { EditProvider, File, type EditorFactory, type FileOptions } from '@pierre/diffs/react';
import { useI18n } from '../i18n';
import { highlightLanguage } from '../services/highlightLanguages';
import { useAppliedTheme } from '../theme';
import { arborCSS, HIGHLIGHTER, highlighterReady, THEMES } from './CodeDiff';

const createEditor: EditorFactory<undefined, undefined> = (type, options, key) => new Editor(type, options, key);

/** Markdown and plain text read better wrapped; code keeps its lines and scrolls. */
const wraps = (path: string) => /\.(md|markdown|txt)$/i.test(path) || !path.includes('.');

/**
 * One file, drawn by `@pierre/diffs`: highlighted by its type, and while `editing`, edited in place with its own undo,
 * find and replace. Each change reaches `onDraft`; the file always shows `content` once editing ends, so a save that
 * worked passes the saved text back in, and one that's dropped puts the old text back.
 */
export function CodeFile({ path, content, editing, onDraft }: {
  path: string;
  content: string;
  editing: boolean;
  onDraft?: (text: string) => void;
}) {
  const { t } = useI18n();
  const theme = useAppliedTheme();
  const file = useMemo(() => ({ name: path, contents: content, lang: highlightLanguage(path) }), [path, content]);
  const options = useMemo((): FileOptions<undefined, undefined> => ({
    theme: THEMES,
    themeType: theme,
    preferredHighlighter: HIGHLIGHTER,
    overflow: wraps(path) ? 'wrap' : 'scroll',
    disableFileHeader: true,
    unsafeCSS: arborCSS(t),
  }), [path, theme, t]);
  // Suspends to the placeholder the viewer loads behind.
  use(highlighterReady(path));
  return (
    <EditProvider createEditor={createEditor}>
      <File
        file={file}
        options={options}
        edit={editing}
        onEditChange={(event) => onDraft?.(event.file.contents)}
        onEditComplete={() => 'reject'}
      />
    </EditProvider>
  );
}
