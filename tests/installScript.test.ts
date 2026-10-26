import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { feedManifest } from '../scripts/release-notes.mjs';
import { signFeed } from '../scripts/release-signing.mjs';

// Runs scripts/install.sh the way people do, `curl … | sh`, against an update list built by the release scripts'
// own code. Only the network and the macOS-only tools are faked. On a Mac, `sh` is bash 3.2 and plutil is real, so
// this also covers the locale trap and the update list's shape; elsewhere a stand-in plutil reads the same keypaths,
// even where some other plutil is installed, since only macOS's has `-extract … raw`.

const VERSION = '1.4.2';
const DMG_BYTES = 'not really a disk image';
const script = readFileSync('scripts/install.sh');
const isMac = process.platform === 'darwin';
const isRoot = process.getuid?.() === 0;

let root = '';
let bin = '';
let tmp = '';
let log = '';

function tool(name: string, body: string) {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function updateList(sha256: string) {
  const manifest = feedManifest({
    feed: 'github',
    version: VERSION,
    arch: 'aarch64',
    sha256,
    sizeBytes: DMG_BYTES.length,
    publishedAt: '2026-10-20T00:00:00Z',
    releases: [{ version: VERSION, summary: 'A test release.', changes: [] }],
    coreVersion: '8.0.24',
    commit: 'c'.repeat(40),
  });
  const { privateKey } = generateKeyPairSync('ed25519');
  return JSON.stringify(signFeed(`${JSON.stringify(manifest, null, 2)}\n`, privateKey));
}

// ARBOR_INSTALL_DIR is always set, so a run that loses track of it lands in `installDir`, never the real /Applications.
// `command` runs the script as a shell line that reads it from stdin, in place of plain `sh`.
function install(
  installDir: string,
  { sha256 = createHash('sha256').update(DMG_BYTES).digest('hex'), running = false, command = '' } = {},
) {
  writeFileSync(join(root, 'feed.json'), updateList(sha256));
  if (running) tool('pgrep', 'exit 0');
  rmSync(log, { force: true });
  const result = Bun.spawnSync(command ? ['sh', '-c', command] : ['sh'], {
    stdin: script,
    cwd: root,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: root,
      TMPDIR: tmp,
      LC_ALL: 'en_US.UTF-8',
      ARBOR_INSTALL_DIR: installDir,
      FAKE_ROOT: root,
      FAKE_LOG: log,
    },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
  };
}

const installedApp = (installDir: string) => readFileSync(join(installDir, 'Arbor.app', 'Contents', 'MacOS', 'Arbor'), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'arbor-install-test-'));
  bin = join(root, 'bin');
  tmp = join(root, 'tmp');
  log = join(root, 'calls.log');
  mkdirSync(bin);
  mkdirSync(tmp);
  writeFileSync(join(root, 'dmg'), DMG_BYTES);

  tool('uname', 'echo Darwin');
  tool('sysctl', 'echo 1');
  tool('pgrep', 'exit 1');
  tool(
    'curl',
    `out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done
echo "curl $url" >> "$FAKE_LOG"
case "$url" in *.json) cp "$FAKE_ROOT/feed.json" "$out" ;; *.dmg) cp "$FAKE_ROOT/dmg" "$out" ;; *) exit 22 ;; esac`,
  );
  // Attaching "mounts" a DMG holding an Arbor.app whose binary names the version.
  tool(
    'hdiutil',
    `echo "hdiutil $1" >> "$FAKE_LOG"
if [ "$1" = attach ]; then
  while [ $# -gt 0 ]; do [ "$1" = -mountpoint ] && mount="$2"; shift; done
  mkdir -p "$mount/Arbor.app/Contents/MacOS" && echo "Arbor ${VERSION}" > "$mount/Arbor.app/Contents/MacOS/Arbor"
fi`,
  );
  tool('ditto', 'cp -R "$1" "$2"');
  tool('xattr', 'exit 0');
  // An administrator's password lets the copy write to the folder.
  tool('sudo', 'echo "sudo $1" >> "$FAKE_LOG"; chmod u+w "$ARBOR_INSTALL_DIR"; exec "$@"');
  if (!isMac) {
    writeFileSync(
      join(bin, 'plutil.mjs'),
      `const [, , , keypath, , , , file] = process.argv;
let value = JSON.parse(await Bun.file(file).text());
for (const key of keypath.split('.')) value = value?.[key];
if (typeof value !== 'string') process.exit(1);
process.stdout.write(value);`,
    );
    tool('plutil', `exec bun "${join(bin, 'plutil.mjs')}" "$@"`);
  }
});

