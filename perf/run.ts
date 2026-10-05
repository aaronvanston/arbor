/**
 * `bun run perf`: Arbor's speed benchmark (docs/perf/PROCESS.md). Builds the browser mock as the production-optimized
 * demo site, serves it on 127.0.0.1 and drives it in Playwright's WebKit, the engine Arbor's window uses, through a
 * cold launch to Home, a visit to each main page and ten minutes of idle on Home. The page clock runs time, so ten
 * minutes take seconds and the gated counts come out the same on every run.
 *
 *   bun run perf               measure, print the tables, write perf/latest.json
 *   bun run perf:check         measure, then fail when a gated count is over its ceiling in perf/baseline.json
 *   bun run perf:ratchet       measure, then lower the ceilings to this run's counts (never raises one)
 *   bun run perf:report        print perf/latest.json's tables again without measuring
 *
 * Flags: `--reuse` checks or ratchets perf/latest.json instead of measuring again, `--size=default` or `--size=real`
 * measures one mock size (a check then only holds that size's counts), `--no-build` reuses the last build.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { webkit, type Browser, type Page } from 'playwright';
import { installCounters, type CounterSnapshot } from './counters';
import { check, ratchet, type Baseline, type CheckRow, type Counts } from './ratchet';
import { BuildSources, formatPosition, isMockSource, type SourcePosition } from './sourcemap';

const REPO = normalize(join(import.meta.dir, '..'));
const SITE = join(REPO, '.perf', 'site');
const BASELINE = join(REPO, 'perf', 'baseline.json');
const LATEST = join(REPO, 'perf', 'latest.json');

/** The page clock's start: a fixed Monday morning, so dates in the mock (and their text) are the same every run. */
const START_MS = Date.parse('2026-10-05T10:30:00Z');
const LAUNCH_MS = 5_000;
const NAVIGATION_MS = 3_000;
const IDLE_MINUTES = 10;
const STEP_MS = 100;
const IDLE_STEP_MS = 1_000;
/**
 * How far a cold start runs when it's only counting the JS a page needs: just short of the two seconds after which
 * `usePagePrefetch` (src/App.tsx) loads every other page in the background.
 */
const BEFORE_PREFETCH_MS = 1_900;
/** How long frames run at the start of idle before they're held (see perf/counters.ts). */
const FRAME_SAMPLE_MS = 10_000;

type Size = { id: 'default' | 'real'; query: string };
const SIZES: Size[] = [{ id: 'default', query: '' }, { id: 'real', query: 'size=real' }];

/** The main pages and Sync's views, opened in this order from Home the way the sidebar would. */
const PAGES: { id: string; page: string; tab?: string }[] = [
  { id: 'machines', page: 'machines' },
  { id: 'machine', page: 'machine:ci-01' },
  { id: 'pools', page: 'pools' },
  { id: 'sessions', page: 'sessions' },
  { id: 'automations', page: 'automations' },
  { id: 'sync', page: 'setup' },
  { id: 'sync-agents', page: 'setup', tab: 'agents' },
  { id: 'sync-skills', page: 'setup', tab: 'skills' },
  { id: 'sync-repo', page: 'setup', tab: 'repo' },
  { id: 'sync-plugins', page: 'setup', tab: 'plugins' },
  { id: 'sync-hooks', page: 'setup', tab: 'hooks' },
  { id: 'sync-toolchain', page: 'setup', tab: 'toolchain' },
  { id: 'sync-cost', page: 'setup', tab: 'cost' },
  { id: 'sync-history', page: 'setup', tab: 'history' },
  { id: 'accounts', page: 'accounts' },
  { id: 'usage', page: 'usage' },
  { id: 'alerts', page: 'alerts' },
  { id: 'settings', page: 'settings:general' },
  { id: 'home', page: 'home' },
];

