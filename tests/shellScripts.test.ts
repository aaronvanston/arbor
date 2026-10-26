import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

// macOS's /bin/sh is bash 3.2, which in a UTF-8 locale reads a non-ASCII byte right after `$name` as part of the
// name, so under `set -u` "$version…" stops the script with "version…: unbound variable". Write "${version}…".
test('no shell script puts a non-ASCII character straight after a bare variable', () => {
  const offenders = readdirSync('scripts')
    .filter((name) => name.endsWith('.sh'))
    .flatMap((name) =>
      readFileSync(`scripts/${name}`, 'utf8')
        .split('\n')
        .flatMap((line, index) => (/\$[A-Za-z_][A-Za-z0-9_]*[^\p{ASCII}]/u.test(line) ? [`scripts/${name}:${index + 1}`] : [])),
    );
  expect(offenders).toEqual([]);
});
