/**
 * How many of a page top bar's collapsible actions go into its ⋯ menu, counted from the last one, so the rest fit in
 * `room` beside the pinned actions (`pinned` wide, 0 for none) instead of scrolling or being cut off. None when they
 * all fit; otherwise as few as leave room for the ⋯ button (`more` wide) as well. Items sit `gap` apart. Widths are in
 * CSS pixels, as measured.
 */
export function foldedActionCount(widths: readonly number[], room: number, { pinned, gap, more }: { pinned: number; gap: number; more: number }): number {
  const fits = (shown: number, withMore: boolean) => {
    const parts = [...widths.slice(0, shown), ...(withMore ? [more] : []), ...(pinned > 0 ? [pinned] : [])];
    const width = parts.reduce((sum, part) => sum + part, 0) + gap * Math.max(0, parts.length - 1);
    // Half a pixel's grace for the rounding in measured widths.
    return width <= room + 0.5;
  };
  if (fits(widths.length, false)) return 0;
  for (let shown = widths.length - 1; shown > 0; shown -= 1) {
    if (fits(shown, true)) return widths.length - shown;
  }
  return widths.length;
}
