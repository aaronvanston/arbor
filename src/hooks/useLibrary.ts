import { useEffect, useMemo, useState } from 'react';
import { libraryRows, type LibraryRow } from '../services/library';
import { getHookRegistry } from '../services/setupHooks';
import { getMcpRegistry, withRegistry } from '../services/setupMcp';
import { withCodexPluginRepo, withPluginRepo } from '../services/setupPluginRepo';
import { extensionsView } from '../services/setupPlugins';
import { getSetupRepo, storedSetupRepo } from '../services/setupSync';
import type { HookRegistry, McpRegistry, SetupMachine, SetupRepo } from '../native/types';

/** What the Library reads from the setup repo: its contents, its MCP servers and its hooks. */
export type LibrarySources = { repo: SetupRepo | null; registry: McpRegistry | null; hooks: HookRegistry | null };

/**
 * The Library's rows for the machines as last scanned, with what they're read from: the repo is read again whenever a
 * machine has been, since each machine is compared with it as its last scan found it. Sync's Library and Overview both
 * read through this, so they count the same things behind.
 */
export function useLibrary(machines: SetupMachine[]) {
  const [repoPath] = useState(storedSetupRepo);
  const [sources, setSources] = useState<LibrarySources>({ repo: null, registry: null, hooks: null });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);

  const scans = machines.map((machine) => `${machine.machine}:${machine.scannedAt ?? ''}`).join('\n');
  useEffect(() => {
    if (!repoPath) return undefined;
    let current = true;
    Promise.all([getSetupRepo(repoPath), getMcpRegistry(repoPath).catch(() => null), getHookRegistry(repoPath).catch(() => null)])
      .then(([repo, registry, hooks]) => {
        if (!current) return;
        setSources({ repo, registry, hooks });
        setLoadError(null);
        setLoaded(true);
      })
      .catch((error) => {
        if (!current) return;
        setLoadError(String(error));
        setLoaded(true);
      });
    return () => { current = false; };
  }, [repoPath, scans, reads]);

  const rows: LibraryRow[] = useMemo(() => {
    const { repo, registry, hooks } = sources;
    const view = withCodexPluginRepo(withPluginRepo(withRegistry(extensionsView(machines), registry), repo?.plugins ?? null), repo?.codexPlugins ?? null);
    const registryFound = registry?.found === true && registry.problems.length === 0;
    return libraryRows({ machines, view, repo, registryFound, hooks });
  }, [machines, sources]);

  return { repoPath, sources, setSources, loaded, loadError, rows, readAgain: () => setReads((count) => count + 1) };
}
