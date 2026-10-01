import { use, useMemo } from 'react';
import { preloadHighlighter } from '@pierre/diffs';
import { FileDiff, type FileDiffOptions } from '@pierre/diffs/react';
import { useI18n } from '../i18n';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import { formatNumber } from '../lib/format';
import { highlightLanguage } from '../services/highlightLanguages';
import { buildFileDiff, FOLD_STEP, foldControlName, foldedLines, foldText, type FoldControl, type FoldText } from '../services/fileDiff';
import type { DiffStyle } from '../services/fileView';
import { useAppliedTheme } from '../theme';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

const cssString = (text: string) => `"${text.replace(/[\\"]/g, '\\$&').replace(/\n/g, ' ')}"`;

/**
 * The diff draws in its own shadow root, so the app's tokens are handed in as its custom properties. The last of its
 * style layers, so they win over the highlighting theme's. The surface, text and change colors are Arbor's; only
 * the syntax colors are the theme's. Each changed line's − or + is read out as a word, which a screen reader
 * wouldn't otherwise say, and a fold's control is ringed when it has focus.
 */
export const arborCSS = (t: Translate) => `
:host {
  --diffs-font-family: var(--font-mono);
  --diffs-header-font-family: var(--font-sans);
  --diffs-font-size: 12px;
  --diffs-line-height: 20px;
  --diffs-light-bg: var(--background);
  --diffs-dark-bg: var(--background);
  --diffs-light: var(--foreground);
  --diffs-dark: var(--foreground);
  --diffs-addition-color-override: var(--success);
  --diffs-deletion-color-override: var(--error);
  --diffs-modified-color-override: var(--info);
}
[data-indicators=classic] [data-line-type=change-deletion]:is([data-line], [data-no-newline])::before {
  content: "-" / ${cssString(t('fileView.line.removed'))};
}
[data-indicators=classic] [data-line-type=change-addition]:is([data-line], [data-no-newline])::before {
  content: "+" / ${cssString(t('fileView.line.added'))};
}
[data-expand-button]:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}`;

const FOLD = '[data-separator][data-expand-index]';
const FOLD_CONTROL = '[data-expand-button]';

const foldControl = (element: Element): FoldControl =>
  element.hasAttribute('data-expand-all-button') ? 'all'
    : element.hasAttribute('data-expand-up') ? 'up'
      : element.hasAttribute('data-expand-down') ? 'down'
        : 'both';
const foldIndex = (element: Element) => Number(element.closest(FOLD)?.getAttribute('data-expand-index'));
const say = (t: Translate, text: FoldText) => t(text.key, text.count === undefined ? undefined : { count: formatNumber(text.count) });

/** Shadow roots whose folds open from the keyboard, and the control to focus once one has redrawn after a key press. */
const keyed = new WeakSet<ShadowRoot>();
const refocus = new WeakMap<ShadowRoot, { index: number; control: FoldControl }>();

/** Enter or Space on a fold's control opens it as a click would. */
function openFoldFromKey(event: Event) {
  if (!(event instanceof KeyboardEvent) || (event.key !== 'Enter' && event.key !== ' ')) return;
  const control = event.target instanceof Element ? event.target.closest(FOLD_CONTROL) : null;
  const root = control?.getRootNode();
  if (!(control instanceof HTMLElement) || !(root instanceof ShadowRoot)) return;
  event.preventDefault();
  refocus.set(root, { index: foldIndex(control), control: foldControl(control) });
  // Pierre opens folds on a click, and redraws before this returns.
  control.click();
}

/**
 * Pierre draws a fold's controls as bare divs a pointer can open and nothing else can, and counts the lines in its
 * own English. After each render, this puts the controls in the tab order, names them, has Enter and Space open them,
 * and says the count in Arbor's words. A control that's redrawn after a key press gets focus back, or the next fold
 * does when that one opened all the way.
 */
