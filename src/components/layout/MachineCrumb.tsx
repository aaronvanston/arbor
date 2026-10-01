import { MachinePill } from '../identity/Identity';
import { ChevronDown } from '../ui/icons';
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '../ui/menu';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n';
import { useFleetHealth } from '../../services/fleetHealth';
import { setSettingsScope, useSettingsScope } from '../../services/machineSettings';
import { machineName } from '../../services/machineNames';
import { archiveMachines, getSessionArchiveStatus } from '../../services/sessionArchive';

/** What Arbor calls the sessions and requests no machine claims, as the view's `machine` holds it. */
const UNASSIGNED = '__unassigned__';

/**
 * The breadcrumb's last step on a view that can be looked at for one machine or all (`Sessions / Live / All
 * machines`): the machine it's narrowed to as its pill, or All machines, and a menu to pick another. `''` is all of
 * them. `unassigned` adds what no machine claims.
 */
export function MachineCrumb({ machine, machines, unassigned = false, all = true, onChange }: {
  machine: string;
  /** The machines to pick from, in the order they're shown. */
  machines: readonly string[];
  unassigned?: boolean;
  /** Offers All machines; a view that only ever shows one machine (Arbor's changes) leaves it out. */
  all?: boolean;
  onChange: (machine: string) => void;
}) {
  const { t } = useI18n();
  // One picked that isn't listed (gone from this range, or opened from an old link) stays a choice, so it shows ticked.
  const listed = machine && machine !== UNASSIGNED && !machines.includes(machine) ? [...machines, machine] : machines;
  return (
    <Menu>
      <MenuTrigger
        className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-accent"
        aria-label={t('machineCrumb.label')}
      >
        {machine && machine !== UNASSIGNED ? (
          <MachinePill name={machine} />
        ) : (
          <span className="truncate">{t(machine ? 'usage.filter.unassigned' : 'usage.filter.allMachines')}</span>
        )}
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-48">
        <MenuRadioGroup value={machine} onValueChange={(next: string) => onChange(next)}>
          {all ? (
            <>
              <MenuRadioItem closeOnClick value="">{t('usage.filter.allMachines')}</MenuRadioItem>
              {listed.length ? <MenuSeparator /> : null}
            </>
          ) : null}
          {listed.map((name) => (
            <MenuRadioItem closeOnClick key={name} value={name}><MachinePill name={name} /></MenuRadioItem>
          ))}
          {unassigned ? (
            <>
              <MenuSeparator />
              <MenuRadioItem closeOnClick value={UNASSIGNED}>{t('usage.filter.unassigned')}</MenuRadioItem>
            </>
          ) : null}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/**
 * The Machines page's picker: every machine with a host, as the sidebar lists them under Machines, and `known` (the
 * ones with requests). Picking one opens its page; All machines is the fleet overview.
 */
export function FleetMachineCrumb({ machine, known, onChange }: {
  machine: string;
  known: readonly string[];
  onChange: (machine: string) => void;
}) {
  const health = useFleetHealth();
  const choices = useMemo(() => {
    const hosts = (health ?? []).map((entry) => entry.machine).filter(Boolean);
    return [...new Set([...hosts, ...known])].sort((left, right) => machineName(left).localeCompare(machineName(right)));
  }, [health, known]);
  return <MachineCrumb machine={machine} machines={choices} onChange={onChange} />;
}

/**
 * The picker on a Settings page that only shows things per machine (Agent homes, Diagnostics): the machine Settings
 * is on, which the pages with a scope sentence share, so moving between Settings pages keeps it.
 */
export function SettingsMachineCrumb({ machines }: { machines: readonly string[] }) {
  const scope = useSettingsScope();
  const sorted = useMemo(() => [...new Set(machines)].sort((left, right) => machineName(left).localeCompare(machineName(right))), [machines]);
  return <MachineCrumb machine={scope ?? ''} machines={sorted} onChange={(next) => setSettingsScope(next || null)} />;
}

/**
 * Usage › All time's picker: the fleet's machines, and every machine the session archive files sessions under, as an
 * old backup's machine may no longer have a host.
 */
export function ArchiveMachineCrumb({ machine, known, onChange }: {
  machine: string;
  known: readonly string[];
  onChange: (machine: string) => void;
}) {
  const [archived, setArchived] = useState<string[]>([]);
  useEffect(() => {
    let disposed = false;
    // Without the archive's list the fleet's machines still offer, so a failure needs nothing shown.
    getSessionArchiveStatus().then((status) => !disposed && setArchived(archiveMachines(status)), () => {});
    return () => {
      disposed = true;
    };
  }, []);
  const all = useMemo(() => [...known, ...archived], [known, archived]);
  return <FleetMachineCrumb machine={machine} known={all} onChange={onChange} />;
}
