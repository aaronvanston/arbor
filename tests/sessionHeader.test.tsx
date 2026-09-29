import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import type { SessionTranscript, UsageSession } from '../src/native/types';
import { SessionHeader } from '../src/pages/SessionDetailPage';

const MINUTE = 60_000;
const now = Date.now();

const transcript = (fields: Partial<SessionTranscript> = {}): SessionTranscript => ({
  machine: 'casey-mbp', agent: 'claude', home: '/Users/casey', agentHome: '', cwd: '/Users/casey/.t3/worktrees/arbor/login-loop',
  repoRoot: '/Users/casey/.t3/worktrees/arbor/login-loop', mainRepo: '/Users/casey/src/arbor', branch: 'fix/login-loop', commitHash: '',
  repositoryUrl: '', title: 'Fix the login redirect loop', titleSource: 'ai',
  pullRequests: [{ url: 'https://github.com/aaronvanston/arbor/pull/412', repository: 'aaronvanston/arbor', number: 412 }],
  linesAdded: 214, linesRemoved: 37, compactions: [], toolUsage: null, readAtMs: now - 2 * MINUTE,
  ...fields,
});

const session = (fields: Partial<UsageSession> = {}): UsageSession => ({
  id: 'a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7', parentId: null, depth: 0, models: ['claude-opus-5-5'], providers: ['claude'],
  userAgent: 'claude-cli/2.1.280 (external, cli)', startedAtMs: now - 90 * MINUTE, lastActiveAtMs: now - 2 * MINUTE, requests: 40,
  failures: 0, canceled: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  totalTokens: 1_200_000, estimatedCost: 12.4, pricedRequests: 40, peakContext: 0, compactions: 0, provider: 'claude',
  machine: 'casey-mbp', pool: '', apiKeyHash: '', active: true, hasOwnRequests: true, subagents: 0, threads: [],
  transcript: transcript(),
  ...fields,
});

const render = (item: UsageSession) =>
  renderToStaticMarkup(
    <I18nProvider>
      <SessionHeader session={item} onViewRequests={() => {}} />
    </I18nProvider>,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const global = globalThis as { localStorage?: unknown };
const previous = global.localStorage;
afterEach(() => {
  global.localStorage = previous;
});

describe('session header', () => {
  test('puts the title, the id to copy, and one line of where it ran and what it worked on', () => {
    const html = text(render(session()));
    expect(html).toContain('Fix the login redirect loop a3f1c2d4');
    expect(html).toContain('View requests');
    expect(html).toContain('casey-mbp Claude Code 2.1.280 Claude');
    expect(html).toContain('Project arbor / Worktree login-loop Branch fix/login-loop');
    expect(html).toContain('#412');
    expect(html).toContain('+214 −37');
    expect(html).toContain('Started ');
    expect(html).toContain('Last request ');
    // The raw facts wait under Details.
    expect(html).toContain('Details');
    expect(html).not.toContain('a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7');
    expect(html).not.toContain('claude-cli/2.1.280');
  });

  test('without a transcript it goes by its client, named once, with nothing about a project', () => {
    const html = text(render(session({ transcript: null, active: false })));
    expect(html.startsWith('Claude Code 2.1.280 a3f1c2d4')).toBe(true);
    expect(html.match(/Claude Code/g)).toHaveLength(1);
    expect(html).not.toContain('Project');
  });

  test('opens Details as it was last left, with the full id, the User-Agent and where the transcript came from', () => {
    global.localStorage = { getItem: () => 'open', setItem: () => {} };
    const html = text(render(session()));
    expect(html).toContain('Folder ~/.t3/worktrees/arbor/login-loop');
    expect(html).toContain('Session ID a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7');
    expect(html).toContain('User agent claude-cli/2.1.280 (external, cli)');
    expect(html).toContain('From its transcript on casey-mbp , read 2m ago');
  });
});
