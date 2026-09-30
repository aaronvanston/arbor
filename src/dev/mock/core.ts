/**
 * The browser mock's answers for the core: its process and updates, its config, model routing, its management API
 * (credentials, limits and resets) and signing in to accounts.
 */
import { emit } from '@tauri-apps/api/event';
import type { CoreCommands } from '../../native/core';
import type {
  CoreConfigView,
  CoreInstallTask,
  CoreStatus,
  CoreTlsSettings,
  ExtraModel,
  ExtraModelsView,
  ManagementRequest,
  ModelOverrideEntry,
  ProxyChecks,
  ReleaseNotes,
  SettingsInEffect,
  SpeedAliasEntry,
  ThinkingAliasEntry,
  ThinkingAliasSource,
} from '../../native/types';
import { coreReply, type CommandAnswers } from './answers';
import { iso, mockLog, params, type Json } from './scenario';

// With `?heavy=1`, an Orca session on Cedar 01 has used 258M tokens in the last hour.
export const heavyScenario = params.get('heavy') === '1';
export const coreScenario = params.get('core') ?? 'running';
const limitScenario = params.get('limit');
const quotaScenario = params.get('quota');
// With `?limit=unused`, the weekly limits reset in 20 hours with plenty left, so capacity is about to go unused.
const weeklyResetMs = limitScenario === 'unused' ? 20 * 3_600_000 : 4 * 86_400_000;
const quotaErrorScenario = quotaScenario === 'error';
const newCapsScenario = params.get('caps') === 'new';
// With `?proxy=usage-off,network` and the like, the proxy checks find those problems; Turn on clears usage-off.
const proxyScenario = new Set((params.get('proxy') ?? '').split(',').filter(Boolean));
// With `?save=not-loaded`, a settings save finds the proxy still running its old settings, having choked on line 153.
const saveScenario = params.get('save');
// Settings › Extra models: see the list at the top of mockTauri.ts.
const extraModelsScenario = params.get('extraModels');

const claudeThinking = { levels: ['low', 'medium', 'high', 'xhigh', 'max'], min: null, max: null, zeroAllowed: true, dynamicAllowed: true };
const catalogModel = (id: string, displayName: string, more: Partial<ExtraModel> = {}): ExtraModel => ({
  id, displayName, description: null, contextLength: 1_000_000, maxCompletionTokens: 128_000, thinking: claudeThinking,
  inputModalities: ['text', 'image'], outputModalities: ['text'], ...more,
});
/** The proxy's built-in Claude models. */
const claudeCatalog: ExtraModel[] = [
  catalogModel('claude-fable-5-1', 'Claude Fable 5.1'),
  catalogModel('claude-opus-5-5', 'Claude Opus 5.5'),
  catalogModel('claude-opus-5', 'Claude Opus 5'),
  catalogModel('claude-sonnet-5', 'Claude Sonnet 5'),
  catalogModel('claude-haiku-4-5-20251001', 'Claude 4.5 Haiku', {
    contextLength: 200_000, maxCompletionTokens: 64_000,
    thinking: { levels: [], min: 1024, max: 128_000, zeroAllowed: true, dynamicAllowed: false },
  }),
];
/** What Anthropic lists for the mock's Claude accounts: the catalog, plus Sonnet 5.5 and Haiku 5, which it lacks. */
const anthropicModels = extraModelsScenario === 'empty'
  ? claudeCatalog.map(({ id, displayName }) => ({ id, display_name: displayName }))
  : [
    { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5', display_name: 'Claude Haiku 5' },
    ...claudeCatalog.map(({ id, displayName }) => ({ id, display_name: displayName })),
  ];
const codexThinking = { levels: ['low', 'medium', 'high', 'xhigh', 'max'], min: null, max: null, zeroAllowed: false, dynamicAllowed: false };
const codexModel = (id: string, displayName: string, more: Partial<ExtraModel> = {}) =>
  catalogModel(id, displayName, { contextLength: 272_000, thinking: codexThinking, ...more });
/** The proxy's built-in Codex models. */
const codexCatalog: ExtraModel[] = [
  codexModel('gpt-6-sol', 'GPT 6.0 Sol'),
  codexModel('gpt-6-luna', 'GPT 6.0 Luna'),
  codexModel('gpt-5.6-luna', 'GPT 5.6 Luna', { contextLength: 921_000 }),
  codexModel('gpt-5.5', 'GPT 5.5', { thinking: { ...codexThinking, levels: ['low', 'medium', 'high', 'xhigh'] } }),
];
/** What ChatGPT lists for the mock's Codex accounts: the catalog, plus GPT-6-Nova, which it lacks, and a hidden one. */
const codexLiveModels = [
  ...(extraModelsScenario === 'empty' ? [] : [{
    slug: 'gpt-6-nova', display_name: 'GPT-6-Nova', description: 'Frontier intelligence for the longest tasks.', context_window: 400_000,
    supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => ({ effort, description: effort })),
    input_modalities: ['text', 'image'], visibility: 'list',
  }]),
  { slug: 'gpt-reserve', display_name: 'GPT-Reserve', context_window: 272_000, visibility: 'hide' },
  ...codexCatalog.map(({ id, displayName }) => ({ slug: id, display_name: displayName, visibility: 'list' })),
];
const catalogs: Record<string, ExtraModel[]> = { claude: claudeCatalog, codex: codexCatalog };
const extraModels: Record<string, ExtraModel[]> = {
  claude: extraModelsScenario === 'empty'
    ? []
    : [
      catalogModel('claude-haiku-5', 'Claude Haiku 5', { contextLength: 200_000, maxCompletionTokens: 64_000 }),
      ...(extraModelsScenario === 'builtIn' ? [catalogModel('claude-opus-5-5', 'Claude Opus 5.5')] : []),
    ],
  codex: [],
};

function extraModelsView(): ExtraModelsView {
  const coreRunning = coreScenario === 'running';
  const loaded = (provider: string) => coreRunning && extraModelsScenario !== 'notLoaded' && (extraModels[provider]?.length ?? 0) > 0;
  const providers = Object.keys(catalogs)
    .filter((provider) => coreRunning || (extraModels[provider]?.length ?? 0) > 0)
    .map((provider) => ({
      provider,
      models: extraModels[provider] ?? [],
      catalog: coreRunning ? catalogs[provider] ?? [] : [],
      hasAccount: coreRunning,
      pluginInstalled: provider === 'claude' || (extraModels[provider]?.length ?? 0) > 0,
      pluginLoaded: loaded(provider),
    }));
  const served = coreRunning
    ? providers.flatMap((entry) => [...entry.catalog.map((model) => model.id), ...(entry.pluginLoaded ? entry.models.map((model) => model.id) : [])])
    : [];
  return { providers, served: [...new Set(served)], coreRunning };
}

