import { describe, expect, it } from 'bun:test';
import type { FileDiffMetadata } from '@pierre/diffs';
import { en } from '../src/i18n/locales/en';
import { buildFileDiff, foldControlName, foldedLines, foldText, normalizeText, type FoldText } from '../src/services/fileDiff';
import { itemAt } from './support/items';

const changes = (path: string, before: string | null, after: string | null, maxEdits?: number) => {
  const model = buildFileDiff(path, before, after, maxEdits);
  if (model.kind !== 'changes') throw new Error(`expected changes, got ${model.kind}`);
  return model;
};

/** Removed and added lines across every hunk. */
const counts = (diff: FileDiffMetadata) => diff.hunks.reduce(
  (total, hunk) => ({ removed: total.removed + hunk.deletionLines, added: total.added + hunk.additionLines }),
  { removed: 0, added: 0 },
);

describe('file diffs', () => {
  it('reads line endings, and a missing final newline, as no change', () => {
    expect(normalizeText('a\r\nb\rc')).toBe('a\nb\nc\n');
    expect(normalizeText('')).toBe('');
    expect(buildFileDiff('CLAUDE.md', 'a\r\nb\r\n', 'a\nb')).toEqual({ kind: 'same' });
    expect(buildFileDiff('CLAUDE.md', '', '')).toEqual({ kind: 'same' });
  });

  it('marks the lines removed and added, with the whole of both copies to open unchanged stretches from', () => {
    const { diff, whole } = changes('~/.claude/CLAUDE.md', 'a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(whole).toBe(false);
    expect(diff.type).toBe('change');
    expect(diff.isPartial).toBe(false);
    expect(diff.name).toBe('~/.claude/CLAUDE.md');
    expect(counts(diff)).toEqual({ removed: 1, added: 2 });
    expect(diff.deletionLines.join('')).toBe('a\nb\nc\n');
    expect(diff.additionLines.join('')).toBe('a\nB\nc\nd\n');
  });

  it('shows a file only one side has as added or removed whole', () => {
    const added = changes('SKILL.md', null, 'one\ntwo\n').diff;
    expect([added.type, added.prevName, counts(added)]).toEqual(['new', undefined, { removed: 0, added: 2 }]);
    const removed = changes('SKILL.md', 'one\n', null).diff;
    expect([removed.type, counts(removed)]).toEqual(['deleted', { removed: 1, added: 0 }]);
  });

  it('keeps a few unchanged lines around each run of changes, numbered as each copy has them', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
    const after = before.replace('line 2\n', 'line two\n').replace('line 18\n', 'line eighteen\n');
    const { diff } = changes('notes.md', before, after);
    expect(diff.hunks.length).toBe(2);
    expect([itemAt(diff.hunks, 0).deletionStart, itemAt(diff.hunks, 0).deletionCount]).toEqual([1, 5]);
    expect([itemAt(diff.hunks, 1).deletionStart, itemAt(diff.hunks, 1).additionStart]).toEqual([15, 15]);
    // Two changes close together share one run.
    expect(changes('notes.md', before, before.replace('line 9\n', 'nine\n').replace('line 13\n', 'thirteen\n')).diff.hunks.length).toBe(1);
  });

  it('finds the fewest changes', () => {
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    const text = () => Array.from({ length: Math.floor(random() * 9) }, () => 'abc'[Math.floor(random() * 3)]).join('\n');
    const lcs = (a: string[], b: string[]) => {
      const table = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
      for (let i = 1; i <= a.length; i += 1) {
        for (let j = 1; j <= b.length; j += 1) {
          const row = itemAt(table, i);
          const above = itemAt(table, i - 1);
          row[j] = a[i - 1] === b[j - 1] ? itemAt(above, j - 1) + 1 : Math.max(itemAt(above, j), itemAt(row, j - 1));
        }
      }
      return itemAt(itemAt(table, a.length), b.length);
    };
    for (let round = 0; round < 300; round += 1) {
      const before = text();
      const after = text();
      const model = buildFileDiff('x.txt', before, after);
      const a = before ? before.split('\n') : [];
      const b = after ? after.split('\n') : [];
      const edits = model.kind === 'same' ? 0 : counts(model.diff).removed + counts(model.diff).added;
      expect(edits).toBe(a.length + b.length - 2 * lcs(a, b));
    }
  });

  it('replaces the whole middle when the copies are too far apart to line up, keeping what they share', () => {
    const { diff, whole } = changes('CLAUDE.md', 'keep\na\nb\nend\n', 'keep\nx\ny\nend\n', 1);
    expect(whole).toBe(true);
    expect(diff.isPartial).toBe(false);
    expect(counts(diff)).toEqual({ removed: 2, added: 2 });
    const hunk = itemAt(diff.hunks, 0);
    expect([hunk.deletionStart, hunk.deletionCount, hunk.additionStart, hunk.additionCount]).toEqual([1, 4, 1, 4]);
    expect(changes('CLAUDE.md', 'keep\na\nb\nend\n', 'keep\nx\ny\nend\n').whole).toBe(false);
  });

  it('gives up lining up large files that have little in common, rather than hanging', () => {
    const before = Array.from({ length: 6_000 }, (_, index) => `line ${index}`).join('\n');
    const after = Array.from({ length: 6_000 }, (_, index) => (index % 3 ? `line ${index}` : `changed ${index}`)).join('\n');
    const model = changes('big.txt', before, after);
    expect(model.whole).toBe(true);
    // The first line differs, so nothing is shared at the start; the last two match, so they stay unchanged.
    expect(counts(model.diff)).toEqual({ removed: 5_998, added: 5_998 });
  });
});

describe('folded unchanged lines', () => {
  const words = ({ key, count }: FoldText) => en[key].replace('{count}', String(count));

  it('are counted from what the diff draws, whether its words or Arbor’s', () => {
    expect(foldedLines('26 unmodified lines')).toBe(26);
    expect(foldedLines('1 unmodified line')).toBe(1);
    expect(foldedLines('1,207 unchanged lines')).toBe(1_207);
    for (const text of ['More unchanged context may be available', 'Unchanged lines', '', null, undefined]) expect(foldedLines(text)).toBeNull();
    expect(words(foldText(26))).toBe('26 unchanged lines');
    expect(words(foldText(1))).toBe('1 unchanged line');
    expect(words(foldText(null))).toBe('Unchanged lines');
  });

  it('name their controls by what a press shows', () => {
    // A fold no bigger than a step opens whole, whichever way its control points.
    for (const control of ['both', 'up', 'down'] as const) expect(words(foldControlName(control, false, 26))).toBe('Show 26 unchanged lines');
    expect(words(foldControlName('both', false, 1))).toBe('Show 1 unchanged line');
    // A bigger one opens a step above or below it at a time, or all of it.
    expect(words(foldControlName('up', true, 207))).toBe('Show 100 lines above');
    expect(words(foldControlName('down', true, 207))).toBe('Show 100 lines below');
    expect(words(foldControlName('all', true, 207))).toBe('Show all 207 unchanged lines');
    // Once partly opened it's still drawn that way, so a step says what's left.
    expect(words(foldControlName('up', true, 7))).toBe('Show 7 lines above');
    expect(words(foldControlName('down', true, 1))).toBe('Show 1 line below');
    expect(words(foldControlName('both', false, null))).toBe('Show the unchanged lines');
  });
});