afterEach(() => {
  for (const dir of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (dir.isDirectory()) chmodSync(join(dir.parentPath, dir.name), 0o755);
  }
  rmSync(root, { recursive: true, force: true });
});

describe('the installer', () => {
  test('installs the release the update list names into a new folder, and promises self-updates', () => {
    const installDir = join(root, 'Applications');

    const result = install(installDir);

    expect(result.stderr).not.toContain('unbound variable');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Downloading Arbor ${VERSION}…`);
    expect(installedApp(installDir)).toBe(`Arbor ${VERSION}\n`);
    expect(result.stdout).toContain('it updates itself from now on');
    expect(result.calls.filter((call) => call.startsWith('sudo'))).toEqual([]);
  });

  test('leaves nothing behind: the DMG is detached and its temp folder removed', () => {
    const result = install(join(root, 'Applications'));

    expect(result.exitCode).toBe(0);
    expect(result.calls.filter((call) => call.startsWith('hdiutil'))).toEqual(['hdiutil attach', 'hdiutil detach']);
    expect(readdirSync(tmp)).toEqual([]);
    expect(readdirSync(join(root, 'Applications'))).toEqual(['Arbor.app']);
  });

  test.skipIf(isRoot)("says Arbor can't update itself when the folder needed an administrator password", () => {
    const installDir = join(root, 'Applications');
    mkdirSync(installDir);
    chmodSync(installDir, 0o555);

    const result = install(installDir);

    expect(result.exitCode).toBe(0);
    expect(result.calls).toContain('sudo ditto');
    expect(installedApp(installDir)).toBe(`Arbor ${VERSION}\n`);
    expect(result.stdout).toContain('Open it from there.');
    expect(result.stdout).toContain("Arbor can't update itself there");
    expect(result.stdout).not.toContain('it updates itself from now on');
  });

  test.skipIf(isRoot)('suggests a command that, pasted as it is, installs where Arbor can update itself', () => {
    const lockedDir = join(root, 'Shared Applications');
    mkdirSync(lockedDir);
    chmodSync(lockedDir, 0o555);
    const readmeCommand = readFileSync('README.md', 'utf8').match(/^curl \S.*\/install\.sh \| sh$/m)?.[0] ?? '';
    const pipe = `${readmeCommand.slice(0, -' sh'.length)} `;

    const suggested = install(lockedDir).stdout.split('\n').find((line) => line.trim().startsWith('curl '))?.trim() ?? '';
    // The README's own command with the variable added after the pipe, where it reaches the script.
    expect(readmeCommand).not.toBe('');
    expect(suggested.startsWith(pipe)).toBe(true);
    // The decoy is what the shell already has; the pasted line has to replace it.
    const decoy = join(root, 'Decoy');
    const result = install(decoy, { command: suggested.slice(pipe.length) });

    expect(result.exitCode).toBe(0);
    expect(installedApp(join(root, 'Applications'))).toBe(`Arbor ${VERSION}\n`);
    expect(existsSync(join(decoy, 'Arbor.app'))).toBe(false);
    expect(result.calls.filter((call) => call.startsWith('sudo'))).toEqual([]);
    expect(result.stdout).toContain('it updates itself from now on');
  });

  test("keeps the installed Arbor when the download doesn't match the update list's SHA-256", () => {
    const installDir = join(root, 'Applications');
    mkdirSync(join(installDir, 'Arbor.app', 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(installDir, 'Arbor.app', 'Contents', 'MacOS', 'Arbor'), 'Arbor 1.0.0\n');

    const result = install(installDir, { sha256: 'f'.repeat(64) });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("doesn't match the release's SHA-256");
    expect(result.calls).not.toContain('hdiutil attach');
    expect(installedApp(installDir)).toBe('Arbor 1.0.0\n');
    expect(readdirSync(installDir)).toEqual(['Arbor.app']);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test('refuses to replace Arbor while it is open, before downloading anything', () => {
    const result = install(join(root, 'Applications'), { running: true });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Arbor is open');
    expect(result.calls).toEqual([]);
  });
});
