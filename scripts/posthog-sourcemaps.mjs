// After a release build: gives each bundle file a chunk id, sends the source maps to Arbor's PostHog project so crash
// reports read as the source, and removes the maps from dist so they're never shipped inside the app.
//
// Uploading needs a personal API key with error tracking write and organization read, as POSTHOG_CLI_API_KEY in .env
// (bun loads it), with POSTHOG_CLI_PROJECT_ID. Without one the maps are only removed, and crash reports stay minified.
import { spawnSync } from 'node:child_process';
import { readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCargoPackageVersion } from './version.mjs';

const CLI = '@posthog/cli@0.18.7';
const PROJECT_ID = '632085';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

async function mapFiles(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.map')).map((entry) => join(entry.parentPath, entry.name));
}

function cli(args, env) {
  const result = spawnSync('bunx', [CLI, ...args], { cwd: root, stdio: 'inherit', env });
  if (result.status !== 0) throw new Error(`posthog-cli ${args.slice(0, 2).join(' ')} failed`);
}

const key = process.env.POSTHOG_CLI_API_KEY;
if (key) {
  const version = parseCargoPackageVersion(await readFile(join(root, 'src-tauri', 'Cargo.toml'), 'utf8'));
  const project = process.env.POSTHOG_CLI_PROJECT_ID || PROJECT_ID;
  const env = { ...process.env, POSTHOG_CLI_API_KEY: key, POSTHOG_CLI_PROJECT_ID: project };
  // The release goes with the uploaded maps rather than on each exception, which Arbor sends without PostHog's SDK.
  const release = ['--release-name', 'arbor', '--release-version', version, '--release-mode', 'symbol-set'];
  cli(['sourcemap', 'inject', '--directory', dist, ...release], env);
  cli(['sourcemap', 'upload', '--directory', dist, ...release], env);
  console.log(`Sent Arbor ${version}'s source maps to PostHog`);
} else {
  console.warn('POSTHOG_CLI_API_KEY isn\'t set, so source maps weren\'t sent to PostHog; crash reports from this build stay minified.');
}

const maps = await mapFiles(dist);
await Promise.all(maps.map((file) => rm(file)));
if ((await mapFiles(dist)).length) throw new Error('Source maps are still in dist');
