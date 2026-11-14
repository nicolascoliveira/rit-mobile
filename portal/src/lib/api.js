const TOKEN_KEY = 'rit_admin_token';
const LEGACY_TOKEN_KEY = 'opengym_b2b_token';
const TENANT_KEY = 'rit_admin_tenant_override';
const LEGACY_TENANT_KEY = 'opengym_b2b_tenant_override';
const THEME_KEY = 'rit_admin_theme';
const LEGACY_THEME_KEY = 'opengym_b2b_theme';

export function getStoredToken() {
  try { return localStorage.getItem(TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY) || ''; } catch { return ''; }
}

export function setStoredToken(token) {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(LEGACY_TOKEN_KEY);
    }
  } catch { /* ignore */ }
}

export function getTenantOverride() {
  try { return localStorage.getItem(TENANT_KEY) || localStorage.getItem(LEGACY_TENANT_KEY) || ''; } catch { return ''; }
}

export function setTenantOverride(slug) {
  try {
    if (slug) {
      localStorage.setItem(TENANT_KEY, slug);
    } else {
      localStorage.removeItem(TENANT_KEY);
      localStorage.removeItem(LEGACY_TENANT_KEY);
    }
  } catch { /* ignore */ }
}

export function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY) || localStorage.getItem(LEGACY_THEME_KEY) || 'dark'; } catch { return 'dark'; }
}

export function setStoredTheme(theme) {
  const clean = theme === 'light' ? 'light' : 'dark';
  try {
    localStorage.setItem(THEME_KEY, clean);
  } catch { /* ignore */ }
  document.documentElement.dataset.theme = clean;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = clean === 'light' ? '#f2f2f7' : '#000000';
  return clean;
}

/* --- Mesma matemática WCAG de contraste do frontend/src/lib/accent.js --- */
const HEX_RE = /^#[0-9a-f]{6}$/i;
export const cleanHex = v => (typeof v === 'string' && HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : null);

