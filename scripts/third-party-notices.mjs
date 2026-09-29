// Writes THIRD_PARTY_NOTICES.md: the license notices for everything Arbor ships or is adapted from. That's a
// hand-written list of the projects it bundles or borrows from (below), every npm package its frontend can bundle (the
// dependencies in package.json and theirs, read from node_modules), and every Rust crate compiled into the app or its
// core plugin (cargo metadata for Apple silicon, normal dependencies only). Identical license texts are printed once.
// The output is sorted and has no dates, so it only changes when a dependency does.
//
//   bun scripts/third-party-notices.mjs          writes it (bun run notices)
//   bun scripts/third-party-notices.mjs --check  exits 1 when the committed file is out of date; run it before releases
//
// Needs node_modules installed and the crates downloaded (a cargo build or cargo fetch does that).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(root, 'THIRD_PARTY_NOTICES.md');
const CARGO_MANIFESTS = ['src-tauri/Cargo.toml', 'core-plugins/arbor-models/Cargo.toml'];
const RUST_TARGET = 'aarch64-apple-darwin';
// Hugeicons Pro is licensed separately, installed only on release machines, and never published.
const SKIPPED_PACKAGES = /^@hugeicons-pro\//;
// LICENSE, LICENCE, COPYING and NOTICE files, with any suffix: LICENSE-MIT, LICENSE.md, NOTICE.txt, COPYING.
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-_.].*)?$/i;
const LICENSE_DIR = /^licen[cs]es$/i;
const NON_PERMISSIVE = /\b(?:A?GPL|LGPL|SSPL|BUSL|CC-BY-NC|UNKNOWN|UNLICENSED)\b|SEE LICENSE/i;

const INTRO = 'Arbor is MIT licensed (see LICENSE). It includes or is adapted from the software below, under their own '
  + 'licenses. Provider logos and names (Anthropic/Claude, OpenAI/ChatGPT/Codex, Google/Gemini/Antigravity/Vertex AI, '
  + 'xAI/Grok, Moonshot/Kimi and others) are trademarks of their owners, used only to identify the services Arbor '
  + 'connects to; the MIT license doesn\'t cover them, or the Arbor name and logo.';

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const mit = (...copyrights) => `MIT License\n\n${copyrights.join('\n')}\n\n${MIT_BODY}`;

// The projects Arbor bundles whole or took code, styling, artwork or data from. Copyright lines are the upstream ones;
// the text is the MIT license with them, or the installed package's own license file (`file`, under node_modules).
const BUNDLED = [
  {
    name: 'CLIProxyAPI core',
    url: 'https://github.com/router-for-me/CLIProxyAPI',
    license: 'MIT',
    copyright: ['Copyright (c) 2025-2005.9 Luis Pater', 'Copyright (c) 2025.9-present Router-For.ME'],
    use: 'the proxy core, shipped unmodified inside the app',
  },
  {
    name: 'EasyCLIProxyAPI',
    url: 'https://github.com/router-for-me/EasyCLIProxyAPI',
    license: 'MIT',
    copyright: ['Copyright (c) 2026 Router-For.ME'],
    use: 'the app Arbor is forked from (its notice is also in LICENSE)',
  },
  {
    name: 'T3 Code',
    url: 'https://github.com/pingdotgg/t3code',
    license: 'MIT',
    copyright: ['Copyright (c) 2026 T3 Tools Inc.'],
    use: 'UI primitives in src/components/ui and a few ported helpers',
  },
  {
    name: 'coss ui',
    url: 'https://github.com/cosscom/coss',
    license: 'MIT (apps/ui, per the repository\'s LICENSING.md)',
    copyright: ['Copyright (c) 2025 coss.com'],
    use: 'the UI primitives T3 Code\'s are based on',
  },
  {
    name: 'lobe-icons',
    url: 'https://github.com/lobehub/lobe-icons',
    license: 'MIT',
    copyright: ['Copyright (c) 2023 LobeHub'],
    use: 'provider logos in src/assets/icons',
  },
  {
    name: 'Hugeicons (free icons)',
    url: 'https://github.com/hugeicons/hugeicons',
    license: 'MIT',
    copyright: ['Copyright (c) 2025 Hugeicons'],
    use: 'the app\'s icons',
    note: 'Official builds also include a few Hugeicons Pro icons under a commercial license; they aren\'t part of '
      + 'this repository.',
    file: '@hugeicons/react/LICENSE.md',
  },
  {
    name: 'ReUI',
    url: 'https://github.com/keenthemes/reui',
    license: 'MIT',
    copyright: ['Copyright (c) 2025 Keenthemes Inc'],
    use: 'the data grid\'s styling',
  },
  {
    name: 'TextMate bundles',
    url: 'https://github.com/textmate/toml.tmbundle, https://github.com/textmate/yaml.tmbundle, https://github.com/textmate/ssh-config.tmbundle',
    license: 'TextMate bundle license',
    copyright: [],
    use: 'the TOML, YAML and SSH config grammars that highlight diffs, through Shiki',
    note: 'Arbor ships only the Shiki grammars listed in src/services/highlightLanguages.json: these three, and the rest '
      + 'under MIT or BSD licenses. Every other grammar is built empty.',
    text: `Permission to copy, use, modify, sell and distribute this
software is granted. This software is provided "as is" without
express or implied warranty, and with no claim as to its
suitability for any purpose.`,
  },
  {
    name: 'models.dev',
    url: 'https://github.com/anomalyco/models.dev',
    license: 'MIT',
    copyright: ['Copyright (c) 2025 models.dev'],
    use: 'model prices filled in from its catalog',
  },
];

