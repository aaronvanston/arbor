import { describe, expect, it } from 'bun:test';
import {
  repositoryName,
  sessionClient,
  sessionPlace,
  shortSessionId,
  subagentTypes,
  toolLabel,
  toolRows,
} from '../src/services/usageSessions';
import type { SessionTranscript, ToolUsage } from '../src/native/types';

/** A session's tool counts, empty apart from the given fields. */
const toolUsage = (fields: Partial<ToolUsage>): ToolUsage => ({ tools: {}, subagentTools: {}, subagents: {}, skills: {}, usedSkills: [], ...fields });

describe('naming the client behind a session', () => {
  it('tells Claude Code, claude -p and the Agent SDK apart', () => {
    expect(sessionClient('claude-cli/2.1.280 (external, cli)')).toEqual({ name: 'Claude Code', version: '2.1.280', host: undefined });
    expect(sessionClient('claude-cli/2.1.280 (external, sdk-cli)')).toEqual({ name: 'claude -p', version: '2.1.280', host: undefined });
    expect(sessionClient('claude-cli/2.1.280 (external, sdk-ts, agent-sdk/0.3.276)')).toEqual({ name: 'Claude Agent SDK', version: '0.3.276', host: undefined });
    expect(sessionClient('claude-cli/2.1.280')).toEqual({ name: 'Claude Code', version: '2.1.280', host: undefined });
  });

  it('names the Codex surface and the app hosting it', () => {
    expect(sessionClient('codex_exec/0.156.0 (Mac OS 26.0.0; arm64) dumb')).toEqual({ name: 'codex exec', version: '0.156.0', host: undefined });
    expect(sessionClient('codex-tui/0.156.0 (Mac OS 26.0.0; arm64) iTerm.app/3.6.1 Orca/1.4.205'))
      .toEqual({ name: 'Codex CLI', version: '0.156.0', host: 'Orca' });
    expect(sessionClient('Codex Desktop/0.156.0 (Mac OS 26.0.0; arm64)')).toEqual({ name: 'Codex app', version: '0.156.0', host: undefined });
    expect(sessionClient('codex_cli_rs/0.150.0 (Mac OS 15.5.0; arm64) t3code/1.2.0')).toEqual({ name: 'Codex CLI', version: '0.150.0', host: 'T3 Code' });
  });

  it('falls back to the product token, and to nothing without a User-Agent', () => {
    expect(sessionClient('curl/8.7.1')).toEqual({ name: 'curl', version: '8.7.1', host: undefined });
    expect(sessionClient('python-requests')).toEqual({ name: 'python-requests', host: undefined });
    expect(sessionClient('  ')).toBeNull();
    expect(sessionClient(null)).toBeNull();
  });

  it('shortens UUID session ids to their first block', () => {
    expect(shortSessionId('a3f1c2d4-5b6e-4f70-8a91-b2c3d4e5f6a7')).toBe('a3f1c2d4');
    expect(shortSessionId('custom-id')).toBe('custom-id');
  });
});

const transcript = (fields: Partial<SessionTranscript>): SessionTranscript => ({
  machine: 'casey-mbp', agent: 'claude', home: '/Users/casey', agentHome: '', cwd: '', repoRoot: '', mainRepo: '', branch: '', commitHash: '', repositoryUrl: '',
  title: '', titleSource: '', pullRequests: [], linesAdded: null, linesRemoved: null, compactions: [], toolUsage: null, readAtMs: 0, ...fields,
});

