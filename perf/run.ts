/**
 * `bun run perf`: Arbor's speed benchmark (docs/perf/PROCESS.md). Builds the browser mock as the production-optimized
 * demo site, serves it on 127.0.0.1 and drives it in Playwright's WebKit, the engine Arbor's window uses, through a
 * cold launch to Home, a visit to each main page, ten minutes of idle on Home, ten minutes with the window closed to
 * the tray on a heavy page, a tour of heavy pages closed to the tray until the window reloads itself into the
 * background, and the first screen's handoff to React (perf/firstScreen.ts). The page clock runs time, so ten minutes
 * take seconds and the gated counts come out the same on every run.
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
import { webkit, type Browser, type Frame, type Page } from 'playwright';
import { installCounters, type CounterSnapshot } from './counters';
import { firstScreenJourney, type FirstScreen } from './firstScreen';
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
const HIDDEN_MINUTES = 10;
/** The page left open when the window is closed to the tray: Usage's Requests, one of the heaviest. */
const HIDDEN_PAGE = { page: 'usage' };
/**
 * Health rounds after the idle: the native sampler's `machine-health-updated`, which the mock never sends itself, once a
 * minute as on an idle Mac, with what each re-reads and re-renders counted over the seconds after it.
 */
const HEALTH_ROUNDS = 5;
const HEALTH_ROUND_MS = 2_000;

/** The heavy pages toured before the window is closed for long enough to reload (docs/perf/BACKLOG.md, M3). */
const RELOAD_TOUR: { page: string; tab?: string; lens?: string }[] = [
  { page: 'usage' },
  { page: 'sessions' },
  { page: 'setup', tab: 'library', lens: 'machines' },
  { page: 'accounts' },
  { page: 'machines' },
];
/** Closed this long, the window is a look short of its half hour (src/services/backgroundReload.ts). */
const BEFORE_RELOAD_MINUTES = 29;
/** How long after its half hour the window may take to reload: one look, five minutes apart, and a margin. */
const RELOAD_WAIT_MINUTES = 7;
/** Footprint samples, a real second apart, taken for the memory before and after the reload. */
const FOOTPRINT_SAMPLES = 10;
/** How long the background page runs before it's counted: its boot. */
const BACKGROUND_BOOT_MS = 5_000;
/**
 * Each of these must be heard from within a minute of the reload: the tray, the pools' report and the command line. A
 * push that would only clear the tray waits out that minute (services/bootMode.ts), so the journey waits a moment past it.
 */
const MONITOR_COMMANDS = ['report_working_sessions', 'set_tray_rows', 'set_tray_status', 'set_tray_unread', 'cli_bridge_ready'];

type Size = { id: 'default' | 'real'; query: string };
const SIZES: Size[] = [{ id: 'default', query: '' }, { id: 'real', query: 'size=real' }];

/** The main pages and Sync's views, opened in this order from Home the way the sidebar would. */
const PAGES: { id: string; page: string; tab?: string; lens?: string }[] = [
  { id: 'machines', page: 'machines' },
  { id: 'machine', page: 'machine:ci-01' },
  { id: 'pools', page: 'pools' },
  { id: 'sessions', page: 'sessions' },
  { id: 'automations', page: 'automations' },
  { id: 'sync', page: 'setup' },
  { id: 'sync-library', page: 'setup', tab: 'library' },
  { id: 'sync-library-machines', page: 'setup', tab: 'library', lens: 'machines' },
  { id: 'sync-library-cost', page: 'setup', tab: 'library', lens: 'cost' },
  { id: 'sync-software', page: 'setup', tab: 'software' },
  { id: 'sync-repo', page: 'setup', tab: 'repo' },
  { id: 'sync-repo-changes', page: 'setup', tab: 'repo', lens: 'changes' },
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
  /** Component renders across every commit: what each commit cost, as commits alone don't say. */
  componentRenders: number;
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
  /** Where renders started: components that rendered under no other that did, with every render below them. */
  topOrigins: { component: string; renders: number }[];
  topMutations: { target: string; count: number }[];
  live: { site: string; kind: string; delay: number; count: number }[];
};

/**
 * What a launch sent before Home settled: the page clock's time of the DOM's last change before a quiet stretch, the calls sent
 * up to then, and calls repeated while the same call (same command and arguments) was still in flight.
 */
type Settling = {
  settledAtMs: number;
  beforeSettled: number;
  duplicatesInFlight: number;
  /** The calls repeated while in flight, by command (and management path). */
  duplicates: Record<string, number>;
  /** Each command's calls before Home settled, with the management API's broken down by method and path. */
  calls: { command: string; calls: number; firstAtMs: number }[];
};

