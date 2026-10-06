import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { BootShell } from '../src/boot/BootShell';
import { reloadedPage, startsInBackground } from '../src/services/bootMark';
import { BOOT_KEY, DEFAULT_HOME_SHAPE, FIRST_SCREEN_SHOWN, firstScreenShown, NEEDS_YOU_RECENT_MS, needsYouLikely, readBootState } from '../src/boot/bootState';
import { NEEDS_YOU_WINDOW_MS } from '../src/services/fleetBoard';
import { AccountsSkeleton } from '../src/components/homeSkeletons';
import { PageBreadcrumb, PageTopbar } from '../src/components/layout/page';
import { SidebarToggle } from '../src/components/SidebarControls';
import { SidebarHeader, SidebarRow, SidebarSearchGroup, SidebarSearchRow } from '../src/components/sidebar/SidebarChrome';
import { TOGGLE_SHOWN_CLASS } from '../src/components/sidebar/shellParts';
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

  it('draws the sidebar button as App.tsx does over the art', () => {
    const real = render(<SidebarToggle shown onToggle={() => {}} ink="#27272a" className={`pointer-events-auto ${TOGGLE_SHOWN_CLASS}`} />);
    expect(classesAt(boot, 'data-boot-box="toggle"')).toEqual(classesAt(real, 'aria-controls'));
  });

  it('shows the pages that need the core locked, as React’s first frame does before the core answers', () => {
    expect(boot).toMatch(/aria-disabled="true" data-boot-box="row-accounts"/);
    expect(boot).not.toMatch(/aria-disabled="true" data-boot-box="row-(home|usage)"/);
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
    const allowed = new Set(['arbor.theme', 'easy-cli-proxy-api.theme', 'arbor.preferences.v1', 'cpa-gui.preferences.v1', 'arbor.sidebar.v1', 'arbor.sidebar.tree.v1', 'BOOT_KEY']);
    // bootPaint.ts's `read(key, legacy)` helper is the one place a key arrives as a variable.
    const helper = new Set(['key', 'legacy']);
    for (const file of ['src/boot/bootHead.ts', 'src/boot/bootPaint.ts']) {
      const text = source(file);
      expect(text).not.toMatch(/localStorage\.(setItem|removeItem|key|clear)\b|sessionStorage|document\.cookie|indexedDB/);
      const reads = [...text.matchAll(/localStorage\.getItem\(\s*'?([\w.-]+)'?/g)].map((match) => match[1] ?? '');
      const helperReads = [...text.matchAll(/\bread\(\s*'?([\w.-]+)'?(?:,\s*'([\w.-]+)')?/g)].flatMap((match) => [match[1], match[2]]).filter((key): key is string => Boolean(key));
      expect(reads.length + helperReads.length).toBeGreaterThan(0);
      for (const key of reads) expect(allowed.has(key) || helper.has(key)).toBe(true);
      for (const key of helperReads) expect(allowed.has(key)).toBe(true);
    }
  });

  it('keep the zoom only within the View menu’s range', () => {
    expect(BOOT_KEY).toBe('arbor.boot.v1');
    expect(readBootState(null).zoom).toBe(1);
    expect(readBootState('{"zoom":1.2}').zoom).toBe(1.2);
    expect(readBootState('{"zoom":9}').zoom).toBe(1);
    expect(readBootState('not json').zoom).toBe(1);
  });

  it('keep Home’s shape as counts within bounds, and the defaults for anything else', () => {
    expect(readBootState(null).home).toEqual(DEFAULT_HOME_SHAPE);
    expect(readBootState('{"home":{"providers":[1,3],"machines":5}}').home).toMatchObject({ providers: [1, 3], machines: 5 });
    expect(readBootState('{"home":{"providers":[40,2,2,2,2,2,2,2],"machines":99}}').home).toMatchObject({ providers: [8, 2, 2, 2, 2, 2], machines: 9 });
    // Names or anything that isn't a count are dropped; no machines still keeps one card's room.
    expect(readBootState('{"home":{"providers":["casey",0,-1],"machines":0,"needsYou":{"rows":"x"}}}').home)
      .toEqual({ providers: DEFAULT_HOME_SHAPE.providers, machines: 1, needsYou: { rows: 0, more: false, at: 0 } });
  });

  it('draw Needs you only while the rows it last listed are still inside its window', () => {
    expect(NEEDS_YOU_RECENT_MS).toBe(NEEDS_YOU_WINDOW_MS);
    const at = 1_000_000_000;
    expect(needsYouLikely({ rows: 3, more: false, at }, at + 60_000)).toBe(true);
    expect(needsYouLikely({ rows: 3, more: false, at }, at + NEEDS_YOU_WINDOW_MS)).toBe(false);
    expect(needsYouLikely({ rows: 0, more: false, at }, at)).toBe(false);
  });
});

describe('Home while it waits', () => {
  it('draws the same skeletons in the first screen as Home does, under the same section headers', () => {
    for (const key of ['home.accounts.title', 'home.machines.title', 'home.stats.title', 'home.proxy.title'] as const) {
      expect(boot).toContain(`${en[key]}<button`);
    }
    expect(boot.match(/data-boot-provider/g)?.length).toBe(DEFAULT_HOME_SHAPE.providers.length);
    expect(boot.match(/data-boot-account/g)?.length).toBe(DEFAULT_HOME_SHAPE.providers.reduce((sum, count) => sum + count, 0));
    expect(boot.match(/data-boot-machine/g)?.length).toBe(DEFAULT_HOME_SHAPE.machines);
    const real = render(<AccountsSkeleton providers={DEFAULT_HOME_SHAPE.providers} />);
    expect(boot).toContain(real);
  });
});

describe('showing the window', () => {
  it('leaves it to the first screen once that has asked, so main.tsx sends no second frontend_ready', () => {
    const page = globalThis as unknown as Record<string, unknown> & { window?: unknown };
    const hadWindow = 'window' in page;
    if (!hadWindow) page.window = page;
    try {
      expect(firstScreenShown()).toBe(false);
      page[FIRST_SCREEN_SHOWN] = true;
      expect(firstScreenShown()).toBe(true);
    } finally {
      delete page[FIRST_SCREEN_SHOWN];
      if (!hadWindow) delete page.window;
    }
  });
});

describe('a page the window reloaded into', () => {
  it('is never a launch, so the first screen leaves showing the window alone, and idles while hidden', () => {
    expect(reloadedPage('tauri://localhost/?boot=background')).toBe(true);
    expect(reloadedPage('tauri://localhost/')).toBe(false);
    expect(startsInBackground('tauri://localhost/?boot=background', true)).toBe(true);
    expect(startsInBackground('tauri://localhost/?boot=background', false)).toBe(false);
  });
});
