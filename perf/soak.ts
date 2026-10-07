/**
 * `bun run perf:soak`: does a window left open for hours keep growing? The owner's window sat on a machine page for
 * two hours and reached ~490 MB, and a window that stays visible never reloads (src/services/backgroundReload.ts), so
 * anything that only adds is a leak there. This leaves a page open in Playwright's WebKit with the window shown but
 * unfocused, runs hours on the page clock with the health sampler's round every five seconds as the real app sends
 * it, and at each checkpoint records what should stay flat:
 *
 *   - gated (the same every run): elements in the document, live timers, listeners on window and document, and
 *     native event listeners (the mock's Tauri callbacks). Their growth from the first checkpoint to the last must be
 *     at most `GROWTH_ALLOWED`.
 *   - reported: the WebContent process's physical footprint, the least over a few real seconds, and its slope per hour.
 *
 *   bun run perf:soak                         machine page and Home, 4 hours each
 *   bun run perf:soak --case=all --hours=8    every case
 *   bun run perf:soak --check                 fail when a gated count grew
 *   flags: --no-build, --site=<dir> (another build), --hours=<n>, --case=<ids>
 */
import { join } from 'node:path';
import { webkit, type Page } from 'playwright';
import { installCounters, type CounterSnapshot } from './counters';
import { arg, buildDemo, footprintMb, helperPids, REPO, serveSite } from './realClock';

const SITE = arg('site') ?? join(REPO, '.perf', 'site');
const HOURS = Number(arg('hours') ?? 4);
const CHECKPOINT_MINUTES = 30;
const HEALTH_EVERY_MS = 5_000;
const START_MS = Date.parse('2026-10-05T10:30:00Z');
const VIEWPORT = { width: 2345, height: 1410 };
/** Growth a gated count may show over the soak: a list can gain a row as the mock's day moves on. */
const GROWTH_ALLOWED: Record<string, number> = { domNodes: 40, liveTimers: 2, windowListeners: 2, nativeListeners: 2 };

const CASES: Record<string, { page: string; tab?: string; lens?: string; everyRun?: boolean }> = {
  machine: { page: 'machine:ci-01', everyRun: true },
  home: { page: 'home', everyRun: true },
  machines: { page: 'machines' },
  sessions: { page: 'sessions' },
  pools: { page: 'pools' },
  usage: { page: 'usage' },
};
const only = arg('case');
const cases = Object.entries(CASES).filter(([id, target]) => (only === 'all' ? true : only ? only.split(',').includes(id) : target.everyRun));

buildDemo(SITE);
const server = serveSite(SITE);

/** Counts listeners on the window and document, the targets that outlive every page, net of removals. */
function countWindowListeners() {
  const seen = new Map<EventTarget, Set<string>>();
  const ids = new WeakMap<object, number>();
  let next = 0;
  const key = (type: string, listener: unknown, options: unknown) => {
    const capture = typeof options === 'boolean' ? options : Boolean((options as { capture?: boolean } | undefined)?.capture);
    if (listener && typeof listener === 'object' || typeof listener === 'function') {
      if (!ids.has(listener as object)) ids.set(listener as object, (next += 1));
      return `${type}|${capture}|${ids.get(listener as object)}`;
    }
    return `${type}|${capture}|?`;
  };
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if ((this === window || this === document) && listener && !(typeof options === 'object' && options?.once)) {
      if (!seen.has(this)) seen.set(this, new Set());
      seen.get(this)?.add(key(type, listener, options));
    }
    return add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    if ((this === window || this === document) && listener) seen.get(this)?.delete(key(type, listener, options));
    return remove.call(this, type, listener, options);
  };
  (window as unknown as { __soakListeners: () => Record<string, number> }).__soakListeners = () => {
    const byType: Record<string, number> = {};
    for (const set of seen.values()) for (const entry of set) {
      const type = entry.split('|')[0] ?? '?';
      byType[type] = (byType[type] ?? 0) + 1;
    }
    return byType;
  };
}

type Checkpoint = { hour: number; domNodes: number; liveTimers: number; windowListeners: number; nativeListeners: number; footprintMb: number | null };

async function counts(page: Page): Promise<Omit<Checkpoint, 'hour' | 'footprintMb'> & { listenerTypes: Record<string, number>; timerSites: Record<string, number> }> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __arborPerf: { snapshot: () => CounterSnapshot; reset: () => void };
      __soakListeners: () => Record<string, number>;
      __TAURI_INTERNALS__?: { callbacks?: Map<number, unknown> };
    };
    const snap = w.__arborPerf.snapshot();
    w.__arborPerf.reset();
    const listenerTypes = w.__soakListeners();
    const timerSites: Record<string, number> = {};
    for (const timer of snap.live) {
      const site = `${timer.kind} ${timer.delay} ${timer.site.split('|')[0] ?? ''}`;
      timerSites[site] = (timerSites[site] ?? 0) + 1;
    }
    return {
      domNodes: document.getElementsByTagName('*').length - document.head.getElementsByTagName('link').length,
      liveTimers: snap.live.length,
      windowListeners: Object.values(listenerTypes).reduce((sum, count) => sum + count, 0),
      nativeListeners: w.__TAURI_INTERNALS__?.callbacks?.size ?? 0,
      listenerTypes,
      timerSites,
    };
  });
}

/** The least footprint over a few real seconds: one sample lands wherever WebKit's last collection happened to be. */
async function settledFootprint(page: Page, pid: number | undefined) {
  if (!pid) return null;
  const samples: number[] = [];
  for (let sample = 0; sample < 4; sample += 1) {
    await page.waitForTimeout(750);
    const size = footprintMb(pid);
    if (size !== null) samples.push(size);
  }
  return samples.length ? Math.min(...samples) : null;
}

