/**
 * Verifies the shipped decryption pipeline against payloads produced exactly
 * the way the official xBrowserSync client produces them.
 *
 * The reference encryptor below is a direct transcription of `encryptData` and
 * `getPasswordHash` from the official client's crypto.service.ts, using the
 * real lzutf8 library and real WebCrypto. If our decrypt agrees with it, the
 * read path is compatible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import lz from 'lzutf8';
import { webcrypto } from 'node:crypto';

import {
  deriveKey,
  decryptBookmarks,
  base64ToBytes,
  bytesToBase64,
  exportKey,
  importKey
} from '../public/js/crypto.js';

// The shipped modules expect browser globals.
globalThis.crypto ??= webcrypto;
globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary');
globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64');

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/* ------------------------- official client, transcribed ------------------ */

async function officialPasswordHash(password, syncId) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(password);
  const imported = await crypto.subtle.importKey('raw', keyData, { name: 'PBKDF2' }, false, [
    'deriveKey'
  ]);
  const derived = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode(syncId), iterations: 250000, hash: 'SHA-256' },
    imported,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  return b64(new Uint8Array(await crypto.subtle.exportKey('raw', derived)));
}

async function officialEncrypt(plaintext, passwordHash) {
  const keyData = base64ToBytes(passwordHash);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['encrypt']);
  const compressed = lz.compress(plaintext);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, compressed);
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return b64(combined);
}

/* --------------------------------- tests -------------------------------- */

const SYNC_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PASSWORD = 'correct horse battery staple ñ😀';

test('derived key matches the official client byte-for-byte', async () => {
  // Our deriveKey returns a non-extractable CryptoKey, so compare by using it:
  // a payload encrypted under the official hash must decrypt under our key.
  const hash = await officialPasswordHash(PASSWORD, SYNC_ID);
  const payload = await officialEncrypt(JSON.stringify([{ id: 1, title: 'ok' }]), hash);

  const key = await deriveKey(PASSWORD, SYNC_ID);
  const result = await decryptBookmarks(payload, key);
  assert.deepEqual(result, [{ id: 1, title: 'ok' }]);
});

test('round-trips a realistic bookmark tree', async () => {
  const tree = [
    {
      id: 1,
      title: '[xbs] Toolbar',
      children: [
        {
          id: 2,
          title: 'Ünicode ✓ 😀',
          url: 'https://example.com/x?a=1&b=2',
          description: 'desc with émoji 🎉',
          tags: ['news', 'tech']
        },
        { id: 3, title: 'Folder', children: [{ id: 4, title: 'Nested', url: 'https://n.example' }] },
        { id: 5, title: '|', url: 'xbs:separator' }
      ]
    },
    { id: 6, title: '[xbs] Other', children: [] }
  ];

  const hash = await officialPasswordHash(PASSWORD, SYNC_ID);
  const key = await deriveKey(PASSWORD, SYNC_ID);
  const payload = await officialEncrypt(JSON.stringify(tree), hash);

  assert.deepEqual(await decryptBookmarks(payload, key), tree);
});

test('handles a large sync', async () => {
  const tree = Array.from({ length: 5000 }, (_, i) => ({
    id: i,
    title: `Bookmark ${i} 中文`,
    url: `https://example.com/${i}`,
    tags: ['a', 'b']
  }));

  const hash = await officialPasswordHash(PASSWORD, SYNC_ID);
  const key = await deriveKey(PASSWORD, SYNC_ID);
  const payload = await officialEncrypt(JSON.stringify(tree), hash);

  assert.deepEqual(await decryptBookmarks(payload, key), tree);
});

test('a wrong password is rejected, never silently wrong', async () => {
  const hash = await officialPasswordHash(PASSWORD, SYNC_ID);
  const payload = await officialEncrypt(JSON.stringify([{ id: 1 }]), hash);

  const wrongKey = await deriveKey('not the password', SYNC_ID);
  await assert.rejects(() => decryptBookmarks(payload, wrongKey));
});

