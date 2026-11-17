/**
 * The browser mock's Compute data, apart from its answers (./compute.ts) and free of the window, so tests can build
 * every scenario. Made-up names and ids only. Each scenario is a snapshot at `now`; "Typical afternoon" is the approved
 * prototype's (.scratch/remote-compute/prototype.html): cam-mbp, cedar-02 and ci-01 running six sandboxes, plan hours
 * 343 of 555.
 */
import type { ComputeLimit, ComputePoint, ComputeProviderSnapshot, ComputeSandbox, ComputeSession, ComputeSnapshot, Harness } from '../../native/types';

/**
 * The `?compute=` scenarios. `none` (no provider connected) is the default, which keeps the perf gate's launch flat.
 * Like Boat, every scenario's provider says neither what the key can do nor when it expires, except `readonlykey` and
 * `writekey`, a provider that does.
 */
export type ComputeScenario = 'none' | 'typical' | 'near' | 'blocked' | 'unreachable' | 'unlinked' | 'empty' | 'refused' | 'limits' | 'readonlykey' | 'writekey' | 'trouble' | 'paid' | 'big' | 'partial' | 'noload';
export const COMPUTE_SCENARIOS: readonly ComputeScenario[] = ['none', 'typical', 'near', 'blocked', 'unreachable', 'unlinked', 'empty', 'refused', 'limits', 'readonlykey', 'writekey', 'trouble', 'paid', 'big', 'partial', 'noload'];

export const isComputeScenario = (value: string | null): value is ComputeScenario => COMPUTE_SCENARIOS.includes(value as ComputeScenario);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Boat's sizes as the prototype has them: vCPUs, memory and plan hours per hour running. */
const SIZES = {
  small: { vcpus: 2, memoryGb: 4, multiplier: 0.5 },
  default: { vcpus: 4, memoryGb: 8, multiplier: 1 },
  large: { vcpus: 8, memoryGb: 16, multiplier: 2 },
} as const;
type Size = keyof typeof SIZES;

/** The same numbers on every load for the same sandbox: a small seeded generator, as the prototype's. */
function seeded(seed: string) {
  let a = [...seed].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) | 0, 7);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let value = Math.imul(a ^ (a >>> 15), 1 | a);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/**
 * `count` readings a minute apart ending now at `cpu` and `memory`, wandering toward them, oldest first. With `gap`,
 * the readings in that range of minutes ago are missing, as when Arbor wasn't running.
 */
export function mockPoints(id: string, cpu: number, memory: number, now: number, count: number, gap?: { fromMin: number; toMin: number }): ComputePoint[] {
  // On the minute, as a ring read once a minute is: the snapshot's latest points and the full history, asked for at
  // different moments, then share their times, so the page's merge of the two doesn't draw both.
  const lastMs = Math.floor(now / MINUTE) * MINUTE;
  const random = seeded(id);
  let c = cpu * (0.6 + random() * 0.3);
  let m = memory * (0.7 + random() * 0.2);
  const points: ComputePoint[] = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    c = clamp(c + (cpu - c) * 0.22 + (random() - 0.5) * Math.max(0.04, cpu * 0.18));
    m = clamp(m + (memory - m) * 0.2 + (random() - 0.5) * 0.03);
    if (gap && index >= gap.toMin && index <= gap.fromMin) continue;
    points.push({ atMs: lastMs - index * MINUTE, cpu: index === 0 ? cpu : c, memory: index === 0 ? memory : m });
  }
  return points;
}

const session = (id: string, harness: Harness, live: boolean, endedAtMs: number | null = null): ComputeSession =>
  ({ id, known: true, live, endedAtMs: live ? null : endedAtMs, harness });

