/** The parts of the page this needs, so tests can hand in a stand-in. */
type VisibilityDocument = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'> & {
  documentElement: Pick<HTMLElement, 'toggleAttribute'>;
};

/**
 * Marks `<html data-window-hidden>` while the window can't be seen (minimized, closed to the tray, on another
 * Space), so styles.css can pause decorative loops instead of repainting them for nobody. Returns a cleanup.
 */
export function trackWindowVisibility(page: VisibilityDocument = document): () => void {
  const update = () => page.documentElement.toggleAttribute('data-window-hidden', page.visibilityState === 'hidden');
  update();
  page.addEventListener('visibilitychange', update);
  return () => page.removeEventListener('visibilitychange', update);
}

type FrontDocument = Pick<Document, 'visibilityState' | 'hasFocus' | 'addEventListener' | 'removeEventListener'>;
type FrontWindow = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/** Whether Arbor's window is showing and has focus, so whoever is at the Mac is looking at it. */
export const isWindowInFront = (page: Pick<Document, 'visibilityState' | 'hasFocus'>) => page.visibilityState === 'visible' && page.hasFocus();

/**
 * Runs `run` now if the window is in front, and again each time it comes to the front, until the returned cleanup.
 * Closing the window on a Mac only hides it, so a page left open in it keeps running while nobody sees it.
 */
export function whenWindowInFront(run: () => void, page: FrontDocument = document, win: FrontWindow = window): () => void {
  const check = () => {
    if (isWindowInFront(page)) run();
  };
  check();
  page.addEventListener('visibilitychange', check);
  win.addEventListener('focus', check);
  return () => {
    page.removeEventListener('visibilitychange', check);
    win.removeEventListener('focus', check);
  };
}