// Plain code-unit order, so the output doesn't depend on the machine's locale.
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function compareVersions(a, b) {
  const left = a.split(/[.+-]/);
  const right = b.split(/[.+-]/);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index] ?? '';
    const y = right[index] ?? '';
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
    return byText(x, y);
  }
  return 0;
}

const byNameThenVersion = (a, b) => byText(a.name, b.name) || compareVersions(a.version, b.version);
const label = (item) => `${item.name} ${item.version}`;

// A license file's text with Windows line endings, a byte-order mark and blank lines around it removed.
function readText(path) {
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
    .replace(/^\s*\n/, '').replace(/\s+$/, '');
}

// The license and notice files at the top of a package or crate, and inside a LICENSES folder there.
function licenseFiles(dir, extra = []) {
  const found = new Set(extra.map((file) => resolve(dir, file)).filter((path) => existsSync(path)));
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isFile() && LICENSE_FILE.test(entry)) found.add(path);
    if (stats.isDirectory() && LICENSE_DIR.test(entry)) {
      for (const inner of readdirSync(path)) {
        if (statSync(join(path, inner)).isFile()) found.add(join(path, inner));
      }
    }
  }
  return [...found].sort(byText).map((path) => ({ file: path.slice(dir.length + 1), text: readText(path) }))
    .filter(({ text }) => text.trim());
}

function cleanRepository(value) {
  const raw = typeof value === 'string' ? value : value?.url;
  if (!raw) return '';
  let url = raw.trim()
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  return url.replace(/^http:\/\//, 'https://');
}

function npmLicense(manifest) {
  const value = manifest.license ?? manifest.licenses;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => entry?.type ?? entry).join(' OR ');
  return value?.type ?? 'UNKNOWN';
}

// Node's lookup: node_modules/<name> next to the package, then in each folder above it, up to the repo.
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dir === root || dirname(dir) === dir) return null;
  }
}

// Every package the frontend bundle can pull in: package.json's dependencies (not dev or optional ones) and, in turn,
// theirs. Peer dependencies aren't followed: package.json has to list them itself (react), or they're build tools that
// devDependencies bring (vite).
function npmPackages() {
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const queue = Object.keys(rootManifest.dependencies ?? {}).map((name) => ({ name, from: root }));
  const seenDirs = new Set();
  const packages = new Map();
  while (queue.length) {
    const { name, from } = queue.shift();
    if (SKIPPED_PACKAGES.test(name)) continue;
    const dir = resolvePackage(name, from);
    if (!dir) throw new Error(`${name} isn't installed (needed from ${from}); run bun install`);
    if (seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const item = {
      name: manifest.name ?? name,
      version: manifest.version ?? '',
      license: npmLicense(manifest),
      repository: cleanRepository(manifest.repository) || cleanRepository(manifest.homepage)
        || `https://www.npmjs.com/package/${manifest.name ?? name}`,
      files: licenseFiles(dir),
    };
    packages.set(label(item), item);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) queue.push({ name: dependency, from: dir });
  }
  return [...packages.values()].sort(byNameThenVersion);
}

function cargoMetadata(manifest) {
  const args = ['metadata', '--format-version', '1', '--locked', '--filter-platform', RUST_TARGET,
    '--manifest-path', join(root, manifest)];
  const run = (extra) => spawnSync('cargo', [...args, ...extra], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  let result = run([]);
  if (result.status !== 0) result = run(['--offline']);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`cargo metadata failed for ${manifest}: ${String(result.stderr).trim()}`);
  return JSON.parse(result.stdout);
}

