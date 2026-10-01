// Types for cli-commands.mjs, which stays plain JavaScript so it runs without a build step.

export const CLI_COMMANDS_FILE: string;
export const LEFT_OUT: Record<string, string>;
export const NEEDS_CONFIRMATION: Set<string>;
export type CliCommand = { path: string; name: string; access: 'Read' | 'Write' | 'Confirm'; async: boolean; summary: string };
export function cliCommands(): CliCommand[];
export function renderCliCommands(): string;
