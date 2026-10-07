import { useEffect, useRef, useState } from 'react';

const DURATION_MS = 600;
const easeOutCubic = (progress: number) => 1 - (1 - progress) ** 3;

/**
 * Tweens from the previously rendered value to `target` so refreshed figures roll into place
 * instead of snapping. Null targets are returned as-is; the first non-null value is not animated.
 *
 * `step` is the finest change the caller shows (1 for a rounded percent, 0.1 for one decimal): the value only
 * updates when it crosses one, so a figure rolling from 72 to 80 renders 8 times rather than every frame.
 */
export function useAnimatedNumber(target: number | null, step = 0, durationMs = DURATION_MS): number | null {
  const [value, setValue] = useState<number | null>(target);
  const valueRef = useRef<number | null>(target);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    const from = valueRef.current;
    const reduceMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (target === null || from === null || from === target || typeof requestAnimationFrame !== 'function' || reduceMotion) {
      valueRef.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    let shown = from;
    const frame = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      const next = progress < 1 ? from + (target - from) * easeOutCubic(progress) : target;
      valueRef.current = next;
      if (progress >= 1 || !step || Math.round(next / step) !== Math.round(shown / step)) {
        shown = next;
        setValue(next);
      }
      if (progress < 1) frameRef.current = requestAnimationFrame(frame);
      else frameRef.current = null;
    };
    frameRef.current = requestAnimationFrame(frame);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [target, step, durationMs]);

  return value;
}
