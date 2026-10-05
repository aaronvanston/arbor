import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { iconSourceHash } from '../scripts/icon-hash.mjs';

const icons = join(import.meta.dir, '..', 'src-tauri', 'icons');
const iconDirs = [icons, ...readdirSync(join(icons, 'channels')).sort().map((channel) => join(icons, 'channels', channel))]
  .filter((dir) => existsSync(join(dir, 'Arbor.icon')));

describe('the compiled app icons', () => {
  test('every build channel has an Icon Composer file', () => {
    expect(iconDirs.map((dir) => dir.slice(icons.length) || '/')).toEqual(['/', '/channels/dev', '/channels/nightly']);
  });

  // Builds copy the committed Assets.car in without running actool, so one left behind by an icon change would ship the
  // old icon. Run the Icons workflow (scripts/compile-icons.sh) and commit what it makes.
  test.each(iconDirs)('%s/Assets.car was compiled from the Arbor.icon beside it', (dir) => {
    expect(existsSync(join(dir, 'Assets.car'))).toBe(true);
    expect(readFileSync(join(dir, 'Assets.car.sha256'), 'utf8').trim()).toBe(iconSourceHash(join(dir, 'Arbor.icon')));
  });
});
