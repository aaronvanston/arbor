import { describe, expect, it } from 'bun:test';
import {
  clampSidebarWidth,
  draggedSidebarWidth,
  getSidebarLayout,
  MAIN_MIN_WIDTH,
  NARROW_WINDOW_WIDTH,
  pagePutsAwaySidebar,
  parseSidebarLayout,
  resetSidebarWidth,
  setSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  sidebarMaxWidth,
  sidebarOverlays,
  sidebarShown,
  sidebarWidthForKey,
  toggledSidebar,
  withNarrowWindow,
  type SidebarVisibility,
} from '../src/services/sidebarLayout';

describe('the sidebar’s width', () => {
  it('starts at 16rem and never goes under 13rem, in whole pixels', () => {
    expect(SIDEBAR_DEFAULT_WIDTH).toBe(256);
    expect(SIDEBAR_MIN_WIDTH).toBe(208);
    expect(clampSidebarWidth(120)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(263.6)).toBe(264);
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('takes at most the window less the page’s 640px, and never less than its narrowest', () => {
    expect(MAIN_MIN_WIDTH).toBe(640);
    expect(sidebarMaxWidth(1280)).toBe(640);
    expect(sidebarMaxWidth(1024.6)).toBe(384);
    expect(sidebarMaxWidth(700)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(900, sidebarMaxWidth(1280))).toBe(640);
    // The default can be wider than a small window allows.
    expect(clampSidebarWidth(Number.NaN, sidebarMaxWidth(860))).toBe(220);
  });

  it('hides itself in a window narrower than the narrowest sidebar and page side by side', () => {
    expect(NARROW_WINDOW_WIDTH).toBe(848);
  });

  it('follows the pointer from where the drag started, and stops short of the page’s 640px', () => {
    const max = sidebarMaxWidth(1280);
    expect(draggedSidebarWidth(256, 256, 300, max)).toBe(300);
    expect(draggedSidebarWidth(256, 256, 180, max)).toBe(SIDEBAR_MIN_WIDTH);
    expect(draggedSidebarWidth(300, 310, 1_000, max)).toBe(640);
  });

  it('moves a step with the arrow keys, Home to the narrowest and End to the widest the window allows', () => {
    const max = sidebarMaxWidth(1024);
    expect(sidebarWidthForKey(256, 'ArrowRight', max)).toBe(272);
    expect(sidebarWidthForKey(256, 'ArrowLeft', max)).toBe(240);
    expect(sidebarWidthForKey(216, 'ArrowLeft', max)).toBe(SIDEBAR_MIN_WIDTH);
    expect(sidebarWidthForKey(376, 'ArrowRight', max)).toBe(384);
    expect(sidebarWidthForKey(256, 'Home', max)).toBe(SIDEBAR_MIN_WIDTH);
    expect(sidebarWidthForKey(256, 'End', max)).toBe(384);
    // Keys it doesn't use are left to the page.
    expect(sidebarWidthForKey(256, 'ArrowUp', max)).toBeNull();
    expect(sidebarWidthForKey(256, 'Tab', max)).toBeNull();
  });

  it('goes back to 16rem on a double-click', () => {
    setSidebarWidth(420);
    expect(getSidebarLayout().width).toBe(420);
    resetSidebarWidth();
    expect(getSidebarLayout().width).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('the saved layout', () => {
  it('falls back part by part when what’s saved is missing or damaged', () => {
    expect(parseSidebarLayout(null)).toEqual({ width: SIDEBAR_DEFAULT_WIDTH, hidden: false });
    expect(parseSidebarLayout('{not json')).toEqual({ width: SIDEBAR_DEFAULT_WIDTH, hidden: false });
    expect(parseSidebarLayout('[288, true]')).toEqual({ width: SIDEBAR_DEFAULT_WIDTH, hidden: false });
    expect(parseSidebarLayout('"wide"')).toEqual({ width: SIDEBAR_DEFAULT_WIDTH, hidden: false });
    expect(parseSidebarLayout('{"width":"288px","hidden":"yes"}')).toEqual({ width: SIDEBAR_DEFAULT_WIDTH, hidden: false });
    expect(parseSidebarLayout('{"width":288}')).toEqual({ width: 288, hidden: false });
    expect(parseSidebarLayout('{"hidden":true}')).toEqual({ width: SIDEBAR_DEFAULT_WIDTH, hidden: true });
    // A wide one is kept, so widening the window again gives it back; the window caps it as it shows.
    expect(parseSidebarLayout('{"width":4000,"hidden":false}')).toEqual({ width: 4000, hidden: false });
    expect(parseSidebarLayout('{"width":-20,"hidden":false}')).toEqual({ width: SIDEBAR_MIN_WIDTH, hidden: false });
  });

});

describe('showing and hiding the sidebar', () => {
  const wide: SidebarVisibility = { hidden: false, narrow: false, revealed: false };

  it('hides and shows it in a wide window, which is what’s saved', () => {
    expect(sidebarShown(wide)).toBe(true);
    const hidden = toggledSidebar(wide);
    expect(hidden).toEqual({ hidden: true, narrow: false, revealed: false });
    expect(sidebarShown(hidden)).toBe(false);
    expect(toggledSidebar(hidden)).toEqual(wide);
  });

  it('hides it in a narrow window without changing what’s saved, so it’s back once the window is wide', () => {
    const narrow = withNarrowWindow(wide, true);
    expect(narrow).toEqual({ hidden: false, narrow: true, revealed: false });
    expect(sidebarShown(narrow)).toBe(false);
    expect(sidebarShown(withNarrowWindow(narrow, false))).toBe(true);
  });

  it('brings it back in a narrow window, and hiding it again there leaves the saved choice alone', () => {
    const narrow = withNarrowWindow(wide, true);
    const revealed = toggledSidebar(narrow);
    expect(revealed).toEqual({ hidden: false, narrow: true, revealed: true });
    expect(sidebarShown(revealed)).toBe(true);
    const hiddenAgain = toggledSidebar(revealed);
    expect(hiddenAgain).toEqual({ hidden: false, narrow: true, revealed: false });
    expect(sidebarShown(withNarrowWindow(hiddenAgain, false))).toBe(true);
  });

  it('shows a sidebar hidden on purpose from a narrow window, and keeps it once the window is wide', () => {
    const hiddenOnPurpose: SidebarVisibility = { ...wide, hidden: true };
    const narrow = withNarrowWindow(hiddenOnPurpose, true);
    const shown = toggledSidebar(narrow);
    expect(shown).toEqual({ hidden: false, narrow: true, revealed: true });
    expect(sidebarShown(withNarrowWindow(shown, false))).toBe(true);
  });

  it('opens it over the page when it’s brought back in a narrow window, so the page keeps its 640px', () => {
    expect(sidebarOverlays(wide)).toBe(false);
    const narrow = withNarrowWindow(wide, true);
    expect(sidebarOverlays(narrow)).toBe(false);
    const revealed = toggledSidebar(narrow);
    expect(sidebarOverlays(revealed)).toBe(true);
    expect(sidebarOverlays(toggledSidebar(revealed))).toBe(false);
    // Back beside the page once the window is wide again.
    expect(sidebarOverlays(withNarrowWindow(revealed, false))).toBe(false);
  });

  it('puts away a sidebar over the page when a page is picked, but not on switching to Settings or back', () => {
    expect(pagePutsAwaySidebar('home', 'usage')).toBe(true);
    expect(pagePutsAwaySidebar('settings:general', 'settings:network')).toBe(true);
    expect(pagePutsAwaySidebar('home', 'home')).toBe(false);
    expect(pagePutsAwaySidebar('home', 'settings:general')).toBe(false);
    expect(pagePutsAwaySidebar('settings:overrides', 'accounts')).toBe(false);
  });

  it('goes back to what’s saved whenever the window crosses the width', () => {
    const revealed = toggledSidebar(withNarrowWindow(wide, true));
    const widened = withNarrowWindow(revealed, false);
    expect(widened.revealed).toBe(false);
    // Narrow again, the sidebar the window hid stays hidden until it's brought back again.
    expect(sidebarShown(withNarrowWindow(widened, true))).toBe(false);
    // Nothing changes when the width is on the same side as before.
    expect(withNarrowWindow(revealed, true)).toBe(revealed);
  });
});
