// Mobile build only: "connect to my server" mode (see mobile.js's header comment for why the
// mobile flavor has no backend at all by default). This is the alternative — pairing the app to
// an already self-hosted openGym server instead of keeping data device-local.
//
// Passkeys can't be used from inside the app's own WebView (its origin never matches the
// server's RP_ID), so auth here is a short one-time code redeemed from an already signed-in
// browser tab (Settings → "Pair the mobile app") for a bearer token — see api/server.js's
// /api/pair/create + /api/pair/redeem.
import { pairRedeem, setRemoteAuth, getAccessHeadersFor } from './api.js'
import { loadRemoteFile, saveRemoteFile } from './mobile.js'
import { clearCfAccess } from './cf-access.js'
import { nativeFetch } from './capacitor-fetch.js'
import { RIT_STUDENT_SERVER, extractSessionToken, clearNativeCookiesForUrl } from './rit-native.js'

// Accepts what someone actually types: bare host, no scheme, trailing slash, stray whitespace.
// Defaults to https:// (self-hosting docs already push for HTTPS; the one exception, localhost,
// still parses fine without a scheme). Returns null for anything that isn't a usable URL at all.
export function normalizeServerUrl(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s
  try {
    const u = new URL(withScheme)
    if (!u.hostname) return null
    return u.origin + u.pathname.replace(/\/+$/, '')
  } catch (e) { return null }
}

export async function loadRemote() {
  return loadRemoteFile()
}

export async function chooseLocal() {
  await saveRemoteFile({ mode: 'local' })
}

// The server's Cloudflare Access token goes with it (lib/cf-access.js).
export async function forgetRemote() {
  let prevBase = ''
  try {
    const cur = await loadRemoteFile()
    prevBase = cur?.base || ''
  } catch { /* ignore */ }
  await saveRemoteFile({ mode: 'local' })
  setRemoteAuth('', null)
  await clearCfAccess()
  if (prevBase) await clearNativeCookiesForUrl(prevBase)
}

// The server renewed the token (GET /api/me hands one out once the old is past half its life):
// every request from now on carries it, and the pairing file keeps it for the next start. The
// old one stays valid until its own expiry, so a write that fails here costs nothing but a
// renewal on a later start.
export async function renewToken(remote, token) {
  setRemoteAuth(remote.base, token)
  await saveRemoteFile({ ...remote, token })
}

async function nativeJsonRequest(url, init = {}, timeoutMs = 20000) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  const expired = new Promise((_, reject) => {
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (ctl) ctl.abort()
        reject(Object.assign(new Error('O servidor demorou para responder. Tente novamente.'), { code: 'timeout' }))
      }, timeoutMs)
    }
  })
  const headers = { Accept: 'application/json', ...(init.headers || {}) }
  const req = nativeFetch(url, { ...init, headers, ...(ctl ? { signal: ctl.signal } : {}) }).then(async res => {
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = null }
    if (!body || typeof body !== 'object') body = null
    if (!res.ok) {
      const data = body ? { ...body } : {}
      const msg = data.error || ('HTTP ' + res.status)
      if (res.status === 429 && data.retryAfter == null) {
        const ra = Number(res.headers?.get?.('retry-after'))
        data.retryAfter = Number.isFinite(ra) && ra > 0 ? ra : 60
      }
      throw Object.assign(new Error(msg), { status: res.status, code: data.code || 'http', data })
    }
    if (!body) {
      throw Object.assign(new Error('Resposta inesperada do servidor.'), { status: res.status, code: 'bad-response', data: {} })
    }
    return { body, headers: res.headers, status: res.status }
  }, err => {
    if (err?.name === 'AbortError' || err?.code === 'timeout') throw err
    throw Object.assign(new Error('Não foi possível conectar ao servidor. Verifique sua internet.'), { code: 'network' })
  })
  req.catch(() => {})
  try {
    return await Promise.race([req, expired])
  } finally {
    clearTimeout(timer)
  }
}

