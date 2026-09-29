// Plans a run of the Release workflow (.github/workflows/arbor-release.yml): the version it builds, or why it builds nothing.
//
// A nightly is `X.Y.Z-nightly.YYYYMMDD.N`, a prerelease of the next release: the version in Cargo.toml while that isn't
// out yet (after a `Release Arbor X.Y.Z` commit), else the patch after the newest release. Nothing is committed for it.
// A scheduled nightly is skipped when main is still where the newest nightly or release was built.
// A stable release is the version in Cargo.toml, which needs its notes in release-notes.json and has to be newer than
// every release out.
//
//   ARBOR_RELEASE_CHANNEL=nightly|stable node scripts/release-plan.mjs
//
// reads the commit, run number, event and repository from GitHub's variables, the releases with gh (GH_TOKEN), and
// writes version, tag and prerelease, or skip, to $GITHUB_OUTPUT.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readReleaseNotes, releaseEntry, releasesUpTo } from './release-notes.mjs';
import { parseCargoPackageVersion, validateAppVersion } from './version.mjs';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parts(version) {
  const [main, pre] = validateAppVersion(version).replace(/\+.*$/, '').split(/-(.*)/s);
  return { main: main.split('.').map(Number), pre: pre ? pre.split('.') : [] };
}

/** Semver order: 1.0.0-nightly.20261001.3 < 1.0.0 < 1.0.1-nightly.20261001.4. */
export function compareSemver(a, b) {
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) {
    if (left.main[index] !== right.main[index]) return Math.sign(left.main[index] - right.main[index]);
  }
  if (!left.pre.length || !right.pre.length) return Math.sign(right.pre.length - left.pre.length);
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const [x, y] = [left.pre[index], right.pre[index]];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const [xNumber, yNumber] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xNumber && yNumber && Number(x) !== Number(y)) return Math.sign(Number(x) - Number(y));
    if (xNumber !== yNumber) return xNumber ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const isStable = (version) => /^\d+\.\d+\.\d+$/.test(version);

function newest(releases) {
  return releases.reduce((best, release) => (!best || compareSemver(release.version, best.version) > 0 ? release : best), null);
}

/**
 * What a run builds. `releases` are the published ones, `{ version, commit }`, where only the newest nightly's and the
 * newest release's commits matter; `date` is YYYYMMDD. Returns `{ skip }` when a scheduled nightly has nothing new, and
 * throws when a stable release can't go out.
 */
export function planRelease({ channel, cargoVersion, notes, releases, commit, scheduled, date, run }) {
  const stable = releases.filter((release) => isStable(release.version));
  const latest = newest(stable);
  if (channel === 'stable') {
    const version = cargoVersion;
    if (!isStable(version)) throw new Error(`Cargo.toml's version, ${version}, isn't a release version.`);
    if (stable.some((release) => release.version === version)) {
      throw new Error(`Arbor ${version} is already out. Commit "Release Arbor X.Y.Z" for the next version first.`);
    }
    if (latest && compareSemver(version, latest.version) < 0) throw new Error(`Arbor ${latest.version} is out, which is newer than ${version}.`);
    releaseEntry(releasesUpTo(notes, version)[0]);
    return { version, tag: `arbor-v${version}`, prerelease: false };
  }
  if (channel !== 'nightly') throw new Error(`Unknown channel: ${channel}`);
  if (scheduled) {
    const built = [newest(releases.filter((release) => !isStable(release.version))), latest].find((release) => release?.commit === commit);
    if (built) return { skip: `main hasn't changed since Arbor ${built.version}` };
  }
  const [major, minor, patch] = parts(cargoVersion).main;
  const base = !latest || compareSemver(cargoVersion, latest.version) > 0
    ? `${major}.${minor}.${patch}`
    : latest.version.replace(/\d+$/, (last) => String(Number(last) + 1));
  const version = validateAppVersion(`${base}-nightly.${date}.${run}`);
  return { version, tag: `arbor-v${version}`, prerelease: true };
}

function gh(args) {
  const result = spawnSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gh api ${args[0]} failed: ${String(result.stderr).trim()}`);
  return String(result.stdout).trim();
}

/** Arbor's published releases on GitHub: every `arbor-v` tag with a release that isn't a draft. */
function publishedReleases(repository) {
  const tags = gh(['--paginate', `repos/${repository}/releases?per_page=100`, '--jq', '.[] | select(.draft | not) | .tag_name']);
  const versions = tags.split('\n').filter((tag) => tag.startsWith('arbor-v')).map((tag) => tag.slice('arbor-v'.length));
  return [...new Set(versions)].filter((version) => {
    try {
      return Boolean(validateAppVersion(version));
    } catch {
      return false;
    }
  });
}

function main() {
  const env = process.env;
  const repository = env.GITHUB_REPOSITORY;
  const commit = env.GITHUB_SHA;
  if (!repository || !commit || !env.GITHUB_RUN_NUMBER) throw new Error('Run this in the Release workflow.');
  if (env.GITHUB_REF !== 'refs/heads/main') throw new Error(`Releases are built from main, not ${env.GITHUB_REF}.`);
  const releases = publishedReleases(repository).map((version) => ({ version }));
  // Only these two commits decide whether a scheduled nightly has anything new.
  for (const release of [newest(releases.filter((item) => isStable(item.version))), newest(releases.filter((item) => !isStable(item.version)))]) {
    if (release) release.commit = gh([`repos/${repository}/commits/arbor-v${release.version}`, '--jq', '.sha']);
  }
  const plan = planRelease({
    channel: env.ARBOR_RELEASE_CHANNEL,
    cargoVersion: parseCargoPackageVersion(readFileSync(join(repoDir, 'src-tauri', 'Cargo.toml'), 'utf8')),
    notes: readReleaseNotes(),
    releases,
    commit,
    scheduled: env.GITHUB_EVENT_NAME === 'schedule',
    date: new Date().toISOString().slice(0, 10).replaceAll('-', ''),
    run: env.GITHUB_RUN_NUMBER,
  });
  const lines = plan.skip
    ? [`skip=${plan.skip}`]
    : [`version=${plan.version}`, `tag=${plan.tag}`, `prerelease=${plan.prerelease}`];
  console.log(lines.join('\n'));
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPoint) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