type Timing = { firstPaintMs: number | null; domContentLoadedMs: number | null; settledMs: number | null; rssMb: number | null };

/** Ten minutes closed to the tray: the counts over them, and the page's elements while hidden and once shown again. */
type HiddenResult = Step & { domNodesShown: number; domNodesHidden: number; domNodesBack: number; rssShownMb: number | null; rssHiddenMb: number | null };

/**
 * A tour of heavy pages, then closed to the tray until the window reloads into the background: its memory before and
 * after, what the background page loads and does as it starts, whether every monitor was heard from within a minute,
 * and whether an alert went out again.
 */
type ReloadResult = {
  reloaded: boolean;
  /** The background page's start: what it loaded and sent, over its first five seconds. */
  boot: Step;
  domNodesBefore: number;
  domNodesBackground: number;
  domNodesBack: number;
  /** The monitors' commands not heard within a minute of the reload. */
  monitorsMissing: string[];
  /** Alerts sent before the reload that went out again within a minute after it. */
  alertsResent: string[];
  /** Whether the window came back on the view it was left on. */
  sameView: boolean;
  /**
   * The WebContent process's footprint after the tour, closed a look short of the half hour, a minute after it, and
   * shown again; the middle two settled (settledFootprintMb).
   */
  footprintShownMb: number | null;
  footprintBeforeMb: number | null;
  footprintAfterMb: number | null;
  footprintBackMb: number | null;
  /** Wall-clock time from the window showing to the sidebar marking the view, as the app loads around it. */
  backMs: number | null;
};

