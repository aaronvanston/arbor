import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import highlightLanguages from './src/services/highlightLanguages.json' with { type: 'json' };

/**
 * Hugeicons Pro's duotone icons, for the selected sidebar row. They install only with HUGEICONS_LICENSE_KEY in the
 * repo's .env (see .npmrc); without them the free stroke set stands in and a selected row keeps its line icon.
 */
function duotoneIcons() {
  try {
    createRequire(import.meta.url).resolve('@hugeicons-pro/core-duotone-rounded');
    return '@hugeicons-pro/core-duotone-rounded';
  } catch {
    return fileURLToPath(new URL('./src/components/ui/iconsDuotoneFallback.ts', import.meta.url));
  }
}

/**
 * Shiki has a grammar for every language, a few under the GPL and some under no license at all. Arbor highlights only
 * the languages in src/services/highlightLanguages.json (src/services/highlightLanguages.ts draws the rest as plain
 * text), so every other grammar is built empty and its text isn't shipped. An alias file just re-exports its grammar.
 */
function onlyListedGrammars() {
  const keep = new Set(highlightLanguages);
  return {
    name: 'arbor-only-listed-grammars',
    enforce: 'pre',
    load(id) {
      const grammar = /\/@shikijs\/langs\/dist\/([^/]+)\.mjs$/.exec(id.replaceAll('\\', '/'))?.[1];
      if (!grammar || grammar === 'index' || keep.has(grammar)) return undefined;
      if (readFileSync(id, 'utf8').startsWith('/* Alias ')) return undefined;
      return 'export default [];';
    },
  };
}

/**
 * The modules the entry reaches through static imports alone, worked out once per build. The vendor chunks below load
 * with the app, so a library only a lazily loaded part uses (the diff viewer's highlighter and its grammars, the
 * markdown preview's parser) is left out of them to load with that part.
 */
function eagerModules(getModuleIds, getModuleInfo) {
  const eager = new Set();
  const queue = [...getModuleIds()].filter((id) => getModuleInfo(id)?.isEntry);
  while (queue.length) {
    const id = queue.pop();
    if (eager.has(id)) continue;
    eager.add(id);
    queue.push(...(getModuleInfo(id)?.importedIds ?? []));
  }
  return eager;
}

let eager = null;

export default defineConfig({
  plugins: [onlyListedGrammars(), react(), tailwindcss()],
  resolve: {
    alias: { 'arbor-duotone-icons': duotoneIcons() },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id, { getModuleIds, getModuleInfo }) {
          const normalizedId = id.replaceAll('\\', '/');
          if (!normalizedId.includes('/node_modules/')) return undefined;
          eager ??= eagerModules(getModuleIds, getModuleInfo);
          if (!eager.has(id)) return undefined;
          if (normalizedId.includes('/node_modules/@tauri-apps/')) return 'tauri-vendor';
          if (normalizedId.includes('/node_modules/@dnd-kit/')) return 'dnd-vendor';
          if (normalizedId.includes('/node_modules/@base-ui/')) return 'ui-vendor';
          if (normalizedId.includes('/node_modules/@hugeicons')) return 'icons-vendor';
          if (
            normalizedId.includes('/node_modules/react/')
            || normalizedId.includes('/node_modules/react-dom/')
            || normalizedId.includes('/node_modules/scheduler/')
          ) return 'react-vendor';
          return 'vendor';
        },
      },
    },
  },
});
