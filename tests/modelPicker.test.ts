import { describe, expect, it } from 'bun:test';
import type { ThinkingAliasSource } from '../src/native/types';
import { effortChoices, effortForModel, effortLabelKey, findModelChoice, modelChoices, searchModelChoices, typedModel } from '../src/services/modelPicker';
import { itemAt, present } from './support/items';

const source = (fields: Partial<ThinkingAliasSource> & { model: string }): ThinkingAliasSource => ({
  id: `${fields.kind ?? 'codex-oauth'}:${fields.model}`,
  displayName: null,
  provider: 'Codex OAuth',
  kind: 'codex-oauth',
  protocol: 'codex',
  reasoningLevels: ['low', 'medium', 'high'],
  ...fields,
});

const choices = modelChoices([
  source({ model: 'gpt-6-sol', displayName: 'GPT-6 Sol', reasoningLevels: ['low', 'medium', 'high', 'xhigh'] }),
  source({ model: 'gpt-6-luna', displayName: 'GPT-6 Luna' }),
  source({ model: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', provider: 'Claude OAuth', kind: 'claude-oauth', reasoningLevels: ['high', 'max'] }),
  source({ model: 'GPT-6-Sol', provider: 'Codex API', kind: 'codex-api', reasoningLevels: ['minimal', 'low'] }),
  source({ model: 'plain-chat', provider: 'Example router', kind: 'openai-compatible', reasoningLevels: [] }),
]);

describe('model choices', () => {
  it('lists a model once, with every provider that serves it and every effort either takes', () => {
    expect(choices.map((choice) => choice.model)).toEqual(['gpt-6-sol', 'gpt-6-luna', 'claude-fable-5-1', 'plain-chat']);
    const sol = itemAt(choices, 0);
    expect(sol.providers).toEqual(['Codex OAuth', 'Codex API']);
    expect(sol.reasoningLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'minimal']);
  });

  it('finds a saved model whatever its case, and not one the proxy doesn’t list', () => {
    expect(present(findModelChoice(choices, ' GPT-6-LUNA ')).model).toBe('gpt-6-luna');
    expect(findModelChoice(choices, 'luna-fast')).toBeNull();
  });
});

describe('searching models', () => {
  const found = (query: string) => searchModelChoices(choices, query).map((choice) => choice.model);

  it('keeps the core’s order with nothing typed', () => {
    expect(found('  ')).toEqual(choices.map((choice) => choice.model));
  });

  it('puts the closest name first', () => {
    expect(found('luna')).toEqual(['gpt-6-luna']);
    expect(itemAt(found('gpt-6-l'), 0)).toBe('gpt-6-luna');
  });

  it('matches a provider, and needs every word', () => {
    expect(found('claude')).toEqual(['claude-fable-5-1']);
    expect(found('codex sol')).toEqual(['gpt-6-sol']);
    expect(found('codex fable')).toEqual([]);
  });

  it('offers a typed name only when it’s one word the list doesn’t have', () => {
    expect(typedModel(choices, ' luna-fast ')).toBe('luna-fast');
    expect(typedModel(choices, 'GPT-6-Luna')).toBeNull();
    expect(typedModel(choices, 'codex sol')).toBeNull();
    expect(typedModel(choices, '')).toBeNull();
  });
});

describe('a model’s efforts', () => {
  it('offers the model’s own, and the common three for one nobody lists', () => {
    expect(effortChoices(findModelChoice(choices, 'claude-fable-5-1'), 'low')).toEqual(['high', 'max']);
    expect(effortChoices(findModelChoice(choices, 'plain-chat'), 'low')).toEqual([]);
    expect(effortChoices(null, 'low')).toEqual(['low', 'medium', 'high']);
    expect(effortChoices(null, 'xhigh')).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('keeps the effort in use when the new model takes it, else starts on its lowest', () => {
    expect(effortForModel(findModelChoice(choices, 'gpt-6-sol'), 'xhigh')).toBe('xhigh');
    expect(effortForModel(findModelChoice(choices, 'gpt-6-luna'), 'xhigh')).toBe('low');
    expect(effortForModel(findModelChoice(choices, 'claude-fable-5-1'), 'low')).toBe('high');
    expect(effortForModel(findModelChoice(choices, 'plain-chat'), 'low')).toBe('');
    expect(effortForModel(null, 'xhigh')).toBe('xhigh');
    expect(effortForModel(null, '')).toBe('low');
  });

  it('names the efforts it knows and leaves the rest as the core spells them', () => {
    expect(effortLabelKey('xhigh')).toBe('modelPicker.effort.xhigh');
    expect(effortLabelKey('turbo')).toBeNull();
  });
});
