import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Maps the built chunks' positions back to source files, through the hidden source maps the perf build writes beside
 * them. Small on purpose: a VLQ decoder and a lookup are all perf/run.ts needs, so it adds no dependency.
 */

type Segment = [genColumn: number, source: number, line: number, column: number, name: number];

type RawMap = { sources: string[]; sourcesContent?: (string | null)[]; names: string[]; mappings: string };

type ChunkMap = { sources: string[]; contents: (string | null)[]; names: string[]; lines: Segment[][]; code: string };

export type SourcePosition = { file: string; line: number; name: string | null };

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DIGIT = new Map([...BASE64].map((char, index) => [char, index]));

/** The source map's `mappings`, one array of segments per generated line, in column order. */
export function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let source = 0, line = 0, column = 0, name = 0;
  for (const text of mappings.split(';')) {
    const segments: Segment[] = [];
    let genColumn = 0;
    for (const part of text.split(',')) {
      if (!part) continue;
      const values: number[] = [];
      let value = 0, shift = 0;
      for (const char of part) {
        const digit = DIGIT.get(char) ?? 0;
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      genColumn += values[0] ?? 0;
      if (values.length >= 4) {
        source += values[1] ?? 0;
        line += values[2] ?? 0;
        column += values[3] ?? 0;
        if (values.length >= 5) name += values[4] ?? 0;
        segments.push([genColumn, source, line, column, values.length >= 5 ? name : -1]);
      }
    }
    lines.push(segments);
  }
  return lines;
}

/** Source maps for one build folder, read as they're asked for. */
export class BuildSources {
  private readonly maps = new Map<string, ChunkMap | null>();

  constructor(private readonly siteDir: string, private readonly repoDir: string) {}

  private chunk(file: string): ChunkMap | null {
    if (this.maps.has(file)) return this.maps.get(file) ?? null;
    const path = join(this.siteDir, file);
    let map: ChunkMap | null = null;
    if (existsSync(`${path}.map`)) {
      const raw = JSON.parse(readFileSync(`${path}.map`, 'utf8')) as RawMap;
      map = {
        sources: raw.sources.map((source) => this.tidy(join(this.siteDir, 'assets', source))),
        contents: raw.sourcesContent ?? [],
        names: raw.names,
        lines: decodeMappings(raw.mappings),
        code: readFileSync(path, 'utf8'),
      };
    }
    this.maps.set(file, map);
    return map;
  }

  /** A path from the repo's root, with node_modules' long prefixes cut to the package. */
  private tidy(path: string) {
    const fromRepo = relative(this.repoDir, path);
    const modules = fromRepo.lastIndexOf('node_modules/');
    return modules >= 0 ? fromRepo.slice(modules) : fromRepo;
  }

  /** Where a 1-based line and column of a built chunk came from. */
  lookup(file: string, line: number, column: number): SourcePosition | null {
    const map = this.chunk(file);
    const segments = map?.lines[line - 1];
    if (!map || !segments?.length) return null;
    let low = 0, high = segments.length - 1, found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = segments[middle];
      if (segment && segment[0] <= column - 1) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const segment = segments[Math.max(0, found)];
    if (!segment) return null;
    const [, source, sourceLine, , name] = segment;
    return { file: map.sources[source] ?? '?', line: sourceLine + 1, name: name >= 0 ? map.names[name] ?? null : this.nameAt(map, source, sourceLine) };
  }

  /** A function's or component's name from the source line it starts on, when the map didn't name it. */
  private nameAt(map: ChunkMap, source: number, line: number) {
    const text = map.contents[source]?.split('\n')[line] ?? '';
    const match = /(?:function\s+|const\s+|let\s+|class\s+)([A-Za-z_$][\w$]*)/.exec(text) ?? /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:\(|async|function)/.exec(text);
    return match?.[1] ?? null;
  }

  /** A stack frame as the page reports it, `assets/x.js:12:345`. */
  frame(frame: string): SourcePosition | null {
    const match = /^(assets\/[^:]+):(\d+):(\d+)$/.exec(frame);
    if (!match) return null;
    return this.lookup(match[1] ?? '', Number(match[2]), Number(match[3]));
  }

  /** Where a function starts, found by its text in the chunks the page loaded; null when it's not unique enough. */
  functionSource(text: string, chunks: string[]): SourcePosition | null {
    if (text.length < 12) return null;
    for (const file of chunks) {
      const map = this.chunk(file);
      const offset = map?.code.indexOf(text) ?? -1;
      if (!map || offset < 0) continue;
      const before = map.code.slice(0, offset);
      const line = before.split('\n').length;
      const column = offset - before.lastIndexOf('\n');
      return this.lookup(file, line, column);
    }
    return null;
  }

  /** How much of a chunk's source is the browser mock, which the app itself never loads. */
  mockShare(file: string): number {
    const map = this.chunk(file);
    if (!map) return 0;
    let mock = 0, total = 0;
    map.sources.forEach((source, index) => {
      const size = map.contents[index]?.length ?? 0;
      total += size;
      if (isMockSource(source)) mock += size;
    });
    return total ? mock / total : 0;
  }
}

/** Code that's only in the browser mock: src/dev and Tauri's IPC mocks. */
export const isMockSource = (file: string) => file.startsWith('src/dev/') || file.includes('@tauri-apps/api/mocks');

export const formatPosition = (position: SourcePosition | null) =>
  position ? `${position.file}:${position.line}${position.name ? ` (${position.name})` : ''}` : '?';
