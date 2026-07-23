/**
 * xBrowserSync REST API client.
 *
 * Endpoints and error semantics mirror the official API
 * (https://github.com/xbrowsersync/api -> src/routers/bookmarks.router.ts).
 * This module only ever talks to the service URL the user configured.
 */

export const DEFAULT_SERVICE_URL = 'https://api.xbrowsersync.org';

/** Minimum API version the official client requests, sent as Accept-Version. */
const API_VERSION = '1.1.9';

const REQUEST_TIMEOUT_MS = 15000;

export class ApiError extends Error {
  constructor(message, { status, code, offline } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.offline = Boolean(offline);
  }
}

/** Strip any trailing slashes so path joining is predictable. */
export function normaliseServiceUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * A sync ID is a 32-character hex string; the API parses it as a binary UUID
 * and rejects anything else.
 */
export function isValidSyncId(syncId) {
  return /^[0-9a-f]{32}$/i.test(String(syncId || '').trim());
}

async function request(serviceUrl, path) {
  const url = `${normaliseServiceUrl(serviceUrl)}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept-Version': API_VERSION },
      // No cookies, no credentials -- the service is anonymous by design.
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal
    });
  } catch (err) {
    // fetch() rejects for network failure, DNS, CORS rejection and abort alike;
    // the browser deliberately does not tell us which.
    throw new ApiError(
      navigator.onLine
        ? 'Could not reach the service. Check the service URL, your connection, and that the instance allows cross-origin requests.'
        : 'You appear to be offline.',
      { offline: !navigator.onLine }
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      /* error bodies are best-effort */
    }
    throw new ApiError(describeHttpError(response.status, payload), {
      status: response.status,
      code: payload?.code
    });
  }

  try {
    return await response.json();
  } catch {
    throw new ApiError('The service returned a response that was not valid JSON.');
  }
}

function describeHttpError(status, payload) {
  switch (true) {
    // The API returns 401 for "sync does not exist", not for a bad password --
    // it never sees the password at all.
    case status === 401:
      return 'Sync ID not found on this service. Check the ID and the service URL.';
    case status === 404:
      return 'That URL does not look like an xBrowserSync service.';
    case status === 405:
      return 'This service is not accepting new syncs.';
    case status === 406:
      return 'The service has reached its daily new-sync limit.';
    case status === 413:
      return 'The sync data exceeds this service’s size limit.';
    case status === 429:
      return 'Too many requests. Wait a while and try again.';
    case status >= 500:
      return 'The service is offline or returned an error.';
    default:
      return payload?.message || `Request failed (HTTP ${status}).`;
  }
}

/**
 * Service info: status, version, message, location, max sync size.
 * Doubles as a reachability/CORS check when validating a service URL.
 */
export function getServiceInfo(serviceUrl) {
  return request(serviceUrl, '/info');
}

/**
 * Fetch the encrypted bookmarks blob.
 * @returns {Promise<{bookmarks: string, lastUpdated: string, version: string}>}
 */
export function getBookmarks(serviceUrl, syncId) {
  return request(serviceUrl, `/bookmarks/${encodeURIComponent(syncId)}`);
}

/** Cheap staleness check without transferring the whole blob. */
export function getLastUpdated(serviceUrl, syncId) {
  return request(serviceUrl, `/bookmarks/${encodeURIComponent(syncId)}/lastUpdated`);
}

/**
 * Sync data format version.
 *
 * Syncs created before API 1.1.3 have no version and use a different, legacy
 * key derivation (the raw password rather than a PBKDF2 hash). We detect that
 * case and refuse rather than silently failing to decrypt.
 */
export function getSyncVersion(serviceUrl, syncId) {
  return request(serviceUrl, `/bookmarks/${encodeURIComponent(syncId)}/version`);
}
