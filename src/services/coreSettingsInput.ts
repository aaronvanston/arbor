import type { MessageKey } from '../i18n/resources';

/** The schemes both the core and Arbor's own downloads (reqwest) take for the outbound proxy. */
const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

/**
 * Why a Proxy URL can't be saved, or null when it can: blank (no proxy), or an http, https or SOCKS5 URL with a host.
 * The save itself takes any text, and the core then can't reach the providers through it.
 */
export function proxyUrlProblem(text: string): MessageKey | null {
  const value = text.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return PROXY_SCHEMES.has(url.protocol.toLowerCase()) && url.hostname ? null : 'config.error.proxyUrl';
  } catch {
    return 'config.error.proxyUrl';
  }
}

/** One or more numbers with a unit each, as Go's time.ParseDuration reads them: 30m, 1h30m, 1.5h. */
const GO_DURATION = /^\+?(?:(?:\d+\.?\d*|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+$/u;

/**
 * Why a session affinity TTL can't be saved, or null when it can: blank (the core's default) or a length of time
 * longer than zero, the rule the save itself applies, shown while it's typed.
 */
export function sessionTtlProblem(text: string): MessageKey | null {
  const value = text.trim();
  if (!value) return null;
  if (!GO_DURATION.test(value)) return 'config.error.sessionTtl';
  // A duration made only of zeros (0s, 0h0m) is no time at all.
  return /[1-9]/.test(value) ? null : 'config.error.sessionTtl';
}
