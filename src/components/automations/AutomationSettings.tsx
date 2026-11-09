import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { invokeCommand } from '../../native/commands';
import {
  RUNNER_STATE_LABEL,
  RUNNER_STATE_TONE,
  canInstallRunner,
  runnerPrunesHistory,
  runnerState,
  showAutomations,
  useAutomations,
} from '../../services/automations';
import { effortChoices, effortForModel, effortLabelKey, findModelChoice, useModelChoices } from '../../services/modelPicker';
import { useConfirmation } from '../ConfirmationDialog';
import { ModelPicker } from '../ModelPicker';
import { MachinePill } from '../identity/Identity';
import { SettingsRow, SettingsSection } from '../layout/settings';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../ui/select';
import { Spinner } from '../ui/spinner';
import { StatusDot } from '../ui/status-dot';
import { Switch } from '../ui/switch';
import { toast } from '../ui/toast';
import { plainError } from '../../services/plainError';

/** Settings › Machines › Automations: whether Arbor runs its own, and the model that drafts them. */
export function AutomationSettings() {
  const { t } = useI18n();
  const { list } = useAutomations();
  const { askConfirmation } = useConfirmation();
  const models = useModelChoices(t);
  const [address, setAddress] = useState(() => list?.proxyAddress ?? '');
  const [addressError, setAddressError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<{ machine: string; error: string } | null>(null);
  const savedAddress = list?.proxyAddress;
  useEffect(() => { if (savedAddress !== undefined) setAddress(savedAddress); }, [savedAddress]);
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
  const saveModel = (model: string, effort: string) => run(async () => {
    showAutomations(await invokeCommand('set_automation_draft_model', { model, effort }));
    toast({ title: t('automations.settings.modelSaved') });
  });
  // The drafting model as the proxy lists it; null for a name it doesn't have, or while its list isn't read.
  const draftChoice = findModelChoice(models.choices, list.draftModel);
  const efforts = effortChoices(draftChoice, list.draftEffort);
  const effortName = (effort: string) => {
    const key = effortLabelKey(effort);
    return key ? t(key) : effort;
  };

  const addKey = async () => {
    if (!(await askConfirmation({
      title: t('automations.proxy.addTitle'),
      message: t('automations.proxy.addMessage'),
      confirmText: t('automations.proxy.add'),
    }))) return;
    await run(async () => {
      showAutomations(await invokeCommand('add_automations_key'));
      toast({ title: t('automations.proxy.added') });
    });
  };
  const saveAddress = async () => {
    setSaving(true);
    setAddressError(null);
    try {
      showAutomations(await invokeCommand('set_automation_proxy_address', { address: address.trim() }));
      toast({ title: t('automations.proxy.addressSaved') });
    } catch (reason) {
      setAddressError(plainError(reason, t));
    } finally {
      setSaving(false);
    }
  };
  const addressChanged = address.trim() !== list.proxyAddress;

  const install = async (machine: string, update: boolean | 'skill', prunes: boolean) => {
    if (prunes && !(await askConfirmation({
      title: t('automations.runner.prune.title', { machine }),
      message: t('automations.runner.prune.message', { machine }),
      confirmText: t('automations.runner.prune.confirm'),
    }))) return;
    setInstalling(machine);
    setInstallError(null);
    try {
      showAutomations(await invokeCommand('install_background_runner', { machine }));
      toast({ title: t(update === 'skill' ? 'automations.runner.skillAdded' : update ? 'automations.runner.updated' : 'automations.runner.installed', { machine }) });
    } catch (reason) {
      setInstallError({ machine, error: plainError(reason, t) });
    } finally {
      setInstalling(null);
    }
  };
  const bundled = list.udianBundled;

  return (
    <SettingsSection title={t('automations.settings.title')} description={t('automations.settings.description')}>
      <SettingsRow
        settingId="machines.automations-runner"
        align="start"
        title={t('automations.runner.title')}
        description={bundled ? t('automations.runner.description', { version: bundled }) : t('automations.runner.noBundle')}
      >
        <ul className="divide-y divide-border/60 rounded-lg border border-border/70">
          {list.scans.map((scan) => {
            const state = runnerState(scan, bundled, list.udianSkill);
            const busy = installing === scan.machine;
            // Writing the schedules is tried again every round, so its failure says so rather than reading as a dead machine.
            const failed = installError?.machine === scan.machine ? installError.error
              : scan.placingError ? t('automations.runner.placingFailed', { error: plainError(scan.placingError, t) }) : null;
            return (
              <li key={scan.machine} className="flex flex-col gap-1 px-3 py-2">
                <div className="flex items-center gap-3">
                  <MachinePill name={scan.machine} />
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
                    <StatusDot tone={RUNNER_STATE_TONE[state]} />
                    {t(RUNNER_STATE_LABEL[state])}
                    {scan.udian?.version ? <span className="tabular-nums">· {scan.udian.version}</span> : null}
                  </span>
                  {bundled && canInstallRunner(state) ? (
                    <Button size="xs" variant="outline" disabled={installing !== null} onClick={() => void install(scan.machine, state === 'noSkill' ? 'skill' : state !== 'missing', runnerPrunesHistory(scan))}>
                      {busy ? <Spinner /> : null}
                      {t(state === 'missing' ? 'automations.runner.install' : state === 'stopped' ? 'automations.runner.restart' : state === 'noSkill' ? 'automations.runner.addSkill' : 'automations.runner.update')}
                    </Button>
                  ) : null}
                </div>
                {failed ? <p className="text-xs text-error-foreground" role="alert">{failed}</p> : null}
              </li>
            );
          })}
        </ul>
      </SettingsRow>
      <SettingsRow
        settingId="machines.automations-proxy-key"
        title={t('automations.proxy.key')}
        description={t('automations.proxy.keyHint')}
        control={list.proxyKey ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot tone="success" />
            {t('automations.proxy.keyReady')}
          </span>
        ) : (
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <StatusDot tone="warning" />
              {t('automations.proxy.keyMissing')}
            </span>
            <Button size="sm" disabled={saving} onClick={() => void addKey()}>{t('automations.proxy.add')}</Button>
          </div>
        )}
      />
      <SettingsRow
        settingId="machines.automations-proxy-address"
        title={t('automations.proxy.address')}
        description={addressError ?? t('automations.proxy.addressHint')}
        control={
          <div className="flex items-center gap-2">
            <Input
              font="mono"
              className="w-64"
              aria-label={t('automations.proxy.address')}
              placeholder={t('automations.proxy.addressPlaceholder')}
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && addressChanged) void saveAddress(); }}
              // Saved on leaving the field, like other inline fields, unless it's for its own Save button.
              onBlur={(event) => { if (addressChanged && !saving && event.relatedTarget?.getAttribute('data-save') !== 'proxy-address') void saveAddress(); }}
            />
            {addressChanged ? <Button size="sm" data-save="proxy-address" disabled={saving} onClick={() => void saveAddress()}>{t('common.save')}</Button> : null}
          </div>
        }
      />
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
            <ModelPicker
              className="w-52"
              aria-label={t('automations.settings.model')}
              value={list.draftModel}
              models={models}
              onRetry={models.reload}
              disabled={saving}
              // A model that doesn't take the effort in use starts on one it does.
              onChange={(model) => void saveModel(model, effortForModel(findModelChoice(models.choices, model), list.draftEffort))}
            />
            {efforts.length ? (
              <Select value={list.draftEffort} disabled={saving} onValueChange={(effort) => void saveModel(list.draftModel, String(effort))}>
                <SelectTrigger aria-label={t('automations.settings.effort')} className="w-28"><SelectValue>{list.draftEffort ? effortName(list.draftEffort) : t('modelPicker.effort.pick')}</SelectValue></SelectTrigger>
                <SelectPopup>{efforts.map((effort) => <SelectItem key={effort} value={effort}>{effortName(effort)}</SelectItem>)}</SelectPopup>
              </Select>
            ) : (
              // A model with no say over its reasoning: the control stays, so the row doesn't jump, and says why.
              <Select value="" disabled>
                <SelectTrigger aria-label={t('automations.settings.effort')} className="w-28" title={t('modelPicker.effort.unsupportedHint')}><SelectValue>{t('modelPicker.effort.unsupported')}</SelectValue></SelectTrigger>
              </Select>
            )}
          </div>
        }
      />
    </SettingsSection>
  );
}
