import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cn } from '../src/lib/utils';

/*
 * Type sizes and letter spacing come from the named steps in styles.css (text-3xs to text-sm and up,
 * and tracking-title), so one-off values like text-[11px] or tracking-[0.08em] don't creep
 * back in and drift from the scale.
 */

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const styles = readFileSync(join(sourceRoot, 'styles.css'), 'utf8');

// An arbitrary font size (text-[11px], text-[.625rem], text-[length:12px], text-[calc(...)]) or letter spacing. Colors
// such as text-[var(--sidebar-icon-color)] are fine.
const oneOff = /\btext-\[(?:length:)?(?:[\d.]|(?:calc|clamp|min|max)\()[^\]]*\]|\btracking-\[[^\]]*\]/g;

// `path: class` pairs that have to stay, each with its reason. Keep this short; add a named step to styles.css instead
// when a size or spacing is used in more than one place.
const allowed = new Map<string, string>();

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(entry.name) ? [path] : [];
  });
}

/** The names of the theme's own steps in a namespace, e.g. `text` gives 2xs and 3xs. */
function themeSteps(namespace: string): string[] {
  return [...styles.matchAll(new RegExp(`--${namespace}-([a-z0-9]+):`, 'g'))].flatMap(([, name]) => (name ? [name] : []));
}

describe('type scale', () => {
  it('uses the named sizes and letter spacings rather than one-off values', () => {
    const found: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        for (const [match] of line.matchAll(oneOff)) {
          const key = `${relative(sourceRoot, file)}: ${match}`;
          if (!allowed.has(key)) found.push(`src/${relative(sourceRoot, file)}:${index + 1}: ${match}`);
        }
      });
    }
    expect(found).toEqual([]);
  });

  it('registers every theme size and letter spacing with cn', () => {
    // Finding no steps would let this pass with nothing checked.
    expect(themeSteps('text')).not.toEqual([]);
    expect(themeSteps('tracking')).not.toEqual([]);
    for (const name of themeSteps('text')) {
      // A font size, so a later size replaces it and a color sits beside it.
      expect(cn('text-sm', `text-${name}`)).toBe(`text-${name}`);
      expect(cn(`text-${name}`, 'text-muted-foreground')).toBe(`text-${name} text-muted-foreground`);
    }
    for (const name of themeSteps('tracking')) {
      expect(cn('tracking-wide', `tracking-${name}`)).toBe(`tracking-${name}`);
      expect(cn(`tracking-${name}`, 'tracking-normal')).toBe('tracking-normal');
    }
  });
});
