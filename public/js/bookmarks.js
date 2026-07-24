/**
 * Bookmark tree helpers.
 *
 * Schema (from the official client's `cleanBookmark`, which whitelists exactly
 * these keys): { id?, title?, url?, description?, tags?, children? }
 *
 * Node kind is inferred rather than stored:
 *   - a `children` array           -> folder
 *   - a reserved title at the root -> container
 *   - url === 'xbs:separator'      -> separator
 */

/** Reserved root container titles, mapped to display names. */
const CONTAINER_TITLES = {
  '[xbs] Toolbar': 'Toolbar',
  '[xbs] Menu': 'Menu',
  '[xbs] Other': 'Other'
};

const SEPARATOR_URL = 'xbs:separator';

export function isSeparator(node) {
  return node?.url === SEPARATOR_URL;
}

export function isFolder(node) {
  return Array.isArray(node?.children);
}

/** Friendly label for a node, falling back sensibly for untitled bookmarks. */
export function displayTitle(node) {
  const title = (node?.title || '').trim();
  if (CONTAINER_TITLES[title]) return CONTAINER_TITLES[title];
  if (title) return title;
  if (node?.url) return node.url;
  return isFolder(node) ? 'Untitled folder' : 'Untitled';
}

/**
 * Only allow protocols that are safe to hand to `window.open`.
 * Bookmarks are the user's own data, but a `javascript:` URL in a synced
 * bookmark should still never be navigable from this app.
 */
export function isSafeUrl(url) {
  try {
    const { protocol } = new URL(url, window.location.href);
    return ['http:', 'https:', 'ftp:', 'mailto:'].includes(protocol);
  } catch {
    return false;
  }
}

/** Host portion of a URL, for the secondary line in the list. */
export function displayHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Every openable bookmark inside a folder, including nested subfolders.
 *
 * Separators and anything with an unsupported URL scheme are skipped, so the
 * result is exactly the set that "open all" can actually open.
 *
 * @param {object} node a folder node
 * @returns {Array} bookmark nodes in display order
 */
export function collectOpenable(node) {
  const found = [];
  const walk = (list) => {
    for (const child of sortedChildren({ children: list })) {
      if (isFolder(child)) walk(child.children);
      else if (!isSeparator(child) && child.url && isSafeUrl(child.url)) found.push(child);
    }
  };
  walk(node?.children);
  return found;
}

/**
 * Total number of non-separator bookmarks in a tree.
 * @param {Array} nodes
 */
export function countBookmarks(nodes) {
  let count = 0;
  const walk = (list) => {
    for (const node of list || []) {
      if (isFolder(node)) walk(node.children);
      else if (!isSeparator(node)) count++;
    }
  };
  walk(nodes);
  return count;
}

/**
 * Search the tree, returning flat results ordered by relevance.
 *
 * All whitespace-separated terms must match (AND), each against any of title,
 * URL, description or tags. Results carry the folder path they were found in so
 * the flattened list stays navigable.
 *
 * @param {Array} nodes
 * @param {string} query
 * @param {number} limit
 */
export function searchBookmarks(nodes, query, limit = 300) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];

  const results = [];

  const walk = (list, path) => {
    for (const node of list || []) {
      if (isFolder(node)) {
        walk(node.children, [...path, displayTitle(node)]);
        continue;
      }
      if (isSeparator(node)) continue;

      const title = (node.title || '').toLowerCase();
      const url = (node.url || '').toLowerCase();
      const description = (node.description || '').toLowerCase();
      const tags = (node.tags || []).join(' ').toLowerCase();

      const matchesAll = terms.every(
        (term) =>
          title.includes(term) ||
          url.includes(term) ||
          description.includes(term) ||
          tags.includes(term)
      );
      if (!matchesAll) continue;

      // Rank title matches above matches that only occur in metadata, and
      // prefix matches above matches buried mid-string.
      let score = 0;
      for (const term of terms) {
        if (title.startsWith(term)) score += 4;
        else if (title.includes(term)) score += 3;
        else if (tags.includes(term)) score += 2;
        else if (url.includes(term)) score += 1;
      }

      results.push({ node, path, score });
    }
  };

  walk(nodes, []);

  results.sort(
    (a, b) => b.score - a.score || displayTitle(a.node).localeCompare(displayTitle(b.node))
  );
  return results.slice(0, limit);
}

/**
 * Sort a node's children for display: folders first, then alphabetically.
 * Separators keep their original position, so they still divide the list.
 */
export function sortedChildren(node) {
  const children = node?.children || [];
  return [...children].sort((a, b) => {
    if (isSeparator(a) || isSeparator(b)) return 0;
    const aFolder = isFolder(a);
    const bFolder = isFolder(b);
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return displayTitle(a).localeCompare(displayTitle(b));
  });
}

/**
 * Stable-ish key for remembering which folders are expanded across renders.
 * Falls back to the path when a node has no id.
 */
export function nodeKey(node, path) {
  return node?.id != null ? `id:${node.id}` : `path:${path.join('/')}/${node?.title || ''}`;
}
