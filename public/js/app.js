/**
 * App shell: view routing, sync orchestration and rendering.
 *
 * Security posture:
 *   - the password itself is never persisted, only ever held long enough to
 *     derive a key from
 *   - if the user chooses to stay signed in, the derived key is saved instead;
 *     otherwise it exists in module scope only, for the lifetime of the page
 *   - only the encrypted blob is cached, never decrypted bookmarks
 *   - all bookmark text is rendered via textContent / DOM APIs, never innerHTML
 */

import * as api from './api.js';
import * as store from './store.js';
import { deriveKey, decryptBookmarks, exportKey, importKey } from './crypto.js';
import {
  collectOpenable,
  countBookmarks,
  displayHost,
  displayTitle,
  isFolder,
  isSafeUrl,
  isSeparator,
  nodeKey,
  searchBookmarks,
  sortedChildren
} from './bookmarks.js';

/* ------------------------------------------------------------------ state */

/** The AES key in use. Cleared on lock, logout and page unload. */
let cryptoKey = null;

/** Whether this session's key is also saved to disk ("stay signed in"). */
let keyIsSaved = false;
let bookmarks = [];
let settings = null;

/** Provenance of what is currently on screen, so stale data is never shown as fresh. */
let dataOrigin = null; // 'network' | 'cache'
let lastUpdated = null; // server-reported time of last sync change
let fetchedAt = null; // when this client last successfully fetched
let lastError = null;

const expanded = new Set();
let searchQuery = '';

/* ------------------------------------------------------------------- dom */

const $ = (id) => document.getElementById(id);

const views = {
  setup: $('view-setup'),
  unlock: $('view-unlock'),
  bookmarks: $('view-bookmarks')
};

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.hidden = key !== name;
  }
}

function setBusy(visible, label = 'Working…') {
  $('busy-label').textContent = label;
  $('busy').hidden = !visible;
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

/**
 * Announce something to assistive technology.
 * Opening tabs produces no visible change in this window, so without this a
 * screen-reader user gets no confirmation that anything happened.
 */
function announce(message) {
  const live = $('live');
  if (!live) return;
  // Clearing first guarantees the live region fires even for a repeat message.
  live.textContent = '';
  setTimeout(() => {
    live.textContent = message;
  }, 50);
}

let toastTimer = null;

/**
 * Show a brief message at the bottom of the screen.
 * @param {string} message
 * @param {{persistent?: boolean, duration?: number}} [opts] persistent toasts
 *   stay until dismissed; others auto-hide.
 */
function showToast(message, opts = {}) {
  const el = $('toast');
  if (!el) return;
  clearTimeout(toastTimer);

  el.replaceChildren();
  const text = document.createElement('span');
  text.className = 'toast-msg';
  text.textContent = message;
  el.appendChild(text);

  if (opts.persistent) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', hideToast);
    el.appendChild(close);
  }

  el.hidden = false;
  // Force a reflow so the transition runs on the freshly shown element.
  void el.offsetWidth;
  el.classList.add('is-visible');

  announce(message);

  if (!opts.persistent) {
    toastTimer = setTimeout(hideToast, opts.duration || 3400);
  }
}

