import type { MessageKey } from '../i18n/resources';
import type { ExtraModel, ExtraModelsProvider, ExtraModelsView } from '../native/types';
import { authFileAvailability, canonicalProvider } from './authFiles';
import { apiCallErrorMessage, isRecord, managementApi, normalizeAuthIndex, readString, responseList } from './managementApi';
import { codexMetadataFor } from './quotaMetadata';

/**
 * Extra models are ones the proxy's built-in catalog doesn't have yet, which Arbor's model plugin adds to every account
 * of a provider, a copy of the plugin per provider. New ones are found in the list the provider gives a signed-in
 * account, where Arbor knows how to ask for it (Anthropic's for Claude, ChatGPT's for Codex), and filled in from the
 * nearest model the catalog does have.
 */

/** A model a provider's live list offers the account, with the details the list gives about it, if any. */
export type LiveModel = { id: string; displayName: string | null; details: Partial<ExtraModel> | null };

/**
 * Where an extra model stands. `active`: the proxy serves it. `builtIn`: the catalog has it now, so the extra does
 * nothing. `notLoaded`: saved, but the proxy isn't serving it. `saved`: the proxy isn't running to ask.
 */
export type ExtraModelStatus = 'active' | 'builtIn' | 'notLoaded' | 'saved';

export type LiveModelsResult =
  | { ok: true; models: LiveModel[] }
  | { ok: false; reason: MessageKey }
  | { ok: false; message: string };

type Api = Pick<typeof managementApi, 'get' | 'post'>;

export const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000';
export const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
/** The Codex version to ask ChatGPT's list as when npm's latest isn't known. The list leaves out models that need a newer one. */
export const CODEX_CLIENT_VERSION = '0.158.0';

/** The headers a Claude account's own requests carry; the core puts the account's token in for `$TOKEN$`. */
const ANTHROPIC_HEADERS: Record<string, string> = {
  Authorization: 'Bearer $TOKEN$',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'oauth-2025-04-20',
  'User-Agent': 'claude-cli/2.1.280 (external, cli)',
};

/** The names Arbor gives the providers extra models can be added to, by the core's key for them. */
export const EXTRA_MODEL_PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
  kimi: 'Kimi',
  xai: 'xAI',
  vertex: 'Vertex',
  aistudio: 'AI Studio',
};

export const extraModelProviderLabel = (provider: string) => EXTRA_MODEL_PROVIDER_LABEL[provider] ?? provider;

/** Who publishes each provider's live list, for the page to say where new models were looked for. */
export const LIVE_LIST_SOURCE: Record<string, string> = { claude: 'Anthropic', codex: 'OpenAI' };

const sameId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export const EXTRA_MODEL_STATUS_LABEL: Record<ExtraModelStatus, MessageKey> = {
  active: 'extraModels.status.active',
  builtIn: 'extraModels.status.builtIn',
  notLoaded: 'extraModels.status.notLoaded',
  saved: 'extraModels.status.saved',
};

export function extraModelStatus(model: ExtraModel, provider: ExtraModelsProvider, view: Pick<ExtraModelsView, 'coreRunning' | 'served'>): ExtraModelStatus {
  if (provider.catalog.some((entry) => sameId(entry.id, model.id))) return 'builtIn';
  if (!view.coreRunning) return 'saved';
  return view.served.some((id) => sameId(id, model.id)) ? 'active' : 'notLoaded';
}

/** The models in Anthropic's `/v1/models` answer, each once. It gives names but not limits. */
export function parseAnthropicModels(payload: unknown): LiveModel[] {
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const models: LiveModel[] = [];
  for (const entry of data) {
    const id = readString(entry, 'id').trim();
    if (!id || models.some((model) => sameId(model.id, id))) continue;
    models.push({ id, displayName: readString(entry, 'display_name', 'displayName').trim() || null, details: null });
  }
  return models;
}

/**
 * The models in ChatGPT's Codex list, each once, with the context window, reasoning levels and inputs it gives. Ones
 * it hides from Codex's own picker aren't offered either.
 */
