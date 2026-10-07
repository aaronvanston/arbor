import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import { CommandFailure } from '../src/services/commandError';
import { errorWords, plainError, plainErrorReason } from '../src/services/plainError';

const t = (key: Parameters<typeof translate>[0], variables?: Parameters<typeof translate>[1]) => translate(key, variables, {});

describe('errorWords', () => {
  it('drops the "Error: " a thrown Error or a wrapped string starts with', () => {
    expect(errorWords(new Error('database is locked'))).toBe('database is locked');
    expect(errorWords('Error: claude-fable-5-1 is already routed or aliased; remove it first')).toBe('claude-fable-5-1 is already routed or aliased; remove it first');
    expect(errorWords('Error: Error: twice')).toBe('twice');
    expect(errorWords(new TypeError('Importing a module script failed.'))).toBe('Importing a module script failed.');
    expect(errorWords('TypeError: Importing a module script failed.')).toBe('Importing a module script failed.');
  });

  it('leaves words alone that only mention an error', () => {
    expect(errorWords('Telemetry error: none')).toBe('Telemetry error: none');
    expect(errorWords('  Orca couldn’t find the run’s terminal.  ')).toBe('Orca couldn’t find the run’s terminal.');
  });

  it('reads a command failure by its message', () => {
    expect(errorWords({ kind: 'failed', message: 'Couldn’t save' })).toBe('Couldn’t save');
  });
});

describe('plainError', () => {
  it('names the machine ssh couldn’t reach and why', () => {
    expect(plainError('ssh: connect to host cam-mbp port 22: Operation timed out', t)).toBe('cam-mbp didn’t answer over SSH. Check that it’s on and connected.');
    expect(plainError('ssh: connect to host ci-01 port 22: Connection refused', t)).toBe('ci-01 refused the SSH connection. Check that its SSH server is running.');
    expect(plainError('ssh: Could not resolve hostname ci-01: nodename nor servname provided', t)).toBe('Couldn’t find ci-01 on the network. Check its name in your SSH config.');
    expect(plainError('cam@cedar-02: Permission denied (publickey).', t)).toBe('cedar-02 didn’t accept Arbor’s SSH key.');
  });

  it('says a renamed machine by the name it’s shown by', () => {
    const named = (key: Parameters<typeof translate>[0], variables?: Parameters<typeof translate>[1]) => translate(key, variables, { ci01: 'Build box' });
    expect(plainError('ssh: connect to host ci-01 port 22: Operation timed out', named)).toStartWith('Build box didn’t answer');
  });

  it('turns OS errors into what happened, with the file in question', () => {
    expect(plainError('Couldn’t read /Users/cam/.ssh/config: Permission denied (os error 13)', t)).toBe('Arbor isn’t allowed to open ~/.ssh/config. Check its permissions, then try again.');
    expect(plainError('Failed to write configuration directly /Users/cam/Library/Application Support/onl.arbor.app/config.toml: Permission denied (os error 13)', t))
      .toBe('Arbor isn’t allowed to open ~/Library/Application Support/onl.arbor.app/config.toml. Check its permissions, then try again.');
    expect(plainError('Couldn’t read a session file: Permission denied (os error 13)', t)).toBe('Arbor isn’t allowed to open a file it needs. Check its permissions, then try again.');
    expect(plainError('Couldn’t read a kept chunk: No such file or directory (os error 2)', t)).toBe('A file Arbor needs is missing.');
    expect(plainError("Arbor couldn't listen on port 8319: Address already in use (os error 48)", t)).toBe('Another app is using port 8319. Pick another port or quit that app.');
  });

  it('says what an HTTP status means without the URL', () => {
    expect(plainError('HTTP 502: Bad Gateway (https://api.github.com/graphql)', t)).toBe('The server had a problem on its end. Try again in a moment.');
    expect(plainError('The core’s usage queue returned HTTP 401: invalid management key', t)).toBe('The server didn’t accept the sign-in or key.');
    expect(plainError('HTTP 418: teapot', t)).toBe('The server turned the request down (HTTP 418).');
  });

  it('reads the core’s failures by their status, not their sentence', () => {
    const failure = new CommandFailure({ kind: 'core', status: 502, reason: 'request failed', message: 'Management API error (502): request failed' });
    expect(plainError(failure, t)).toBe('The core couldn’t finish the request. Try again in a moment.');
    expect(plainErrorReason(failure, t)).toBe('The core couldn’t finish the request.');
    expect(plainError({ kind: 'core', status: 401, reason: 'x', message: 'anything at all' }, t)).toBe('The core didn’t accept Arbor’s management key. Restart the core, then try again.');
  });

  it('explains a busy database and a part of the window that didn’t load', () => {
    expect(plainError(new Error('database is locked'), t)).toBe('Arbor’s records were busy. Try again in a moment.');
    expect(plainError('Failed to read the fleet: database is locked', t)).toBe('Arbor’s records were busy. Try again in a moment.');
    expect(plainError(new TypeError('Importing a module script failed.'), t)).toBe('Part of Arbor didn’t load. Try again, and restart Arbor if it keeps happening.');
  });

  it('says a request that never got an answer couldn’t reach where it went', () => {
    expect(plainError("Arbor couldn't reach GitHub: error sending request", t)).toBe('Arbor couldn’t reach GitHub. Check the internet connection, then try again.');
    expect(plainError('error sending request for url (https://example.test/x): dns error', t)).toBe('Arbor couldn’t reach the server. Check the internet connection, then try again.');
  });

  it('keeps words it doesn’t recognize, less the "Error: " in front', () => {
    expect(plainError('Error: Orca couldn’t find the run’s terminal. It may have been closed.', t)).toBe('Orca couldn’t find the run’s terminal. It may have been closed.');
  });
});
