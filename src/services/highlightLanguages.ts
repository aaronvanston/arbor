import { getFiletypeFromFileName, type SupportedLanguages } from '@pierre/diffs';
import { bundledLanguagesInfo } from 'shiki';
import listed from './highlightLanguages.json';

/**
 * The languages a file diff is highlighted in. Shiki has a grammar for every language, a few under the GPL and some
 * under no license at all, so Arbor ships only these (all MIT or as permissive; vite.config.js builds the rest empty)
 * and draws any other file as plain text.
 */
const LISTED = new Set<string>(listed);
const GRAMMAR = new Map(bundledLanguagesInfo.flatMap((info) => [info.id, ...(info.aliases ?? [])].map((name) => [name, info.id] as const)));

/** The language `path` is highlighted in: its type when Arbor ships that grammar, else plain text. */
export function highlightLanguage(path: string): SupportedLanguages {
  const lang = getFiletypeFromFileName(path);
  return LISTED.has(GRAMMAR.get(lang) ?? lang) ? lang : 'text';
}
