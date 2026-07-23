/**
 * Integrity checks on the static site itself.
 *
 * These catch the class of mistake that unit tests cannot: a renamed file, a
 * typo in a path, an icon referenced but never generated. On a no-build-step
 * site there is no bundler to notice a broken reference.
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

test('every local path referenced by index.html exists', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((m) => m[1]);

  assert.ok(refs.length > 5, 'expected several local references');
  for (const ref of refs) {
    assert.ok(exists(ref), `index.html references missing file: ${ref}`);
  }
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
  assert.ok(
    manifest.icons.some((i) => i.purpose === 'maskable'),
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

test('every file the service worker precaches exists', () => {
  const sw = read('sw.js');
  const shell = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  const entries = [...shell.matchAll(/'(\.\/[^']*)'/g)].map((m) => m[1]);

  assert.ok(entries.length > 5, 'expected a populated shell list');
  for (const entry of entries) {
    if (entry === './') continue; // the directory root, served as index.html
    assert.ok(exists(entry), `sw.js precaches missing file: ${entry}`);
  }
});

test('iOS homescreen meta tags are present', () => {
  const html = read('index.html');
  // Safari ignores the manifest for homescreen install, so these are required
  // for the app to launch standalone with the right icon.
  for (const needle of [
    'apple-mobile-web-app-capable',
    'apple-mobile-web-app-status-bar-style',
    'apple-mobile-web-app-title',
    'rel="apple-touch-icon"',
    'viewport-fit=cover'
  ]) {
    assert.ok(html.includes(needle), `index.html is missing ${needle}`);
  }
});

test('no third-party origins are referenced anywhere in the app', () => {
  // The privacy model depends on this: the app must talk to nothing except the
  // service the user configured.
  const files = fs
    .readdirSync(path.join(PUBLIC, 'js'))
    .map((f) => `js/${f}`)
    .concat(['index.html', 'sw.js', 'css/styles.css', 'manifest.webmanifest']);

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

test('every element id the app looks up exists in the HTML', () => {
  // Without a build step nothing catches a renamed id: getElementById just
  // returns null and the feature silently stops working.
  const html = read('index.html');
  const js = read('js/app.js');

  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const usedIds = [...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);

  assert.ok(usedIds.length > 10, 'expected the app to look up several ids');
  for (const id of new Set(usedIds)) {
    assert.ok(htmlIds.has(id), `app.js looks up #${id}, which index.html does not define`);
  }
});

test('the hidden attribute overrides author display rules', () => {
  // The app toggles several .btn elements via the hidden attribute, and
  // `.btn { display: block }` would otherwise win over the UA stylesheet's
  // `[hidden] { display: none }`, leaving them visible.
  const css = read('css/styles.css');
  assert.match(
    css,
    /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    'styles.css needs a global [hidden] { display: none !important } rule'
  );
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
  // Nothing in the app is inline, so these escape hatches should never appear.
  assert.ok(!toml.includes("'unsafe-inline'"), "CSP should not need 'unsafe-inline'");
  assert.ok(!toml.includes("'unsafe-eval'"), "CSP should not need 'unsafe-eval'");
});

test('the app contains no inline script or style, as the CSP requires', () => {
  const html = read('index.html');
  // A script tag with a body (rather than src=) would be blocked by the CSP.
  const inlineScript = /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html);
  assert.ok(!inlineScript, 'inline <script> would be blocked by the CSP');

  const inlineStyle = /<style[^>]*>/.test(html);
  assert.ok(!inlineStyle, 'inline <style> would be blocked by the CSP');
});
