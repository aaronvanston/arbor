import { describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HELD_SETTING_CONTROL, SETTING_CONTROL, SettingsRow } from '../src/components/layout/settings';
import { Button } from '../src/components/ui/button';
import { Switch } from '../src/components/ui/switch';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { I18nProvider } from '../src/i18n';
import { resultKeyStep } from '../src/services/settingsIndex';

/** A row as Settings draws it, with its value changed from the default so the reset button shows before the control. */
const row = (control: ReactNode) => renderToStaticMarkup(
  <I18nProvider>
    <TooltipProvider>
      <SettingsRow settingId="appearance.zoom" title="Zoom" reset={{ value: '100%', onReset: () => {} }} control={control} />
    </TooltipProvider>
  </I18nProvider>,
);

/** The labels of what a selector finds in some markup, in document order. */
async function found(html: string, selector: string) {
  const labels: string[] = [];
  const rewriter = new HTMLRewriter().on(selector, { element: (element) => { labels.push(element.getAttribute('aria-label') ?? element.tagName); } });
  await rewriter.transform(new Response(html)).text();
  return labels;
}

/** Where a pick from Settings search puts the keyboard in a row: settingControl's choice, over the same markup. */
async function keyboardLandsOn(html: string) {
  const [usable] = await found(html, SETTING_CONTROL);
  const [held] = await found(html, HELD_SETTING_CONTROL);
  return usable ?? held ?? null;
}

describe('the Settings sidebar search', () => {
  it('steps through the results with the arrows, and goes back to the field from the first or with Escape', () => {
    expect(resultKeyStep('ArrowDown', 0, 3)).toBe(1);
    expect(resultKeyStep('ArrowDown', 2, 3)).toBe(2);
    expect(resultKeyStep('ArrowUp', 2, 3)).toBe(1);
    expect(resultKeyStep('ArrowUp', 0, 3)).toBe('field');
    // Escape on a result goes back to what's typed, never out of Settings in one press.
    expect(resultKeyStep('Escape', 1, 3)).toBe('field');
    // Anything else is the result's own: Enter and Space open it.
    expect(resultKeyStep('Enter', 1, 3)).toBeNull();
    expect(resultKeyStep('a', 1, 3)).toBeNull();
  });
});

describe('a row picked in Settings search', () => {
  it('takes the keyboard to a control that can be used, passing over one held back with a reason', async () => {
    // The Zoom row at the smallest zoom: Zoom out is held back, and Zoom in beside it works.
    const smallest = row(
      <>
        <Button aria-label="Zoom out" disabledReason="Already at the smallest size">-</Button>
        <Button aria-label="Zoom in">+</Button>
      </>,
    );
    expect(await keyboardLandsOn(smallest)).toBe('Zoom in');
    const middle = row(
      <>
        <Button aria-label="Zoom out">-</Button>
        <Button aria-label="Zoom in">+</Button>
      </>,
    );
    expect(await keyboardLandsOn(middle)).toBe('Zoom out');
  });

  it('still lands on a held-back control when the row has nothing else, so it can say why', async () => {
    const held = row(<Button aria-label="Install" disabledReason="Already installed">Install</Button>);
    expect(await keyboardLandsOn(held)).toBe('Install');
    // Never on the reset button, and never on a switch that can't be turned.
    const locked = row(<Switch checked disabled aria-label="Tray limits" />);
    expect(await found(locked, SETTING_CONTROL)).not.toContain('Tray limits');
    expect(await keyboardLandsOn(locked)).toBeNull();
  });
});