/** Lets React and promise chains finish: they run on real tasks the page clock doesn't hold. */
const settle = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => {
  const channel = new MessageChannel();
  let rounds = 0;
  channel.port1.onmessage = () => { rounds += 1; if (rounds >= 6) resolve(); else channel.port2.postMessage(0); };
  channel.port2.postMessage(0);
}));

async function soak(id: string, target: { page: string; tab?: string; lens?: string }) {
  const before = new Set(helperPids().keys());
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, timezoneId: 'UTC', locale: 'en-US', serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.clock.install({ time: START_MS - 1_000 });
    await page.addInitScript(installCounters);
    await page.addInitScript(countWindowListeners);
    await page.addInitScript(() => { document.hasFocus = () => false; });
    await page.clock.pauseAt(START_MS);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('crash', () => console.log('  page crashed'));
    page.on('close', () => console.log('  page closed'));
    await page.goto(`http://127.0.0.1:${server.port}/?size=real`, { waitUntil: 'load' });
    for (let ms = 0; ms < 5_000; ms += 100) { await page.clock.runFor(100); await settle(page); }
    await page.evaluate(({ page, tab, lens }) => (window as unknown as { __mockOpen: (page: string, tab?: string, lens?: string) => Promise<void> }).__mockOpen(page, tab, lens), target);
    for (let ms = 0; ms < 5_000; ms += 100) { await page.clock.runFor(100); await settle(page); }
    const contentPid = [...helperPids()].filter(([pid, kind]) => !before.has(pid) && kind === 'WebContent').map(([pid]) => pid).pop();

    const checkpoints: Checkpoint[] = [];
    const first = await counts(page);
    checkpoints.push({ hour: 0, ...first, footprintMb: await settledFootprint(page, contentPid) });
    const rounds = (CHECKPOINT_MINUTES * 60_000) / HEALTH_EVERY_MS;
    const started = Date.now();
    let last = first;
    for (let elapsed = CHECKPOINT_MINUTES; elapsed <= HOURS * 60; elapsed += CHECKPOINT_MINUTES) {
      for (let round = 0; round < rounds; round += 1) {
        await page.clock.runFor(HEALTH_EVERY_MS);
        await page.evaluate(() => (window as Window & { __mockEmit?: (event: string) => void }).__mockEmit?.('machine-health-updated'));
        await settle(page);
      }
      last = await counts(page);
      const point = { hour: elapsed / 60, ...last, footprintMb: await settledFootprint(page, contentPid) };
      checkpoints.push(point);
      console.log(`  ${id} ${point.hour.toFixed(1)} h: ${point.domNodes} elements, ${point.liveTimers} timers, ${point.windowListeners} window listeners, ${point.nativeListeners} native listeners, footprint ${point.footprintMb ?? '?'} MB (${Math.round((Date.now() - started) / 1000)} s real)`);
    }
    return { checkpoints, first, last, errors };
  } finally {
    await browser.close();
  }
}

/** Least-squares slope of footprint per hour, from the first hour on (the first fills caches and the JIT). */
function slopePerHour(points: Checkpoint[]) {
  const used = points.filter((point) => point.hour >= 1 && point.footprintMb !== null);
  if (used.length < 3) return null;
  const n = used.length;
  const mx = used.reduce((s, p) => s + p.hour, 0) / n;
  const my = used.reduce((s, p) => s + (p.footprintMb ?? 0), 0) / n;
  const num = used.reduce((s, p) => s + (p.hour - mx) * ((p.footprintMb ?? 0) - my), 0);
  const den = used.reduce((s, p) => s + (p.hour - mx) ** 2, 0);
  return den ? Math.round((num / den) * 10) / 10 : null;
}

const failures: string[] = [];
const summary: Record<string, unknown> = {};
for (const [id, target] of cases) {
  console.log(`[${id}] ${HOURS} hours on the page clock, a health round every 5 s…`);
  const { checkpoints, first, last, errors } = await soak(id, target);
  const growth = {
    domNodes: last.domNodes - first.domNodes,
    liveTimers: last.liveTimers - first.liveTimers,
    windowListeners: last.windowListeners - first.windowListeners,
    nativeListeners: last.nativeListeners - first.nativeListeners,
  };
  const slope = slopePerHour(checkpoints);
  summary[id] = { growth, footprintSlopeMbPerHour: slope, footprintMb: checkpoints.map((point) => point.footprintMb) };
  console.log(`${id}: growth ${JSON.stringify(growth)}, footprint ${checkpoints[0]?.footprintMb ?? '?'} → ${checkpoints[checkpoints.length - 1]?.footprintMb ?? '?'} MB, slope ${slope ?? '?'} MB/h`);
  for (const [name, grew] of Object.entries(growth)) {
    if (grew > (GROWTH_ALLOWED[name] ?? 0)) {
      failures.push(`${id}.${name} grew by ${grew}`);
      if (name === 'liveTimers') {
        const sites = Object.entries(last.timerSites).filter(([site, count]) => count > (first.timerSites[site] ?? 0));
        console.log(`  timers that grew: ${JSON.stringify(sites.slice(0, 8))}`);
      }
      if (name === 'windowListeners') {
        const types = Object.entries(last.listenerTypes).filter(([type, count]) => count > (first.listenerTypes[type] ?? 0));
        console.log(`  listeners that grew: ${JSON.stringify(types)}`);
      }
    }
  }
  if (errors.length) failures.push(`${id}: the page threw ${errors.length} time(s): ${errors[0]}`);
}
console.log(JSON.stringify(summary));
server.stop(true);
if (process.argv.includes('--check') && failures.length) {
  console.error(`perf:soak failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