const rgb = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const toHex = c => '#' + c.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const luminance = hex => { const [r, g, b] = rgb(hex); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const contrast = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (hex, to, t) => { const a = rgb(hex), b = rgb(to); return toHex(a.map((v, i) => v + (b[i] - v) * t)); };
export const inkOn = hex => {
  const c = cleanHex(hex);
  if (!c) return '#000000';
  return contrast(c, '#000000') >= contrast(c, '#ffffff') ? '#000000' : '#ffffff';
};

export function applyPortalAccent(hexColor, theme = getStoredTheme()) {
  const el = document.documentElement;
  const c = cleanHex(hexColor);
  if (!c) {
    el.dataset.accent = 'lime';
    for (const k of ['--acc', '--acc-2', '--on-acc', '--acc-ink']) el.style.removeProperty(k);
    return;
  }
  const acc2 = mix(c, '#000000', 0.22);
  const ink = inkOn(c);
  const accInk = theme === 'light' && contrast(c, '#ffffff') < 3.5 ? mix(c, '#000000', 0.35) : (theme === 'dark' && contrast(c, '#1c1c1e') < 3.2 ? mix(c, '#ffffff', 0.3) : c);
  el.dataset.accent = 'custom';
  el.style.setProperty('--acc', c);
  el.style.setProperty('--acc-2', acc2);
  el.style.setProperty('--on-acc', ink);
  el.style.setProperty('--acc-ink', accInk);
}

/* --- Toast Global (#toast idêntico ao Rit) --- */
let toastListeners = new Set();
export function subscribeToast(fn) {
  toastListeners.add(fn);
  return () => toastListeners.delete(fn);
}
export function toast(message) {
  for (const fn of toastListeners) fn(String(message || ''));
}

/* --- Cliente HTTP --- */
export async function portalApi(path, opts = {}) {
  const token = getStoredToken();
  const tenantOverride = opts.tenantId !== undefined ? opts.tenantId : getTenantOverride();

  const headers = {
    'Content-Type': 'application/json',
    ...(opts.headers || {})
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenantOverride) headers['X-Tenant-Id'] = tenantOverride;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = String(opts.idempotencyKey);

  const res = await fetch(path, {
    ...opts,
    credentials: 'omit',
    headers,
    body: opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)
      ? JSON.stringify(opts.body)
      : opts.body
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok) {
    if (res.status === 401) {
      setStoredToken('');
      if (typeof window !== 'undefined' && !window.location.pathname.includes('/login')) {
        window.dispatchEvent(new CustomEvent('rit:unauthorized'));
      }
    }
    const err = new Error(data?.error || `Erro HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

export function fmtBRL(val) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(val || 0));
}

export function fmtDateBR(isoOrDate) {
  if (!isoOrDate) return '—';
  const s = String(isoOrDate);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-');
    return `${d}/${m}/${y}`;
  }
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return s;
  return dt.toLocaleDateString('pt-BR');
}

export function buildWhatsAppUrl(phone, message) {
  const digits = String(phone || '').replace(/\D/g, '').replace(/^00/, '');
  if (!digits) return null;
  const full = (digits.length === 10 || digits.length === 11) ? '55' + digits : digits;
  return `https://wa.me/${full}?text=${encodeURIComponent(message)}`;
}

export function getStudentAppUrl(tenantSlug) {
  const configured = typeof import.meta !== 'undefined' && (import.meta.env?.VITE_STUDENT_APP_URL || import.meta.env?.VITE_APP_URL)
    ? String(import.meta.env.VITE_STUDENT_APP_URL || import.meta.env.VITE_APP_URL).trim().replace(/\/+$/, '')
    : '';

  let base = configured;
  if (!base && typeof window !== 'undefined') {
    const host = window.location.hostname || 'localhost';
    const proto = window.location.protocol || 'http:';
    const port = window.location.port || '';

    // 1. GitHub Codespaces / GitHub.dev port-forwarded URLs (ex: <id>-8081.app.github.dev -> <id>-8080.app.github.dev)
    const codespaceMatch = /^(.+)-\d+\.(app\.github\.dev|githubpreview\.dev|preview\.app\.github\.dev)$/i.exec(host);
    if (codespaceMatch) {
      base = `${proto}//${codespaceMatch[1]}-8080.${codespaceMatch[2]}`;
    } else if (host === 'localhost' || host === '127.0.0.1' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || port === '8081') {
      // 2. Ambiente local, IP de rede local ou porta direta de dev (:8081 -> :8080)
      base = `${proto}//${host}:8080`;
    } else if (/^(painel|portal|admin|gestao)\./i.test(host)) {
      // 3. Domínio de produção com subdomínio (ex: painel.treinerit.com.br -> app.treinerit.com.br)
      base = `${proto}//${host.replace(/^(painel|portal|admin|gestao)\./i, 'app.')}`;
    } else if (/^www\./i.test(host)) {
      base = `${proto}//${host.replace(/^www\./i, 'app.')}`;
    } else if (!/^(localhost|127\.0\.0\.1)$/.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      // 4. Domínio raiz de produção (ex: treinerit.com.br -> app.treinerit.com.br)
      base = `${proto}//app.${host}`;
    } else {
      base = `${proto}//${host}${port ? ':' + port : ''}`;
    }
  }
  if (!base) base = 'http://localhost:8080';

  return tenantSlug && tenantSlug !== 'default'
    ? `${base}/?tenant=${encodeURIComponent(tenantSlug)}`
    : base;
}

/**
 * Generates an unambiguous 12-character temporary password (>= 8 chars).
 */
export function generateTempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let suffix = '';
  for (let i = 0; i < bytes.length; i += 1) {
    suffix += alphabet[bytes[i] % alphabet.length];
  }
  return `Rit#${suffix}`;
}

/**
 * Gera uma chave UUID v4 para cabeçalho `Idempotency-Key` (sem dados pessoais).
 */
export function newIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Reutiliza a mesma chave UUID v4 em retries da mesma operação e gira se os parâmetros mudarem.
 */
export function getOrRotateIntentKey(ref, signature) {
  const sig = typeof signature === 'string' ? signature : JSON.stringify(signature ?? {});
  if (!ref.current || ref.current.sig !== sig || !ref.current.key) {
    ref.current = { sig, key: newIdempotencyKey() };
  }
  return ref.current.key;
}
