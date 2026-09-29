import { useEffect, useState, type CSSProperties } from 'react';
import { NO_SCROLL_EDGES, sameScrollEdges, scrollEdges, scrollFadeMask, scrollPosition, type ScrollAxis, type ScrollEdges } from '../lib/scrollFade';

/**
 * Fades a scrolling element's edges while there's more to scroll that way. Returns a callback ref for
 * the element and the style to give it; the ref can move between elements (the sidebar swaps navs).
 */
export function useScrollFade<T extends HTMLElement>(axis: ScrollAxis = 'y', size?: string): [(element: T | null) => void, CSSProperties | undefined] {
  const [element, setElement] = useState<T | null>(null);
  const [edges, setEdges] = useState<ScrollEdges>(NO_SCROLL_EDGES);

  useEffect(() => {
    if (!element) {
      setEdges(NO_SCROLL_EDGES);
      return;
    }
    const update = () => {
      const next = scrollEdges(scrollPosition(element, axis));
      setEdges((current) => (sameScrollEdges(current, next) ? current : next));
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    // The area's own size changes with the window and its neighbors; its content with what it holds.
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => {
      element.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [element, axis]);

  const mask = scrollFadeMask(edges, axis, size);
  return [setElement, mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined];
}
