/** Stored JSON as an object with string keys, or an empty one when it's missing or anything else. */
export function storedRecord(raw: string | null): Record<string, unknown> {
  const parsed = JSON.parse(raw ?? '{}') as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}
