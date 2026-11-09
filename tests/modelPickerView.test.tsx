import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelPicker } from '../src/components/ModelPicker';
import { I18nProvider, translate } from '../src/i18n';

const render = (value: string, defaultLabel?: string) => renderToStaticMarkup(
  <I18nProvider>
    <ModelPicker aria-label="Model" value={value} models={{ status: 'ready', choices: [] }} onChange={() => {}} onRetry={() => {}} {...(defaultLabel ? { defaultLabel } : {})} />
  </I18nProvider>,
);

describe('the model picker’s button', () => {
  it('names the model it’s set to', () => {
    expect(render('gpt-6-luna')).toContain('title="gpt-6-luna"');
  });

  it('asks for a model when none is set, unless none is a choice of its own', () => {
    expect(render('')).toContain(translate('modelPicker.pick'));
    const left = render('', 'The agent’s own');
    expect(left).toContain('The agent’s own');
    expect(left).not.toContain(translate('modelPicker.pick'));
  });
});
