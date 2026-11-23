import { getStoredToken, getTenantOverride, portalApi } from './api.js';
import { isNativePortalApp, resolvePortalApiUrl } from './native.js';

const MB = 1024 * 1024;
const IMAGE_MAX_EDGE = 1600;
const POSTER_EDGE = 480;

export const DEFAULT_MEDIA_CAPS = {
  imageMB: 2,
  gifMB: 8,
  videoMB: 40,
  videoSec: 60
};

/* --- SHA-256 (WebCrypto + fallback puro JS para HTTP em rede local) --- */
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function sha256Pure(bytes) {
  const len = bytes.length;
  const bitLen = len * 8;
  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  const pad = new Uint8Array(paddedLen);
  pad.set(bytes);
  pad[len] = 0x80;
  const dv = new DataView(pad.buffer);
  dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(v => v.toString(16).padStart(8, '0')).join('');
}

async function sha256Blob(blob) {
  const buf = await blob.arrayBuffer();
  if (typeof crypto !== 'undefined' && crypto.subtle?.digest) {
    try {
      const dig = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(dig), b => b.toString(16).padStart(2, '0')).join('');
    } catch { /* falls back to pure JS on non-secure origin */ }
  }
  return sha256Pure(new Uint8Array(buf));
}

/* --- Magic-byte sniffing (compatível com api/media.js) --- */
const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VP',
  'dash', 'mmp4', 'MSNV', '3gp4', '3gp5', '3gp6', '3g2a'
]);
const HEIF_BRANDS = new Set(['heic', 'heix', 'mif1', 'msf1', 'avif', 'avis']);

async function sniffFile(file) {
  const b = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const at = (off, ...vals) => vals.every((v, i) => b[off + i] === v);
  const ascii = (off, len) => (b.length >= off + len ? String.fromCharCode(...b.slice(off, off + len)) : '');

  if (at(0, 0xff, 0xd8, 0xff)) return { kind: 'image', mime: 'image/jpeg' };
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: 'image', mime: 'image/png' };
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return { kind: 'gif', mime: 'image/gif' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime' };
    if (MP4_BRANDS.has(brand)) return { kind: 'video', mime: 'video/mp4' };
    if (HEIF_BRANDS.has(brand)) return { kind: 'image', mime: 'image/heif' };
    return null;
  }
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return { kind: 'video', mime: 'video/webm' };
  return null;
}

const fitBox = (w, h, maxEdge) => {
  if (!w || !h) return { width: 480, height: 480 };
  const s = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
};

function canvasEncode(source, w, h, maxEdge, preferWebp = true) {
  return new Promise((resolve, reject) => {
    const box = fitBox(w, h, maxEdge);
    const cv = document.createElement('canvas');
    cv.width = box.width;
    cv.height = box.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(source, 0, 0, box.width, box.height);
    const tryMime = (mime, quality, fallback) => {
      cv.toBlob(blob => {
        if (blob && blob.type === mime) {
          resolve({ blob, mime, width: box.width, height: box.height });
        } else if (fallback) {
          tryMime('image/jpeg', 0.85, false);
        } else if (blob) {
          resolve({ blob, mime: blob.type || 'image/jpeg', width: box.width, height: box.height });
        } else {
          reject(new Error('Falha ao codificar miniatura da mídia.'));
        }
      }, mime, quality);
    };
    tryMime(preferWebp ? 'image/webp' : 'image/jpeg', 0.86, preferWebp);
  });
}

function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      URL.revokeObjectURL(url);
      if (!w || !h) return reject(new Error('Imagem sem dimensões válidas.'));
      resolve({ img, width: w, height: h });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Não foi possível decodificar esta imagem neste navegador.'));
    };
    img.src = url;
  });
}

