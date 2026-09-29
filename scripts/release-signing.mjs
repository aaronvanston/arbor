// Signs Arbor's update list. The app installs an update only when the list it reads from a GitHub release carries a
// signature from this key, so write access to the releases alone can't ship an update. The private key lives in the
// Keychain of the Mac that publishes releases; the public half, src-tauri/release-signing.pub, is compiled into the app.
//
//   node scripts/release-signing.mjs keygen                       makes the key (once), stores it, writes the .pub
//   node scripts/release-signing.mjs check                        stops when this Mac can't sign for the app's key
//   node scripts/release-signing.mjs sign --manifest M --output O writes O, the signed update list for manifest M
//
// ARBOR_RELEASE_SIGNING_KEY (the private key as base64 PKCS#8) stands in for the Keychain, e.g. from a backup.
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Signed ahead of the list, so the key can't be used to vouch for anything but an Arbor update list. */
export const FEED_SIGNING_CONTEXT = 'Arbor update feed v1\n';
export const KEYCHAIN_SERVICE = 'Arbor release signing key';
export const KEYCHAIN_ACCOUNT = 'arbor';
export const PUBLIC_KEY_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../src-tauri/release-signing.pub');

const signedBytes = (manifest) => Buffer.concat([Buffer.from(FEED_SIGNING_CONTEXT, 'utf8'), Buffer.from(manifest, 'utf8')]);

/** A raw 32-byte Ed25519 public key, as base64, from a key object. */
export function rawPublicKey(key) {
  const { x } = createPublicKey(key).export({ format: 'jwk' });
  if (!x) throw new Error('Not an Ed25519 key');
  return Buffer.from(x, 'base64url').toString('base64');
}

function publicKeyFromRaw(base64) {
  const raw = Buffer.from(base64.trim(), 'base64');
  if (raw.length !== 32) throw new Error('The release signing public key must be 32 bytes of base64');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

/** The signed update list: the manifest's exact text and a signature over it, which the app checks before reading it. */
export function signFeed(manifest, privateKey) {
  JSON.parse(manifest);
  return { schemaVersion: 1, manifest, signature: sign(null, signedBytes(manifest), privateKey).toString('base64') };
}

/** The manifest text of a signed update list, when its signature is from `publicKey` (raw, base64); else it throws. */
export function verifyFeed(feed, publicKey) {
  if (feed?.schemaVersion !== 1 || typeof feed.manifest !== 'string' || typeof feed.signature !== 'string') {
    throw new Error('Not a signed Arbor update list');
  }
  if (!verify(null, signedBytes(feed.manifest), publicKeyFromRaw(publicKey), Buffer.from(feed.signature, 'base64'))) {
    throw new Error("The update list's signature doesn't match the release signing key");
  }
  return feed.manifest;
}

function security(args, input) {
  const result = spawnSync('/usr/bin/security', args, { encoding: 'utf8', input });
  if (result.error) throw result.error;
  return result;
}

function keychainKey() {
  const result = security(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w']);
  return result.status === 0 ? result.stdout.trim() : '';
}

function privateKey() {
  const stored = process.env.ARBOR_RELEASE_SIGNING_KEY?.trim() || keychainKey();
  if (!stored) {
    throw new Error(`There's no "${KEYCHAIN_SERVICE}" in this Mac's Keychain. Releases are signed on the Mac that holds it; restore it from its backup, or set ARBOR_RELEASE_SIGNING_KEY.`);
  }
  return createPrivateKey({ key: Buffer.from(stored, 'base64'), format: 'der', type: 'pkcs8' });
}

/** The private key, once it's known to be the one whose public half the app checks for. */
async function signingKey() {
  const key = privateKey();
  const expected = (await readFile(PUBLIC_KEY_FILE, 'utf8')).trim();
  if (rawPublicKey(key) !== expected) {
    throw new Error(`The signing key here isn't the one in ${PUBLIC_KEY_FILE}; the app would refuse what it signs.`);
  }
  return key;
}

async function keygen() {
  if (keychainKey()) throw new Error(`This Mac's Keychain already has "${KEYCHAIN_SERVICE}"; keygen only makes the first one.`);
  if (existsSync(PUBLIC_KEY_FILE)) {
    throw new Error(`${PUBLIC_KEY_FILE} already names a key. Apps built with it accept only that key, so restore its private half instead.`);
  }
  const { privateKey: key } = generateKeyPairSync('ed25519');
  const der = key.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  // Through stdin rather than the command line, so the key never shows in the process list.
  const stored = security(['-i'], `add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${KEYCHAIN_ACCOUNT}" -w "${der}"\n`);
  if (stored.status !== 0 || keychainKey() !== der) throw new Error(`Couldn't store the key in the Keychain: ${stored.stderr.trim()}`);
  await writeFile(PUBLIC_KEY_FILE, `${rawPublicKey(key)}\n`);
  console.log(`Stored "${KEYCHAIN_SERVICE}" in the login Keychain and wrote ${PUBLIC_KEY_FILE}.`);
  console.log('Back the private key up somewhere safe: without it, every Mac needs one update installed by hand.');
  console.log(`  security find-generic-password -s "${KEYCHAIN_SERVICE}" -a ${KEYCHAIN_ACCOUNT} -w`);
}

function options(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? '';
    const value = argv[index + 1];
    if (!flag.startsWith('--') || value === undefined) throw new Error(`Unexpected argument: ${flag}`);
    values[flag.slice(2)] = value;
  }
  return values;
}

async function main([command, ...argv]) {
  switch (command) {
    case 'keygen':
      return keygen();
    case 'check':
      await signingKey();
      return;
    case 'sign': {
      const { manifest: manifestPath, output } = options(argv);
      if (!manifestPath || !output) throw new Error('sign needs --manifest and --output');
      const key = await signingKey();
      const feed = signFeed(await readFile(manifestPath, 'utf8'), key);
      verifyFeed(feed, rawPublicKey(key));
      const temporary = `${output}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(feed, null, 2)}\n`);
      await rename(temporary, output);
      return;
    }
    default:
      throw new Error('Usage: release-signing.mjs keygen|check|sign --manifest <file> --output <file>');
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPoint) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
