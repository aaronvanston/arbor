import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutomationSettings } from '../src/components/automations/AutomationSettings';
import { I18nProvider, translate } from '../src/i18n';
import type { AutomationList } from '../src/native/types';
import { showAutomations } from '../src/services/automations';

const list = (fields: Partial<AutomationList>): AutomationList => ({
  automations: [],
  scans: [],
  running: true,
  draftModel: 'gpt-6-luna',
  draftEffort: 'low',
  udianBundled: '1.0.0',
  udianSkill: null,
  agents: ['claude', 'codex'],
  proxyKey: true,
  proxyAddress: '',
  appsOff: [],
  ...fields,
});
const render = (value: AutomationList) => {
  showAutomations(value);
  return renderToStaticMarkup(<I18nProvider><AutomationSettings /></I18nProvider>);
};

describe('automation settings', () => {
  it('offers the Automations proxy key only while the proxy lacks it', () => {
    const missing = render(list({ proxyKey: false }));
    expect(missing).toContain(translate('automations.proxy.add'));
    expect(missing).toContain(translate('automations.proxy.keyMissing'));
    const ready = render(list({}));
    expect(ready).not.toContain(`>${translate('automations.proxy.add')}<`);
    expect(ready).toContain(translate('automations.proxy.keyReady'));
  });

  it('names the drafting model and its effort on their pickers', () => {
    const html = render(list({ draftModel: 'gpt-6-luna', draftEffort: 'medium' }));
    expect(html).toContain('data-slot="model-picker-trigger"');
    expect(html).toContain('title="gpt-6-luna"');
    expect(html).toContain(`>${translate('modelPicker.effort.medium')}<`);
    // An effort Arbor has no word for shows as the core spells it.
    expect(render(list({ draftEffort: 'turbo' }))).toContain('>turbo<');
  });

  it('shows the address machines try first, as saved', () => {
    expect(render(list({ proxyAddress: 'https://proxy.example.net:8443' }))).toContain('value="https://proxy.example.net:8443"');
  });
});
