import { useEffect, useState, type CSSProperties } from 'react';
import { NO_SCROLL_EDGES, sameScrollEdges, scrollEdges, scrollFadeMask, scrollPosition, type ScrollAxis, type ScrollEdges } from '../lib/scrollFade';

/**
 * Which edges of a scrolling element have more past them, kept up to date as it scrolls and resizes.
 * Returns a callback ref for the element; the ref can move between elements (the sidebar swaps navs).
 */
export function useScrollEdges<T extends HTMLElement>(axis: ScrollAxis = 'y'): [(element: T | null) => void, ScrollEdges] {
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

  return [setElement, edges];
}

/**
 * Fades a scrolling element's edges while there's more to scroll that way. Returns a callback ref for
 * the element and the style to give it.
 */
export function useScrollFade<T extends HTMLElement>(axis: ScrollAxis = 'y', size?: string): [(element: T | null) => void, CSSProperties | undefined] {
  const [ref, edges] = useScrollEdges<T>(axis);
  const mask = scrollFadeMask(edges, axis, size);
  return [ref, mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined];
}
