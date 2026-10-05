import { describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChangesHeader } from '../src/components/FileChanges';
import { I18nProvider } from '../src/i18n';
import { canPreview, parseDiffStyle } from '../src/services/fileView';

describe('the diff layout', () => {
  it('is one column until side by side is chosen, and anything else saved reads as the default', () => {
    expect(parseDiffStyle('split')).toBe('split');
    expect(parseDiffStyle('unified')).toBe('unified');
    for (const raw of [null, undefined, '', 'Split', 'side-by-side', '{"style":"split"}']) expect(parseDiffStyle(raw)).toBe('unified');
  });
});

describe('previewable files', () => {
  it('are the agents’ skill and instruction files, wherever they are', () => {
    for (const path of ['SKILL.md', '~/.claude/CLAUDE.md', '~/.codex/AGENTS.md', 'agents.md', 'skills/review/Skill.md']) expect(canPreview(path)).toBe(true);
    for (const path of ['README.md', 'reference/palette.md', 'CLAUDE.md.bak', '~/.claude/settings.json', 'SKILL.md/notes.txt', '']) expect(canPreview(path)).toBe(false);
  });
});

const render = (node: ReactNode) => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);

describe('the changes header', () => {
  it('offers Preview and Source for a file that can be previewed, and the layout for any', () => {
    const markdown = render(<ChangesHeader before="cam-mbp" after="ci-01" path="~/.claude/CLAUDE.md" view="source" onView={() => {}} />);
    expect(markdown).toContain('cam-mbp');
    expect(markdown).toContain('ci-01');
    expect(markdown).toContain('Preview');
    expect(markdown).toContain('Source');
    expect(markdown).toContain('aria-label="Layout"');
    // The − and + are only drawn, so a screen reader hears which copy is which in the words each line is read with.
    expect(markdown).toContain('<span class="sr-only">Removed: </span>cam-mbp');
    expect(markdown).toContain('<span class="sr-only">Added: </span>ci-01');
    const settings = render(<ChangesHeader before="cam-mbp" after="ci-01" path="~/.claude/settings.json" view="source" onView={() => {}} />);
    expect(settings).not.toContain('Preview');
    expect(settings).toContain('aria-label="Layout"');
  });
});
