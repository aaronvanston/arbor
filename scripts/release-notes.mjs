// Arbor's public release notes. They're written for each release, at a feature level, and kept in release-notes.json:
// a summary and at most a few high-level changes, never commit subjects. Everything public reads them from there: the
// GitHub release's body, the update list the app reads for its update card (publish-github-release.sh), and the local
// feed for apps from before the GitHub feed (publish-local-update.sh). Each is checked for what must never be published:
// other apps' names, machines, people, emails, paths, addresses and usage figures, and for British spelling.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { britishSpellings } from './us-spelling.mjs';
import { validateAppVersion } from './version.mjs';

export const RELEASE_LIMITS = { versions: 30, changes: 3, changeLength: 120, summaryLength: 200 };
export const LOCAL_FEED_ORIGIN = 'http://127.0.0.1:8321';
export const GITHUB_REPOSITORY = 'aaronvanston/arbor';
export const RELEASE_NOTES_FILE = 'release-notes.json';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// What public notes never say. Private machine, account and people's names are listed one a line in
// ~/.config/arbor/release-deny.txt (or the file ARBOR_DENY_LIST names), which is read too when it's there.
const PUBLIC_TEXT_RULES = [
  ['another app', /\bT3(?: Code)?\b|\bOrca\b|\bAntiburn\b|\bCodexBar\b|\bPostHog\b/i],
  ['an email address', /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/i],
  ['a path', /\/Users\/|\/Volumes\/|~\/|Application Support/],
  ['an address', /\b[\w-]+\.ts\.net\b|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\blocalhost\b|:\d{4,5}\b/i],
  ['a link', /https?:\/\//i],
  ['a screen path', /›/],
  ['a usage figure', /\d[\d,.]*\s*[KMB]?\s+(?:tokens|sessions|requests|transcripts)\b/i],
];

function privateWords() {
  const file = process.env.ARBOR_DENY_LIST || join(homedir(), '.config/arbor/release-deny.txt');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').map((line) => line.replace(/#.*/, '').trim()).filter(Boolean);
}

/** Why `text` can't be published, or [] when it can. */
export function publicTextProblems(text, words = privateWords()) {
  const problems = PUBLIC_TEXT_RULES.filter(([, pattern]) => pattern.test(text)).map(([what]) => `names ${what}`);
  const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (words.some((word) => new RegExp(`(?<![\\w-])${escape(word)}(?![\\w-])`, 'i').test(text))) problems.push('names something on the private list');
  const british = britishSpellings(text);
  if (british.length) problems.push(`spells ${british.join(', ')} the British way`);
  return problems;
}

/**
 * A release's notes, checked: a summary of what it adds or changes, and at most RELEASE_LIMITS.changes high-level
 * changes. Throws with every problem at once.
 */
export function releaseEntry({ version, summary, changes = [] }, words) {
  const entry = {
    version: validateAppVersion(version),
    summary: String(summary ?? '').replace(/\s+/g, ' ').trim(),
    changes: changes.map((change) => String(change).replace(/\s+/g, ' ').trim()).filter(Boolean),
  };
  const problems = [];
  if (!entry.summary) problems.push('it needs a summary (ARBOR_RELEASE_SUMMARY): what the release adds or changes, at a feature level');
  if (entry.summary.length > RELEASE_LIMITS.summaryLength) problems.push(`the summary is over ${RELEASE_LIMITS.summaryLength} characters`);
  if (entry.changes.length > RELEASE_LIMITS.changes) problems.push(`it has more than ${RELEASE_LIMITS.changes} changes`);
  for (const change of entry.changes) {
    if (change.length > RELEASE_LIMITS.changeLength) problems.push(`"${change.slice(0, 40)}…" is over ${RELEASE_LIMITS.changeLength} characters`);
  }
  for (const text of [entry.summary, ...entry.changes]) {
    for (const problem of publicTextProblems(text, words)) problems.push(`"${text.slice(0, 60)}" ${problem}`);
  }
  if (problems.length) throw new Error(`Arbor ${entry.version}'s release notes can't be published: ${problems.join('; ')}.`);
  return entry;
}

/** The release notes in a release-notes.json's text, newest first. */
export function parseReleaseNotes(text) {
  const releases = JSON.parse(text);
  if (!Array.isArray(releases)) throw new Error(`${RELEASE_NOTES_FILE} must be a list of releases`);
  for (const release of releases) {
    validateAppVersion(release?.version);
    if (typeof release.summary !== 'string' || !Array.isArray(release.changes)) {
      throw new Error(`${RELEASE_NOTES_FILE}: ${release.version} needs a summary and changes`);
    }
  }
  return releases;
}

function versionParts(version) {
  return version.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** `releases` with `entry` added at the top; it must be newer than every release there. */
export function withRelease(releases, entry) {
  const newest = releases[0];
  if (newest && compareVersions(entry.version, newest.version) <= 0) {
    throw new Error(`Arbor ${newest.version} is already released; publish a newer version than ${entry.version}`);
  }
  return [entry, ...releases];
}

/** The notes the app shows for `version`: that release and the ones before it, up to RELEASE_LIMITS.versions. */
export function releasesUpTo(releases, version) {
  const at = releases.findIndex((release) => release.version === version);
  if (at < 0) throw new Error(`${RELEASE_NOTES_FILE} has no notes for Arbor ${version}`);
  return releases.slice(at, at + RELEASE_LIMITS.versions);
}

export const NIGHTLY_SUMMARY = 'A nightly build of what’s next.';

/** Whether `version` is a nightly, `X.Y.Z-nightly.YYYYMMDD.N`, built from main by the Release workflow. */
export function isNightly(version) {
  return /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(version);
}

/**
 * The notes a release carries. A nightly has none written for it, so it says what it is, followed by the releases
 * before it; X.Y.Z-nightly comes before X.Y.Z.
 */
export function releaseNotesFor(releases, version) {
  if (!isNightly(version)) return releasesUpTo(releases, version);
  const earlier = releases.filter((release) => compareVersions(release.version, version) < 0);
  return [{ version, summary: NIGHTLY_SUMMARY, changes: [] }, ...earlier].slice(0, RELEASE_LIMITS.versions);
}

function assetName(version, arch) {
  return `Arbor-v${version}-Darwin-${arch}.dmg`;
}

/** Where a release's page and DMG are: in the local feed, or in its GitHub release. */
function releaseLocations(feed, version, arch) {
  if (feed === 'github') {
    const tag = `arbor-v${version}`;
    return {
      releaseUrl: `https://github.com/${GITHUB_REPOSITORY}/releases/tag/${tag}`,
      assetUrl: `https://github.com/${GITHUB_REPOSITORY}/releases/download/${tag}/${assetName(version, arch)}`,
    };
  }
  if (feed === 'local') return { releaseUrl: `${LOCAL_FEED_ORIGIN}/`, assetUrl: `${LOCAL_FEED_ORIGIN}/${assetName(version, arch)}` };
  throw new Error(`Unknown feed: ${feed}`);
}

/**
 * A release's manifest, in the exact shape the app's feed checks accept, plus recent releases' notes and the core the
 * release bundles, which tells the app whether installing it restarts the proxy. The local feed's is read as it is;
 * the GitHub one is signed (release-signing.mjs) and uploaded with the DMG.
 */
export function feedManifest({ feed = 'local', version, arch, sha256, sizeBytes, publishedAt, releases, coreVersion }) {
  validateAppVersion(version);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Invalid SHA-256: ${sha256}`);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error(`Invalid DMG size: ${sizeBytes}`);
  if (!/^\d+\.\d+\.\d+$/.test(coreVersion)) throw new Error(`Invalid core version: ${coreVersion}`);
  const { releaseUrl, assetUrl } = releaseLocations(feed, version, arch);
  return {
    schemaVersion: 1,
    version,
    publishedAt,
    coreVersion,
    releaseUrl,
    assets: {
      [`darwin-${arch}`]: { url: assetUrl, sha256, sizeBytes },
    },
    releases: releases.map(({ version: releaseVersion, summary, changes }) => ({ version: releaseVersion, summary, changes })),
  };
}

/** A GitHub release's body: the summary, any changes, and the DMG's checksum. */
export function githubReleaseBody({ release, asset, sha256 }) {
  const lines = [release.summary];
  if (release.changes.length) lines.push('', ...release.changes.map((change) => `- ${change}`));
  if (asset && sha256) lines.push('', `\`${asset}\` SHA-256: \`${sha256}\``);
  return `${lines.join('\n')}\n`;
}

/** The `Release Arbor X.Y.Z` commit message, carrying the summary. */
export function releaseCommitMessage(version, summary) {
  const text = summary ? summary.replace(/\s+/g, ' ').trim() : '';
  return `Release Arbor ${validateAppVersion(version)}\n${text ? `\n${text}\n` : ''}`;
}

/** release-notes.json in the working tree, or as committed at `ref`. */
export function readReleaseNotes({ ref, cwd = repoDir, spawnImpl = spawnSync } = {}) {
  if (!ref) return parseReleaseNotes(readFileSync(join(cwd, RELEASE_NOTES_FILE), 'utf8'));
  const result = spawnImpl('git', ['show', `${ref}:${RELEASE_NOTES_FILE}`], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${ref} has no ${RELEASE_NOTES_FILE}: ${String(result.stderr).trim()}`);
  return parseReleaseNotes(String(result.stdout));
}

/** The next release's notes, from ARBOR_RELEASE_SUMMARY and ARBOR_RELEASE_CHANGES (one change a line). */
function pendingEntry(version) {
  const changes = (process.env.ARBOR_RELEASE_CHANGES ?? '').split('\n');
  return releaseEntry({ version, summary: process.env.ARBOR_RELEASE_SUMMARY, changes });
}

function options(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? '';
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    values[flag.slice(2)] = value;
    index += 1;
  }
  return values;
}

function required(values, name) {
  const value = values[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function writeAtomically(path, contents) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, path);
}

function describe(release) {
  return [`Arbor ${release.version}`, `  ${release.summary}`, ...release.changes.map((change) => `  - ${change}`)].join('\n');
}

async function main([command, ...argv]) {
  const values = options(argv);
  switch (command) {
    case 'preview': {
      // Also refuses a version that's already out, and notes that can't be published.
      const entry = pendingEntry(required(values, 'pending'));
      withRelease(readReleaseNotes(), entry);
      console.log(describe(entry));
      return;
    }
    case 'add': {
      const releases = withRelease(readReleaseNotes(), pendingEntry(required(values, 'version')));
      await writeAtomically(join(repoDir, RELEASE_NOTES_FILE), `${JSON.stringify(releases, null, 2)}\n`);
      return;
    }
    case 'check':
      // Every release's notes, as publishing would check them.
      for (const release of readReleaseNotes({ ref: values.ref })) releaseEntry(release);
      return;
    case 'feed-manifest':
    case 'github-manifest': {
      // The local feed's is written while the release is built, after `add`. The GitHub one is written after the
      // release commit is pushed, from the notes as committed there (--ref), or by the Release workflow from its
      // checkout, where a stable release's notes were just added.
      const github = command === 'github-manifest';
      const version = validateAppVersion(required(values, 'version'));
      const notes = readReleaseNotes({ ref: values.ref });
      const releases = github ? releaseNotesFor(notes, version) : releasesUpTo(notes, version);
      const manifest = feedManifest({
        feed: github ? 'github' : 'local',
        version,
        arch: required(values, 'arch'),
        sha256: required(values, 'sha256'),
        sizeBytes: Number(required(values, 'size')),
        publishedAt: values['published-at'] ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        releases,
        coreVersion: required(values, 'core-version'),
      });
      await writeAtomically(required(values, 'output'), `${JSON.stringify(manifest, null, 2)}\n`);
      return;
    }
    case 'github-body': {
      const version = validateAppVersion(required(values, 'version'));
      const [release] = releaseNotesFor(readReleaseNotes({ ref: values.ref }), version);
      process.stdout.write(githubReleaseBody({ release: releaseEntry(release), asset: values.asset, sha256: values.sha256 }));
      return;
    }
    case 'commit-message': {
      const version = validateAppVersion(required(values, 'version'));
      const [release] = releasesUpTo(readReleaseNotes(), version);
      await writeFile(required(values, 'output'), releaseCommitMessage(version, release.summary));
      return;
    }
    default:
      throw new Error('Usage: release-notes.mjs preview|add|check|feed-manifest|github-manifest|github-body|commit-message [--flag value ...]');
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
