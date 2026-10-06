// Types for vite-split-strings.mjs, which stays plain JavaScript so vite.config.js can load it without a build step.

type Table = Record<string, string>;

export function importsOf(source: string): { statics: string[]; dynamics: string[]; unnamed: boolean };
export function staticGraph(roots: string[], read?: (path: string) => string): Map<string, string>;
export function keysNamed(source: string, keys: Set<string>): Set<string>;
export function partOf(key: string): string;
export function readStrings(path: string): Table;
export function jsonParseCode(table: Table): string;
export function launchEntries(mode: string): string[];
export function splitSource(root: string, mode: string): { core: Table; parts: Record<string, Table>; lazy: Map<string, string[]>; unnamed: string[] };
export function splitStringsPlugin(options: { root: string; mode: string }): import('vite').Plugin;
