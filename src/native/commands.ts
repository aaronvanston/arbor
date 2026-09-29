import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import type { AppCommands } from './app';
import type { ArchiveCommands } from './archive';
import type { CoreCommands } from './core';
import type { MachineCommands } from './machines';
import type { SetupCommands } from './setup';
import type { UsageCommands } from './usage';

/**
 * Every command the native side answers, by domain, each with the arguments it takes (when it takes any) and what it
 * returns. The entries are written from the Rust signatures, and `tests/commandParity.test.ts` checks each one
 * against them. The types they use come from Rust as well: `./types.ts`, written by `bun run bindings`.
 */
export type Commands = AppCommands & CoreCommands & UsageCommands & MachineCommands & SetupCommands & ArchiveCommands;

export type CommandName = keyof Commands;
export type CommandResult<K extends CommandName> = Commands[K]['result'];
type CommandArgs<K extends CommandName> = Commands[K] extends { args: infer Args } ? [args: Args] : [];

/** Runs a native command. The webview calls commands only through this, so every call is checked against the list. */
export function invokeCommand<K extends CommandName>(command: K, ...[args]: CommandArgs<K>): Promise<CommandResult<K>> {
  return invoke<CommandResult<K>>(command, args as InvokeArgs | undefined);
}
