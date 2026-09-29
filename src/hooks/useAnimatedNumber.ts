import { useEffect, useRef, useState } from 'react';

const DURATION_MS = 600;
const easeOutCubic = (progress: number) => 1 - (1 - progress) ** 3;

/**
 * Tweens from the previously rendered value to `target` so refreshed figures roll into place
 * instead of snapping. Null targets are returned as-is; the first non-null value is not animated.
 */
export function useAnimatedNumber(target: number | null, durationMs = DURATION_MS): number | null {
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
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      const next = from + (target - from) * easeOutCubic(progress);
      valueRef.current = next;
      setValue(next);
      if (progress < 1) frameRef.current = requestAnimationFrame(step);
      else frameRef.current = null;
    };
    frameRef.current = requestAnimationFrame(step);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [target, durationMs]);

  return value;
}
