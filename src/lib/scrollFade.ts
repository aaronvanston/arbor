/** Which way an area scrolls: a list scrolls down (`y`), a row of top-bar actions sideways (`x`). */
export type ScrollAxis = 'x' | 'y';

/** Whether a scrolling area has more to show before (above, left of) or after (below, right of) what's in view. */
export type ScrollEdges = { start: boolean; end: boolean };

/** Where a scrolling area sits along one axis: how far it's scrolled, how long its content is, how much is in view. */
export type ScrollPosition = { offset: number; content: number; view: number };

export const NO_SCROLL_EDGES: ScrollEdges = { start: false, end: false };

/** Sub-pixel scroll positions (zoom, fractional sizes) shouldn't count as more to scroll. */
const SLACK_PX = 1;

export function scrollPosition(element: Element, axis: ScrollAxis): ScrollPosition {
  return axis === 'y'
    ? { offset: element.scrollTop, content: element.scrollHeight, view: element.clientHeight }
    : { offset: element.scrollLeft, content: element.scrollWidth, view: element.clientWidth };
}

export function scrollEdges({ offset, content, view }: ScrollPosition): ScrollEdges {
  return {
    start: offset > SLACK_PX,
    end: content - view - offset > SLACK_PX,
  };
}

export const sameScrollEdges = (left: ScrollEdges, right: ScrollEdges) => left.start === right.start && left.end === right.end;

/** A span along the scrolling axis, in the same coordinates for the area and what's in it: a DOMRect will do. */
export type ScrollSpan = { top: number; bottom: number };

/**
 * Whether an item in a scrolling area is fully in view and clear of the fades at its edges. An
 * edge with nothing past it doesn't fade, so an item can sit right against it.
 */
export function clearOfFade(item: ScrollSpan, area: ScrollSpan, edges: ScrollEdges, fade: number): boolean {
  const top = area.top + (edges.start ? fade : 0);
  const bottom = area.bottom - (edges.end ? fade : 0);
  return item.top >= top - SLACK_PX && item.bottom <= bottom + SLACK_PX;
}

/**
 * A mask that fades the area out toward each edge with more past it, so it's clear it scrolls.
 * Undefined when everything is in view.
 */
export function scrollFadeMask(edges: ScrollEdges, axis: ScrollAxis = 'y', size = '1.5rem'): string | undefined {
  if (!edges.start && !edges.end) return undefined;
  const start = edges.start ? `transparent, #000 ${size}` : '#000';
  const end = edges.end ? `#000 calc(100% - ${size}), transparent` : '#000';
  return `linear-gradient(${axis === 'y' ? 'to bottom' : 'to right'}, ${start}, ${end})`;
}
