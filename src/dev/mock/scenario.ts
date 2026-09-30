/** What the browser mock shares across its domains: the scenario the page was opened with, and its clock. */

export type Json = Record<string, unknown>;

/** The scenario switches, from the page's query string; each is listed at the top of `src/dev/mockTauri.ts`. */
export const params = new URLSearchParams(window.location.search);

/**
 * `?fresh=1`: Arbor on the day it's installed. No machines, no requests or sessions yet, no archive and no other apps,
 * with the proxy running and its key made. Each domain empties its own answers for it.
 */
export const freshInstall = params.get('fresh') === '1';

/** When the page loaded; the mock's times are set from it. */
export const now = Date.now();

export const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

/** That many hours before now. */
export const hours = (count: number) => Date.now() - count * 3_600_000;

/** Answers after `ms`, like a command that takes a while, rejecting with what `result` throws. */
export const later = <T,>(ms: number, result: () => T) => new Promise<T>((resolve, reject) => window.setTimeout(() => {
  try {
    resolve(result());
  } catch (error) {
    reject(error);
  }
}, ms));

/** Records side-effect-only commands so browser tests can assert on them via window.__mockLog. */
export const mockLog = (kind: string, detail: unknown) => {
  const target = window as Window & { __mockLog?: { kind: string; detail: unknown }[] };
  (target.__mockLog ??= []).push({ kind, detail });
  console.info(`[mockTauri] ${kind}`, detail);
};
