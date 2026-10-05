import { appColorChoice } from '../services/appColor';
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