function hideToast() {
  const el = $('toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.classList.remove('is-visible');
  toastTimer = setTimeout(() => {
    el.hidden = true;
    el.replaceChildren();
  }, 200);
}

/* -------------------------------------------------------------- rendering */

function iconSvg(paths, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

const FOLDER_ICON = ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'];
const LINK_ICON = [
  'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1',
  'M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1'
];
const CHEVRON = ['M9 6l6 6-6 6'];

/** Arrow leaving a box: the standard "opens in a new tab" marker. */
const EXTERNAL_ICON = [
  'M14 4h6v6',
  'M20 4 10 14',
  'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'
];

/** Stacked windows: open everything in this folder, each in its own tab. */
const OPEN_ALL_ICON = [
  'M8 3h11a2 2 0 0 1 2 2v11',
  'M4 7h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z'
];

/** Build the row for a single bookmark. */
function bookmarkRow(node, pathLabel) {
  const safe = node.url && isSafeUrl(node.url);

  // A real anchor when navigable, so long-press / share / open-in-background
  // all behave natively on mobile.
  const row = document.createElement(safe ? 'a' : 'div');
  row.className = 'row row-bookmark';
  if (safe) {
    row.href = node.url;
    row.target = '_blank';
    row.rel = 'noopener noreferrer';
  }

  row.appendChild(iconSvg(LINK_ICON, 'row-icon'));

  const body = document.createElement('span');
  body.className = 'row-body';

  const title = document.createElement('span');
  title.className = 'row-title';
  title.textContent = displayTitle(node);
  body.appendChild(title);

  const metaParts = [];
  if (node.url) metaParts.push(displayHost(node.url) || node.url);
  if (node.description) metaParts.push(node.description);

  if (metaParts.length || node.tags?.length) {
    const meta = document.createElement('span');
    meta.className = 'row-meta';

    for (const tag of node.tags || []) {
      const tagEl = document.createElement('span');
      tagEl.className = 'tag';
      tagEl.textContent = tag;
      meta.appendChild(tagEl);
    }
    meta.appendChild(document.createTextNode(metaParts.join(' — ')));
    body.appendChild(meta);
  }

  if (pathLabel) {
    const path = document.createElement('span');
    path.className = 'row-meta result-path';
    path.textContent = pathLabel;
    body.appendChild(path);
  }

  row.appendChild(body);

  if (safe) {
    // Marks the row as leaving the app. Decorative only -- the surrounding
    // anchor already conveys the destination to assistive technology.
    row.appendChild(iconSvg(EXTERNAL_ICON, 'row-ext'));
  } else if (node.url) {
    // Non-navigable scheme: show it, but do not make it clickable.
    row.title = `Unsupported link type: ${node.url}`;
  }
  return row;
}

/**
 * Open every bookmark in a folder, each in its own tab.
 *
 * Browsers only allow the FIRST new tab per user gesture without permission;
 * opening several at once requires the site's pop-up permission. So the calls
 * are issued synchronously from the click handler, the successes are counted,
 * and if any were blocked the user gets a calm one-time explanation rather than
 * a blocking alert.
 *
 * Note: window.open is called WITHOUT a 'noopener' feature on purpose. Passing
 * 'noopener' makes window.open return null by spec, which would make every tab
 * look blocked; instead we open normally and sever the opener link ourselves.
 */
function openAllInFolder(node) {
  const targets = collectOpenable(node);
  const label = displayTitle(node);

  if (!targets.length) {
    showToast(`“${label}” has no bookmarks to open.`);
    return;
  }

  // Opening dozens of tabs at once is rarely intended, and on mobile it can
  // wedge the browser. Confirm before anything drastic.
  const MANY = 12;
  if (
    targets.length > MANY &&
    !confirm(`Open all ${targets.length} bookmarks in “${label}” in separate tabs?`)
  ) {
    return;
  }

  let opened = 0;
  for (const bookmark of targets) {
    const win = window.open(bookmark.url, '_blank');
    if (win) {
      // Reverse-tabnabbing guard: the opened page must not reach back into this
      // one. (Cross-origin assignment can throw; that is fine.)
      try {
        win.opener = null;
      } catch (e) {
        /* ignore */
      }
      opened++;
    }
  }

  const blocked = targets.length - opened;
  if (blocked === 0) {
    showToast(`Opened ${opened} ${opened === 1 ? 'tab' : 'tabs'} from “${label}”.`);
  } else {
    // Only reachable while pop-ups are still blocked; once the user allows them
    // for the site, every tab opens and this never shows again.
    showPopupHelp(opened, blocked, targets.length);
  }
}

/**
 * Explain the browser pop-up limit, once, without a blocking dialog.
 */
function showPopupHelp(opened, blocked, total) {
  const lead =
    opened > 0
      ? `Opened ${opened} of ${total} tabs. `
      : 'Your browser opened the first tab only. ';
  showToast(
    `${lead}To open several at once, allow pop-ups for this site — you only need to do it once, then “open all” works every time.`,
    { persistent: true }
  );
}

/** Build a collapsible folder row plus its (lazily rendered) children. */
function folderRow(node, path) {
  const key = nodeKey(node, path);
  const isOpen = expanded.has(key);
  const fragment = document.createDocumentFragment();

  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'row row-folder';
  row.setAttribute('aria-expanded', String(isOpen));

  row.appendChild(iconSvg(CHEVRON, 'chevron'));
  row.appendChild(iconSvg(FOLDER_ICON, 'row-icon'));

  const body = document.createElement('span');
  body.className = 'row-body';
  const title = document.createElement('span');
  title.className = 'row-title';
  title.textContent = displayTitle(node);
  body.appendChild(title);
  row.appendChild(body);

  const total = countBookmarks(node.children);
  const count = document.createElement('span');
  count.className = 'row-count';
  count.textContent = String(total);
  row.appendChild(count);

  const childrenEl = document.createElement('div');
  childrenEl.className = 'children';
  childrenEl.hidden = !isOpen;
  if (isOpen) renderInto(childrenEl, node.children, [...path, displayTitle(node)]);

  row.addEventListener('click', () => {
    const nowOpen = !expanded.has(key);
    if (nowOpen) {
      expanded.add(key);
      // Render on first expand rather than up front: a large sync would
      // otherwise build thousands of nodes the user never looks at.
      if (!childrenEl.hasChildNodes()) {
        renderInto(childrenEl, node.children, [...path, displayTitle(node)]);
      }
    } else {
      expanded.delete(key);
    }
    childrenEl.hidden = !nowOpen;
    row.setAttribute('aria-expanded', String(nowOpen));
  });

  // The open-all control is a sibling of the toggle, not a child of it: a
  // button inside a button is invalid HTML and breaks keyboard navigation.
  const group = document.createElement('div');
  group.className = 'row-group';
  group.appendChild(row);

  if (total > 0) {
    const openAll = document.createElement('button');
    openAll.type = 'button';
    openAll.className = 'row-open-all';
    openAll.title = `Open all ${total} in new tabs`;
    openAll.setAttribute(
      'aria-label',
      `Open all ${total} bookmarks in ${displayTitle(node)} in new tabs`
    );
    openAll.appendChild(iconSvg(OPEN_ALL_ICON, ''));
    openAll.addEventListener('click', (event) => {
      // Without this the click bubbles to the row and toggles the folder.
      event.stopPropagation();
      openAllInFolder(node);
    });
    group.appendChild(openAll);
  }

  fragment.appendChild(group);
  fragment.appendChild(childrenEl);
  return fragment;
}

function renderInto(container, nodes, path) {
  for (const node of sortedChildren({ children: nodes })) {
    if (isSeparator(node)) {
      const hr = document.createElement('div');
      hr.className = 'separator';
      container.appendChild(hr);
    } else if (isFolder(node)) {
      container.appendChild(folderRow(node, path));
    } else {
      container.appendChild(bookmarkRow(node));
    }
  }
}

function render() {
  const tree = $('tree');
  const empty = $('empty-state');
  tree.replaceChildren();

  if (searchQuery) {
    const results = searchBookmarks(bookmarks, searchQuery);
    if (!results.length) {
      empty.hidden = false;
      empty.textContent = `No bookmarks match “${searchQuery}”.`;
      return;
    }
    empty.hidden = true;

    const label = document.createElement('div');
    label.className = 'section-label';
    label.textContent = `${results.length} result${results.length === 1 ? '' : 's'}`;
    tree.appendChild(label);

    for (const { node, path } of results) {
      tree.appendChild(bookmarkRow(node, path.join(' › ')));
    }
    return;
  }

  if (!bookmarks.length) {
    empty.hidden = false;
    empty.textContent = 'This sync has no bookmarks yet.';
    return;
  }
  empty.hidden = true;
  renderInto(tree, bookmarks, []);
}

/* ------------------------------------------------------------ status line */

function formatRelative(iso) {
  if (!iso) return 'unknown';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'unknown';

  const seconds = Math.round((Date.now() - then.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return then.toLocaleDateString();
}

/**
 * Renders provenance honestly: cached data is always labelled as possibly
 * stale, and a failed refresh is never allowed to look like a success.
 */
function updateStatus() {
  const bar = $('status-bar');
  bar.className = 'status';

  if (lastError) {
    bar.classList.add('error');
    bar.textContent = lastError;
    return;
  }

  if (dataOrigin === 'cache') {
    bar.classList.add('stale');
    bar.textContent = `Offline — showing bookmarks cached ${formatRelative(
      fetchedAt
    )}. May be out of date.`;
    return;
  }

  bar.textContent = `Synced ${formatRelative(fetchedAt)} · changed ${formatRelative(lastUpdated)}`;
}

/* --------------------------------------------------------------- syncing */

/**
 * Fetch and decrypt.
 * Falls back to the cached encrypted blob when the network is unavailable, and
 * marks the result as cached so the UI can say so.
 */
async function loadBookmarks({ allowCache = true } = {}) {
  let payload = null;
  let origin = 'network';
  let networkError = null;

  try {
    payload = await api.getBookmarks(settings.serviceUrl, settings.syncId);
  } catch (err) {
    networkError = err;
    const cached = allowCache ? store.getCachedSync() : null;
    if (!cached) throw err;
    payload = cached;
    origin = 'cache';
  }

  // Decrypt before caching, so a payload we cannot read is never written over
  // a good one. Throws on a wrong password (AES-GCM tag mismatch).
  const decrypted = await decryptBookmarks(payload.bookmarks, cryptoKey);

  bookmarks = decrypted;
  dataOrigin = origin;
  lastUpdated = payload.lastUpdated ?? null;

  if (origin === 'network') {
    store.saveCachedSync({ bookmarks: payload.bookmarks, lastUpdated: payload.lastUpdated });
    fetchedAt = new Date().toISOString();
    lastError = null;
  } else {
    fetchedAt = payload.fetchedAt ?? null;
    lastError = null; // the cached-data banner already communicates the problem
  }

  return { origin, networkError };
}

/** Manual refresh from the sync button or pull-to-refresh. */
async function syncNow() {
  if (!cryptoKey) return;
  const btn = $('sync-now');
  btn.classList.add('spinning');
  btn.disabled = true;

  try {
    const payload = await api.getBookmarks(settings.serviceUrl, settings.syncId);
    bookmarks = await decryptBookmarks(payload.bookmarks, cryptoKey);
    store.saveCachedSync({ bookmarks: payload.bookmarks, lastUpdated: payload.lastUpdated });
    dataOrigin = 'network';
    lastUpdated = payload.lastUpdated ?? null;
    fetchedAt = new Date().toISOString();
    lastError = null;
    render();
  } catch (err) {
    // Keep showing what we already have, but say plainly that the refresh failed
    // rather than leaving a stale "synced just now".
    lastError = `Refresh failed: ${err.message}`;
  } finally {
    btn.classList.remove('spinning');
    btn.disabled = false;
    updateStatus();
  }
}

/* --------------------------------------------------------- session control */

function enterBookmarks() {
  searchQuery = '';
  $('search').value = '';
  $('search-clear').hidden = true;

  // Open the top-level containers by default; deeper folders stay collapsed.
  for (const node of bookmarks) {
    if (isFolder(node)) expanded.add(nodeKey(node, []));
  }

  render();
  updateStatus();
  showView('bookmarks');
}

/**
 * Drop all secrets and decrypted data, and return to the unlock screen.
 * Also discards any saved key, since otherwise the next launch would sign
 * straight back in and locking would be meaningless.
 */
function lock() {
  store.clearSavedKey();
  keyIsSaved = false;
  cryptoKey = null;
  bookmarks = [];
  expanded.clear();
  searchQuery = '';
  dataOrigin = null;
  lastError = null;
  $('tree').replaceChildren();
  showError($('unlock-error'), '');
  $('unlock-password').value = '';
  startUnlockView();
}

async function logout() {
  await store.forgetEverything();
  keyIsSaved = false;
  cryptoKey = null;
  bookmarks = [];
  expanded.clear();
  settings = null;
  dataOrigin = null;
  lastUpdated = null;
  fetchedAt = null;
  lastError = null;
  $('tree').replaceChildren();
  $('setup-password').value = '';
  $('unlock-password').value = '';
  startSetupView();
}

function startSetupView() {
  $('setup-service-url').value = api.DEFAULT_SERVICE_URL;
  $('setup-sync-id').value = '';
  showError($('setup-error'), '');
  showView('setup');
}

function startUnlockView(message) {
  $('unlock-sync-id').textContent = settings.syncId;
  $('unlock-service').textContent = settings.serviceUrl;
  $('unlock-remember').checked = false;
  showError($('unlock-error'), message || '');
  showView('unlock');
}

/* ---------------------------------------------------------------- handlers */

$('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError($('setup-error'), '');

  const serviceUrl = api.normaliseServiceUrl($('setup-service-url').value);
  const syncId = $('setup-sync-id').value.trim();
  const password = $('setup-password').value;

  if (!serviceUrl) return showError($('setup-error'), 'Enter a service URL.');
  if (!/^https:\/\//i.test(serviceUrl) && !/^http:\/\/localhost(:|\/|$)/i.test(serviceUrl)) {
    return showError(
      $('setup-error'),
      'The service URL must use https:// (a page served over HTTPS cannot call an insecure endpoint).'
    );
  }
  if (!api.isValidSyncId(syncId)) {
    return showError($('setup-error'), 'A sync ID is 32 characters, using 0-9 and a-f.');
  }
  if (!password) return showError($('setup-error'), 'Enter your password.');

  try {
    setBusy(true, 'Checking service…');
    // Validates reachability, CORS and that it really is an xBrowserSync API.
    const info = await api.getServiceInfo(serviceUrl);
    if (!info?.version || info.status === undefined) {
      throw new Error('That URL does not look like an xBrowserSync service.');
    }

    // Syncs predating API 1.1.3 use a different, legacy key derivation that
    // this client deliberately does not implement.
    setBusy(true, 'Checking sync…');
    const { version } = await api.getSyncVersion(serviceUrl, syncId);
    if (!version) {
      throw new Error(
        'This sync uses a legacy format from an old xBrowserSync version. Update it with the official browser extension first.'
      );
    }

    const remember = $('setup-remember').checked;

    setBusy(true, 'Deriving key…');
    // 250k PBKDF2 rounds: about a second on a modern phone, longer on old ones.
    cryptoKey = await deriveKey(password, syncId, { extractable: remember });

    setBusy(true, 'Fetching bookmarks…');
    settings = { serviceUrl, syncId };
    await loadBookmarks({ allowCache: false });

    // Only persist once decryption has actually succeeded, so we never save
    // credentials that turn out not to work.
    store.saveSettings(settings);
    if (remember) await rememberKey(syncId);
    else {
      store.clearSavedKey();
      keyIsSaved = false;
    }

    $('setup-password').value = '';
    enterBookmarks();
  } catch (err) {
    cryptoKey = null;
    settings = null;
    showError($('setup-error'), explain(err));
  } finally {
    setBusy(false);
  }
});

$('unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError($('unlock-error'), '');

  const password = $('unlock-password').value;
  if (!password) return showError($('unlock-error'), 'Enter your password.');

  try {
    const remember = $('unlock-remember').checked;

    setBusy(true, 'Deriving key…');
    cryptoKey = await deriveKey(password, settings.syncId, { extractable: remember });

    setBusy(true, 'Fetching bookmarks…');
    await loadBookmarks({ allowCache: true });

    // The checkbox is authoritative: unchecking it must also discard any key
    // saved earlier, or the next launch would sign straight back in.
    if (remember) await rememberKey(settings.syncId);
    else {
      store.clearSavedKey();
      keyIsSaved = false;
    }

    $('unlock-password').value = '';
    enterBookmarks();
  } catch (err) {
    cryptoKey = null;
    showError($('unlock-error'), explain(err));
  } finally {
    setBusy(false);
  }
});

/**
 * Persist the current key so the next launch skips the password prompt.
 * Failure here is not fatal: the session continues, just not remembered.
 */
async function rememberKey(syncId) {
  try {
    store.saveKey(await exportKey(cryptoKey), syncId);
    keyIsSaved = true;
  } catch {
    keyIsSaved = false;
  }
}

/**
 * Turn an exception into something a person can act on. A decryption failure is
 * reported as a wrong password because AES-GCM authentication makes that by far
 * the likeliest cause.
 */
function explain(err) {
  if (err instanceof api.ApiError) return err.message;
  if (err?.name === 'OperationError' || err?.name === 'InvalidAccessError') {
    return 'Could not decrypt. Check your password.';
  }
  if (err instanceof SyntaxError) {
    return 'Decrypted data was not valid — check your password.';
  }
  return err?.message || 'Something went wrong.';
}

$('unlock-forget').addEventListener('click', () => {
  if (confirm('Forget this sync and its cached bookmarks on this device?')) logout();
});

$('sync-now').addEventListener('click', syncNow);

/* search */
let searchTimer = null;
$('search').addEventListener('input', (event) => {
  const value = event.target.value;
  $('search-clear').hidden = !value;
  clearTimeout(searchTimer);
  // Debounced: re-rendering a large tree on every keystroke is visibly janky.
  searchTimer = setTimeout(() => {
    searchQuery = value.trim();
    render();
  }, 140);
});

$('search-clear').addEventListener('click', () => {
  $('search').value = '';
  $('search-clear').hidden = true;
  searchQuery = '';
  render();
  $('search').focus();
});

/* menu sheet */
function openSheet() {
  $('sheet-service').textContent = settings.serviceUrl;
  $('sheet-sync-id').textContent = settings.syncId;
  $('sheet-last-synced').textContent =
    dataOrigin === 'cache'
      ? `${formatRelative(fetchedAt)} (cached, may be stale)`
      : formatRelative(fetchedAt);
  $('sheet-count').textContent = String(countBookmarks(bookmarks));
  $('sheet-signed-in').textContent = keyIsSaved
    ? 'Yes — key saved on this device'
    : 'No — password needed next launch';

  // "Sign out" only makes sense when there is a saved key to discard; "Lock"
  // only when there is not, since otherwise the next launch would let you
  // straight back in.
  $('sheet-sign-out').hidden = !keyIsSaved;
  $('sheet-lock').hidden = keyIsSaved;

  $('sheet-backdrop').hidden = false;
}

const closeSheet = () => {
  $('sheet-backdrop').hidden = true;
};

$('menu-btn').addEventListener('click', openSheet);
$('sheet-close').addEventListener('click', closeSheet);
$('sheet-backdrop').addEventListener('click', (event) => {
  if (event.target === $('sheet-backdrop')) closeSheet();
});

$('sheet-expand').addEventListener('click', () => {
  const walk = (nodes, path) => {
    for (const node of nodes || []) {
      if (!isFolder(node)) continue;
      expanded.add(nodeKey(node, path));
      walk(node.children, [...path, displayTitle(node)]);
    }
  };
  walk(bookmarks, []);
  render();
  closeSheet();
});

$('sheet-collapse').addEventListener('click', () => {
  expanded.clear();
  render();
  closeSheet();
});

$('sheet-lock').addEventListener('click', () => {
  closeSheet();
  lock();
});

$('sheet-sign-out').addEventListener('click', () => {
  closeSheet();
  // Same path as Lock: it discards the saved key and returns to the prompt.
  lock();
});

$('sheet-logout').addEventListener('click', async () => {
  if (!confirm('Forget this sync? Stored settings and cached bookmarks will be deleted.')) return;
  closeSheet();
  await logout();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('sheet-backdrop').hidden) closeSheet();
});

/* ------------------------------------------------------- pull to refresh */

(function installPullToRefresh() {
  const scroller = $('scroller');
  const ptr = $('ptr');
  const label = $('ptr-label');
  const THRESHOLD = 64;
  const MAX = 96;

  let startY = 0;
  let pulling = false;

  scroller.addEventListener(
    'touchstart',
    (event) => {
      // Only engage at the very top, so it never fights normal scrolling.
      if (scroller.scrollTop > 0 || event.touches.length !== 1) return;
      startY = event.touches[0].clientY;
      pulling = true;
      ptr.classList.add('dragging');
    },
    { passive: true }
  );

  scroller.addEventListener(
    'touchmove',
    (event) => {
      if (!pulling) return;
      const delta = event.touches[0].clientY - startY;
      if (delta <= 0) {
        ptr.style.height = '0px';
        return;
      }
      // Resistance curve, so the pull feels damped rather than 1:1.
      const height = Math.min(MAX, delta * 0.5);
      ptr.style.height = `${height}px`;
      label.textContent = height >= THRESHOLD ? 'Release to refresh' : 'Pull to refresh';
    },
    { passive: true }
  );

  const end = async () => {
    if (!pulling) return;
    pulling = false;
    ptr.classList.remove('dragging');
    const triggered = parseFloat(ptr.style.height || '0') >= THRESHOLD;
    ptr.style.height = '0px';
    if (triggered) {
      label.textContent = 'Refreshing…';
      await syncNow();
      label.textContent = 'Pull to refresh';
    }
  };

  scroller.addEventListener('touchend', end, { passive: true });
  scroller.addEventListener('touchcancel', end, { passive: true });
})();

/* ------------------------------------------------------------- lifecycle */

// Re-check freshness when returning to the app, but only if already unlocked.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cryptoKey && dataOrigin === 'cache') {
    syncNow();
  }
});

