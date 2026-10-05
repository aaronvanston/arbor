import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { BootShell } from '../src/boot/BootShell';
import { BOOT_KEY, readBootState } from '../src/boot/bootState';
import { PageBreadcrumb, PageTopbar } from '../src/components/layout/page';
import { SidebarHeader, SidebarRow, SidebarSearchGroup, SidebarSearchRow } from '../src/components/sidebar/SidebarChrome';
import { House } from '../src/components/ui/icons';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { I18nProvider } from '../src/i18n';
import { en } from '../src/i18n/resources';
import { SIDEBAR_TREE } from '../src/services/sidebarTree';

const boot = renderToStaticMarkup(<BootShell />);
const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider><TooltipProvider>{node}</TooltipProvider></I18nProvider>);
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** The class list of the first tag carrying `marker`, as a sorted set, so the same classes in any order compare equal. */
function classesAt(html: string, marker: string): string[] {
  const at = html.indexOf(marker);
  if (at < 0) throw new Error(`no ${marker}`);
  const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at));
  return [...new Set((tag.match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean))].sort();
}

describe("index.html's static first screen", () => {
  it('lists the sidebar tree’s pages and sections in order, by their English names', () => {
    const labels = [...boot.matchAll(/data-boot-box="row-([a-z]+)"/g)].map((match) => match[1]);
    expect(labels).toEqual(SIDEBAR_TREE.flatMap((section) => section.pages.map((page) => page.id)));
    for (const section of SIDEBAR_TREE) {
      if (section.labelKey) expect(boot).toContain(`>${en[section.labelKey]}</div>`);
      for (const page of section.pages) expect(boot).toContain(`>${en[page.labelKey]}</span>`);
    }
  });

  it('draws the sidebar’s rows with the real rows’ classes', () => {
    const real = render(<SidebarRow icon={House} label="Home" active locked={false} lockedHint="" onClick={() => {}} rowProps={{ 'data-tree-page': 'home' }} />);
    expect(classesAt(boot, 'data-boot-box="row-home"')).toEqual(classesAt(real, 'data-tree-page="home"'));
  });

  it('draws the title row, wordmark and search row with the real ones’ classes', () => {
    const header = render(<SidebarHeader art="canopy" theme="light" color="summer" macTitleBar={false} onHome={() => {}} />);
    expect(classesAt(boot, 'data-boot-box="header"')).toEqual(classesAt(header, 'class='));
    expect(classesAt(boot, 'data-boot-box="wordmark"')).toEqual(classesAt(header, 'art-halo'));
    const search = render(<SidebarSearchGroup><SidebarSearchRow coreReady lockedHint="" onSearch={() => {}} onNavigate={() => {}} onAddMachine={() => {}} /></SidebarSearchGroup>);
    expect(classesAt(boot, 'data-boot-box="search"')).toEqual(classesAt(search, 'data-slot="sidebar-search"'));
    expect(classesAt(boot, 'group/search')).toEqual(classesAt(search, 'group/search'));
  });

  it('draws Home’s top bar and title with the real top bar’s classes', () => {
    const real = render(<PageTopbar><PageBreadcrumb segments={['Home']} /></PageTopbar>);
    expect(classesAt(boot, 'data-boot-box="topbar"')).toEqual(classesAt(real, 'data-slot="page-topbar"'));
    expect(classesAt(boot, 'data-boot-box="title"')).toEqual(classesAt(real, 'truncate text-foreground'));
  });

  it('takes the frame, sidebar, footer and page from the classes the real shell uses', () => {
    const app = source('src/App.tsx');
    for (const name of ['SHELL_CLASS', 'TOGGLE_SLOT_CLASS', 'SIDEBAR_CLASS', 'SIDEBAR_FOOTER_CLASS', 'FOOTER_UTILITIES_CLASS', 'MAIN_CLASS']) {
      expect(app).toContain(name);
    }
    // The footer's three icons: Settings, Alerts and the core.
    expect(app).toMatch(/<SettingsUtility[\s\S]*<AlertsUtility[\s\S]*<CoreUtility/);
    const footer = boot.slice(boot.indexOf('data-boot-box="footer"'), boot.indexOf('</aside>'));
    expect(footer.match(/<svg/g)?.length).toBe(3);
  });

  it('is replaced by React and hidden from assistive tech until then', () => {
    expect(boot).toContain('data-boot-shell');
    expect(boot).toMatch(/^<div[^>]*aria-hidden="true"[^>]*inert=""/);
    expect(source('index.html')).toContain('<div id="root"><!--boot-shell--></div>');
  });
});

describe("the first screen's scripts", () => {
  it('read only look preferences from the window’s storage', () => {
    const allowed = new Set(['arbor.theme', 'easy-cli-proxy-api.theme', 'arbor.preferences.v1', 'cpa-gui.preferences.v1', 'arbor.sidebar.v1', 'BOOT_KEY']);
    // bootPaint.ts's `read(key, legacy)` helper is the one place a key arrives as a variable.
    const helper = new Set(['key', 'legacy']);
    for (const file of ['src/boot/bootHead.ts', 'src/boot/bootPaint.ts']) {
      const text = source(file);
      expect(text).not.toMatch(/localStorage\.(setItem|removeItem|key|clear)\b|sessionStorage|document\.cookie|indexedDB/);
      const reads = [...text.matchAll(/localStorage\.getItem\(\s*'?([\w.-]+)'?/g)].map((match) => match[1] ?? '');
      const helperReads = [...text.matchAll(/\bread\(\s*'([\w.-]+)'(?:,\s*'([\w.-]+)')?/g)].flatMap((match) => [match[1], match[2]]).filter((key): key is string => Boolean(key));
      expect(reads.length + helperReads.length).toBeGreaterThan(0);
      for (const key of reads) expect(allowed.has(key) || helper.has(key)).toBe(true);
      for (const key of helperReads) expect(allowed.has(key)).toBe(true);
    }
  });

  it('keep the zoom only within the View menu’s range', () => {
    expect(BOOT_KEY).toBe('arbor.boot.v1');
    expect(readBootState(null)).toEqual({ zoom: 1 });
    expect(readBootState('{"zoom":1.2}')).toEqual({ zoom: 1.2 });
    expect(readBootState('{"zoom":9}')).toEqual({ zoom: 1 });
    expect(readBootState('not json')).toEqual({ zoom: 1 });
  });
});