type SandboxSeed = {
  id: string;
  name: string;
  size: Size;
  cpu: number | null;
  memory: number | null;
  ageMin: number;
  stopsInMin: number | null;
  /** The auto-stop it was started with, when it has been put off since; else it's when it stops, from creation. */
  autoStopMin?: number;
  monthHours: number;
  /** What it cost this month past what the plan's hours cover; $0 when they cover it. */
  monthDollars?: number;
  machine: string | null;
  session: ComputeSession | null;
  state?: ComputeSandbox['state'];
  issue?: ComputeSandbox['issue'];
  issueMin?: number;
  forgotten?: ComputeSandbox['forgotten'];
  mine?: boolean;
};

function sandbox(seed: SandboxSeed, now: number): ComputeSandbox {
  const size = SIZES[seed.size];
  const state = seed.state ?? 'running';
  // As Rust's `load_shown`: only a running sandbox has a reading; one starting isn't read yet, and one stopping, stopped
  // or in error has none to give.
  const read = seed.cpu !== null && seed.memory !== null && state === 'running';
  const mine = seed.mine ?? true;
  return {
    id: seed.id,
    name: seed.name,
    size: seed.size,
    vcpus: size.vcpus,
    memoryGb: size.memoryGb,
    multiplier: size.multiplier,
    state,
    issue: seed.issue ?? null,
    issueSinceMs: seed.issue ? now - (seed.issueMin ?? 0) * MINUTE : null,
    createdAtMs: now - seed.ageMin * MINUTE,
    // None of these was resumed, so each run began when it was made.
    startedAtMs: now - seed.ageMin * MINUTE,
    stopsAtMs: seed.stopsInMin === null || state === 'stopped' ? null : now + seed.stopsInMin * MINUTE,
    autoStopSeconds: seed.stopsInMin === null ? null : (seed.autoStopMin ?? seed.ageMin + seed.stopsInMin) * 60,
    monthHours: seed.monthHours,
    monthDollars: seed.monthDollars ?? 0,
    mine,
    load: read && seed.cpu !== null && seed.memory !== null ? { kind: 'read', cpu: seed.cpu, memory: seed.memory, atMs: now - 20_000 }
      : state === 'running' || state === 'starting' ? { kind: 'notReadYet' } : { kind: 'unavailable' },
    points: read && seed.cpu !== null && seed.memory !== null ? mockPoints(seed.id, seed.cpu, seed.memory, now, Math.min(30, seed.ageMin + 1)) : [],
    machine: mine ? seed.machine : null,
    session: mine ? seed.session : null,
    linkedBy: mine && (seed.machine || seed.session) ? 'link' : null,
    linkProblem: mine && !seed.machine ? 'notLinked' : null,
    forgotten: mine && state !== 'stopped' ? seed.forgotten ?? null : null,
  };
}

/** The prototype's six sandboxes. */
const TYPICAL: SandboxSeed[] = [
  { id: 'bx_4k2m9xqa', name: 'cam-mbp-fix-login', size: 'large', cpu: 0.99, memory: 0.61, ageMin: 72, stopsInMin: 168, monthHours: 2.4, machine: 'cam-mbp', session: session('3f2a91c4-7b1e-4c2d-9a10-5e6f7a8b9c01', 'claude', true) },
  { id: 'bx_p7d3w1nc', name: 'cedar-02-ci-matrix', size: 'large', cpu: 0.78, memory: 0.4, ageMin: 185, stopsInMin: 55, monthHours: 6.2, machine: 'cedar-02', session: session('8b07e2d1-2c3d-4e5f-8a9b-0c1d2e3f4a5b', 'codex', true) },
  { id: 'bx_t9v6h2rk', name: 'ci-01-perf', size: 'large', cpu: 0.03, memory: 0.09, ageMin: 220, stopsInMin: null, monthHours: 7.3, machine: 'ci-01', session: null, forgotten: 'sessionEnded' },
  { id: 'bx_e5y8b4mz', name: 'cam-mbp-docs', size: 'default', cpu: 0.12, memory: 0.22, ageMin: 30, stopsInMin: 210, monthHours: 0.5, machine: null, session: null },
  { id: 'bx_r1q7j3fd', name: 'cedar-02-e2e', size: 'large', state: 'starting', cpu: null, memory: null, ageMin: 1, stopsInMin: 239, monthHours: 0, machine: 'cedar-02', session: session('5e19b3aa-6f70-4a81-b2c3-d4e5f6a7b8c9', 'claude', true) },
  { id: 'bx_n3c2x8ws', name: 'ci-01-build', size: 'small', cpu: 0.55, memory: 0.88, ageMin: 140, stopsInMin: 100, monthHours: 1.2, machine: 'ci-01', session: session('77ad20c9-1a2b-4c3d-8e4f-5a6b7c8d9e0f', 'codex', true), issue: 'diskPressure', issueMin: 7 },
];

