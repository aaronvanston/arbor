/**
 * `bun run perf:cpu`: what an open, idle window costs in real CPU, on the real clock (docs/perf/PROCESS.md). The main
 * benchmark runs a page clock, so it counts commits and timers but can't see CSS transitions or painting, which run on
 * WebKit's own clock. This one opens a page in Playwright's WebKit at a large Retina window, sends the health sampler's
 * `machine-health-updated` every five seconds as the real app does while a machine is on screen, and reads the CPU
 * time the WebContent and GPU processes used over the idle stretch. Reported only: it's wall-clock noisy, so each
 * case runs several times and the median is printed.
 *
 *   bun run perf:cpu                       every case, 3 runs of 30 s each
 *   bun run perf:cpu --case=machine --runs=5 --seconds=20 --no-build
 *   bun run perf:cpu --unfocused           the window shows but another app has focus, so the sidebar art rests
 */
import { spawnSync } from 'node:child_process';
import { join, normalize } from 'node:path';
import { webkit, type Page } from 'playwright';

const REPO = normalize(join(import.meta.dir, '..'));
const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
/** `--site=<dir>` measures another build, such as main's, for a before and after. */
const SITE = arg('site') ?? join(REPO, '.perf', 'site');
const RUNS = Number(arg('runs') ?? 3);
const SECONDS = Number(arg('seconds') ?? 30);
const HEALTH_EVERY_MS = 5_000;
const UNFOCUSED = process.argv.includes('--unfocused');
/** The owner's window when the cost was reported (2026-10-07): 2345 × 1410 points on a Retina display. */
const VIEWPORT = { width: 2345, height: 1410 };

const CASES: Record<string, { page: string }> = {
  home: { page: 'home' },
  machine: { page: 'machine:ci-01' },
  machines: { page: 'machines' },
};
const only = arg('case');
const cases = Object.entries(CASES).filter(([id]) => !only || only.split(',').includes(id));

