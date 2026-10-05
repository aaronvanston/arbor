import { invokeCommand } from '../native/commands';
import type { ExceptionSource, Feature, ProductAnalyticsSettings, ProductEvent } from '../native/types';
import { viewPageId, type AppView } from '../navigation';
import { describeError } from './errorReport';

/**
 * Hands usage events and errors to the app, which decides whether they go (Settings › Software) and takes out of them
 * what could name the user (product_analytics.rs). The window only ever sends ids and error text, never a page's
 * params, so a machine, session or project name can't get in.
 */

/** A page and the view on it, as the ids the app itself uses: `usage` + `digest`, or `settings:software`. */
export function pageViewEvent(view: AppView): Extract<ProductEvent, { event: 'page.viewed' }> {
  const tab = view.kind === 'main' && view.params && 'tab' in view.params ? view.params.tab ?? null : null;
  return { event: 'page.viewed', page: viewPageId(view), tab };
}

const pageViewKey = (event: ReturnType<typeof pageViewEvent>) => `${event.page}/${event.tab ?? ''}`;

let lastPageView: string | null = null;

/** Sends a page view when the page or its view changes, not for every param a page takes. */
export function trackPageView(view: AppView) {
  const event = pageViewEvent(view);
  const key = pageViewKey(event);
  if (key === lastPageView) return;
  lastPageView = key;
  send(event);
}

function send(event: ProductEvent) {
  if (!inApp()) return;
  invokeCommand('track_event', { event }).catch(() => undefined);
}

const inApp = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** The same error sent again within this long is the same error. */
export const REPEAT_WINDOW_MS = 60_000;
/** A window that keeps failing sends this many and then stops, until it's opened again. */
export const EXCEPTIONS_MAX = 25;

export type ExceptionGate = { sent: number; recent: Map<string, number> };
export const newExceptionGate = (): ExceptionGate => ({ sent: 0, recent: new Map() });

/** Whether an error with this signature goes now, noting that it did. */
export function admitException(gate: ExceptionGate, signature: string, now: number) {
  if (gate.sent >= EXCEPTIONS_MAX) return false;
  const last = gate.recent.get(signature);
  if (last !== undefined && now - last < REPEAT_WINDOW_MS) return false;
  gate.recent.set(signature, now);
  gate.sent += 1;
  return true;
}

const gate = newExceptionGate();

/** Sends an error the window caught. Its message is scrubbed on the other side, before anything leaves. */
export function reportException(source: ExceptionSource, error: unknown, page: string | null = null) {
  const { name, message, stack } = describeError(error);
  if (!admitException(gate, `${source}|${name}|${message}|${stack.split('\n', 2).join('|')}`, Date.now())) return;
  if (!inApp()) return;
  const chunkIds = (globalThis as { _posthogChunkIds?: Record<string, string> })._posthogChunkIds;
  invokeCommand('report_exception', { report: { source, name, message, stack, page, chunkIds } }).catch(() => undefined);
}

/**
 * Browser messages that aren't the app failing: a ResizeObserver whose callback changed layout has its
 * notifications put off to the next frame, which the browser reports as an error event with no error.
 */
export const isBenignWindowError = (message: string | undefined) => Boolean(message?.startsWith('ResizeObserver loop'));

/** Errors nothing caught: a failed script or a promise nobody waited on. Once, at startup. */
export function reportUncaughtErrors(currentPage: () => string | null) {
  window.addEventListener('error', (event) => {
    // A resource that failed to load has no error, just a target; those aren't the app's code failing.
    if (event.error === undefined && !event.message) return;
    if (isBenignWindowError(event.message)) return;
    reportException('window', event.error ?? new Error(event.message), currentPage());
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportException('rejection', event.reason, currentPage());
  });
}


/** An app id from a name the app itself uses: `limitWarning` becomes `limit-warning`. Anything else is dropped. */
export function appId(name: string | null | undefined): string | null {
  if (!name) return null;
  const id = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
  return /^[a-z0-9:-]{1,40}$/.test(id) ? id : null;
}

/** Something was done with a feature: which kind (a provider, an alert kind) and how many things, never which. */
export function trackFeature(feature: Feature, details: { kind?: string | null; count?: number | null } = {}) {
  send({ event: 'feature.used', feature, kind: appId(details.kind), count: details.count ?? null });
}

/** Runs a command and notes the feature once it worked. */
export async function tracked<T>(feature: Feature, run: Promise<T>, details: { kind?: string | null; count?: number | null } = {}): Promise<T> {
  const result = await run;
  trackFeature(feature, details);
  return result;
}

/** The kind of thing picked in the search palette: `page`, `setting`, `session`, from its id, never the rest. */
export const paletteKind = (itemId: string) => appId(itemId.split(':', 1)[0]);

/** The first-launch note, shown once, and only by a build that sends, while something is still being sent. */
export const usageDataNoticeDue = (settings: ProductAnalyticsSettings) =>
  settings.available && !settings.noticeShown && !settings.blockedByEnv && (settings.usage || settings.crashReports);
