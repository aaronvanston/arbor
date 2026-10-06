import type { CSSProperties } from 'react';
import { en, type MessageKey } from '../i18n/resources';
import { I18nProvider, useI18n } from '../i18n';
import { AccountsSkeleton, MACHINES_GRID_CLASS, MachinesSkeleton, NeedsYouSkeleton, NeedsYouSummarySkeleton, ProxySkeleton, TODAY_CARD_CLASS, TodaySkeleton } from '../components/homeSkeletons';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Button, buttonVariants } from '../components/ui/button';
import { DEFAULT_HOME_SHAPE } from './bootState';
import { cn } from '../lib/utils';
import { CORNER_DOT, PAGE_ICONS, FOOTER_UTILITIES_CLASS, LEAF_CLASS, TREE_LEAVES_CLASS, TOGGLE_BUTTON_CLASS, TOGGLE_INK_CLASS, TOGGLE_SHOWN_CLASS, HEADER_ICON_BUTTON, MAIN_CLASS, ROW_CLASS, ROW_ICON_CLASS, SEARCH_GROUP_CLASS, SEARCH_KBD_CLASS, SEARCH_ROW_CLASS, SHELL_CLASS, SIDEBAR_ART_CLASS, SIDEBAR_CLASS, SIDEBAR_FOOTER_CLASS, SIDEBAR_HEADER_CLASS, TOGGLE_SLOT_CLASS, TREE_CHEVRON_CLASS, TREE_NAV_CLASS, TREE_SECTION_LABEL_CLASS, treeSectionClass, UTILITY_BUTTON, WORDMARK_CLASS } from '../components/sidebar/shellParts';
import { ArrowUpRight, ChevronRight, Lock, Play, MonitorPlus, PanelLeft, PanelLeftClose, Search, Server, Settings, Bell, UserPlus } from '../components/ui/icons';
import { Kbd } from '../components/ui/kbd';
import { SettingsSection } from '../components/layout/settings';
import { accountSignInsView, canOpenView, mainView } from '../navigation';
import { leafView, SIDEBAR_TREE } from '../services/sidebarTree';
import { sidebarCoreState } from '../services/coreLock';
import { StatusDot } from '../components/ui/status-dot';
import { formatKeys, SHORTCUTS } from '../services/shortcuts';

/** The core's state before its status has been read, as React's first frame has it. */
const CHECKING = sidebarCoreState(null, '');

/**
 * The window's first screen, drawn before any script runs: the build renders this to static HTML inside index.html's
 * `#root` (vite.config.js, `bootShell()`), and React's first commit replaces it. It draws the same boxes as the real
 * shell, from the same classes (components/sidebar/shellParts.ts), with nothing that depends on a person's data: the
 * tree's fixed pages and section names, the footer's icons, and Home's top bar over quiet skeletons. index.html's
 * scripts put the saved theme, color, sidebar width and zoom on it before it paints, and draw the sidebar art into
 * `[data-boot-art]`. Rendered on the build machine: nothing here may read the window, a store or a Tauri API.
 */
export function BootShell() {
  return <I18nProvider><BootFrame /></I18nProvider>;
}

