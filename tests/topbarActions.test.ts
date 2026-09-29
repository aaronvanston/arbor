import { describe, expect, it } from 'bun:test';
import { foldedActionCount } from '../src/services/topbarActions';

const layout = { pinned: 100, gap: 8, more: 28 };

describe('a page top bar short of room', () => {
  it('keeps every action in the bar while they fit beside the pinned ones', () => {
    // 200 + 8 + 150 + 8 + 100
    expect(foldedActionCount([200, 150], 466, layout)).toBe(0);
    expect(foldedActionCount([], 100, layout)).toBe(0);
    expect(foldedActionCount([200, 150], 358, { ...layout, pinned: 0 })).toBe(0);
  });

  it('moves the last actions into ⋯ first, and only as many as it takes, leaving room for the ⋯ button', () => {
    // One short: the last goes, and the first fits with ⋯: 200 + 8 + 28 + 8 + 100.
    expect(foldedActionCount([200, 150], 465, layout)).toBe(1);
    expect(foldedActionCount([200, 150], 344, layout)).toBe(1);
    // Not even the first fits beside ⋯.
    expect(foldedActionCount([200, 150], 343, layout)).toBe(2);
  });

  it('folds everything when nothing fits, pinned actions included', () => {
    expect(foldedActionCount([200, 150, 90], 50, layout)).toBe(3);
  });

  it('forgives the half pixel measured widths can round by', () => {
    expect(foldedActionCount([200.4, 150], 466, layout)).toBe(0);
  });
});
