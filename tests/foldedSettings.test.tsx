import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { FoldedSettingsSection, SettingsRow, SettingsSection } from '../src/components/layout/settings';
import { TooltipProvider } from '../src/components/ui/tooltip';
import { I18nProvider } from '../src/i18n';

const folded = (changed: number, attention = false) =>
  renderToStaticMarkup(
    <I18nProvider>
      <TooltipProvider>
        <FoldedSettingsSection fold="retry" title="Failure Retries" changed={changed} attention={attention} headerAction={<button type="button">Save</button>}>
          <SettingsRow settingId="network.request-retry" title="Request Retries" control={<input aria-label="Request Retries" />} />
        </FoldedSettingsSection>
      </TooltipProvider>
    </I18nProvider>,
  );

describe('a folded settings group', () => {
  it('starts folded, its rows out of the page until opened, its Save still in reach', () => {
    const html = folded(0);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Failure Retries');
    expect(html).not.toContain('data-setting-id="network.request-retry"');
    expect(html).toContain('>Save</button>');
    expect(html).toContain('data-fold="retry"');
  });

  it('says how many of its settings are changed, so a change isn’t out of sight', () => {
    expect(folded(0)).not.toContain('changed');
    const html = folded(2);
    expect(html).toContain('2 changed');
    expect(html).toContain('title="2 settings here aren’t at their defaults"');
    expect(folded(1)).toContain('title="One setting here isn’t at its default"');
  });

  it('shows what needs seeing inside it straight away', () => {
    const html = folded(1, true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-setting-id="network.request-retry"');
  });
});

/** Each folded group on Settings › General and Network: its `attention`, and the failures it shows inside itself. */
function configPanelFolds() {
  const file = new URL('../src/pages/ConfigPanel.tsx', import.meta.url);
  const source = ts.createSourceFile('ConfigPanel.tsx', readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const folds: { fold: string; attention: string; failures: Set<string> }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'FoldedSettingsSection') {
      const attribute = (name: string) => node.openingElement.attributes.properties
        .find((item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && item.name.getText(source) === name)?.initializer?.getText(source) ?? '';
      const failures = new Set<string>();
      const inside = (child: ts.Node) => {
        // `{loggingError ? <Alert …> : null}`, or a row's `status={retryError ? … : null}`.
        if (ts.isConditionalExpression(child) && ts.isIdentifier(child.condition) && child.condition.text.endsWith('Error')) failures.add(child.condition.text);
        // `{feedbackBlock(retryFeedback)}`, a notice that can say a save failed.
        if (ts.isCallExpression(child) && child.expression.getText(source) === 'feedbackBlock') failures.add(`${child.arguments[0]?.getText(source)}.notice`);
        ts.forEachChild(child, inside);
      };
      node.children.forEach(inside);
      folds.push({ fold: attribute('fold'), attention: attribute('attention'), failures });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return folds;
}

describe('the folded groups in Settings', () => {
  it('open by themselves for every failure they show inside, so one saved from the header while folded is seen', () => {
    const folds = configPanelFolds();
    expect(folds.map((item) => item.fold).sort()).toEqual(['"logging"', '"retry"', '"tls"']);
    for (const { fold, attention, failures } of folds) {
      expect({ fold, failures: failures.size > 0 }).toEqual({ fold, failures: true });
      for (const failure of failures) expect({ fold, attention: attention.includes(failure) }).toEqual({ fold, attention: true });
    }
  });
});

describe('a section’s header', () => {
  it('moves its actions under the title when they don’t fit beside it, rather than shrinking them over it', () => {
    const plain = renderToStaticMarkup(
      <I18nProvider>
        <TooltipProvider>
          <SettingsSection title="Machine Health" description="Sampled every 5s." headerAction={<button type="button">Configure Hosts</button>}>
            <p>rows</p>
          </SettingsSection>
        </TooltipProvider>
      </I18nProvider>,
    );
    for (const html of [plain, folded(0)]) {
      const [header = '', title = '', action = ''] = html.match(/<div class="([^"]*)"><div class="([^"]*)"><h2[\s\S]*?<\/h2>[\s\S]*?<div class="([^"]*)"><button/)?.slice(1) ?? [];
      // A line of its own for the actions once the title would have less than 12rem, and at the right as before.
      expect(header.split(' ')).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'justify-between']));
      expect(title.split(' ')).toEqual(expect.arrayContaining(['min-w-0', 'flex-1', 'basis-48']));
      expect(action.split(' ')).toEqual(expect.arrayContaining(['shrink-0', 'max-w-full', 'ms-auto']));
    }
  });
});
