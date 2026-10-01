import { describe, expect, test } from 'bun:test';
import { clearOfFade, scrollEdges, scrollFadeMask, scrollPosition } from '../src/lib/scrollFade';

describe('scroll fade', () => {
  test('an area that fits has nothing past either edge', () => {
    expect(scrollEdges({ offset: 0, content: 400, view: 400 })).toEqual({ start: false, end: false });
    expect(scrollFadeMask({ start: false, end: false })).toBeUndefined();
  });

  test('content longer than its area shows more past the end until it reaches it', () => {
    expect(scrollEdges({ offset: 0, content: 640, view: 400 })).toEqual({ start: false, end: true });
    expect(scrollEdges({ offset: 120, content: 640, view: 400 })).toEqual({ start: true, end: true });
    expect(scrollEdges({ offset: 240, content: 640, view: 400 })).toEqual({ start: true, end: false });
  });

  test('sub-pixel leftovers from zoom or fractional sizes don’t count as more to scroll', () => {
    expect(scrollEdges({ offset: 0.5, content: 400.6, view: 400 })).toEqual({ start: false, end: false });
    expect(scrollEdges({ offset: 239.4, content: 640, view: 400 })).toEqual({ start: true, end: false });
    // WebKit reports whole pixels, so a two-option menu at 120% measures 65 tall in a 64 box.
    expect(scrollEdges({ offset: 0, content: 65, view: 64 })).toEqual({ start: false, end: false });
  });

  test('each axis reads its own scroll position', () => {
    const element = { scrollTop: 10, scrollHeight: 500, clientHeight: 300, scrollLeft: 0, scrollWidth: 320, clientWidth: 200 } as Element;
    expect(scrollPosition(element, 'y')).toEqual({ offset: 10, content: 500, view: 300 });
    expect(scrollPosition(element, 'x')).toEqual({ offset: 0, content: 320, view: 200 });
  });

  test('only the edges with more past them fade, down a list or across a row', () => {
    expect(scrollFadeMask({ start: false, end: true })).toBe('linear-gradient(to bottom, #000, #000 calc(100% - 1.5rem), transparent)');
    expect(scrollFadeMask({ start: true, end: false })).toBe('linear-gradient(to bottom, transparent, #000 1.5rem, #000)');
    expect(scrollFadeMask({ start: true, end: true }, 'y', '2rem')).toBe('linear-gradient(to bottom, transparent, #000 2rem, #000 calc(100% - 2rem), transparent)');
    expect(scrollFadeMask({ start: true, end: false }, 'x', '1rem')).toBe('linear-gradient(to right, transparent, #000 1rem, #000)');
  });

  test('an item is clear of the fades only when neither faded edge covers it', () => {
    const area = { top: 52, bottom: 701 };
    const both = { start: true, end: true };
    expect(clearOfFade({ top: 300, bottom: 332 }, area, both, 24)).toBe(true);
    // Under the fade at the foot of the nav, or past it altogether.
    expect(clearOfFade({ top: 669, bottom: 701 }, area, both, 24)).toBe(false);
    expect(clearOfFade({ top: 714, bottom: 746 }, area, both, 24)).toBe(false);
    expect(clearOfFade({ top: 60, bottom: 92 }, area, both, 24)).toBe(false);
    // Scrolled to an end, that edge doesn't fade, so a row can sit against it.
    expect(clearOfFade({ top: 661, bottom: 693 }, area, { start: true, end: false }, 24)).toBe(true);
    expect(clearOfFade({ top: 60, bottom: 92 }, area, { start: false, end: true }, 24)).toBe(true);
  });
});
