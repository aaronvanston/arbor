import { afterEach, describe, expect, it } from 'bun:test';
import {
  accountInitials,
  avatarText,
  clearAccountProfile,
  defaultAccountColor,
  fileProfile,
  getAccountProfiles,
  profilesByAuthIndex,
  saveAccountProfile,
} from '../src/services/accountProfiles';
import { present } from './support/items';

afterEach(() => clearAccountProfile('work.json::1'));

describe('saveAccountProfile', () => {
  it('takes any color a machine can have: the palette, or a picked hex kept in lower case', () => {
    saveAccountProfile('work.json::1', { color: 'rose' });
    expect(getAccountProfiles()['work.json::1']).toEqual({ color: 'rose' });
    saveAccountProfile('work.json::1', { color: '#E11D48' });
    expect(getAccountProfiles()['work.json::1']).toEqual({ color: '#e11d48' });
  });

  it("drops what isn't a color, and a profile with nothing left in it", () => {
    saveAccountProfile('work.json::1', { name: 'Work', color: 'chartreuse' as never });
    expect(getAccountProfiles()['work.json::1']).toEqual({ name: 'Work' });
    saveAccountProfile('work.json::1', { name: '  ', color: 'red; background: url(x)' as never });
    expect(getAccountProfiles()['work.json::1']).toBeUndefined();
  });

  it('keeps a fill other than soft, which is what an avatar is without one', () => {
    saveAccountProfile('work.json::1', { fill: 'outline' });
    expect(getAccountProfiles()['work.json::1']).toEqual({ fill: 'outline' });
    saveAccountProfile('work.json::1', { name: 'Work', fill: 'soft' });
    expect(getAccountProfiles()['work.json::1']).toEqual({ name: 'Work' });
    saveAccountProfile('work.json::1', { name: 'Work', fill: 'glow' as never });
    expect(getAccountProfiles()['work.json::1']).toEqual({ name: 'Work' });
  });

  it('keeps an avatar as it shows: in capitals and three characters at most', () => {
    saveAccountProfile('work.json::1', { avatar: ' ops team ' });
    expect(getAccountProfiles()['work.json::1']).toEqual({ avatar: 'OPS' });
  });
});

describe('avatarText', () => {
  it('counts an emoji made of several code points as one character, and never cuts one in half', () => {
    expect(avatarText('ab')).toBe('AB');
    expect(avatarText('🇦🇺🦊x')).toBe('🇦🇺🦊X');
    expect(avatarText('ab👩‍💻z')).toBe('AB👩‍💻');
  });
});

describe('defaultAccountColor', () => {
  it('keeps the color an account always had now that accounts share the machines’ palette', () => {
    expect(['claude-max.json::claude-1', 'codex-team.json::codex-2', 'codex-casey.json::codex-1'].map(defaultAccountColor)).toEqual(['slate', 'amber', 'blue']);
  });
});

describe('fileProfile', () => {
  it('resolves a file under its quota key, with the saved profile winning over the file name', () => {
    const file = { name: 'claude-max.json', auth_index: 'claude-1' };
    expect(fileProfile(file, { 'claude-max.json::claude-1': { name: 'P4', color: 'slate' } })).toEqual({ name: 'P4', avatar: 'P4', color: 'slate', fill: 'soft', custom: true });
    expect(fileProfile(file, {})).toMatchObject({ name: 'claude-max', avatar: 'MA', custom: false });
  });
});

describe('profilesByAuthIndex', () => {
  it("finds each request's account by the auth index it carries, trimmed like the core's", () => {
    const byIndex = profilesByAuthIndex(
      [
        { name: 'claude-max.json', auth_index: ' claude-1 ' },
        { name: 'codex-team.json', authIndex: 'codex-2' },
      ],
      { 'codex-team.json::codex-2': { name: 'P3', avatar: 'OPS', color: 'violet' } },
    );
    expect(present(byIndex.get('claude-1')).name).toBe('claude-max');
    expect(present(byIndex.get('codex-2'))).toMatchObject({ name: 'P3', avatar: 'OPS', color: 'violet' });
  });

  it('skips files without an index and keeps the first file listed for one', () => {
    const byIndex = profilesByAuthIndex(
      [
        { name: 'runtime.json' },
        { name: 'first.json', auth_index: 'idx' },
        { name: 'second.json', auth_index: 'idx' },
      ],
      {},
    );
    expect([...byIndex.keys()]).toEqual(['idx']);
    expect(present(byIndex.get('idx')).name).toBe('first');
  });
});

describe('accountInitials', () => {
  it('takes a letter-and-number tag from a file name', () => {
    expect(accountInitials('CC-P1-samrivera.json')).toBe('P1');
    expect(accountInitials('CX-W2-sam.json')).toBe('W2');
  });

  it('falls back to the first letters otherwise', () => {
    expect(accountInitials('claude-max.json')).toBe('MA');
    expect(accountInitials('grok-sam.json')).toBe('SA');
  });

  it("skips the id the core puts in the name of a file it saved", () => {
    expect(accountInitials('claude-5772b8d7-sam.side@example.com.json')).toBe('SS');
    expect(accountInitials('codex-9f1e2a3b-casey@example.com-pro.json')).toBe('CA');
    // A word made of the letters a to f is still a name.
    expect(accountInitials('claude-facade.json')).toBe('FA');
  });
});