function probeVideoFile(file, maxSec) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    let settled = false;
    const cleanup = () => {
      v.onloadedmetadata = null;
      v.onseeked = null;
      v.onerror = null;
      v.removeAttribute('src');
      URL.revokeObjectURL(url);
    };
    const fail = msg => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(msg));
    };

    const timer = setTimeout(() => fail('Tempo esgotado ao ler o vídeo.'), 20000);
    v.onerror = () => { clearTimeout(timer); fail('Não foi possível abrir este arquivo de vídeo (tente MP4 H.264 ou WebM).'); };
    v.onloadedmetadata = () => {
      const dur = Number(v.duration);
      const width = v.videoWidth || 0;
      const height = v.videoHeight || 0;
      if (!Number.isFinite(dur) || dur <= 0 || !width || !height) {
        clearTimeout(timer);
        return fail('Vídeo inválido ou sem faixa de vídeo legível.');
      }
      if (dur > maxSec) {
        clearTimeout(timer);
        return fail(`O vídeo tem ${Math.ceil(dur)}s. O máximo permitido é ${maxSec}s.`);
      }
      const targetTime = Math.min(dur * 0.1, 0.4);
      if (v.currentTime === targetTime) {
        v.onseeked();
      } else {
        try { v.currentTime = targetTime; } catch {
          clearTimeout(timer);
          settled = true;
          cleanup();
          resolve({ duration: Math.round(dur * 10) / 10, width, height, poster: null });
        }
      }
    };
    v.onseeked = async () => {
      if (settled) return;
      clearTimeout(timer);
      const duration = Math.round(Number(v.duration) * 10) / 10;
      const width = v.videoWidth;
      const height = v.videoHeight;
      let poster = null;
      try {
        poster = await canvasEncode(v, width, height, POSTER_EDGE, true);
      } catch { poster = null; }
      settled = true;
      cleanup();
      resolve({ duration, width, height, poster });
    };
    v.src = url;
  });
}

