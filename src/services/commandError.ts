/**
 * What a command said went wrong. The commands whose callers act on the failure (the core's management API,
 * installing a core) answer with its kind, and the core's status and own words when it answered; the rest answer
 * with a sentence, which reads here as `failed`. Deciding from these fields rather than the sentence means the
 * native side can reword it without anything here breaking. The type comes from `src-tauri/src/command_error.rs`.
 */
import type { CommandError, CommandErrorKind } from '../native/types';

const KINDS: readonly CommandErrorKind[] = ['failed', 'canceled', 'core'];
const isKind = (value: string): value is CommandErrorKind => (KINDS as readonly string[]).includes(value);

/** A command's failure as an Error, so code that shows `String(error)` or `error.message` shows the same sentence. */
export class CommandFailure extends Error {
  constructor(readonly failure: CommandError) {
    super(failure.message);
    this.name = 'CommandFailure';
  }

  override toString(): string {
    return this.message;
  }
}

/** Whatever a command rejected with, as a failure: its fields when it gave them, its sentence otherwise. */
export function readCommandError(reason: unknown): CommandError {
  if (reason instanceof CommandFailure) return reason.failure;
  if (typeof reason === 'object' && reason !== null && !(reason instanceof Error)) {
    const { kind, status, reason: words, message } = reason as Record<string, unknown>;
    if (typeof kind === 'string' && typeof message === 'string') {
      return {
        kind: isKind(kind) ? kind : 'failed',
        ...(typeof status === 'number' ? { status } : {}),
        ...(typeof words === 'string' ? { reason: words } : {}),
        message,
      };
    }
  }
  return { kind: 'failed', message: reason instanceof Error ? reason.message : String(reason) };
}
