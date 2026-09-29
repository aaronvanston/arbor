import type { SessionTranscript, ToolUsage, UsageSession } from '../native/types';

/** The Sessions page's pull request filter: sessions that opened or worked on one, or the rest. */
export type SessionPullRequestFilter = '' | 'with' | 'without';

export type UsageSessionSort = 'recent' | 'cost' | 'tokens' | 'requests';
export const sessionSorts: readonly UsageSessionSort[] = ['recent', 'cost', 'tokens', 'requests'];

export type SessionClient = { name: string; version?: string; host?: string };

/**
 * Names the client behind a session from its User-Agent. Claude Code reports how it was started in brackets
 * (`cli`, `sdk-cli` for `claude -p`, or the Agent SDK); Codex names its surface in the product token.
 */
export function sessionClient(userAgent: string | null | undefined): SessionClient | null {
  const agent = userAgent?.trim();
  if (!agent) return null;
  const host = /\bOrca\//i.test(agent) ? 'Orca' : /t3code/i.test(agent) ? 'T3 Code' : undefined;
  const claude = /^claude-cli\/(\S+)(?:\s*\(([^)]*)\))?/i.exec(agent);
  if (claude) {
    const parts = (claude[2] ?? '').split(',').map((part) => part.trim().toLowerCase());
    const sdk = parts.find((part) => part.startsWith('agent-sdk/'));
    if (sdk) return { name: 'Claude Agent SDK', version: sdk.slice('agent-sdk/'.length), host };
    return { name: parts.includes('sdk-cli') ? 'claude -p' : 'Claude Code', version: claude[1], host };
  }
  const codex = /^(codex_exec|codex[-_]tui|codex_cli_rs|codex desktop|codex[-_][\w-]+)\/(\S+)/i.exec(agent);
  if (codex) {
    const surface = codex[1]!.toLowerCase();
    const name = surface === 'codex_exec' ? 'codex exec' : surface === 'codex desktop' ? 'Codex app' : 'Codex CLI';
    return { name, version: codex[2], host };
  }
  const product = /^([^\s/]+)\/(\S+)/.exec(agent);
  return product ? { name: product[1]!, version: product[2], host } : { name: agent.split(/\s/)[0]!, host };
}

/** A session id short enough for a table: the first block of the UUID. */
export const shortSessionId = (id: string) => (id.length > 12 ? id.split('-')[0]!.slice(0, 8) : id);

/** Where a session ran, as the Sessions pages label it. */
export type SessionPlace = {
  /** The folder, with the machine's home directory written as ~. */
  folder: string;
  /** The repository's name, else the main checkout's folder, else the folder's own name. */
  project: string;
  /** A linked worktree's folder name. */
  worktree: string | null;
  branch: string;
  /** `owner/name` of the repository the agent recorded, or that the session opened a pull request in. */
  repository: string | null;
};

const lastSegment = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? '';

/** `owner/name` from a git remote: `git@github.com:owner/name.git`, `https://github.com/owner/name`. */
export function repositoryName(url: string): string | null {
  const match = /^(?:[\w+.-]+:\/\/(?:[^@/]+@)?[^/]+\/|[^@\s]+@[^:\s]+:)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1] ?? null;
}

/** A tool as the Tools list names it, apart from the MCP server or Codex namespace it came in. */
export type ToolLabel = { name: string; source: string | null };

/**
 * Splits a tool's name for the Tools list. Claude Code names an MCP server's tools `mcp__server__tool`. Arbor stores a
 * Codex tool that came in a namespace as `namespace/name`; an app's are in one like `mcp__codex_apps__github`.
 */