function BootFrame() {
  const t = (key: MessageKey) => en[key];
  const paletteKeys = SHORTCUTS.find((shortcut) => shortcut.id === 'palette.toggle')?.keys ?? 'mod+k';
  return (
    <div className={SHELL_CLASS} data-app-shell data-boot-shell aria-hidden="true" inert>
      <div className={TOGGLE_SLOT_CLASS} data-boot-box="toggle-slot">
        <span className={cn(buttonVariants({ variant: 'ghost-muted', size: 'icon-sm' }), TOGGLE_BUTTON_CLASS, TOGGLE_INK_CLASS, 'pointer-events-auto', TOGGLE_SHOWN_CLASS)} data-boot-box="toggle" data-boot-ink>
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
              {/* Dimmed, as React first draws it, until the core says it's running. */}
              <span className={cn(buttonVariants({ variant: 'ghost-muted', size: 'icon-sm' }), HEADER_ICON_BUTTON)} aria-disabled={canOpenView(accountSignInsView(), false) ? undefined : true}><UserPlus /></span>
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
                  // A page that needs the core shows locked until it answers, as in React's first frame.
                  const locked = !canOpenView(mainView(page.id), false);
                  return (
                    <li key={page.id} className="flex flex-col">
                      <div className="relative">
                        <span className={cn(ROW_CLASS, expandable && 'pr-8')} data-active={active} aria-disabled={locked || undefined} data-boot-box={`row-${page.id}`}>
                          <Icon aria-hidden="true" selected={active} className={ROW_ICON_CLASS} />
                          <span className="min-w-0 flex-1 truncate">{t(page.labelKey)}</span>
                          {locked ? <Lock aria-hidden="true" className="size-3 shrink-0 text-[var(--sidebar-icon-color)]" /> : null}
                        </span>
                        {expandable ? <span className={TREE_CHEVRON_CLASS}><ChevronRight aria-hidden="true" className="size-3.5 transition-transform duration-150" data-boot-chevron={page.id} /></span> : null}
                      </div>
                      {/* Its views, for a group left open: index.html's script shows the ones React's first frame will. */}
                      {expandable ? (
                        <ul className={TREE_LEAVES_CLASS} data-boot-leaves={page.id} hidden>
                          {page.leaves.map((leaf) => {
                            const leafLocked = !canOpenView(leafView(leaf), false);
                            return (
                              <li key={leaf.tab}>
                                <span className={cn(LEAF_CLASS, 'pr-2.5')} data-active={false} aria-disabled={leafLocked || undefined}>
                                  <span className="min-w-0 flex-1 truncate">{t(leaf.labelKey)}</span>
                                  {leafLocked ? <Lock aria-hidden="true" className="size-3 shrink-0 text-[var(--sidebar-icon-color)]" /> : null}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
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
            {/* The core's dot, as CoreUtility draws it before the core's status has been read. */}
            <span className={cn(buttonVariants({ variant: 'ghost-muted', size: 'icon' }), UTILITY_BUTTON)}>
              <Server />
              <StatusDot tone={CHECKING.tone} pulse={CHECKING.tone === 'warning'} className={CORNER_DOT} />
            </span>
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
 * Home as it first draws while it waits for the core: each section under its own header and actions, the real
 * SettingsSection, over the skeletons Home itself shows (components/homeSkeletons.tsx), as many rows as the last
 * launch had. index.html's script fits the counts to the saved shape; the defaults stand in until then.
 */
function BootHome({ title }: { title: string }) {
  const { t } = useI18n();
  const open = (label: MessageKey) => <Button variant="ghost-muted" size="sm">{t(label)}<ArrowUpRight /></Button>;
  const refresh = (label: MessageKey) => <Button variant="ghost-muted" size="icon-sm" disabled focusableWhenDisabled aria-label={t(label)}><RefreshIcon /></Button>;
  return (
    <div className="flex h-full min-h-0 flex-col" style={{ '--page-width': '87.5rem' } as CSSProperties} data-slot="page" data-width="main">
      <header className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 pr-[max(1.25rem,calc((100%_-_var(--page-width))/2_+_1.25rem))] pl-[max(var(--topbar-start,1.25rem),calc((100%_-_var(--page-width))/2_+_1.25rem))]" data-boot-box="topbar">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h1 className="flex min-w-0 items-center gap-3 text-sm font-medium">
            <span className="truncate text-foreground [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1.5" data-boot-box="title">{title}</span>
          </h1>
        </div>
      </header>
      <div className="relative min-h-0 flex-1 overflow-y-auto" data-slot="page-scroll">
        <div className="mx-auto flex w-full max-w-(--page-width) flex-col gap-8 px-5 pt-4 pb-12" data-boot-box="body">
          {/* Hidden unless it listed rows within its window last time; the script then shows it with that many. */}
          <div className="contents" data-boot-attention hidden>
            <SettingsSection title={t('home.attention.title')} summary={<NeedsYouSummarySkeleton />} headerAction={open('home.attention.open')}>
              <NeedsYouSkeleton rows={1} more />
            </SettingsSection>
          </div>
          <SettingsSection
            title={t('home.accounts.title')}
            description={t('home.accounts.description')}
            headerAction={<div className="flex items-center gap-1">{refresh('home.limits.refresh')}{open('home.limits.open')}</div>}
          >
            <AccountsSkeleton providers={DEFAULT_HOME_SHAPE.providers} />
          </SettingsSection>
          <SettingsSection
            title={t('home.machines.title')}
            description={t('home.machines.description')}
            headerAction={open('home.machines.open')}
            contentClassName={MACHINES_GRID_CLASS}
          >
            <MachinesSkeleton count={DEFAULT_HOME_SHAPE.machines} />
          </SettingsSection>
          <SettingsSection
            title={t('home.stats.title')}
            description={t('home.stats.description')}
            headerAction={open('home.stats.openUsage')}
            contentClassName={TODAY_CARD_CLASS}
          >
            <TodaySkeleton />
          </SettingsSection>
          <SettingsSection
            title={t('home.proxy.title')}
            description={t('home.proxy.description')}
            headerAction={(
              <div className="flex items-center gap-1.5">
                {refresh('kernel.control.refresh')}
                <Button size="sm" disabled><Play />{t('kernel.control.start')}</Button>
              </div>
            )}
          >
            <ProxySkeleton />
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}
