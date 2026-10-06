/**
 * A Vite build plugin that ships the UI's English strings with the code that shows them. The strings the launch's own
 * code names go with the app; every module loaded lazily (a page, a dialog, a viewer) imports the strings its code
 * names that the launch didn't bring, grouped by the key's first two parts (`setup.skills.*`), so a page brings only
 * its own and the parts pages share load once. Each part is a `JSON.parse('…')`, which WebKit reads in about two thirds
 * of the time an object literal of the same size takes.
 *
 * `src/i18n/locales/en.ts` stays one typed table: dev, the tests and `t()`'s keys read it whole, and only a build swaps
 * `src/i18n/strings.ts` for the split. Which strings a piece of code needs is read from its source: every key it names
 * as a string, plus every key under a prefix it builds one from (`t(\`status.indicator.${x}\`)` brings all of
 * `status.indicator.*`), across every file it reaches through static imports. A lazy import must name its module
 * literally, so the build knows what loads with what; it stops on one that doesn't.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const CODE = /\.(?:tsx?|mjs|js)$/;
const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx'];
const TABLE = 'src/i18n/locales/en.ts';

function resolveImport(from, specifier) {
  const base = resolve(dirname(from), specifier);
  for (const extension of EXTENSIONS) {
    const path = base + extension;
    if (CODE.test(path) && existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

/**
 * The relative modules a file imports for their values (type-only imports aren't followed), its `import()`s, and
 * whether any `import()` names its module some other way than as a string.
 */
export function importsOf(source) {
  const statics = [];
  for (const match of source.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g)) {
    if (!match[1]) statics.push(match[2]);
  }
  const dynamics = [...source.matchAll(/(?<!typeof )\bimport\(\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  const unnamed = /(?<!typeof )\bimport\(\s*[^'"\s]/.test(source);
  return { statics, dynamics, unnamed };
}

/** Every file the roots reach through static imports. */
export function staticGraph(roots, read = (path) => readFileSync(path, 'utf8')) {
  const files = new Map();
  const queue = [...roots];
  while (queue.length) {
    const path = queue.pop();
    if (files.has(path)) continue;
    const source = read(path);
    files.set(path, source);
    for (const specifier of importsOf(source).statics) {
      const next = resolveImport(path, specifier);
      if (next) queue.push(next);
    }
  }
  return files;
}

/** The keys a piece of source names, as strings or as the fixed start of a template. */
export function keysNamed(source, keys) {
  const named = new Set();
  for (const match of source.matchAll(/(['"`])([\w-]+(?:\.[\w-]+)+)\1/g)) {
    if (keys.has(match[2])) named.add(match[2]);
  }
  for (const match of source.matchAll(/`([\w-]+\.(?:[\w-]+\.)*[\w-]*)\$\{/g)) {
    for (const key of keys) if (key.startsWith(match[1])) named.add(key);
  }
  return named;
}

/** The part a key loads in: its first two parts. */
export const partOf = (key) => key.split('.').slice(0, 2).join('.');

/** The table in en.ts, which is one exported object of plain strings. */
export function readStrings(path) {
  const source = readFileSync(path, 'utf8');
  const start = source.indexOf('{', source.indexOf('export const en'));
  const end = source.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error(`${path} is no longer one exported object, which the strings split expects`);
  return new Function(`return (${source.slice(start, end + 2)});`)();
}

/** `JSON.parse('…')` for a table: a single-quoted string, so JSON's own double quotes needn't be escaped. */
export function jsonParseCode(table) {
  const text = JSON.stringify(table);
  const quoted = `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')}'`;
  return `JSON.parse(${quoted})`;
}

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : CODE.test(path) ? [path] : [];
  });
}

/** The launch's modules; the demo build installs the browser mock as it starts, so its strings go along there. */
export const launchEntries = (mode) => (mode === 'demo' ? ['src/main.tsx', 'src/dev/mockTauri.ts'] : ['src/main.tsx']);

/**
 * How a build splits the strings: what the launch's code names (`core`), each part of the rest, and the parts each
 * lazily loaded module brings. `unnamed` lists the files with an `import()` the split can't follow.
 */
export function splitSource(root, mode) {
  const table = join(root, TABLE);
  const strings = readStrings(table);
  const keys = new Set(Object.keys(strings));
  const named = (roots) => {
    const files = staticGraph(roots);
    // The table names every key; the split is about the code that uses them.
    files.delete(table);
    const found = new Set();
    for (const source of files.values()) for (const key of keysNamed(source, keys)) found.add(key);
    return found;
  };

  const launch = named(launchEntries(mode).map((entry) => join(root, entry)));
  const core = {};
  const parts = {};
  for (const [key, text] of Object.entries(strings)) {
    if (launch.has(key)) core[key] = text;
    else (parts[partOf(key)] ??= {})[key] = text;
  }

  const lazy = new Map();
  const unnamed = [];
  for (const file of sourceFiles(join(root, 'src'))) {
    const imports = importsOf(readFileSync(file, 'utf8'));
    if (imports.unnamed) unnamed.push(relative(root, file));
    for (const specifier of imports.dynamics) {
      const target = specifier.startsWith('.') ? resolveImport(file, specifier) : null;
      if (target && !lazy.has(target)) lazy.set(target, []);
    }
  }
  for (const target of lazy.keys()) {
    const brings = new Set([...named([target])].filter((key) => !launch.has(key)).map(partOf));
    lazy.set(target, [...brings].sort());
  }
  return { core, parts, lazy, unnamed };
}

const PART_PREFIX = 'virtual:arbor-strings/';
const RESOLVED_PART_PREFIX = '\0arbor-strings/';

/** @param {{ root: string, mode: string }} options */
export function splitStringsPlugin({ root, mode }) {
  let split = null;
  const normalize = (path) => path.replaceAll('\\', '/');
  const stringsModule = normalize(join(root, 'src/i18n/strings.ts'));
  return {
    name: 'arbor-split-strings',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      split = splitSource(root, mode);
      if (split.unnamed.length) {
        throw new Error(`An import() that doesn't name its module as a string can't bring its strings along: ${split.unnamed.join(', ')}.`);
      }
    },
    resolveId(id) {
      return id.startsWith(PART_PREFIX) ? RESOLVED_PART_PREFIX + id.slice(PART_PREFIX.length) : undefined;
    },
    load(id) {
      if (id.startsWith(RESOLVED_PART_PREFIX)) {
        const part = split.parts[id.slice(RESOLVED_PART_PREFIX.length)] ?? {};
        return `import { addStrings } from ${JSON.stringify(stringsModule)};\naddStrings(${jsonParseCode(part)});\n`;
      }
      if (normalize(id) !== stringsModule) return undefined;
      return [
        `export const strings = ${jsonParseCode(split.core)};`,
        '/** Adds a part of the strings, which a lazily loaded module imports before its own code runs. */',
        'export const addStrings = (part) => { Object.assign(strings, part); };',
        '',
      ].join('\n');
    },
    transform(code, id) {
      const parts = split.lazy.get(id.split('?')[0]);
      if (!parts?.length) return undefined;
      // Imports run in order, so the strings are in before anything the module imports or runs itself. On the first
      // line, so no line moves and the source map still holds.
      return { code: `${parts.map((part) => `import ${JSON.stringify(PART_PREFIX + part)};`).join('')}${code}`, map: null };
    },
  };
}
