import { describe, expect, it } from 'bun:test';
import { buildErrorReport, describeError } from '../src/services/errorReport';

const at = new Date('2026-09-25T03:04:05.678Z');

describe('error report', () => {
  it('lists the versions, page, time, error and both stacks', () => {
    const error = new TypeError('Cannot read properties of undefined (reading \'limits\')');
    error.stack = 'TypeError: Cannot read properties of undefined (reading \'limits\')\n    at AccountsPage (AccountsPage.tsx:12:3)\n    at renderWithHooks\n';
    const report = buildErrorReport({
      appVersion: '0.3.33',
      coreVersion: 'v7.3.15',
      pageId: 'settings:auth-files',
      at,
      error,
      componentStack: '\n    at AccountsPage\n    at PageErrorBoundary\n',
    });
    expect(report).toBe([
      'Arbor error report',
      'App version: 0.3.33',
      'Core version: v7.3.15',
      'Page: settings:auth-files',
      'Time: 2026-09-25T03:04:05.678Z',
      'Error: TypeError: Cannot read properties of undefined (reading \'limits\')',
      '',
      'Stack:',
      'TypeError: Cannot read properties of undefined (reading \'limits\')',
      '    at AccountsPage (AccountsPage.tsx:12:3)',
      '    at renderWithHooks',
      '',
      'Component stack:',
      '    at AccountsPage',
      '    at PageErrorBoundary',
    ].join('\n'));
  });

  it('says unknown for what it could not learn and none for missing stacks', () => {
    const error = new Error('boom');
    error.stack = undefined;
    const report = buildErrorReport({ appVersion: null, coreVersion: '  ', at: new Date(Number.NaN), error });
    expect(report).toContain('App version: unknown\nCore version: unknown\nPage: unknown\nTime: unknown\nError: Error: boom');
    expect(report).toContain('Stack:\n(none)\n\nComponent stack:\n(none)');
  });

  it('keeps line endings plain', () => {
    const report = buildErrorReport({ at, error: 'x', componentStack: '\r\n    at One\r\n    at Two\r\n' });
    expect(report.endsWith('Component stack:\n    at One\n    at Two')).toBe(true);
  });

  it('describes thrown values that are not errors', () => {
    expect(describeError('plain text')).toEqual({ name: 'Thrown value', message: 'plain text', stack: '' });
    expect(describeError(undefined)).toEqual({ name: 'Thrown value', message: 'undefined', stack: '' });
    expect(describeError(Object.create(null)).message).toBe('[object Object]');
    expect(describeError({ message: 'shaped like an error' })).toEqual({ name: 'Error', message: 'shaped like an error', stack: '' });
    expect(buildErrorReport({ at, error: 42 })).toContain('Error: Thrown value: 42');
  });

  it('shows just the name when the message is empty', () => {
    const error = new RangeError();
    expect(buildErrorReport({ at, error })).toContain('Error: RangeError\n');
  });
});
