import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReleaseNoteSections, UpdatePillNotes } from '../src/components/UpdateReleaseNotes';
import { I18nProvider } from '../src/i18n';
import { ARBOR_RELEASES_URL, arborReleaseUrl, NO_RELEASE_NOTES, type ReleaseNotesView } from '../src/services/releaseNotes';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const view: ReleaseNotesView = {
  sections: [
    { version: '0.3.59', summary: 'Updates show what they change.', changes: ['Show release notes on the update pill'], moreChanges: 4 },
    { version: '0.3.58', changes: ['Show sessions on a live board'], moreChanges: 1 },
    { version: '0.3.57', changes: ['Bundle core 7.3.17'], moreChanges: 0 },
  ],
  olderReleases: 2,
};

const sections = (titleNewest: boolean) => text(renderToStaticMarkup(
  <I18nProvider>
    <ReleaseNoteSections view={view} releaseUrl={arborReleaseUrl} releasesUrl={ARBOR_RELEASES_URL} titleNewest={titleNewest} />
  </I18nProvider>,
));

describe('release notes', () => {
  it('head the newest release “What’s changed” on the pill, and send the rest to GitHub', () => {
    expect(sections(true)).toBe([
      'What’s changed Updates show what they change. Show release notes on the update pill 4 more changes on GitHub',
      'Changes in v0.3.58 Show sessions on a live board 1 more change on GitHub',
      'Changes in v0.3.57 Bundle core 7.3.17 View release on GitHub',
      '2 older releases on GitHub',
    ].join(' '));
  });

  it('head every release by its version elsewhere', () => {
    expect(sections(false)).toStartWith('Changes in v0.3.59 Updates show what they change.');
  });

  it('turn the pill into a card trigger only when there are notes, keeping its tooltip otherwise', () => {
    const pill = (notes: ReleaseNotesView) => renderToStaticMarkup(
      <I18nProvider>
        <UpdatePillNotes
          view={notes}
          enabled
          header="Update available"
          releaseUrl={arborReleaseUrl}
          releasesUrl={ARBOR_RELEASES_URL}
          button={<button type="button" title={notes.sections.length ? undefined : 'Update available'}>Update available</button>}
        />
      </I18nProvider>,
    );
    expect(pill(view)).toContain('aria-haspopup="dialog"');
    expect(pill(view)).not.toContain('title=');
    const plain = pill(NO_RELEASE_NOTES);
    expect(plain).not.toContain('aria-haspopup');
    expect(plain).toContain('title="Update available"');
  });
});
