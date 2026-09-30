import { useMemo } from 'react';
import { useAppPreferences } from '../appPreferences';
import { shownIdentity } from './emailPrivacy';
import { isIdentityFill, keptColor, type IdentityColor, type IdentityFill, type PickedColor } from './identityColors';
import { normalizeAuthIndex } from './managementApi';
import { fileName, quotaKey, type AuthFile } from './quotaService';
import { savedStore, storedRecord } from './savedStore';

/** What was set for an account. Its color and fill are any a machine can have: the shared palette or a picked hex. */
export type AccountProfile = { name?: string; avatar?: string; color?: PickedColor; fill?: IdentityFill };
type ProfileMap = Record<string, AccountProfile>;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A label's characters as people count them, so an emoji built from several code points (a flag, a family) is one. */
export const avatarCharacters = (value: string) => Array.from(graphemes.segment(value), ({ segment }) => segment);

/** An avatar as it's shown: in capitals, and at most three characters, never cutting an emoji in half. */
export const avatarText = (value: string) => avatarCharacters(value.toUpperCase()).slice(0, 3).join('');

/** A profile with only what's set in it, each part checked, or null when nothing is. */
function keptProfile(value: unknown): AccountProfile | null {
  if (!value || typeof value !== 'object') return null;
  const { name, avatar, color, fill } = value as Record<string, unknown>;
  const profile: AccountProfile = {};
  if (typeof name === 'string' && name.trim()) profile.name = name.trim();
  if (typeof avatar === 'string' && avatar.trim()) profile.avatar = avatarText(avatar.trim());
  const kept = keptColor(color);
  if (kept) profile.color = kept;
  // Soft is what an avatar is without a choice, so it isn't kept.
  if (isIdentityFill(fill) && fill !== 'soft') profile.fill = fill;
  return Object.keys(profile).length ? profile : null;
}

/** Each account's profile, keeping only what's set and valid. */
function parseProfiles(raw: string | null): ProfileMap {
  const kept: ProfileMap = {};
  for (const [key, value] of Object.entries(storedRecord(raw))) {
    const profile = keptProfile(value);
    if (profile) kept[key] = profile;
  }
  return kept;
}

const store = savedStore<ProfileMap>({ key: 'arbor.account-profiles.v1', parse: parseProfiles, fallback: {} });

export const getAccountProfiles = store.get;

export function saveAccountProfile(key: string, profile: AccountProfile) {
  const cleaned = keptProfile(profile);
  const next = { ...store.get() };
  if (cleaned) next[key] = cleaned;
  else delete next[key];
  store.set(next);
}

/** Moves profiles to a credential's new key after a rename. A profile already saved under the new key wins. */
export function renameAccountProfiles(renames: { from: string; to: string }[]) {
  let next = store.get();
  for (const { from, to } of renames) {
    const moved = next[from];
    if (from === to || !moved) continue;
    next = { ...next };
    if (!next[to]) next[to] = moved;
    delete next[from];
  }
  store.set(next);
}

export const clearAccountProfile = (key: string) => saveAccountProfile(key, {});

/**
 * The saved profiles. Hiding email addresses changes the names accounts without one fall back to, so the map is a new
 * one then too, and whatever was worked out from it is worked out again.
 */
export function useAccountProfiles() {
  const saved = store.useValue();
  const { hideEmails } = useAppPreferences();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ({ ...saved }), [saved, hideEmails]);
}

/**
 * Colors an account gets by default: the nine accounts had before they shared the machines' palette, in their order,
 * so an account nobody picked a color for keeps the one it always had.
 */
const DEFAULT_COLORS: readonly IdentityColor[] = ['slate', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'];

/** Stable default color so an account keeps the same tint until the user picks one. */
export function defaultAccountColor(key: string): IdentityColor {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return DEFAULT_COLORS[hash % DEFAULT_COLORS.length]!;
}

export function accountInitials(name: string): string {
  const base = name.replace(/\.json$/i, '').replace(/^(claude|codex|kimi|grok|xai|antigravity|gemini)[-_]/i, '');
  const local = base.split('@')[0] ?? base;
  // The core names a file it saved by the account's id and email (claude-5772b8d7-sam@…); the id says nothing about whose it is.
  const parts = local.split(/[^\p{L}\p{N}]+/u).filter((part) => part && !/^(?=.*\d)[0-9a-f]{6,}$/i.test(part));
  // A letter and a number in the name, like CC-P1-sam's P1 or CC-W2-sam's W2, is how the files are told apart.
  const tag = parts.find((part) => /^\p{L}\d{1,2}$/u.test(part));
  if (tag) return tag.toUpperCase();
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? local).slice(0, 2);
  return (letters || name.slice(0, 2)).toUpperCase();
}

export type ResolvedProfile = { name: string; avatar: string; color: PickedColor; fill: IdentityFill; custom: boolean };

/** File name without its extension, used when no display name is set. */
const displayFileName = (fileName: string) => fileName.replace(/\.json$/i, '');

export function resolveAccountProfile(key: string, fileName: string, profile: AccountProfile | undefined): ResolvedProfile {
  // A file name can carry the account's email, so it's hidden with it.
  const name = profile?.name || shownIdentity(displayFileName(fileName), { fileName });
  return {
    name,
    avatar: profile?.avatar || accountInitials(profile?.name || fileName),
    color: profile?.color ?? defaultAccountColor(key),
    fill: profile?.fill ?? 'soft',
    custom: Boolean(profile && Object.keys(profile).length),
  };
}

/** A credential file's profile, under the key its limits and profile are kept by. */
export function fileProfile(file: AuthFile, profiles: ProfileMap): ResolvedProfile {
  const key = quotaKey(file);
  return resolveAccountProfile(key, fileName(file), profiles[key]);
}

/**
 * Each credential's profile by the auth index the core records its requests under, for rows that carry only that. The
 * first file listed for an index wins, as the core names one credential per index.
 */
export function profilesByAuthIndex(files: AuthFile[], profiles: ProfileMap): Map<string, ResolvedProfile> {
  const byIndex = new Map<string, ResolvedProfile>();
  for (const file of files) {
    const index = normalizeAuthIndex(file.auth_index ?? file.authIndex);
    if (index && !byIndex.has(index)) byIndex.set(index, fileProfile(file, profiles));
  }
  return byIndex;
}