/** One journey's step, its counters with call sites mapped to source. */
type Step = {
  appJsBytes: number;
  mockJsBytes: number;
  chunks: string[];
  commits: number;
  mutations: number;
  commands: number;
  commandBytes: number;
  timerFires: number;
  rafCalls: number;
  liveTimers: number;
  topCommands: { command: string; calls: number; replyBytes: number; argBytes: number }[];
  topTimers: { site: string; kind: string; fires: number; created: number }[];
  topRaf: { site: string; calls: number }[];
  topComponents: { component: string; renders: number }[];
  topMutations: { target: string; count: number }[];
  live: { site: string; kind: string; delay: number; count: number }[];
};

type Timing = { firstPaintMs: number | null; domContentLoadedMs: number | null; settledMs: number | null; rssMb: number | null };

type SizeResult = {
  launch: Step;
  /** App JS a cold start needs before the prefetch: Home's, and each page's beyond Home's. Default size only. */
  coldJs?: { home: number; pages: Record<string, number> };
  idle: Step & { rssStartMb: number | null; rssEndMb: number | null };
  pages: Record<string, Step>;
  timing: Timing;
};

type Latest = {
  generatedAt: string;
  commit: string;
  counts: Counts;
  reported: Record<string, number | null>;
  sizes: Partial<Record<Size['id'], SizeResult>>;
  notMeasured: string[];
  /** Uncaught errors in the page; a journey that threw measured a broken page, so a check fails on any. */
  pageErrors: string[];
};

const argv = process.argv.slice(2);
const mode = argv.includes('--check') ? 'check' : argv.includes('--ratchet') ? 'ratchet' : argv.includes('--report') ? 'report' : 'run';
const reuse = argv.includes('--reuse') || mode === 'report';
const onlySize = argv.find((arg) => arg.startsWith('--size='))?.slice('--size='.length);
const sizes = SIZES.filter((size) => !onlySize || size.id === onlySize);

// ---------------------------------------------------------------------------------------------------------------
// Building and serving

function build() {
  console.log('Building the demo site with source maps into .perf/site…');
  const result = spawnSync('bunx', ['vite', 'build', '--mode', 'demo', '--sourcemap', 'hidden', '--outDir', SITE, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: REPO,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('The demo build failed.');
}

function serve() {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const path = normalize(join(SITE, pathname === '/' ? 'index.html' : pathname));
      if (!path.startsWith(SITE)) return new Response('Not found', { status: 404 });
      const file = Bun.file(path);
      return (await file.exists()) ? new Response(file) : new Response('Not found', { status: 404 });
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Driving the page

/** Requests in flight, so a step waits for lazily loaded chunks before time moves on. */
function trackNetwork(page: Page) {
  let inflight = 0;
  let waiters: (() => void)[] = [];
  const done = () => {
    inflight -= 1;
    if (inflight <= 0) {
      inflight = 0;
      for (const resolve of waiters) resolve();
      waiters = [];
    }
  };
  page.on('request', () => { inflight += 1; });
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return {
    get inflight() { return inflight; },
    idle: () => (inflight === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve))),
  };
}

/** The JS files the page fetched, in order, by their path in the build (`assets/x.js`). */
function trackScripts(page: Page) {
  const loaded: string[] = [];
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname.replace(/^\//, '');
    if (path.endsWith('.js') && !loaded.includes(path)) loaded.push(path);
  });
  return loaded;
}

/**
 * Lets the page finish what it started: React's scheduler and promise chains run on real tasks, which the page clock
 * doesn't hold, so this posts messages until nothing new has rendered or changed for a few rounds.
 */
async function flush(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    const perf = (window as Window & { __arborPerf?: { progress: () => number } }).__arborPerf;
    const progress = () => perf?.progress() ?? 0;
    const channel = new MessageChannel();
    let rounds = 0, still = 0, last = progress();
    channel.port1.onmessage = () => {
      rounds += 1;
      const current = progress();
      still = current === last ? still + 1 : 0;
      last = current;
      if ((rounds >= 4 && still >= 3) || rounds >= 400) resolve();
      else channel.port2.postMessage(0);
    };
    channel.port2.postMessage(0);
  }));
}