function typicalSeeds(now: number): SandboxSeed[] {
  // ci-01-perf's session ended 41 minutes ago, so it looks forgotten.
  return TYPICAL.map((seed) => (seed.id === 'bx_t9v6h2rk' ? { ...seed, session: session('c41d0a77-3e4f-4a5b-9c6d-7e8f9a0b1c2d', 'claude', false, now - 41 * MINUTE) } : seed));
}

/** The next midnight UTC, when Boat's daily starts reset. */
const nextUtcMidnight = (now: number) => {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
};

type Hours = { used: number; max: number };

type ProviderOptions = Partial<ComputeProviderSnapshot> & { hours?: Hours | null; starts?: [number, number, number]; extraSpend?: Hours };

function provider(now: number, sandboxes: ComputeSandbox[], over: ProviderOptions = {}): ComputeProviderSnapshot {
  const { hours = { used: 343, max: 555 }, starts = [1, 9, 71], extraSpend, ...rest } = over;
  // The period ends at a fixed time, as a provider's does, not a moment that moves on with each round.
  const periodEndMs = Math.floor(now / DAY) * DAY + 29 * DAY;
  const active = sandboxes.filter((entry) => entry.state !== 'stopped');
  // Only running sandboxes use plan hours, as Rust counts them (compute.rs `burn`); the active limit counts the rest too.
  const perHour = sandboxes.filter((entry) => entry.state === 'running').reduce((sum, entry) => sum + (entry.multiplier ?? 0), 0);
  const left = hours ? Math.max(0, hours.max - hours.used) : 0;
  const limits: ComputeLimit[] = [
    { kind: 'activeSandboxes', used: active.length, max: 100, resetsAtMs: null },
    { kind: 'startsPerMinute', used: starts[0], max: 12, resetsAtMs: now + 40_000 },
    { kind: 'startsPerHour', used: starts[1], max: 60, resetsAtMs: now + 8 * MINUTE },
    { kind: 'startsPerDay', used: starts[2], max: 200, resetsAtMs: nextUtcMidnight(now) },
    ...(hours ? [{ kind: 'planHours' as const, used: hours.used, max: hours.max, resetsAtMs: periodEndMs }] : []),
    ...(extraSpend ? [{ kind: 'extraSpend' as const, used: extraSpend.used, max: extraSpend.max, resetsAtMs: periodEndMs }] : []),
  ];
  return {
    id: 'boat',
    status: 'ok',
    keyAccess: 'unknown',
    keyExpiresAtMs: null,
    checkedAtMs: now - 12_000,
    capabilities: { limits: true, load: true, cost: true, autoStop: true },
    limits,
    canStart: true,
    startBlock: null,
    planHoursPerHour: perHour,
    runOutAtMs: hours && perHour > 0 ? now + (left / perHour) * HOUR : null,
    periodEndMs,
    listPartial: false,
    sandboxes,
    ...rest,
  };
}

const MACHINES = ['cam-mbp', 'cedar-02', 'ci-01'] as const;
const HARNESSES: readonly Harness[] = ['claude', 'codex'];

