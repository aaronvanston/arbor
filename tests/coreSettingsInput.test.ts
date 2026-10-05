import { describe, expect, it } from 'bun:test';
import { proxyUrlProblem, sessionTtlProblem } from '../src/services/coreSettingsInput';

describe('Proxy URL', () => {
  it('takes blank, or an http, https or SOCKS5 URL with a host', () => {
    for (const value of ['', '  ', 'socks5://127.0.0.1:7890', 'http://proxy.example.com:8080', 'https://user:pass@proxy:443', 'SOCKS5H://proxy:1080']) {
      expect(proxyUrlProblem(value)).toBeNull();
    }
  });

  it('refuses text that is not such a URL', () => {
    for (const value of ['notaurl', '127.0.0.1:7890', 'ftp://proxy:21', 'socks5://', 'direct']) {
      expect(proxyUrlProblem(value)).toBe('config.error.proxyUrl');
    }
  });
});

describe('session affinity TTL', () => {
  it("takes blank, or a length of time Go's ParseDuration reads", () => {
    for (const value of ['', '30m', '1h', '1h30m', '1.5h', '90s', '+2h', '500ms']) {
      expect(sessionTtlProblem(value)).toBeNull();
    }
  });

  it('refuses words, bare numbers and no time at all', () => {
    for (const value of ['banana', '30', '1 h', 'h', '1d', '0', '0s', '0h0m', '-1h']) {
      expect(sessionTtlProblem(value)).toBe('config.error.sessionTtl');
    }
  });
});
