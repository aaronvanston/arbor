// Plans a run of the Release workflow (.github/workflows/arbor-release.yml): the version it builds and the commit it
// builds it from, or why it builds nothing.
//
// A nightly is `X.Y.Z-nightly.YYYYMMDD.N`, a prerelease of the next release: the patch after the newest release, or the
// version in Cargo.toml if that's newer. It's built from main, and nothing is committed for it. On the schedule it's
// skipped until main has moved past the newest nightly or release with something besides release commits, and until
// 20 hours have passed since the newest nightly. The schedule runs once a day, so that's one nightly a day, and a
// nightly run by hand that day holds back the scheduled one (20, not 24, so the schedule's own lateness doesn't skip a day).
// A stable release promotes the newest nightly: the same commit, as X.Y.Z, so it ships only what nightly users already
// run. X.Y.Z is the nightly's own version for a patch release; ARBOR_RELEASE_BUMP=minor or major makes it the next
// minor or major after the newest release instead, for a release that adds features or breaks something, which a
// nightly can't know about when it's built. Its notes come with the run (ARBOR_RELEASE_SUMMARY, ARBOR_RELEASE_CHANGES),
// and the workflow commits them and the version to main once it's out.
//
//   ARBOR_RELEASE_CHANNEL=nightly|stable [ARBOR_RELEASE_BUMP=patch|minor|major] node scripts/release-plan.mjs
//
// reads the commit, run number, event and repository from GitHub's variables, the releases with gh (GH_TOKEN), and
// writes version, tag, prerelease and ref, or skip, to $GITHUB_OUTPUT.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isNightly, readReleaseNotes, releaseEntry, withRelease } from './release-notes.mjs';
import { parseCargoPackageVersion, validateAppVersion } from './version.mjs';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The least time between scheduled nightlies. */
export const NIGHTLY_GAP_MS = 20 * 60 * 60 * 1000;

/** The subject of the commit a stable release leaves on main; commits with only this subject don't call for a nightly. */
const RELEASE_COMMIT = /^Release Arbor \d+\.\d+\.\d+$/;

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

/**
 * The X.Y.Z a stable release promotes `nightlyVersion` as: its own X.Y.Z for a patch release, or the next minor or major
 * after `latestVersion` (the newest release, if any). Never older than the nightly, which installs already run.
 */
export function stableVersion(nightlyVersion, latestVersion, bump = 'patch') {
  const own = validateAppVersion(nightlyVersion).replace(/[-+].*$/, '');
  if (bump === 'patch') return own;
  if (bump !== 'minor' && bump !== 'major') throw new Error(`Unknown bump: ${bump}. Use patch, minor or major.`);
  const [major, minor] = parts(latestVersion ?? own).main;
  const version = bump === 'major' ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
  if (compareSemver(version, own) < 0) {
    throw new Error(`Arbor ${nightlyVersion} is already past ${version}; release it as a patch, or bump further.`);
  }
  return version;
}

function newest(releases) {
  return releases.reduce((best, release) => (!best || compareSemver(release.version, best.version) > 0 ? release : best), null);
}

/**
 * What a run builds. `releases` are the published ones, `{ version, commit, publishedAt }`, where only the newest
 * nightly's and the newest release's commit and time matter. `commit` is main's; `newCommits` are the subjects of
 * main's commits since the newest of those two was built (null when main isn't ahead of it); `bump` is a stable
 * release's patch, minor or major (patch when left out); `pending` is a stable release's notes, `{ summary, changes }`; `date` is YYYYMMDD and `now` milliseconds. Returns `{ skip }` when a
 * scheduled nightly isn't due, and throws when a stable release can't go out.
 */
export function planRelease({ channel, bump, cargoVersion, notes, releases, commit, newCommits, pending, scheduled, date, run, now }) {
  const stable = releases.filter((release) => isStable(release.version));
  const latest = newest(stable);
  const nightly = newest(releases.filter((release) => isNightly(release.version)));
  if (channel === 'stable') {
    if (!nightly) throw new Error('No nightly is out yet. A stable release promotes the newest nightly.');
    // Compared on the nightly, not the version it becomes: a minor bump would otherwise promote a nightly that's
    // already out as a release.
    if (latest && compareSemver(nightly.version.replace(/-.*$/, ''), latest.version) <= 0) {
      throw new Error(`Arbor ${latest.version} is out and no nightly has been built since. Wait for the next nightly.`);
    }
    const version = stableVersion(nightly.version, latest?.version, bump);
    if (!nightly.commit) throw new Error(`Couldn't find the commit Arbor ${nightly.version} was built from.`);
    // Refuses notes missing a summary or naming what's never published, and a version release-notes.json already has.
    withRelease(notes, releaseEntry({ version, summary: pending?.summary, changes: pending?.changes ?? [] }));
    return { version, tag: `arbor-v${version}`, prerelease: false, ref: nightly.commit, promotes: nightly.version };
  }
  if (channel !== 'nightly') throw new Error(`Unknown channel: ${channel}`);
  if (scheduled) {
    const built = [nightly, latest].find((release) => release?.commit === commit);
    if (built) return { skip: `main hasn't changed since Arbor ${built.version}` };
    if (newCommits === null) return { skip: "main isn't ahead of the newest build" };
    if (newCommits && newCommits.length > 0 && newCommits.every((subject) => RELEASE_COMMIT.test(subject))) {
      return { skip: 'main has only release commits since the newest build' };
    }
    const since = nightly?.publishedAt ? now - Date.parse(nightly.publishedAt) : Infinity;
    if (since < NIGHTLY_GAP_MS) {
      const hours = Math.ceil((NIGHTLY_GAP_MS - since) / (60 * 60 * 1000));
      return { skip: `Arbor ${nightly.version} came out less than 20 hours ago; the next nightly is due in about ${hours} h` };
    }
  }
  const [major, minor, patch] = parts(cargoVersion).main;
  const base = !latest || compareSemver(cargoVersion, latest.version) > 0
    ? `${major}.${minor}.${patch}`
    : latest.version.replace(/\d+$/, (last) => String(Number(last) + 1));
  const version = validateAppVersion(`${base}-nightly.${date}.${run}`);
  return { version, tag: `arbor-v${version}`, prerelease: true, ref: commit };
}

