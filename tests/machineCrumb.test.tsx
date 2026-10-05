import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MachineCrumb } from '../src/components/layout/MachineCrumb';
import { I18nProvider } from '../src/i18n';

const render = (machine: string) => renderToStaticMarkup(
  <I18nProvider>
    <MachineCrumb machine={machine} machines={['cam-mbp', 'ci-01']} unassigned onChange={() => {}} />
  </I18nProvider>,
);

/** The breadcrumb's machine picker, by its name. */
const picker = (html: string) => html.match(/<button(?=[^>]*aria-label="Machine to show")[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';

describe('the breadcrumb’s machine picker', () => {
  it('names the machine a view is narrowed to, every machine, or the ones no machine claims', () => {
    expect(picker(render('ci-01'))).toContain('ci-01');
    // One no longer listed, like an old link's, still names itself.
    expect(picker(render('old-box'))).toContain('old-box');
    expect(picker(render(''))).toContain('All machines');
    expect(picker(render('__unassigned__'))).toContain('Unassigned');
  });
});