// The crates compiled into the app and its core plugin: the root crates' normal dependencies, followed all the way
// down. Dev and build dependencies aren't followed; the workspace's own crates are left out.
function rustCrates() {
  const crates = new Map();
  for (const manifest of CARGO_MANIFESTS) {
    const metadata = cargoMetadata(manifest);
    const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
    const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
    const own = new Set(metadata.workspace_members);
    const queue = metadata.resolve.root ? [metadata.resolve.root] : [...own];
    const seen = new Set();
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const dep of nodes.get(id)?.deps ?? []) {
        if (dep.dep_kinds.some((kind) => kind.kind === null)) queue.push(dep.pkg);
      }
      if (own.has(id)) continue;
      const pkg = packages.get(id);
      const dir = dirname(pkg.manifest_path);
      const item = {
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? (pkg.license_file ? `see ${pkg.license_file}` : 'UNKNOWN'),
        repository: cleanRepository(pkg.repository) || cleanRepository(pkg.homepage)
          || `https://crates.io/crates/${pkg.name}`,
        files: licenseFiles(dir, pkg.license_file ? [pkg.license_file] : []),
      };
      crates.set(label(item), item);
    }
  }
  return [...crates.values()].sort(byNameThenVersion);
}

// A rough name for a license text, for its heading. The packages' own declared licenses are listed next to them.
function textKind(file, text) {
  if (/^notice/i.test(file.split('/').pop())) return 'Notice';
  if (/Apache License/i.test(text) && /Version 2\.0/.test(text)) return 'Apache-2.0';
  if (/Mozilla Public License,? Version 2\.0/i.test(text)) return 'MPL-2.0';
  if (/Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/Permission to use, copy, modify, and\/or distribute/i.test(text)) return 'ISC';
  if (/Redistribution and use in source and binary forms/i.test(text)) return 'BSD';
  if (/UNICODE LICENSE|Unicode, Inc\./i.test(text)) return 'Unicode';
  if (/This software is provided 'as-is'/i.test(text)) return 'Zlib';
  if (/free and unencumbered software released into the public domain/i.test(text)) return 'Unlicense';
  if (/Boost Software License/i.test(text)) return 'BSL-1.0';
  if (/^SPDXVersion:/m.test(text)) return 'SPDX summary';
  if (/CC0|Creative Commons/i.test(text)) return 'Creative Commons';
  return 'Other license';
}

const APACHE_END = 'END OF TERMS AND CONDITIONS';
const APACHE_APPENDIX = [
  /APPENDIX: How to apply the Apache License to your work\..*?third-party archives\./,
  /Licensed under the Apache License, Version 2\.0.*?limitations under the License\./,
];
const APACHE_PLACEHOLDER = /^Copyright [[{]yyyy[\]}] [[{]name of copyright owner[\]}]$/;
// A filled-in appendix line: "Copyright 2017 Juniper Networks, Inc." Anything longer is more than a copyright line.
const APACHE_COPYRIGHT = /^Copyright .{1,100}$/;

