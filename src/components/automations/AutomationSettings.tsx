import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { invokeCommand } from '../../native/commands';
import { showAutomations, useAutomations } from '../../services/automations';
import { SettingsRow, SettingsSection } from '../layout/settings';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';
import { toast } from '../ui/toast';

const EFFORTS = ['low', 'medium', 'high'] as const;

/** Settings › Machines › Automations: whether Arbor runs its own, and the model that drafts them. */
export function AutomationSettings() {
  const { t } = useI18n();
  const { list } = useAutomations();
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savedModel = list?.draftModel;
  // Follows what's saved, as Settings or the command line changes it.
  useEffect(() => { if (savedModel !== undefined) setModel(savedModel); }, [savedModel]);
  if (!list) return null;

  const run = async (action: () => Promise<void>) => {
    setSaving(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  const saveModel = (nextModel: string, effort: string) => run(async () => {
    showAutomations(await invokeCommand('set_automation_draft_model', { model: nextModel.trim(), effort }));
    toast({ title: t('automations.settings.modelSaved') });
  });

  return (
    <SettingsSection title={t('automations.settings.title')} description={t('automations.settings.description')}>
      <SettingsRow
        settingId="machines.automations-running"
        title={t('automations.settings.running')}
        description={t('automations.settings.runningHint')}
        control={
          <Switch
            checked={list.running}
            disabled={saving}
            aria-label={t('automations.settings.running')}
            onCheckedChange={(running) => void run(async () => { showAutomations(await invokeCommand('set_automations_running', { running })); })}
          />
        }
      />
      <SettingsRow
        settingId="machines.automations-draft-model"
        title={t('automations.settings.model')}
        description={error ?? t('automations.settings.modelHint')}
        control={
          <div className="flex items-center gap-2">
            <Input
              font="mono"
              className="w-40"
              aria-label={t('automations.settings.model')}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && model.trim()) void saveModel(model, list.draftEffort); }}
            />
            <Select value={list.draftEffort} onValueChange={(effort) => void saveModel(model || list.draftModel, String(effort))}>
              <SelectTrigger aria-label={t('automations.settings.effort')} className="w-28"><SelectValue>{t(`automations.effort.${list.draftEffort === 'medium' || list.draftEffort === 'high' ? list.draftEffort : 'low'}`)}</SelectValue></SelectTrigger>
              <SelectPopup>{EFFORTS.map((effort) => <SelectItem key={effort} value={effort}>{t(`automations.effort.${effort}`)}</SelectItem>)}</SelectPopup>
            </Select>
            {model.trim() && model.trim() !== list.draftModel ? (
              <Button size="sm" disabled={saving} onClick={() => void saveModel(model, list.draftEffort)}>{t('common.save')}</Button>
            ) : null}
          </div>
        }
      />
    </SettingsSection>
  );
}