function gh(args) {
  const result = spawnSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gh api ${args[0]} failed: ${String(result.stderr).trim()}`);
  return String(result.stdout).trim();
}

/** Arbor's published releases on GitHub: every `arbor-v` tag with a release that isn't a draft, and when it came out. */
function publishedReleases(repository) {
  const rows = gh(['--paginate', `repos/${repository}/releases?per_page=100`, '--jq', '.[] | select(.draft | not) | [.tag_name, .published_at] | @tsv']);
  const releases = new Map();
  for (const [tag = '', publishedAt] of rows.split('\n').map((row) => row.split('\t'))) {
    if (!tag.startsWith('arbor-v')) continue;
    const version = tag.slice('arbor-v'.length);
    try {
      validateAppVersion(version);
    } catch {
      continue;
    }
    releases.set(version, { version, publishedAt: publishedAt || undefined });
  }
  return [...releases.values()];
}

/** The subjects of the commits `head` has past `base`, or null when it isn't ahead of it. */
function commitsSince(repository, base, head) {
  const compare = JSON.parse(gh([`repos/${repository}/compare/${base}...${head}`, '--jq', '{status, subjects: [.commits[].commit.message | split("\n")[0]]}']));
  return compare.status === 'ahead' ? compare.subjects : compare.status === 'identical' ? [] : null;
}

function main() {
  const env = process.env;
  const repository = env.GITHUB_REPOSITORY;
  const commit = env.GITHUB_SHA;
  if (!repository || !commit || !env.GITHUB_RUN_NUMBER) throw new Error('Run this in the Release workflow.');
  if (env.GITHUB_REF !== 'refs/heads/main') throw new Error(`Releases are built from main, not ${env.GITHUB_REF}.`);
  const channel = env.ARBOR_RELEASE_CHANNEL;
  const scheduled = env.GITHUB_EVENT_NAME === 'schedule';
  const releases = publishedReleases(repository);
  // Only the newest release's and the newest nightly's commits matter.
  const latest = newest(releases.filter((item) => isStable(item.version)));
  const nightly = newest(releases.filter((item) => isNightly(item.version)));
  for (const release of [latest, nightly]) {
    if (release) release.commit = gh([`repos/${repository}/commits/arbor-v${release.version}`, '--jq', '.sha']);
  }
  // A scheduled nightly looks at what main has gained since whichever of the two was built last.
  const lastBuilt = [latest, nightly].filter(Boolean).sort((a, b) => Date.parse(b.publishedAt ?? '') - Date.parse(a.publishedAt ?? ''))[0];
  const newCommits = scheduled && lastBuilt ? commitsSince(repository, lastBuilt.commit, commit) : undefined;
  const plan = planRelease({
    channel,
    bump: env.ARBOR_RELEASE_BUMP || 'patch',
    cargoVersion: parseCargoPackageVersion(readFileSync(join(repoDir, 'src-tauri', 'Cargo.toml'), 'utf8')),
    notes: readReleaseNotes(),
    releases,
    commit,
    newCommits,
    pending: { summary: env.ARBOR_RELEASE_SUMMARY, changes: (env.ARBOR_RELEASE_CHANGES ?? '').split('\n') },
    scheduled,
    date: new Date().toISOString().slice(0, 10).replaceAll('-', ''),
    run: env.GITHUB_RUN_NUMBER,
    now: Date.now(),
  });
  // A stable release ships a commit main already has, so its notes and version can be committed on top.
  if (!plan.skip && channel === 'stable' && commitsSince(repository, plan.ref, commit) === null) {
    throw new Error(`Arbor ${plan.promotes} was built from ${plan.ref}, which isn't on main.`);
  }
  const lines = plan.skip
    ? [`skip=${plan.skip}`]
    : [`version=${plan.version}`, `tag=${plan.tag}`, `prerelease=${plan.prerelease}`, `ref=${plan.ref}`];
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