// Copies of the Apache License 2.0 mostly differ only in their appendix, which just shows how to apply the license, and
// in http or https links. For such a copy this gives its terms and the copyright lines its appendix was filled in with;
// null for any other text, including a copy with anything else added (ring's other licenses, rustix's LLVM exception).
function apacheCopy(text) {
  const flat = text.replace(/\s+/g, ' ').trim().replace(/https?:\/\//g, '').replace(/[\u201C\u201D]/g, '"');
  const end = flat.indexOf(APACHE_END);
  if (!flat.startsWith('Apache License Version 2.0, January 2004') || end < 0) return null;
  let rest = flat.slice(end + APACHE_END.length);
  for (const boilerplate of APACHE_APPENDIX) rest = rest.replace(boilerplate, '');
  const lines = rest.trim() ? rest.trim().split(/\s*(?=Copyright )/) : [];
  const copyrights = lines.filter((line) => !APACHE_PLACEHOLDER.test(line));
  if (!copyrights.every((line) => APACHE_COPYRIGHT.test(line))) return null;
  return { terms: flat.slice(0, end), copyrights };
}

// Groups identical texts (ignoring whitespace) and says which packages share each. Each group prints the text from the
// first package that has it. Apache License copies with the same terms are one group, printed from a copy with an
// unfilled appendix where there is one, with the copyright lines the others filled in listed under it.
function groupTexts(items) {
  const groups = new Map();
  for (const item of items) {
    for (const { file, text } of item.files) {
      const kind = textKind(file, text);
      const apache = kind === 'Apache-2.0' ? apacheCopy(text) : null;
      const key = apache ? `Apache ${apache.terms}` : text.replace(/\s+/g, ' ').trim();
      const group = groups.get(key) ?? { text, kind, users: [], copyrights: [], unfilled: false };
      if (apache && !apache.copyrights.length && !group.unfilled) Object.assign(group, { text, unfilled: true });
      if (apache?.copyrights.length) {
        const line = `${label(item)}: ${apache.copyrights.join('; ')}`;
        if (!group.copyrights.includes(line)) group.copyrights.push(line);
      }
      if (!group.users.includes(item)) group.users.push(item);
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort((a, b) => byText(a.kind, b.kind) || byNameThenVersion(a.users[0], b.users[0]));
}

function fence(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}text\n${text}\n${ticks}`;
}

const cell = (value) => String(value).replace(/\|/g, '\\|');
const joinNames = (names) => (names.length < 2 ? names.join('')
  : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

function dependencySection(title, intro, items) {
  const lines = [`## ${title}`, '', intro, ''];
  lines.push('| Name | Version | License | Source |', '| --- | --- | --- | --- |');
  for (const item of items) {
    lines.push(`| ${cell(item.name)} | ${cell(item.version)} | ${cell(item.license)} | ${cell(item.repository)} |`);
  }
  lines.push('');
  const mpl = [...new Set(items.filter((item) => /\bMPL-2\.0\b/i.test(item.license)).map((item) => item.name))];
  if (mpl.length) {
    const one = mpl.length === 1;
    lines.push(`${joinNames(mpl)} ${one ? 'is' : 'are'} MPL-2.0 licensed and used unmodified; source at the linked `
      + `${one ? 'repository' : 'repositories'}.`, '');
  }
  const groups = groupTexts(items);
  lines.push(`### ${title}: license texts`, '');
  for (const group of groups) {
    lines.push(`#### ${group.kind}`, '', `Used by ${group.users.map(label).join(', ')}.`, '');
    if (group.copyrights.length) {
      lines.push('Copyright lines in their copies of this license:', '');
      lines.push(...group.copyrights.map((line) => `- ${line}`), '');
    }
    lines.push(fence(group.text), '');
  }
  const missing = items.filter((item) => item.files.length === 0);
  if (missing.length) {
    lines.push(`### ${title}: no license file`, '',
      'These don\'t include a license file; their declared license applies, with its standard text.', '');
    for (const item of missing) lines.push(`- ${label(item)}: ${item.license}`);
    lines.push('');
  }
  return { lines, groups };
}

function render() {
  const lines = ['# Third-party notices', '', INTRO, '', '## Bundled and adapted', ''];
  for (const entry of BUNDLED) {
    lines.push(`### ${entry.name}`, '', `- Source: ${entry.url}`, `- License: ${entry.license}`,
      ...entry.copyright.map((line) => `- ${line}`), `- Used for: ${entry.use}`);
    if (entry.note) lines.push(`- ${entry.note}`);
    const text = entry.text ?? (entry.file ? readText(join(root, 'node_modules', entry.file)) : mit(...entry.copyright));
    lines.push('', fence(text), '');
  }

  const packages = npmPackages();
  const npm = dependencySection('JavaScript packages',
    'Every npm package the app\'s frontend can bundle: the dependencies in package.json and, in turn, theirs.',
    packages);

  const crates = rustCrates();
  const rust = dependencySection('Rust crates',
    `Every crate compiled into the app and its core plugin, for ${RUST_TARGET}: their dependencies and, in turn, `
      + 'theirs.',
    crates);

  lines.push(...npm.lines, ...rust.lines);
  return {
    markdown: `${lines.join('\n').replace(/\n+$/, '')}\n`,
    summary: {
      packages: packages.length,
      crates: crates.length,
      texts: npm.groups.length + rust.groups.length,
      flagged: [...packages, ...crates].filter((item) => NON_PERMISSIVE.test(item.license)),
    },
  };
}

const { markdown, summary } = render();
const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
const flagged = summary.flagged.map((item) => `${label(item)} (${item.license})`);
if (flagged.length) console.warn(`Check these licenses: ${flagged.join(', ')}`);

if (process.argv.includes('--check')) {
  if (current !== markdown) {
    console.error('THIRD_PARTY_NOTICES.md is out of date; run bun run notices and commit it.');
    process.exit(1);
  }
  console.log('THIRD_PARTY_NOTICES.md is up to date.');
} else {
  if (current !== markdown) writeFileSync(OUTPUT, markdown);
  const size = Buffer.byteLength(markdown);
  console.log(`${current === markdown ? 'Unchanged' : 'Wrote'} THIRD_PARTY_NOTICES.md: ${summary.packages} npm `
    + `packages, ${summary.crates} crates, ${summary.texts} license texts, ${(size / 1024).toFixed(0)} KB.`);
}
