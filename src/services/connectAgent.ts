import { clientApiProfiles } from './clientAccess';

/**
 * What an agent needs to send its requests through the proxy: the address, the key, and the lines that set them in
 * Claude Code's settings.json and Codex's config.toml. Arbor only shows these; the user adds them.
 */

export type ProxyListen = { host: string; port: number; tls: boolean };
export type AgentOrigin = 'here' | 'other';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const EVERYWHERE = new Set(['', '0.0.0.0', '::', '[::]']);

/** Whether the proxy only answers this Mac, so another machine can't reach it until it listens on the network. */
export const listensOnlyHere = (listen: ProxyListen) => LOOPBACK.has(listen.host.trim().toLowerCase());

/**
 * The proxy's address for an agent on this Mac, or on another machine: the address it listens on when that's one, or
 * else this Mac's name on the local network.
 */
export function proxyOrigin(listen: ProxyListen, from: AgentOrigin, thisMac: string): string {
  const here = clientApiProfiles(listen.port, listen.tls, listen.host).find((profile) => profile.id === 'claude')?.baseUrl ?? '';
  if (from === 'here') return here;
  const host = listen.host.trim();
  const reached = EVERYWHERE.has(host) || LOOPBACK.has(host.toLowerCase()) ? `${thisMac}.local` : host.includes(':') ? `[${host}]` : host;
  const port = Number.isInteger(listen.port) && listen.port >= 1 && listen.port <= 65535 ? listen.port : 8317;
  return `${listen.tls ? 'https' : 'http'}://${reached}:${port}`;
}

/** The env var Codex reads the key from, set in the shell it starts from. */
export const CODEX_KEY_ENV = 'ARBOR_API_KEY';

/** The lines for each agent, with `key` in them: the real key to copy, a masked one to show. */
export function agentSetup(origin: string, key: string) {
  const claude = JSON.stringify({ env: { ANTHROPIC_BASE_URL: origin, ANTHROPIC_AUTH_TOKEN: key, ENABLE_TOOL_SEARCH: 'true' } }, null, 2);
  const codex = [
    'model_provider = "arbor"',
    '',
    '[model_providers.arbor]',
    'name = "Arbor"',
    `base_url = "${origin}/v1"`,
    'wire_api = "responses"',
    `env_key = "${CODEX_KEY_ENV}"`,
  ].join('\n');
  return { claude, codex, codexKey: `export ${CODEX_KEY_ENV}="${key}"` };
}
