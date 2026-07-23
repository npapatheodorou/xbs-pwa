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
 * Derive the AES-GCM key from a password and sync ID.
 *
 * The sync ID is the PBKDF2 salt. Note that the official client stores the
 * base64 of this derived key under the name "password" and imports it directly
 * as the AES key at decrypt time -- there is no second derivation step. This
 * client never persists the key or the password; it lives in memory only, for
 * the lifetime of the page.
 *
 * @param {string} password
 * @param {string} syncId used as the PBKDF2 salt
 * @returns {Promise<CryptoKey>} a non-extractable AES-GCM key
 */
export async function deriveKey(password, syncId) {
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
    // Not extractable: this client only ever decrypts, and never needs to export
    // or persist the key material.
    false,
    ['decrypt']
  );
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
