import { build, defineConfig, runnerImport } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { splitStringsPlugin } from './scripts/vite-split-strings.mjs';
import highlightLanguages from './src/services/highlightLanguages.json' with { type: 'json' };

/**
 * Hugeicons Pro's duotone icons, for the selected sidebar row. They install only with HUGEICONS_LICENSE_KEY in the
 * repo's .env (see .npmrc); without them the free stroke set stands in and a selected row keeps its line icon.
 */
function duotoneIcons(mode) {
  // The demo build is served publicly on the website, which the Pro license doesn't cover, so it always takes the free set.
  if (mode === 'demo') return fileURLToPath(new URL('./src/components/ui/iconsDuotoneFallback.ts', import.meta.url));
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


/**
 * The static first screen (src/boot/BootShell.tsx): rendered to HTML into index.html's `#root`, with the two small
 * scripts that fit it to what's saved (src/boot/bootHead.ts in the head, src/boot/bootPaint.ts after the screen)
 * bundled and inlined, so the window can show before any of the app's script has loaded. React's first commit replaces
 * it. Worked out once per build, and again in a dev server whenever a file it's made from changes.
 */
function bootShell(mode) {
  const root = fileURLToPath(new URL('.', import.meta.url));
  let made = null;
  const script = async (entry) => {
    const output = await build({
      configFile: false,
      logLevel: 'silent',
      // The browser mock's `?chrome=mac` only matters outside the app's own build.
      define: { __BOOT_MOCK__: String(mode !== 'production') },
      build: {
        write: false,
        minify: true,
        target: 'es2020',
        lib: { entry: fileURLToPath(new URL(entry, import.meta.url)), formats: ['iife'], name: 'arborBoot' },
      },
    });
    const [chunk] = (Array.isArray(output) ? output[0] : output).output;
    return chunk.code.trim().replaceAll('</script', '<\\/script');
  };
  const make = async () => {
    const { module } = await runnerImport('/src/boot/renderBootShell.tsx', {
      root,
      configFile: false,
      logLevel: 'error',
      resolve: { alias: { 'arbor-duotone-icons': duotoneIcons(mode) } },
    });
    const [head, paint] = await Promise.all([script('./src/boot/bootHead.ts'), script('./src/boot/bootPaint.ts')]);
    return { shell: module.renderBootShell(), head, paint };
  };
  return {
    name: 'arbor-boot-shell',
    handleHotUpdate({ file }) {
      if (/\/src\/(boot|components\/sidebar|components\/ui|services\/sidebar|i18n)\//.test(file.replaceAll('\\', '/'))) made = null;
    },
    async transformIndexHtml(html) {
      made ??= make();
      const { shell, head, paint } = await made;
      return html
        .replace('<!--boot-head-->', `<script>${head}</script>`)
        .replace('<!--boot-shell-->', shell)
        .replace('<!--boot-paint-->', `<script>${paint}</script>`);
    },
  };
}

let eager = null;

/**
 * `vite build --mode demo` (bun run build:demo) builds the browser mock as a static site in dist-demo/, for the
 * website's clickable demo: main.tsx installs the mock in it as in a dev build, and its paths are relative so it can
 * sit in any folder.
 */
export default defineConfig(({ mode }) => ({
  base: mode === 'demo' ? './' : '/',
  plugins: [
    onlyListedGrammars(),
    splitStringsPlugin({ root: fileURLToPath(new URL('.', import.meta.url)), mode }),
    react(),
    tailwindcss(),
    bootShell(mode),
  ],
  resolve: {
    alias: { 'arbor-duotone-icons': duotoneIcons(mode) },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    // main.tsx loads the mock with a top-level await, which ES2020 doesn't have; the demo runs in current browsers.
    target: mode === 'demo' ? 'es2022' : 'es2020',
    outDir: mode === 'demo' ? 'dist-demo' : 'dist',
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
}));
