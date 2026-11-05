import { toast } from './ui/toast';
import type { MessageKey } from '../i18n/resources';
import { loadAccountFiles } from '../services/accountsStore';
import { changedModels, undoAccessChanges, type ExclusionChange } from '../services/extraModelAccess';

type Translate = (key: MessageKey, variables?: Record<string, string | number>) => string;

/**
 * Says which accounts Arbor stopped sending a model to, with Undo. Undoing sends it to them again and leaves it that
 * way, rather than taking it back out at the next check.
 */
export function announceAccessChanges(changes: ExclusionChange[], t: Translate, onUndone?: () => void) {
  if (changes.length === 0) return;
  void loadAccountFiles();
  const models = changedModels(changes);
  // One model kept from accounts, and nothing given back, reads best by the model's name.
  const [model] = models.length === 1 && changes.every((change) => change.before.every((rule) => change.after.includes(rule))) ? models : [];
  toast({
    kind: 'success',
    title: model ? t('extraModels.access.routed', { model }) : t('extraModels.access.updated', { count: changes.length }),
    action: {
      label: t('common.undo'),
      onClick: () => {
        void undoAccessChanges(changes, true)
          .then(() => {
            if (model) toast({ kind: 'success', title: t('extraModels.access.restored', { model }) });
            onUndone?.();
          })
          .catch((error) => toast({ kind: 'error', title: t('extraModels.access.failed', { error: String(error) }) }))
          .finally(() => void loadAccountFiles());
      },
    },
  });
}
