/**
 * Whether the page loaded inside Arbor's own shell. Read as this module loads, which main.tsx makes happen before it
 * can install the browser mock: the mock stands in for the shell, so any later look would say yes in a plain browser.
 */
export const IN_REAL_SHELL = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