export function toolLabel(key: string): ToolLabel {
  const slash = key.indexOf('/');
  if (slash > 0) {
    const namespace = key.slice(0, slash);
    const name = key.slice(slash + 1);
    const source = namespace.replace(/^mcp__/, '').split('__').filter(Boolean).join(' · ');
    return { name: name.replace(/^_+/, '') || name, source: source || namespace };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(key);
  return mcp ? { name: mcp[2]!, source: mcp[1]! } : { name: key, source: null };
}

/** One tool in the Tools list: the session's calls to it, and its subagents'. */
export type ToolRow = { key: string; calls: number; subagentCalls: number };

/** Every tool the session or its subagents called, the most called first. */
export function toolRows(usage: ToolUsage): ToolRow[] {
  const rows = new Map<string, ToolRow>();
  const row = (key: string) => {
    let found = rows.get(key);
    if (!found) rows.set(key, (found = { key, calls: 0, subagentCalls: 0 }));
    return found;
  };
  for (const [key, count] of Object.entries(usage.tools)) row(key).calls += count;
  for (const [key, count] of Object.entries(usage.subagentTools)) row(key).subagentCalls += count;
  const total = (item: ToolRow) => item.calls + item.subagentCalls;
  return [...rows.values()].sort((a, b) => total(b) - total(a) || a.key.localeCompare(b.key));
}

/** Claude Code's tools that start a subagent: `Agent`, and `Task` before it was renamed. */
const AGENT_TOOLS = ['Agent', 'Task'];

/** The subagents a session started of one type. A null type is those started without naming one. */
export type SubagentType = { type: string | null; count: number };

/**
 * The subagents a session and its own subagents started, by type, the most first. A call that named no type gets
 * the agent's default, which the transcript doesn't write down, so those are counted apart.
 */
export function subagentTypes(usage: ToolUsage): SubagentType[] {
  const typed = Object.entries(usage.subagents)
    .map(([type, count]): SubagentType => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type!.localeCompare(b.type!));
  const started = AGENT_TOOLS.reduce((sum, name) => sum + (usage.tools[name] ?? 0) + (usage.subagentTools[name] ?? 0), 0);
  const untyped = started - typed.reduce((sum, item) => sum + item.count, 0);
  return untyped > 0 ? [...typed, { type: null, count: untyped }] : typed;
}

export type SessionSkill = { name: string; calls: number };

/** The skills a session used, the ones its model called for most first, then those typed or picked. */
export function sessionSkills(usage: ToolUsage): SessionSkill[] {
  const names = new Set([...(usage.usedSkills ?? []), ...Object.keys(usage.skills ?? {})]);
  return [...names]
    .map((name) => ({ name, calls: usage.skills?.[name] ?? 0 }))
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

/**
 * The repository a session worked in, `owner/name`, which settings know a project by. Null when its transcript names
 * no remote or pull request: a folder alone is only a project on its own machine.
 */
export function sessionRepository(session: Pick<UsageSession, 'transcript'> | null | undefined): string | null {
  const transcript = session?.transcript;
  if (!transcript) return null;
  return repositoryName(transcript.repositoryUrl) ?? transcript.pullRequests[0]?.repository ?? null;
}

/** Labels for where a session ran, or null when its transcript didn't say. */
export function sessionPlace(transcript: SessionTranscript | null | undefined): SessionPlace | null {
  if (!transcript?.cwd) return null;
  const home = transcript.home.replace(/\/+$/, '');
  const folder = home && (transcript.cwd === home || transcript.cwd.startsWith(`${home}/`)) ? `~${transcript.cwd.slice(home.length)}` : transcript.cwd;
  const repository = repositoryName(transcript.repositoryUrl) ?? transcript.pullRequests[0]?.repository ?? null;
  const checkout = transcript.mainRepo || transcript.repoRoot;
  const project = repository ? lastSegment(repository) : lastSegment(checkout || transcript.cwd).replace(/\.git$/, '');
  const worktree = transcript.repoRoot && transcript.mainRepo && transcript.repoRoot !== transcript.mainRepo ? lastSegment(transcript.repoRoot) : null;
  return { folder, project: project || folder, worktree, branch: transcript.branch, repository };
}
