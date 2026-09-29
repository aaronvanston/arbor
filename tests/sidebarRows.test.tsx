import { describe, expect, it } from 'bun:test';
import { Users, type AppIcon } from '../src/components/ui/icons';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidebarRow, SidebarSearchRow } from '../src/components/sidebar/SidebarChrome';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { I18nProvider } from '../src/i18n';

const HINT = 'Start the core to open this';
const render = (node: React.ReactNode) => renderToStaticMarkup(<I18nProvider><TooltipProvider>{node}</TooltipProvider></I18nProvider>);
const row = (locked: boolean) => render(
  <SidebarRow icon={Users} label="Accounts" active={false} locked={locked} lockedHint={HINT} onClick={() => {}} shortcut="go.accounts" />,
);

/** The text of the element a button names as its description, the button being the first tag `button` matches. */
function description(html: string, button: RegExp): string {
  const id = html.match(button)?.[0].match(/aria-describedby="([^"]+)"/)?.[1];
  if (!id) return '';
  return html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`))?.[1] ?? '';
}
const ADD_ACCOUNT = /<button[^>]*aria-label="Add account"[^>]*>/;

describe('a page row that needs the core while it’s down', () => {
  it('stays in the Tab order and gives its reason as its description', () => {
    const html = row(true);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
    expect(html).toContain('aria-disabled="true"');
    expect(description(html, /<button[^>]*>/)).toBe(HINT);
  });

  it('is an ordinary row once the core is back', () => {
    const html = row(false);
    expect(html).not.toContain('aria-disabled="');
    expect(html).not.toContain('aria-describedby');
  });
});

describe('the open page’s icon', () => {
  /** Whether the row asked its icon for the selected (duotone) drawing. */
  const selected = (active: boolean, current: boolean) => {
    let seen: boolean | undefined;
    const Spy: AppIcon = ({ selected: on }) => {
      seen = on;
      return <svg />;
    };
    render(<SidebarRow icon={Spy} label="Accounts" active={active} current={current} locked={false} lockedHint={HINT} onClick={() => {}} />);
    return seen;
  };

  it('is drawn selected while its row or a view under it is lit', () => {
    expect(selected(true, false)).toBe(true);
    expect(selected(false, true)).toBe(true);
    expect(selected(false, false)).toBe(false);
  });

  it('takes the theme’s teal only then', () => {
    expect(render(<SidebarRow icon={Users} label="Accounts" active locked={false} lockedHint={HINT} onClick={() => {}} />))
      .toContain('group-data-[active=true]/row:text-primary');
  });
});

describe('the sidebar’s Add account button while the core is down', () => {
  const searchRow = (coreReady: boolean) => render(
    <SidebarSearchRow coreReady={coreReady} lockedHint={HINT} onSearch={() => {}} onNavigate={() => {}} onAddMachine={() => {}} />,
  );

  it('says why it can’t be used, to a screen reader as well as in its tooltip', () => {
    const html = searchRow(false);
    expect(html.match(ADD_ACCOUNT)?.[0]).toContain('aria-disabled="true"');
    expect(description(html, ADD_ACCOUNT)).toBe(HINT);
  });

  it('has no description once it can be used', () => {
    const button = searchRow(true).match(ADD_ACCOUNT)?.[0] ?? '';
    expect(button).not.toBe('');
    expect(button).not.toContain('aria-describedby');
  });
});
