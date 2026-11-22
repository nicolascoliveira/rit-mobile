/**
 * api/test/portal-pwa.test.js
 *
 * Verifica os requisitos de instalabilidade PWA, integridade de ícones,
 * regras anti-cache de API no Service Worker e saída de build do Portal B2B.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORTAL_DIR = path.join(ROOT_DIR, 'portal');
const PUBLIC_DIR = path.join(PORTAL_DIR, 'public');
const DIST_DIR = path.join(PORTAL_DIR, 'dist');

function readPngSize(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${filePath} deve ser um PNG válido`);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20)
  };
}

test('Portal PWA manifest e ícones atendem aos critérios obrigatórios de Desktop, Android e iOS', () => {
  const manifestPath = path.join(PUBLIC_DIR, 'manifest.webmanifest');
  assert.ok(fs.existsSync(manifestPath), 'portal/public/manifest.webmanifest deve existir');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.start_url, '/painel');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color, '#000000');
  assert.equal(manifest.theme_color, '#000000');
  assert.ok(manifest.name && manifest.short_name && manifest.description);

  const expectedIcons = [
    { src: '/icon-192.png', width: 192, height: 192, purpose: 'any' },
    { src: '/icon-512.png', width: 512, height: 512, purpose: 'any' },
    { src: '/icon-512-maskable.png', width: 512, height: 512, purpose: 'maskable' },
    { src: '/apple-touch-icon.png', width: 180, height: 180, purpose: 'any' }
  ];

  for (const exp of expectedIcons) {
    const entry = manifest.icons.find(i => i.src === exp.src && i.purpose === exp.purpose);
    assert.ok(entry, `Manifest deve listar ícone ${exp.src} (${exp.purpose})`);
    assert.equal(entry.sizes, `${exp.width}x${exp.height}`);

    const fileOnDisk = path.join(PUBLIC_DIR, exp.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(fileOnDisk), `Arquivo ${fileOnDisk} deve existir`);
    const dims = readPngSize(fileOnDisk);
    assert.equal(dims.width, exp.width);
    assert.equal(dims.height, exp.height);
  }
});

test('Portal index.html declara manifest, apple-touch-icon 180x180 e meta tags iOS', () => {
  const html = fs.readFileSync(path.join(PORTAL_DIR, 'index.html'), 'utf8');
  assert.match(html, /<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"/i);
  assert.match(html, /<link\s+rel="apple-touch-icon"\s+sizes="180x180"\s+href="\/apple-touch-icon\.png"/i);
  assert.match(html, /<meta\s+name="apple-mobile-web-app-capable"\s+content="yes"/i);
  assert.match(html, /<meta\s+name="apple-mobile-web-app-status-bar-style"\s+content="black-translucent"/i);
  assert.match(html, /<meta\s+name="apple-mobile-web-app-title"\s+content="Rit Painel"/i);
});

test('Portal Service Worker nunca cacheia /api/, auth ou métodos não-GET e possui fallback offline', () => {
  const swPath = path.join(PUBLIC_DIR, 'sw.js');
  const offlinePath = path.join(PUBLIC_DIR, 'offline.html');
  assert.ok(fs.existsSync(swPath), 'portal/public/sw.js deve existir');
  assert.ok(fs.existsSync(offlinePath), 'portal/public/offline.html deve existir');

  const sw = fs.readFileSync(swPath, 'utf8');
  assert.ok(sw.includes("req.method !== 'GET'"));
  assert.ok(sw.includes("url.pathname.startsWith('/api/')"));
  assert.ok(sw.includes("req.headers.has('authorization')"));
  assert.ok(sw.includes("req.mode === 'navigate'"));
  assert.ok(sw.includes("'/offline.html'") || sw.includes('OFFLINE_URL'));

  const nginxConf = fs.readFileSync(path.join(PORTAL_DIR, 'nginx.conf.template'), 'utf8');
  assert.ok(nginxConf.includes('location = /sw.js'));
  assert.ok(nginxConf.includes('location = /manifest.webmanifest'));
  assert.ok(nginxConf.includes("worker-src 'self'"));
  assert.ok(nginxConf.includes("manifest-src 'self'"));
});

test('Build de produção do Portal gera dist/ com Service Worker carimbado e assets PWA', () => {
  assert.ok(fs.existsSync(path.join(DIST_DIR, 'index.html')), 'portal/dist/index.html deve existir após build');
  const distSwPath = path.join(DIST_DIR, 'sw.js');
  assert.ok(fs.existsSync(distSwPath), 'portal/dist/sw.js deve existir após build');
  const distSw = fs.readFileSync(distSwPath, 'utf8');
  assert.ok(!distSw.includes('__PORTAL_BUILD__'), 'Build do Vite deve substituir __PORTAL_BUILD__ pelo hash real');
  assert.match(distSw, /rit-portal-shell-[a-f0-9]{12}/);

  for (const rel of ['manifest.webmanifest', 'offline.html', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png']) {
    assert.ok(fs.existsSync(path.join(DIST_DIR, rel)), `portal/dist/${rel} deve estar presente no build`);
  }
});