function mockProxyChecks(): ProxyChecks {
  if (coreScenario !== 'running') return { checked: false, problems: [] };
  if (proxyScenario.has('refused')) return { checked: true, problems: [{ kind: 'managementRefused', detail: '404' }] };
  return {
    checked: true,
    problems: [
      ...(proxyScenario.has('not-loaded') ? [{ kind: 'settingsNotLoaded' as const, detail: '153' }] : []),
      ...(proxyScenario.has('usage-off') ? [{ kind: 'usageOff' as const, detail: null }] : []),
      ...(proxyScenario.has('no-keys') ? [{ kind: 'noClientKeys' as const, detail: null }] : []),
      ...(proxyScenario.has('default-key') ? [{ kind: 'defaultClientKey' as const, detail: null }] : []),
      ...(proxyScenario.has('network') ? [{ kind: 'openToNetwork' as const, detail: '0.0.0.0' }] : []),
    ],
  };
}
const paceAhead = params.get('pace') === 'ahead';
const coreProcessUp = coreScenario === 'running' || coreScenario === 'unready' || coreScenario === 'stops';

export let coreStatus: CoreStatus = {
  installed: coreScenario !== 'missing',
  running: coreProcessUp,
  ready: coreScenario === 'running' || coreScenario === 'stops',
  starting: false,
  managed: true,
  processId: coreProcessUp ? 48213 : null,
  currentVersion: coreScenario === 'missing' ? null : 'v6.8.21',
  installDir: '/Users/casey/Library/Application Support/EasyCLIProxyAPI/core',
  binaryPath: coreScenario === 'missing' ? null : '/Users/casey/Library/Application Support/EasyCLIProxyAPI/core/cli-proxy-api',
  message: '',
};

export const configSettings: CoreConfigView = {
  apiKeys: params.get('apikey') === 'none' ? [] : [
    { apiKey: 'sk-4f1e9c2b7a8d4e6f9b1c3d5e7f9a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1e3f5a', apiKeyHash: 'hash-casey', remark: 'Casey laptop' },
    { apiKey: 'sk-9b2d4f6a8c0e2a4c6e8a0c2e4a6c8e0a2c4e6a8c0e2a4c6e8a0c2e4a6c8e0a2c', apiKeyHash: 'hash-ci', remark: 'CI runner' },
    ...(heavyScenario ? [{ apiKey: 'sk-0e1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c7b8a9f0e1d', apiKeyHash: 'hash-orca-cedar', remark: 'orca-cedar-01' }] : []),
  ],
  pausedApiKeys: [],
  managementSecretConfigured: true,
  debug: false,
  commercialMode: false,
  loggingToFile: true,
  logsMaxTotalSizeMb: 512,
  errorLogsMaxFiles: 20,
  usageStatisticsEnabled: true,
  redisUsageQueueRetentionSeconds: 604800,
  requestLog: false,
  pluginsEnabled: false,
  host: '127.0.0.1',
  port: 8317,
  allowLan: false,
  routingStrategy: 'round-robin',
  proxyUrl: '',
  routingSessionAffinity: true,
  routingSessionAffinityTtl: '1h',
  disableCooling: false,
  requestRetry: 3,
  maxRetryCredentials: 3,
  maxRetryInterval: 30,
  streamingBootstrapRetries: 2,
  ...(params.get('coreconfig') === 'defaults'
    ? { loggingToFile: false, logsMaxTotalSizeMb: 0, errorLogsMaxFiles: 10, redisUsageQueueRetentionSeconds: 60, routingSessionAffinity: false, maxRetryCredentials: 0, streamingBootstrapRetries: 0 }
    : {}),
};

// With `?coresave=fail`, the settings in the folded groups (logging, retries, TLS) fail to save.
const coreSaveFails = (command: string) =>
  params.get('coresave') === 'fail' && ['save_core_logging_settings', 'save_retry_settings', 'save_core_tls_settings'].includes(command);

/** Saves one of the core settings pages' groups, kept so a page opened again shows what was saved. */
const saveCoreSettings = (command: string, settings: object) => {
  if (coreSaveFails(command)) throw 'Couldn’t write config.yaml: permission denied';
  Object.assign(configSettings, settings);
  return configSettings;
};

const tlsSettings: CoreTlsSettings = params.get('tls') === 'on'
  ? { enabled: true, cert: '/Users/casey/.arbor/tls/proxy.crt', key: '/Users/casey/.arbor/tls/proxy.key' }
  : { enabled: false, cert: '', key: '' };

let oauthLogin: { provider: string; polls: number } | null = null;
/**
 * `?signin=wait` keeps a sign-in waiting on the browser, and `?signin=link` has the browser not open, so only the link
 * shows; `?signin=fail` has the provider refuse it.
 */
const signInScenario = params.get('signin');

const authDir = '/Users/casey/Library/Application Support/EasyCLIProxyAPI/auths';

/** A credential file as the core lists it: on disk, OAuth, with a path. */
const fileEntry = (name: string, fields: Json): Json => ({
  name, source: 'file', path: `${authDir}/${name}`, account_type: 'oauth', disabled: false, ...fields,
});

// One credential per state the Auth Files page tells apart, using the core's
// own status markers and `cooldowns` shapes (7.3.x). Cooldowns hold an absolute
// `retry_at`; each listing derives `remaining_seconds` and drops ended rests.
// `modtime` is the file's own; account ids live in the files but are not listed.
const authFiles: Json[] = [
  // Rejected refresh token: Sign In Again.
  fileEntry('codex-casey.json', { provider: 'codex', email: 'casey@example.com', account_id: 'acct-casey', status: 'error', status_message: 'invalid_grant', unavailable: true, cooldowns: [], auth_index: 'codex-1', priority: 10, size: 2188, modtime: iso(-3_600_000), excluded_models: ['codex-mini-latest'] }),
  // Account-wide usage limit.
  fileEntry('codex-team.json', { provider: 'codex', email: 'team@example.com', status: 'error', status_message: 'quota exhausted', unavailable: true, next_retry_after: iso(3 * 86_400_000), cooldowns: [{ scope: 'credential', reason: 'credential_quota', retry_at: iso(3 * 86_400_000) }, { scope: 'model', model_key: 'gpt-6-astra', reason: 'quota', retry_at: iso(3 * 86_400_000), backoff_level: 1, http_status: 429 }], auth_index: 'codex-2', priority: 0, size: 2190, modtime: iso(-86_400_000) }),
  // Still routed, with two models resting; the short rest ends while the page is open.
  fileEntry('claude-max.json', { provider: 'claude', email: 'casey@example.com', account_uuid: 'uuid-casey', status: 'error', status_message: 'quota exhausted', unavailable: false, cooldowns: [{ scope: 'model', model_key: 'claude-opus-5-5', reason: 'quota', retry_at: iso(3 * 3_600_000), backoff_level: 0, http_status: 429 }, { scope: 'model', model_key: 'claude-fable-5-1', reason: 'transient_error', retry_at: iso(5 * 60_000), http_status: 503 }], auth_index: 'claude-1', priority: 5, size: 1672, modtime: iso(-7_200_000) }),
  // Every model resting after upstream errors: Retrying, with Refresh Now.
  fileEntry('codex-backup.json', { provider: 'codex', email: 'backup@example.com', account_id: 'acct-backup', status: 'error', status_message: 'transient upstream error', unavailable: true, next_retry_after: iso(4 * 60_000), cooldowns: [{ scope: 'model', model_key: 'gpt-6-sol', reason: 'transient_error', retry_at: iso(4 * 60_000), http_status: 502 }, { scope: 'model', model_key: 'gpt-6-luna', reason: 'transient_error', retry_at: iso(6 * 60_000), http_status: 502 }], auth_index: 'codex-3', priority: 0, size: 2204, modtime: iso(-10_800_000) }),
  // Plan or account refused.
  fileEntry('claude-lapsed.json', { provider: 'claude', email: 'lapsed@example.com', account_uuid: 'uuid-lapsed', status: 'error', status_message: 'payment_required', unavailable: true, cooldowns: [{ scope: 'model', model_key: 'claude-opus-5-5', reason: 'payment_required', retry_at: iso(25 * 60_000), http_status: 402 }, { scope: 'model', model_key: 'claude-fable-5-1', reason: 'payment_required', retry_at: iso(25 * 60_000), http_status: 402 }], auth_index: 'claude-2', priority: 0, size: 1650, modtime: iso(-259_200_000) }),
  // A failure the core has no reason code for.
  fileEntry('gemini-ops.json', { provider: 'gemini', email: 'ops@example.com', status: 'error', status_message: 'upstream returned an unexpected response', unavailable: true, cooldowns: [{ scope: 'model', model_key: 'gemini-3-pro', reason: 'unknown', retry_at: iso(10 * 60_000) }], auth_index: 'gemini-2', priority: 0, size: 1320, modtime: iso(-432_000_000) }),
  fileEntry('grok-paid.json', { provider: 'xai', email: 'ops@example.com', status: 'disabled', auth_index: 'xai-1', priority: 0, size: 908, modtime: iso(-172_800_000), disabled: true }),
  { name: 'runtime-gemini', provider: 'gemini', status: 'active', auth_index: 'gemini-1', runtime_only: true, source: 'memory', account_type: 'api_key', size: 0 },
  // A Claude sign-in the core holds only in memory: no file to turn off, so the palette can't pause it.
  ...(params.get('account') === 'runtime'
    ? [{ name: 'runtime-claude', provider: 'claude', email: 'runtime@example.com', status: 'active', auth_index: 'claude-3', runtime_only: true, source: 'memory', account_type: 'oauth', size: 0 }]
    : []),
];