async function quiet(page: Page, network: ReturnType<typeof trackNetwork>) {
  do {
    await network.idle();
    await flush(page);
  } while (network.inflight > 0);
}

/** Moves the page clock on by `totalMs` in steps, letting the page settle after each. */
async function advance(page: Page, network: ReturnType<typeof trackNetwork>, totalMs: number, stepMs: number) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await page.clock.runFor(stepMs);
    await quiet(page, network);
  }
}

const snapshot = (page: Page) => page.evaluate(() => (window as unknown as { __arborPerf: { snapshot: () => CounterSnapshot } }).__arborPerf.snapshot());
const reset = (page: Page) => page.evaluate(() => (window as unknown as { __arborPerf: { reset: () => void } }).__arborPerf.reset());

/** Uncaught errors from every page this run drove. */
const pageErrors: string[] = [];

const contextOptions = { viewport: { width: 1440, height: 900 }, timezoneId: 'UTC', locale: 'en-US', serviceWorkers: 'block' as const };

/** A page on a fresh profile with the page clock paused at START_MS and the counters in, loaded and settled. */
async function launch(browser: Browser, url: string, settleMs = LAUNCH_MS) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  // The clock goes in first so the counters wrap its timers rather than being replaced by them.
  await page.clock.install({ time: START_MS - 1_000 });
  await page.addInitScript(installCounters);
  await page.clock.pauseAt(START_MS);
  page.on('pageerror', (error) => { pageErrors.push(`${new URL(url).search || '/'}: ${error.message}`); });
  const network = trackNetwork(page);
  const scripts = trackScripts(page);
  await page.goto(url, { waitUntil: 'load' });
  await quiet(page, network);
  await advance(page, network, settleMs, STEP_MS);
  const counted = await snapshot(page);
  if (!counted.wrapped) throw new Error('The counters were replaced: the page clock must be installed before them.');
  if (counted.visibility !== 'visible') throw new Error(`The page is ${counted.visibility}; the app polls differently while hidden.`);
  return { context, page, network, scripts, counted };
}

// ---------------------------------------------------------------------------------------------------------------
// The WebKit content process's memory

/** The WebContent processes of Playwright's WebKit, which launchd starts rather than the browser, so found by path. */
function webContentPids(): Set<number> {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const pids = new Set<number>();
  for (const line of result.stdout.split('\n')) {
    if (!line.includes('ms-playwright') || !line.includes('WebContent')) continue;
    const pid = Number.parseInt(line.trim(), 10);
    if (pid) pids.add(pid);
  }
  return pids;
}