async function upgradeToMobileBearer(base, cookieToken, currentPassword) {
  if (!cookieToken || !currentPassword) return cookieToken
  try {
    const created = await nativeJsonRequest(base + '/api/pair/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cookieToken,
        ...getAccessHeadersFor(base)
      },
      body: JSON.stringify({ current: currentPassword })
    }, 10000)
    const code = created?.body?.code
    if (!code) return cookieToken
    const redeemed = await nativeJsonRequest(base + '/api/pair/redeem', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAccessHeadersFor(base)
      },
      body: JSON.stringify({ code })
    }, 10000)
    return redeemed?.body?.token || cookieToken
  } catch {
    return cookieToken
  }
}

async function persistRemoteAuth(base, token, user, fallbackName = '') {
  setRemoteAuth(base, token)
  await saveRemoteFile({ mode: 'remote', base, token, user })
  try {
    if (typeof localStorage !== 'undefined') {
      const remembered = user?.name || fallbackName
      if (remembered) localStorage.setItem('rit_last_username', remembered)
    }
  } catch { /* ignore */ }
  return user
}

async function authenticatePasswordRoute(rawUrl, path, payload, upgradeSecret, fallbackName) {
  const base = normalizeServerUrl(rawUrl || RIT_STUDENT_SERVER)
  if (!base) throw new Error('Enter a valid server address')
  await clearNativeCookiesForUrl(base)
  const { body, headers } = await nativeJsonRequest(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAccessHeadersFor(base)
    },
    body: JSON.stringify({ ...payload, mobile: true })
  })
  const rawToken = extractSessionToken(body, headers)
  if (!rawToken || !body?.user?.id) {
    throw Object.assign(new Error('Resposta inesperada do servidor.'), { status: 200, code: 'bad-response', data: {} })
  }
  const token = typeof body.token === 'string' && body.token.trim()
    ? rawToken
    : await upgradeToMobileBearer(base, rawToken, upgradeSecret)
  return persistRemoteAuth(base, token, body.user, fallbackName)
}

export async function connectWithPassword(rawUrl, name, password) {
  return authenticatePasswordRoute(
    rawUrl,
    '/api/login/password',
    { name, password },
    password,
    name
  )
}

export async function registerWithPassword(rawUrl, { name, password, code = '', email = '' }) {
  const cleanCode = String(code || '').trim().toUpperCase()
  const cleanEmail = typeof email === 'string' && email.trim() ? email.trim() : ''
  return authenticatePasswordRoute(
    rawUrl,
    '/api/register/password',
    { name, password, code: cleanCode, ...(cleanEmail ? { email: cleanEmail } : {}) },
    password,
    name
  )
}

export async function resetPasswordAndConnect(rawUrl, { name, code, next }) {
  return authenticatePasswordRoute(
    rawUrl,
    '/api/login/password-reset',
    { name, code: String(code || '').trim().toUpperCase(), next },
    next,
    name
  )
}

export async function previewRemoteInvite(rawUrl, code) {
  const base = normalizeServerUrl(rawUrl || RIT_STUDENT_SERVER)
  if (!base) throw new Error('Enter a valid server address')
  const clean = String(code || '').trim().toUpperCase()
  const { body } = await nativeJsonRequest(
    base + '/api/invite/preview?code=' + encodeURIComponent(clean),
    { method: 'GET', headers: getAccessHeadersFor(base) },
    10000
  )
  return body
}

export async function fetchRemoteConfig(rawUrl) {
  const base = normalizeServerUrl(rawUrl || RIT_STUDENT_SERVER)
  if (!base) return null
  try {
    const { body } = await nativeJsonRequest(
      base + '/api/config',
      { method: 'GET', headers: getAccessHeadersFor(base) },
      8000
    )
    return body
  } catch {
    return null
  }
}

// Redeems the pairing code, wires api.js at the resolved base, and persists the connection so
// boot() can restore it on the next launch.
export async function connect(rawUrl, code) {
  const base = normalizeServerUrl(rawUrl)
  if (!base) throw new Error('Enter a valid server address')
  const { token, user } = await pairRedeem(base, String(code || '').trim())
  return persistRemoteAuth(base, token, user)
}
