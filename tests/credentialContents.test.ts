import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

/**
 * The core's `/auth-files/download` answers with a whole credential file, tokens included. Rust reads it
 * (src-tauri/src/auth_file_contents.rs) and hands the webview only what it needs, and `management_request` refuses the
 * path, so nothing in the webview may ask for it. The browser mock is left out: it refuses the path the way Rust does.
 */
describe('credential files stay out of the webview', () => {
  test('nothing in src outside the mock asks the core for a credential file', () => {
    const askers = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((path) => /\.tsx?$/.test(path) && !path.startsWith('dev/'))
      .filter((path) => /auth-files\/+download/i.test(readFileSync(join(root, 'src', path), 'utf8')));
    expect(askers).toEqual([]);
  });
});
