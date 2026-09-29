// Types for release-signing.mjs, which stays plain JavaScript so node can run it without a build step.
import type { KeyObject } from 'node:crypto';

type SignedFeed = { schemaVersion: 1; manifest: string; signature: string };

export const FEED_SIGNING_CONTEXT: string;
export const KEYCHAIN_SERVICE: string;
export const KEYCHAIN_ACCOUNT: string;
export const PUBLIC_KEY_FILE: string;

export function rawPublicKey(key: KeyObject): string;
export function signFeed(manifest: string, privateKey: KeyObject): SignedFeed;
export function verifyFeed(feed: unknown, publicKey: string): string;
