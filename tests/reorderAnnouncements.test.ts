import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import { reorderAnnouncements } from '../src/services/reorderAnnouncements';

// money-5: a reorder is announced by the names on screen, in Arbor's words, never by the rows' ids.
describe('reorder announcements', () => {
  const max = 'claude-max.json::claude-1';
  const lapsed = 'claude-lapsed.json::claude-2';
  const names: Record<string, string> = { [max]: 'claude-max', [lapsed]: 'claude-lapsed' };
  const { announcements, screenReaderInstructions } = reorderAnnouncements([max, lapsed], (id) => names[String(id)] ?? '', translate);
  const active = { id: max, data: { current: undefined }, rect: { current: { initial: null, translated: null } } };
  const over = { id: lapsed, rect: { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }, disabled: false, data: { current: undefined } };

  it('names rows as they read and says where they are', () => {
    expect(announcements.onDragStart({ active })).toBe('Picked up claude-max, position 1 of 2.');
    expect(announcements.onDragOver({ active, over })).toBe('claude-max is at position 2 of 2.');
    expect(announcements.onDragEnd({ active, over })).toBe('Dropped claude-max at position 2 of 2.');
    expect(announcements.onDragCancel({ active, over: null })).toBe('Moving claude-max canceled. It’s back where it was.');
  });

  it('never says a row’s id', () => {
    const heard = [
      announcements.onDragOver({ active, over: null }),
      announcements.onDragEnd({ active, over: null }),
      screenReaderInstructions.draggable,
    ];
    for (const words of heard) expect(words).not.toContain('.json');
  });
});
