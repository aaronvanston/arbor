type ChunkWindow = Window & { __mockChunkDelayMs?: number; __mockChunkFail?: string };

/**
 * Wraps a lazily loaded chunk's import so the browser mock can slow it down or fail it: `?chunks=slow` holds it back,
 * so what shows while it loads can be seen, and `?chunks=fail` has it fail, as a module the webview can't fetch does.
 */
export const mockableChunk = <T,>(load: () => Promise<T>) => () => {
  const mock = import.meta.env.DEV || import.meta.env.MODE === 'demo' ? (window as ChunkWindow) : null;
  if (mock?.__mockChunkFail) return Promise.reject(new TypeError(mock.__mockChunkFail));
  const delay = mock?.__mockChunkDelayMs ?? 0;
  return delay ? new Promise<void>((resolve) => window.setTimeout(resolve, delay)).then(load) : load();
};
