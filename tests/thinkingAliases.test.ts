import { describe, expect, test } from 'bun:test';
import {
  combineModelAliasEntries,
  combineModelAliasSources,
  defaultModelAlias,
  excludeModelOverrides,
  reselectAliasSource,
  uniqueModelAlias,
} from '../src/services/modelAliases';

describe('模型别名默认名称', () => {
  test('按思考强度和 Fast 选项生成可编辑的默认名称', () => {
    expect(defaultModelAlias('gpt-5.6-sol', 'XHigh', false)).toBe('gpt-5.6-sol-xhigh');
    expect(defaultModelAlias('gpt-5.6-sol', '', true)).toBe('gpt-5.6-sol-fast');
    expect(defaultModelAlias('gpt-5.6-sol', 'xhigh', true)).toBe('gpt-5.6-sol-xhigh-fast');
    expect(defaultModelAlias('gpt-5.6-sol', '', false)).toBe('gpt-5.6-sol-alias');
  });

  test('默认别名与现有模型重名时递增数字后缀', () => {
    expect(uniqueModelAlias('gpt-5.6-sol-high', ['gpt-5.6-sol-high'])).toBe('gpt-5.6-sol-high-2');
    expect(uniqueModelAlias('gpt-5.6-sol-high', [
      'gpt-5.6-sol-high',
      'gpt-5.6-sol-high-2',
    ])).toBe('gpt-5.6-sol-high-3');
    expect(uniqueModelAlias('gpt-5.6-sol-high', ['GPT-5.6-SOL-HIGH'])).toBe('gpt-5.6-sol-high-2');
  });
});

describe('统一模型别名列表', () => {
  test('同一个别名可同时显示思考强度和 Fast', () => {
    const identity = {
      sourceModel: 'gpt-5.6-sol',
      alias: 'gpt-5.6-sol-xhigh-fast',
      provider: 'Codex OAuth',
      kind: 'codex-oauth',
      oauthChannel: 'codex',
    };
    const entries = combineModelAliasEntries(
      [{ ...identity, effort: 'xhigh' }],
      [{ ...identity, serviceTier: 'priority' }],
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ effort: 'xhigh', serviceTier: 'priority' });
  });

  test('Fast-only 别名仍会显示为独立条目', () => {
    const entries = combineModelAliasEntries([], [{
      sourceModel: 'gpt-5.6-sol',
      alias: 'gpt-5.6-sol-fast',
      serviceTier: 'priority',
      provider: 'Codex OAuth',
      kind: 'codex-oauth',
      oauthChannel: 'codex',
    }]);

    expect(entries[0]).toMatchObject({ effort: null, serviceTier: 'priority' });
  });

  test('leaves model overrides to Model Routing', () => {
    const entry = (alias: string, oauthChannel: string | null) => ({
      sourceModel: 'claude-opus-5',
      alias,
      effort: null,
      serviceTier: null,
      provider: 'Claude OAuth',
      kind: 'claude-oauth',
      oauthChannel,
    });
    const entries = [
      entry('claude-fable-5-1', 'claude'),
      entry('Claude-Fable-5-1[1M]', 'Claude'),
      entry('claude-fable-5-1', 'codex'),
      entry('claude-fable-5-1', null),
      entry('fable-max', 'claude'),
    ];

    const visible = excludeModelOverrides(entries, [
      { requestedModel: 'claude-fable-5-1', oauthChannel: 'claude' },
      { requestedModel: ' claude-fable-5-1[1m] ', oauthChannel: 'claude' },
    ]);

    expect(visible.map((item) => [item.alias, item.oauthChannel])).toEqual([
      ['claude-fable-5-1', 'codex'],
      ['claude-fable-5-1', null],
      ['fable-max', 'claude'],
    ]);
    expect(excludeModelOverrides(entries, [])).toEqual(entries);
  });
});

describe('思考别名来源', () => {
  test('仅把内核报告了思考等级的来源标为可覆写', () => {
    const baseSource = {
      model: 'shared-model',
      displayName: 'Shared Model',
      provider: 'Provider',
      kind: 'codex-api',
      protocol: 'codex',
      reasoningLevels: [] as string[],
    };
    const sources = combineModelAliasSources(
      [
        { ...baseSource, id: 'reasoning' },
        { ...baseSource, id: 'plain', model: 'plain-model' },
      ],
      [{ ...baseSource, id: 'reasoning', reasoningLevels: ['low', 'high'] }],
      [{ ...baseSource, id: 'reasoning', reasoningLevels: ['low', 'high'] }],
    );

    expect(sources).toHaveLength(2);
    expect(sources.find((source) => source.id === 'reasoning')).toMatchObject({
      supportsReasoning: true,
      supportsFast: true,
      reasoningLevels: ['low', 'high'],
    });
    expect(sources.find((source) => source.id === 'plain')?.supportsReasoning).toBe(false);
    expect(sources.find((source) => source.id === 'plain')?.supportsFast).toBe(false);
  });
});

describe('reselectAliasSource', () => {
  const source = (id: string, model = 'deepseek-chat') => ({
    id,
    model,
    displayName: null,
    provider: 'DeepSeek',
    kind: 'openai-compatibility',
    protocol: 'openai',
    reasoningLevels: [],
  });

  test('keeps an ID that still exists', () => {
    expect(reselectAliasSource('a', source('a'), [source('a'), source('b', 'other')])).toBe('a');
  });

  test('follows a source whose ID changed after an alias was added to its provider', () => {
    expect(reselectAliasSource('old', source('old'), [source('new'), source('b', 'other')])).toBe('new');
  });

  test('clears the selection when no single source matches', () => {
    expect(reselectAliasSource('old', source('old'), [source('b', 'other')])).toBe('');
    expect(reselectAliasSource('old', source('old'), [source('x'), source('y')])).toBe('');
    expect(reselectAliasSource('old', null, [source('x')])).toBe('');
  });
});