window.addEventListener('online', () => {
  if (cryptoKey && dataOrigin === 'cache') syncNow();
});

/**
 * Sign in with a saved key, if there is one for this sync.
 * @returns {Promise<boolean>} whether the app is now showing bookmarks
 */
async function tryAutoUnlock() {
  const savedKey = store.getSavedKey();
  if (!savedKey) return false;

  // A key left over from a different sync must never be applied to this one:
  // it would simply fail to decrypt, but the error would be confusing.
  if (store.getSavedKeySyncId() !== settings.syncId) {
    store.clearSavedKey();
    return false;
  }

  try {
    setBusy(true, 'Opening…');
    cryptoKey = await importKey(savedKey);
    keyIsSaved = true;
    await loadBookmarks({ allowCache: true });
    enterBookmarks();
    return true;
  } catch (err) {
    cryptoKey = null;
    keyIsSaved = false;

    // A network failure with nothing cached is not a credential problem, so
    // keep the saved key and let the user retry.
    if (err instanceof api.ApiError) {
      startUnlockView(`${err.message} Your saved sign-in is still in place.`);
      return true;
    }

    // Anything else means the saved key no longer decrypts this sync -- most
    // likely the password was changed elsewhere. Discard it and ask again.
    store.clearSavedKey();
    startUnlockView('Your saved sign-in no longer works. Please enter your password.');
    return true;
  } finally {
    setBusy(false);
  }
}

async function main() {
  // Web Crypto is only exposed in a secure context; without it nothing works.
  if (!window.isSecureContext || !crypto?.subtle) {
    document.body.innerHTML =
      '<div class="noscript">This app needs a secure context (HTTPS or localhost) for the Web Crypto API. Open it over https://.</div>';
    return;
  }

  settings = store.getSettings();
  if (!settings) {
    startSetupView();
  } else if (!(await tryAutoUnlock())) {
    startUnlockView();
  }

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch {
      // The app is fully usable online without the service worker.
    }
  }
}

main();
