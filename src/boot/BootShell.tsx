import type { CSSProperties } from 'react';
import { en, type MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import { PAGE_ICONS, FOOTER_UTILITIES_CLASS, HEADER_ICON_BUTTON, MAIN_CLASS, ROW_CLASS, ROW_ICON_CLASS, SEARCH_GROUP_CLASS, SEARCH_KBD_CLASS, SEARCH_ROW_CLASS, SHELL_CLASS, SIDEBAR_ART_CLASS, SIDEBAR_CLASS, SIDEBAR_FOOTER_CLASS, SIDEBAR_HEADER_CLASS, TOGGLE_SLOT_CLASS, TREE_CHEVRON_CLASS, TREE_NAV_CLASS, TREE_SECTION_LABEL_CLASS, treeSectionClass, UTILITY_BUTTON, WORDMARK_CLASS } from '../components/sidebar/shellParts';
import { buttonVariants } from '../components/ui/button';
import { ChevronRight, MonitorPlus, PanelLeft, PanelLeftClose, Search, Server, Settings, Bell, UserPlus } from '../components/ui/icons';
import { Kbd } from '../components/ui/kbd';
import { Skeleton } from '../components/ui/skeleton';
import { SECTION_CARD, SECTION_HEADER } from '../components/layout/settings';
import { SIDEBAR_TREE } from '../services/sidebarTree';
import { formatKeys, SHORTCUTS } from '../services/shortcuts';

/**
 * The window's first screen, drawn before any script runs: the build renders this to static HTML inside index.html's
 * `#root` (vite.config.js, `bootShell()`), and React's first commit replaces it. It draws the same boxes as the real
 * shell, from the same classes (components/sidebar/shellParts.ts), with nothing that depends on a person's data: the
 * tree's fixed pages and section names, the footer's icons, and Home's top bar over quiet skeletons. index.html's
 * scripts put the saved theme, color, sidebar width and zoom on it before it paints, and draw the sidebar art into
 * `[data-boot-art]`. Rendered on the build machine: nothing here may read the window, a store or a Tauri API.
 */
export function BootShell() {
  const t = (key: MessageKey) => en[key];
  const paletteKeys = SHORTCUTS.find((shortcut) => shortcut.id === 'palette.toggle')?.keys ?? 'mod+k';
  return (
    <div className={SHELL_CLASS} data-app-shell data-boot-shell aria-hidden="true" inert>
      <div className={TOGGLE_SLOT_CLASS} data-boot-box="toggle-slot">
        <span className={cn(buttonVariants({ variant: 'ghost-muted', size: 'icon-sm' }), 'size-(--workspace-titlebar-control-size) art-halo text-[var(--sidebar-icon-color)]')} data-boot-box="toggle" data-boot-ink>
          <span className="contents" data-boot-when="shown"><PanelLeftClose /></span>
          <span className="contents" data-boot-when="hidden" hidden><PanelLeft /></span>
        </span>
      </div>
      <aside className={SIDEBAR_CLASS} data-app-sidebar data-boot-box="sidebar">
        <div className={SIDEBAR_HEADER_CLASS} data-boot-box="header">
          <div className={SIDEBAR_ART_CLASS} data-boot-art />
          <span className={cn(WORDMARK_CLASS, 'art-halo')} data-boot-box="wordmark" data-boot-ink>{t('app.brandName')}</span>
        </div>
        <div className={SEARCH_GROUP_CLASS} data-boot-box="search">
          <div className="flex items-center gap-1">
            <span className={SEARCH_ROW_CLASS}>
              <Search aria-hidden="true" className="size-4 shrink-0 text-[var(--sidebar-icon-color)]" />
              <span className="min-w-0 flex-1 truncate">{t('palette.open')}</span>
              <Kbd className={cn('h-4.5 min-w-4.5 px-1 text-2xs', SEARCH_KBD_CLASS)}>{formatKeys(paletteKeys, { escape: t('shortcuts.key.escape'), ctrl: t('shortcuts.key.ctrl'), alt: t('shortcuts.key.alt'), shift: t('shortcuts.key.shift') }, true)}</Kbd>
            </span>
            <div className="flex shrink-0 items-center">
              <span className={cn(buttonVariants({ variant: 'ghost-muted', size: 'icon-sm' }), HEADER_ICON_BUTTON)}><UserPlus /></span>
              <span className={cn(buttonVariants({ variant: 'ghost-muted', size: 'icon-sm' }), HEADER_ICON_BUTTON)}><MonitorPlus /></span>
            </div>
          </div>
        </div>
        <nav className={TREE_NAV_CLASS} data-boot-box="tree">
          {SIDEBAR_TREE.map((section, index) => (
            <div key={section.id} className={treeSectionClass(index)}>
              {section.labelKey ? <div className={TREE_SECTION_LABEL_CLASS}>{t(section.labelKey)}</div> : null}
              <ul className="flex flex-col gap-px">
                {section.pages.map((page) => {
                  const Icon = PAGE_ICONS[page.id];
                  // Home is where every launch opens. A page with views has its chevron; Machines and Pools get theirs
                  // once there's a machine or pool to list, as in React's first frame.
                  const active = page.id === 'home';
                  const expandable = page.leaves.length > 0;
                  return (
                    <li key={page.id} className="flex flex-col">
                      <div className="relative">
                        <span className={cn(ROW_CLASS, expandable && 'pr-8')} data-active={active} data-boot-box={`row-${page.id}`}>
                          <Icon aria-hidden="true" selected={active} className={ROW_ICON_CLASS} />
                          <span className="min-w-0 flex-1 truncate">{t(page.labelKey)}</span>
                        </span>
                        {expandable ? <span className={TREE_CHEVRON_CLASS}><ChevronRight aria-hidden="true" className="size-3.5" /></span> : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <div className={SIDEBAR_FOOTER_CLASS} data-boot-box="footer">
          <div className={FOOTER_UTILITIES_CLASS}>
            <span className={cn(buttonVariants({ variant: 'ghost-muted', size: 'icon' }), UTILITY_BUTTON)}><Settings /></span>
            <span className={cn(buttonVariants({ variant: 'ghost-muted', size: 'icon' }), UTILITY_BUTTON)}><Bell /></span>
            <span className={cn(buttonVariants({ variant: 'ghost-muted', size: 'icon' }), UTILITY_BUTTON)}><Server /></span>
          </div>
        </div>
      </aside>
      <main className={MAIN_CLASS} data-boot-box="main">
        <BootHome title={t('app.nav.home')} />
      </main>
    </div>
  );
}

/**
 * Home's frame: its top bar and the column its sections sit in, from the real Page parts' classes, with each section
 * a header line over an empty card. Quiet on purpose: no shimmer, as it's on screen for a fraction of a second.
 */
function BootHome({ title }: { title: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col" style={{ '--page-width': '87.5rem' } as CSSProperties} data-slot="page" data-width="main">
      <header className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 pr-[max(1.25rem,calc((100%_-_var(--page-width))/2_+_1.25rem))] pl-[max(var(--topbar-start,1.25rem),calc((100%_-_var(--page-width))/2_+_1.25rem))]" data-boot-box="topbar">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h1 className="flex min-w-0 items-center gap-3 text-sm font-medium">
            <span className="truncate text-foreground [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1.5" data-boot-box="title">{title}</span>
          </h1>
        </div>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex w-full max-w-(--page-width) flex-col gap-8 px-5 pt-4 pb-12" data-boot-box="body">
          {[3, 2].map((rows, index) => (
            <section key={index} className="space-y-2.5">
              <div className={SECTION_HEADER}><div className="flex min-h-7 items-center"><Skeleton className="h-3 w-24 motion-safe:animate-none" /></div></div>
              <div className={SECTION_CARD}>
                {Array.from({ length: rows }, (_, row) => (
                  <div key={row} className="flex items-center gap-3 px-4 py-3.5">
                    <Skeleton className="size-8 rounded-lg motion-safe:animate-none" />
                    <div className="flex flex-1 flex-col gap-2">
                      <Skeleton className="h-3 w-40 motion-safe:animate-none" />
                      <Skeleton className="h-2.5 w-64 motion-safe:animate-none" />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
