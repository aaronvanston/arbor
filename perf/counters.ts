/**
 * The counters `bun run perf` puts in the page before anything else loads (Playwright's `addInitScript`). Playwright
 * sends this function's source to the page, so it can't use anything from outside its own body. Everything it counts
 * stays on `window.__arborPerf` for perf/run.ts to read; nothing here is in the app's own build.
 *
 * Call sites are kept as raw `assets/<chunk>.js:line:col` frames; perf/run.ts maps them back to source files through
 * the build's source maps, so the page doesn't have to.
 */
export function installCounters() {
  type Tally = Record<string, number>;
  type LiveTimer = { kind: 'timeout' | 'interval'; site: string; delay: number };
  type CommandTally = { calls: number; argBytes: number; replyBytes: number; failed: number };
  type Fiber = {
    tag: number;
    type: unknown;
    flags: number;
    child: Fiber | null;
    sibling: Fiber | null;
    alternate: Fiber | null;
  };

  const encoder = new TextEncoder();
  const bump = (tally: Tally, key: string, by = 1) => { tally[key] = (tally[key] ?? 0) + by; };

  /** The page's own frames of the current stack, innermost first, as `assets/x.js:line:col`, joined by `|`. */
  const site = () => {
    const frames: string[] = [];
    for (const line of (new Error().stack ?? '').split('\n')) {
      const at = line.indexOf('/assets/');
      if (at < 0) continue;
      frames.push(line.slice(at + 1));
      if (frames.length === 6) break;
    }
    return frames.join('|') || '(no app frame)';
  };

  const state = {
    timersCreated: {} as Tally,
    timersFired: {} as Tally,
    live: new Map<number, LiveTimer>(),
    rafCalls: {} as Tally,
    commands: {} as Record<string, CommandTally>,
    commits: 0,
    rendered: {} as Tally,
    componentTypes: new Map<unknown, string>(),
    componentSources: {} as Record<string, { name: string; source: string }>,
    mutations: 0,
    mutationTargets: {} as Tally,
    wrapped: false,
  };

  // Timers: the page clock's fakes are already installed (perf/run.ts installs the clock first), so these wrap them.
  const realSetTimeout = window.setTimeout;
  const realSetInterval = window.setInterval;
  const realClearTimeout = window.clearTimeout;
  const realClearInterval = window.clearInterval;
  const track = (kind: LiveTimer['kind'], handler: unknown, delay: number | undefined, rest: unknown[]) => {
    const where = site();
    bump(state.timersCreated, `${kind} ${where}`);
    let id = 0;
    const fire = function (this: unknown, ...args: unknown[]) {
      bump(state.timersFired, `${kind} ${where}`);
      if (kind === 'timeout') state.live.delete(id);
      return typeof handler === 'function' ? (handler as (...a: unknown[]) => unknown).apply(this, args) : undefined;
    };
    const start = kind === 'timeout' ? realSetTimeout : realSetInterval;
    id = (start as (handler: unknown, delay?: number, ...rest: unknown[]) => number).call(window, typeof handler === 'function' ? fire : handler, delay, ...rest);
    state.live.set(id, { kind, site: where, delay: Number(delay ?? 0) });
    return id;
  };
  window.setTimeout = ((handler: unknown, delay?: number, ...rest: unknown[]) => track('timeout', handler, delay, rest)) as typeof window.setTimeout;
  window.setInterval = ((handler: unknown, delay?: number, ...rest: unknown[]) => track('interval', handler, delay, rest)) as typeof window.setInterval;
  window.clearTimeout = ((id?: number) => { if (id !== undefined) state.live.delete(id); realClearTimeout.call(window, id); }) as typeof window.clearTimeout;
  window.clearInterval = ((id?: number) => { if (id !== undefined) state.live.delete(id); realClearInterval.call(window, id); }) as typeof window.clearInterval;

  // Frames: the page clock waits a real task after every callback it runs, about 7 ms, so a loop drawing every frame
  // makes ten minutes of idle take minutes. perf/run.ts counts frames over a short stretch, then holds them: a held
  // frame is counted but its callback never runs, so a loop stops there without anything else changing.
  const realRaf = window.requestAnimationFrame;
  const realCancelRaf = window.cancelAnimationFrame;
  let holdingFrames = false;
  let heldId = 0;
  window.requestAnimationFrame = (callback) => {
    bump(state.rafCalls, site());
    if (holdingFrames) {
      heldId -= 1;
      return heldId;
    }
    return realRaf.call(window, callback);
  };
  window.cancelAnimationFrame = (id) => { if (id > 0) realCancelRaf.call(window, id); };
  state.wrapped = true;

  // Commands: src/dev/mockTauri.ts hands this to mockCommands as its `observe` option.
  const bytes = (value: unknown) => {
    try {
      return encoder.encode(JSON.stringify(value) ?? '').length;
    } catch {
      return 0;
    }
  };
  (window as Window & { __arborPerfCommand?: unknown }).__arborPerfCommand = (
    call: { command: string; args: Record<string, unknown> }, reply: unknown, failed: boolean,
  ) => {
    const tally = (state.commands[call.command] ??= { calls: 0, argBytes: 0, replyBytes: 0, failed: 0 });
    tally.calls += 1;
    tally.argBytes += bytes(call.args);
    tally.replyBytes += failed ? 0 : bytes(reply);
    if (failed) tally.failed += 1;
  };

  // React commits, through the hook React DevTools uses, which production React calls on every commit too. Which
  // components rendered is worked out the way DevTools does: a fiber cloned in this render with PerformedWork set.
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  const PERFORMED_WORK = 1;
  const componentKey = (type: unknown) => {
    const known = state.componentTypes.get(type);
    if (known) return known;
    const inner = (type && typeof type === 'object' && ('render' in type || 'type' in type))
      ? ((type as { render?: unknown; type?: unknown }).render ?? (type as { type?: unknown }).type)
      : type;
    const fn = typeof inner === 'function' ? inner as { name?: string; displayName?: string } : null;
    const name = fn?.displayName ?? fn?.name ?? '(anonymous)';
    const key = `c${state.componentTypes.size}`;
    state.componentTypes.set(type, key);
    state.componentSources[key] = { name, source: fn ? String(fn).slice(0, 160) : '' };
    return key;
  };
  const visit = (fiber: Fiber | null) => {
    let node = fiber;
    while (node) {
      if (COMPONENT_TAGS.has(node.tag) && (!node.alternate || (node.flags & PERFORMED_WORK) === PERFORMED_WORK)) {
        bump(state.rendered, componentKey(node.type));
      }
      // A subtree React bailed out of keeps the very same child fibers; only a re-rendered one has new ones.
      if (node.child && (!node.alternate || node.child !== node.alternate.child)) visit(node.child);
      node = node.sibling;
    }
  };
  let renderers = 0;
  (window as Window & { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject() { renderers += 1; return renderers; },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_renderer: number, root: { current: Fiber }) {
      state.commits += 1;
      visit(root.current.child);
    },
  };

  // DOM mutations, named by the nearest element that says what it is.
  const describe = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return '(detached)';
    const named = element.closest('[data-slot],[aria-label],[role],[id]');
    const label = named
      ? named.getAttribute('data-slot') ?? named.getAttribute('aria-label') ?? named.getAttribute('role') ?? `#${named.id}`
      : '';
    return `${element.tagName.toLowerCase()}${label ? ` in ${named?.tagName.toLowerCase()}[${label.slice(0, 40)}]` : ''}`;
  };
  const observer = new MutationObserver((records) => {
    state.mutations += records.length;
    for (const record of records) {
      bump(state.mutationTargets, `${record.type}${record.attributeName ? `:${record.attributeName}` : ''} ${describe(record.target)}`);
    }
  });
  const observe = () => observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  if (document.documentElement) observe();
  else document.addEventListener('readystatechange', observe, { once: true });

  /** What's been counted since the last reset; perf/run.ts reads it between steps of a journey. */
  const snapshot = () => ({
    timersCreated: { ...state.timersCreated },
    timersFired: { ...state.timersFired },
    live: [...state.live.values()],
    rafCalls: { ...state.rafCalls },
    commands: JSON.parse(JSON.stringify(state.commands)) as Record<string, CommandTally>,
    commits: state.commits,
    rendered: { ...state.rendered },
    componentSources: { ...state.componentSources },
    mutations: state.mutations,
    mutationTargets: { ...state.mutationTargets },
    wrapped: state.wrapped && window.setTimeout !== realSetTimeout,
    visibility: document.visibilityState,
  });
  /** Starts a new count; live timers carry on, as they're still running. */
  const reset = () => {
    for (const tally of [state.timersCreated, state.timersFired, state.rafCalls, state.rendered, state.mutationTargets]) {
      for (const key of Object.keys(tally)) delete tally[key];
    }
    state.commands = {};
    state.commits = 0;
    state.mutations = 0;
  };
  /** A number that changes whenever React commits or the DOM changes, cheap enough to ask for between tasks. */
  const progress = () => state.commits * 1_000_003 + state.mutations;
  const holdFrames = () => { holdingFrames = true; };
  (window as Window & { __arborPerf?: unknown }).__arborPerf = { snapshot, reset, progress, holdFrames };
}

/** What `installCounters` leaves for perf/run.ts, as `snapshot()` returns it. */
export type CounterSnapshot = {
  timersCreated: Record<string, number>;
  timersFired: Record<string, number>;
  live: { kind: 'timeout' | 'interval'; site: string; delay: number }[];
  rafCalls: Record<string, number>;
  commands: Record<string, { calls: number; argBytes: number; replyBytes: number; failed: number }>;
  commits: number;
  rendered: Record<string, number>;
  componentSources: Record<string, { name: string; source: string }>;
  mutations: number;
  mutationTargets: Record<string, number>;
  wrapped: boolean;
  visibility: DocumentVisibilityState;
};