type SizeResult = {
  launch: Step & { settling?: Settling };
  hidden?: HiddenResult;
  reload?: ReloadResult;
  /** App JS a cold start needs before the prefetch: Home's, and each page's beyond Home's. Default size only. */
  coldJs?: { home: number; pages: Record<string, number> };
  idle: Step & { rssStartMb: number | null; rssEndMb: number | null };
  /** Every health round's counts together; the gated ones are per round. */
  healthRounds?: Step;
  pages: Record<string, Step>;
  /** index.html's static first screen against React's first frame. Default size only. */
  firstScreen?: FirstScreen;
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

/** Elements in the document, and in the content area beside the sidebar. */
// Leaves out the <link>s Vite adds to <head> as code loads, which say how the code is split, not what the page holds.
const domNodes = (page: Page) => page.evaluate(() => ({
  all: document.getElementsByTagName('*').length - document.head.getElementsByTagName('link').length,
  main: document.querySelector('main')?.getElementsByTagName('*').length ?? 0,
}));

const openPage = (page: Page, target: { page: string; tab?: string; lens?: string }) => page.evaluate(({ page, tab, lens }) => {
  const open = (window as Window & { __mockOpen?: (page: string, tab?: string, lens?: string) => void }).__mockOpen;
  if (!open) throw new Error('The mock has no __mockOpen');
  open(page, tab, lens);
}, target);

/** Closes the mock's window to the tray, or shows it again (src/dev/mockTauri.ts). */
const moveWindow = (page: Page, state: 'shown' | 'closed') => page.evaluate((state) => {
  const move = (window as Window & { __mockWindow?: (state: string) => void }).__mockWindow;
  if (!move) throw new Error('The mock has no __mockWindow');
  move(state);
}, state);

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

/**
 * The largest physical footprint, in MB, among the WebContent processes started since `before`: what Activity Monitor
 * shows as a process's memory. Resident size keeps pages WebKit has handed back until the system wants them, so it
 * barely moves when a page lets go; the footprint does.
 */
function footprintMb(before: Set<number>): number | null {
  const sizes = [...webContentPids()].filter((pid) => !before.has(pid)).flatMap((pid) => {
    const match = /Footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(spawnSync('footprint', ['-p', String(pid)], { encoding: 'utf8' }).stdout);
    if (!match?.[1] || !match[2]) return [];
    return [Number(match[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2] as 'KB' | 'MB' | 'GB']];
  });
  return sizes.length ? Math.round(Math.max(...sizes)) : null;
}

/**
 * The footprint once WebKit has had a few real seconds to collect what the page let go of and hand it back: the least
 * over several samples, since a single one lands wherever its last collection happened to be.
 */
async function settledFootprintMb(page: Page, before: Set<number>): Promise<number | null> {
  const samples: number[] = [];
  for (let sample = 0; sample < FOOTPRINT_SAMPLES; sample += 1) {
    await page.waitForTimeout(1_000);
    const size = footprintMb(before);
    if (size !== null) samples.push(size);
  }
  return samples.length ? Math.min(...samples) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Turning raw counts into a step

/** How long the mock takes to answer (src/dev/mockTauri.ts), so how long a call is in flight. */
const MOCK_ANSWER_MS = 60;

/** Home has settled at its last DOM change before this long without one. */
const SETTLED_QUIET_MS = 500;

function settlingOf(counted: CounterSnapshot): Settling {
  const times = counted.mutationTimes;
  const quietAfter = times.findIndex((at, index) => (times[index + 1] ?? Infinity) - at >= SETTLED_QUIET_MS);
  const settledAt = times[quietAfter] ?? START_MS;
  const before = counted.sent.filter((call) => call.at <= settledAt);
  const lastSent = new Map<string, number>();
  let duplicatesInFlight = 0;
  const duplicates: Record<string, number> = {};
  for (const call of counted.sent) {
    const key = `${call.command} ${call.args}`;
    const previous = lastSent.get(key);
    if (previous !== undefined && call.at - previous < MOCK_ANSWER_MS) {
      duplicatesInFlight += 1;
      const name = call.detail ? `${call.command} ${call.detail}` : call.command;
      duplicates[name] = (duplicates[name] ?? 0) + 1;
    }
    lastSent.set(key, call.at);
  }
  const calls = new Map<string, { command: string; calls: number; firstAtMs: number }>();
  for (const call of before) {
    const name = call.detail ? `${call.command} ${call.detail}` : call.command;
    const entry = calls.get(name) ?? { command: name, calls: 0, firstAtMs: call.at - START_MS };
    entry.calls += 1;
    calls.set(name, entry);
  }
  return {
    settledAtMs: settledAt - START_MS,
    beforeSettled: before.length,
    duplicatesInFlight,
    duplicates,
    calls: [...calls.values()].sort((a, b) => a.firstAtMs - b.firstAtMs || b.calls - a.calls),
  };
}

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

  const labels = new Map<string, string>();
  const label = (key: string) => {
    const cached = labels.get(key);
    if (cached) return cached;
    const known = counted.componentSources[key];
    const position = known ? sources.functionSource(known.source, allChunks) : null;
    const named = position ? formatPosition({ ...position, name: position.name ?? known?.name ?? null }) : `${known?.name ?? key} (?)`;
    labels.set(key, named);
    return named;
  };
  const byComponent = (tally: Record<string, number>) => {
    const components = new Map<string, number>();
    for (const [key, renders] of Object.entries(tally)) components.set(label(key), (components.get(label(key)) ?? 0) + renders);
    return top([...components.entries()].map(([component, renders]) => ({ component, renders })), (entry) => entry.renders);
  };

  const commands = Object.entries(counted.commands).map(([command, tally]) => ({ command, calls: tally.calls, replyBytes: tally.replyBytes, argBytes: tally.argBytes }));
  const appTimers = [...timers.values()];
  return {
    appJsBytes: sum(chunks.filter((chunk) => !mockChunk(chunk)).map(fileBytes)),
    mockJsBytes: sum(chunks.filter(mockChunk).map(fileBytes)),
    chunks,
    commits: counted.commits,
    componentRenders: sum(Object.values(counted.rendered)),
    mutations: counted.mutations,
    commands: sum(commands.map((command) => command.calls)),
    commandBytes: sum(commands.map((command) => command.replyBytes + command.argBytes)),
    timerFires: sum(appTimers.map((timer) => timer.fires)),
    rafCalls: sum([...raf.values()]),
    liveTimers: sum([...live.values()].map((timer) => timer.count)),
    topCommands: top(commands, (command) => command.replyBytes + command.argBytes),
    topTimers: top(appTimers, (timer) => timer.fires * 1_000 + timer.created),
    topRaf: top([...raf.entries()].map(([site, calls]) => ({ site, calls })), (entry) => entry.calls),
    topComponents: byComponent(counted.rendered),
    topOrigins: byComponent(counted.origins),
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
  const coldStart = async (target?: { page: string; tab?: string; lens?: string }) => {
    const query = new URLSearchParams();
    if (target) query.set('page', target.page);
    if (target?.tab) query.set('tab', target.tab);
    if (target?.lens) query.set('lens', target.lens);
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
  const launchStep = { ...summarize(sources, idleRun.counted, launchChunks, launchChunks), settling: settlingOf(idleRun.counted) };
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
  console.log(`[${size.id}] (${elapsed()}) ${HEALTH_ROUNDS} health rounds…`);
  const healthRounds = summarize(sources, await healthRoundsOf(idleRun.page, idleRun.network), [], [...idleRun.scripts]);
  await idleRun.context.close();

  console.log(`[${size.id}] (${elapsed()}) opening each page…`);
  const navRun = await launch(browser, url);
  const pages: Record<string, Step> = {};
  for (const target of PAGES) {
    await reset(navRun.page);
    const loadedBefore = navRun.scripts.length;
    await openPage(navRun.page, target);
    await quiet(navRun.page, navRun.network);
    await advance(navRun.page, navRun.network, NAVIGATION_MS, STEP_MS);
    pages[target.id] = summarize(sources, await snapshot(navRun.page), navRun.scripts.slice(loadedBefore), [...navRun.scripts]);
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  await navRun.context.close();

  console.log(`[${size.id}] (${elapsed()}) ${HIDDEN_MINUTES} minutes closed to the tray on ${HIDDEN_PAGE.page}…`);
  const hidden = await hiddenJourney(browser, url, sources);

  console.log(`[${size.id}] (${elapsed()}) a tour of heavy pages, then closed to the tray until the window reloads…`);
  const reload = await reloadJourney(browser, url, sources);

  let cold: SizeResult['coldJs'];
  let firstScreen: FirstScreen | undefined;
  if (size.id === 'default') {
    console.log(`[${size.id}] (${elapsed()}) the first screen against React's first frame…`);
    const handoff = await firstScreenJourney(browser, origin, SITE, contextOptions, START_MS);
    firstScreen = handoff.result;
    pageErrors.push(...handoff.errors);
    console.log(`[${size.id}] (${elapsed()}) cold start on each page for its JS…`);
    cold = await coldJs(browser, origin, sources);
  }
  console.log(`[${size.id}] (${elapsed()}) done`);
  return { launch: launchStep, coldJs: cold, idle: { ...idleStep, rssStartMb, rssEndMb }, healthRounds, hidden, reload, pages, timing, firstScreen };
}

/**
 * The window closed to the tray with a heavy page open, as it mostly is (docs/perf/BACKLOG.md, M1): what keeps
 * running for the tray, the alerts and the pools, and what's left of the page. Frames are held, as WebKit runs none
 * for a hidden page. Showing it again must bring the page back.
 */
async function hiddenJourney(browser: Browser, url: string, sources: BuildSources): Promise<HiddenResult> {
  const before = webContentPids();
  const run = await launch(browser, url);
  await openPage(run.page, HIDDEN_PAGE);
  await quiet(run.page, run.network);
  await advance(run.page, run.network, NAVIGATION_MS, STEP_MS);
  const shown = await domNodes(run.page);
  const rssShownMb = rssMb(before);
  await run.page.evaluate(() => (window as unknown as { __arborPerf: { holdFrames: () => void } }).__arborPerf.holdFrames());
  await reset(run.page);
  const loadedBefore = run.scripts.length;
  await moveWindow(run.page, 'closed');
  await advance(run.page, run.network, HIDDEN_MINUTES * 60_000, IDLE_STEP_MS);
  // The minute's checks land on the last step, each through a timer due at once; let them finish before counting what's
  // still live.
  await advance(run.page, run.network, STEP_MS, STEP_MS);
  const step = summarize(sources, await snapshot(run.page), run.scripts.slice(loadedBefore), [...run.scripts]);
  const hidden = await domNodes(run.page);
  const rssHiddenMb = rssMb(before);
  await moveWindow(run.page, 'shown');
  await quiet(run.page, run.network);
  await advance(run.page, run.network, NAVIGATION_MS, STEP_MS);
  const back = await domNodes(run.page);
  if (back.main < shown.main / 2) pageErrors.push(`hidden: the page didn't come back once the window showed (${back.main} elements, ${shown.main} before)`);
  await run.context.close();
  return { ...step, domNodesShown: shown.all, domNodesHidden: hidden.all, domNodesBack: back.all, rssShownMb, rssHiddenMb };
}

/** Each health round's counts over the seconds after it, added up; the minute between rounds isn't counted. */
async function healthRoundsOf(page: Page, network: ReturnType<typeof trackNetwork>): Promise<CounterSnapshot> {
  let total: CounterSnapshot | null = null;
  const add = (into: Record<string, number>, from: Record<string, number>) => {
    for (const [key, count] of Object.entries(from)) into[key] = (into[key] ?? 0) + count;
  };
  for (let round = 0; round < HEALTH_ROUNDS; round += 1) {
    await reset(page);
    await page.evaluate(() => (window as Window & { __mockEmit?: (event: string) => void }).__mockEmit?.('machine-health-updated'));
    await quiet(page, network);
    await advance(page, network, HEALTH_ROUND_MS, STEP_MS);
    const counted = await snapshot(page);
    if (!total) total = counted;
    else {
      total.commits += counted.commits;
      total.mutations += counted.mutations;
      for (const tally of ['timersCreated', 'timersFired', 'rafCalls', 'rendered', 'origins', 'mutationTargets'] as const) add(total[tally], counted[tally]);
      Object.assign(total.componentSources, counted.componentSources);
      for (const [command, tally] of Object.entries(counted.commands)) {
        const into = (total.commands[command] ??= { calls: 0, argBytes: 0, replyBytes: 0, failed: 0 });
        into.calls += tally.calls;
        into.argBytes += tally.argBytes;
        into.replyBytes += tally.replyBytes;
        into.failed += tally.failed;
      }
    }
    await advance(page, network, 60_000 - HEALTH_ROUND_MS, IDLE_STEP_MS);
  }
  if (!total) throw new Error('No health rounds ran.');
  return total;
}

/** The alert history as the mock keeps it (src/services/alertHistory.ts): each entry's key and when it last went out. */
const alertsSent = (page: Page) => page.evaluate(() => {
  try {
    const history = JSON.parse(localStorage.getItem('arbor.alert-history.v1') ?? '{}') as { entries?: { kind: string; title: string; subject?: unknown; atMs: number; notifiedAtMs?: number }[] };
    return (history.entries ?? []).map((entry) => ({ key: `${entry.kind} ${JSON.stringify(entry.subject ?? null)} ${entry.title}`, sentAtMs: entry.notifiedAtMs ?? entry.atMs }));
  } catch {
    return [];
  }
});

/** The view on screen, as the sidebar marks it. */
const currentRow = (page: Page) => page.evaluate(() => document.querySelector('aside [aria-current="page"]')?.textContent?.trim() ?? '');

/**
 * The window closed to the tray after a tour of heavy pages, for longer than the half hour after which it reloads
 * into a fresh page (docs/perf/BACKLOG.md, M3). The app reloads itself, as it would; the journey only moves the clock
 * and watches. The background page must start every monitor again within a minute, without sending an alert twice,
 * and the window must come back on the view it was left on.
 */
async function reloadJourney(browser: Browser, url: string, sources: BuildSources): Promise<ReloadResult> {
  const before = webContentPids();
  const run = await launch(browser, url);
  for (const target of RELOAD_TOUR) {
    await openPage(run.page, target);
    await quiet(run.page, run.network);
    await advance(run.page, run.network, NAVIGATION_MS, STEP_MS);
  }
  const shownRow = await currentRow(run.page);
  const footprintShownMb = footprintMb(before);
  await run.page.evaluate(() => (window as unknown as { __arborPerf: { holdFrames: () => void } }).__arborPerf.holdFrames());
  await moveWindow(run.page, 'closed');
  await advance(run.page, run.network, BEFORE_RELOAD_MINUTES * 60_000, 5_000);
  const beforeNodes = (await domNodes(run.page)).all;
  const footprintBeforeMb = await settledFootprintMb(run.page, before);
  const sentBefore = await alertsSent(run.page);

  // From here the page may go at any moment: the clock moves in steps, and each waits for the page that's there.
  let reloaded = false;
  const scripts: string[] = [];
  const onNavigated = (frame: Frame) => {
    if (frame === run.page.mainFrame() && frame.url().includes('boot=background')) reloaded = true;
  };
  run.page.on('framenavigated', onNavigated);
  run.page.on('response', (response) => {
    const path = new URL(response.url()).pathname.replace(/^\//, '');
    if (reloaded && path.endsWith('.js') && !scripts.includes(path)) scripts.push(path);
  });
  const reloadedAtMs = await run.page.evaluate(() => Date.now());
  for (let waited = 0; waited < RELOAD_WAIT_MINUTES * 60_000 && !reloaded; waited += 5_000) {
    await run.page.clock.runFor(5_000).catch(() => undefined);
    await quiet(run.page, run.network).catch(() => undefined);
  }
  run.page.off('framenavigated', onNavigated);
  if (!reloaded) {
    const footprintAfterMb = await settledFootprintMb(run.page, before);
    await run.context.close();
    return {
      reloaded, boot: summarize(sources, emptySnapshot(), [], []), domNodesBefore: beforeNodes, domNodesBackground: beforeNodes, domNodesBack: beforeNodes,
      monitorsMissing: MONITOR_COMMANDS, alertsResent: [], sameView: true, footprintShownMb, footprintBeforeMb, footprintAfterMb, footprintBackMb: footprintAfterMb, backMs: null,
    };
  }
  await run.page.waitForLoadState('load');
  await quiet(run.page, run.network);
  await run.page.evaluate(() => (window as unknown as { __arborPerf: { holdFrames: () => void } }).__arborPerf.holdFrames());
  await advance(run.page, run.network, BACKGROUND_BOOT_MS, STEP_MS);
  const boot = summarize(sources, await snapshot(run.page), [...scripts], [...run.scripts, ...scripts]);
  const backgroundNodes = (await domNodes(run.page)).all;
  await advance(run.page, run.network, 61_000 - BACKGROUND_BOOT_MS, 1_000);
  const heard = (await snapshot(run.page)).commands;
  const monitorsMissing = MONITOR_COMMANDS.filter((command) => !heard[command]?.calls);
  const sentBeforeKeys = new Set(sentBefore.map((alert) => alert.key));
  const alertsResent = (await alertsSent(run.page)).filter((alert) => alert.sentAtMs >= reloadedAtMs && sentBeforeKeys.has(alert.key)).map((alert) => alert.key);
  const footprintAfterMb = await settledFootprintMb(run.page, before);

  const showing = performance.now();
  await moveWindow(run.page, 'shown');
  const backMs = await run.page.waitForSelector('aside [aria-current="page"]', { timeout: 10_000 }).then(() => Math.round(performance.now() - showing), () => null);
  await quiet(run.page, run.network);
  await advance(run.page, run.network, NAVIGATION_MS, STEP_MS);
  const backNodes = (await domNodes(run.page)).all;
  const sameView = (await currentRow(run.page)) === shownRow;
  const footprintBackMb = footprintMb(before);
  await run.context.close();
  return { reloaded, boot, domNodesBefore: beforeNodes, domNodesBackground: backgroundNodes, domNodesBack: backNodes, monitorsMissing, alertsResent, sameView, footprintShownMb, footprintBeforeMb, footprintAfterMb, footprintBackMb, backMs };
}

/** Counters with nothing in them, for a journey that never got to count. */
const emptySnapshot = (): CounterSnapshot => ({
  timersCreated: {}, timersFired: {}, live: [], rafCalls: {}, commands: {}, commits: 0, rendered: {}, origins: {}, componentSources: {}, mutations: 0, mutationTargets: {}, sent: [], mutationTimes: [], wrapped: true, visibility: 'hidden',
});

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
    counts[`${size}.launch.componentRenders`] = result.launch.componentRenders;
    // Everything a launch loads, the prefetched pages included; then what Home and each page need on their own.
    counts[`${size}.launch.appJsBytes`] = result.launch.appJsBytes;
    if (result.launch.settling) {
      counts[`${size}.launch.commandsBeforeSettled`] = result.launch.settling.beforeSettled;
      counts[`${size}.launch.duplicateCallsInFlight`] = result.launch.settling.duplicatesInFlight;
    }
    if (result.coldJs) {
      counts[`${size}.launch.homeJsBytes`] = result.coldJs.home;
      for (const [page, bytes] of Object.entries(result.coldJs.pages)) counts[`${size}.page.${page}.appJsBytes`] = bytes;
    }
    for (const [page, values] of Object.entries(result.pages)) step(`${size}.page.${page}`, values);
    const { idle } = result;
    counts[`${size}.idle.commandsPerMinute`] = perMinute(idle.commands);
    counts[`${size}.idle.commandBytesPerMinute`] = Math.round(idle.commandBytes / IDLE_MINUTES);
    counts[`${size}.idle.reactCommitsPerMinute`] = perMinute(idle.commits);
    counts[`${size}.idle.componentRendersPerMinute`] = perMinute(idle.componentRenders);
    counts[`${size}.idle.domMutationsPerMinute`] = perMinute(idle.mutations);
    counts[`${size}.idle.timerFiresPerMinute`] = perMinute(idle.timerFires);
    counts[`${size}.idle.liveTimers`] = idle.liveTimers;
    counts[`${size}.idle.rafPerSecond`] = Math.round((idle.rafCalls / (IDLE_MINUTES * 60)) * 10) / 10;
    const { firstScreen } = result;
    if (firstScreen) {
      counts[`${size}.firstScreen.shiftPx`] = firstScreen.shiftPx;
      counts[`${size}.firstScreen.pixelsChanged`] = firstScreen.pixelsChanged;
      counts[`${size}.firstScreen.shellElements`] = firstScreen.shellElements;
      counts[`${size}.firstScreen.indexHtmlBytes`] = firstScreen.indexHtmlBytes;
    }
    const { hidden } = result;
    if (hidden) {
      const perHiddenMinute = (value: number) => Math.round((value / HIDDEN_MINUTES) * 10) / 10;
      counts[`${size}.hidden.commandsPerMinute`] = perHiddenMinute(hidden.commands);
      counts[`${size}.hidden.commandBytesPerMinute`] = Math.round(hidden.commandBytes / HIDDEN_MINUTES);
      counts[`${size}.hidden.reactCommitsPerMinute`] = perHiddenMinute(hidden.commits);
      counts[`${size}.hidden.domMutationsPerMinute`] = perHiddenMinute(hidden.mutations);
      counts[`${size}.hidden.timerFiresPerMinute`] = perHiddenMinute(hidden.timerFires);
      counts[`${size}.hidden.liveTimers`] = hidden.liveTimers;
      counts[`${size}.hidden.domNodes`] = hidden.domNodesHidden;
    }
    const rounds = result.healthRounds;
    if (rounds) {
      const perRound = (value: number) => Math.round((value / HEALTH_ROUNDS) * 10) / 10;
      counts[`${size}.healthRound.reactCommits`] = perRound(rounds.commits);
      counts[`${size}.healthRound.componentRenders`] = perRound(rounds.componentRenders);
      counts[`${size}.healthRound.commands`] = perRound(rounds.commands);
    }
    const { reload } = result;
    if (reload) {
      // What a page the window reloaded into in the background loads and does as it starts: only what the monitors need.
      counts[`${size}.reload.appJsBytes`] = reload.boot.appJsBytes;
      counts[`${size}.reload.commands`] = reload.boot.commands;
      counts[`${size}.reload.commandBytes`] = reload.boot.commandBytes;
      counts[`${size}.reload.reactCommits`] = reload.boot.commits;
      counts[`${size}.reload.domNodes`] = reload.domNodesBackground;
      // Each must stay at none: the window didn't reload, a monitor wasn't heard from within a minute, an alert went
      // out twice, or the window came back somewhere else.
      counts[`${size}.reload.notReloaded`] = reload.reloaded ? 0 : 1;
      counts[`${size}.reload.monitorsMissing`] = reload.monitorsMissing.length;
      counts[`${size}.reload.alertsResent`] = reload.alertsResent.length;
      counts[`${size}.reload.viewLost`] = reload.sameView ? 0 : 1;
    }
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
    reported[`${size}.hidden.rssShownMb`] = result.hidden?.rssShownMb ?? null;
    reported[`${size}.hidden.rssHiddenMb`] = result.hidden?.rssHiddenMb ?? null;
    reported[`${size}.launch.settledAtMs`] = result.launch.settling?.settledAtMs ?? null;
    reported[`${size}.reload.footprintShownMb`] = result.reload?.footprintShownMb ?? null;
    reported[`${size}.reload.footprintBeforeMb`] = result.reload?.footprintBeforeMb ?? null;
    reported[`${size}.reload.footprintAfterMb`] = result.reload?.footprintAfterMb ?? null;
    reported[`${size}.reload.footprintBackMb`] = result.reload?.footprintBackMb ?? null;
    reported[`${size}.reload.backMs`] = result.reload?.backMs ?? null;
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
    const { firstScreen } = result;
    if (firstScreen) {
      const moved = Object.entries(firstScreen.shifts).filter(([, px]) => px > 0);
      console.log(`\nFirst screen → React's first frame (at ${firstScreen.handoffAtMs} ms of page clock): ${firstScreen.shiftPx} px moved at most${moved.length ? ` (${moved.map(([name, px]) => `${name} ${px}`).join(', ')})` : ''}, ${firstScreen.pixelsChanged} pixels changed, ${firstScreen.shellElements} elements in the static screen, index.html ${kb(firstScreen.indexHtmlBytes)} KB.`);
    }
    const { settling } = result.launch;
    if (settling) {
      console.log(`\nLaunch: Home settled at ${settling.settledAtMs} ms on the page clock (its last DOM change before ${SETTLED_QUIET_MS} ms without one), after ${settling.beforeSettled} calls; ${settling.duplicatesInFlight} repeated a call still in flight${settling.duplicatesInFlight ? ` (${Object.entries(settling.duplicates).map(([name, count]) => `${name} ×${count}`).join(', ')})` : ''}.`);
      table(['Sent before Home settled', 'Calls', 'First at ms'], settling.calls.map((entry) => [entry.command, entry.calls, entry.firstAtMs]));
    }
    const { idle } = result;
    console.log(`\nIdle on Home, per minute over ${IDLE_MINUTES} minutes:`);
    table(['Counter', 'Value'], [
      ['commands', (idle.commands / IDLE_MINUTES).toFixed(1)],
      ['command KB', kb(idle.commandBytes / IDLE_MINUTES)],
      ['React commits', (idle.commits / IDLE_MINUTES).toFixed(1)],
      ['component renders', (idle.componentRenders / IDLE_MINUTES).toFixed(1)],
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
    const { hidden } = result;
    if (hidden) {
      const perMinute = (value: number) => (value / HIDDEN_MINUTES).toFixed(1);
      console.log(`\nClosed to the tray on ${HIDDEN_PAGE.page}, per minute over ${HIDDEN_MINUTES} minutes (WebContent RSS ${hidden.rssShownMb ?? '?'} MB shown → ${hidden.rssHiddenMb ?? '?'} MB hidden, reported only):`);
      table(['Counter', 'Value'], [
        ['commands', perMinute(hidden.commands)],
        ['command KB', kb(hidden.commandBytes / HIDDEN_MINUTES)],
        ['React commits', perMinute(hidden.commits)],
        ['DOM mutations', perMinute(hidden.mutations)],
        ['app timer fires', perMinute(hidden.timerFires)],
        ['live app timers at the end', hidden.liveTimers],
        ['elements: shown → hidden → shown again', `${hidden.domNodesShown} → ${hidden.domNodesHidden} → ${hidden.domNodesBack}`],
      ]);
      console.log('\nHidden: commands by bytes per minute');
      table(['Command', 'Calls/min', 'KB/min'], hidden.topCommands.slice(0, 10).map((command) => [command.command, perMinute(command.calls), kb((command.replyBytes + command.argBytes) / HIDDEN_MINUTES)]));
      console.log('\nHidden: timers by fires per minute');
      table(['Site', 'Kind', 'Fires/min'], hidden.topTimers.slice(0, 10).map((timer) => [timer.site, timer.kind, perMinute(timer.fires)]));
      console.log('\nHidden: components rendered per minute');
      table(['Component', 'Renders/min'], hidden.topComponents.slice(0, 10).map((entry) => [entry.component, perMinute(entry.renders)]));
    }
    console.log('\nIdle: where renders started (renders per minute at and below each)');
    table(['Component', 'Renders/min'], (idle.topOrigins ?? []).slice(0, 10).map((entry) => [entry.component, (entry.renders / IDLE_MINUTES).toFixed(1)]));
    const rounds = result.healthRounds;
    if (rounds) {
      const perRound = (value: number) => (value / HEALTH_ROUNDS).toFixed(1);
      console.log(`\nEach health round (machine-health-updated), over the ${HEALTH_ROUND_MS / 1_000} s after it: ${perRound(rounds.commits)} commits, ${perRound(rounds.componentRenders)} component renders, ${perRound(rounds.commands)} commands`);
      table(['Started at', 'Renders/round'], (rounds.topOrigins ?? []).slice(0, 8).map((entry) => [entry.component, perRound(entry.renders)]));
    }
  }
  for (const [size, result] of Object.entries(latest.sizes)) {
    const reload = result?.reload;
    if (!reload) continue;
    console.log(`\n━━ ${size} size: closed to the tray past the half hour after a tour of ${RELOAD_TOUR.map((target) => target.page).join(', ')} ━━`);
    console.log(`WebContent footprint (reported only): ${reload.footprintShownMb ?? '?'} MB after the tour → ${reload.footprintBeforeMb ?? '?'} MB closed ${BEFORE_RELOAD_MINUTES} minutes → ${reload.footprintAfterMb ?? '?'} MB a minute after ${reload.reloaded ? 'the reload' : 'the half hour (no reload)'} → ${reload.footprintBackMb ?? '?'} MB shown again.`);
    table(['Counter', 'Value'], [
      ['reloaded by itself', reload.reloaded ? 'yes' : 'NO'],
      ['background boot: app JS KB', kb(reload.boot.appJsBytes)],
      ['background boot: commands', reload.boot.commands],
      ['background boot: command KB', kb(reload.boot.commandBytes)],
      ['background boot: React commits', reload.boot.commits],
      ['elements: closed → background → shown again', `${reload.domNodesBefore} → ${reload.domNodesBackground} → ${reload.domNodesBack}`],
      ['monitors not heard within a minute', reload.monitorsMissing.join(', ') || 'none'],
      ['alerts sent again', reload.alertsResent.join('; ') || 'none'],
      ['back on the view it was left on', reload.sameView ? 'yes' : 'NO'],
      ['shown to the sidebar back (wall clock, reported)', reload.backMs ? `${reload.backMs} ms` : '—'],
    ]);
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
