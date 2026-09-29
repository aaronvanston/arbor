import { savedStore } from './savedStore';

/**
 * How a file's changes are laid out: one column with removed lines above added ones, or the two copies side by side.
 * A UI preference with nothing secret in it, so it's kept in the window's storage like the sidebar's width.
 */
export type DiffStyle = 'unified' | 'split';
/** A file Arbor can render: its source changes, or the rendered copies. */
export type FileView = 'source' | 'preview';

export const DEFAULT_DIFF_STYLE: DiffStyle = 'unified';

/** The saved style; anything else, from an older version or a damaged entry, is the default. */
export const parseDiffStyle = (raw: string | null | undefined): DiffStyle => (raw === 'split' || raw === 'unified' ? raw : DEFAULT_DIFF_STYLE);

const store = savedStore<DiffStyle>({ key: 'cpa-gui.diffStyle.v1', parse: parseDiffStyle, fallback: DEFAULT_DIFF_STYLE, serialize: (style) => style });

export const setDiffStyle = store.set;

/** The layout every diff shares, so choosing it once holds for the next one opened. */
export const useDiffStyle = store.useValue;

/** The agents' own markdown files, which read better rendered: skills and the instructions Claude Code and Codex load. */
const PREVIEWABLE = new Set(['skill.md', 'claude.md', 'agents.md']);

/** Whether a file, by its path or name, can be shown rendered as well as by its source. */
export function canPreview(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return PREVIEWABLE.has(name);
}
