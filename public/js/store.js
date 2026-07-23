/**
 * Local persistence.
 *
 * What is stored on the device:
 *   - service URL and sync ID  (identifiers, not secrets)
 *   - the ENCRYPTED bookmarks blob, verbatim as the API returned it
 *   - optionally, if the user chose to stay signed in, the derived AES key
 *
 * What is never stored:
 *   - the password itself
 *   - decrypted bookmarks
 *
 * The saved credential is the *derived key*, not the password. It is exactly
 * what is needed to decrypt this one sync and nothing else, so a password the
 * user may have reused elsewhere is never written to disk. This matches what
 * the official client persists.
 *
 * Caching the encrypted blob rather than the plaintext is what lets the app
 * work offline: decryption still happens locally on every launch.
 */

const SETTINGS_KEY = 'xbs.settings.v1';
const CACHE_KEY = 'xbs.cache.v1';
const KEY_KEY = 'xbs.key.v1';

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // Corrupt or unavailable storage (e.g. Safari private mode) is treated as
    // "nothing stored" rather than a hard failure.
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** @returns {{serviceUrl: string, syncId: string} | null} */
export function getSettings() {
  const settings = readJson(SETTINGS_KEY);
  if (!settings?.serviceUrl || !settings?.syncId) return null;
  return settings;
}

export function saveSettings({ serviceUrl, syncId }) {
  return writeJson(SETTINGS_KEY, { serviceUrl, syncId });
}

/**
 * @returns {{bookmarks: string, lastUpdated: string, fetchedAt: string} | null}
 * the cached encrypted payload
 */
export function getCachedSync() {
  const cache = readJson(CACHE_KEY);
  if (!cache?.bookmarks) return null;
  return cache;
}

export function saveCachedSync({ bookmarks, lastUpdated }) {
  return writeJson(CACHE_KEY, {
    bookmarks,
    lastUpdated,
    fetchedAt: new Date().toISOString()
  });
}

/* ------------------------------------------------------------ saved login */

/**
 * The base64 derived key for a remembered login, or null.
 * @returns {string | null}
 */
export function getSavedKey() {
  const saved = readJson(KEY_KEY);
  return typeof saved?.key === 'string' ? saved.key : null;
}

/**
 * @param {string} base64Key
 * @param {string} syncId recorded so a key left over from a different sync is
 *   never applied to the wrong one
 */
export function saveKey(base64Key, syncId) {
  return writeJson(KEY_KEY, { key: base64Key, syncId });
}

/** Which sync a saved key belongs to, or null. */
export function getSavedKeySyncId() {
  return readJson(KEY_KEY)?.syncId ?? null;
}

export function hasSavedKey() {
  return getSavedKey() !== null;
}

/** Sign out of the saved session, keeping the sync ID and cached bookmarks. */
export function clearSavedKey() {
  try {
    localStorage.removeItem(KEY_KEY);
  } catch {
    /* nothing we can do if storage is unavailable */
  }
}

/* ---------------------------------------------------------------- wipe */

/** Clear everything this app has stored, including the service worker caches. */
export async function forgetEverything() {
  try {
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(KEY_KEY);
  } catch {
    /* nothing we can do if storage is unavailable */
  }

  if ('caches' in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    } catch {
      /* cache clearing is best-effort */
    }
  }
}
