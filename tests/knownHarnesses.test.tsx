import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { KnownHarnesses } from '../src/pages/AgentHomesSettings';
import { knownHarnessOrder } from '../src/services/knownHarnesses';
import type { Harness, HarnessInfo } from '../src/native/types';

const info = (harness: Harness, found: boolean, foundOn: string[] = []): HarnessInfo => ({
  harness, binary: harness, home: `~/.${harness}`, projectInstructions: [], skills: [], sync: true, automations: false, limitsEdits: false, found, foundOn,
});

const CATALOG = [info('claude', true, ['cam-mbp']), info('codex', true), info('pi', false), info('droid', true, ['cedar-02']), info('amp', false)];
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('the harnesses Arbor knows', () => {
  it('lists the ones some machine has first, each group in the catalog order', () => {
    expect(knownHarnessOrder(CATALOG).map((entry) => entry.harness)).toEqual(['claude', 'codex', 'droid', 'pi', 'amp']);
    expect(knownHarnessOrder([])).toEqual([]);
  });

  it('says where each was found, and marks the ones no machine has', () => {
    const html = renderToStaticMarkup(<I18nProvider><KnownHarnesses harnesses={CATALOG} /></I18nProvider>);
    const rows = html.split('<tr').slice(2).map((row) => text(`<tr${row}`));
    expect(rows.map((row) => row.split(' ')[0])).toEqual(['Claude', 'Codex', 'Droid', 'Pi', 'Amp']);
    expect(rows[0]).toContain('On cam-mbp');
    expect(rows[2]).toContain('On cedar-02');
    // Codex counts as found before any scan has seen it, so it says nothing either way.
    expect(rows[1]).not.toContain('Not found');
    expect(rows[3]).toContain('Not found on a machine right now');
    expect(rows[4]).toContain('Not found on a machine right now');
    expect(html.match(/data-found="false"/g)?.length).toBe(2);
  });
});
