import { useEffect, useMemo } from 'react';
import { useAppPreferences } from '../appPreferences';
import { useI18n } from '../i18n';
import type { TrayRow } from '../native/types';
import { useLatestAgentVersions } from '../services/agentReleases';
import { newestAgents } from '../services/agentVersions';
import { useFleetHealth, useFleetMachines, watchFleetHealth } from '../services/fleetHealth';
import { glanceMachines, machineTrayRows, useGlancePicks } from '../services/glance';
import { machineNameIn, useMachineNames } from '../services/machineNames';
import { publishTrayRows, watchTrayActions } from '../services/trayMenu';

/**
 * Headless: keeps the machines' health fresh for the sidebar and Home, puts a row per picked machine in the menu bar
 * menu, and carries out what's picked there. It keeps reading while the window is hidden, since then the menu is all
 * that shows.
 */
export function FleetHealthMonitor() {
  const { t } = useI18n();
  const { trayMachines } = useAppPreferences();
  const picks = useGlancePicks();
  const names = useMachineNames();
  const machines = useFleetMachines();
  const health = useFleetHealth();
  const latest = useLatestAgentVersions();

  useEffect(() => watchFleetHealth(), []);
  useEffect(() => watchTrayActions(), []);

  const trayKey = useMemo(() => {
    if (!trayMachines || !machines) return '[]';
    const newest = newestAgents(health ?? [], latest);
    return JSON.stringify(machineTrayRows(glanceMachines(machines, picks), (machine) => machineNameIn(names, machine), newest, t));
  }, [health, latest, machines, names, picks, trayMachines, t]);
  useEffect(() => {
    publishTrayRows('machines', JSON.parse(trayKey) as TrayRow[]);
  }, [trayKey]);

  return null;
}
