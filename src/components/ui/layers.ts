import { createContext, useContext, useRef, type RefObject } from 'react';

/** Lets a popover's or menu's root know its popup element, which its popup part sets. */
export const LayerPopupContext = createContext<RefObject<HTMLDivElement | null> | null>(null);

export const useLayerPopupRef = () => useRef<HTMLDivElement | null>(null);

export const useLayerPopup = () => useContext(LayerPopupContext);

/**
 * Whether a press outside a popup landed in a dialog opened after it, such as a confirmation the popup asked for.
 * Base UI counts that as outside, since the dialog isn't in the popup's tree, and would close the popup under it.
 * A dialog the popup itself sits over came before it in the document, so a press there still closes it.
 */
export function pressedLayerAbove(popup: Element | null, event: Event): boolean {
  const target = event.target;
  if (!popup || !(target instanceof Element)) return false;
  const layer = target.closest('[data-slot=dialog-viewport]');
  return Boolean(layer && popup.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING);
}
