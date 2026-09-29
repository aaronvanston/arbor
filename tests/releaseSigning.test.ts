import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PUBLIC_KEY_FILE, rawPublicKey, signFeed, verifyFeed } from '../scripts/release-signing.mjs';
import fixture from './fixtures/signed-update-feed.json';

const manifest = `${JSON.stringify({ schemaVersion: 1, version: '0.3.180' }, null, 2)}\n`;

describe('release signing', () => {
  test('the committed fixture verifies, as the Rust tests also check', () => {
    expect(JSON.parse(verifyFeed(fixture.feed, fixture.publicKey)).version).toBe('0.3.200');
  });

  test('a signed list keeps the manifest text exactly and verifies only unchanged, with its own key', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const feed = signFeed(manifest, privateKey);
    expect(feed.manifest).toBe(manifest);
    expect(verifyFeed(feed, rawPublicKey(privateKey))).toBe(manifest);

    expect(() => verifyFeed({ ...feed, manifest: manifest.replace('0.3.180', '0.3.181') }, rawPublicKey(privateKey))).toThrow("doesn't match");
    const other = generateKeyPairSync('ed25519').privateKey;
    expect(() => verifyFeed(feed, rawPublicKey(other))).toThrow("doesn't match");
    expect(() => verifyFeed({ manifest, signature: feed.signature }, rawPublicKey(privateKey))).toThrow('Not a signed');
  });

  test('only JSON is signed', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    expect(() => signFeed('not json', privateKey)).toThrow();
  });

  test("the app's public key is a 32-byte key, and the test fixture isn't signed with it", () => {
    const key = readFileSync(PUBLIC_KEY_FILE, 'utf8').trim();
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(key).not.toBe(fixture.publicKey);
    expect(() => verifyFeed(fixture.feed, key)).toThrow("doesn't match");
  });
});
