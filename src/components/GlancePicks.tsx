import { useMemo } from 'react';
import { useI18n } from '../i18n';
import { useAccountsStore } from '../services/accountsStore';
import { useFleetMachines } from '../services/fleetHealth';
import { glanceCandidates, setGlanceMachineShown, setGlanceProviderShown, useGlancePicks } from '../services/glance';
import { providerLabel, providerOrder } from '../services/providerLimits';
import { providerForFile, type QuotaProvider } from '../services/quotaService';
import { ChevronDown } from './ui/icons';
import { MachinePill, ProviderMark } from './identity/Identity';
import { Button } from './ui/button';
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuTrigger } from './ui/menu';

/** The providers there are accounts for, which are the ones with a limit to show. */
export function useGlanceProviders(): QuotaProvider[] {
  const { files } = useAccountsStore();
  return useMemo(() => providerOrder.filter((provider) => files.some((file) => providerForFile(file) === provider)), [files]);
}

/** The machines with a host, which are the ones with health to show. */
export function useGlanceMachineNames(): string[] {
  const machines = useFleetMachines();
  return useMemo(() => glanceCandidates(machines ?? []).map((item) => item.machine), [machines]);
}

/** A tick per provider, for the sidebar's menu and Settings. Ticking leaves the menu open, so several can be changed. */
export function ProviderPickItems({ providers }: { providers: readonly QuotaProvider[] }) {
  const { t } = useI18n();
  const { hiddenProviders } = useGlancePicks();
  if (!providers.length) return <MenuItem disabled>{t('glance.picker.noProviders')}</MenuItem>;
  return providers.map((provider) => (
    <MenuCheckboxItem key={provider} checked={!hiddenProviders.includes(provider)} onCheckedChange={(checked) => setGlanceProviderShown(provider, checked)}>
      <ProviderMark provider={provider} decorative />
      {providerLabel[provider]}
    </MenuCheckboxItem>
  ));
}

/** A tick per machine with a host, for the sidebar's menu and Settings. */
export function MachinePickItems({ machines }: { machines: readonly string[] }) {
  const { t } = useI18n();
  const { hiddenMachines } = useGlancePicks();
  if (!machines.length) return <MenuItem disabled>{t('glance.picker.noMachines')}</MenuItem>;
  return machines.map((machine) => (
    <MenuCheckboxItem key={machine} checked={!hiddenMachines.includes(machine)} onCheckedChange={(checked) => setGlanceMachineShown(machine, checked)}>
      <MachinePill name={machine} size="sm" />
    </MenuCheckboxItem>
  ));
}

/** How many of a list are ticked, in a word where it can be: All, None, or "2 of 3". */
function pickedLabel(total: number, hidden: number, t: ReturnType<typeof useI18n>['t']) {
  const shown = total - hidden;
  return shown >= total ? t('glance.picker.all') : shown <= 0 ? t('glance.picker.none') : t('glance.picker.some', { count: shown, total });
}

/** Settings' control for which providers show: a button saying how many, opening their ticks. */
export function ProviderPicker({ label }: { label: string }) {
  const { t } = useI18n();
  const providers = useGlanceProviders();
  const { hiddenProviders } = useGlancePicks();
  const hidden = providers.filter((provider) => hiddenProviders.includes(provider)).length;
  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" size="sm" className="min-w-24 justify-between" aria-label={label} />}>
        {pickedLabel(providers.length, hidden, t)}
        <ChevronDown aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-48">
        <ProviderPickItems providers={providers} />
      </MenuPopup>
    </Menu>
  );
}

/** Settings' control for which machines show. */
export function MachinePicker({ label }: { label: string }) {
  const { t } = useI18n();
  const machines = useGlanceMachineNames();
  const { hiddenMachines } = useGlancePicks();
  const hidden = machines.filter((machine) => hiddenMachines.includes(machine)).length;
  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" size="sm" className="min-w-24 justify-between" aria-label={label} />}>
        {pickedLabel(machines.length, hidden, t)}
        <ChevronDown aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-48">
        <MachinePickItems machines={machines} />
      </MenuPopup>
    </Menu>
  );
}
