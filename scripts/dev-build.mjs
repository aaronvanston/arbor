// The dev channel's bookkeeping for scripts/dev-build.sh: a build's version, its update list and the builder's status
// file, which the app reads (src-tauri/src/dev_builds.rs). Nothing here leaves this Mac.
//
//   node scripts/dev-build.mjs version --cargo-version 1.0.26 --count 4123     prints 1.0.27-dev.4123
//   node scripts/dev-build.mjs manifest --version V --arch A --sha256 S --size N --commit C --core-version X
//        [--subjects-file F] --output O                                        writes the unsigned update list
//   node scripts/dev-build.mjs status <file> key=value ...                     merges into status.json (key= clears)
//   node scripts/dev-build.mjs get <file> key                                  prints one status value, or nothing
import { existsSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAppVersion } from './version.mjs';

const REPOSITORY = 'aaronvanston/arbor';
/** The most commit subjects a build lists, newest first; the app shows fewer. */
const MAX_SUBJECTS = 20;
/** status.json's keys, so a typo in the shell script fails instead of writing a field the app never reads. */
const STATUS_KEYS = new Set(['state', 'commit', 'step', 'startedAt', 'finishedAt', 'error', 'log', 'builtVersion', 'builtCommit', 'builtAt']);
const isCommit = (value) => /^[0-9a-f]{40}$/.test(value);

/** A dev build of main is a prerelease of the patch after the version main says it's at, numbered by main's commits. */
export function devVersion(cargoVersion, commitCount) {
  const [major, minor, patch] = validateAppVersion(cargoVersion).replace(/[-+].*$/, '').split('.').map(Number);
  const count = Number(commitCount);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Not a commit count: ${commitCount}`);
  return `${major}.${minor}.${patch + 1}-dev.${count}`;
}

/** The update list the app reads from the builder's folder: the DMG beside it by name, and the commit it's from. */
export function devManifest({ version, arch, sha256, sizeBytes, commit, coreVersion, subjects = [], publishedAt }) {
  if (!/^\d+\.\d+\.\d+-dev\.\d+$/.test(version)) throw new Error(`Not a dev version: ${version}`);
  if (arch !== 'aarch64' && arch !== 'amd64') throw new Error(`Unexpected Mac architecture: ${arch}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Not a SHA-256');
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error('Not a size');
  if (!isCommit(commit)) throw new Error(`Not a commit: ${commit}`);
  const changes = subjects.map((subject) => subject.trim()).filter((subject) => subject && !/^Release Arbor \d/.test(subject));
  return {
    schemaVersion: 1,
    version,
    publishedAt,
    releaseUrl: `https://github.com/${REPOSITORY}/commit/${commit}`,
    assets: { [`darwin-${arch}`]: { url: `Arbor-v${version}-Darwin-${arch}.dmg`, sha256, sizeBytes } },
    releases: [{ version, summary: `Main at ${commit.slice(0, 7)}.`, changes: changes.slice(0, MAX_SUBJECTS) }],
    coreVersion,
  };
}

function readStatus(file) {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** status.json with `pairs` (`key=value`, `key=` for none) merged in. */
export function mergeStatus(current, pairs) {
  const next = { ...current };
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const key = at < 0 ? pair : pair.slice(0, at);
    if (at < 0 || !STATUS_KEYS.has(key)) throw new Error(`Unexpected status field: ${pair}`);
    const value = pair.slice(at + 1);
    next[key] = value === '' ? null : value;
  }
  return next;
}

async function writeAtomically(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, file);
}

function options(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? '';
    const value = argv[index + 1];
    if (!flag.startsWith('--') || value === undefined) throw new Error(`Unexpected argument: ${flag}`);
    values[flag.slice(2)] = value;
  }
  return values;
}

function required(values, key) {
  const value = values[key];
  if (value === undefined || value === '') throw new Error(`--${key} is needed`);
  return value;
}

async function main([command, ...argv]) {
  switch (command) {
    case 'version': {
      const values = options(argv);
      console.log(devVersion(required(values, 'cargo-version'), required(values, 'count')));
      return;
    }
    case 'manifest': {
      const values = options(argv);
      const subjects = values['subjects-file'] ? readFileSync(values['subjects-file'], 'utf8').split('\n') : [];
      const manifest = devManifest({
        version: required(values, 'version'),
        arch: required(values, 'arch'),
        sha256: required(values, 'sha256'),
        sizeBytes: Number(required(values, 'size')),
        commit: required(values, 'commit'),
        coreVersion: required(values, 'core-version'),
        subjects,
        publishedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      });
      await writeAtomically(required(values, 'output'), `${JSON.stringify(manifest, null, 2)}\n`);
      return;
    }
    case 'status': {
      const [file, ...pairs] = argv;
      if (!file) throw new Error('status needs the status file');
      await writeAtomically(file, `${JSON.stringify(mergeStatus(readStatus(file), pairs), null, 2)}\n`);
      return;
    }
    case 'get': {
      const [file, key] = argv;
      if (!file || !key || !STATUS_KEYS.has(key)) throw new Error('get needs the status file and a field');
      const value = readStatus(file)[key];
      if (typeof value === 'string') console.log(value);
      return;
    }
    default:
      throw new Error('Usage: dev-build.mjs version|manifest|status|get ...');
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPoint) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