// With `?accounts=fleet`, one person's accounts named the way people name them: a scheme with their email's name in
// it, or the email itself. Mostly ready, one needing a sign-in, one turned off, and an API key.
const fleetAccounts = params.get('accounts') === 'fleet';
/** Each fleet account's used percent: Claude's 5-hour, 7-day and Fable windows, Codex's 5-hour and weekly. */
const fleetUsage: Record<string, { fiveHour: number; week: number; fable?: number; fiveHourResetH: number; weekResetH: number }> = {
  'cc-p1': { fiveHour: 8, week: 93, fable: 0, fiveHourResetH: 3.2, weekResetH: 16.4 },
  'cc-p2': { fiveHour: 2, week: 0, fable: 0, fiveHourResetH: 2.7, weekResetH: 150 },
  'cc-p3': { fiveHour: 2, week: 3, fable: 0, fiveHourResetH: 3.1, weekResetH: 110 },
  'cc-w1': { fiveHour: 7, week: 2, fable: 0, fiveHourResetH: 0.35, weekResetH: 161 },
  'cc-x': { fiveHour: 16, week: 48, fable: 0, fiveHourResetH: 1.9, weekResetH: 46 },
  'cx-p1': { fiveHour: 12, week: 8, fiveHourResetH: 2.1, weekResetH: 131 },
  'cx-p2': { fiveHour: 0, week: 1, fiveHourResetH: 5, weekResetH: 133 },
};
if (fleetAccounts) {
  authFiles.length = 0;
  authFiles.push(
    fileEntry('CC-P1-samrivera.json', { provider: 'claude', email: 'samrivera@example.com', status: 'active', auth_index: 'cc-p1', priority: 0, size: 1672, modtime: iso(-5_000_000) }),
    fileEntry('CC-P2-riverasam.json', { provider: 'claude', email: 'riverasam@example.com', status: 'active', auth_index: 'cc-p2', priority: 2, size: 1664, modtime: iso(-12_000_000) }),
    fileEntry('CC-P3-samr.core.json', { provider: 'claude', email: 'samr.core@example.com', status: 'active', auth_index: 'cc-p3', priority: 3, size: 1650, modtime: iso(-9_000_000) }),
    fileEntry('CC-W1-sam.json', { provider: 'claude', email: 'sam@northwind.dev', status: 'active', auth_index: 'cc-w1', priority: 1, size: 1680, modtime: iso(-12_500_000) }),
    fileEntry('claude-samrivera.alt@example.com.json', { provider: 'claude', email: 'samrivera.alt@example.com', status: 'error', status_message: 'invalid_grant', unavailable: true, cooldowns: [], auth_index: 'cc-x', priority: 4, size: 1702, modtime: iso(-4_000_000) }),
    fileEntry('CX-P1-samrivera.json', { provider: 'codex', email: 'samrivera@example.com', account_id: 'acct-p1', status: 'active', auth_index: 'cx-p1', priority: 4, size: 4390, modtime: iso(-8_000_000) }),
    fileEntry('CX-P2-riverasam.json', { provider: 'codex', email: 'riverasam@example.com', account_id: 'acct-p2', status: 'active', auth_index: 'cx-p2', priority: 3, size: 4402, modtime: iso(-90_000_000) }),
    fileEntry('grok-sam.json', { provider: 'xai', email: 'samrivera@example.com', status: 'disabled', auth_index: 'xai-1', priority: 0, size: 908, modtime: iso(-172_800_000), disabled: true }),
    { name: 'gemini-api-key', provider: 'gemini', status: 'active', auth_index: 'gemini-1', runtime_only: true, source: 'memory', account_type: 'api_key', size: 0 },
  );
}

// With `?accounts=none`, the core lists no credentials at all: Accounts, Home's limits and the sidebar offer Add account.
if (params.get('accounts') === 'none') authFiles.length = 0;
// With `?accounts=off`, every credential is turned off, as if by hand on Auth Files.
if (params.get('accounts') === 'off') authFiles.forEach((file) => Object.assign(file, { disabled: true, status: 'disabled' }));

/** One listing entry the way the core reports it at `nowMs`. */
const listingEntry = (file: Json, nowMs: number): Json => {
  const { lingering: _lingering, account_id: _accountId, account_uuid: _accountUuid, ...entry } = file;
  // Without a file on disk (never had one, or it was just deleted), the core
  // lists size 0 and its own time, which moves with every request.
  if (entry.source === 'memory') Object.assign(entry, { size: 0, modtime: entry.updated_at });
  const retryAt = typeof file.next_retry_after === 'string' ? Date.parse(file.next_retry_after) : NaN;
  if (!(retryAt > nowMs)) delete entry.next_retry_after;
  if (!Array.isArray(file.cooldowns)) return entry;
  const cooldowns = (file.cooldowns as Json[])
    .map((cooldown) => ({ ...cooldown, remaining_seconds: Math.ceil((Date.parse(String(cooldown.retry_at)) - nowMs) / 1000) }))
    .filter((cooldown) => cooldown.remaining_seconds > 0);
  return { ...entry, cooldowns };
};

