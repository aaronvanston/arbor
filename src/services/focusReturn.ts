/** The parts of an element that say whether the focus can go back to it. */
export type FocusReturnTarget = {
  readonly isConnected: boolean;
  readonly tagName: string;
  getClientRects(): { readonly length: number };
};

/**
 * Where a dialog opened from the window's own controls (the search palette from the sidebar's Search row or ⌘K) hands
 * the focus back as it closes: the element that had it as the dialog opened, while that's still there and showing.
 * One that the dialog's action hid along with the sidebar gives it to the sidebar button, which stays put. With nothing
 * to go back to (the dialog opened with nothing focused, or its opener went with the page it was on) it's `false`, and
 * the focus is left where it is rather than jumping to whatever had it some time before.
 */
export function focusReturnTarget<T extends FocusReturnTarget>(
  opener: T | null,
  { inSidebar, sidebarButton }: { inSidebar: (element: T) => boolean; sidebarButton: T | null },
): T | false {
  if (!opener || !opener.isConnected || opener.tagName === 'BODY') return false;
  if (opener.getClientRects().length > 0) return opener;
  return inSidebar(opener) && sidebarButton ? sidebarButton : false;
}
