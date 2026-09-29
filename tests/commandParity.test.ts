import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const root = new URL('..', import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** The commands the native side registers, by the name the webview invokes them with. */
function registeredCommands() {
  const list = read('src-tauri/src/main.rs').match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? '';
  return list.split(',').map((entry) => entry.trim().split('::').pop() ?? '').filter(Boolean).sort();
}

/** The webview's own source files, by their path under src; the browser mock names every command, so it's left out. */
function webviewFiles() {
  return readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.tsx?$/.test(path) && !path.startsWith('dev/'))
    .map((path) => ({ path, text: read(join('src', path)) }));
}

/** Every `.rs` file under src-tauri/src. */
function rustSources() {
  return readdirSync(join(root, 'src-tauri/src'), { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.rs'))
    .map((path) => ({ path, text: read(join('src-tauri/src', path)) }));
}

/** Splits at the commas that aren't inside brackets. */
function splitTopLevel(text: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '<' || char === '(' || char === '[') depth += 1;
    else if (char === '>' || char === ')' || char === ']') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** One spelling for a union, whatever order it was written in. */
const union = (...members: string[]) => [...new Set(members.flatMap((member) => splitTopLevelUnion(member)))].sort().join(' | ');
function splitTopLevelUnion(text: string) {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '<' || char === '(' || char === '[') depth += 1;
    else if (char === '>' || char === ')' || char === ']') depth -= 1;
    else if (char === '|' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** A Rust type as its TypeScript spelling here: the names ts-rs gives it, lists as `Array<T>`, maps as `Record<K, V>`. */
function rustToTs(type: string): string {
  const text = type.trim().replace(/^&(?:'\w+\s+)?(?:mut\s+)?/, '');
  if (text === '' || text === '()') return 'void';
  const generic = /^([\w:]+)\s*<([\s\S]*)>$/.exec(text);
  if (generic) {
    const name = (generic[1] ?? '').split('::').pop() ?? '';
    const params = splitTopLevel(generic[2] ?? '').map(rustToTs);
    const [first = '', second = ''] = params;
    if (name === 'Result') return first;
    if (name === 'Option') return union(first, 'null');
    if (['Vec', 'VecDeque', 'HashSet', 'BTreeSet'].includes(name)) return `Array<${first}>`;
    if (['HashMap', 'BTreeMap'].includes(name)) return `Record<${first}, ${second}>`;
    if (['Box', 'Arc', 'Rc'].includes(name)) return first;
    return `${name}<${params.join(', ')}>`;
  }
  const name = text.split('::').pop() ?? text;
  if (['String', 'str', 'PathBuf', 'Path'].includes(name)) return 'string';
  if (name === 'bool') return 'boolean';
  if (/^(?:[iu](?:8|16|32|64|128|size)|f32|f64)$/.test(name)) return 'number';
  if (name === 'Value') return 'JsonValue';
  return name;
}

/** Arguments the native side fills in itself; the webview never passes them. */
const INJECTED = /^(?:tauri::)?(?:State|AppHandle|Window|WebviewWindow)\b/;

/** Each command's Rust signature: its arguments as the webview names them, and what it returns. */
function rustSignatures() {
  const signatures = new Map<string, { args: Map<string, string>; result: string }>();
  for (const { text } of rustSources()) {
    for (const match of text.matchAll(/#\[tauri::command\]\s*(?:#\[[^\]]*\]\s*)*pub(?:\(crate\))?\s+(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g)) {
      const name = match[1] ?? '';
      let depth = 1;
      let end = (match.index ?? 0) + match[0].length;
      const start = end;
      while (depth > 0 && end < text.length) {
        if (text[end] === '(') depth += 1;
        else if (text[end] === ')') depth -= 1;
        end += 1;
      }
      const params = splitTopLevel(text.slice(start, end - 1));
      const returns = text.slice(end, text.indexOf('{', end)).replace(/^\s*->/, '').replace(/\bwhere\b[\s\S]*$/, '');
      const args = new Map<string, string>();
      for (const param of params) {
        const [rawName = '', ...rest] = param.split(':');
        const type = rest.join(':').trim();
        if (INJECTED.test(type)) continue;
        // Tauri turns a snake_case argument into camelCase for the webview.
        const argName = rawName.replace(/^mut\s+/, '').trim().replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
        args.set(argName, rustToTs(type));
      }
      signatures.set(name, { args, result: rustToTs(returns) });
    }
  }
  return signatures;
}

/** A TypeScript type as spelled here, so it can be compared with a Rust one. */
function tsToCanonical(node: ts.TypeNode, source: ts.SourceFile): string {
  if (ts.isArrayTypeNode(node)) return `Array<${tsToCanonical(node.elementType, source)}>`;
  if (ts.isUnionTypeNode(node)) return union(...node.types.map((member) => tsToCanonical(member, source)));
  if (ts.isParenthesizedTypeNode(node)) return tsToCanonical(node.type, source);
  if (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText(source);
    const params = node.typeArguments?.map((param) => tsToCanonical(param, source));
    return params ? `${name}<${params.join(', ')}>` : name;
  }
  return node.getText(source);
}

/** The command list in src/native: each entry's arguments and result, from the domain files' `…Commands` types. */
function listedCommands() {
  const listed: { name: string; args: Map<string, string>; result: string }[] = [];
  for (const file of readdirSync(join(root, 'src/native')).filter((file) => !['commands.ts', 'types.ts'].includes(file))) {
    const source = ts.createSourceFile(file, read(join('src/native', file)), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isTypeAliasDeclaration(statement) || !statement.name.text.endsWith('Commands')) continue;
      if (!ts.isTypeLiteralNode(statement.type)) continue;
      for (const member of statement.type.members) {
        if (!ts.isPropertySignature(member) || !member.type || !ts.isTypeLiteralNode(member.type)) continue;
        const entry = { name: member.name.getText(source), args: new Map<string, string>(), result: '' };
        for (const part of member.type.members) {
          if (!ts.isPropertySignature(part) || !part.type) continue;
          if (part.name.getText(source) === 'result') entry.result = tsToCanonical(part.type, source);
          if (part.name.getText(source) === 'args' && ts.isTypeLiteralNode(part.type)) {
            for (const arg of part.type.members) {
              if (!ts.isPropertySignature(arg) || !arg.type) continue;
              const type = tsToCanonical(arg.type, source);
              // Leaving an argument out reaches Rust as None, the same as null.
              entry.args.set(arg.name.getText(source), arg.questionToken ? union(type, 'null') : type);
            }
          }
        }
        listed.push(entry);
      }
    }
  }
  return listed;
}

describe('the commands between the webview and the native side', () => {
  const registered = registeredCommands();
  const files = webviewFiles();
  const source = files.map(({ text }) => text).join('\n');

  test('the list is read at all', () => {
    expect(registered.length).toBeGreaterThan(100);
    expect(registered).toContain('management_request');
  });

  test('every command the webview invokes by name is registered', () => {
    const invoked = [...source.matchAll(/invoke(?:Command)?(?:<[^()]*>)?\(\s*'([a-z0-9_]+)'/g)].flatMap((match) => match[1] ?? []);
    expect(invoked.length).toBeGreaterThan(100);
    expect([...new Set(invoked)].filter((command) => !registered.includes(command))).toEqual([]);
  });

  // Some commands reach invoke through a helper (a core action, a settings save), so this looks for the name anywhere.
  test('every registered command is used by the webview, so none is left behind unused', () => {
    expect(registered.filter((command) => !source.includes(`'${command}'`))).toEqual([]);
  });

  // The compiler checks each answer against the list, and that the browser mock has one for every command, but only
  // for answers given through mockCommands.
  test('the browser mock and the tests stand in for the native side only through mockCommands', () => {
    const files = ['src', 'tests'].flatMap((dir) =>
      readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
        .filter((path) => /\.tsx?$/.test(path))
        .map((path) => join(dir, path)),
    );
    const faking = files.filter((path) => path !== 'src/dev/mock/answers.ts' && /\bmockIPC\b/.test(read(path)));
    expect(faking).toEqual([]);
  });

  describe('the Rust types written out for the webview', () => {
    /** Each field of a struct deriving TS: its name, its attributes and its type. */
    const fields = rustSources().flatMap(({ path, text }) =>
      [...text.matchAll(/#\[derive\(([^)]*)\)\]\s*((?:#\[[^\]]*\]\s*|\/\/[^\n]*\n\s*)*)(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)[^{;]*\{([\s\S]*?)\n\}/g)]
        .filter((match) => /\bTS\b/.test(match[1] ?? ''))
        .flatMap((match) =>
          [...(match[4] ?? '').matchAll(/((?:\s*(?:#\[[\s\S]*?\]|\/\/[^\n]*))*)\s*(?:pub(?:\([^)]*\))?\s+)?(\w+)\s*:\s*([^,\n]+),/g)].map((field) => ({
            where: `${path} ${match[3]}.${field[2]}`,
            attributes: field[1] ?? '',
            type: (field[3] ?? '').trim(),
          })),
        ),
    );

    test('are read at all', () => {
      expect(fields.length).toBeGreaterThan(100);
    });

    // serde leaves the field out, so the webview has to be told it may be missing rather than null.
    test('mark a field serde may leave out as optional', () => {
      const unmarked = fields.filter(({ attributes }) =>
        attributes.includes('skip_serializing_if') && !/\bdefault\b/.test(attributes) && !/#\[ts\([^\]]*optional/.test(attributes),
      );
      expect(unmarked.map(({ where }) => where)).toEqual([]);
    });
  });

  describe('the command list in src/native', () => {
    const listed = listedCommands();
    const signatures = rustSignatures();

    test('is read at all', () => {
      expect(listed.length).toBeGreaterThan(60);
      expect(signatures.size).toBe(registered.length);
    });

    test('lists every registered command, once', () => {
      const names = listed.map(({ name }) => name);
      expect(registered.filter((name) => !names.includes(name))).toEqual([]);
      expect(names.filter((name) => !registered.includes(name))).toEqual([]);
      expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    });

    test('gives each command the arguments its Rust signature takes', () => {
      const wrong = listed.flatMap(({ name, args }) => {
        const rust = signatures.get(name)?.args ?? new Map<string, string>();
        const names = [...new Set([...rust.keys(), ...args.keys()])];
        return names
          .filter((arg) => rust.get(arg) !== args.get(arg))
          .map((arg) => `${name}(${arg}): Rust takes ${rust.get(arg) ?? 'nothing'}, the list says ${args.get(arg) ?? 'nothing'}`);
      });
      expect(wrong).toEqual([]);
    });

    test('gives each command the result its Rust signature returns', () => {
      const wrong = listed
        .filter(({ name, result }) => signatures.get(name)?.result !== result)
        .map(({ name, result }) => `${name}: Rust returns ${signatures.get(name)?.result}, the list says ${result}`);
      expect(wrong).toEqual([]);
    });

    test('is the only way the webview calls a command', () => {
      const importing = files
        .filter(({ path, text }) => !path.startsWith('native/') && /import\s*\{[^}]*\binvoke\b[^}]*\}\s*from\s*'@tauri-apps\/api\/core'/.test(text))
        .map(({ path }) => path);
      expect(importing).toEqual([]);
    });
  });
});
