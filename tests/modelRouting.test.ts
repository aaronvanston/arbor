import { describe, expect, it } from 'bun:test';
import { availableQuickRoutes, groupSources, routableSources, type RouteSource } from '../src/pages/ModelRoutingPage';
import type { ModelOverrideEntry } from '../src/native/types';

const source = (kind: string, model: string): RouteSource => ({ id: `${kind}:${model}`, model, displayName: null, provider: kind, kind, protocol: 'x' });

const sources: RouteSource[] = [
  source('claude-oauth', 'claude-fable-5-1'),
  source('claude-oauth', 'claude-opus-5'),
  source('codex-oauth', 'gpt-5.6-sol'),
  source('codex-api', 'gpt-5.6-luna'),
];

describe('model routing helpers', () => {
  it('only offers OAuth sources as upstream targets', () => {
    expect(routableSources(sources).map((entry) => entry.id)).toEqual([
      'claude-oauth:claude-fable-5-1',
      'claude-oauth:claude-opus-5',
      'codex-oauth:gpt-5.6-sol',
    ]);
    expect(groupSources(sources).map(([kind, list]) => [kind, list.length])).toEqual([['claude-oauth', 2], ['codex-oauth', 1]]);
  });

  it('surfaces quick routes only when both ends exist on the same channel', () => {
    const quick = availableQuickRoutes(sources, []);
    expect(quick.map((route) => `${route.requested}>${route.upstream}`)).toEqual(['claude-fable-5-1>claude-opus-5']);
    expect(quick[0]?.sourceId).toBe('claude-oauth:claude-opus-5');
    expect(quick[0]?.active).toBeNull();
  });

  it('marks a quick route active when either its base or [1m] rule exists', () => {
    const override: ModelOverrideEntry = {
      requestedModel: 'claude-fable-5-1[1m]',
      upstreamModel: 'claude-opus-5[1m]',
      oauthChannel: 'claude',
      provider: 'Claude OAuth',
      kind: 'claude-oauth',
      forceMapping: true,
      longContext: true,
    };
    expect(availableQuickRoutes(sources, [override])[0]?.active).toEqual(override);
  });
});
