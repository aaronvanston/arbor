/**
 * The first screen's handoff (src/boot/BootShell.tsx): what index.html paints before any of the app's script, against
 * React's first frame, which must draw the same picture. Two loads on the same paused page clock and seeds:
 *
 * - the static screen: index.html with its module scripts taken out, its frame callbacks run (the art, the open
 *   groups), so it shows exactly what the window opens on;
 * - React's first frame: the full page, the clock stepped 10 ms at a time only until the shell's first commit. The
 *   mock answers every command 60 ms after it's sent, and the clock stops there, so nothing Home asks for has come
 *   back yet: it's the frame before any data, every time.
 *
 * Gated: the most any shell box or Home section moved between the two (px), how many pixels changed, how many
 * elements the static screen lays out before the window shows, and index.html's size.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContextOptions, Page } from 'playwright';

export type FirstScreen = {
  /** The most any compared box moved or resized at the handoff, in CSS px; 0 is the point. */
  shiftPx: number;
  /** Each box's movement, by name, for the report. */
  shifts: Record<string, number>;
  /** Pixels that differ between the two frames (by more than anti-aliasing), over the whole window. */
  pixelsChanged: number;
  /** Elements in the static screen once fitted, which WebKit styles and lays out before the window shows. */
  shellElements: number;
  /** index.html as built: the static screen and its two inline scripts ride in it. */
  indexHtmlBytes: number;
  /** Page-clock ms from load to React's first commit (reported only). */
  handoffAtMs: number;
};

const REAL = '[data-app-shell]:not([data-boot-shell])';
const STEP_MS = 10;
/** Past every startup wait in main.tsx (the saved settings' second), so a first commit that never comes fails. */
const HANDOFF_LIMIT_MS = 3_000;

/** The boxes both shells draw, by name: the static screen's markers and the real shell's slots. */
const BOXES: Record<string, [boot: string, real: string]> = {
  sidebar: ['[data-boot-shell] aside', `${REAL} aside[data-app-sidebar]`],
  titleRow: ['[data-boot-box=header]', `${REAL} aside > div:first-child`],
  wordmark: ['[data-boot-box=wordmark]', `${REAL} aside > div:first-child > button`],
  sidebarButton: ['[data-boot-box=toggle]', `${REAL} > div.fixed button`],
  search: ['[data-boot-box=search]', `${REAL} [data-slot=sidebar-search]`],
  treeTop: ['[data-boot-box=row-home]', `${REAL} [data-tree-page=home]`],
  rowMachines: ['[data-boot-box=row-machines]', `${REAL} [data-tree-page=machines]`],
  rowUsage: ['[data-boot-box=row-usage]', `${REAL} [data-tree-page=usage]`],
  page: ['[data-boot-box=main]', `${REAL} main`],
  topBar: ['[data-boot-box=topbar]', `${REAL} main [data-slot=page-topbar]`],
  title: ['[data-boot-box=title]', `${REAL} main [data-slot=page-topbar] h1 span`],
  art: ['[data-boot-art] canvas', `${REAL} [data-slot=sidebar-art] canvas`],
};

type Box = [number, number, number, number];

/** Every named box and each Home section (by its title) in whichever shell `root` picks. */
const boxesIn = (page: Page, which: 'boot' | 'real') => page.evaluate(({ boxes, which, REAL }) => {
  const box = (element: Element | null): Box | null => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 10) / 10) as Box;
  };
  const found: Record<string, Box | null> = {};
  for (const [name, [boot, real]] of Object.entries(boxes)) found[name] = box(document.querySelector(which === 'boot' ? boot : real));
  const root = which === 'boot' ? '[data-boot-shell]' : REAL;
  for (const section of document.querySelectorAll(`${root} main [data-slot=settings-section]`)) {
    const title = section.querySelector('h2')?.firstChild?.textContent ?? '?';
    // The last line of a section that's below the window's edge still counts: content under it would move.
    found[`section ${title}`] = box(section);
  }
  return found;
}, { boxes: BOXES, which, REAL });

