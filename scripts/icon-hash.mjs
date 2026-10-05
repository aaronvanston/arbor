// The hash of an Icon Composer file's source (every file in the .icon folder, by path and contents), kept beside the
// Assets.car compiled from it. tests/appIcons.test.ts compares the two, so an icon edited without compiling it again
// fails the checks instead of shipping the old Assets.car.
//
//   node scripts/icon-hash.mjs src-tauri/icons/Arbor.icon
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function files(dir) {
  return readdirSync(dir)
    // Finder's own files say nothing about the icon.
    .filter((name) => name !== '.DS_Store')
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
}

export function iconSourceHash(iconDir) {
  const hash = createHash('sha256');
  for (const path of files(iconDir).sort()) {
    hash.update(relative(iconDir, path).split('\\').join('/'));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPoint) {
  const [dir] = process.argv.slice(2);
  if (!dir) {
    console.error('Usage: node scripts/icon-hash.mjs <path/to/Arbor.icon>');
    process.exit(1);
  }
  console.log(iconSourceHash(dir));
}