export function parseCodexModels(payload: unknown): LiveModel[] {
  const data = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
  const models: LiveModel[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const id = readString(entry, 'slug', 'id').trim();
    if (!id || readString(entry, 'visibility') === 'hide' || models.some((model) => sameId(model.id, id))) continue;
    const levels = (Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [])
      .map((level) => readString(level, 'effort').trim())
      .filter(Boolean);
    const contextWindow = Number(entry.context_window);
    const inputs = (Array.isArray(entry.input_modalities) ? entry.input_modalities : [])
      .filter((input): input is string => typeof input === 'string' && input.trim() !== '');
    const details: Partial<ExtraModel> = {};
    const description = readString(entry, 'description').trim();
    if (description) details.description = description;
    if (Number.isInteger(contextWindow) && contextWindow > 0) details.contextLength = contextWindow;
    if (levels.length > 0) details.thinking = { levels, min: null, max: null, zeroAllowed: false, dynamicAllowed: false };
    if (inputs.length > 0) details.inputModalities = inputs;
    models.push({
      id,
      displayName: readString(entry, 'display_name', 'displayName').trim() || null,
      details: Object.keys(details).length > 0 ? details : null,
    });
  }
  return models;
}

/** The models a provider's live list offers that the proxy has no way to serve yet: not in its catalog, not added, not served. */
export function suggestExtraModels(live: LiveModel[], provider: Pick<ExtraModelsProvider, 'catalog' | 'models'>, served: string[] = []): LiveModel[] {
  return live.filter((model) =>
    !provider.catalog.some((entry) => sameId(entry.id, model.id))
    && !provider.models.some((entry) => sameId(entry.id, model.id))
    && !served.some((id) => sameId(id, model.id)));
}

/**
 * A model id's family and version: `claude-sonnet-5-5` is sonnet 5.5, `claude-3-7-sonnet-20250219` sonnet 3.7,
 * `gpt-5.6-luna` luna 5.6 and `gpt-5.5` gpt 5.5.
 */
export function modelVersion(id: string): { family: string; version: number[] } | null {
  const trimmed = id.trim();
  const newer = /^claude-([a-z]+)((?:-\d{1,2})+)(?:-\d{8})?$/i.exec(trimmed);
  if (newer?.[1] && newer[2]) {
    return { family: newer[1].toLowerCase(), version: newer[2].split('-').filter(Boolean).map(Number) };
  }
  const older = /^claude-((?:\d{1,2}-)+)([a-z]+)(?:-\d{8})?$/i.exec(trimmed);
  if (older?.[1] && older[2]) {
    return { family: older[2].toLowerCase(), version: older[1].split('-').filter(Boolean).map(Number) };
  }
  const gpt = /^gpt-(\d{1,2}(?:\.\d{1,2})*)(?:-([a-z]+))?$/i.exec(trimmed);
  if (gpt?.[1]) {
    return { family: (gpt[2] ?? 'gpt').toLowerCase(), version: gpt[1].split('.').map(Number) };
  }
  return null;
}

const compareVersions = (left: number[], right: number[]) => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * The catalog model a new one is most like, to take its limits and thinking from: the newest of its family that's no
 * newer than it, else the oldest of its family, else the newest model there is. Nothing when the catalog is empty.
 */
export function templateFor(id: string, catalog: ExtraModel[]): ExtraModel | null {
  const target = modelVersion(id);
  const versioned = catalog.flatMap((model) => {
    const parsed = modelVersion(model.id);
    return parsed ? [{ model, ...parsed }] : [];
  });
  const newestFirst = (entries: typeof versioned) => [...entries].sort((left, right) => compareVersions(right.version, left.version));
  if (target) {
    const family = newestFirst(versioned.filter((entry) => entry.family === target.family));
    const atOrBelow = family.find((entry) => compareVersions(entry.version, target.version) <= 0);
    const nearest = atOrBelow ?? family[family.length - 1];
    if (nearest) return nearest.model;
  }
  return newestFirst(versioned)[0]?.model ?? catalog[0] ?? null;
}

/** A new extra model: its own id and name, then the details its live list gave, the rest from `template`. */
export function extraModelFrom(id: string, displayName: string | null, template: ExtraModel | null, details: Partial<ExtraModel> | null = null): ExtraModel {
  return {
    id: id.trim(),
    displayName: displayName?.trim() || null,
    description: details?.description ?? null,
    contextLength: details?.contextLength ?? template?.contextLength ?? null,
    maxCompletionTokens: details?.maxCompletionTokens ?? template?.maxCompletionTokens ?? null,
    thinking: details?.thinking ?? template?.thinking ?? null,
    inputModalities: details?.inputModalities ?? template?.inputModalities ?? [],
    outputModalities: details?.outputModalities ?? template?.outputModalities ?? [],
  };
}

