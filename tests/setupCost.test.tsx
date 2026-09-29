import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { I18nProvider } from '../src/i18n';
import { SetupCost } from '../src/pages/SetupCost';
import type { SetupMachine } from '../src/native/types';

const machine = (name: string): SetupMachine => ({
  machine: name, local: name === 'casey-mbp', reachable: true, homes: [], installs: [], policy: null, scannedAt: null, error: null, scanning: false,
});

const render = (machines: SetupMachine[], picked: string | null) => renderToStaticMarkup(
  <I18nProvider>
    <TooltipProvider>
      <SetupCost machines={machines} homeLabel={(key) => key} machine={picked} onMachineChange={() => {}} reads={0} onNavigate={() => {}} />
    </TooltipProvider>
  </I18nProvider>,
);

/** The opening tag of the machine picker, by its name. */
const picker = (html: string) => html.match(/<button(?=[^>]*aria-label="Machine to count")[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';

describe('Sync › Cost’s Claude Code spend', () => {
  it('narrows to one machine by a picker that names it, or every machine', () => {
    const fleet = [machine('casey-mbp'), machine('ci-01'), machine('cedar-02')];
    expect(picker(render(fleet, 'ci-01'))).toContain('ci-01');
    expect(picker(render(fleet, null))).toContain('All machines');
    // One machine has nothing to narrow to, unless the view already names one.
    expect(picker(render([machine('casey-mbp')], null))).toBe('');
    expect(picker(render([machine('casey-mbp')], 'old-box'))).toContain('old-box');
  });
});
