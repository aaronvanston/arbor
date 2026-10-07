import { useCallback, useMemo, useState } from 'react';
import { libraryRows, type LibraryKind, type LibraryRow } from '../services/library';
import { withRegistry } from '../services/setupMcp';
import { withCodexPluginRepo, withPluginRepo } from '../services/setupPluginRepo';
import { extensionsView } from '../services/setupPlugins';
import { reloadSyncStanding, useSyncStanding } from '../services/syncStanding';
import type { HookRegistry, McpRegistry, SetupMachine, SetupRepo, SyncStanding } from '../native/types';

/** What the Library reads from the setup repo: its contents, its MCP servers and its hooks. */
export type LibrarySources = { repo: SetupRepo | null; registry: McpRegistry | null; hooks: HookRegistry | null };

type Override = { from: SyncStanding | null; sources: LibrarySources };

/**
 * The Library's rows for the machines as last scanned, from Sync's shared standing: the repo, its MCP servers and hooks
 * as the standing read them, and which machines are behind on each row. Overview, the Library and the directory read
 * through this, and the standing is one read for the whole window, so none of them reads the repo again on its own.
 *
 * A change made here (`setSources`) shows at once and asks for a fresh standing, which replaces it when it comes.
 * `kindErrors` says why a kind's registry couldn't be read, so its tab can say so rather than look empty.
 */
export function useLibrary(machines: SetupMachine[]) {
  const { repoPath, standing, error, loaded } = useSyncStanding();
  const [override, setOverride] = useState<Override | null>(null);
  const read = useMemo<LibrarySources>(() => ({ repo: standing?.repo ?? null, registry: standing?.mcp ?? null, hooks: standing?.hooks ?? null }), [standing]);
  const sources = override && override.from === standing ? override.sources : read;

  const setSources = useCallback((next: LibrarySources | ((current: LibrarySources) => LibrarySources)) => {
    setOverride((current) => {
      const base = current && current.from === standing ? current.sources : read;
      return { from: standing, sources: typeof next === 'function' ? next(base) : next };
    });
    reloadSyncStanding();
  }, [standing, read]);

  const rows: LibraryRow[] = useMemo(() => {
    const { repo, registry, hooks } = sources;
    const view = withCodexPluginRepo(withPluginRepo(withRegistry(extensionsView(machines), registry), repo?.plugins ?? null), repo?.codexPlugins ?? null);
    const registryFound = registry?.found === true && registry.problems.length === 0;
    return libraryRows({ machines, view, repo, registryFound, hooks, standing });
  }, [machines, sources, standing]);

  const kindErrors = useMemo<Partial<Record<LibraryKind, string>>>(() => ({
    ...(standing?.mcpError ? { mcps: standing.mcpError } : {}),
    ...(standing?.hooksError ? { hooks: standing.hooksError } : {}),
  }), [standing]);

  return { repoPath, sources, setSources, loaded, loadError: error, kindErrors, rows, standing, readAgain: () => reloadSyncStanding() };
}
