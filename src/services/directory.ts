import { invokeCommand } from '../native/commands';
import { isCodexOwnMarketplace, isGithubRepo, type ExtensionsView } from './setupPlugins';
import type { LibraryRow } from './library';
import type { CatalogPlugin, MarketplaceCatalog, SetupRepo } from '../native/types';

/**
 * Sync › Library's directory: the plugins each marketplace offers, read from its GitHub repository, beside what the
 * Library has. The marketplaces are the ones a machine or the repo already uses, the agents' official ones as
 * suggestions, and any typed in.
 */

/** What a marketplace offers; GitHub is asked again only after 15 minutes, unless `force`. */
export const getMarketplaceCatalog = (source: string, force = false) => invokeCommand('get_marketplace_catalog', { source, force });

export type DirectoryAgent = 'claude' | 'codex';

/**
 * Official marketplaces, suggested until one is added. OpenAI's curated Codex plugins come with a ChatGPT account and
 * are turned on in the Codex app, so there's no repository to list for them.
 */
export const OFFICIAL_MARKETPLACES: readonly { source: string; agent: DirectoryAgent }[] = [
  { source: 'anthropics/claude-plugins-official', agent: 'claude' },
];

/**
 * A marketplace the directory lists: its repository, the agent whose plugins it holds, whether a machine or the repo
 * uses it already (`added`), and whether it's only a suggestion or typed in.
 */
export type DirectorySource = { source: string; agent: DirectoryAgent; added: boolean; suggested: boolean };

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The marketplaces to list: the ones in use first, then the official ones not in use, then the ones typed in. */
export function directorySources(view: ExtensionsView, repo: SetupRepo | null, typed: readonly { source: string; agent: DirectoryAgent }[] = []): DirectorySource[] {
  const found: DirectorySource[] = [];
  const add = (source: string | null | undefined, agent: DirectoryAgent, added: boolean, suggested: boolean) => {
    if (!isGithubRepo(source) || found.some((entry) => same(entry.source, source) && entry.agent === agent)) return;
    found.push({ source, agent, added, suggested });
  };
  for (const row of view.marketplaces) add(row.github, 'claude', true, false);
  for (const row of view.codexMarketplaces) if (!isCodexOwnMarketplace(row.name)) add(row.github, 'codex', true, false);
  for (const plugin of repo?.plugins ?? []) add(plugin.source, 'claude', true, false);
  for (const plugin of repo?.codexPlugins ?? []) add(plugin.source, 'codex', true, false);
  for (const official of OFFICIAL_MARKETPLACES) add(official.source, official.agent, false, true);
  for (const entry of typed) add(entry.source.trim(), entry.agent, false, false);
  return found;
}

/** A catalog plugin against the Library: in it, on or off for every machine, or not there yet. */
export type DirectoryStanding = 'on' | 'off' | 'unlisted' | 'removed' | null;
export type DirectoryEntry = CatalogPlugin & { id: string; standing: DirectoryStanding; row: LibraryRow | null };

/** A catalog's plugins, each with how the Library has it, matching `query` by name, description or category. */
export function directoryEntries(catalog: MarketplaceCatalog, agent: DirectoryAgent, rows: readonly LibraryRow[], query = ''): DirectoryEntry[] {
  const text = query.trim().toLowerCase();
  return catalog.plugins
    .filter((plugin) => !text || [plugin.name, plugin.description, plugin.category].some((field) => field?.toLowerCase().includes(text)))
    .map((plugin) => {
      const id = `${plugin.name}@${catalog.name}`;
      const row = rows.find((entry) => entry.toggle?.kind === 'plugin' && entry.toggle.codex === (agent === 'codex') && entry.toggle.row.id === id) ?? null;
      return { ...plugin, id, standing: row?.state ?? null, row };
    });
}
