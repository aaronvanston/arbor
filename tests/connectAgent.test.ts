import { describe, expect, it } from 'bun:test';
import { newClientKey } from '../src/services/clientKeys';
import { agentSetup, listensOnlyHere, proxyOrigin } from '../src/services/connectAgent';

describe('connecting an agent', () => {
  it('gives this Mac the local address, and another machine the one it can reach', () => {
    const local = { host: '127.0.0.1', port: 8317, tls: false };
    expect(proxyOrigin(local, 'here', 'studio-mac')).toBe('http://127.0.0.1:8317');
    // Listening only here, another machine is still shown this Mac's name, with the page saying it can't reach it yet.
    expect(listensOnlyHere(local)).toBe(true);
    expect(proxyOrigin(local, 'other', 'studio-mac')).toBe('http://studio-mac.local:8317');
    const everywhere = { host: '0.0.0.0', port: 9000, tls: true };
    expect(listensOnlyHere(everywhere)).toBe(false);
    expect(proxyOrigin(everywhere, 'here', 'studio-mac')).toBe('https://127.0.0.1:9000');
    expect(proxyOrigin(everywhere, 'other', 'studio-mac')).toBe('https://studio-mac.local:9000');
    expect(proxyOrigin({ host: '100.64.1.2', port: 8317, tls: false }, 'other', 'studio-mac')).toBe('http://100.64.1.2:8317');
    expect(proxyOrigin({ host: 'fd7a::1', port: 8317, tls: false }, 'other', 'studio-mac')).toBe('http://[fd7a::1]:8317');
  });

  it('puts the address and key where each agent reads them', () => {
    const setup = agentSetup('http://studio-mac.local:8317', 'sk-test');
    expect(JSON.parse(setup.claude)).toEqual({ env: { ANTHROPIC_BASE_URL: 'http://studio-mac.local:8317', ANTHROPIC_AUTH_TOKEN: 'sk-test', ENABLE_TOOL_SEARCH: 'true' } });
    expect(setup.codex).toContain('base_url = "http://studio-mac.local:8317/v1"');
    expect(setup.codex).toContain('wire_api = "responses"');
    expect(setup.codex).toContain('env_key = "ARBOR_API_KEY"');
    expect(setup.codexKey).toBe('export ARBOR_API_KEY="sk-test"');
  });

  it('makes a key from 24 random bytes, written as hex after sk-', () => {
    const counting = (bytes: Uint8Array) => bytes.map((_, index) => index * 11);
    expect(newClientKey(counting)).toBe('sk-000b16212c37424d58636e79848f9aa5b0bbc6d1dce7f2fd');
  });
});
