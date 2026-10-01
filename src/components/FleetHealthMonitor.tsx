import { useEffect, useMemo } from 'react';
import { useAppPreferences } from '../appPreferences';
import { useI18n } from '../i18n';
import { invokeCommand } from '../native/commands';
import { useFleetMachines, watchFleetHealth } from '../services/fleetHealth';
import { glanceMachines, machineTrayLines, useGlancePicks } from '../services/glance';
import { machineNameIn, useMachineNames } from '../services/machineNames';

/**
 * Headless: keeps the machines' health fresh for the sidebar and Home, and puts a line per picked machine in the menu
 * bar menu. It keeps reading while the window is hidden, since then the menu is all that shows.
 */
export function FleetHealthMonitor() {
  const { t } = useI18n();
  const { trayMachines } = useAppPreferences();
  const picks = useGlancePicks();
  const names = useMachineNames();
  const machines = useFleetMachines();

  useEffect(() => watchFleetHealth(), []);

  const trayKey = useMemo(
    () => (trayMachines && machines ? machineTrayLines(glanceMachines(machines, picks), (machine) => machineNameIn(names, machine), t).join('\n') : ''),
    [machines, names, picks, trayMachines, t],
  );
  useEffect(() => {
    invokeCommand('set_tray_lines', { section: 'machines', lines: trayKey ? trayKey.split('\n') : [] })
      .catch((error) => console.warn('Failed to update the tray machines', error));
  }, [trayKey]);

  return null;
}
