import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { en } from '../src/i18n/locales/en';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const technicalText = new Set(['EasyCLIProxyAPI', 'Arbor', 'WebSocket', 'Fast', 'ms', 'auto']);
const technicalPlaceholders = new Set(['1h', 'sk-...', 'gpt-5.6-terra', 'https://...']);

function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'i18n' ? [] : componentFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/** Every .ts and .tsx file under `src/`, but the text itself. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'locales' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('UI localization boundaries', () => {
  it('keeps no text that nothing can show', () => {
    // A key counts as used when the code names it whole, or builds it from a template such as
    // `machines.health.status.${status}`. Text left behind by a removed screen fails here instead of piling up.
    const named = new Set<string>();
    const built: RegExp[] = [];
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const file of sourceFiles(sourceRoot)) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node)) named.add(node.text);
        // Only a template that starts with a key's first word, so `${a}.${b}` can't count every key as used.
        else if (ts.isTemplateExpression(node) && /^[a-z][A-Za-z0-9]*\./.test(node.head.text)) {
          const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
          built.push(new RegExp(`^${parts.map(escape).join('[\\w.-]+')}$`));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    const unused = Object.keys(en).filter((key) => !named.has(key) && !built.some((pattern) => pattern.test(key)));
    expect(unused).toEqual([]);
  });

  it('preserves the raw reasoning effort in usage text and tooltips', () => {
    const parse = (...path: string[]) => {
      const file = join(sourceRoot, ...path);
      return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    };
    const find = <T extends ts.Node>(root: ts.Node, test: (node: ts.Node) => node is T): T | undefined => {
      let found: T | undefined;
      const visit = (node: ts.Node) => {
        if (!found && test(node)) found = node;
        ts.forEachChild(node, visit);
      };
      visit(root);
      return found;
    };
    const component = (source: ts.SourceFile, name: string) =>
      source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
    const attribute = (source: ts.SourceFile, element: ts.JsxOpeningLikeElement | undefined, name: string) =>
      element?.attributes.properties.find((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(source) === name)
        ?.initializer?.getText(source);

    // Requests hands ModelName the effort the proxy recorded, untranslated...
    const grid = parse('pages', 'UsageRequestsGrid.tsx');
    const model = component(grid, 'Model');
    expect(model).toBeDefined();
    const named = model && find(model, (node): node is ts.JsxSelfClosingElement => ts.isJsxSelfClosingElement(node) && node.tagName.getText(grid) === 'ModelName');
    expect(attribute(grid, named, 'effort')).toBe("{record.reasoning_effort || 'auto'}");

    // ...and ModelName shows it and titles it as it came.
    const identity = parse('components', 'identity', 'Identity.tsx');
    const modelName = component(identity, 'ModelName');
    expect(modelName).toBeDefined();
    const small = modelName && find(modelName, (node): node is ts.JsxElement => ts.isJsxElement(node) && node.openingElement.tagName.getText(identity) === 'small');
    expect(small?.children.find(ts.isJsxExpression)?.expression?.getText(identity)).toBe('effort');
    expect(attribute(identity, small?.openingElement, 'title')).toBe('{effort}');
  });

  it('routes visible prose and accessibility labels through translations', () => {
    const hardcoded: string[] = [];
    for (const file of componentFiles(sourceRoot)) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const report = (node: ts.Node, text: string, allowed = technicalText) => {
        const normalized = text.trim();
        if (/\p{L}/u.test(normalized) && !allowed.has(normalized)) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          hardcoded.push(`${file}:${line}: ${normalized}`);
        }
      };
      const inspectExpression = (expression?: ts.Expression) => {
        if (!expression) return;
        if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
          report(expression, expression.text);
        } else if (ts.isConditionalExpression(expression)) {
          inspectExpression(expression.whenTrue);
          inspectExpression(expression.whenFalse);
        } else if (ts.isBinaryExpression(expression)) {
          inspectExpression(expression.right);
        }
      };
      const visit = (node: ts.Node) => {
        if (ts.isJsxText(node)) report(node, node.text);
        if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) inspectExpression(node.expression);
        if (ts.isJsxAttribute(node) && node.initializer) {
          const name = node.name.getText(source);
          if (['title', 'aria-label', 'alt', 'placeholder'].includes(name) && ts.isStringLiteral(node.initializer)) {
            report(node, node.initializer.text, name === 'placeholder' ? technicalPlaceholders : technicalText);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(hardcoded).toEqual([]);
  });
});