/** How many pixels differ between two PNGs of the same size, decoded in a blank page. */
async function pixelsChanged(browser: Browser, a: Buffer, b: Buffer): Promise<number> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ({ a, b }) => {
      const load = (data: string) => new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = `data:image/png;base64,${data}`;
      });
      const pixels = (image: HTMLImageElement) => {
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No 2D canvas');
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const [first, second] = await Promise.all([load(a), load(b)]);
      if (first.width !== second.width || first.height !== second.height) return first.width * first.height;
      const pa = pixels(first), pb = pixels(second);
      let changed = 0;
      for (let index = 0; index < pa.length; index += 4) {
        const difference = Math.abs((pa[index] ?? 0) - (pb[index] ?? 0)) + Math.abs((pa[index + 1] ?? 0) - (pb[index + 1] ?? 0)) + Math.abs((pa[index + 2] ?? 0) - (pb[index + 2] ?? 0));
        if (difference > 24) changed += 1;
      }
      return changed;
    }, { a: a.toString('base64'), b: b.toString('base64') });
  } finally {
    await page.close();
  }
}

export async function firstScreenJourney(browser: Browser, origin: string, site: string, options: BrowserContextOptions, startMs: number): Promise<{ result: FirstScreen; errors: string[] }> {
  const errors: string[] = [];
  // Home's shape as a previous launch left it (src/boot/bootState.ts), the mock's own: Needs you's four rows and
  // its more line, two providers of two and three accounts, six machines.
  const seed = { 'arbor.boot.v1': JSON.stringify({ zoom: 1, home: { providers: [2, 3], machines: 6, needsYou: { rows: 4, more: true, at: startMs } } }) };
  const open = async (staticOnly: boolean) => {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await page.clock.install({ time: startMs - 1_000 });
    await page.addInitScript((seed: Record<string, string>) => {
      for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
      // The static screen is built for the Mac the window runs on (⌘K in the search row); React reads the platform,
      // so on a Linux host it would draw Ctrl+K and count a difference the app never shows.
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
    }, seed);
    await page.clock.pauseAt(startMs);
    page.on('pageerror', (error) => { errors.push(`first screen: ${error.message}`); });
    if (staticOnly) {
      await page.route(/\/(index\.html)?(\?.*)?$/, async (route) => {
        const response = await route.fetch();
        const html = (await response.text()).replace(/<script type="module"[^>]*><\/script>/g, '').replace(/<link rel="modulepreload"[^>]*>/g, '');
        await route.fulfill({ response, body: html });
      });
    }
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    return { context, page };
  };

  // The static screen, its two frames run: the art drawn and the remembered groups opened.
  const boot = await open(true);
  await boot.page.clock.runFor(200);
  const bootShot = await boot.page.screenshot();
  const bootBoxes = await boxesIn(boot.page, 'boot');
  const shellElements = await boot.page.evaluate(() => document.querySelector('[data-boot-shell]')?.getElementsByTagName('*').length ?? 0);
  await boot.context.close();

  // React's first frame: step until the shell's first commit and no further.
  const real = await open(false);
  let handoffAtMs = 0;
  while (!(await real.page.evaluate((selector) => Boolean(document.querySelector(selector)), REAL))) {
    if (handoffAtMs >= HANDOFF_LIMIT_MS) {
      errors.push(`first screen: React's shell never committed within ${HANDOFF_LIMIT_MS} ms of page clock`);
      break;
    }
    await real.page.clock.runFor(STEP_MS);
    handoffAtMs += STEP_MS;
    // React renders on real tasks, which the page clock doesn't hold; let them run.
    await real.page.evaluate(() => new Promise((resolve) => { const channel = new MessageChannel(); channel.port1.onmessage = resolve; channel.port2.postMessage(0); }));
  }
  const waiting = await real.page.evaluate((selector) => Boolean(document.querySelector(`${selector} [data-boot-provider]`)), REAL);
  if (!waiting) errors.push('first screen: React\'s first frame already had data in it, so the handoff wasn\'t caught before the answers');
  const realShot = await real.page.screenshot();
  const realBoxes = await boxesIn(real.page, 'real');
  await real.context.close();

  const shifts: Record<string, number> = {};
  for (const name of new Set([...Object.keys(bootBoxes), ...Object.keys(realBoxes)])) {
    const a = bootBoxes[name], b = realBoxes[name];
    // A box only one of them draws is as bad as the window's height of movement.
    shifts[name] = a && b ? Math.max(...a.map((value, index) => Math.abs(value - (b[index] ?? 0)))) : (options.viewport?.height ?? 900);
  }
  return {
    result: {
      shiftPx: Math.ceil(Math.max(0, ...Object.values(shifts))),
      shifts,
      pixelsChanged: await pixelsChanged(browser, bootShot, realShot),
      shellElements,
      indexHtmlBytes: statSync(join(site, 'index.html')).size,
      handoffAtMs,
    },
    errors,
  };
}
