import { translate } from '../i18n';
import type { ModelOverrideEntry, SpeedAliasEntry, ThinkingAliasEntry, ThinkingAliasSource } from '../native/types';

/** An alias on Settings › Aliases: a thinking alias, a Fast alias, or both on one name. */
export type AliasListEntry = ThinkingAliasEntry & {
  serviceTier: string | null;
};

export type ModelAliasSource = ThinkingAliasSource & {
  supportsReasoning: boolean;
  supportsFast: boolean;
};

/** The part of a Model Routing override that identifies its oauth-model-alias entry. */
export type ModelOverrideRoute = Pick<ModelOverrideEntry, 'requestedModel' | 'oauthChannel'>;

export const combineModelAliasEntries = (
  thinkingEntries: ThinkingAliasEntry[],
  speedEntries: SpeedAliasEntry[],
): AliasListEntry[] => {
  const entries = new Map<string, AliasListEntry>();
  const entryKey = (
    entry: Pick<ThinkingAliasEntry, 'kind' | 'provider' | 'sourceModel' | 'alias' | 'oauthChannel'>,
  ) => (
    [entry.oauthChannel ?? '', entry.kind, entry.provider, entry.sourceModel, entry.alias]
      .map((value) => value.toLocaleLowerCase())
      .join('\u0000')
  );

  thinkingEntries.forEach((entry) => {
    entries.set(entryKey(entry), { ...entry, serviceTier: null });
  });
  speedEntries.forEach((entry) => {
    const key = entryKey(entry);
    const current = entries.get(key);
    entries.set(key, current
      ? { ...current, serviceTier: entry.serviceTier }
      : { ...entry, effort: null });
  });

  return [...entries.values()].sort((left, right) => (
    left.provider.localeCompare(right.provider)
      || left.alias.localeCompare(right.alias)
  ));
};

/**
 * Model overrides are stored as OAuth aliases too, but they belong to Model
 * Routing: it removes the base and [1m] routes together and leaves the payload
 * rules of the real model alone. Deleting one here would do neither.
 */
export const excludeModelOverrides = <Entry extends Pick<AliasListEntry, 'alias' | 'oauthChannel'>>(
  entries: Entry[],
  overrides: ModelOverrideRoute[],
): Entry[] => {
  const routeKey = (channel: string, model: string) => (
    `${channel.trim().toLowerCase()}\u0000${model.trim().toLowerCase()}`
  );
  const routes = new Set(overrides.map((override) => (
    routeKey(override.oauthChannel, override.requestedModel)
  )));
  return entries.filter((entry) => (
    !entry.oauthChannel || !routes.has(routeKey(entry.oauthChannel, entry.alias))
  ));
};

export const combineModelAliasSources = (
  baseSources: ThinkingAliasSource[],
  thinkingSources: ThinkingAliasSource[],
  speedSources: ThinkingAliasSource[],
): ModelAliasSource[] => {
  const reasoningSourceIds = new Set(thinkingSources.map((source) => source.id));
  const speedSourceIds = new Set(speedSources.map((source) => source.id));
  const sources = new Map<string, ModelAliasSource>();
  [...baseSources, ...speedSources, ...thinkingSources].forEach((source) => {
    sources.set(source.id, {
      ...source,
      supportsReasoning: reasoningSourceIds.has(source.id),
      supportsFast: speedSourceIds.has(source.id),
    });
  });
  return [...sources.values()];
};

/**
 * Keeps the picked model selected across a reload. API-key source IDs carry a hash of their
 * provider entry, so creating an alias there changes the ID; fall back to the one source with
 * the same identity.
 */
export const reselectAliasSource = (
  currentId: string,
  previous: ThinkingAliasSource | null,
  nextSources: ThinkingAliasSource[],
) => {
  if (nextSources.some((source) => source.id === currentId)) return currentId;
  if (!previous) return '';
  const matches = nextSources.filter((source) => (
    source.kind === previous.kind
    && source.provider === previous.provider
    && source.protocol === previous.protocol
    && source.model === previous.model
  ));
  const [only] = matches;
  return matches.length === 1 && only ? only.id : '';
};

export const defaultModelAlias = (
  model: string | null | undefined,
  effort: string,
  fast: boolean,
) => {
  const normalizedModel = model?.trim() ?? '';
  const normalizedEffort = effort.trim().toLowerCase();
  if (!normalizedModel) return '';
  if (!normalizedEffort && !fast) return `${normalizedModel}-alias`;
  return `${normalizedModel}${normalizedEffort ? `-${normalizedEffort}` : ''}${fast ? '-fast' : ''}`;
};

export const uniqueModelAlias = (
  alias: string,
  existingModelNames: string[],
) => {
  const normalizedAlias = alias.trim();
  if (!normalizedAlias) return '';
  const existingNames = new Set(
    existingModelNames
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!existingNames.has(normalizedAlias.toLowerCase())) return normalizedAlias;

  let suffix = 2;
  let candidate = `${normalizedAlias}-${suffix}`;
  while (existingNames.has(candidate.toLowerCase())) {
    suffix += 1;
    candidate = `${normalizedAlias}-${suffix}`;
  }
  return candidate;
};

export const thinkingAliasSourceKindLabel = (kind: string) => {
  if (kind === 'codex-oauth') return 'Codex OAuth';
  if (kind === 'antigravity-oauth') return 'Antigravity OAuth';
  if (kind === 'claude-oauth') return 'Claude OAuth';
  if (kind === 'aistudio-oauth') return 'AI Studio OAuth';
  if (kind === 'vertex-oauth') return 'Vertex OAuth';
  if (kind === 'kimi-oauth') return 'Kimi OAuth';
  if (kind === 'xai-oauth') return 'xAI OAuth';
  if (kind === 'codex-api') return 'Codex API';
  if (kind === 'claude-api') return 'Claude API';
  if (kind === 'gemini-api') return 'Gemini API';
  if (kind === 'openai-compatible') return translate('aliases.source.openAiCompatible');
  return translate('aliases.source.other');
};
