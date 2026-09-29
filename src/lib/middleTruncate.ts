const DEFAULT_TAIL = 10;
const MAX_SEGMENT_TAIL = 16;
/** The fewest characters worth an ellipsis in front of the tail. */
const MIN_HEAD = 5;

const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);

/**
 * Where to cut a string that's shortened in the middle. A path keeps its last segment when that's short enough to be
 * the part that tells two apart (a file or folder name); anything else keeps a fixed number of characters. Nothing is
 * split when the tail would be most of the string, since the head could then never show enough to be worth an ellipsis.
 *
 * The two halves are laid out apart, and a space at the end of one or the start of the other is dropped there, running
 * the words beside it together ("Claude " and "Sonnet 4.5" read "ClaudeSonnet 4.5"). So a cut next to a space moves
 * back until it sits between two other characters, keeping more of the end rather than less.
 */
export function splitForMiddleTruncate(value: string, tail?: number): { head: string; tail: string } | null {
  // Code points, not UTF-16 units: a cut inside a surrogate pair would leave two broken characters.
  const chars = Array.from(value);
  let keep = tail ?? DEFAULT_TAIL;
  if (tail === undefined) {
    const slash = chars.lastIndexOf('/');
    if (slash > 0 && slash < chars.length - 1) {
      const segment = chars.length - slash - 1;
      keep = segment <= MAX_SEGMENT_TAIL ? segment : DEFAULT_TAIL;
    }
  }
  if (keep <= 0) return null;
  let cut = chars.length - keep;
  while (cut > 0 && (isSpace(chars[cut - 1]) || isSpace(chars[cut]))) cut -= 1;
  if (cut < MIN_HEAD) return null;
  return { head: chars.slice(0, cut).join(''), tail: chars.slice(cut).join('') };
}
