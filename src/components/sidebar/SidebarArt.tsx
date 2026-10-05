import { useEffect, useRef } from 'react';
import { useAppPreferences } from '../../appPreferences';
import type { AppColor } from '../../services/appColor';
import { SIDEBAR_ART_SPEED, sidebarArtMotionChoice, type SidebarArt as SidebarArtChoice } from '../../services/sidebarArt';
import { drawScene, sceneClock, sceneRows, sceneWakeDelay, SCENE_STILL_SECONDS, type SceneName } from '../../services/sidebarScenes';
import type { AppTheme } from '../../theme';

/**
 * The artwork behind the sidebar's title row, as T3 has its stage backdrop: a layer at the top of the sidebar as tall
 * as its scene asks (80px, or more for the canopy), overhanging the search row. It's behind everything and deaf to the
 * pointer, so the whole title row still drags the window.
 */
export function SidebarArt({ art, theme, color }: { art: SidebarArtChoice; theme: AppTheme; color: AppColor }) {
  const speed = SIDEBAR_ART_SPEED[sidebarArtMotionChoice(useAppPreferences().sidebarArtMotion)];
  if (art === 'off') return null;
  return (
    <div
      aria-hidden="true"
      // Raised 6px from T3's placement; the scenes (services/sidebarScenes.ts) are laid out for this. What's past the
      // title row is in rem, as the rows under it are.
      className="pointer-events-none absolute inset-x-0 -top-1.5 z-0 overflow-hidden select-none"
      style={{ height: `calc(var(--workspace-topbar-height) + ${(sceneRows(art) - 52) / 16}rem)` }}
      data-slot="sidebar-art"
    >
      <SceneCanvas scene={art} theme={theme} color={color} speed={speed} />
    </div>
  );
}

/**
 * A scene in Arbor's color on a canvas, a canvas pixel per CSS px, scaled up without smoothing so each dither dot stays crisp. It moves
 * `speed` times its own pace, and only while Arbor's window is visible and in front, so it costs nothing behind other
 * windows; at speed 0 (the Still setting) or under Reduce motion it's drawn once, at one still moment.
 */
function SceneCanvas({ scene, theme, color, speed }: { scene: SceneName; theme: AppTheme; color: AppColor; speed: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current, host = canvas?.parentElement, context = canvas?.getContext('2d');
    if (!canvas || !host || !context) return;
    const clock = sceneClock();
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let image: ImageData | null = null;
    let pixels: Uint32Array | null = null;
    let value = new Float32Array(0), drift = new Float32Array(0);
    let frame = 0;
    // Between the scene's frames it sleeps on a timer instead of waking every display frame (sceneWakeDelay).
    let wake = 0;

    // Sizes the canvas to the strip; false while the strip has no size (a hidden sidebar).
    const fit = () => {
      const width = Math.ceil(host.clientWidth), height = Math.ceil(host.clientHeight);
      if (!width || !height) return false;
      if (image && image.width === width && image.height === height) return true;
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      image = context.createImageData(width, height);
      pixels = new Uint32Array(image.data.buffer);
      value = new Float32Array(width * height);
      drift = new Float32Array(width * height);
      return true;
    };
    const draw = (seconds: number) => {
      if (!image || !pixels) return;
      drawScene(scene, pixels, value, drift, image.width, image.height, seconds, theme, color);
      context.putImageData(image, 0, 0);
    };
    const still = () => speed === 0 || (reduce?.matches ?? false);
    const moving = () => !still() && document.visibilityState === 'visible' && document.hasFocus();
    const redraw = () => {
      if (fit()) draw(still() ? SCENE_STILL_SECONDS : clock.seconds);
    };
    const loop = (now: number) => {
      frame = 0;
      if (!moving()) {
        clock.pause();
        return;
      }
      const seconds = clock.tick(now, speed);
      if (seconds === null) {
        frame = requestAnimationFrame(loop);
        return;
      }
      if (fit()) draw(seconds);
      wake = window.setTimeout(() => {
        wake = 0;
        if (!frame) frame = requestAnimationFrame(loop);
      }, sceneWakeDelay(clock.dueAt, performance.now()));
    };
    const follow = () => {
      if (!moving()) {
        // A sleep cut short, so coming back in front draws on the next display frame, as it always has.
        window.clearTimeout(wake);
        wake = 0;
        clock.pause();
        if (still()) redraw();
        return;
      }
      if (!frame && !wake) frame = requestAnimationFrame(loop);
    };

    redraw();
    follow();
    const resized = new ResizeObserver(redraw);
    resized.observe(host);
    window.addEventListener('focus', follow);
    window.addEventListener('blur', follow);
    document.addEventListener('visibilitychange', follow);
    reduce?.addEventListener('change', follow);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(wake);
      resized.disconnect();
      window.removeEventListener('focus', follow);
      window.removeEventListener('blur', follow);
      document.removeEventListener('visibilitychange', follow);
      reduce?.removeEventListener('change', follow);
    };
  }, [scene, theme, color, speed]);

  return <canvas ref={canvasRef} aria-hidden="true" className="absolute top-0 left-0 block [image-rendering:pixelated]" />;
}
