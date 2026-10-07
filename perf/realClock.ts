/**
 * What perf:cpu and perf:soak share: serving a built demo site, and reading Playwright WebKit's helper processes from
 * the outside (CPU time and physical footprint), which the page can't see itself.
 */
import { spawnSync } from 'node:child_process';
import { join, normalize } from 'node:path';

export const REPO = normalize(join(import.meta.dir, '..'));

export const arg = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

/** Builds the demo site into `site`, unless `--no-build` or a `--site=` of another build was given. */
export function buildDemo(site: string) {
  if (process.argv.includes('--no-build') || arg('site')) return;
  console.log(`Building the demo site into ${site}…`);
  const result = spawnSync('bunx', ['vite', 'build', '--mode', 'demo', '--outDir', site, '--emptyOutDir', '--logLevel', 'warn'], { cwd: REPO, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('The demo build failed.');
}

export function serveSite(site: string) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const path = normalize(join(site, pathname === '/' ? 'index.html' : pathname));
      if (!path.startsWith(site)) return new Response('Not found', { status: 404 });
      const file = Bun.file(path);
      return (await file.exists()) ? new Response(file) : new Response('Not found', { status: 404 });
    },
  });
}

/** Playwright WebKit's helper processes, which launchd starts, so found by path: pid → kind. */
export function helperPids(): Map<number, string> {
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

/** CPU seconds used so far by each pid still running. */
export function cpuSeconds(pids: number[]): Map<number, number> {
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

/** A process's physical footprint in MB: Activity Monitor's memory, which drops when a page lets go, unlike RSS. */
export function footprintMb(pid: number): number | null {
  const match = /Footprint:\s*([\d.]+)\s*(KB|MB|GB)/.exec(spawnSync('footprint', ['-p', String(pid)], { encoding: 'utf8', timeout: 15_000 }).stdout);
  if (!match?.[1] || !match[2]) return null;
  return Math.round(Number(match[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2] as 'KB' | 'MB' | 'GB']);
}

export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};
