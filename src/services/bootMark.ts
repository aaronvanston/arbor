/**
 * The mark on the address of a page the window reloaded into while closed to the tray (backgroundReload.ts), apart
 * from the rest of the reload so index.html's first-screen script (src/boot/bootPaint.ts) can tell such a page without
 * bundling what the reload carries.
 */

/** The query parameter that says the page starts in the background. */
export const BOOT_PARAM = 'boot';
const BACKGROUND = 'background';

/** Whether the window reloaded into this page itself (shown or not): it isn't a launch, so the window is already up. */
export const reloadedPage = (href: string) => new URL(href).searchParams.has(BOOT_PARAM);

/** Where the window reloads to: the same page, marked to start in the background. */
export function backgroundBootUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.set(BOOT_PARAM, BACKGROUND);
  return url.href;
}

/** The address without the mark, so a later reload of any kind starts as usual. */
export function withoutBootMark(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(BOOT_PARAM);
  return url.href;
}

/**
 * Whether this page starts in the background: marked so, and still hidden. A window that showed while it reloaded
 * starts as at launch.
 */
export const startsInBackground = (href: string, hidden: boolean) => hidden && new URL(href).searchParams.get(BOOT_PARAM) === BACKGROUND;
