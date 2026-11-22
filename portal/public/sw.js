/* Rit Painel Service Worker
 *
 * Estratégia conservadora e segura para painel administrativo/gestão:
 *  - NUNCA intercepta nem armazena rotas de API (/api/*), autenticação ou métodos não-GET.
 *  - Navegações (HTML): sempre Network-First para refletir sessão e estado atuais; fallback offline seguro.
 *  - Assets com hash de build (/assets/*.js, /assets/*.css) e thumbs (/exercise-media/still/*): Cache-First.
 *  - Ícones/imagens estáticas: Stale-While-Revalidate.
 *  - Build hash carimbado pelo Vite (`__PORTAL_BUILD__`) limpa caches obsoletos automaticamente na ativação.
 */

const CACHE = 'rit-portal-shell-__PORTAL_BUILD__';
const MEDIA_CACHE = 'rit-portal-media-v1';
const OFFLINE_URL = '/offline.html';

const PRECACHE_URLS = [
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon.png',
  '/rit-logo.png'
];

const isValidCacheableResponse = res => {
  if (!res || !res.ok || res.redirected || res.type === 'opaque') return false;
  return true;
};

const isHtmlResponse = res => {
  const ct = (res?.headers && res.headers.get('content-type')) || '';
  return /text\/html/i.test(ct);
};

async function precacheShell() {
  const cache = await caches.open(CACHE);
  await Promise.all(
    PRECACHE_URLS.map(u => cache.add(u).catch(() => { /* best effort for optional static icons */ }))
  );

  try {
    const htmlRes = await fetch('/index.html', { cache: 'no-cache' });
    if (isValidCacheableResponse(htmlRes) && isHtmlResponse(htmlRes)) {
      const htmlText = await htmlRes.clone().text();
      await cache.put('/index.html', new Response(htmlText, {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }));

      const assetRefs = [...new Set(
        [...htmlText.matchAll(/(?:src|href)="([^"]+)"/g)]
          .map(m => m[1])
          .filter(u => /^\/assets\/[^"]+\.(?:js|css)$/i.test(u))
      )];

      await Promise.all(
        assetRefs.map(async u => {
          try {
            const r = await fetch(u, { cache: 'no-cache' });
            if (isValidCacheableResponse(r) && !isHtmlResponse(r)) {
              await cache.put(u, r);
            }
          } catch { /* fetched lazily if needed */ }
        })
      );
    }
  } catch { /* fallback remains /offline.html */ }
}

self.addEventListener('install', event => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k.startsWith('rit-portal-') && k !== CACHE && k !== MEDIA_CACHE)
        .map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (!req || req.method !== 'GET') return;

  // Nunca intercepta headers de autenticação Bearer/Range (streams de vídeo/upload)
  if (req.headers.has('authorization') || req.headers.has('range')) return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Regra crítica: nunca interceptar nem cachear endpoints dinâmicos, auth ou cookies de API
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/sw.js') return;

  // Navegação de telas (/painel, /painel/students, /login): sempre Network-First
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const netRes = await fetch(req);
        if (isValidCacheableResponse(netRes) && isHtmlResponse(netRes)) {
          const cache = await caches.open(CACHE);
          cache.put('/index.html', netRes.clone()).catch(() => { });
        }
        return netRes;
      } catch {
        const cache = await caches.open(CACHE);
        const offlineFallback = await cache.match(OFFLINE_URL);
        if (offlineFallback) return offlineFallback;
        const cachedShell = await cache.match('/index.html');
        if (cachedShell) return cachedShell;
        return new Response('Sem conexão com a internet.', {
          status: 503,
          headers: { 'content-type': 'text/plain; charset=utf-8' }
        });
      }
    })());
    return;
  }

  // Bundles com hash imutável do Vite (/assets/*.js|css) e miniaturas de exercícios (/exercise-media/still/*)
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const netRes = await fetch(req);
      if (isValidCacheableResponse(netRes) && !isHtmlResponse(netRes)) {
        cache.put(req, netRes.clone()).catch(() => { });
      }
      return netRes;
    })());
    return;
  }

  if (url.pathname.startsWith('/exercise-media/still/')) {
    event.respondWith((async () => {
      const cache = await caches.open(MEDIA_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const netRes = await fetch(req);
      if (isValidCacheableResponse(netRes) && !isHtmlResponse(netRes)) {
        cache.put(req, netRes.clone()).catch(() => { });
      }
      return netRes;
    })());
    return;
  }

  // Ícones, logos e manifest: Stale-While-Revalidate
  if (/\.(?:png|webp|jpg|jpeg|svg|ico|woff2?|webmanifest)$/i.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then(res => {
          if (isValidCacheableResponse(res) && !isHtmlResponse(res)) {
            cache.put(req, res.clone()).catch(() => { });
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })());
  }
});
