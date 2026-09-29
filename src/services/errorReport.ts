export type ErrorReportInput = {
  appVersion?: string | null;
  coreVersion?: string | null;
  /** The page on screen when it happened, as `viewPageId` names it. */
  pageId?: string | null;
  at: Date;
  /** Whatever was thrown, which isn't always an Error. */
  error: unknown;
  /** React's component stack from the error boundary that caught it. */
  componentStack?: string | null;
};

export type DescribedError = { name: string; message: string; stack: string };

function safeString(value: unknown) {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Name, message and stack of a thrown value, with plain text for things that aren't errors. */
export function describeError(error: unknown): DescribedError {
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    const { name, message, stack } = error as { name?: unknown; message: string; stack?: unknown };
    return {
      name: typeof name === 'string' && name ? name : 'Error',
      message,
      stack: typeof stack === 'string' ? stack : '',
    };
  }
  return { name: 'Thrown value', message: safeString(error), stack: '' };
}

const known = (value: string | null | undefined) => value?.trim() || 'unknown';

// Drop the blank lines React puts before a component stack but keep each frame's indent.
const block = (text: string | null | undefined) => (text ?? '').replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();

function isoTime(at: Date) {
  return Number.isNaN(at.getTime()) ? 'unknown' : at.toISOString();
}

/** Plain text to paste into a bug report or an agent: versions, where and when, then both stacks. */
export function buildErrorReport({ appVersion, coreVersion, pageId, at, error, componentStack }: ErrorReportInput) {
  const { name, message, stack } = describeError(error);
  return [
    'Arbor error report',
    `App version: ${known(appVersion)}`,
    `Core version: ${known(coreVersion)}`,
    `Page: ${known(pageId)}`,
    `Time: ${isoTime(at)}`,
    `Error: ${message ? `${name}: ${message}` : name}`,
    '',
    'Stack:',
    block(stack) || '(none)',
    '',
    'Component stack:',
    block(componentStack) || '(none)',
  ].join('\n');
}
