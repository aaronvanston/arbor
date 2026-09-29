import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { translate } from '../src/i18n';
import type { MessageKey, MessageVariables } from '../src/i18n/resources';
import { settingsPageIds } from '../src/navigation';
import { SETTINGS_INDEX, currentSettingId, indexSettings, revealStep, searchSettings, settingEntry, settingScore } from '../src/services/settingsIndex';
import { itemAt, present } from './support/items';

const t = (key: MessageKey, variables?: MessageVariables) => translate(key, variables);
const index = indexSettings(t);
const titles = (query: string) => searchSettings(index, query).map((group) => `${group.label}: ${group.settings.map((setting) => setting.title).join(' | ')}`);

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}
/** Every `settingId="…"` the pages render. */
const renderedIds = sourceFiles(sourceRoot).flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/settingId="([^"]+)"/g)].map((match) => match[1] ?? ''));

describe('the Settings index', () => {
  it('names each setting once, under the page it is on', () => {
    const ids = SETTINGS_INDEX.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of SETTINGS_INDEX) {
      expect(settingsPageIds).toContain(entry.page);
      expect(entry.id.startsWith(`${entry.page}.`)).toBe(true);
    }
    // Every page has something to find.
    expect(new Set(SETTINGS_INDEX.map((entry) => entry.page))).toEqual(new Set(settingsPageIds));
  });

  it('matches the rows the pages render, both ways, so search always has somewhere to land', () => {
    const indexed = new Set(SETTINGS_INDEX.map((entry) => entry.id));
    expect(renderedIds.filter((id) => !indexed.has(id))).toEqual([]);
    expect([...indexed].filter((id) => !renderedIds.includes(id))).toEqual([]);
  });

  it('falls back only to a setting on the same page that is always there', () => {
    for (const entry of SETTINGS_INDEX.filter((item) => item.fallback)) {
      const fallback = present(settingEntry(entry.fallback), entry.fallback);
      expect(fallback.page).toBe(entry.page);
      expect(fallback.fallback).toBeUndefined();
    }
  });

  it('reads a description that takes a value without its placeholder', () => {
    const expiring = present(index.find((setting) => setting.entry.id === 'notifications.expiring'));
    expect(expiring.words).not.toContain('{percent}');
    expect(expiring.words).toContain('headline limit left');
  });
});

describe('Settings search', () => {
  it('finds nothing until something is typed', () => {
    expect(searchSettings(index, '')).toEqual([]);
    expect(searchSettings(index, '   ')).toEqual([]);
  });

  it('groups what matches by page, the page with the best match first', () => {
    expect(titles('tls')).toEqual(['Proxy: Enable TLS | Certificate path | Private key path']);
    const retry = searchSettings(index, 'retry');
    expect(itemAt(retry, 0).page).toBe('general');
    // A title with the word in it comes before one found only by its section.
    expect(itemAt(itemAt(retry, 0).settings, 0).title).toMatch(/retry/i);
    expect(itemAt(retry, 0).settings.map((setting) => setting.title)).toContain('Request retries');
  });

  it('ranks a title that starts with the words over one that only holds them, and both over the description', () => {
    const tray = present(index.find((setting) => setting.entry.id === 'appearance.tray-limits'));
    const theme = present(index.find((setting) => setting.entry.id === 'appearance.theme'));
    expect(settingScore(theme, 'theme')).toBe(0);
    expect(settingScore(tray, 'tray')).toBe(1);
    expect(settingScore(tray, 'ray')).toBe(2);
    expect(settingScore(tray, 'sidebar')).toBe(3);
    expect(settingScore(theme, 'dark mode')).toBe(4);
    expect(settingScore(theme, 'nothing like it')).toBeNull();
  });

  it('finds a setting by its section, its page or the other words it is known by', () => {
    expect(titles('phone')[0]).toContain('Notifications');
    const byKeyword = searchSettings(index, 'pushover').flatMap((group) => group.settings.map((setting) => setting.entry.id));
    expect(byKeyword).toContain('notifications.phone-service');
    const byPage = searchSettings(index, 'appearance').flatMap((group) => group.settings.map((setting) => setting.entry.id));
    expect(byPage).toContain('appearance.tray-sessions');
    // Reset Zoom is what other apps call going back to actual size.
    expect(titles('reset zoom')).toEqual(['Appearance: Zoom']);
  });
});

describe('a setting whose row moved page', () => {
  it('is found by the id it was saved under, as Network’s rows are on Proxy now', () => {
    expect(currentSettingId('network.port')).toBe('general.port');
    expect(currentSettingId('general.debug')).toBe('general.debug');
    expect(present(settingEntry('network.tls-cert')).id).toBe('general.tls-cert');
  });
});

describe('bringing a picked setting into view', () => {
  const cert = present(settingEntry('general.tls-cert'));
  const on = (...ids: string[]) => (id: string) => ids.includes(id);

  it('lands on the row as soon as its page shows it', () => {
    expect(revealStep(cert, on('general.tls-cert', 'general.tls'), 0)).toEqual({ reveal: 'general.tls-cert' });
  });

  it('waits a moment for a row still loading before landing on the one that stands in for it', () => {
    expect(revealStep(cert, on('general.tls'), 100)).toBe('wait');
    expect(revealStep(cert, on('general.tls'), 800)).toEqual({ reveal: 'general.tls' });
    // With neither there yet, it keeps waiting, and gives up in the end.
    expect(revealStep(cert, on(), 2_000)).toBe('wait');
    expect(revealStep(cert, on(), 4_000)).toBe('give-up');
    expect(revealStep(present(settingEntry('general.port')), on(), 4_000)).toBe('give-up');
  });
});