/** The largest resident size, in MB, among the WebContent processes started since `before`. */
function rssMb(before: Set<number>): number | null {
  const fresh = [...webContentPids()].filter((pid) => !before.has(pid));
  if (!fresh.length) return null;
  const result = spawnSync('ps', ['-o', 'rss=', '-p', fresh.join(',')], { encoding: 'utf8' });
  const sizes = result.stdout.split('\n').map((line) => Number.parseInt(line.trim(), 10)).filter((kb) => kb > 0);
  return sizes.length ? Math.round(Math.max(...sizes) / 1024) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Turning raw counts into a step

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const top = <T,>(items: T[], by: (item: T) => number, count = 15) => [...items].sort((a, b) => by(b) - by(a)).slice(0, count);

function summarize(sources: BuildSources, counted: CounterSnapshot, chunks: string[], allChunks: string[]): Step {
  const fileBytes = (chunk: string) => statSync(join(SITE, chunk)).size;
  const mockChunk = (chunk: string) => sources.mockShare(chunk) > 0.5;

  /** A timer's or frame's place: the first frame in Arbor's own code, else the first frame at all. */
  const placeCache = new Map<string, { place: string; mock: boolean }>();
  const place = (frames: string) => {
    const cached = placeCache.get(frames);
    if (cached) return cached;
    const mapped = frames.split('|').map((frame) => sources.frame(frame)).filter((position): position is SourcePosition => position !== null);
    const first = mapped[0];
    const own = mapped.find((position) => position.file.startsWith('src/') && !isMockSource(position.file));
    const result = { place: formatPosition(own ?? first ?? null), mock: first ? isMockSource(first.file) : false };
    placeCache.set(frames, result);
    return result;
  };
  const split = (key: string) => {
    const space = key.indexOf(' ');
    return { kind: key.slice(0, space), frames: key.slice(space + 1) };
  };

  const timers = new Map<string, { site: string; kind: string; fires: number; created: number }>();
  const addTimer = (key: string, field: 'fires' | 'created', count: number) => {
    const { kind, frames } = split(key);
    const where = place(frames);
    if (where.mock) return;
    const id = `${kind} ${where.place}`;
    const entry = timers.get(id) ?? { site: where.place, kind, fires: 0, created: 0 };
    entry[field] += count;
    timers.set(id, entry);
  };
  for (const [key, count] of Object.entries(counted.timersFired)) addTimer(key, 'fires', count);
  for (const [key, count] of Object.entries(counted.timersCreated)) addTimer(key, 'created', count);

  const raf = new Map<string, number>();
  for (const [frames, count] of Object.entries(counted.rafCalls)) {
    const where = place(frames).place;
    raf.set(where, (raf.get(where) ?? 0) + count);
  }

  const live = new Map<string, { site: string; kind: string; delay: number; count: number }>();
  for (const timer of counted.live) {
    const where = place(timer.site);
    if (where.mock) continue;
    const id = `${timer.kind} ${timer.delay} ${where.place}`;
    const entry = live.get(id) ?? { site: where.place, kind: timer.kind, delay: timer.delay, count: 0 };
    entry.count += 1;
    live.set(id, entry);
  }

  const components = new Map<string, number>();
  for (const [key, renders] of Object.entries(counted.rendered)) {
    const known = counted.componentSources[key];
    const position = known ? sources.functionSource(known.source, allChunks) : null;
    const label = position ? formatPosition({ ...position, name: position.name ?? known?.name ?? null }) : `${known?.name ?? key} (?)`;
    components.set(label, (components.get(label) ?? 0) + renders);
  }

  const commands = Object.entries(counted.commands).map(([command, tally]) => ({ command, calls: tally.calls, replyBytes: tally.replyBytes, argBytes: tally.argBytes }));
  const appTimers = [...timers.values()];
  return {
    appJsBytes: sum(chunks.filter((chunk) => !mockChunk(chunk)).map(fileBytes)),
    mockJsBytes: sum(chunks.filter(mockChunk).map(fileBytes)),
    chunks,
    commits: counted.commits,
    mutations: counted.mutations,
    commands: sum(commands.map((command) => command.calls)),
    commandBytes: sum(commands.map((command) => command.replyBytes + command.argBytes)),
    timerFires: sum(appTimers.map((timer) => timer.fires)),
    rafCalls: sum([...raf.values()]),
    liveTimers: sum([...live.values()].map((timer) => timer.count)),
    topCommands: top(commands, (command) => command.replyBytes + command.argBytes),
    topTimers: top(appTimers, (timer) => timer.fires * 1_000 + timer.created),
    topRaf: top([...raf.entries()].map(([site, calls]) => ({ site, calls })), (entry) => entry.calls),
    topComponents: top([...components.entries()].map(([component, renders]) => ({ component, renders })), (entry) => entry.renders),
    topMutations: top(Object.entries(counted.mutationTargets).map(([target, count]) => ({ target, count })), (entry) => entry.count),
    live: top([...live.values()], (timer) => timer.count, 40),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Journeys

/** Reported only: paint and settle times and memory on a real clock, with no counters slowing the page. */
async function timingPass(browser: Browser, url: string): Promise<Timing> {
  const before = webContentPids();
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await page.addInitScript(() => {
    const target = window as Window & { __lastChange?: number };
    target.__lastChange = 0;
    new MutationObserver(() => { target.__lastChange = performance.now(); })
      .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  const network = trackNetwork(page);
  await page.goto(url, { waitUntil: 'load' });
  // Settled: no request in flight and no DOM change for a second, or fifteen seconds at most.
  const deadline = Date.now() + 15_000;
  let settledMs: number | null = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(200);
    const { now, last } = await page.evaluate(() => ({ now: performance.now(), last: (window as Window & { __lastChange?: number }).__lastChange ?? 0 }));
    if (network.inflight === 0 && now - last > 1_000) {
      settledMs = Math.round(last);
      break;
    }
  }
  const paint = await page.evaluate(() => {
    const contentful = performance.getEntriesByName('first-contentful-paint')[0] ?? performance.getEntriesByType('paint')[0];
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return { firstPaintMs: contentful ? Math.round(contentful.startTime) : null, domContentLoadedMs: navigation ? Math.round(navigation.domContentLoadedEventEnd) : null };
  });
  const rss = rssMb(before);
  await context.close();
  return { ...paint, settledMs, rssMb: rss };
}

/**
 * Each page's own JS: a cold start on it (`?page=`), stopped before the prefetch, less what a cold start on Home loads.
 * Opening pages one after another can't show it, as by then the prefetch has loaded them all.
 */
async function coldJs(browser: Browser, origin: string, sources: BuildSources) {
  const appBytes = (chunks: string[]) => sum(chunks.filter((chunk) => sources.mockShare(chunk) <= 0.5).map((chunk) => statSync(join(SITE, chunk)).size));
  const coldStart = async (target?: { page: string; tab?: string }) => {
    const query = new URLSearchParams();
    if (target) query.set('page', target.page);
    if (target?.tab) query.set('tab', target.tab);
    const run = await launch(browser, `${origin}/${target ? `?${query}` : ''}`, BEFORE_PREFETCH_MS);
    const chunks = [...run.scripts];
    await run.context.close();
    return chunks;
  };
  const home = await coldStart();
  const pages: Record<string, number> = {};
  for (const target of PAGES) {
    if (target.page === 'home') continue;
    pages[target.id] = appBytes((await coldStart(target)).filter((chunk) => !home.includes(chunk)));
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return { home: appBytes(home), pages };
}

async function measureSize(browser: Browser, origin: string, size: Size, sources: BuildSources): Promise<SizeResult> {
  const url = `${origin}/${size.query ? `?${size.query}` : ''}`;
  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1_000).toFixed(0)}s`;
  console.log(`\n[${size.id}] timing on a real clock…`);
  const timing = await timingPass(browser, url);

  console.log(`[${size.id}] (${elapsed()}) cold launch and ${IDLE_MINUTES} minutes idle on Home…`);
  const before = webContentPids();
  const idleRun = await launch(browser, url);
  const launchChunks = [...idleRun.scripts];
  const launchStep = summarize(sources, idleRun.counted, launchChunks, launchChunks);
  const rssStartMb = rssMb(before);
  console.log(`[${size.id}] (${elapsed()}) launched; idling…`);
  await reset(idleRun.page);
  await advance(idleRun.page, idleRun.network, FRAME_SAMPLE_MS, IDLE_STEP_MS);
  const framesSampled = (await snapshot(idleRun.page)).rafCalls;
  await idleRun.page.evaluate(() => (window as unknown as { __arborPerf: { holdFrames: () => void } }).__arborPerf.holdFrames());
  await advance(idleRun.page, idleRun.network, IDLE_MINUTES * 60_000 - FRAME_SAMPLE_MS, IDLE_STEP_MS);
  // Frames are counted over the sample alone, scaled to the whole idle, since they're held after it.
  const idleCounted = { ...(await snapshot(idleRun.page)), rafCalls: Object.fromEntries(Object.entries(framesSampled).map(([key, count]) => [key, (count * IDLE_MINUTES * 60_000) / FRAME_SAMPLE_MS])) };
  const idleChunks = idleRun.scripts.slice(launchChunks.length);
  const idleStep = summarize(sources, idleCounted, idleChunks, [...idleRun.scripts]);
  const rssEndMb = rssMb(before);
  await idleRun.context.close();

  console.log(`[${size.id}] (${elapsed()}) opening each page…`);
  const navRun = await launch(browser, url);
  const pages: Record<string, Step> = {};
  for (const target of PAGES) {
    await reset(navRun.page);
    const loadedBefore = navRun.scripts.length;
    await navRun.page.evaluate(({ page, tab }) => {
      const open = (window as Window & { __mockOpen?: (page: string, tab?: string) => void }).__mockOpen;
      if (!open) throw new Error('The mock has no __mockOpen');
      open(page, tab);
    }, target);
    await quiet(navRun.page, navRun.network);
    await advance(navRun.page, navRun.network, NAVIGATION_MS, STEP_MS);
    pages[target.id] = summarize(sources, await snapshot(navRun.page), navRun.scripts.slice(loadedBefore), [...navRun.scripts]);
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  await navRun.context.close();

  let cold: SizeResult['coldJs'];
  if (size.id === 'default') {
    console.log(`[${size.id}] (${elapsed()}) cold start on each page for its JS…`);
    cold = await coldJs(browser, origin, sources);
  }
  console.log(`[${size.id}] (${elapsed()}) done`);
  return { launch: launchStep, coldJs: cold, idle: { ...idleStep, rssStartMb, rssEndMb }, pages, timing };
}

/** The gated counts, flattened into baseline keys. */
function countsOf(results: Latest['sizes']): Counts {
  const counts: Counts = {};
  const perMinute = (value: number) => Math.round((value / IDLE_MINUTES) * 10) / 10;
  for (const [size, result] of Object.entries(results)) {
    if (!result) continue;
    const step = (prefix: string, values: Step) => {
      counts[`${prefix}.reactCommits`] = values.commits;
      counts[`${prefix}.domMutations`] = values.mutations;
      counts[`${prefix}.commands`] = values.commands;
      counts[`${prefix}.commandBytes`] = values.commandBytes;
    };
    step(`${size}.launch`, result.launch);
    // Everything a launch loads, the prefetched pages included; then what Home and each page need on their own.
    counts[`${size}.launch.appJsBytes`] = result.launch.appJsBytes;
    if (result.coldJs) {
      counts[`${size}.launch.homeJsBytes`] = result.coldJs.home;
      for (const [page, bytes] of Object.entries(result.coldJs.pages)) counts[`${size}.page.${page}.appJsBytes`] = bytes;
    }
    for (const [page, values] of Object.entries(result.pages)) step(`${size}.page.${page}`, values);
    const { idle } = result;
    counts[`${size}.idle.commandsPerMinute`] = perMinute(idle.commands);
    counts[`${size}.idle.commandBytesPerMinute`] = Math.round(idle.commandBytes / IDLE_MINUTES);
    counts[`${size}.idle.reactCommitsPerMinute`] = perMinute(idle.commits);
    counts[`${size}.idle.domMutationsPerMinute`] = perMinute(idle.mutations);
    counts[`${size}.idle.timerFiresPerMinute`] = perMinute(idle.timerFires);
    counts[`${size}.idle.liveTimers`] = idle.liveTimers;
    counts[`${size}.idle.rafPerSecond`] = Math.round((idle.rafCalls / (IDLE_MINUTES * 60)) * 10) / 10;
  }
  return counts;
}

function reportedOf(results: Latest['sizes']): Latest['reported'] {
  const reported: Latest['reported'] = {};
  for (const [size, result] of Object.entries(results)) {
    if (!result) continue;
    reported[`${size}.firstPaintMs`] = result.timing.firstPaintMs;
    reported[`${size}.domContentLoadedMs`] = result.timing.domContentLoadedMs;
    reported[`${size}.settledMs`] = result.timing.settledMs;
    reported[`${size}.rssAfterLaunchMb`] = result.timing.rssMb;
    reported[`${size}.rssIdleStartMb`] = result.idle.rssStartMb;
    reported[`${size}.rssIdleEndMb`] = result.idle.rssEndMb;
    reported[`${size}.launch.mockJsBytes`] = result.launch.mockJsBytes;
  }
  return reported;
}

// ---------------------------------------------------------------------------------------------------------------
// Printing

const kb = (bytes: number) => (bytes / 1024).toFixed(1);

function table(headers: string[], rows: (string | number)[][]) {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => String(row[column] ?? '').length)));
  const line = (cells: (string | number)[]) => cells.map((cell, column) => (column === 0 ? String(cell).padEnd(widths[column] ?? 0) : String(cell).padStart(widths[column] ?? 0))).join('  ');
  console.log(line(headers));
  console.log(widths.map((width) => '─'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
}

function printReport(latest: Latest) {
  for (const [size, result] of Object.entries(latest.sizes)) {
    if (!result) continue;
    console.log(`\n━━ ${size} size ━━`);
    const { timing } = result;
    console.log(`Real clock (reported only): first paint ${timing.firstPaintMs ?? '?'} ms, DOM ready ${timing.domContentLoadedMs ?? '?'} ms, settled ${timing.settledMs ?? 'never'} ms, WebContent RSS ${timing.rssMb ?? '?'} MB after launch, ${result.idle.rssStartMb ?? '?'} → ${result.idle.rssEndMb ?? '?'} MB over idle (page clock).`);
    console.log('');
    const js = (bytes: number | undefined) => (bytes === undefined ? '—' : kb(bytes));
    const stepRow = (name: string, step: Step, jsBytes: number | undefined) => [name, js(jsBytes), step.commits, step.mutations, step.commands, kb(step.commandBytes), step.timerFires];
    if (result.coldJs) console.log(`App JS: ${kb(result.launch.appJsBytes)} KB loaded by a launch (every page prefetched two seconds in), ${kb(result.coldJs.home)} KB of it needed for Home. Page JS below is a cold start on that page beyond Home's.\n`);
    table(['Journey', 'App JS KB', 'Commits', 'Mutations', 'Commands', 'Cmd KB', 'Timer fires'], [
      stepRow('launch → Home settled', result.launch, result.launch.appJsBytes),
      ...Object.entries(result.pages).map(([page, step]) => stepRow(`open ${page}`, step, result.coldJs?.pages[page])),
    ]);
    const { idle } = result;
    console.log(`\nIdle on Home, per minute over ${IDLE_MINUTES} minutes:`);
    table(['Counter', 'Value'], [
      ['commands', (idle.commands / IDLE_MINUTES).toFixed(1)],
      ['command KB', kb(idle.commandBytes / IDLE_MINUTES)],
      ['React commits', (idle.commits / IDLE_MINUTES).toFixed(1)],
      ['DOM mutations', (idle.mutations / IDLE_MINUTES).toFixed(1)],
      ['app timer fires', (idle.timerFires / IDLE_MINUTES).toFixed(1)],
      ['live app timers at the end', idle.liveTimers],
      ['requestAnimationFrame per second', (idle.rafCalls / (IDLE_MINUTES * 60)).toFixed(1)],
    ]);
    console.log('\nIdle: commands by bytes per minute');
    table(['Command', 'Calls/min', 'KB/min'], idle.topCommands.slice(0, 10).map((command) => [command.command, (command.calls / IDLE_MINUTES).toFixed(1), kb((command.replyBytes + command.argBytes) / IDLE_MINUTES)]));
    console.log('\nIdle: timers by fires per minute');
    table(['Site', 'Kind', 'Fires/min'], idle.topTimers.slice(0, 10).map((timer) => [timer.site, timer.kind, (timer.fires / IDLE_MINUTES).toFixed(1)]));
    console.log('\nIdle: components rendered per minute');
    table(['Component', 'Renders/min'], idle.topComponents.slice(0, 10).map((entry) => [entry.component, (entry.renders / IDLE_MINUTES).toFixed(1)]));
  }
  if (latest.pageErrors.length) console.log(`\nUncaught errors in the page (counts may be wrong):\n  ${latest.pageErrors.join('\n  ')}`);
  if (latest.notMeasured.length) console.log(`\nNot measured in WebKit: ${latest.notMeasured.join('; ')}`);
}

function printCheck(rows: CheckRow[], verbose: boolean) {
  const shown = rows.filter((row) => verbose || row.status !== 'ok');
  if (shown.length) {
    console.log('');
    table(['Counter', 'Ceiling', 'This run', 'Status'], shown.map((row) => [row.key, row.ceiling ?? '—', row.value ?? '—', row.status === 'over' ? 'OVER' : row.status]));
  }
  const over = rows.filter((row) => row.status === 'over').length;
  const fresh = rows.filter((row) => row.status === 'new').length;
  console.log(`\n${rows.length - over - fresh} within their ceilings, ${over} over, ${fresh} without a ceiling yet${fresh ? ' (bun run perf:ratchet adds them)' : ''}.`);
}

// ---------------------------------------------------------------------------------------------------------------

async function measure(): Promise<Latest> {
  if (!argv.includes('--no-build') || !existsSync(join(SITE, 'index.html'))) build();
  const sources = new BuildSources(SITE, REPO);
  const server = serve();
  const browser = await webkit.launch();
  try {
    const results: Latest['sizes'] = {};
    for (const size of sizes) results[size.id] = await measureSize(browser, `http://127.0.0.1:${server.port}`, size, sources);
    const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
    return {
      generatedAt: new Date().toISOString(),
      commit,
      counts: countsOf(results),
      reported: reportedOf(results),
      sizes: results,
      pageErrors: [...new Set(pageErrors)],
      notMeasured: [
        'long tasks: WebKit has no PerformanceObserver "longtask" entries, and the page clock fakes performance.now, so they can\'t be timed in the page either',
      ],
    };
  } finally {
    await browser.close();
    server.stop(true);
  }
}

const readBaseline = (): Baseline => existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline : { tolerance: {}, ceilings: {} };

let latest: Latest;
if (reuse) {
  if (!existsSync(LATEST)) throw new Error('perf/latest.json is missing: run bun run perf first.');
  latest = JSON.parse(readFileSync(LATEST, 'utf8')) as Latest;
  console.log(`From perf/latest.json (${latest.commit}, ${latest.generatedAt}).`);
} else {
  latest = await measure();
  writeFileSync(LATEST, `${JSON.stringify(latest, null, 2)}\n`);
}
printReport(latest);

const baseline = readBaseline();
if (mode === 'ratchet') {
  const next = ratchet(baseline, latest.counts);
  const lowered = Object.keys(next.ceilings).filter((key) => baseline.ceilings[key] !== undefined && next.ceilings[key] !== baseline.ceilings[key]);
  const added = Object.keys(next.ceilings).filter((key) => baseline.ceilings[key] === undefined);
  writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\nperf/baseline.json: ${lowered.length} ceilings lowered, ${added.length} added.`);
  for (const key of lowered) console.log(`  ${key}: ${baseline.ceilings[key]} → ${next.ceilings[key]}`);
  const over = check(baseline, latest.counts).filter((row) => row.status === 'over');
  if (over.length) console.log(`\n${over.length} counts are over their ceilings and kept them; the ratchet never raises one.`);
} else {
  const rows = check(baseline, latest.counts).filter((row) => row.status !== 'missing' || !onlySize || row.key.startsWith(`${onlySize}.`));
  printCheck(rows, argv.includes('--verbose'));
  if (mode === 'check' && (latest.pageErrors.length || rows.some((row) => row.status === 'over' || row.status === 'missing'))) {
    console.log('\nperf:check failed: a gated count went over its ceiling, wasn\'t measured, or the page threw. Fix it, or raise the ceiling in perf/baseline.json by hand with the reason in the commit.');
    process.exitCode = 1;
  }
}