/** Fields that live in the listing, not in the credential file itself. */
const listingOnlyFields = ['status', 'status_message', 'unavailable', 'size', 'cooldowns', 'quota', 'source', 'path', 'next_retry_after', 'auth_index', 'runtime_only', 'lingering', 'updated_at', 'modtime', 'last_refresh'];

/** A model aliases can start from, and which kinds it takes: Rust works that out from the model, the mock just says. */
type MockAliasSource = ThinkingAliasSource & { supportsReasoning: boolean; supportsFast: boolean };
const aliasSources: MockAliasSource[] = [
  { id: 'codex-oauth:gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6 Sol', provider: 'Codex OAuth', kind: 'codex-oauth', protocol: 'codex', reasoningLevels: ['low', 'medium', 'high', 'xhigh'], supportsReasoning: true, supportsFast: true },
  { id: 'codex-oauth:gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6 Luna', provider: 'Codex OAuth', kind: 'codex-oauth', protocol: 'codex', reasoningLevels: ['low', 'medium', 'high', 'xhigh'], supportsReasoning: true, supportsFast: true },
  { id: 'claude-oauth:claude-fable-5-1', model: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', provider: 'Claude OAuth', kind: 'claude-oauth', protocol: 'claude', reasoningLevels: ['low', 'medium', 'high', 'max'], supportsReasoning: true, supportsFast: false },
  { id: 'claude-oauth:claude-opus-5-5', model: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', provider: 'Claude OAuth', kind: 'claude-oauth', protocol: 'claude', reasoningLevels: ['low', 'medium', 'high', 'max'], supportsReasoning: true, supportsFast: false },
];

// The source a form names, or the first one when the id is unknown.
const aliasSourcesWhere = (keep: (source: MockAliasSource) => boolean): ThinkingAliasSource[] =>
  aliasSources.filter(keep).map(({ supportsReasoning: _reasoning, supportsFast: _fast, ...source }) => source);
function aliasSourceFor(sourceId: unknown) {
  const source = aliasSources.find((entry) => entry.id === sourceId) ?? aliasSources[0];
  if (!source) throw new Error('No alias sources');
  return source;
}

let thinkingAliases: ThinkingAliasEntry[] = [
  { sourceModel: 'gpt-6-sol', alias: 'gpt-6-sol-high', effort: 'high', provider: 'Codex OAuth', kind: 'codex-oauth', oauthChannel: 'codex' },
  { sourceModel: 'claude-fable-5-1', alias: 'fable-max', effort: 'max', provider: 'Claude OAuth', kind: 'claude-oauth', oauthChannel: 'claude' },
];

let speedAliases: SpeedAliasEntry[] = [
  { sourceModel: 'gpt-6-luna', alias: 'luna-fast', serviceTier: 'priority', provider: 'Codex OAuth', kind: 'codex-oauth', oauthChannel: 'codex' },
];

let modelOverrides: ModelOverrideEntry[] = [
  { requestedModel: 'claude-fable-5-1', upstreamModel: 'claude-opus-5-5', oauthChannel: 'claude', provider: 'Claude OAuth', kind: 'claude-oauth', forceMapping: true, longContext: false },
  { requestedModel: 'claude-fable-5-1[1m]', upstreamModel: 'claude-opus-5-5[1m]', oauthChannel: 'claude', provider: 'Claude OAuth', kind: 'claude-oauth', forceMapping: true, longContext: true },
];

let installTask: CoreInstallTask = { running: false, cancelable: false, phase: '', downloaded: 0, total: null, percent: null, message: null, result: null };
let quotaCalls = 0;
// Usage endpoints each account has been asked once, for `?quota=fail-after-first`.
const quotaChecked = new Set<string>();
// Claude banked resets by auth index: one that can be used any time, and one
// saved for when the account reaches a limit.
const claudeBankedResets: Record<string, { left: number; anytime: boolean }> = {
  'claude-1': { left: 2, anytime: true },
  'claude-2': { left: 1, anytime: false },
  'cc-p2': { left: 1, anytime: false },
  'cc-p3': { left: 1, anytime: false },
  'cc-w1': { left: 1, anytime: false },
  'cc-x': { left: 1, anytime: false },
};
const codexResetScenario = params.get('codexreset');
// Codex reset credits by auth index, the redemptions Codex has seen by request id, and
// the accounts a reset refilled. The later credit doesn't apply to the account now, except
// with `?codexreset=lost`, so a reset can be tried again after the lost reply.
const codexCredits: Record<string, Json[]> = {};
const codexRedemptions = new Map<string, string>();
const codexRefilled = new Set<string>();

const codexCreditsFor = (authIndex: string) => codexCredits[authIndex] ??= [
  { id: `rlrc_${authIndex}_soon`, reset_type: 'codex_rate_limits', status: 'available', expires_at: iso(20 * 86_400_000), applicable: true },
  { id: `rlrc_${authIndex}_later`, reset_type: 'codex_rate_limits', status: 'available', expires_at: iso(40 * 86_400_000), applicable: codexResetScenario === 'lost' },
];

/** How the native side fails a management call the core answered with an error: its status and its own words. */
const coreFailure = (status: number, reason: string) => ({ kind: 'core', status, reason, message: `Management API error (${status}): ${reason}` });

function apiCall(body: Json): Json {
  const url = String(body.url ?? '');
  const ok = (payload: unknown) => ({ status_code: 200, header: { date: [new Date().toUTCString()] }, body: JSON.stringify(payload) });
  const authIndex = String(body.authIndex ?? '');
  if (url.startsWith('https://api.anthropic.com/v1/models')) {
    if (extraModelsScenario === 'checkFails') {
      return { status_code: 401, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'OAuth token has expired' } }) };
    }
    return ok({ data: anthropicModels.map((model) => ({ type: 'model', created_at: '2026-09-01T00:00:00Z', ...model })), has_more: false });
  }
  if (url.startsWith('https://chatgpt.com/backend-api/codex/models')) {
    if (extraModelsScenario === 'codexFails') {
      return { status_code: 401, body: JSON.stringify({ error: { message: 'Your authentication token has expired. Please try signing in again.' } }) };
    }
    return ok({ models: codexLiveModels });
  }
  if (quotaScenario === 'fail-after-first' && /\/wham\/usage$|\/api\/oauth\/usage$/.test(url)) {
    const checked = `${authIndex} ${url}`;
    // What the core answers when it can't get to the provider at all (a stale DNS entry, a dropped network).
    if (quotaChecked.has(checked)) throw coreFailure(502, 'request failed');
    quotaChecked.add(checked);
  }
  if (quotaErrorScenario && ['claude-2', 'codex-3'].includes(authIndex) && /oauth\/usage|wham\/usage/.test(url)) {
    return { status_code: 503, body: JSON.stringify({ error: { message: 'upstream unavailable' } }) };
  }
  if (url.includes('chatgpt.com/backend-api/wham/usage')) {
    // Drift a little on every call so refreshes visibly animate in the dev shell.
    const drift = (quotaCalls++ % 4) * 9;
    const credits = codexCreditsFor(authIndex).filter((credit) => credit.status === 'available');
    const fleet = fleetUsage[authIndex];
    if (fleet) {
      return ok({
        plan_type: 'pro',
        rate_limit: {
          primary_window: { used_percent: fleet.fiveHour, limit_window_seconds: 18_000, reset_after_seconds: Math.round(fleet.fiveHourResetH * 3_600) },
          secondary_window: { used_percent: fleet.week, limit_window_seconds: 604_800, reset_after_seconds: Math.round(fleet.weekResetH * 3_600) },
        },
        rate_limit_reset_credits: { available_count: 1, applicable_available_count: 0 },
      });
    }
    return ok({
      plan_type: 'pro',
      rate_limit: {
        primary_window: {
          used_percent: codexRefilled.has(authIndex) ? drift / 3 : limitScenario === 'codex' ? 100 : 34 + drift,
          limit_window_seconds: 18_000,
          reset_after_seconds: 2_400,
        },
        secondary_window: { used_percent: paceAhead ? 80 : Math.min(95, 50 + drift * 2), limit_window_seconds: 604_800, reset_after_seconds: limitScenario === 'unused' ? 20 * 3_600 : 3 * 86_400 },
      },
      additional_rate_limits: [
        { limit_name: 'GPT-5.3 Spark', rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18_000, reset_after_seconds: 9_000 }, secondary_window: { used_percent: 18, limit_window_seconds: 604_800, reset_after_seconds: 5 * 86_400 } } },
      ],
      rate_limit_reset_credits: {
        available_count: credits.length,
        applicable_available_count: credits.filter((credit) => credit.applicable !== false).length,
      },
    });
  }
  if (url.endsWith('/rate-limit-reset-credits/consume')) {
    const redeem = JSON.parse(String(body.data ?? '{}')) as Json;
    const requestId = String(redeem.redeem_request_id ?? '');
    mockLog('codex_reset_consume', { authIndex, ...redeem });
    if (codexRedemptions.has(requestId) || codexResetScenario === 'already') return ok({ code: 'already_redeemed' });
    if (codexResetScenario === 'nothing') return ok({ code: 'nothing_to_reset' });
    const credit = codexCreditsFor(authIndex).find((entry) => entry.status === 'available'
      && (redeem.credit_id ? entry.id === redeem.credit_id : entry.applicable !== false));
    if (!credit || codexResetScenario === 'none') return ok({ code: 'no_credit' });
    credit.status = 'redeemed';
    codexRedemptions.set(requestId, String(credit.id));
    codexRefilled.add(authIndex);
    if (codexResetScenario === 'lost' && codexRedemptions.size === 1) throw coreFailure(502, 'request failed');
    return ok({ code: 'reset' });
  }
  if (url.includes('rate-limit-reset-credits')) return ok({ credits: codexCreditsFor(authIndex) });
  const claudeUsage = {
    five_hour: { utilization: 22, resets_at: iso(2 * 3_600_000) },
    seven_day: { utilization: 58, resets_at: iso(weeklyResetMs) },
    seven_day_opus: { utilization: 12, resets_at: iso(weeklyResetMs) },
    seven_day_sonnet: { utilization: 91, resets_at: iso(weeklyResetMs) },
    limits: [
      { kind: 'weekly_scoped', is_active: true, percent: paceAhead ? 70 : 12, resets_at: iso(weeklyResetMs), scope: { model: { display_name: 'Fable' } } },
      ...(newCapsScenario ? [{ kind: 'weekly_scoped', is_active: true, percent: 47, resets_at: iso(weeklyResetMs), scope: { model: { display_name: 'Haiku 5' } } }] : []),
    ],
    ...(newCapsScenario ? { seven_day_omelette: { utilization: 84, resets_at: iso(2 * 86_400_000) } } : {}),
  };
  const fleet = fleetUsage[authIndex];
  if (fleet) {
    const at = (hours: number) => iso(Math.round(hours * 3_600_000));
    Object.assign(claudeUsage, {
      five_hour: { utilization: fleet.fiveHour, resets_at: at(fleet.fiveHourResetH) },
      seven_day: { utilization: fleet.week, resets_at: at(fleet.weekResetH) },
      seven_day_opus: undefined,
      seven_day_sonnet: undefined,
      limits: [{ kind: 'weekly_scoped', is_active: true, percent: fleet.fable ?? 0, resets_at: at(fleet.weekResetH), scope: { model: { display_name: 'Fable' } } }],
    });
  }
  const bank = claudeBankedResets[authIndex];
  // With `?limit=claude`, the account whose reset waits for a limit has reached its 5-hour one.
  const atLimit = limitScenario === 'claude' && bank !== undefined && !bank.anytime;
  if (url.includes('api.anthropic.com/api/oauth/usage') && url.includes('cedar_ember=1')) {
    return ok({
      ...claudeUsage,
      ...(atLimit ? { five_hour: { utilization: 100, resets_at: iso(2 * 3_600_000) } } : {}),
      cedar_ember: bank ? {
        eligible: true,
        at_limit: atLimit,
        exhausted: atLimit ? ['five_hour'] : [],
        next_grant_id: 'launch_week',
        weekly_resets_at: iso(4 * 86_400_000),
        cooldown_until: null,
        grants: [{
          id: 'launch_week', label: 'Launch week', resets_total: 3, resets_left: bank.left,
          starts_at: iso(-3 * 86_400_000), ends_at: iso(12 * 86_400_000),
          clears: ['five_hour', 'seven_day'], paused: false,
          usable_now: (bank.anytime || atLimit) && bank.left > 0, use_requires_limit: !bank.anytime,
          percent_used: { five_hour: atLimit ? 100 : 22, seven_day: 58 }, blocking: [],
        }],
      } : undefined,
    });
  }
  if (url.includes('api.anthropic.com/api/oauth/usage')) {
    return ok(atLimit ? { ...claudeUsage, five_hour: { utilization: 100, resets_at: iso(2 * 3_600_000) } } : claudeUsage);
  }
  if (url.includes('api.anthropic.com/api/oauth/profile')) {
    return ok({ account: { has_claude_max: true, has_claude_pro: false }, organization: { uuid: '5f0c1a2e-8d7b-4c3a-9e21-0b6d4f8a7c11', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' } });
  }
  if (/api\.anthropic\.com\/api\/organizations\/[^/]+\/reset_rate_limits$/.test(url)) {
    const claim = JSON.parse(String(body.data ?? '{}')) as Json;
    mockLog('claude_reset_claim', { authIndex: body.authIndex, url, ...claim });
    if (!bank || claim.grant_id !== 'launch_week' || bank.left === 0) return ok({ result: 'ineligible', reason: 'unknown_grant' });
    if (!bank.anytime && !atLimit) return ok({ result: 'not_limited', reason: 'not_limited' });
    bank.left -= 1;
    return ok({ result: 'reset', resets_left: bank.left, cleared: ['five_hour', 'seven_day'], weekly_resets_at: iso(4 * 86_400_000) });
  }
  if (url.includes('api.x.ai/v1/me')) return ok({ user_id: 'u_1', team_id: 't_1' });
  if (url.includes('api.x.ai/v1/chat/completions')) return ok({ id: 'chatcmpl', choices: [] });
  return { status_code: 404, body: '{}' };
}

function managementRequest(request: ManagementRequest): unknown {
  const method = String(request.method ?? 'GET');
  const path = String(request.path ?? '');
  const query = (request.query ?? {}) as Record<string, string>;
  const body = (request.body ?? {}) as Json;
  if (path === '/auth-files' && method === 'GET') {
    // With `?accounts=fail`, listing the credentials fails every time.
    if (params.get('accounts') === 'fail') throw coreFailure(500, 'couldn’t read the auth directory');
    // The real core re-observes quota and cooldowns constantly, so every listing
    // differs slightly. Reproduced here, since that can make each credential look
    // like it had just been rewritten.
    const observedAt = Date.now();
    authFiles.forEach((file) => {
      file.quota = { observed_at: new Date(observedAt).toISOString(), signals: { 'Retry-After': String(Math.floor(Math.random() * 1000)) } };
      // The core stamps `updated_at` after every request a credential serves.
      if (!file.disabled) file.updated_at = new Date(observedAt - Math.floor(Math.random() * 60_000)).toISOString();
    });
    const files = authFiles.map((file) => listingEntry(file, observedAt));
    // A file the core deleted is listed from memory once more, until its watcher catches up.
    for (let index = authFiles.length - 1; index >= 0; index -= 1) {
      if (authFiles[index]?.lingering) authFiles.splice(index, 1);
    }
    return { files, observed_at: new Date(observedAt).toISOString() };
  }
  if (path === '/auth-files/refresh' && method === 'POST') {
    const file = authFiles.find((entry) => entry.name === body.name);
    if (!file) throw coreFailure(404, 'auth file not found');
    // Like the core's forced refresh: new tokens clear the credential's error and
    // any rejected-token rests, while other model rests run their course.
    const refreshedAt = new Date().toISOString();
    Object.assign(file, { status: 'active', status_message: '', unavailable: false, last_refresh: refreshedAt, modtime: refreshedAt });
    if (Array.isArray(file.cooldowns)) {
      file.cooldowns = (file.cooldowns as Json[]).filter((cooldown) => cooldown.reason !== 'unauthorized' && cooldown.reason !== 'invalid_grant');
    }
    delete file.next_retry_after;
    return { ok: true, auth: { id: file.name } };
  }
  if (path === '/auth-files' && method === 'DELETE') {
    const index = authFiles.findIndex((file) => file.name === query.name);
    if (index >= 0) authFiles.splice(index, 1);
    return { ok: true };
  }
  if (path === '/auth-files/status') {
    if (params.get('pause') === 'fail') throw coreFailure(500, 'mock store is read-only');
    const file = authFiles.find((entry) => entry.name === body.name);
    if (file) Object.assign(file, { disabled: Boolean(body.disabled), status: body.disabled ? 'disabled' : 'active', modtime: new Date().toISOString() });
    return { ok: true };
  }
  if (path === '/auth-files/fields') {
    const file = authFiles.find((entry) => entry.name === body.name);
    if (file) Object.assign(file, body, { modtime: new Date().toISOString() });
    return { ok: true };
  }
  if (path === '/auth-files/models') {
    return { models: [{ id: 'gpt-6-sol', display_name: 'GPT-6 Sol' }, { id: 'gpt-6-luna', display_name: 'GPT-6 Luna' }, { id: 'gpt-6-terra' }, { id: 'codex-mini-latest', display_name: 'Codex Mini' }] };
  }
  if (path === '/auth-files/download') {
    const file = authFiles.find((entry) => entry.name === query.name);
    if (!file) throw coreFailure(404, 'file not found');
    const content = Object.fromEntries(Object.entries(file).filter(([key]) => !listingOnlyFields.includes(key)));
    return { ...content, access_token: `mock-access-${String(file.name)}`, refresh_token: `mock-refresh-${String(file.name)}` };
  }
  if (path === '/api-call') return apiCall(body);
  if (path === '/reset-quota' && method === 'POST') {
    mockLog('reset_quota', body);
    if (codexResetScenario === 'clear-fails') throw coreFailure(500, 'failed to reset quota: mock store is read-only');
    const file = authFiles.find((entry) => entry.auth_index === body.auth_index);
    if (!file) throw coreFailure(404, 'auth not found');
    // Like the core, this only clears the account's rests; nothing goes to the provider.
    Object.assign(file, { cooldowns: [], unavailable: false, modtime: new Date().toISOString() });
    if (!file.disabled) Object.assign(file, { status: 'active', status_message: '' });
    delete file.next_retry_after;
    return { status: 'ok', auth_index: file.auth_index, models: [] };
  }
  if (path === '/oauth-session') return { ok: true };
  if (path === '/config') return { 'oauth-excluded-models': {} };
  if (path === '/openai-compatibility') return [];
  return {};
}

// Release notes as GitHub's releases feed gives them, newest first.
function mockCoreReleases(): { version: string; releases: ReleaseNotes[] } {
  const scenario = params.get('corenotes');
  if (scenario === 'none') return { version: 'v6.8.22', releases: [] };
  const release = (version: string, changes: string[]) => ({ version, changes });
  const newest = release('v6.8.22', [
    'fix(codex): send the ChatGPT routing hint native Codex sends',
    'fix(claude): align 2.1.280 fingerprint & thinking visibility (#6096)',
    'fix(api): immediately close connections on stop and guard state access',
  ]);
  if (scenario === 'long') {
    return {
      version: 'v6.8.25',
      releases: [
        release('v6.8.25', ['feat(executor): support resolved thinking for xAI responses']),
        release('v6.8.24', ['fix(registry): keep request context active until the body is read', 'fix(translator): sanitize tool names for Claude']),
        release('v6.8.23', ['fix(auth): reduce stream rewrite log noise']),
        newest,
        release('v6.8.21', ['Already installed, so not shown']),
      ],
    };
  }
  return { version: 'v6.8.22', releases: [newest, release('v6.8.21', ['Already installed, so not shown'])] };
}

// With `?corecmd=fail`, starting, stopping and restarting the core fail.
const failCoreCommand = () => {
  if (params.get('corecmd') === 'fail') throw 'The core didn’t answer on 127.0.0.1:8317 within 15 seconds';
};

/** The core: its process, updates and config, model routing, its management API and signing in. */
export const coreAnswers: CommandAnswers<CoreCommands> = {
  get_core_status: () => {
    if (coreScenario === 'unreadable') throw 'The core’s status file is locked by another process';
    return coreStatus;
  },
  start_core_process: () => {
    failCoreCommand();
    coreStatus = { ...coreStatus, running: true, ready: true, processId: 48213 };
    return coreStatus;
  },
  stop_core_process: () => {
    failCoreCommand();
    coreStatus = { ...coreStatus, running: false, ready: false, processId: null };
    return coreStatus;
  },
  restart_core_process: () => {
    failCoreCommand();
    coreStatus = { ...coreStatus, running: true, ready: true, processId: 48214 };
    return coreStatus;
  },
  get_core_config_settings: () => {
    if (params.get('coreconfig') === 'fail') throw 'Couldn’t read config.yaml: permission denied';
    return configSettings;
  },
  get_core_tls_settings: () => tlsSettings,
  add_core_api_key: (args) => {
    configSettings.apiKeys.push({ apiKey: args.apiKey, apiKeyHash: `hash-${Date.now()}`, remark: args.remark });
    return configSettings;
  },
  update_core_api_key: (args) => {
    const key = configSettings.apiKeys.find((entry) => entry.apiKey === args.originalApiKey);
    if (!key) throw 'API key not found';
    Object.assign(key, { apiKey: args.apiKey, remark: args.remark });
    return configSettings;
  },
  delete_core_api_key: (args) => {
    configSettings.apiKeys = configSettings.apiKeys.filter((entry) => entry.apiKey !== args.apiKey);
    return configSettings;
  },
  pause_core_api_key: (args) => {
    mockLog('pause_core_api_key', args);
    const index = configSettings.apiKeys.findIndex((key) => key.apiKeyHash === args.apiKeyHash);
    if (index < 0) throw new Error('This key isn’t in the core’s list any more; refresh and try again');
    if (configSettings.apiKeys.length === 1) throw new Error('This is the only authentication key. Without one the core lets any client in, so add another key before pausing this one');
    configSettings.pausedApiKeys.push(...configSettings.apiKeys.splice(index, 1));
    return configSettings;
  },
  resume_core_api_key: (args) => {
    mockLog('resume_core_api_key', args);
    const index = configSettings.pausedApiKeys.findIndex((key) => key.apiKeyHash === args.apiKeyHash);
    if (index < 0) throw new Error('This key isn’t paused any more; refresh and try again');
    configSettings.apiKeys.push(...configSettings.pausedApiKeys.splice(index, 1));
    return configSettings;
  },
  delete_paused_core_api_key: (args) => {
    mockLog('delete_paused_core_api_key', args);
    configSettings.pausedApiKeys = configSettings.pausedApiKeys.filter((key) => key.apiKeyHash !== args.apiKeyHash);
    return configSettings;
  },
  set_core_management_secret_key: () => configSettings,
  set_core_routing_strategy: (args) => { configSettings.routingStrategy = args.strategy; return configSettings; },
  save_core_logging_settings: (args) => saveCoreSettings('save_core_logging_settings', args.settings),
  turn_on_usage_statistics: () => {
    mockLog('turn_on_usage_statistics', null);
    proxyScenario.delete('usage-off');
    configSettings.usageStatisticsEnabled = true;
    return configSettings;
  },
  check_proxy_settings: () => mockProxyChecks(),
  confirm_core_settings: (): SettingsInEffect => {
    if (coreScenario !== 'running') return { state: 'coreStopped', settings: [], line: null };
    if (saveScenario !== 'not-loaded') return { state: 'live', settings: [], line: null };
    proxyScenario.add('not-loaded');
    return { state: 'notLoaded', settings: ['requestRetry'], line: 153 };
  },
  save_network_endpoint_settings: (args) => saveCoreSettings('save_network_endpoint_settings', args.settings),
  save_retry_settings: (args) => saveCoreSettings('save_retry_settings', args.settings),
  save_session_routing_settings: (args) => saveCoreSettings('save_session_routing_settings', args.settings),
  save_core_tls_settings: (args) => {
    if (coreSaveFails('save_core_tls_settings')) throw 'Couldn’t write config.yaml: permission denied';
    Object.assign(tlsSettings, args.settings);
    return tlsSettings;
  },
  open_core_logs_directory: () => null,
  reveal_core_config_file: () => { mockLog('reveal_core_config_file', null); return null; },
  open_auth_files_directory: () => null,
  open_oauth_url: () => null,
  check_latest_core: () => { mockLog('check_latest_core', null); return { assetName: 'cli-proxy-api-darwin-arm64.tar.gz', ...mockCoreReleases() }; },
  get_core_install_task: () => installTask,
  install_core_version: (args) => {
    mockLog('install_core_version', args);
    const version = args.version ?? 'v6.8.22';
    installTask = { running: true, cancelable: true, phase: 'downloading', percent: 42, downloaded: 20_000_000, total: 48_000_000, message: null, result: null };
    if (params.get('install') === 'fail') {
      return new Promise((_, reject) => window.setTimeout(() => {
        installTask = { ...installTask, running: false, cancelable: false, phase: 'failed', message: 'Download failed: connection reset by GitHub' };
        // As the native side fails it: its kind, and the sentence to show.
        reject({ kind: 'failed', message: 'Download failed: connection reset by GitHub' });
      }, 2_000));
    }
    return new Promise((resolve, reject) => window.setTimeout(() => {
      if (installTask.phase === 'canceled') {
        reject({ kind: 'canceled', message: 'Download canceled' });
        return;
      }
      const result = { version, assetName: 'cli-proxy-api_darwin_arm64.tar.gz', installDir: coreStatus.installDir, binaryPath: coreStatus.binaryPath };
      installTask = { running: false, cancelable: false, phase: 'completed', percent: 100, downloaded: 48_000_000, total: 48_000_000, message: null, result };
      coreStatus = { ...coreStatus, installed: true, currentVersion: version, binaryPath: coreStatus.binaryPath ?? `${coreStatus.installDir}/cli-proxy-api` };
      resolve(result);
    }, 4_000));
  },
  cancel_core_install: () => {
    installTask = { ...installTask, running: false, phase: 'canceled' };
    return null;
  },
  get_model_overrides: () => modelOverrides,
  get_extra_models: () => extraModelsView(),
  set_extra_models: (args) => {
    const current = JSON.stringify((extraModels[args.provider] ?? []).map((model) => model.id));
    if (JSON.stringify(args.expected.map((model) => model.id)) !== current) {
      throw 'The extra models changed while saving; refresh and try again';
    }
    if (extraModelsScenario === 'saveFails' && args.models.length > 0) {
      throw 'The proxy didn’t load Arbor’s model plugin, so the change was taken back out. Nothing changed.';
    }
    mockLog('set_extra_models', { provider: args.provider, models: args.models.map((model) => model.id) });
    extraModels[args.provider] = args.models;
    return extraModelsView();
  },
  create_model_override: (args) => {
    const source = aliasSourceFor(args.sourceId);
    const requestedModel = args.requestedModel;
    if (requestedModel.toLowerCase() === source.model.toLowerCase()) {
      throw new Error('The requested model cannot be the same as the upstream model');
    }
    const entry = { requestedModel, upstreamModel: source.model, oauthChannel: source.protocol, provider: source.provider, kind: source.kind, forceMapping: args.forceMapping ?? true, longContext: /\[1m\]$/i.test(requestedModel) };
    const entries = [entry];
    if (args.includeLongContext && !entry.longContext) {
      entries.push({ ...entry, requestedModel: `${requestedModel}[1m]`, upstreamModel: `${source.model}[1m]`, longContext: true });
    }
    for (const candidate of entries) {
      if (modelOverrides.some((existing) => existing.requestedModel.toLowerCase() === candidate.requestedModel.toLowerCase())
        || [...thinkingAliases, ...speedAliases].some((existing) => existing.alias.toLowerCase() === candidate.requestedModel.toLowerCase())) {
        throw new Error(`${candidate.requestedModel} is already routed or aliased; remove it first`);
      }
    }
    modelOverrides = [...modelOverrides, ...entries];
    return modelOverrides;
  },
  delete_model_override: (args) => {
    const requestedModel = args.requestedModel.toLowerCase();
    const names = /\[1m\]$/i.test(requestedModel) ? [requestedModel] : [requestedModel, `${requestedModel}[1m]`];
    modelOverrides = modelOverrides.filter((entry) => entry.oauthChannel.toLowerCase() !== args.oauthChannel.toLowerCase() || !names.includes(entry.requestedModel.toLowerCase()));
    return modelOverrides;
  },
  // Like the backend, list model overrides among the OAuth aliases; the Aliases page filters them out.
  get_thinking_aliases: () => [
    ...thinkingAliases,
    ...modelOverrides.map((entry) => ({ sourceModel: entry.upstreamModel, alias: entry.requestedModel, effort: null, provider: entry.provider, kind: entry.kind, oauthChannel: entry.oauthChannel })),
  ],
  get_model_alias_sources: () => aliasSourcesWhere(() => true),
  get_thinking_alias_sources: () => aliasSourcesWhere((source) => source.supportsReasoning),
  get_speed_aliases: () => speedAliases,
  get_speed_alias_sources: () => aliasSourcesWhere((source) => source.supportsFast),
  create_thinking_alias: (args) => {
    const source = aliasSourceFor(args.sourceId);
    thinkingAliases = [...thinkingAliases, { sourceModel: source.model, alias: args.alias, effort: args.effort ?? null, provider: source.provider, kind: source.kind, oauthChannel: source.protocol }];
    return thinkingAliases;
  },
  create_speed_alias: (args) => {
    const source = aliasSourceFor(args.sourceId);
    speedAliases = [...speedAliases, { sourceModel: source.model, alias: args.alias, serviceTier: 'priority', provider: source.provider, kind: source.kind, oauthChannel: source.protocol }];
    return speedAliases;
  },
  delete_thinking_alias: (args) => { thinkingAliases = thinkingAliases.filter((entry) => entry.alias !== args.alias); return thinkingAliases; },
  delete_speed_alias: (args) => { speedAliases = speedAliases.filter((entry) => entry.alias !== args.alias); return speedAliases; },
  list_oauth_browsers: () => [{ id: 'default', label: 'System default browser' }, { id: 'chrome', label: 'Google Chrome' }, { id: 'arc', label: 'Arc' }],
  start_oauth_login: (args) => {
    oauthLogin = { provider: args.provider, polls: 0 };
    const url = args.provider === 'claude'
      ? 'https://claude.ai/oauth/authorize?code=true&client_id=app&state=mock-state-1234'
      : args.provider === 'xai'
        ? 'https://auth.x.ai/oauth2/authorize?client_id=app&state=mock-state-1234'
        : 'https://auth.openai.com/oauth/authorize?client_id=app&state=mock-state-1234';
    const opened = signInScenario !== 'link' && args.browser !== 'none';
    return { url, state: 'mock-state-1234', opened, openError: null };
  },
  get_oauth_status: () => {
    if (!oauthLogin) return { status: 'pending', error: null };
    oauthLogin.polls += 1;
    if (oauthLogin.polls < 2 || signInScenario === 'wait' || signInScenario === 'link') return { status: 'pending', error: null };
    if (signInScenario === 'fail') {
      oauthLogin = null;
      return { status: 'error', error: 'The provider refused the sign-in (access_denied)' };
    }
    // The core always saves a login under its own canonical file name.
    const canonical = oauthLogin.provider === 'claude'
      ? fleetAccounts
        ? fileEntry('claude-3c9d41e2-sam.side@example.com.json', { provider: 'claude', email: 'sam.side@example.com', account_uuid: 'uuid-side', auth_index: 'cc-side', size: 1680 })
        : fileEntry('claude-5772b8d7-casey@example.com.json', { provider: 'claude', email: 'casey@example.com', account_uuid: 'uuid-casey', auth_index: 'claude-9', size: 1680 })
      : oauthLogin.provider === 'xai'
        ? fileEntry('xai-4b2e-casey@example.com.json', { provider: 'xai', email: 'casey@example.com', account_id: 'acct-xai', auth_index: 'xai-9', size: 912 })
        : fileEntry('codex-9f1e2a3b-casey@example.com-pro.json', { provider: 'codex', email: 'casey@example.com', account_id: 'acct-casey', auth_index: 'codex-9', size: 4483 });
    const savedAt = new Date().toISOString();
    const saved = { status: 'active', status_message: '', unavailable: false, cooldowns: [], modtime: savedAt, updated_at: savedAt };
    // Core 7.2.158+ also carries an older Claude file's settings into the new
    // name and deletes that file itself.
    const replaced = oauthLogin.provider === 'claude'
      ? authFiles.find((entry) => entry.provider === 'claude' && entry.account_uuid === canonical.account_uuid && entry.name !== canonical.name && !entry.lingering)
      : undefined;
    const existing = authFiles.find((entry) => entry.name === canonical.name);
    if (existing) {
      Object.assign(existing, saved);
    } else {
      const carried = replaced ? Object.fromEntries(['priority', 'disabled', 'note', 'excluded_models'].filter((key) => key in replaced).map((key) => [key, replaced[key]])) : {};
      authFiles.push({ ...canonical, ...carried, ...saved });
    }
    if (replaced) Object.assign(replaced, { source: 'memory', lingering: true });
    oauthLogin = null;
    return { status: 'ok', error: null };
  },
  submit_oauth_callback: () => null,
  upload_auth_file: (args) => {
    const text = new TextDecoder().decode(Uint8Array.from(args.data));
    const parsed = JSON.parse(text) as Json;
    const name = args.name;
    const index = authFiles.findIndex((entry) => entry.name === name);
    const previous = index >= 0 ? authFiles[index] : undefined;
    const next = fileEntry(name, {
      auth_index: previous?.auth_index ?? `upload-${name}`,
      ...parsed,
      name,
      size: text.length, modtime: new Date().toISOString(), status: 'active', status_message: '', unavailable: false, cooldowns: [],
    });
    if (index >= 0) authFiles[index] = next; else authFiles.push(next);
    mockLog('upload_auth_file', { name, keys: Object.keys(parsed) });
    return { status: 'ok' };
  },
  management_request: (args) => coreReply(managementRequest(args.request)),
};


/** With `?core=stops`, the core stops eight seconds after the page loads, as if it quit on its own. */
export function stopCoreLater() {
  window.setTimeout(() => {
    coreStatus = { ...coreStatus, running: false, ready: false, processId: null };
    void emit('core-status-changed', coreStatus);
  }, 8_000);
}
