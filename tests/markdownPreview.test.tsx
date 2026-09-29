import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownPreview } from '../src/components/MarkdownPreview';
import { I18nProvider } from '../src/i18n';
import { externalUrl, splitFrontMatter } from '../src/services/markdownPreview';

describe('front matter', () => {
  it('is only a --- block that opens the file and closes', () => {
    expect(splitFrontMatter('# Title\n\n---\nname: x\n---\n')).toEqual({ frontMatter: null, body: '# Title\n\n---\nname: x\n---\n' });
    expect(splitFrontMatter('---\nname: x\nno end')).toEqual({ frontMatter: null, body: '---\nname: x\nno end' });
    expect(splitFrontMatter('')).toEqual({ frontMatter: null, body: '' });
    expect(splitFrontMatter('---\n---\nBody')).toEqual({ frontMatter: [], body: 'Body' });
  });

  it('reads plain and quoted values, and splits off the markdown after it', () => {
    const { frontMatter, body } = splitFrontMatter([
      '﻿---\r',
      'name: release-notes\r',
      'description: "Use when: the user asks for notes, \\"quoted\\""\r',
      "title: 'It''s here'\r",
      'model: opus # the big one\r',
      'empty:\r',
      '# a comment\r',
      '---\r',
      '# Release notes\r',
    ].join('\n'));
    expect(frontMatter).toEqual([
      { key: 'name', value: 'release-notes' },
      { key: 'description', value: 'Use when: the user asks for notes, "quoted"' },
      { key: 'title', value: 'It\'s here' },
      { key: 'model', value: 'opus' },
      { key: 'empty', value: '' },
    ]);
    expect(body).toBe('# Release notes\n');
  });

  it('joins lists, keeps block text, and folds carried-on lines', () => {
    const { frontMatter } = splitFrontMatter([
      '---',
      'allowed-tools: [Read, "Bash(git:*)", Grep]',
      'tools:',
      '  - Read',
      '  - Write # not this',
      'compact:',
      '- one',
      '- two',
      'literal: |',
      '  First line',
      '  # still text',
      '',
      '  Last line',
      'folded: >-',
      '  One',
      '  sentence.',
      '',
      '  Next.',
      'long: starts here',
      '  and carries on',
      'metadata:',
      '  version: 2',
      '  owner: casey',
      '...',
      'Body',
    ].join('\n'));
    expect(frontMatter).toEqual([
      { key: 'allowed-tools', value: 'Read, Bash(git:*), Grep' },
      { key: 'tools', value: 'Read, Write' },
      { key: 'compact', value: 'one, two' },
      { key: 'literal', value: 'First line\n# still text\n\nLast line' },
      { key: 'folded', value: 'One sentence.\nNext.' },
      { key: 'long', value: 'starts here and carries on' },
      { key: 'metadata', value: 'version: 2\nowner: casey' },
    ]);
  });
});

describe('links in a preview', () => {
  it('open only http and https addresses', () => {
    expect(externalUrl('https://example.com/docs')).toBe('https://example.com/docs');
    expect(externalUrl('http://example.com')).toBe('http://example.com/');
    for (const href of ['javascript:alert(1)', 'mailto:a@example.com', 'file:///etc/passwd', 'reference.md', '#usage', '', null, undefined]) {
      expect(externalUrl(href)).toBeNull();
    }
  });
});

const render = (source: string) => renderToStaticMarkup(<I18nProvider><MarkdownPreview source={source} /></I18nProvider>);
// A real element carrying an event handler, as opposed to its text shown escaped.
const handler = /<[a-z][^>]*\son[a-z]+=/i;

describe('the markdown preview', () => {
  it('shows front matter as keys and values, not as markdown', () => {
    const html = render('---\nname: reviewer\ndescription: Reviews a change.\n---\n\n# Reviewer\n\nRead the diff.\n');
    expect(html).toContain('<dl aria-label="Front matter"');
    expect(html).toMatch(/<dt[^>]*>name<\/dt><dd[^>]*>reviewer<\/dd>/);
    expect(html).toContain('<h1');
    expect(html).not.toContain('<hr');
    expect(html).not.toContain('name: reviewer');
  });

  it('never renders HTML from the file: a script and an onerror attribute show as text', () => {
    const html = render([
      '# Notes',
      '',
      '<script>alert(1)</script>',
      '',
      'Inline <img src=x onerror="alert(2)"> and <b onclick="alert(3)">bold</b>.',
      '',
      '<img src="https://example.com/pixel.gif" onerror="alert(4)">',
      '',
      '<!-- a note to self -->',
    ].join('\n'));
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b ');
    expect(html).not.toMatch(handler);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('a note to self');
  });

  it('keeps prompt tags like <example> readable', () => {
    expect(render('<example>\nUser: hi\n</example>\n')).toContain('&lt;example&gt;\nUser: hi\n&lt;/example&gt;');
  });

  it('never loads an image, showing its description instead', () => {
    const html = render('![The logo](https://example.com/logo.png) and ![](data:image/png;base64,AAAA)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('src=');
    expect(html).toContain('The logo');
    expect(html).toContain('title="Not loaded: https://example.com/logo.png"');
    expect(html).toContain('>Image<');
  });

  it('links only to web addresses, and nothing else becomes a link', () => {
    const html = render('[Docs](https://example.com/docs), [run](javascript:alert(1)), [ref](reference.md) and <https://example.com/auto>.');
    expect(html).toContain('title="Opens in your browser: https://example.com/docs"');
    expect(html).toContain('title="Opens in your browser: https://example.com/auto"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('reference.md');
    expect((html.match(/role="link"/g) ?? []).length).toBe(2);
    expect(html).toMatch(/role="link" tabindex="0"/);
    expect(html).toContain('>ref<');
  });

  it('gives a link no address the webview could follow into Arbor’s window', () => {
    const html = render('[Docs](https://example.com/docs) and <https://example.com/auto>.');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href=');
  });

  it('renders GitHub tables and task lists', () => {
    const html = render('| Tool | Use |\n| --- | :-: |\n| Read | always |\n\n- [x] Done\n- [ ] Not yet\n');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('text-align:center');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
    expect(html).toContain('Not yet');
  });

  it('says so when the file has nothing in it', () => {
    expect(render('')).toContain('The file is empty.');
    expect(render('---\nname: x\n---\n')).not.toContain('The file is empty.');
  });
});
