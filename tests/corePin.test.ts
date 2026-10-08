import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// The release build bundles the core only when its archive matches core-sha256.txt, so a core-version.txt bumped
// without scripts/pin-core.sh fails here rather than in the nightly's build.
test('core-sha256.txt pins both macOS archives of the core in core-version.txt, and nothing else', () => {
  const version = readFileSync('core-version.txt', 'utf8').trim().replace(/^v/, '');
  const pins = readFileSync('core-sha256.txt', 'utf8').trim().split('\n').map((line) => line.split(/\s+/));
  expect(pins.map(([, asset]) => asset)).toEqual(
    ['aarch64', 'amd64'].map((arch) => `CLIProxyAPI_${version}_darwin_${arch}.tar.gz`),
  );
  for (const [digest] of pins) expect(digest).toMatch(/^[0-9a-f]{64}$/);
});