/** A hundred sandboxes, for a page that's slow with many: most linked, some not, a few teammates'. */
function bigSandboxes(now: number): ComputeSandbox[] {
  const random = seeded('big');
  const sizes: Size[] = ['small', 'default', 'large'];
  return Array.from({ length: 100 }, (_, index) => {
    const machine = MACHINES[index % MACHINES.length] ?? 'cam-mbp';
    const size = sizes[Math.floor(random() * sizes.length)] ?? 'default';
    const teammate = index % 17 === 0;
    const linked = index % 9 !== 0;
    const ageMin = 5 + Math.floor(random() * 300);
    const hex = (index * 2654435761 >>> 0).toString(16).padStart(8, '0');
    return sandbox({
      id: `bx_${hex}`,
      name: teammate ? `team-runner-${index}` : `${machine}-task-${index}`,
      size,
      cpu: Math.round(random() * 100) / 100,
      memory: Math.round(random() * 100) / 100,
      ageMin,
      stopsInMin: index % 11 === 0 ? null : Math.max(5, 240 - ageMin),
      monthHours: Math.round(random() * 80) / 10,
      machine: linked ? machine : null,
      session: linked ? session(`${hex}-0000-4000-8000-${hex}0000`, HARNESSES[index % 2] ?? 'claude', index % 5 !== 0, now - 50 * MINUTE) : null,
      mine: !teammate,
      forgotten: index % 11 === 0 && ageMin > 180 ? 'noAutoStop' : null,
    }, now);
  }).map((entry, index) => readingEdges(entry, index));
}

/**
 * The states a long list also has to draw: a sandbox with monitoring off, one with no reading, one linked to a
 * machine Arbor doesn't know, and one whose session Arbor hasn't seen.
 */
function readingEdges(entry: ComputeSandbox, index: number): ComputeSandbox {
  if (index % 23 === 4) return { ...entry, load: { kind: 'monitoringOff' }, points: [] };
  if (index % 29 === 5) return { ...entry, load: { kind: 'unavailable' }, points: [] };
  if (entry.mine && index % 31 === 7) return { ...entry, machine: null, session: null, linkProblem: 'unknownMachine', forgotten: null };
  if (entry.mine && entry.session && index % 37 === 8) return { ...entry, session: { ...entry.session, known: false, live: false, endedAtMs: null, harness: null } };
  return entry;
}

/** Sandboxes stopped earlier this month, for the scenario with nothing running. */
const STOPPED: SandboxSeed[] = [
  { id: 'bx_s1a2b3c4', name: 'cam-mbp-refactor', size: 'large', state: 'stopped', cpu: null, memory: null, ageMin: 600, stopsInMin: null, monthHours: 9.6, machine: 'cam-mbp', session: null },
  { id: 'bx_s5d6e7f8', name: 'ci-01-nightly', size: 'default', state: 'stopped', cpu: null, memory: null, ageMin: 1_400, stopsInMin: null, monthHours: 4, machine: 'ci-01', session: null },
  { id: 'bx_s9g0h1i2', name: 'cedar-02-bisect', size: 'small', state: 'stopped', cpu: null, memory: null, ageMin: 2_000, stopsInMin: null, monthHours: 1.5, machine: 'cedar-02', session: null },
];

