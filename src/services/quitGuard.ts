/** Sent by the native shell when it holds back a first ⌘Q because quitting would stop the proxy. */
export const QUIT_GUARD_ARMED_EVENT = 'quit-guard-armed';
/** How long a second ⌘Q quits for, as the native shell has it: long enough to read the warning and press again. */
export const QUIT_GUARD_WINDOW_MS = 3_000;
const LONGEST_WARNING_MS = 10_000;
/**
 * The warning goes this much before the window ends. The window starts before the warning reaches the page, and
 * the warning takes a moment to fade, so this way a press while it's on screen always quits.
 */
const WARNING_EARLY_MS = 300;

/** How long to show the warning: the window the shell sent, or the usual one when it's missing or odd, less a little. */
export function quitWarningMs(payload: unknown): number {
  const sent = typeof payload === 'object' && payload !== null ? (payload as { windowMs?: unknown }).windowMs : undefined;
  const windowMs = typeof sent === 'number' && Number.isFinite(sent) && sent > 0 ? Math.min(sent, LONGEST_WARNING_MS) : QUIT_GUARD_WINDOW_MS;
  return Math.max(windowMs - WARNING_EARLY_MS, windowMs / 2);
}

/** Only macOS has the guard: elsewhere ⌘Q isn't how the app quits. */
export function quitGuardSupported(userAgent: string): boolean {
  return /Macintosh|Mac OS X/.test(userAgent);
}

export type QuitPress = { action: 'quit' | 'warn'; armedAt: number | null };

/**
 * What a ⌘Q at `now` does, by the native shell's rule (src-tauri/src/quit_guard.rs). Kept here so the
 * browser preview behaves the same.
 */
export function pressQuit(armedAt: number | null, now: number, enabled: boolean, coreRunning: boolean): QuitPress {
  if (!enabled) return { action: 'quit', armedAt: null };
  if (armedAt !== null && now - armedAt >= 0 && now - armedAt <= QUIT_GUARD_WINDOW_MS) return { action: 'quit', armedAt: null };
  if (!coreRunning) return { action: 'quit', armedAt: null };
  return { action: 'warn', armedAt: now };
}
