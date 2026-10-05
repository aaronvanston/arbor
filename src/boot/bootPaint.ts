import { appColorChoice } from '../services/appColor';
import { BOOT_KEY, needsYouLikely, readBootState } from './bootState';
import { fitOpenGroups, parseOpenChoices, wantedOpen } from '../services/sidebarTree';
import { sidebarArtChoice, sidebarArtHalo, sidebarArtHeight, sidebarArtInk } from '../services/sidebarArt';
import { drawScene, sceneRows, SCENE_STILL_SECONDS } from '../services/sidebarScenes';
import { clampSidebarWidth, parseSidebarLayout, sidebarMaxWidth, sidebarShown, NARROW_WINDOW_WIDTH } from '../services/sidebarLayoutRules';

declare const __BOOT_MOCK__: boolean;

type TauriInternals = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };

/**
 * index.html's second script, inlined right after the static first screen (src/boot/BootShell.tsx) by the build. It
 * fits that screen to what's saved, as the shell will draw it: the sidebar's width, or hidden; the Mac title row; the
 * sidebar art's first still frame and the ink over it. Then, once it has painted, it tells the native side to show the
 * window (src-tauri/src/main_window.rs's `frontend_ready`), a whole script parse and first render before React could.
 * React's first commit replaces the lot; main.tsx's own `frontend_ready` then finds the window already shown.
 */
