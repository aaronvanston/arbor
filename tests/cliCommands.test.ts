import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { britishSpellings } from '../scripts/us-spelling.mjs';
import { CLI_COMMANDS_FILE, cliCommands, LEFT_OUT, NEEDS_CONFIRMATION, renderCliCommands } from '../scripts/cli-commands.mjs';

const root = new URL('..', import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** The commands main.rs registers, by name. */
const registered = () =>
  (read('src-tauri/src/main.rs').match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? '')
    .split(',')
    .map((entry) => entry.trim().split('::').pop() ?? '')
    .filter(Boolean);

describe('the command line’s command table', () => {
  test('is up to date with the commands the app registers (bun run cli-commands rewrites it)', () => {
    expect(read(CLI_COMMANDS_FILE)).toBe(renderCliCommands());
  });

  test('has every registered command, or says why it is left out', () => {
    const inTable = new Set(cliCommands().map((command) => command.name));
    for (const name of registered()) expect(inTable.has(name) || name in LEFT_OUT).toBe(true);
    for (const name of Object.keys(LEFT_OUT)) {
      expect(registered()).toContain(name);
      expect(inTable.has(name)).toBe(false);
    }
  });

  test('asks first for exactly the changes listed, and never offers a reset, a claim or a passthrough', () => {
    const table = cliCommands();
    for (const name of NEEDS_CONFIRMATION) expect(table.find((command) => command.name === name)?.access).toBe('Confirm');
    for (const command of table) expect(command.name).not.toMatch(/management_request|reset_quota|redeem|claim|banked|secret$/);
    expect(LEFT_OUT).toHaveProperty('management_request');
  });

  test('only looks for commands named as reads', () => {
    for (const command of cliCommands().filter((entry) => entry.access === 'Read')) {
      expect(command.name).toMatch(/^(?:get_|read_|list_|check_|preview_|measure_|discover_|confirm_core_settings$|system_locale$)/);
    }
    expect(cliCommands().find((command) => command.name === 'saved_store_set')?.access).toBe('Write');
  });
});

describe('what arbor prints', () => {
  test('is US English, like the rest of Arbor', () => {
    const dir = 'src-tauri/src/cli';
    for (const file of readdirSync(join(root, dir))) {
      expect({ file, british: britishSpellings(read(join(dir, file))) }).toEqual({ file, british: [] });
    }
  });
});
