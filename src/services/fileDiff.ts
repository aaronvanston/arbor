import { processFile, type FileDiffMetadata } from '@pierre/diffs';
import { createTwoFilesPatch } from 'diff';
import type { MessageKey } from '../i18n/resources';

/**
 * Past this many removed and added lines, working out the fewest changes costs more than it's worth (a pair of
 * 256 KB files with nothing in common takes seconds), so the part between what the copies share at the start and end
 * is shown whole instead.
 */
export const MAX_DIFF_EDITS = 2_000;
/** Unchanged lines kept around each run of changes; the rest fold away and can be opened. */
const CONTEXT = 3;
/** What a missing side is called in a patch, as git and `@pierre/diffs` have it. */
const NO_FILE = '/dev/null';

/**
 * Line endings don't count as a change: a copy saved with CRLF, or without a newline at its end, reads the same. Every
 * line then ends in a newline, which keeps the patch free of "no newline at end of file" markers.
 */
export function normalizeText(text: string): string {
  const unix = text.replace(/\r\n?/g, '\n');
  return unix && !unix.endsWith('\n') ? `${unix}\n` : unix;
}

export type FileDiffModel =
  /** Nothing to show: the copies match once line endings are set aside. */
  | { kind: 'same' }
  /** `whole` when the copies were too far apart to line up, so their differing middle is removed and added whole. */
  | { kind: 'changes'; diff: FileDiffMetadata; whole: boolean };

/**
 * The changes from `before` to `after` for `@pierre/diffs` to draw, where `path` names the file so it's highlighted by
 * its type. A null side hasn't the file at all. Built as `parseDiffFromFile` does, but with a cap on the work.
 */
export function buildFileDiff(path: string, before: string | null, after: string | null, maxEdits = MAX_DIFF_EDITS): FileDiffModel {
  const oldText = normalizeText(before ?? '');
  const newText = normalizeText(after ?? '');
  if (oldText === newText) return { kind: 'same' };
  const oldName = before === null ? NO_FILE : path;
  const newName = after === null ? NO_FILE : path;
  const lined = createTwoFilesPatch(oldName, newName, oldText, newText, undefined, undefined, { context: CONTEXT, maxEditLength: maxEdits });
  const patch = lined ?? wholePatch(oldName, newName, oldText, newText);
  const diff = processFile(patch, {
    oldFile: { name: oldName, contents: oldText },
    newFile: { name: newName, contents: newText },
    throwOnError: true,
  });
  if (!diff) return { kind: 'same' };
  if (before === null) diff.type = 'new';
  else if (after === null) diff.type = 'deleted';
  if (before === null || after === null) diff.prevName = undefined;
  return { kind: 'changes', diff, whole: lined === undefined };
}

const lines = (text: string) => (text ? text.slice(0, -1).split('\n') : []);

/** One hunk that keeps what both copies start and end with and replaces everything between. */
function wholePatch(oldName: string, newName: string, oldText: string, newText: string): string {
  const a = lines(oldText);
  const b = lines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const from = Math.max(0, start - CONTEXT);
  const toA = Math.min(a.length, endA + CONTEXT);
  const toB = endB + (toA - endA);
  const body = [
    ...a.slice(from, start).map((line) => ` ${line}`),
    ...a.slice(start, endA).map((line) => `-${line}`),
    ...b.slice(start, endB).map((line) => `+${line}`),
    ...a.slice(endA, toA).map((line) => ` ${line}`),
  ];
  // A side with no lines in the hunk is numbered from the line before it, as unified diffs have it.
  const range = (count: number) => `${count ? from + 1 : from},${count}`;
  return `--- ${oldName}\n+++ ${newName}\n@@ -${range(toA - from)} +${range(toB - from)} @@\n${body.join('\n')}\n`;
}

/** How many unchanged lines a fold's arrows open at a time, when it hides more than that. */
export const FOLD_STEP = 100;

/** A fold's controls: open it whole, a step of lines above or below it, or all of a large one at once. */
export type FoldControl = 'both' | 'up' | 'down' | 'all';

export type FoldText = { key: MessageKey; count?: number };

/** The lines a fold hides, from `@pierre/diffs`' count of them ("26 unmodified lines"), or null when it has none. */
export function foldedLines(text: string | null | undefined): number | null {
  const digits = /^\s*(\d[\d,]*)\s/.exec(text ?? '')?.[1];
  if (!digits) return null;
  const lines = Number(digits.replace(/,/g, ''));
  return Number.isSafeInteger(lines) ? lines : null;
}

/** What a fold says it hides. */
export function foldText(lines: number | null): FoldText {
  if (lines === null) return { key: 'fileView.fold.unknown' };
  return { key: lines === 1 ? 'fileView.fold.lines.one' : 'fileView.fold.lines.other', count: lines };
}

/**
 * What a fold's control does, as its name. A fold of up to FOLD_STEP lines has one control, which opens all of it; a
 * larger one (`chunked`, and still so once partly opened) opens FOLD_STEP lines above or below it at a time, or what's
 * left when that's fewer, or all of them.
 */
export function foldControlName(control: FoldControl, chunked: boolean, lines: number | null): FoldText {
  if (chunked && (control === 'up' || control === 'down')) {
    const step = Math.min(FOLD_STEP, lines ?? FOLD_STEP);
    const key = control === 'up'
      ? step === 1 ? 'fileView.fold.above.one' : 'fileView.fold.above.other'
      : step === 1 ? 'fileView.fold.below.one' : 'fileView.fold.below.other';
    return { key, count: step };
  }
  if (lines === null) return { key: 'fileView.fold.showUnknown' };
  if (chunked) return { key: 'fileView.fold.showAll', count: lines };
  return { key: lines === 1 ? 'fileView.fold.show.one' : 'fileView.fold.show.other', count: lines };
}
