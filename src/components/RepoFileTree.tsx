import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import type { ContextMenuItem, ContextMenuOpenContext, FileTreeRowDecoration } from '@pierre/trees';
import { useI18n } from '../i18n';
import type { RepoEntry } from '../native/types';
import { treeStatus } from '../services/repoBrowser';
import { Menu, MenuPopup } from './ui/menu';

/**
 * The tree draws in its own shadow root and reads its colors from these, so it takes the app's: the sidebar's quiet
 * rows on the card's surface, the accent where a row is chosen, and git's colors for what isn't committed.
 */
const TREE_STYLE = {
  '--trees-bg-override': 'transparent',
  '--trees-bg-muted-override': 'var(--accent)',
  '--trees-fg-override': 'var(--foreground)',
  '--trees-fg-muted-override': 'var(--muted-foreground)',
  '--trees-selected-bg-override': 'var(--accent)',
  '--trees-selected-fg-override': 'var(--foreground)',
  '--trees-selected-focused-border-color-override': 'var(--ring)',
  '--trees-border-color-override': 'var(--border)',
  '--trees-accent-override': 'var(--primary)',
  '--trees-focus-ring-color-override': 'var(--ring)',
  '--trees-font-family-override': 'var(--font-sans)',
  '--trees-font-size-override': '13px',
  '--trees-search-bg-override': 'var(--background)',
  '--trees-input-bg-override': 'var(--background)',
  '--trees-indent-guide-bg-override': 'color-mix(in oklab, var(--border) 70%, transparent)',
  '--trees-status-modified-override': 'var(--warning-foreground)',
  '--trees-status-added-override': 'var(--success-foreground)',
  '--trees-status-untracked-override': 'var(--success-foreground)',
  '--trees-status-deleted-override': 'var(--error-foreground)',
  '--trees-status-renamed-override': 'var(--info-foreground)',
} as CSSProperties;

/** The tree names a folder with a slash at the end; the repo's paths don't have one. */
const plain = (path: string) => (path.endsWith('/') ? path.slice(0, -1) : path);

/** A deleted file is struck through, as git clients show one still to commit. */
const TREE_CSS = `
button[data-type='item'][data-item-git-status='deleted'] [data-item-section='content'] { text-decoration: line-through; }
`;

/**
 * The tree clips what it draws to its own column, so a row's menu drawn inside it is cut off where the file pane
 * starts. It opens on the page's own layer instead, marked as the tree's so a click in it doesn't count as outside:
 * under the row's button, or at the pointer, a rect with no size, for a right-click.
 */
function RowMenu({ context, children }: { context: ContextMenuOpenContext; children: ReactNode }) {
  const { anchorRect } = context;
  const atPointer = anchorRect.width === 0 && anchorRect.height === 0;
  const anchor = useMemo(() => ({ getBoundingClientRect: () => DOMRect.fromRect(anchorRect) }), [anchorRect]);
  return (
    <Menu open onOpenChange={(open) => { if (!open) context.close(); }}>
      <MenuPopup anchor={anchor} align={atPointer ? 'start' : 'end'} className="min-w-48" data-file-tree-context-menu-root="true">
        {children}
      </MenuPopup>
    </Menu>
  );
}

/**
 * Every file in the setup repo as `@pierre/trees` draws it: folders opened a level deep, searchable, git's colors on
 * what isn't committed, and `decorate`'s word on the rows it names. Choosing a row reaches `onSelect`; right-click, or
 * a row's menu button, opens `renderMenu`'s items.
 */
export function RepoFileTree({ entries, selected, onSelect, decorate, renderMenu, header }: {
  entries: readonly RepoEntry[];
  selected: string | null;
  onSelect: (path: string) => void;
  decorate?: (path: string, folder: boolean) => FileTreeRowDecoration | null;
  renderMenu?: (item: ContextMenuItem, close: () => void) => ReactNode;
  header?: ReactNode;
}) {
  const { t } = useI18n();
  // The tree keeps the callbacks it was made with, so it calls through these to reach the current ones.
  const select = useRef(onSelect);
  const decorateRef = useRef(decorate);
  useEffect(() => {
    select.current = onSelect;
    decorateRef.current = decorate;
  });
  const paths = useMemo(() => entries.map((entry) => entry.path), [entries]);
  const { model } = useFileTree({
    paths,
    initialExpansion: 1,
    flattenEmptyDirectories: true,
    initialSelectedPaths: selected ? [selected] : [],
    gitStatus: treeStatus(entries),
    search: true,
    density: 'compact',
    icons: { set: 'standard', colored: false },
    unsafeCSS: TREE_CSS,
    onSelectionChange: (chosen) => {
      const [path] = chosen;
      if (path) select.current(plain(path));
    },
    renderRowDecoration: ({ item }) => decorateRef.current?.(plain(item.path), item.kind === 'directory') ?? null,
    composition: { contextMenu: { enabled: Boolean(renderMenu), triggerMode: 'both', buttonVisibility: 'when-needed' } },
  });

  // A save, a rename or a commit changes the files or their colors without making a new tree, so what's open stays open.
  const listed = useRef(paths.join('\n'));
  useEffect(() => {
    const joined = paths.join('\n');
    if (joined !== listed.current) {
      listed.current = joined;
      model.resetPaths(paths);
    }
    model.setGitStatus(treeStatus(entries));
  }, [model, paths, entries]);

  // A file chosen elsewhere (a change, a skill's link) is chosen and shown in the tree too.
  useEffect(() => {
    if (!selected || model.getSelectedPaths().includes(selected)) return;
    for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
    model.getItem(selected)?.select();
    model.scrollToPath(selected, { focus: false, offset: 'nearest' });
  }, [model, selected]);

  return (
    <FileTree
      model={model}
      aria-label={t('repo.tree.label')}
      header={header}
      style={{ ...TREE_STYLE, height: '100%' }}
      renderContextMenu={renderMenu ? (item: ContextMenuItem, context: ContextMenuOpenContext) => (
        <RowMenu context={context}>{renderMenu({ ...item, path: plain(item.path) }, () => context.close())}</RowMenu>
      ) : undefined}
    />
  );
}
