import { beforeAll, describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { projectsLensAction } from '../src/components/ProjectsLens';
import { I18nProvider } from '../src/i18n';
import type { SessionsParams } from '../src/navigation';
import { UsageRecordsPage } from '../src/pages/UsageRecordsPage';
import { loadPageModule } from '../src/pageModules';

const bar = (lens: 'checkouts' | undefined) =>
  renderToStaticMarkup(<I18nProvider>{projectsLensAction(lens, () => {}).bar}</I18nProvider>);

/** Each toggle's name and whether it's pressed, in order. */
const toggles = (html: string) =>
  [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)</g)].map((match) => [match[2], match[1]]);

describe('Sessions › Projects’ Activity / Checkouts choice', () => {
  it('names what it chooses, and presses Activity with no lens and Checkouts with its lens', () => {
    expect(bar(undefined)).toContain('aria-label="Look at projects by"');
    expect(toggles(bar(undefined))).toEqual([['Activity', 'true'], ['Checkouts', 'false']]);
    expect(toggles(bar('checkouts'))).toEqual([['Activity', 'false'], ['Checkouts', 'true']]);
  });

  it('folds into the top bar’s ⋯ under the same id on both views, so it keeps its place', () => {
    expect(projectsLensAction(undefined, () => {}).id).toBe(projectsLensAction('checkouts', () => {}).id);
  });
});

describe('Sessions › Projects’ Checkouts', () => {
  // Its code loads before it's opened, as going to it waits for.
  beforeAll(() => loadPageModule('checkouts'));
  const sessions = (params: SessionsParams) =>
    renderToStaticMarkup(<I18nProvider><UsageRecordsPage variant="sessions" params={params} /></I18nProvider>);

  it('shows in place of the Sessions list, as a session does, so the list keeps its search and filters for Activity and Back', () => {
    const checkouts = sessions({ tab: 'projects', lens: 'checkouts' });
    expect(toggles(checkouts)).toEqual([['Activity', 'false'], ['Checkouts', 'true']]);
    // Its own page, with none of the list's search or filters.
    expect(checkouts).not.toContain('aria-label="Search sessions"');
    const activity = sessions({ tab: 'projects' });
    expect(toggles(activity)).toEqual([['Activity', 'true'], ['Checkouts', 'false']]);
    expect(activity).toContain('aria-label="Search sessions"');
  });
});
