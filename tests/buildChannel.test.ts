import { describe, expect, test } from 'bun:test';
import { buildChannelLabel, buildChannelOf } from '../src/services/buildChannel';

describe('buildChannelOf', () => {
  test('reads the kind of build from its version', () => {
    expect(buildChannelOf('1.0.27', false)).toBe('stable');
    expect(buildChannelOf('v1.0.27', false)).toBe('stable');
    expect(buildChannelOf('1.0.27-nightly.20261002.1', false)).toBe('nightly');
    expect(buildChannelOf('1.0.27-dev.20261002.1', false)).toBe('dev');
    expect(buildChannelOf('1.0.27-dev', false)).toBe('dev');
  });

  test('only counts a whole prerelease word', () => {
    expect(buildChannelOf('1.0.27-nightlyish', false)).toBe('stable');
    expect(buildChannelOf('1.0.27-device.1', false)).toBe('stable');
    expect(buildChannelOf('', false)).toBe('stable');
  });

  test('a development build is dev whatever its version says', () => {
    expect(buildChannelOf('1.0.27', true)).toBe('dev');
    expect(buildChannelOf('1.0.27-nightly.20261002.1', true)).toBe('dev');
  });
});

test('only nightly and dev builds are marked', () => {
  expect(buildChannelLabel('stable')).toBeNull();
  expect(buildChannelLabel('nightly')).toBe('app.build.nightly');
  expect(buildChannelLabel('dev')).toBe('app.build.dev');
});