describe('where a session ran', () => {
  it('names the project after the main checkout, and a linked worktree after its own folder', () => {
    expect(sessionPlace(transcript({
      cwd: '/Users/casey/.t3/worktrees/arbor/login-loop/src', repoRoot: '/Users/casey/.t3/worktrees/arbor/login-loop', mainRepo: '/Users/casey/src/arbor', branch: 'fix/login-loop',
    }))).toEqual({ folder: '~/.t3/worktrees/arbor/login-loop/src', project: 'arbor', worktree: 'login-loop', branch: 'fix/login-loop', repository: null });
    expect(sessionPlace(transcript({ cwd: '/Users/casey/src/proxy', repoRoot: '/Users/casey/src/proxy', mainRepo: '/Users/casey/src/proxy' })))
      .toMatchObject({ folder: '~/src/proxy', project: 'proxy', worktree: null });
  });

  it('prefers the repository the agent recorded, or the one it opened a pull request in', () => {
    expect(sessionPlace(transcript({ cwd: '/work/checkout', repoRoot: '/work/checkout', mainRepo: '/work/checkout', repositoryUrl: 'git@github.com:acme/proxy.git' })))
      .toMatchObject({ folder: '/work/checkout', project: 'proxy', repository: 'acme/proxy' });
    expect(sessionPlace(transcript({ cwd: '/Users/casey/tmp/x', pullRequests: [{ number: 4, url: 'https://github.com/acme/arbor/pull/4', repository: 'acme/arbor' }] })))
      .toMatchObject({ project: 'arbor', repository: 'acme/arbor' });
  });

  it('falls back to the folder’s own name once the folder is gone, and to nothing without a transcript', () => {
    expect(sessionPlace(transcript({ cwd: '/Users/casey/.local/share/reviews/review-7/review-7', branch: 'review-7' })))
      .toEqual({ folder: '~/.local/share/reviews/review-7/review-7', project: 'review-7', worktree: null, branch: 'review-7', repository: null });
    expect(sessionPlace(transcript({ cwd: '/Users/caseyr/src' }))?.folder).toBe('/Users/caseyr/src');
    expect(sessionPlace(transcript({ cwd: '' }))).toBeNull();
    expect(sessionPlace(null)).toBeNull();
  });
});

describe('the names the Sessions filters match on', () => {
  // The same cases as the Rust tests (session_filters.rs, transcripts.rs), so the menus name things as the list does.
  const clientLabel = (agent: string) => {
    const client = sessionClient(agent);
    return client ? [client.name, client.host].filter(Boolean).join(' · ') : null;
  };

  it('names clients without their version', () => {
    const cases: [string, string | null][] = [
      ['claude-cli/2.1.280 (external, cli)', 'Claude Code'],
      ['claude-cli/2.1.280 (external, sdk-cli)', 'claude -p'],
      ['claude-cli/2.1.280 (external, sdk-ts, agent-sdk/0.3.276)', 'Claude Agent SDK'],
      ['claude-cli/2.1.280 (external, sdk-ts, agent-sdk/0.3.276, t3code)', 'Claude Agent SDK · T3 Code'],
      ['claude-cli/2.1.280 (external, cli) Orca/1.4.205', 'Claude Code · Orca'],
      ['codex-tui/0.156.0 (Mac OS 26.0.0; arm64) iTerm.app/3.6.1 Orca/1.4.205', 'Codex CLI · Orca'],
      ['codex_exec/0.156.0 (Mac OS 26.0.0; arm64) dumb', 'codex exec'],
      ['Codex_Exec/0.156.0', 'codex exec'],
      ['codex_cli_rs/0.156.0 (Mac OS 26.0.0; arm64)', 'Codex CLI'],
      ['Codex Desktop/0.156.0 (Mac OS 26.0.0; arm64)', 'Codex app'],
      ['codex_exec_beta/1.0', 'Codex CLI'],
      ['python-requests/2.32', 'python-requests'],
      ['TinyOrca/1.0 curl', 'TinyOrca'],
      ['claude-cli/ (cli)', 'claude-cli/'],
      ['curl', 'curl'],
      ['   ', null],
    ];
    for (const [agent, label] of cases) expect([agent, clientLabel(agent)]).toEqual([agent, label]);
  });

  it('reads repositories out of either kind of remote', () => {
    const cases: [string, string | null][] = [
      ['git@github.com:acme/arbor.git', 'acme/arbor'],
      ['https://github.com/acme/arbor', 'acme/arbor'],
      ['https://github.com/acme/arbor.git/', 'acme/arbor'],
      ['ssh://git@github.com:22/acme/arbor.git', 'acme/arbor'],
      ['https://token@github.com/acme/arbor', 'acme/arbor'],
      ['  git@github.com:acme/arbor  ', 'acme/arbor'],
      ['https://gitlab.com/group/sub/site', null],
      ['file:///srv/arbor', null],
      ['/Users/casey/src/arbor', null],
      ['', null],
    ];
    for (const [url, name] of cases) expect([url, repositoryName(url)]).toEqual([url, name]);
  });

  it('files sessions under the same projects', () => {
    const project = (cwd: string, mainRepo: string, repositoryUrl: string, pullRequest?: string) => sessionPlace(transcript({
      cwd, repoRoot: mainRepo ? cwd : '', mainRepo, repositoryUrl,
      pullRequests: pullRequest ? [{ number: 7, url: '', repository: pullRequest }] : [],
    }))?.project ?? null;
    expect(project('', '', 'git@github.com:acme/arbor.git')).toBeNull();
    expect(project('/Users/casey/src/arbor/src', '/Users/casey/src/arbor', 'git@github.com:acme/arbor-app.git')).toBe('arbor-app');
    expect(project('/Users/casey/.t3/worktrees/arbor/login', '/Users/casey/src/arbor', '')).toBe('arbor');
    expect(project('/Users/casey/src/site', '/Users/casey/src/site', 'https://gitlab.com/group/sub/site', 'acme/website')).toBe('website');
    expect(project('/srv/mirror.git', '', '')).toBe('mirror');
    expect(project('/Users/casey/scratch', '', '')).toBe('scratch');
    expect(project('/', '', '')).toBe('/');
  });
});