test('the sync ID is the salt: the same password on another sync fails', async () => {
  const hash = await officialPasswordHash(PASSWORD, SYNC_ID);
  const payload = await officialEncrypt(JSON.stringify([{ id: 1 }]), hash);

  const otherKey = await deriveKey(PASSWORD, 'ffffffffffffffffffffffffffffffff');
  await assert.rejects(() => decryptBookmarks(payload, otherKey));
});

test('an empty sync decrypts to an empty array', async () => {
  const key = await deriveKey(PASSWORD, SYNC_ID);
  assert.deepEqual(await decryptBookmarks('', key), []);
});

test('truncated payloads are rejected', async () => {
  const key = await deriveKey(PASSWORD, SYNC_ID);
  await assert.rejects(() => decryptBookmarks(b64(new Uint8Array(8)), key));
});

/* --------------------- "stay signed in" saved-key path ------------------- */

test('base64 helpers round-trip arbitrary bytes', () => {
  for (const length of [0, 1, 2, 3, 31, 32, 255]) {
    const bytes = new Uint8Array(length).map((_, i) => (i * 37) % 256);
    assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  }
});

test('an exported key re-imports and still decrypts the same sync', async () => {
  // This is the whole "stay signed in" mechanism: derive once, persist the
  // exported key, and decrypt with it on later launches without the password.
  const hash = await officialPasswordHash(PASSWORD, SYNC_ID);
  const tree = [{ id: 1, title: 'Saved session', url: 'https://example.com' }];
  const payload = await officialEncrypt(JSON.stringify(tree), hash);

  const derived = await deriveKey(PASSWORD, SYNC_ID, { extractable: true });
  const saved = await exportKey(derived);

  // What gets persisted must be the raw 32-byte AES key, exactly the
  // representation the official client stores.
  assert.equal(base64ToBytes(saved).length, 32);
  assert.equal(saved, hash);

  const reimported = await importKey(saved);
  assert.deepEqual(await decryptBookmarks(payload, reimported), tree);
});

test('keys are non-extractable unless remembering was requested', async () => {
  const ephemeral = await deriveKey(PASSWORD, SYNC_ID);
  await assert.rejects(
    () => exportKey(ephemeral),
    'a key derived without extractable:true must not be exportable'
  );

  // And a key re-imported from storage is likewise locked down.
  const derived = await deriveKey(PASSWORD, SYNC_ID, { extractable: true });
  const reimported = await importKey(await exportKey(derived));
  await assert.rejects(() => exportKey(reimported));
});

test('a corrupt or wrong-length saved key is rejected', async () => {
  await assert.rejects(() => importKey(bytesToBase64(new Uint8Array(16))));
  await assert.rejects(() => importKey(bytesToBase64(new Uint8Array(0))));
  await assert.rejects(() => importKey('not base64 at all!!'));
});

test('a saved key from a different sync cannot decrypt this one', async () => {
  const hash = await officialPasswordHash(PASSWORD, SYNC_ID);
  const payload = await officialEncrypt(JSON.stringify([{ id: 1 }]), hash);

  const otherDerived = await deriveKey(PASSWORD, 'ffffffffffffffffffffffffffffffff', {
    extractable: true
  });
  const otherSaved = await importKey(await exportKey(otherDerived));
  await assert.rejects(() => decryptBookmarks(payload, otherSaved));
});

test('tampered ciphertext is rejected by the GCM tag', async () => {
  const hash = await officialPasswordHash(PASSWORD, SYNC_ID);
  const key = await deriveKey(PASSWORD, SYNC_ID);
  const payload = await officialEncrypt(JSON.stringify([{ id: 1, title: 'x' }]), hash);

  const bytes = base64ToBytes(payload);
  bytes[bytes.length - 5] ^= 0xff; // flip a bit in the ciphertext
  await assert.rejects(() => decryptBookmarks(b64(bytes), key));
});
