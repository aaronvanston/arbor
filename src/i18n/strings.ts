import { en, type MessageKey } from './locales/en';

/**
 * The UI's strings. A build ships the ones the launch's code names here, and each lazily loaded page, dialog or viewer
 * brings its own as it loads (scripts/vite-split-strings.mjs); in dev and the tests this is the whole table.
 */
export const strings: Record<MessageKey, string> = en;