/** Why an id can't be added to a provider, or nothing when it can. */
export function extraModelIdProblem(id: string, provider: Pick<ExtraModelsProvider, 'catalog' | 'models'>): MessageKey | null {
  const trimmed = id.trim();
  if (!trimmed) return 'extraModels.add.error.empty';
  if (/\s/.test(trimmed)) return 'extraModels.add.error.whitespace';
  if (provider.catalog.some((entry) => sameId(entry.id, trimmed))) return 'extraModels.add.error.builtIn';
  if (provider.models.some((entry) => sameId(entry.id, trimmed))) return 'extraModels.add.error.added';
  return null;
}

/**
 * The credential of `provider`'s to ask its live list with: one that's turned on and whose sign-in still works,
 * preferring one that's ready. Nothing when there's none.
 */
export function accountFor(files: Record<string, unknown>[], provider: string): Record<string, unknown> | null {
  const usable = files
    .filter((file) => canonicalProvider(readString(file, 'provider', 'type')) === provider)
    .filter((file) => normalizeAuthIndex(file.auth_index ?? file.authIndex))
    .map((file) => ({ file, availability: authFileAvailability(file) }))
    .filter(({ availability }) => availability.kind !== 'disabled' && availability.kind !== 'signin');
  return (usable.find(({ availability }) => availability.kind === 'ready') ?? usable[0])?.file ?? null;
}

async function askLiveList(
  api: Api,
  provider: string,
  request: (account: Record<string, unknown>) => { url: string; header: Record<string, string> },
  parse: (payload: unknown) => LiveModel[],
): Promise<LiveModelsResult> {
  const account = accountFor(responseList(await api.get('/auth-files'), 'files'), provider);
  if (!account) return { ok: false, reason: 'extraModels.suggestions.noAccount' };
  const response = await api.post<Record<string, unknown>>('/api-call', {
    authIndex: normalizeAuthIndex(account.auth_index ?? account.authIndex),
    method: 'GET',
    ...request(account),
  }, { timeoutMs: 15_000 });
  const status = Number(response.status_code ?? response.statusCode ?? 0);
  if (status < 200 || status >= 300) return { ok: false, message: apiCallErrorMessage(response) };
  const body = response.body ?? response.bodyText;
  let payload: unknown = body;
  if (typeof body === 'string') {
    try {
      payload = JSON.parse(body);
    } catch {
      return { ok: false, reason: 'extraModels.suggestions.unreadable' };
    }
  }
  return { ok: true, models: parse(payload) };
}

/**
 * Anthropic's model list for one of the Claude accounts. The proxy makes the request with the account's own
 * credential, so the token never reaches the webview.
 */
export function fetchAnthropicModels(api: Api = managementApi): Promise<LiveModelsResult> {
  return askLiveList(api, 'claude', () => ({ url: ANTHROPIC_MODELS_URL, header: ANTHROPIC_HEADERS }), parseAnthropicModels);
}

/**
 * ChatGPT's list of Codex models for one of the Codex accounts, asked as Codex `clientVersion` asks it, through the
 * proxy the same way.
 */
export function fetchCodexModels(api: Api = managementApi, clientVersion = CODEX_CLIENT_VERSION): Promise<LiveModelsResult> {
  return askLiveList(api, 'codex', (account) => {
    const header: Record<string, string> = {
      Authorization: 'Bearer $TOKEN$',
      Accept: 'application/json',
      Originator: 'codex_cli_rs',
      'User-Agent': `codex_cli_rs/${clientVersion} (Mac OS 26.5.2; arm64)`,
    };
    const accountId = codexMetadataFor(account).accountId;
    if (accountId) header['Chatgpt-Account-Id'] = accountId;
    return { url: `${CODEX_MODELS_URL}?client_version=${encodeURIComponent(clientVersion)}`, header };
  }, parseCodexModels);
}

/** How to ask each provider that has one for its live list. The rest take models by ID only. */
export const LIVE_MODEL_SOURCES: Record<string, (api: Api, codexVersion?: string) => Promise<LiveModelsResult>> = {
  claude: (api) => fetchAnthropicModels(api),
  codex: (api, codexVersion) => fetchCodexModels(api, codexVersion),
};
