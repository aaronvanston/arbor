import { useState } from 'react';
import { useI18n } from '../../i18n';
import { automationView, automationsView, type AppView } from '../../navigation';
import { invokeCommand } from '../../native/commands';
import type { AutomationSummary } from '../../native/types';
import { automationTargetGone, loadAutomations, showAutomations } from '../../services/automations';
import { usePools } from '../../services/pools';
import { useConfirmation } from '../ConfirmationDialog';
import { Button } from '../ui/button';
import { CirclePause, CirclePlay, Copy, MoreHorizontal, Pencil, Play, Trash2 } from '../ui/icons';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '../ui/menu';
import { toast } from '../ui/toast';
import { AutomationDialog } from './AutomationDialog';

/**
 * What can be done with an automation, as far as the app that keeps it allows: run it now, pause or resume it, edit
 * it, copy it into Arbor, or delete it. `compact` is the list's ⋯ menu; otherwise the page's buttons and the rest in ⋯.
 */
export function AutomationActions({ item, onNavigate, compact = false }: {
  item: AutomationSummary;
  onNavigate: (view: AppView) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const { askConfirmation, askChoice } = useConfirmation();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const { abilities } = item;
  // One with nowhere to run can't be started by hand either; it says why until it's given a machine or a pool.
  const { pools } = usePools();
  const gone = automationTargetGone(item, pools);
  const goneReason = gone ? t(gone === 'best' ? 'automations.note.bestGone' : 'automations.note.poolGone') : undefined;

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast({ title: t('automations.action.failed'), description: String(error), kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // Pausing is undone as easily as it's done, so it happens straight away with Undo.
  const setEnabled = (enabled: boolean) => act(async () => {
    showAutomations(await invokeCommand('set_automation_enabled', { id: item.id, enabled }));
    toast({
      title: t(enabled ? 'automations.resumed' : 'automations.pausedOne', { name: item.name }),
      action: {
        label: t('common.undo'),
        onClick: () => { void invokeCommand('set_automation_enabled', { id: item.id, enabled: !enabled }).then(showAutomations); },
      },
    });
  });

  // A run spends tokens on the machine, so it's asked first.
  const runNow = () => act(async () => {
    const confirmed = await askConfirmation({
      title: t('automations.runNow.title', { name: item.name }),
      message: t(item.source !== 'arbor' ? 'automations.runNow.messageOther' : item.hasPrecheck ? 'automations.runNow.message' : 'automations.runNow.messageNoCheck'),
      confirmText: t('automations.runNow.confirm'),
    });
    if (!confirmed) return;
    await invokeCommand('run_automation_now', { id: item.id });
    // The list is read again so the automation's page, which reads its runs whenever the list changes, shows this one
    // at once rather than at the runner's next word.
    await loadAutomations();
    toast({ title: t('automations.runNow.started', { name: item.name }) });
    onNavigate(automationView(item.id));
  });

  const copyIntoArbor = () => act(async () => {
    // Only an original Arbor can pause is offered paused, so only then does the message say it can be.
    const canPause = abilities.pause && item.enabled;
    const choice = await askChoice({
      title: t('automations.copy.title', { name: item.name }),
      message: t(canPause ? 'automations.copy.message' : 'automations.copy.messageKeep'),
      confirmText: abilities.pause && item.enabled ? t('automations.copy.confirmPause') : t('automations.copy.confirm'),
      ...(abilities.pause && item.enabled ? { secondaryText: t('automations.copy.keepBoth') } : {}),
    });
    if (choice === 'cancel') return;
    const copy = await invokeCommand('copy_automation_into_arbor', { id: item.id, pauseOriginal: choice === 'confirm' && abilities.pause && item.enabled });
    showAutomations(await invokeCommand('list_automations'));
    toast({ title: t('automations.copy.done', { name: copy.summary.name }) });
    onNavigate(automationView(copy.summary.id));
  });

  // Its runs go with it, which can't be put back.
  const remove = () => act(async () => {
    const confirmed = await askConfirmation({
      title: t('automations.delete.title', { name: item.name }),
      message: t('automations.delete.message'),
      confirmText: t('automations.delete.confirm'),
      variant: 'danger',
    });
    if (!confirmed) return;
    showAutomations(await invokeCommand('delete_automation', { id: item.id }));
    toast({ title: t('automations.delete.done', { name: item.name }) });
    onNavigate(automationsView());
  });

  const menuItems = (
    <>
      {compact && abilities.runNow ? <MenuItem disabled={Boolean(gone)} onClick={() => void runNow()}><Play />{t('automations.runNow.action')}</MenuItem> : null}
      {compact && abilities.edit ? <MenuItem onClick={() => setEditing(true)}><Pencil />{t('automations.edit')}</MenuItem> : null}
      {compact && abilities.pause ? (
        <MenuItem onClick={() => void setEnabled(!item.enabled)}>
          {item.enabled ? <CirclePause /> : <CirclePlay />}
          {t(item.enabled ? 'automations.pause' : 'automations.resume')}
        </MenuItem>
      ) : null}
      {abilities.copy ? <MenuItem onClick={() => void copyIntoArbor()}><Copy />{t('automations.copy.action')}</MenuItem> : null}
      {abilities.delete ? (
        <>
          {compact ? <MenuSeparator /> : null}
          <MenuItem variant="destructive" onClick={() => void remove()}><Trash2 />{t('automations.delete.action')}</MenuItem>
        </>
      ) : null}
    </>
  );
  const hasMenu = compact
    ? abilities.runNow || abilities.edit || abilities.pause || abilities.copy || abilities.delete
    : abilities.copy || abilities.delete;

  return (
    <div className="flex items-center justify-end gap-2">
      {!compact && abilities.runNow ? (
        <Button variant="outline" size="sm" disabled={busy || Boolean(gone)} disabledReason={goneReason} onClick={() => void runNow()}>
          <Play />
          {t('automations.runNow.action')}
        </Button>
      ) : null}
      {!compact && abilities.pause ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void setEnabled(!item.enabled)}>
          {item.enabled ? <CirclePause /> : <CirclePlay />}
          {t(item.enabled ? 'automations.pause' : 'automations.resume')}
        </Button>
      ) : null}
      {!compact && abilities.edit ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(true)}>
          <Pencil />
          {t('automations.edit')}
        </Button>
      ) : null}
      {hasMenu ? (
        <Menu>
          <MenuTrigger render={<Button variant={compact ? 'ghost-muted' : 'outline'} size={compact ? 'icon-xs' : 'icon-sm'} disabled={busy} aria-label={t('automations.more', { name: item.name })} />}>
            <MoreHorizontal />
          </MenuTrigger>
          <MenuPopup align="end">{menuItems}</MenuPopup>
        </Menu>
      ) : null}
      {editing ? <AutomationDialog open onOpenChange={setEditing} editing={item.id} onSaved={() => undefined} /> : null}
    </div>
  );
}