if (!process.argv.includes('--no-build') && !arg('site')) {
  console.log('Building the demo site into .perf/site…');
  const result = spawnSync('bunx', ['vite', 'build', '--mode', 'demo', '--outDir', SITE, '--emptyOutDir', '--logLevel', 'warn'], { cwd: REPO, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('The demo build failed.');
}

const server = Bun.serve({
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

/** Playwright WebKit's helper processes, which launchd starts, so found by path: kind → pids. */
function helperPids(): Map<number, string> {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const pids = new Map<number, string>();
  for (const line of result.stdout.split('\n')) {
    if (!line.includes('ms-playwright')) continue;
    const kind = /WebKit\.(WebContent|GPU|Networking)/.exec(line)?.[1] ?? (line.includes('Playwright.app') ? 'UI' : null);
    const pid = Number.parseInt(line.trim(), 10);
    if (kind && pid) pids.set(pid, kind);
  }
  return pids;
}

/** CPU seconds used so far by each pid. */
function cpuSeconds(pids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (!pids.length) return out;
  const result = spawnSync('ps', ['-o', 'pid=,time=', '-p', pids.join(',')], { encoding: 'utf8' });
  for (const line of result.stdout.split('\n')) {
    const [pid, time] = line.trim().split(/\s+/);
    if (!pid || !time) continue;
    // [[dd-]hh:]mm:ss.ss
    const parts = time.replace('-', ':').split(':').map(Number);
    out.set(Number(pid), parts.reduce((total, part) => total * 60 + part, 0));
  }
  return out;
}

function footprintMb(pid: number): number | null {
  const match = /Footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(spawnSync('footprint', ['-p', String(pid)], { encoding: 'utf8', timeout: 15_000 }).stdout);
  if (!match?.[1] || !match[2]) return null;
  return Math.round(Number(match[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2] as 'KB' | 'MB' | 'GB']);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

type Run = { webContent: number; gpu: number; total: number; footprintMb: number | null; commits: number };

/** React commits, counted by wrapping the devtools hook the way perf/counters.ts does, kept small on purpose. */
const countCommits = () => {
  const w = window as unknown as { __cpuCommits: number; __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
  w.__cpuCommits = 0;
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    onCommitFiberRoot: () => { w.__cpuCommits += 1; },
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
  };
};

async function measure(target: { page: string }): Promise<Run> {
  const before = new Set(helperPids().keys());
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, timezoneId: 'UTC', locale: 'en-US', serviceWorkers: 'block' });
    const page: Page = await context.newPage();
    await page.addInitScript(countCommits);
    if (UNFOCUSED) await page.addInitScript(() => { document.hasFocus = () => false; });
    await page.goto(`http://127.0.0.1:${server.port}/?size=real`, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean((window as Window & { __mockOpen?: unknown }).__mockOpen));
    await page.evaluate((name) => (window as unknown as { __mockOpen: (page: string) => Promise<void> }).__mockOpen(name), target.page);
    await page.bringToFront();
    // Let launch work and the page's first reads finish before counting.
    await page.waitForTimeout(6_000);
    const fresh = [...helperPids()].filter(([pid]) => !before.has(pid));
    const pids = fresh.map(([pid]) => pid);
    const kinds = new Map(fresh);
    await page.evaluate(() => { (window as unknown as { __cpuCommits: number }).__cpuCommits = 0; });
    const start = cpuSeconds(pids);
    const emitter = await page.evaluate((every) => window.setInterval(() => (window as Window & { __mockEmit?: (event: string) => void }).__mockEmit?.('machine-health-updated'), every), HEALTH_EVERY_MS);
    await page.waitForTimeout(SECONDS * 1_000);
    const end = cpuSeconds(pids);
    await page.evaluate((id) => window.clearInterval(id), emitter);
    const commits = await page.evaluate(() => (window as unknown as { __cpuCommits: number }).__cpuCommits);
    // A spare WebContent process WebKit started ahead of time can exit mid-run; only processes alive throughout count.
    const used = (kind: string) => pids.filter((pid) => kinds.get(pid) === kind && start.has(pid) && end.has(pid)).reduce((sum, pid) => sum + ((end.get(pid) ?? 0) - (start.get(pid) ?? 0)), 0);
    const contentPid = pids.filter((pid) => kinds.get(pid) === 'WebContent' && end.has(pid)).sort((a, b) => ((end.get(b) ?? 0) - (start.get(b) ?? 0)) - ((end.get(a) ?? 0) - (start.get(a) ?? 0)))[0];
    const webContent = used('WebContent');
    const gpu = used('GPU');
    return { webContent, gpu, total: webContent + gpu + used('UI'), footprintMb: contentPid ? footprintMb(contentPid) : null, commits };
  } finally {
    await browser.close();
  }
}

const pct = (seconds: number) => `${((seconds / SECONDS) * 100).toFixed(1)}%`;
const results: Record<string, unknown> = {};
for (const [id, target] of cases) {
  const runs: Run[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    // A WebKit launch now and then never finishes loading the page; such a run is dropped and taken again.
    const result = await Promise.race([measure(target), new Promise<null>((resolve) => setTimeout(() => resolve(null), (SECONDS + 60) * 1_000))]);
    if (!result) {
      console.log(`  ${id} #${run + 1}: timed out, again`);
      run -= 1;
      continue;
    }
    runs.push(result);
    console.log(`  ${id} #${run + 1}: WebContent ${pct(result.webContent)}, GPU ${pct(result.gpu)}, all ${pct(result.total)}, footprint ${result.footprintMb ?? '?'} MB, ${result.commits} commits`);
  }
  const summary = {
    webContentPct: Number(pct(median(runs.map((r) => r.webContent))).slice(0, -1)),
    gpuPct: Number(pct(median(runs.map((r) => r.gpu))).slice(0, -1)),
    totalPct: Number(pct(median(runs.map((r) => r.total))).slice(0, -1)),
    footprintMb: median(runs.map((r) => r.footprintMb ?? 0)),
    commitsPerMinute: Math.round(median(runs.map((r) => r.commits)) * (60 / SECONDS)),
  };
  results[id] = summary;
  console.log(`${id}: median CPU ${summary.totalPct}% (WebContent ${summary.webContentPct}%, GPU ${summary.gpuPct}%), footprint ${summary.footprintMb} MB, ${summary.commitsPerMinute} commits/min`);
}
console.log(JSON.stringify(results));
server.stop(true);