describe('the tools a session called', () => {
  it('names MCP tools and Codex’s namespaced ones apart from where they came from', () => {
    expect(toolLabel('Bash')).toEqual({ name: 'Bash', source: null });
    expect(toolLabel('mcp__t3-code__preview_click')).toEqual({ name: 'preview_click', source: 't3-code' });
    expect(toolLabel('mcp__claude_ai_Gmail__search_threads')).toEqual({ name: 'search_threads', source: 'claude_ai_Gmail' });
    expect(toolLabel('collaboration/spawn_agent')).toEqual({ name: 'spawn_agent', source: 'collaboration' });
    expect(toolLabel('mcp__codex_apps__github/_create_pull_request')).toEqual({ name: 'create_pull_request', source: 'codex_apps · github' });
    expect(toolLabel('mcp__')).toEqual({ name: 'mcp__', source: null });
  });

  it('lists every tool once, the most called first, with its subagents’ calls beside the session’s', () => {
    const rows = toolRows(toolUsage({ tools: { Bash: 40, Read: 10, Agent: 2 }, subagentTools: { Read: 35, Grep: 12 }, subagents: {} }));
    expect(rows).toEqual([
      { key: 'Read', calls: 10, subagentCalls: 35 },
      { key: 'Bash', calls: 40, subagentCalls: 0 },
      { key: 'Grep', calls: 0, subagentCalls: 12 },
      { key: 'Agent', calls: 2, subagentCalls: 0 },
    ]);
  });

  it('counts the subagents started without a type apart', () => {
    expect(subagentTypes(toolUsage({ tools: { Agent: 5 }, subagentTools: { Task: 1 }, subagents: { Explore: 3, 'general-purpose': 1 } }))).toEqual([
      { type: 'Explore', count: 3 },
      { type: 'general-purpose', count: 1 },
      { type: null, count: 2 },
    ]);
    expect(subagentTypes(toolUsage({ tools: { Agent: 2 }, subagentTools: {}, subagents: { Explore: 2 } }))).toEqual([{ type: 'Explore', count: 2 }]);
    expect(subagentTypes(toolUsage({ tools: { 'collaboration/spawn_agent': 2 }, subagentTools: {}, subagents: {} }))).toEqual([]);
  });
});