(() => {
  const shell = document.querySelector<HTMLElement>('[data-boot-shell]');
  if (!shell) return;
  const root = document.documentElement;
  const theme = root.dataset.theme === 'dark' ? 'dark' : 'light';
  const read = (key: string, legacy?: string) => {
    try {
      return localStorage.getItem(key) ?? (legacy ? localStorage.getItem(legacy) : null);
    } catch {
      return null;
    }
  };
  let preferences: Record<string, unknown> = {};
  try {
    preferences = JSON.parse(read('arbor.preferences.v1', 'cpa-gui.preferences.v1') ?? '{}') as Record<string, unknown>;
  } catch {
    // Damaged storage draws the defaults, as the app does.
  }
  const art = sidebarArtChoice(preferences.sidebarArt);
  const color = appColorChoice(preferences.appColor);

  // The Mac window has no title bar of its own, so the title row leaves room for its buttons (windowChrome.ts). The
  // browser mock's `?chrome=mac` draws it too.
  const tauri = '__TAURI_INTERNALS__' in window;
  const mac = (tauri && /Macintosh|Mac OS X/.test(navigator.userAgent))
    || (__BOOT_MOCK__ && new URLSearchParams(location.search).get('chrome') === 'mac');
  if (mac) shell.dataset.macTitleBar = '';

  // The sidebar as sidebarLayout.ts works it out: the saved width within what the window allows, hidden when it's
  // saved hidden or the window is too narrow for it and the page side by side.
  const layout = parseSidebarLayout(read('arbor.sidebar.v1'));
  const shown = sidebarShown({ hidden: layout.hidden, narrow: window.innerWidth < NARROW_WINDOW_WIDTH, revealed: false });
  shell.style.setProperty('--sidebar-width', `${clampSidebarWidth(layout.width, sidebarMaxWidth(window.innerWidth))}px`);
  const ink = shown ? sidebarArtInk(art, theme, color) : undefined;
  const halo = sidebarArtHalo(art, theme, color);
  if (halo) shell.style.setProperty('--art-halo', halo);
  shell.querySelectorAll<HTMLElement>('[data-boot-when]').forEach((element) => {
    element.hidden = element.dataset.bootWhen !== (shown ? 'shown' : 'hidden');
  });
  shell.querySelectorAll<HTMLElement>('[data-boot-ink]').forEach((element) => {
    if (ink) element.style.color = ink;
    else element.classList.remove('art-halo');
  });
  // As App.tsx draws it: the sidebar's icon color while the sidebar shows, the ink's halo over the art.
  const toggle = shell.querySelector<HTMLElement>('[data-boot-box="toggle"]');
  if (!shown) toggle?.classList.remove('text-[var(--sidebar-icon-color)]', 'hover:bg-sidebar-row-hover', 'hover:text-sidebar-foreground');
  if (!ink) toggle?.classList.remove('hover:bg-current/10');
  if (!shown) {
    shell.querySelector('aside')?.classList.add('hidden');
    shell.querySelector<HTMLElement>('main')?.style.setProperty('--topbar-start', 'var(--workspace-titlebar-content-left)');
  }

  // The groups React's first frame opens: every one left open by hand, less those that don't fit the window, as
  // SidebarTree fits them. Machines and Pools have nothing to list until their reads answer, so they stay closed.
  const nav = shell.querySelector<HTMLElement>('[data-boot-box="tree"]');
  if (nav && shown) {
    const style = getComputedStyle(nav);
    const rem = parseFloat(getComputedStyle(root).fontSize) || 16;
    const available = (nav.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / rem;
    for (const page of fitOpenGroups(wantedOpen('home', parseOpenChoices(read('arbor.sidebar.tree.v1'))), 'home', available)) {
      const leaves = nav.querySelector<HTMLElement>(`[data-boot-leaves="${page}"]`);
      if (!leaves) continue;
      leaves.hidden = false;
      nav.querySelector(`[data-boot-chevron="${page}"]`)?.classList.add('rotate-90');
    }
  }

  // Home's skeletons with the rows the content had last time: a provider block per provider, with a row per account,
  // and a card per machine, copied from the ones the build drew.
  const { home } = readBootState(read(BOOT_KEY));
  const provider = shell.querySelector<HTMLElement>('[data-boot-provider]');
  if (provider?.parentElement) {
    const card = provider.parentElement;
    const account = provider.querySelector('[data-boot-account]');
    card.querySelectorAll('[data-boot-provider]').forEach((block) => block.remove());
    for (const accounts of home.providers) {
      const block = provider.cloneNode(true) as HTMLElement;
      const list = block.querySelector('ul');
      block.querySelectorAll('[data-boot-account]').forEach((row) => row.remove());
      for (let index = 0; account && list && index < accounts; index++) list.append(account.cloneNode(true));
      card.append(block);
    }
  }
  const attention = shell.querySelector<HTMLElement>('[data-boot-attention]');
  if (attention && needsYouLikely(home.needsYou, Date.now())) {
    const row = attention.querySelector('[data-boot-attention-row]');
    const more = attention.querySelector('[data-boot-attention-more]');
    const card = row?.parentElement;
    attention.querySelectorAll('[data-boot-attention-row]').forEach((element) => element.remove());
    for (let index = 0; row && card && index < home.needsYou.rows; index++) card.insertBefore(row.cloneNode(true), more);
    if (!home.needsYou.more) more?.remove();
    attention.hidden = false;
  } else {
    attention?.remove();
  }
  const machine = shell.querySelector<HTMLElement>('[data-boot-machine]');
  if (machine?.parentElement) {
    const grid = machine.parentElement;
    grid.querySelectorAll('[data-boot-machine]').forEach((card) => card.remove());
    for (let index = 0; index < home.machines; index++) grid.append(machine.cloneNode(true));
  }

  // The art's first frame, the same still moment SidebarArt's canvas draws first, so the handoff doesn't move it. In
  // the first frame rather than here, so drawing it doesn't hold up the page's parse; the window shows a frame later.
  const drawArt = () => {
    const host = shell.querySelector<HTMLElement>('[data-boot-art]');
    if (host && shown && art !== 'off') {
      host.style.height = sidebarArtHeight(sceneRows(art));
      const width = Math.ceil(host.clientWidth), height = Math.ceil(host.clientHeight);
      const canvas = document.createElement('canvas');
      const context = width && height ? canvas.getContext('2d') : null;
      if (context) {
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        canvas.className = 'absolute top-0 left-0 block [image-rendering:pixelated]';
        const image = context.createImageData(width, height);
        drawScene(art, new Uint32Array(image.data.buffer), new Float32Array(width * height), new Float32Array(width * height), width, height, SCENE_STILL_SECONDS, theme, color);
        context.putImageData(image, 0, 0);
        host.append(canvas);
      }
    } else {
      host?.remove();
    }
  };

  // Shown once it has painted: two frames, or a short wait, as a window that isn't on screen yet may run no frames
  // (windowChrome.ts's afterFirstPaint).
  let done = false;
  const ready = () => {
    if (done) return;
    done = true;
    performance.mark('boot-painted');
    const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
    internals?.invoke('frontend_ready', { theme }).catch(() => {
      // main.tsx asks again once React has painted, and the shell shows the window by itself after a short wait.
    });
  };
  let drawn = false;
  const draw = () => {
    if (drawn) return;
    drawn = true;
    drawArt();
  };
  requestAnimationFrame(() => {
    draw();
    requestAnimationFrame(ready);
  });
  setTimeout(() => {
    draw();
    ready();
  }, 100);
})();
