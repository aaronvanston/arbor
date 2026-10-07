import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every way the window changes a machine to match the setup repo goes through `services/applyEngine.ts`, which makes
 * the change through its guarded command and has the standing read again. A file that called one of those commands
 * itself would skip that, so only the engine (and the services that define them, and skill runs, the engine's own skill
 * step) may name them.
 */
const RAW = ['applySetupSync', 'applyHooks', 'applyMcpChanges', 'applyPluginChanges', 'applyCodexPluginChanges', 'runSkillPlan'];
const ALLOWED = new Set([
  'src/services/applyEngine.ts',
  'src/services/setupSync.ts',
  'src/services/setupHooks.ts',
  'src/services/setupMcp.ts',
  'src/services/setupPlugins.ts',
  'src/services/skillRuns.ts',
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'dev' ? [] : files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('one way to apply', () => {
  it('leaves the guarded apply commands to the engine', () => {
    const offenders = files('src').filter((path) => !ALLOWED.has(path)).flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return RAW.filter((name) => new RegExp(`\\b${name}\\(`).test(text) || new RegExp(`import[^;]*\\b${name}\\b[^;]*from`).test(text)).map((name) => `${path}: ${name}`);
    });
    expect(offenders).toEqual([]);
  });
});
