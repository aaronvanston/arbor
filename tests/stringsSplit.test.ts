import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { importsOf, jsonParseCode, keysNamed, partOf, splitSource } from '../scripts/vite-split-strings.mjs';
import { en } from '../src/i18n/locales/en';

const ROOT = join(import.meta.dir, '..');

describe('the UI strings split', () => {
  test('a build ships what the launch names with the app, and every other string with the lazy code that names it', () => {
    for (const mode of ['production', 'demo']) {
      const { core, parts, lazy, unnamed } = splitSource(ROOT, mode);
      expect(unnamed).toEqual([]);
      const rest = Object.values(parts).flatMap((part) => Object.keys(part));
      expect(Object.keys(core).length + rest.length).toBe(Object.keys(en).length);
      // The monitors' alerts load with the app; the shell and Home with App.tsx, which a launch loads straight away and
      // a reload into the background only once the window shows.
      const app = lazy.get(join(ROOT, 'src/App.tsx')) ?? [];
      const atLaunch = (key: string) => key in core || app.includes(partOf(key));
      for (const key of ['app.nav.home', 'home.start.agent.title', 'palette.open', 'status.indicator.major']) expect(atLaunch(key)).toBe(true);
      const launchStrings = Object.keys(en).filter(atLaunch);
      expect(launchStrings.length).toBeLessThan(Object.keys(en).length / 2);
      // A page brings its own, and not another page's.
      const setup = lazy.get(join(ROOT, 'src/pages/SetupPage.tsx')) ?? [];
      const alerts = lazy.get(join(ROOT, 'src/pages/AlertsPage.tsx')) ?? [];
      expect(setup).toContain(partOf('setup.toolchain.loadFailed'));
      expect(alerts).not.toContain(partOf('setup.toolchain.loadFailed'));
    }
  });

  test('a key counts as named whole, or by the fixed start of a template that builds it', () => {
    const keys = new Set(['status.indicator.none', 'status.indicator.major', 'status.banner.title', 'app.nav.home', 'app.nav.homeless']);
    expect([...keysNamed("t('app.nav.home')", keys)]).toEqual(['app.nav.home']);
    expect([...keysNamed('t(`status.indicator.${status}`)', keys)].sort()).toEqual(['status.indicator.major', 'status.indicator.none']);
    expect([...keysNamed('"app.nav"', keys)]).toEqual([]);
  });

  test('only value imports are followed, and import() is told apart from a type that names one', () => {
    const source = [
      "import type { A } from './types';",
      "import { b, type C } from './values';",
      "export { d } from '../shared';",
      "import './side-effect';",
      "type P = typeof import('./typeOnly');",
      "const page = () => import('./pages/Page');",
    ].join('\n');
    expect(importsOf(source)).toEqual({ statics: ['./values', '../shared', './side-effect'], dynamics: ['./pages/Page'], unnamed: false });
    expect(importsOf('const load = (path) => import(path);').unnamed).toBe(true);
  });

  test('the strings survive JSON.parse unchanged, quotes, backslashes and line separators included', () => {
    const table = { a: 'it\'s "quoted"', b: 'back\\slash', c: 'line\u2028separator\u2029', d: 'curly ’ quote' };
    // The code a build emits.
    expect(new Function(`return ${jsonParseCode(table)};`)()).toEqual(table);
  });
});