export function labelFolds(host: HTMLElement, t: Translate) {
  const root = host.shadowRoot;
  if (!root) return;
  if (!keyed.has(root)) {
    root.addEventListener('keydown', openFoldFromKey);
    keyed.add(root);
  }
  for (const fold of root.querySelectorAll<HTMLElement>(FOLD)) {
    const count = fold.querySelector('[data-unmodified-lines]');
    // Pierre's words hold the count until they're replaced, so it's kept on the fold, and read again whenever pierre
    // has put its own words back.
    if (count && count.textContent !== fold.dataset.arborText) fold.dataset.arborLines = String(foldedLines(count.textContent) ?? '');
    const lines = fold.dataset.arborLines ? Number(fold.dataset.arborLines) : null;
    if (count) {
      count.textContent = say(t, foldText(lines));
      fold.dataset.arborText = count.textContent;
    }
    const chunked = fold.querySelector('[data-expand-all-button]') !== null;
    for (const control of fold.querySelectorAll<HTMLElement>(FOLD_CONTROL)) {
      const kind = foldControl(control);
      control.tabIndex = 0;
      control.setAttribute('aria-label', say(t, foldControlName(kind, chunked, lines)));
      if (kind === 'all') control.textContent = t('fileView.fold.all');
    }
  }
  const wanted = refocus.get(root);
  if (!wanted) return;
  refocus.delete(root);
  // Each fold is drawn in the gutter and in each column, but shown once.
  const shown = [...root.querySelectorAll<HTMLElement>(`${FOLD} ${FOLD_CONTROL}`)].filter((control) => control.getClientRects().length > 0);
  const next = shown.find((control) => foldIndex(control) === wanted.index && foldControl(control) === wanted.control)
    ?? shown.find((control) => foldIndex(control) === wanted.index)
    ?? shown.find((control) => foldIndex(control) > wanted.index)
    ?? [...shown].reverse().find((control) => foldIndex(control) < wanted.index);
  if (next) next.focus();
  else {
    host.tabIndex = -1;
    host.focus();
  }
}

export const THEMES = { light: 'pierre-light', dark: 'pierre-dark' } as const;
export const HIGHLIGHTER = 'shiki-wasm';
const loading = new Map<string, Promise<void>>();

/**
 * Pierre leaves a diff blank when its first render starts before the highlighter has loaded; the highlight it waits
 * for is dropped. So the viewer waits for the highlighter, both themes and the file's language first. A failed load
 * is forgotten, so opening the file again tries again.
 */
export function highlighterReady(path: string): Promise<void> {
  const lang = highlightLanguage(path);
  let ready = loading.get(lang);
  if (!ready) {
    ready = preloadHighlighter({ themes: [THEMES.light, THEMES.dark], langs: ['text', lang], preferredHighlighter: HIGHLIGHTER })
      .catch((error: unknown) => {
        loading.delete(lang);
        throw error;
      });
    loading.set(lang, ready);
  }
  return ready;
}

const allLoading = new Map<string, Promise<void>>();

/** The highlighter ready for every file's language at once, the same promise for the same languages each time. */
export function highlightersReady(paths: readonly string[]): Promise<void> {
  const key = [...new Set(paths.map(highlightLanguage))].sort().join(' ');
  let ready = allLoading.get(key);
  if (!ready) {
    ready = Promise.all(paths.map(highlighterReady)).then(() => undefined, (error: unknown) => {
      allLoading.delete(key);
      throw error;
    });
    allLoading.set(key, ready);
  }
  return ready;
}

/**
 * One file's changes, drawn by `@pierre/diffs`: highlighted by the file's type, with the words that changed in a line
 * marked, and unchanged stretches folded behind controls that open from the keyboard too. Loaded on demand with the
 * highlighter, which is large; Shiki's WASM regex engine, since its JavaScript one can backtrack for a very long time
 * on some grammars.
 */
export function CodeDiff({ path, before, after, style }: {
  /** Names the file, for its type. */
  path: string;
  /** Null for a side that hasn't the file. */
  before: string | null;
  after: string | null;
  style: DiffStyle;
}) {
  const { t } = useI18n();
  const theme = useAppliedTheme();
  const model = useMemo(() => {
    const built = buildFileDiff(path, before, after);
    // Highlighted as highlighterReady loaded it: a language Arbor doesn't ship a grammar for draws as plain text.
    return built.kind === 'changes' ? { ...built, diff: { ...built.diff, lang: highlightLanguage(path) } } : built;
  }, [path, before, after]);
  const options = useMemo((): FileDiffOptions<undefined, undefined> => ({
    diffStyle: style,
    theme: THEMES,
    themeType: theme,
    preferredHighlighter: HIGHLIGHTER,
    // − and + beside each line, as the dialogs' descriptions and the legend above name the two copies.
    diffIndicators: 'classic',
    lineDiffType: 'word-alt',
    overflow: 'wrap',
    disableFileHeader: true,
    expansionLineCount: FOLD_STEP,
    unsafeCSS: arborCSS(t),
    onPostRender: (host, _instance, phase) => {
      if (phase !== 'unmount') labelFolds(host, t);
    },
  }), [style, theme, t]);
  if (model.kind === 'same') return <p className="py-2 text-sm text-muted-foreground">{t('setup.compare.onlyLineEndings')}</p>;
  // Suspends to the placeholder the viewer loads behind.
  use(highlighterReady(path));
  return (
    <div className="flex flex-col gap-1.5">
      {model.whole ? <p className="text-xs text-muted-foreground">{t('fileView.whole')}</p> : null}
      <div className="overflow-hidden rounded-lg border border-border/60" data-slot="code-diff">
        <FileDiff fileDiff={model.diff} options={options} />
      </div>
    </div>
  );
}
