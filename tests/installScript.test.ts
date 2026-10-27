import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
// Stand-ins for /Applications and ~/Applications: every run gets both, so none can reach the real ones.
let systemApps = '';
let home = '';
let homeApps = '';

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

interface InstallOptions {
  /** ARBOR_INSTALL_DIR, when the run names a folder that way. */
  dir?: string;
  /** Options after `sh -s --`. */
  args?: string[];
  /** A shell line that reads the script from stdin, in place of `sh -s -- …args`. */
  command?: string;
  sha256?: string;
  /** The folder Arbor is open from. */
  running?: string;
  /** A folder sudo makes writable. */
  locked?: string;
  /** What `id -u` says. */
  uid?: number;
}

function install({ dir, args = [], command, sha256 = createHash('sha256').update(DMG_BYTES).digest('hex'), running = '', locked = '', uid = 501 }: InstallOptions = {}) {
  writeFileSync(join(root, 'feed.json'), updateList(sha256));
  rmSync(log, { force: true });
  const result = Bun.spawnSync(command ? ['sh', '-c', command] : ['sh', '-s', '--', ...args], {
    stdin: script,
    cwd: root,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: home,
      TMPDIR: tmp,
      LC_ALL: 'en_US.UTF-8',
      ARBOR_SYSTEM_APPLICATIONS: systemApps,
      ...(dir === undefined ? {} : { ARBOR_INSTALL_DIR: dir }),
      FAKE_ROOT: root,
      FAKE_LOG: log,
      FAKE_RUNNING: running,
      FAKE_LOCKED: locked,
      FAKE_UID: String(uid),
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
const sudoCalls = (calls: string[]) => calls.filter((call) => call.startsWith('sudo'));

function oldArbor(folder: string) {
  mkdirSync(join(folder, 'Arbor.app', 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(folder, 'Arbor.app', 'Contents', 'MacOS', 'Arbor'), 'Arbor 1.0.0\n');
}

function lock(folder: string) {
  mkdirSync(folder, { recursive: true });
  chmodSync(folder, 0o555);
  return folder;
}

beforeEach(() => {
  // Resolved, since the script prints folders resolved and macOS's temp folder sits behind /var → /private/var.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'arbor-install-test-')));
  bin = join(root, 'bin');
  tmp = join(root, 'tmp');
  log = join(root, 'calls.log');
  systemApps = join(root, 'Applications');
  home = join(root, 'home');
  homeApps = join(home, 'Applications');
  mkdirSync(bin);
  mkdirSync(tmp);
  mkdirSync(home);
  writeFileSync(join(root, 'dmg'), DMG_BYTES);

  tool('uname', 'echo Darwin');
  tool('sysctl', 'echo 1');
  // Arbor is "open" from the folder in FAKE_RUNNING. Like pgrep -f, the last argument is an extended regex matched
  // against the process's command line.
  tool(
    'pgrep',
    `for arg; do pattern="$arg"; done
[ -n "$FAKE_RUNNING" ] && printf '%s\\n' "$FAKE_RUNNING/Arbor.app/Contents/MacOS/Arbor" | grep -Eq -- "$pattern"`,
  );
  tool('id', 'echo "$FAKE_UID"');
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
  // An administrator's password lets the copy write to the locked folder.
  tool('sudo', 'echo "sudo $1" >> "$FAKE_LOG"; [ -z "$FAKE_LOCKED" ] || chmod u+w "$FAKE_LOCKED"; exec "$@"');
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
  test('installs the release the update list names into /Applications, and promises self-updates', () => {
    mkdirSync(systemApps);

    const result = install();

    expect(result.stderr).not.toContain('unbound variable');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Downloading Arbor ${VERSION}…`);
    expect(installedApp(systemApps)).toBe(`Arbor ${VERSION}\n`);
    expect(result.stdout).toContain(`Installed Arbor ${VERSION} in ${systemApps}. Open it from there; it updates itself from now on.`);
    expect(sudoCalls(result.calls)).toEqual([]);
    expect(existsSync(homeApps)).toBe(false);
  });

  test('leaves nothing behind: the DMG is detached and its temp folder removed', () => {
    mkdirSync(systemApps);

    const result = install();

    expect(result.exitCode).toBe(0);
    expect(result.calls.filter((call) => call.startsWith('hdiutil'))).toEqual(['hdiutil attach', 'hdiutil detach']);
    expect(readdirSync(tmp)).toEqual([]);
    expect(readdirSync(systemApps)).toEqual(['Arbor.app']);
  });

  test.skipIf(isRoot)("installs into ~/Applications without sudo when /Applications isn't writable", () => {
    lock(systemApps);

    const result = install();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Installing into ${homeApps}, because ${systemApps} needs an administrator password.`);
    expect(installedApp(homeApps)).toBe(`Arbor ${VERSION}\n`);
    expect(result.stdout).toContain('it updates itself from now on');
    expect(sudoCalls(result.calls)).toEqual([]);
    expect(readdirSync(systemApps)).toEqual([]);
  });

  test.skipIf(isRoot)("never asks for sudo on its own, even when neither Applications folder is writable", () => {
    lock(systemApps);
    lock(homeApps);

    const result = install();

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Couldn't write to ${homeApps}. Choose a folder you own with --dir.`);
    expect(sudoCalls(result.calls)).toEqual([]);
  });

  test('updates Arbor where it already is', () => {
    mkdirSync(systemApps);
    oldArbor(homeApps);

    const result = install();

    expect(result.exitCode).toBe(0);
    expect(installedApp(homeApps)).toBe(`Arbor ${VERSION}\n`);
    expect(readdirSync(systemApps)).toEqual([]);
    expect(result.stdout).not.toContain('Installing into');
    expect(result.stdout).not.toContain('another Arbor');
  });

  test.skipIf(isRoot)("moves an Arbor it can't update into ~/Applications, and points out the old copy", () => {
    oldArbor(systemApps);
    lock(systemApps);

    const result = install();

    expect(result.exitCode).toBe(0);
    expect(installedApp(homeApps)).toBe(`Arbor ${VERSION}\n`);
    expect(installedApp(systemApps)).toBe('Arbor 1.0.0\n');
    expect(sudoCalls(result.calls)).toEqual([]);
    expect(result.stdout).toContain(`There's another Arbor in ${systemApps}. Delete it (it may ask for an administrator's password), so Spotlight, the Dock and Open at login use this one.`);
  });

  test('installs into the folder --dir names, ~ included', () => {
    const custom = join(home, 'Tools');

    const spaced = install({ args: ['--dir', join(root, 'My Apps')] });
    const joined = install({ args: ['--dir=~/Tools/'] });

    expect(spaced.exitCode).toBe(0);
    expect(installedApp(join(root, 'My Apps'))).toBe(`Arbor ${VERSION}\n`);
    expect(joined.exitCode).toBe(0);
    expect(installedApp(custom)).toBe(`Arbor ${VERSION}\n`);
    expect(joined.stdout).toContain(`Installed Arbor ${VERSION} in ${custom}. Open it`);
    expect(joined.stdout).not.toContain('Installing into');
  });

  test('settles a relative --dir, or one spelled another way, to the folder itself', () => {
    mkdirSync(systemApps);

    const relative = install({ args: ['--dir', 'home/Applications'] });
    const dotted = install({ args: [`--dir=${systemApps}/./`] });

    expect(relative.exitCode).toBe(0);
    expect(relative.stdout).toContain(`Installed Arbor ${VERSION} in ${homeApps}. Open it`);
    expect(dotted.stdout).toContain(`Installed Arbor ${VERSION} in ${systemApps}. Open it`);
    // Each copy is pointed out only from the other folder's install, never as a copy of itself.
    expect(relative.stdout).not.toContain(`another Arbor in ${homeApps}`);
    expect(dotted.stdout).not.toContain(`another Arbor in ${systemApps}`);
  });

  test('sees a linked folder as the folder it links to, for the copy notice and for an open Arbor', () => {
    mkdirSync(systemApps);
    mkdirSync(homeApps);
    const link = join(root, 'Apps link');
    symlinkSync(homeApps, link);

    const result = install({ args: ['--dir', link] });
    const open = install({ args: ['--dir', link], running: homeApps });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Installed Arbor ${VERSION} in ${homeApps}. Open it`);
    expect(result.stdout).not.toContain('another Arbor');
    expect(open.exitCode).toBe(1);
    expect(open.stderr).toContain('Arbor is open');
  });

  test('takes --dir=~ as the home folder, and refuses a --dir with no folder before downloading', () => {
    const tilde = install({ args: ['--dir=~'] });
    const missing = install({ args: ['--dir'] });
    const empty = install({ args: ['--dir='] });

    expect(tilde.exitCode).toBe(0);
    expect(installedApp(home)).toBe(`Arbor ${VERSION}\n`);
    for (const result of [missing, empty]) {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--dir needs a folder.');
      expect(result.calls).toEqual([]);
    }
  });

  test("won't install as root into a folder it picks, and warns when root installs into a named one", () => {
    mkdirSync(systemApps);

    const picked = install({ uid: 0 });
    const named = install({ uid: 0, args: ['--dir', join(root, 'Shared')] });

    expect(picked.exitCode).toBe(1);
    expect(picked.stderr).toContain('Run this without sudo');
    expect(picked.calls).toEqual([]);
    expect(named.exitCode).toBe(0);
    expect(named.stdout).toContain("Arbor can't update itself there");
    expect(named.stdout).not.toContain('it updates itself from now on');
  });

  test.skipIf(isRoot)("replaces an Arbor.app it can't write into, and says how to remove the old copy", () => {
    mkdirSync(systemApps);
    oldArbor(systemApps);
    for (const dir of ['Arbor.app/Contents/MacOS', 'Arbor.app/Contents', 'Arbor.app']) chmodSync(join(systemApps, dir), 0o555);

    const result = install();

    expect(result.exitCode).toBe(0);
    expect(installedApp(systemApps)).toBe(`Arbor ${VERSION}\n`);
    expect(result.stdout).toContain('it updates itself from now on');
    const leftover = readdirSync(systemApps).filter((name) => name.startsWith('.Arbor.app.replaced-'));
    expect(leftover.length).toBe(1);
    expect(result.stdout).toContain(`An administrator can remove it with: sudo rm -rf "${join(systemApps, leftover[0] ?? '')}"`);
    expect(readdirSync(systemApps).filter((name) => name.startsWith('.Arbor.app.installing'))).toEqual([]);
  });

  test('prefers --dir over ARBOR_INSTALL_DIR, and refuses an option it does not know before downloading', () => {
    const chosen = install({ dir: join(root, 'From env'), args: ['--dir', join(root, 'From flag')] });
    const unknown = install({ args: ['--prefix', '/opt'] });

    expect(installedApp(join(root, 'From flag'))).toBe(`Arbor ${VERSION}\n`);
    expect(existsSync(join(root, 'From env'))).toBe(false);
    expect(chosen.exitCode).toBe(0);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("--prefix isn't an option");
    expect(unknown.calls).toEqual([]);
  });

  test.skipIf(isRoot)("says Arbor can't update itself in a folder named for it that needed an administrator password", () => {
    const shared = lock(join(root, 'Shared'));

    const result = install({ dir: shared, locked: shared });

    expect(result.exitCode).toBe(0);
    expect(result.calls).toContain('sudo ditto');
    expect(installedApp(shared)).toBe(`Arbor ${VERSION}\n`);
    expect(result.stdout).toContain('Open it from there.');
    expect(result.stdout).toContain("Arbor can't update itself there");
    expect(result.stdout).not.toContain('it updates itself from now on');
  });

  test.skipIf(isRoot)('suggests a command that, pasted as it is, installs where Arbor can update itself', () => {
    const shared = lock(join(root, 'Shared'));
    const readmeCommand = readFileSync('README.md', 'utf8').match(/^curl \S.*\/install\.sh \| sh$/m)?.[0] ?? '';
    const pipe = `${readmeCommand.slice(0, -' sh'.length)} `;

    const suggested = install({ dir: shared, locked: shared }).stdout.split('\n').find((line) => line.trim().startsWith('curl '))?.trim() ?? '';
    // The README's own command with options after the pipe, where they reach the script.
    expect(readmeCommand).not.toBe('');
    expect(suggested.startsWith(pipe)).toBe(true);
    // The decoy is what the shell already has; the pasted line has to win over it.
    const decoy = join(root, 'Decoy');
    const result = install({ dir: decoy, command: suggested.slice(pipe.length) });

    expect(result.exitCode).toBe(0);
    expect(installedApp(homeApps)).toBe(`Arbor ${VERSION}\n`);
    expect(existsSync(join(decoy, 'Arbor.app'))).toBe(false);
    expect(sudoCalls(result.calls)).toEqual([]);
    expect(result.stdout).toContain('it updates itself from now on');
  });

  test.skipIf(isRoot)("tells someone who can't use sudo where they can install instead", () => {
    const shared = lock(join(root, 'Shared'));
    tool('sudo', 'echo "sudo $1" >> "$FAKE_LOG"; echo "cam is not in the sudoers file." >&2; exit 1');

    const result = install({ dir: shared });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Couldn't get an administrator's permission");
    expect(result.stderr).toContain('curl -fsSL https://arbor.onl/install.sh | sh -s -- --dir ~/Applications');
    expect(sudoCalls(result.calls)).toEqual(['sudo true']);
    expect(readdirSync(shared)).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("keeps the installed Arbor when the download doesn't match the update list's SHA-256", () => {
    oldArbor(systemApps);

    const result = install({ sha256: 'f'.repeat(64) });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("doesn't match the release's SHA-256");
    expect(result.calls).not.toContain('hdiutil attach');
    expect(installedApp(systemApps)).toBe('Arbor 1.0.0\n');
    expect(readdirSync(systemApps)).toEqual(['Arbor.app']);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test('refuses while Arbor is open from either Applications folder or the one --dir names, before downloading anything', () => {
    mkdirSync(systemApps);
    oldArbor(homeApps);
    const odd = join(root, 'Apps (old)');

    const fromHome = install({ running: homeApps });
    const fromSystem = install({ running: systemApps });
    const fromNamed = install({ running: odd, args: ['--dir', odd] });

    for (const result of [fromHome, fromSystem, fromNamed]) {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Arbor is open');
      expect(result.calls).toEqual([]);
    }
  });
});
