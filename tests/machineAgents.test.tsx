import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, translate } from '../src/i18n';
import { AgentCopies, updateOutcomeText } from '../src/pages/MachineAgents';
import type { AgentInstall } from '../src/native/types';

const t = (key: Parameters<typeof translate>[0], variables?: Record<string, string | number>) => translate(key, variables);

describe('what an agent update says it did', () => {
  it('names both versions when the version moved on', () => {
    expect(updateOutcomeText(t, 'codex', { before: '0.155.0', after: '0.156.0', output: '' })).toBe('Updated Codex from 0.155.0 to 0.156.0.');
  });

  it("says a version that didn't move is unchanged, not the latest", () => {
    const text = updateOutcomeText(t, 'claude', { before: '2.1.281', after: '2.1.281', output: '' });
    expect(text).toBe('Unchanged, still Claude Code 2.1.281.');
    expect(text).not.toContain('latest');
  });

  it("says only that it finished when a version couldn't be read", () => {
    expect(updateOutcomeText(t, 'codex', { before: null, after: null, output: '' })).toBe('The Codex update finished.');
    expect(updateOutcomeText(t, 'codex', { before: '0.155.0', after: null, output: '' })).toBe('The Codex update finished.');
  });
});

describe('an agent installed more than once', () => {
  const install: AgentInstall = {
    version: '0.156.0',
    path: '/Users/casey/.npm-global/bin/codex',
    real: '/Users/casey/.npm-global/lib/node_modules/@openai/codex/bin/codex.js',
    method: 'npm',
    updateCommand: 'npm install -g @openai/codex@latest',
    copies: [],
  };
  const render = (value: AgentInstall) => renderToStaticMarkup(<I18nProvider><AgentCopies agent="codex" install={value} /></I18nProvider>);

  it('says nothing about an agent installed once', () => {
    expect(render(install)).toBe('');
  });

  it('lists every copy with its version, the one the shell finds first at the top', () => {
    const html = render({
      ...install,
      copies: [
        { path: '/opt/homebrew/bin/codex', real: '/opt/homebrew/Caskroom/codex/0.153.3/codex', version: '0.153.3' },
        { path: '/usr/local/bin/codex', real: null, version: null },
      ],
    });
    expect(html).toContain('Codex is installed 3 times here');
    // A path is split to be cut in the middle, so each is found by where it leads, shown on hover.
    const first = html.indexOf('title="/Users/casey/.npm-global/lib/node_modules/@openai/codex/bin/codex.js"');
    const cask = html.indexOf('title="/opt/homebrew/Caskroom/codex/0.153.3/codex"');
    expect(first).toBeGreaterThan(-1);
    expect(cask).toBeGreaterThan(first);
    expect(html.indexOf('Found first')).toBeGreaterThan(first);
    expect(html.indexOf('Found first')).toBeLessThan(cask);
    expect(html).toContain('title="/usr/local/bin/codex"');
    expect(html).toContain('0.153.3');
    expect(html).toContain('Version unknown');
  });
});
