/**
 * Integrity checks on the static site itself.
 *
 * These catch the class of mistake that unit tests cannot: a renamed file, a
 * typo in a path, an icon referenced but never generated. On a no-build-step
 * site there is no bundler to notice a broken reference.
 *
 * The site has two pages: index.html is the landing page, app.html is the app
 * (and the manifest's start_url, so that is what gets installed).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const read = (relative) => fs.readFileSync(path.join(PUBLIC, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(PUBLIC, relative.replace(/^\.\//, '')));

const PAGES = ['index.html', 'app.html'];

test('every local path referenced by either page exists', () => {
  for (const page of PAGES) {
    const html = read(page);
    const refs = [...html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((m) => m[1]);

    assert.ok(refs.length > 3, `${page} should reference several local files`);
    for (const ref of refs) {
      // "./" is the landing page itself, served as index.html.
      if (ref === './') continue;
      assert.ok(exists(ref), `${page} references missing file: ${ref}`);
    }
  }
});

test('the landing page links to the app', () => {
  const html = read('index.html');
  assert.match(html, /href="\.\/app\.html"/, 'landing page must link to the app');
});

test('every icon in the manifest exists and the manifest is valid', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));

  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.name && manifest.short_name);
  assert.ok(manifest.start_url && manifest.scope);
  assert.ok(manifest.theme_color && manifest.background_color);

  for (const icon of manifest.icons) {
    assert.ok(exists(icon.src), `manifest references missing icon: ${icon.src}`);
  }

  // Android needs a maskable icon to avoid letterboxing the homescreen icon.
  // `purpose` is a space-separated list, so match on membership rather than
  // equality -- the 512 icon is declared "any maskable".
  assert.ok(
    manifest.icons.some((i) => (i.purpose || 'any').split(/\s+/).includes('maskable')),
    'manifest needs a maskable icon'
  );
  // Chrome requires both 192 and 512 to treat the app as installable.
  for (const size of ['192x192', '512x512']) {
    assert.ok(
      manifest.icons.some((i) => i.sizes === size),
      `manifest needs a ${size} icon`
    );
  }
});

test('the manifest starts at the app, not the landing page', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));

  // Installing from the homescreen must land on the app itself; starting at
  // the marketing page would make the installed icon useless.
  assert.ok(exists(manifest.start_url), `start_url does not exist: ${manifest.start_url}`);
  assert.match(manifest.start_url, /app\.html$/, 'start_url should be the app page');
});

test('every file the service worker precaches exists', () => {
  const sw = read('sw.js');
  const shell = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  const entries = [...shell.matchAll(/'(\.\/[^']*)'/g)].map((m) => m[1]);

  assert.ok(entries.length > 5, 'expected a populated shell list');
  for (const entry of entries) {
    if (entry === './') continue; // the directory root, served as index.html
    assert.ok(exists(entry), `sw.js precaches missing file: ${entry}`);
  }

  // Both pages must survive a cold offline launch.
  for (const page of PAGES) {
    assert.ok(entries.includes(`./${page}`), `sw.js should precache ${page}`);
  }
});

test('iOS homescreen meta tags are present on the app page', () => {
  const html = read('app.html');
  // Safari ignores the manifest for homescreen install, so these are required
  // for the app to launch standalone with the right icon.
  for (const needle of [
    'apple-mobile-web-app-capable',
    'apple-mobile-web-app-status-bar-style',
    'apple-mobile-web-app-title',
    'rel="apple-touch-icon"',
    'viewport-fit=cover'
  ]) {
    assert.ok(html.includes(needle), `app.html is missing ${needle}`);
  }
});

test('both pages declare a responsive viewport', () => {
  for (const page of PAGES) {
    const html = read(page);
    assert.match(html, /name="viewport"[^>]*width=device-width/, `${page} needs a viewport meta`);
    // A hard maximum-scale=1 or user-scalable=no would block pinch zoom.
    assert.ok(
      !/user-scalable=no/.test(html) && !/maximum-scale=1[^\d]/.test(html),
      `${page} must not block pinch zoom`
    );
  }
});

test('no third-party origins are referenced anywhere in the app', () => {
  // The privacy model depends on this: the app must talk to nothing except the
  // service the user configured.
  const files = fs
    .readdirSync(path.join(PUBLIC, 'js'))
    .map((f) => `js/${f}`)
    .concat(fs.readdirSync(path.join(PUBLIC, 'css')).map((f) => `css/${f}`))
    .concat([...PAGES, 'sw.js', 'manifest.webmanifest']);

  for (const file of files) {
    const contents = read(file);
    const urls = [...contents.matchAll(/https?:\/\/[^\s'"()]+/g)]
      // Source also contains regex literals like /^https:\/\//, whose escapes
      // are not part of a real URL.
      .map((m) => m[0].replace(/\\/g, ''));

    for (const url of urls) {
      let host;
      try {
        host = new URL(url).host;
      } catch {
        continue; // not a real URL (regex fragment, placeholder in a comment)
      }
      if (!host) continue;
      const allowed =
        // the default xBrowserSync service, and doc links in comments
        host === 'api.xbrowsersync.org' ||
        host === 'github.com' ||
        host === 'www.xbrowsersync.org' ||
        host === 'www.w3.org'; // SVG namespace, never fetched
      assert.ok(allowed, `${file} references unexpected origin: ${url}`);
    }
  }
});

test('every element id the app looks up exists in the app page', () => {
  // Without a build step nothing catches a renamed id: getElementById just
  // returns null and the feature silently stops working.
  const html = read('app.html');
  const js = read('js/app.js');

  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const usedIds = [...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);

  assert.ok(usedIds.length > 10, 'expected the app to look up several ids');
  for (const id of new Set(usedIds)) {
    assert.ok(htmlIds.has(id), `app.js looks up #${id}, which app.html does not define`);
  }
});

test('the hidden attribute overrides author display rules', () => {
  // The app toggles several .btn elements via the hidden attribute, and
  // `.btn { display: block }` would otherwise win over the UA stylesheet's
  // `[hidden] { display: none }`, leaving them visible.
  const css = read('css/theme.css');
  assert.match(
    css,
    /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    'theme.css needs a global [hidden] { display: none !important } rule'
  );
});

test('both pages load the shared theme before their own styles', () => {
  // theme.css defines the tokens every other rule references; loading it second
  // would still work, but the ordering documents the dependency.
  for (const page of PAGES) {
    const html = read(page);
    const theme = html.indexOf('css/theme.css');
    assert.ok(theme > -1, `${page} must load css/theme.css`);

    const own = Math.max(html.indexOf('css/styles.css'), html.indexOf('css/landing.css'));
    assert.ok(own > theme, `${page} must load theme.css before its page stylesheet`);
  }
});

test('both pages load the theme controller synchronously in <head>', () => {
  for (const page of PAGES) {
    const html = read(page);
    const tag = html.match(/<script[^>]*js\/theme\.js[^>]*><\/script>/);
    assert.ok(tag, `${page} must load js/theme.js`);
    // Must be a blocking classic script (no defer/async/module) so the saved
    // theme is applied before the body paints — otherwise the wrong theme flashes.
    assert.ok(
      !/\b(defer|async)\b|type=["']module["']/.test(tag[0]),
      `${page}: theme.js must be a blocking classic script, got: ${tag[0]}`
    );
    assert.ok(html.indexOf('js/theme.js') < html.indexOf('</head>'), `${page}: theme.js must be in <head>`);
  }
});

test('the service worker precaches the theme controller', () => {
  const sw = read('sw.js');
  const shell = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  assert.ok(shell.includes("'./js/theme.js'"), 'sw.js should precache js/theme.js');
});

test('an explicit theme choice can override the OS preference', () => {
  const css = read('css/theme.css');
  assert.match(css, /:root\[data-theme=['"]dark['"]\]/, 'need a forced-dark selector');
  assert.match(css, /:root\[data-theme=['"]light['"]\]/, 'need a forced-light selector');
  // System-dark must be gated so a forced light choice still wins.
  assert.match(
    css,
    /prefers-color-scheme: dark[\s\S]*?:root:not\(\[data-theme=['"]light['"]\]\)/,
    'system-dark palette must be gated by :not([data-theme=light])'
  );
});

test('every page with a theme control also loads theme.js', () => {
  for (const page of PAGES) {
    const html = read(page);
    if (/data-theme-cycle|data-theme-value/.test(html)) {
      assert.ok(html.includes('js/theme.js'), `${page} has a theme control but does not load theme.js`);
    }
  }
});

test('netlify.toml has the expected security headers and SPA fallback', () => {
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');

  assert.match(toml, /publish = "public"/);
  assert.match(toml, /status = 200/, 'SPA fallback redirect missing');
  assert.match(toml, /Content-Security-Policy/);
  assert.match(toml, /X-Frame-Options/);
  assert.match(toml, /X-Content-Type-Options/);
  assert.match(toml, /Referrer-Policy/);

  // connect-src must permit HTTPS so user-configured self-hosted instances work.
  assert.match(toml, /connect-src [^;]*https:/);

  // The CSP must be a single-line value. Netlify emits one header per line of a
  // multi-line value, and multiple CSP headers are enforced as an intersection,
  // which would block the app's own API calls.
  const cspLine = toml.split('\n').find((line) => line.includes('Content-Security-Policy'));
  assert.ok(cspLine, 'CSP header not found');
  assert.ok(
    !cspLine.includes('"""') && !cspLine.includes("'''"),
    'CSP must not use a multi-line TOML string'
  );
  assert.match(cspLine, /^\s*Content-Security-Policy = ".*"\s*$/, 'CSP must be one quoted line');
  // Sanity-check that the whole policy really is on that line.
  for (const directive of ['default-src', 'connect-src', 'frame-ancestors', 'object-src']) {
    assert.ok(cspLine.includes(directive), `CSP line missing ${directive}`);
  }
});

test('neither page uses inline script or style, as the CSP requires', () => {
  for (const page of PAGES) {
    const html = read(page);
    // A script tag with a body (rather than src=) would be blocked by the CSP.
    const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html);
    assert.ok(!inlineScript, `inline <script> in ${page} would be blocked by the CSP`);

    const inlineStyle = /<style[^>]*>/.test(html);
    assert.ok(!inlineStyle, `inline <style> in ${page} would be blocked by the CSP`);

    assert.ok(!/ style="/.test(html), `inline style attribute in ${page} would be blocked`);
  }
});

test('icon-only controls carry accessible names', () => {
  // Icon buttons have no text, so without aria-label they are announced as
  // "button" and nothing else.
  const html = read('app.html');
  const iconButtons = [...html.matchAll(/<button[^>]*class="icon-btn"[^>]*>/g)].map((m) => m[0]);

  assert.ok(iconButtons.length >= 2, 'expected the icon buttons in the top bar');
  for (const button of iconButtons) {
    assert.match(button, /aria-label="/, `icon button needs an aria-label: ${button}`);
  }
});