/** A scenario's snapshot at `now`. */
export function computeScenarioSnapshot(scenario: ComputeScenario, now: number): ComputeSnapshot {
  const typical = () => typicalSeeds(now).map((seed) => sandbox(seed, now));
  switch (scenario) {
    case 'none': return { providers: [] };
    case 'typical': return { providers: [provider(now, typical())] };
    case 'near': return { providers: [provider(now, typical(), { hours: { used: 551, max: 555 }, starts: [10, 58, 192] })] };
    case 'blocked': {
      const sandboxes = typical();
      return { providers: [provider(now, sandboxes, { hours: { used: 555, max: 555 }, canStart: false, startBlock: 'planHoursGone' })] };
    }
    case 'unreachable': return { providers: [provider(now, typical(), { status: 'unreachable', checkedAtMs: now - 14 * MINUTE })] };
    case 'unlinked': {
      const seeds = typicalSeeds(now).map((seed): SandboxSeed => ({ ...seed, machine: null, session: null, forgotten: seed.stopsInMin === null ? 'noAutoStop' : null }));
      return { providers: [provider(now, seeds.map((seed) => sandbox(seed, now)))] };
    }
    case 'empty': return { providers: [provider(now, STOPPED.map((seed) => sandbox(seed, now)))] };
    case 'refused': return { providers: [provider(now, typical(), { status: 'refused', checkedAtMs: now - 20 * MINUTE })] };
    case 'limits': {
      const sandboxes = typical();
      return { providers: [provider(now, sandboxes, { status: 'limitsNeedScope', limits: [], canStart: null, runOutAtMs: null, periodEndMs: null })] };
    }
    // A provider that says what the key can do and when it expires: a read-only key with five days left, so the
    // badge, the expiry and the week-ahead alert show; and one that can also write.
    case 'readonlykey': return { providers: [provider(now, typical(), { keyAccess: 'readOnly', keyExpiresAtMs: now + 5 * DAY })] };
    case 'writekey': return { providers: [provider(now, typical(), { keyAccess: 'canWrite', keyExpiresAtMs: now + 300 * DAY })] };
    case 'trouble': {
      // Asked too often, with one sandbox in error, one stopping and one kept alive past twice its auto-stop.
      const seeds = typicalSeeds(now).map((seed): SandboxSeed => {
        if (seed.id === 'bx_e5y8b4mz') return { ...seed, state: 'error' };
        if (seed.id === 'bx_p7d3w1nc') return { ...seed, state: 'stopping' };
        if (seed.id === 'bx_4k2m9xqa') return { ...seed, ageMin: 520, stopsInMin: 20, autoStopMin: 240, forgotten: 'keptAlive' };
        return seed;
      });
      return { providers: [provider(now, seeds.map((seed) => sandbox(seed, now)), { status: 'rateLimited', checkedAtMs: now - 3 * MINUTE })] };
    }
    case 'paid': {
      // Past the plan's hours, so sandboxes cost dollars and the extra spend counts toward its cap.
      const seeds = typicalSeeds(now).map((seed): SandboxSeed => ({ ...seed, monthDollars: Math.round(seed.monthHours * 0.12 * 100) / 100 }));
      return { providers: [provider(now, seeds.map((seed) => sandbox(seed, now)), { hours: { used: 555, max: 555 }, extraSpend: { used: 12.5, max: 50 } })] };
    }
    // More sandboxes listed than Arbor reads pages of, so the list stopped short.
    case 'partial': return { providers: [provider(now, typical(), { listPartial: true })] };
    // A key that can list sandboxes but that the provider won't give their load to, as Boat's read-only key is.
    case 'noload': {
      const sandboxes = typical().map((entry): ComputeSandbox => (entry.state === 'running' ? { ...entry, load: { kind: 'keyCantRead' }, points: [] } : entry));
      return { providers: [provider(now, sandboxes)] };
    }
    case 'big': {
      const sandboxes = bigSandboxes(now);
      return { providers: [provider(now, sandboxes, { hours: { used: 2_180, max: 5_000 }, starts: [6, 48, 160] })] };
    }
  }
}

/**
 * A sandbox's full ring, as `get_compute_sandbox_history` answers: a reading a minute for up to two hours (as long as
 * it has run since it last started), with a gap from 70 to 60 minutes ago where Arbor wasn't reading. None before it's been read.
 */
export function mockHistory(sandbox: ComputeSandbox, now: number): ComputePoint[] {
  if (sandbox.load.kind !== 'read') return [];
  const minutes = Math.min(120, Math.floor((now - sandbox.startedAtMs) / MINUTE) + 1);
  return mockPoints(sandbox.id, sandbox.load.cpu, sandbox.load.memory, now, minutes, { fromMin: 70, toMin: 60 });
}
