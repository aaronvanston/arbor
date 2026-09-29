import { invokeCommand } from '../native/commands';

// ---------------------------------------------------------------------------
// Front matter
// ---------------------------------------------------------------------------

/** One `key: value` from a file's front matter, the value as text to read: lists joined, block text kept whole. */
export type FrontMatterEntry = { key: string; value: string };
/** A markdown file split into its front matter, when it opens with one, and the markdown after it. */
export type MarkdownDocument = { frontMatter: FrontMatterEntry[] | null; body: string };

/**
 * Splits off the `---` block a SKILL.md opens with. Skills keep it to plain keys (name, description, allowed tools),
 * so this reads the parts of YAML they use rather than all of it: `key: value`, quoted values, `[a, b]` and `- item`
 * lists, `|` and `>` block text, and indented lines under a key. A file whose first line isn't `---`, or whose block
 * never closes, has no front matter.
 */
export function splitFrontMatter(text: string): MarkdownDocument {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trimEnd() !== '---') return { frontMatter: null, body: text };
  const end = lines.findIndex((line, index) => index > 0 && (line.trimEnd() === '---' || line.trimEnd() === '...'));
  if (end < 0) return { frontMatter: null, body: text };
  return { frontMatter: parseFrontMatter(lines.slice(1, end)), body: lines.slice(end + 1).join('\n') };
}

type Draft = { key: string; inline: string; block: string | null; lines: string[] };

// A key starts its line and ends at the first colon followed by a space or the line's end.
const KEY_LINE = /^([^\s#-][^:]*?):(?:[ \t]+(.*))?$/;
const BLOCK_MARK = /^([|>])[+-]?\d*[+-]?$/;

function parseFrontMatter(lines: string[]): FrontMatterEntry[] {
  const drafts: Draft[] = [];
  for (const line of lines) {
    const key = KEY_LINE.exec(line);
    if (key?.[1]) {
      const inline = stripComment((key[2] ?? '').trim());
      const block = BLOCK_MARK.exec(inline)?.[1] ?? null;
      drafts.push({ key: unquote(key[1].trim()), inline: block ? '' : inline, block, lines: [] });
      continue;
    }
    // Anything else belongs to the key above it; a comment or a line before any key says nothing to show.
    const last = drafts[drafts.length - 1];
    if (last && (line.trim() === '' || /^\s/.test(line) || line.startsWith('- '))) last.lines.push(line);
  }
  return drafts.map((draft) => ({ key: draft.key, value: draftValue(draft) }));
}

function draftValue({ inline, block, lines }: Draft): string {
  if (block) {
    const trimmed = dedent(lines);
    // `|` keeps each line; `>` folds them into one, with a blank line starting a new one.
    const text = trimmed.join('\n').trim();
    return block === '|' ? text : text.split(/\n\s*\n/).map((paragraph) => paragraph.replace(/\n/g, ' ')).join('\n');
  }
  // Outside block text, a line starting with # is a comment.
  const filled = lines.filter((line) => line.trim() && !/^\s*#/.test(line));
  if (!filled.length) return flowList(inline) ?? unquote(inline);
  if (filled.every((line) => /^\s*- /.test(line))) return filled.map((line) => unquote(stripComment(line.trim().slice(2).trim()))).join(', ');
  // Text carried onto the next lines reads as one line; a map under the key reads as its lines.
  if (inline) return [unquote(inline), ...filled.map((line) => line.trim())].join(' ');
  return dedent(filled).join('\n');
}

const dedent = (lines: string[]) => {
  const indents = lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(cut).trimEnd());
};

/** `[a, "b", c]` as `a, b, c`; null for anything else. */
function flowList(value: string): string | null {
  if (!value.startsWith('[') || !value.endsWith(']')) return null;
  return value.slice(1, -1).split(',').map((part) => unquote(part.trim())).filter(Boolean).join(', ');
}

/** A trailing ` # comment` isn't part of a plain value; inside quotes it is. */
const stripComment = (value: string) => (/^["']/.test(value) ? value : value.replace(/\s+#.*$/, ''));

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\/nt])/g, (_, escaped: string) => (escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped));
  }
  return value;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A link the preview can open: only http and https, in the browser. Relative links and other schemes go nowhere. */
export function externalUrl(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export const openExternalUrl = (url: string) =>
  invokeCommand('open_external_url', { url }).catch((error) => console.warn('Failed to open the link', error));

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };
// Where a block of HTML can stand on its own; anywhere else it's inside a paragraph.
const FLOW = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);
const COMMENT = /^<!--[\s\S]*-->$/;

/**
 * A remark plugin that shows HTML in the markdown as the text it is, never as HTML. Skills and instructions often
 * use tags like `<example>` to structure a prompt, so dropping them would hide what the file says. Comments are left
 * out, as the file's own renderers do.
 */
export function remarkLiteralHtml() {
  return (tree: MarkdownNode) => { literalHtml(tree); };
}

function literalHtml(node: MarkdownNode) {
  if (!node.children) return;
  node.children = node.children.flatMap((child): MarkdownNode[] => {
    if (child.type !== 'html') {
      literalHtml(child);
      return [child];
    }
    const value = child.value ?? '';
    if (COMMENT.test(value.trim())) return [];
    return [FLOW.has(node.type) ? { type: 'code', value } : { type: 'text', value }];
  });
}
