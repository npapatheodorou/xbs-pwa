/**
 * xBrowserSync decryption pipeline.
 *
 * Mirrors CryptoService in the official client
 * (https://github.com/xbrowsersync/app -> src/modules/shared/crypto/crypto.service.ts).
 * Every parameter here is load-bearing for compatibility; see README.md for the
 * annotated derivation of each one.
 */

import { decompressToString } from './lzutf8.js';

const KEY_GEN_ALGORITHM = 'PBKDF2';
const KEY_GEN_ITERATIONS = 250000;
const KEY_GEN_HASH = 'SHA-256';
const ENCRYPTION_ALGORITHM = 'AES-GCM';
const KEY_LENGTH_BITS = 256;

/** The official client uses a 16-byte IV, not the more common 12. */
const IV_LENGTH_BYTES = 16;

/**
 * Decode base64 to bytes.
 * @param {string} value
 * @returns {Uint8Array}
 */
export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode bytes as base64.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Derive the AES-GCM key from a password and sync ID.
 *
 * The sync ID is the PBKDF2 salt. Note that the official client stores the
 * base64 of this derived key under the name "password" and imports it directly
 * as the AES key at decrypt time -- there is no second derivation step.
 *
 * By default the key is non-extractable and lives in memory only. Pass
 * `extractable: true` when the user has chosen to stay signed in, so it can be
 * exported once and persisted in place of the password.
 *
 * @param {string} password
 * @param {string} syncId used as the PBKDF2 salt
 * @param {{extractable?: boolean}} [options]
 * @returns {Promise<CryptoKey>} an AES-GCM key
 */
export async function deriveKey(password, syncId, { extractable = false } = {}) {
  const encoder = new TextEncoder();

  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: KEY_GEN_ALGORITHM },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: KEY_GEN_ALGORITHM,
      salt: encoder.encode(syncId),
      iterations: KEY_GEN_ITERATIONS,
      hash: KEY_GEN_HASH
    },
    baseKey,
    { name: ENCRYPTION_ALGORITHM, length: KEY_LENGTH_BITS },
    extractable,
    ['decrypt']
  );
}

/**
 * Export a derived key as base64, to persist a "stay signed in" session.
 *
 * This is the same representation the official client stores: the raw 32-byte
 * AES key, base64 encoded. The key must have been derived with
 * `extractable: true`.
 *
 * @param {CryptoKey} key
 * @returns {Promise<string>}
 */
export async function exportKey(key) {
  return bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

/**
 * Re-import a persisted key.
 *
 * Imported as non-extractable: once stored there is never a reason to export it
 * again, so this narrows what a script running on the page could get back out.
 *
 * @param {string} base64Key
 * @returns {Promise<CryptoKey>}
 */
export async function importKey(base64Key) {
  const keyData = base64ToBytes(base64Key);
  if (keyData.length !== KEY_LENGTH_BITS / 8) {
    throw new Error('Stored key is the wrong length.');
  }
  return crypto.subtle.importKey('raw', keyData, { name: ENCRYPTION_ALGORITHM }, false, ['decrypt']);
}

/**
 * Decrypt a base64 sync payload and parse the bookmarks JSON.
 *
 * Payload layout: base64( iv[16] || aes-gcm-ciphertext-with-tag ), where the
 * plaintext is LZ-UTF8-compressed JSON.
 *
 * @param {string} encryptedData base64 payload from the API
 * @param {CryptoKey} key from deriveKey()
 * @returns {Promise<Array>} the decrypted bookmark tree
 * @throws if the password is wrong (GCM tag mismatch) or the data is malformed
 */
export async function decryptBookmarks(encryptedData, key) {
  if (!encryptedData) {
    // An empty sync is legitimate: a sync ID that has been created but never
    // written to returns an empty bookmarks string.
    return [];
  }

  const bytes = base64ToBytes(encryptedData);
  if (bytes.length <= IV_LENGTH_BYTES) {
    throw new Error('Encrypted payload is too short to be valid.');
  }

  const iv = bytes.slice(0, IV_LENGTH_BYTES);
  const ciphertext = bytes.slice(IV_LENGTH_BYTES);

  // Throws OperationError on tag mismatch, which is how a wrong password
  // surfaces. AES-GCM is authenticated, so this cannot silently return garbage.
  const decrypted = await crypto.subtle.decrypt(
    { name: ENCRYPTION_ALGORITHM, iv },
    key,
    ciphertext
  );

  const json = decompressToString(new Uint8Array(decrypted));
  const parsed = JSON.parse(json);

  if (!Array.isArray(parsed)) {
    throw new Error('Decrypted data is not a bookmark array.');
  }
  return parsed;
}
