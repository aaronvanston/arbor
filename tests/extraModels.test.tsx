import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { ExtraModelRows, SuggestionRows, type Check } from '../src/pages/ExtraModelsPage';
import {
  ANTHROPIC_MODELS_URL,
  CODEX_MODELS_URL,
  accountFor,
  extraModelFrom,
  extraModelIdProblem,
  extraModelStatus,
  fetchAnthropicModels,
  fetchCodexModels,
  modelVersion,
  parseAnthropicModels,
  parseCodexModels,
  suggestExtraModels,
  templateFor,
} from '../src/services/extraModels';
import type { ExtraModel, ExtraModelsProvider, ExtraModelsView } from '../src/native/types';
import { present } from './support/items';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const model = (id: string, more: Partial<ExtraModel> = {}): ExtraModel => ({
  id, displayName: null, description: null, contextLength: null, maxCompletionTokens: null, thinking: null,
  inputModalities: [], outputModalities: [], ...more,
});
const levels = { levels: ['low', 'high'], min: null, max: null, zeroAllowed: true, dynamicAllowed: true };
const catalog = [
  model('claude-sonnet-5', { displayName: 'Claude Sonnet 5', contextLength: 1_000_000, maxCompletionTokens: 128_000, thinking: levels, inputModalities: ['text', 'image'], outputModalities: ['text'] }),
  model('claude-sonnet-4-6', { contextLength: 200_000, maxCompletionTokens: 64_000 }),
  model('claude-opus-5-5', { contextLength: 1_000_000 }),
  model('claude-3-7-sonnet-20250219', { contextLength: 128_000 }),
  model('claude-haiku-4-5-20251001', { contextLength: 200_000 }),
];
const codexCatalog = [
  model('gpt-6-sol', { contextLength: 272_000, maxCompletionTokens: 128_000, outputModalities: ['text'] }),
  model('gpt-6-luna', { contextLength: 272_000 }),
  model('gpt-5.6-luna', { contextLength: 921_000 }),
  model('gpt-5.5', { contextLength: 272_000 }),
];
const claude = (more: Partial<ExtraModelsProvider> = {}): ExtraModelsProvider => ({
  provider: 'claude', models: [], catalog, hasAccount: true, pluginInstalled: true, pluginLoaded: true, ...more,
});
const codex = (more: Partial<ExtraModelsProvider> = {}): ExtraModelsProvider => ({
  provider: 'codex', models: [], catalog: codexCatalog, hasAccount: true, pluginInstalled: true, pluginLoaded: true, ...more,
});
const view = (providers: ExtraModelsProvider[], more: Partial<ExtraModelsView> = {}): ExtraModelsView => ({
  providers, served: providers.flatMap((entry) => entry.catalog.map((item) => item.id)), coreRunning: true, ...more,
});

