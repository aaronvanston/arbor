import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { draftFromNumber, NumberField, numberFromDraft } from '../src/components/ui/number-field';
import { I18nProvider } from '../src/i18n';
import { getFormatRegion, setFormatRegion } from '../src/lib/format';

const render = (element: ReactElement) => renderToStaticMarkup(<I18nProvider>{element}</I18nProvider>);
/** The text field the user types in, not the hidden one that carries the value in a form. */
const field = (html: string) => html.match(/<input[^>]*data-slot="number-field-input"[^>]*>/)?.[0] ?? '';

describe('number field', () => {
  const before = getFormatRegion();
  beforeAll(() => setFormatRegion({ locale: 'en-AU', hourCycle: 'h23' }));
  afterAll(() => setFormatRegion(before));

  it('shows a port or a count as typed, without thousands separators', () => {
    expect(field(render(<NumberField value={8317} aria-label="Port" />))).toContain('value="8317"');
    expect(field(render(<NumberField value={4294967295} aria-label="Retries" />))).toContain('value="4294967295"');
  });

  it('keeps every decimal of a price per million tokens', () => {
    expect(field(render(<NumberField value={0.0375} step={0.0001} aria-label="Cache read" />))).toContain('value="0.0375"');
  });

  it('is empty rather than zero when it has no number', () => {
    expect(field(render(<NumberField value={null} placeholder="List price" aria-label="Cost" />))).toContain('value=""');
  });

  it('turns the arrow at the end of its range off, without fading the whole field', () => {
    const html = render(<NumberField value={65535} min={1} max={65535} aria-label="Port" />);
    const arrow = (label: string) => html.match(new RegExp(`<[a-z]+[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';
    expect(arrow('Increase')).toContain('aria-disabled="true"');
    expect(arrow('Decrease')).not.toContain('aria-disabled="true"');
    // The group fades on :has(:disabled), which only a disabled button or input matches, so the arrows aren't buttons.
    expect(arrow('Increase')).toStartWith('<span');
    expect(arrow('Increase')).toContain('role="button"');
  });

  it('shows a unit after the number and reads it out with the field', () => {
    const html = render(<NumberField value={100} unit="MB" aria-label="Log size" aria-describedby="hint" />);
    const unitId = html.match(/<span id="([^"]+)"[^>]*>MB<\/span>/)?.[1];
    expect(unitId).toBeTruthy();
    expect(field(html)).toContain(`aria-describedby="hint ${unitId}"`);
  });

  it('carries the state a page gives it to the text field', () => {
    const input = field(render(<NumberField id="port" value={0} aria-invalid aria-label="Port" />));
    expect(input).toContain('id="port"');
    expect(input).toContain('aria-invalid="true"');
  });
});

describe('number field drafts', () => {
  it('reads a draft as the number it holds, and blank or junk as empty', () => {
    expect(numberFromDraft('8317')).toBe(8317);
    expect(numberFromDraft(' 2.5 ')).toBe(2.5);
    expect(numberFromDraft('-1')).toBe(-1);
    expect(numberFromDraft('')).toBeNull();
    expect(numberFromDraft('  ')).toBeNull();
    expect(numberFromDraft('abc')).toBeNull();
  });

  it('writes a number back as the draft a page checks, and an emptied field as blank', () => {
    expect(draftFromNumber(22)).toBe('22');
    expect(draftFromNumber(0.0375)).toBe('0.0375');
    expect(draftFromNumber(0)).toBe('0');
    expect(draftFromNumber(null)).toBe('');
  });
});
