const NATIVE_MODE_KEY = 'rit_native_mode';
const PORTAL_API_BASE_KEY = 'rit_portal_api_base';
const DEFAULT_PORTAL_API_BASE = 'https://painel.treinerit.duckdns.org';

export function isNativePortalApp() {
  const embeddedFlag = typeof import.meta !== 'undefined' && import.meta.env?.VITE_MOBILE_EMBED === '1';
  if (embeddedFlag) return true;
  if (typeof window === 'undefined') return false;
  if (window.Capacitor?.isNativePlatform?.()) return true;
  const proto = window.location?.protocol || '';
  const host = window.location?.hostname || '';
  const path = window.location?.pathname || '';
  if (proto === 'file:' || proto === 'capacitor:') return true;
  return Boolean((host === 'localhost' || host === '127.0.0.1') && !window.location?.port && path.startsWith('/portal/'));
}

export function getPortalApiBase() {
  if (!isNativePortalApp()) return '';
  let stored = '';
  try {
    stored = window.localStorage?.getItem(PORTAL_API_BASE_KEY) || '';
  } catch {
    stored = '';
  }
  const envBase = typeof import.meta !== 'undefined' ? (import.meta.env?.VITE_PORTAL_API_BASE || '') : '';
  const raw = String(stored || envBase || DEFAULT_PORTAL_API_BASE).trim();
  return raw.replace(/\/+$/, '');
}

export function resolvePortalApiUrl(path) {
  const raw = String(path || '');
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!isNativePortalApp() || !raw.startsWith('/')) return raw;
  const base = getPortalApiBase();
  return base ? `${base}${raw}` : raw;
}

export function rememberPortalNativeMode() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(NATIVE_MODE_KEY, 'portal');
  } catch {
    /* ignore storage errors */
  }
}

export function openStudentNativeApp(tenantSlug = '') {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage?.setItem(NATIVE_MODE_KEY, 'student');
  } catch {
    /* ignore storage errors */
  }
  const prefix = window.location?.pathname?.includes('/portal') ? '../index.html' : './index.html';
  const query = tenantSlug && tenantSlug !== 'default'
    ? `?tenant=${encodeURIComponent(tenantSlug)}`
    : '';
  window.location.assign(`${prefix}${query}#/`);
}

export async function nativePortalHttpRequest(url, { method = 'GET', headers = {}, body, isFormData = false } = {}) {
  const cap = typeof window !== 'undefined' ? window.Capacitor : null;
  if (cap?.isNativePlatform?.() && typeof cap.nativePromise === 'function' && !isFormData) {
    let data = body;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        /* keep string payload as-is */
      }
    }
    const res = await cap.nativePromise('CapacitorHttp', 'request', {
      url,
      method,
      headers,
      ...(data !== undefined ? { data } : {}),
      responseType: 'text',
      connectTimeout: 30000,
      readTimeout: 60000
    });
    const text = typeof res.data === 'string'
      ? res.data
      : (res.data == null ? '' : JSON.stringify(res.data));
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      text: async () => text,
      json: async () => (text ? JSON.parse(text) : {})
    };
  }

  return fetch(url, {
    method,
    headers,
    body,
    credentials: 'omit'
  });
}

export async function sendPortalNativeNotification({
  id = 4200,
  title = 'Rit Painel',
  body = '',
  delayMs = 800,
  interactive = false
} = {}) {
  if (typeof window === 'undefined' || !body) return false;
  const plugin = window.Capacitor?.Plugins?.LocalNotifications;
  if (!window.Capacitor?.isNativePlatform?.() || !plugin?.schedule) return false;
  try {
    let perm = await plugin.checkPermissions();
    if (perm?.display !== 'granted' && interactive) {
      perm = await plugin.requestPermissions();
    }
    if (perm?.display !== 'granted') return false;
    await plugin.schedule({
      notifications: [
        {
          id,
          title,
          body,
          schedule: { at: new Date(Date.now() + delayMs) },
          isExactNotification: false
        }
      ]
    });
    return true;
  } catch {
    return false;
  }
}
