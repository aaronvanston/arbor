import { describe, expect, it } from 'bun:test';
import { highlightLanguage } from '../src/services/highlightLanguages';

describe('highlightLanguage', () => {
  it('highlights a file whose grammar Arbor ships, under any of its names, and draws the rest as plain text', () => {
    expect(['SKILL.md', 'config.toml', 'settings.json', 'hooks/notify.sh', 'compose.yaml'].map(highlightLanguage)).toEqual(['markdown', 'toml', 'json', 'zsh', 'yaml']);
    expect(['nginx.conf', 'main.adb', 'infra.tf'].map(highlightLanguage)).toEqual(['text', 'text', 'text']);
  });
});
