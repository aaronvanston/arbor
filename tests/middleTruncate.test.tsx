import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MiddleTruncate } from '../src/components/ui/middle-truncate';
import { splitForMiddleTruncate } from '../src/lib/middleTruncate';

describe('where a long path or branch is cut', () => {
  it('keeps a path’s last segment when it is short', () => {
    expect(splitForMiddleTruncate('~/.agent-app/worktrees/arbor/task-5c8a4774')).toEqual({ head: '~/.agent-app/worktrees/arbor/', tail: 'task-5c8a4774' });
    expect(splitForMiddleTruncate('.claude/skills/review/SKILL.md')).toEqual({ head: '.claude/skills/review/', tail: 'SKILL.md' });
  });

  it('keeps ten characters of a branch, or of a path whose last segment is long', () => {
    expect(splitForMiddleTruncate('fix/cache-main-20260918-180825')?.tail).toBe('918-180825');
    expect(splitForMiddleTruncate('release-candidate-2026-09-26')?.tail).toBe('2026-09-26');
  });

  it('keeps as many characters as it is told', () => {
    expect(splitForMiddleTruncate('abcdefghijklmnop', 3)).toEqual({ head: 'abcdefghijklm', tail: 'nop' });
  });

  it('leaves a value whole when the tail would be most of it', () => {
    expect(splitForMiddleTruncate('main')).toBeNull();
    expect(splitForMiddleTruncate('src/index')).toBeNull();
    expect(splitForMiddleTruncate('—')).toBeNull();
    expect(splitForMiddleTruncate('abcdefgh', 0)).toBeNull();
  });

  it('never cuts next to a space, which each half would drop, running two words together', () => {
    expect(splitForMiddleTruncate('Claude Sonnet 4.5')).toEqual({ head: 'Claud', tail: 'e Sonnet 4.5' });
    expect(splitForMiddleTruncate('Cam laptop key')).toBeNull();
    for (const value of [
      'Claude Sonnet 4.5',
      'studio cedar 01 laptop',
      'Gemini  2.5  Flash  Lite',
      '~/Library/Mobile Documents/com~apple~CloudDocs/Project notes for the offsite.md',
      '/Volumes/Backup/Arbor backups/setup backups 2026 09 26',
    ]) {
      const split = splitForMiddleTruncate(value);
      if (!split) continue;
      expect(`${split.head}${split.tail}`).toBe(value);
      expect(split.head).not.toMatch(/\s$/);
      expect(split.tail).not.toMatch(/^\s/);
      expect(split.tail.length).toBeGreaterThanOrEqual(10);
    }
    // A path's short last segment still starts right after its slash.
    expect(splitForMiddleTruncate('~/Mobile Documents/My Notes')).toEqual({ head: '~/Mobile Documents/', tail: 'My Notes' });
  });

  it('never cuts a character in half', () => {
    const split = splitForMiddleTruncate('notes-🌳🌳🌳🌳🌳🌳🌳🌳🌳🌳🌳🌳', 5);
    expect(split?.tail).toBe('🌳🌳🌳🌳🌳');
    expect(`${split?.head}${split?.tail}`).toBe('notes-🌳🌳🌳🌳🌳🌳🌳🌳🌳🌳🌳🌳');
  });
});

describe('middle truncate', () => {
  it('shows the head, which shortens, then the tail, which doesn’t, with the whole value as the title', () => {
    const html = renderToStaticMarkup(<MiddleTruncate value="~/src/dev/tools/EasyCLIProxyAPI" className="font-mono" />);
    expect(html).toContain('title="~/src/dev/tools/EasyCLIProxyAPI"');
    expect(html).toContain('<span class="min-w-0 truncate">~/src/dev/tools/</span><span class="shrink-0">EasyCLIProxyAPI</span>');
    expect(html).toMatch(/class="[^"]*\bfont-mono\b/);
  });

  it('truncates a short value at the end, as before', () => {
    expect(renderToStaticMarkup(<MiddleTruncate value="main" />)).toContain('<span class="min-w-0 truncate">main</span>');
  });

  it('takes a title in place of the value, or none', () => {
    expect(renderToStaticMarkup(<MiddleTruncate value="…/wt/fix-login" title="/Users/me/repo/wt/fix-login" />)).toContain('title="/Users/me/repo/wt/fix-login"');
    expect(renderToStaticMarkup(<MiddleTruncate value="—" title={undefined} />)).not.toContain('title=');
  });
});
