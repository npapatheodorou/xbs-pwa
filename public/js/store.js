/**
 * Local persistence.
 *
 * What is stored on the device:
 *   - service URL and sync ID  (identifiers, not secrets)
 *   - the ENCRYPTED bookmarks blob, verbatim as the API returned it
 *
 * What is never stored:
 *   - the password
 *   - the derived key
 *   - decrypted bookmarks
 *
 * Caching the encrypted blob rather than the plaintext is what lets the app
 * work offline without keeping any secret at rest: decryption happens locally,
 * so an offline launch just needs the password again.
 */

const SETTINGS_KEY = 'xbs.settings.v1';
const CACHE_KEY = 'xbs.cache.v1';

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

/** Clear everything this app has stored, including the service worker caches. */
export async function forgetEverything() {
  try {
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(CACHE_KEY);
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
