import type { Announcements, ScreenReaderInstructions } from '@dnd-kit/core';
import type { MessageKey, MessageVariables } from '../i18n/resources';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;
type Id = string | number;

/**
 * What a screen reader hears while a list is reordered. Rows are keyed by ids nobody should hear
 * ("claude-max.json::claude-1"), so each is named as it's shown, and its place given as a position in the list.
 */
export function reorderAnnouncements(ids: readonly Id[], nameOf: (id: Id) => string, t: Translate): {
  announcements: Announcements;
  screenReaderInstructions: ScreenReaderInstructions;
} {
  const position = (id: Id | undefined) => (id === undefined ? 0 : ids.indexOf(id) + 1);
  const at = (active: Id, over: Id | undefined) => {
    const place = position(over);
    return place ? t('reorder.position', { name: nameOf(active), position: place, count: ids.length }) : t('reorder.outside', { name: nameOf(active) });
  };
  return {
    announcements: {
      onDragStart: ({ active }) => t('reorder.pickedUp', { name: nameOf(active.id), position: position(active.id), count: ids.length }),
      onDragOver: ({ active, over }) => at(active.id, over?.id),
      onDragEnd: ({ active, over }) => {
        const place = position(over?.id);
        return place ? t('reorder.dropped', { name: nameOf(active.id), position: place, count: ids.length }) : t('reorder.canceled', { name: nameOf(active.id) });
      },
      onDragCancel: ({ active }) => t('reorder.canceled', { name: nameOf(active.id) }),
    },
    screenReaderInstructions: { draggable: t('reorder.instructions') },
  };
}
