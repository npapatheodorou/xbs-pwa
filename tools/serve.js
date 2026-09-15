#!/usr/bin/env node
/**
 * Minimal static server for local development.
 *
 * http://localhost is treated as a secure context by browsers, so Web Crypto,
 * service workers and PWA install all work without a TLS certificate.
 *
 * Run: npm run serve
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT) || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Match vercel.json: `trailingSlash: false` redirects /app/ to /app.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    res.writeHead(308, { Location: url.pathname.slice(0, -1) + url.search }).end();
    return;
  }

  const pathname = url.pathname === '/app' ? '/app.html' : url.pathname;
  let filePath = path.join(ROOT, decodeURIComponent(pathname));

  // Refuse to serve anything outside the publish directory.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // Unknown paths get a real 404, as Vercel does with public/404.html.
  let status = 200;
  if (!fs.existsSync(filePath)) {
    filePath = path.join(ROOT, '404.html');
    status = 404;
  }

  const ext = path.extname(filePath);
  res.writeHead(status, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Serving public/ at http://localhost:${PORT}`);
  console.log('localhost counts as a secure context, so Web Crypto and the service worker work.');
});