describe('extra models', () => {
  it('reads Anthropic’s model list, each model once', () => {
    expect(parseAnthropicModels({
      data: [
        { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-09-29T00:00:00Z' },
        { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Duplicate' },
        { type: 'model', id: ' claude-opus-5-5 ' },
        { type: 'model', display_name: 'No id' },
      ],
      has_more: false,
    })).toEqual([
      { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', details: null },
      { id: 'claude-opus-5-5', displayName: null, details: null },
    ]);
    expect(parseAnthropicModels({ error: { message: 'nope' } })).toEqual([]);
    expect(parseAnthropicModels('not json')).toEqual([]);
  });

  it('reads ChatGPT’s Codex list with the details it gives, leaving out the hidden ones', () => {
    expect(parseCodexModels({
      models: [
        {
          slug: 'gpt-6-nova', display_name: 'GPT-6-Nova', description: 'Frontier intelligence.', context_window: 400_000, max_context_window: 900_000,
          supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }, { effort: 'ultra' }, { description: 'No effort' }],
          input_modalities: ['text', 'image'], visibility: 'list',
        },
        { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
        { slug: 'gpt-6-nova', display_name: 'Duplicate' },
        { slug: 'gpt-6-bare' },
        { display_name: 'No slug' },
      ],
    })).toEqual([
      {
        id: 'gpt-6-nova',
        displayName: 'GPT-6-Nova',
        details: {
          description: 'Frontier intelligence.',
          contextLength: 400_000,
          thinking: { levels: ['low', 'ultra'], min: null, max: null, zeroAllowed: false, dynamicAllowed: false },
          inputModalities: ['text', 'image'],
        },
      },
      { id: 'gpt-6-bare', displayName: null, details: null },
    ]);
    expect(parseCodexModels({ detail: 'Unauthorized' })).toEqual([]);
  });

  it('suggests only the models the proxy can’t serve yet', () => {
    const live = [
      { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', details: null },
      { id: 'Claude-Sonnet-5', displayName: 'Claude Sonnet 5', details: null },
      { id: 'claude-haiku-5', displayName: 'Claude Haiku 5', details: null },
      { id: 'claude-served-elsewhere', displayName: null, details: null },
    ];
    expect(suggestExtraModels(live, claude({ models: [model('claude-haiku-5')] }), ['claude-served-elsewhere']))
      .toEqual([{ id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', details: null }]);
  });

  it('reads the family and version from the ways Claude and GPT ids are written', () => {
    expect(modelVersion('claude-sonnet-5-5')).toEqual({ family: 'sonnet', version: [5, 5] });
    expect(modelVersion('claude-opus-4-5-20251101')).toEqual({ family: 'opus', version: [4, 5] });
    expect(modelVersion('claude-3-7-sonnet-20250219')).toEqual({ family: 'sonnet', version: [3, 7] });
    expect(modelVersion('claude-fable-5')).toEqual({ family: 'fable', version: [5] });
    expect(modelVersion('gpt-6-luna')).toEqual({ family: 'luna', version: [6] });
    expect(modelVersion('gpt-5.6-luna')).toEqual({ family: 'luna', version: [5, 6] });
    expect(modelVersion('gpt-5.5')).toEqual({ family: 'gpt', version: [5, 5] });
    expect(modelVersion('codex-auto-review')).toBeNull();
  });

  it('fills a new model in from the nearest one of its family the catalog has', () => {
    expect(templateFor('claude-sonnet-5-5', catalog)?.id).toBe('claude-sonnet-5');
    expect(templateFor('claude-sonnet-4-7', catalog)?.id).toBe('claude-sonnet-4-6');
    // Older than any of its family: the oldest there is.
    expect(templateFor('claude-sonnet-3-5', catalog)?.id).toBe('claude-3-7-sonnet-20250219');
    // A family the catalog doesn't have: its newest model.
    expect(templateFor('claude-fable-6', catalog)?.id).toBe('claude-opus-5-5');
    expect(templateFor('claude-sonnet-5-5', [])).toBeNull();
    expect(templateFor('gpt-6.5-luna', codexCatalog)?.id).toBe('gpt-6-luna');
    expect(templateFor('gpt-5.9', codexCatalog)?.id).toBe('gpt-5.5');
    expect(templateFor('gpt-7-nova', codexCatalog)?.id).toBe('gpt-6-sol');

    expect(extraModelFrom(' claude-sonnet-5-5 ', 'Claude Sonnet 5.5', templateFor('claude-sonnet-5-5', catalog))).toEqual({
      id: 'claude-sonnet-5-5',
      displayName: 'Claude Sonnet 5.5',
      description: null,
      contextLength: 1_000_000,
      maxCompletionTokens: 128_000,
      thinking: levels,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    });
    expect(extraModelFrom('claude-x', ' ', null)).toEqual(model('claude-x'));
  });

  it('takes the details a live list gave over the template’s', () => {
    const thinking = { levels: ['low', 'ultra'], min: null, max: null, zeroAllowed: false, dynamicAllowed: false };
    expect(extraModelFrom('gpt-7-nova', 'GPT-7-Nova', codexCatalog[0] ?? null, { contextLength: 400_000, thinking, description: 'New.' })).toEqual({
      id: 'gpt-7-nova',
      displayName: 'GPT-7-Nova',
      description: 'New.',
      contextLength: 400_000,
      maxCompletionTokens: 128_000,
      thinking,
      inputModalities: [],
      outputModalities: ['text'],
    });
  });

  it('says where each extra model stands', () => {
    const provider = claude({ models: [model('claude-haiku-5'), model('claude-sonnet-5'), model('claude-opus-6')] });
    const current = view([provider], { served: [...catalog.map((entry) => entry.id), 'claude-haiku-5'] });
    expect(provider.models.map((entry) => extraModelStatus(entry, provider, current))).toEqual(['active', 'builtIn', 'notLoaded']);
    const stopped = claude({ models: [model('claude-haiku-5')], catalog: [] });
    expect(extraModelStatus(model('claude-haiku-5'), stopped, view([stopped], { served: [], coreRunning: false }))).toBe('saved');
    // Built in means in the provider's own catalog.
    expect(extraModelStatus(model('gpt-6-sol'), claude(), current)).toBe('notLoaded');
  });

  it('checks an id before adding it', () => {
    const current = claude({ models: [model('claude-haiku-5')] });
    expect(extraModelIdProblem(' ', current)).toBe('extraModels.add.error.empty');
    expect(extraModelIdProblem('claude sonnet', current)).toBe('extraModels.add.error.whitespace');
    expect(extraModelIdProblem('CLAUDE-SONNET-5', current)).toBe('extraModels.add.error.builtIn');
    expect(extraModelIdProblem('claude-haiku-5', current)).toBe('extraModels.add.error.added');
    expect(extraModelIdProblem('claude-sonnet-5-5', current)).toBeNull();
    expect(extraModelIdProblem('gpt-6-sol', codex())).toBe('extraModels.add.error.builtIn');
  });

  it('asks with an account of the provider’s that’s on and signed in, preferring a ready one', () => {
    const files = [
      { name: 'codex.json', provider: 'codex', auth_index: 'codex-1', status: 'active' },
      { name: 'off.json', provider: 'claude', auth_index: 'claude-off', disabled: true, status: 'disabled' },
      { name: 'expired.json', provider: 'claude', auth_index: 'claude-expired', status: 'error', status_message: 'invalid_grant', unavailable: true },
      { name: 'limited.json', provider: 'claude', auth_index: 'claude-limited', status: 'error', status_message: 'quota exhausted', unavailable: true, cooldowns: [{ scope: 'credential', reason: 'quota', retry_at: new Date(Date.now() + 3_600_000).toISOString() }] },
      { name: 'ready.json', provider: 'claude', auth_index: 'claude-ready', status: 'active' },
    ];
    expect(accountFor(files, 'claude')?.auth_index).toBe('claude-ready');
    expect(accountFor(files.filter((file) => file.name !== 'ready.json'), 'claude')?.auth_index).toBe('claude-limited');
    expect(accountFor(files.slice(0, 3), 'claude')).toBeNull();
    expect(accountFor(files, 'codex')?.auth_index).toBe('codex-1');
  });

  const api = (posted: unknown[], answer: Record<string, unknown>, files: unknown[]) => ({
    get: async <T,>() => ({ files }) as T,
    post: async <T,>(path: string, body?: unknown) => {
      posted.push({ path, body });
      return answer as T;
    },
  });
  type Posted = { path: string; body: { authIndex: string; method: string; url: string; header: Record<string, string> } };

  it('asks Anthropic through the proxy, which puts in the account’s token', async () => {
    const posted: unknown[] = [];
    const claudeFiles = [{ provider: 'claude', auth_index: 'claude-1', status: 'active' }];
    const listed = await fetchAnthropicModels(api(posted, { status_code: 200, body: JSON.stringify({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }] }) }, claudeFiles));
    expect(listed).toEqual({ ok: true, models: [{ id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', details: null }] });
    const request = present(posted[0]) as Posted;
    expect(request.path).toBe('/api-call');
    expect(request.body.authIndex).toBe('claude-1');
    expect(request.body.url).toBe(ANTHROPIC_MODELS_URL);
    expect(request.body.header.Authorization).toBe('Bearer $TOKEN$');
    expect(request.body.header['anthropic-version']).toBe('2023-06-01');

    expect(await fetchAnthropicModels(api(posted, { status_code: 200, body: '<html>' }, claudeFiles))).toEqual({ ok: false, reason: 'extraModels.suggestions.unreadable' });
    expect(await fetchAnthropicModels(api(posted, { status_code: 401, body: JSON.stringify({ error: { message: 'OAuth token has expired' } }) }, claudeFiles)))
      .toEqual({ ok: false, message: 'OAuth token has expired' });
    const before = posted.length;
    expect(await fetchAnthropicModels(api(posted, { status_code: 200 }, []))).toEqual({ ok: false, reason: 'extraModels.suggestions.noAccount' });
    expect(posted.length).toBe(before);
  });

  it('asks ChatGPT as the latest Codex, with the account’s id', async () => {
    const posted: unknown[] = [];
    const files = [
      { provider: 'claude', auth_index: 'claude-1', status: 'active' },
      { provider: 'codex', auth_index: 'codex-1', status: 'active', account_id: 'acct-1' },
    ];
    const listed = await fetchCodexModels(api(posted, { status_code: 200, body: JSON.stringify({ models: [{ slug: 'gpt-6-nova' }] }) }, files), '0.170.0');
    expect(listed).toEqual({ ok: true, models: [{ id: 'gpt-6-nova', displayName: null, details: null }] });
    const request = present(posted[0]) as Posted;
    expect(request.body.authIndex).toBe('codex-1');
    expect(request.body.url).toBe(`${CODEX_MODELS_URL}?client_version=0.170.0`);
    expect(request.body.header.Authorization).toBe('Bearer $TOKEN$');
    expect(request.body.header['Chatgpt-Account-Id']).toBe('acct-1');
    expect(request.body.header['User-Agent']).toStartWith('codex_cli_rs/0.170.0 ');
    expect(await fetchCodexModels(api(posted, { status_code: 200 }, files.slice(0, 1)))).toEqual({ ok: false, reason: 'extraModels.suggestions.noAccount' });
  });
});

describe('Settings › Extra models', () => {
  const render = (element: React.ReactElement) => text(renderToStaticMarkup(<I18nProvider>{element}</I18nProvider>));
  const noop = () => {};

  it('offers each new model with the one its details come from', () => {
    const check: Check = { state: 'done', result: { ok: true, models: [] } };
    const html = render(<SuggestionRows provider={claude()} check={check} suggestions={[{ id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', details: null }]} busy="" onAdd={noop} />);
    expect(html).toBe('claude-sonnet-5-5 Claude Sonnet 5.5 · Details from claude-sonnet-5 Add');
    expect(render(<SuggestionRows provider={claude()} check={check} suggestions={[]} busy="" onAdd={noop} />))
      .toBe('Nothing new. The proxy knows every model Anthropic offers your Claude account.');
    expect(render(<SuggestionRows provider={codex()} check={check} suggestions={[]} busy="" onAdd={noop} />))
      .toBe('Nothing new. The proxy knows every model OpenAI offers your Codex account.');
  });

  it('says why there are no suggestions when the check couldn’t be made', () => {
    const rows = (check: Check, provider = codex()) => render(<SuggestionRows provider={provider} check={check} suggestions={[]} busy="" onAdd={noop} />);
    expect(rows({ state: 'idle' })).toBe('Start the proxy to check for new models.');
    expect(rows({ state: 'done', result: { ok: false, reason: 'extraModels.suggestions.noAccount' } })).toBe('Sign in to a Codex account to see which models OpenAI offers it.');
    expect(rows({ state: 'done', result: { ok: false, message: 'OAuth token has expired' } }, claude())).toBe('Couldn’t check with Anthropic: OAuth token has expired');
  });

  it('lists every provider’s extra models with where each stands', () => {
    const current = view([
      claude({ models: [model('claude-haiku-5', { displayName: 'Claude Haiku 5' }), model('claude-sonnet-5'), model('claude-opus-6')] }),
      codex({ models: [model('gpt-6-nova', { displayName: 'GPT-6-Nova' })] }),
    ]);
    current.served.push('claude-haiku-5', 'gpt-6-nova');
    const html = render(<ExtraModelRows view={current} busy="" onRemove={noop} />);
    expect(html).toContain('claude-haiku-5 Claude Haiku 5 Active');
    expect(html).toContain('claude-sonnet-5 The proxy has this model built in now, so this can go. Now built in');
    expect(html).toContain('claude-opus-6 Not served');
    expect(html).toContain('gpt-6-nova GPT-6-Nova Active');
    expect(renderToStaticMarkup(<I18nProvider><ExtraModelRows view={current} busy="" onRemove={noop} /></I18nProvider>)).toContain('alt="Codex"');
    expect(render(<ExtraModelRows view={view([claude(), codex()])} busy="" onRemove={noop} />)).toContain('No extra models');
  });
});