function uploadBlobWithProgress(hash, blob, mime, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', resolvePortalApiUrl(`/api/gym/media/${hash}`), true);
    const token = getStoredToken();
    const tenantOverride = getTenantOverride();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    if (tenantOverride) xhr.setRequestHeader('X-Tenant-Id', tenantOverride);
    xhr.setRequestHeader('Content-Type', mime);

    xhr.upload.onprogress = evt => {
      if (evt.lengthComputable && typeof onProgress === 'function') {
        onProgress(Math.min(99, Math.round((evt.loaded / evt.total) * 100)));
      }
    };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { data = {}; }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve(data);
      } else {
        reject(new Error(data?.error || `Falha no envio do arquivo (HTTP ${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error('Erro de rede ao enviar a mídia para o servidor.'));
    xhr.send(blob);
  });
}

/**
 * Valida, processa (miniatura/poster, hash SHA-256), deduplica e envia o arquivo
 * para `/api/gym/media/{hash}`. Retorna um MediaRef pronto para salvar no exercício.
 */
export async function prepareAndUploadExerciseMedia(file, caps = DEFAULT_MEDIA_CAPS, onProgress) {
  if (!file) throw new Error('Selecione um arquivo de vídeo, GIF ou imagem.');
  const limits = { ...DEFAULT_MEDIA_CAPS, ...(caps || {}) };
  const sniff = await sniffFile(file);
  if (!sniff) {
    throw new Error('Formato não suportado. Use vídeo MP4/MOV/WebM, GIF ou imagem JPG/PNG/WebP.');
  }

  let mainBlob = file;
  let mainMime = sniff.mime;
  let width = 0;
  let height = 0;
  let dur;
  let posterEncoded = null;

  if (sniff.kind === 'video') {
    if (file.size > limits.videoMB * MB) {
      throw new Error(`O vídeo excede o limite de ${limits.videoMB} MB.`);
    }
    onProgress?.({ stage: 'Analisando vídeo...', pct: 5 });
    const meta = await probeVideoFile(file, limits.videoSec);
    width = meta.width;
    height = meta.height;
    dur = meta.duration;
    posterEncoded = meta.poster;
  } else if (sniff.kind === 'gif') {
    if (file.size > limits.gifMB * MB) {
      throw new Error(`O GIF excede o limite de ${limits.gifMB} MB.`);
    }
    onProgress?.({ stage: 'Gerando capa do GIF...', pct: 10 });
    const decoded = await loadImageElement(file);
    width = decoded.width;
    height = decoded.height;
    posterEncoded = await canvasEncode(decoded.img, width, height, POSTER_EDGE, true);
  } else {
    onProgress?.({ stage: 'Otimizando imagem...', pct: 10 });
    const decoded = await loadImageElement(file);
    const reencoded = await canvasEncode(decoded.img, decoded.width, decoded.height, IMAGE_MAX_EDGE, true);
    if (reencoded.blob.size > limits.imageMB * MB) {
      throw new Error(`Mesmo após compressão, a imagem excede ${limits.imageMB} MB.`);
    }
    mainBlob = reencoded.blob;
    mainMime = reencoded.mime;
    width = reencoded.width;
    height = reencoded.height;
    if (Math.max(width, height) > POSTER_EDGE) {
      posterEncoded = await canvasEncode(decoded.img, width, height, POSTER_EDGE, true);
    }
  }

  onProgress?.({ stage: 'Calculando assinatura SHA-256...', pct: 20 });
  const mainHash = await sha256Blob(mainBlob);
  let posterRef = null;
  const uploadQueue = [{ hash: mainHash, blob: mainBlob, mime: mainMime }];

  if (posterEncoded?.blob) {
    const pHash = await sha256Blob(posterEncoded.blob);
    posterRef = {
      hash: pHash,
      mime: posterEncoded.mime,
      size: posterEncoded.blob.size,
      width: posterEncoded.width,
      height: posterEncoded.height
    };
    if (pHash !== mainHash) {
      uploadQueue.push({ hash: pHash, blob: posterEncoded.blob, mime: posterEncoded.mime });
    }
  }

  const check = await portalApi('/api/gym/media/missing', {
    method: 'POST',
    body: { hashes: uploadQueue.map(u => u.hash) }
  });
  const missingSet = new Set(check?.missing || []);
  const pending = uploadQueue.filter(u => missingSet.has(u.hash));

  if (pending.length > 0) {
    let completed = 0;
    for (const item of pending) {
      const idx = completed;
      await uploadBlobWithProgress(item.hash, item.blob, item.mime, pct => {
        const overall = Math.round(((idx + pct / 100) / pending.length) * 75) + 25;
        onProgress?.({ stage: 'Enviando para o servidor...', pct: Math.min(100, overall) });
      });
      completed += 1;
    }
  } else {
    onProgress?.({ stage: 'Mídia já sincronizada!', pct: 100 });
  }

  return {
    kind: sniff.kind,
    hash: mainHash,
    mime: mainMime,
    size: mainBlob.size,
    width,
    height,
    ...(dur != null ? { dur } : {}),
    ...(posterRef ? { poster: posterRef } : {}),
    at: Date.now()
  };
}

/* --- Cache LRU de Object URLs autenticados para preview no Portal --- */
const MAX_MEDIA_URL_CACHE = 30;
const mediaUrlCache = new Map();

function rememberMediaUrl(cacheKey, promise) {
  if (mediaUrlCache.has(cacheKey)) {
    mediaUrlCache.delete(cacheKey);
  }
  while (mediaUrlCache.size >= MAX_MEDIA_URL_CACHE) {
    const oldestKey = mediaUrlCache.keys().next().value;
    const oldestPromise = mediaUrlCache.get(oldestKey);
    mediaUrlCache.delete(oldestKey);
    Promise.resolve(oldestPromise).then(url => {
      if (url && typeof URL?.revokeObjectURL === 'function') {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      }
    });
  }
  mediaUrlCache.set(cacheKey, promise);
  return promise;
}

export function fetchGymMediaUrl(hash) {
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return Promise.resolve('');
  const tenantKey = getTenantOverride() || 'self';
  const cacheKey = `${tenantKey}:${hash}`;
  const existing = mediaUrlCache.get(cacheKey);
  if (existing) return existing;

  const p = (async () => {
    const token = getStoredToken();
    const tenantOverride = getTenantOverride();
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (tenantOverride) headers['X-Tenant-Id'] = tenantOverride;

    const res = await fetch(resolvePortalApiUrl(`/api/gym/media/${hash}`), { headers, credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  })().catch(() => {
    mediaUrlCache.delete(cacheKey);
    return '';
  });

  return rememberMediaUrl(cacheKey, p);
}

export function fetchStudentVideoUrl(studentId, hash) {
  if (!studentId || !hash || !/^[0-9a-f]{64}$/.test(hash)) return Promise.resolve('');
  const tenantKey = getTenantOverride() || 'self';
  const cacheKey = `sv:${tenantKey}:${studentId}:${hash}`;
  const existing = mediaUrlCache.get(cacheKey);
  if (existing) return existing;

  const p = (async () => {
    const token = getStoredToken();
    const tenantOverride = getTenantOverride();
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (tenantOverride) headers['X-Tenant-Id'] = tenantOverride;

    const url = resolvePortalApiUrl(`/api/gym/student/video?studentId=${encodeURIComponent(studentId)}&hash=${encodeURIComponent(hash)}`);
    const res = await fetch(url, { headers, credentials: isNativePortalApp() ? 'omit' : 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  })().catch(() => {
    mediaUrlCache.delete(cacheKey);
    return '';
  });

  return rememberMediaUrl(cacheKey, p);
}

export function extractYouTubeId(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) return '';
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const parts = u.pathname.split('/').filter(Boolean);
    if (host === 'youtu.be' && parts.length === 1) {
      return /^[a-zA-Z0-9_-]{11}$/.test(parts[0]) ? parts[0] : '';
    }
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') {
        const id = u.searchParams.get('v') || '';
        return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : '';
      }
      if (['embed', 'shorts', 'live'].includes(parts[0]) && parts.length === 2) {
        return /^[a-zA-Z0-9_-]{11}$/.test(parts[1]) ? parts[1] : '';
      }
    }
  } catch { /* ignore */ }
  return '';
}

