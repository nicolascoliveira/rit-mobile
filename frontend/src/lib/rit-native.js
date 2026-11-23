import { MOBILE } from './mobile.js'

export const RIT_STUDENT_SERVER = 'https://app.treinerit.duckdns.org'
const NATIVE_MODE_KEY = 'rit_native_mode'
const ADMIN_TOKEN_KEY = 'rit_admin_token'
const DEVICE_ID_KEY = 'rit_device_id'
const TRUSTED_DEVICE_PREFIX = 'rit_td_'
const PENDING_INVITE_KEY = 'rit_pending_invite_code'

export function getOrCreateDeviceId() {
  if (typeof window === 'undefined') return 'rit-web-device'
  try {
    const existing = window.localStorage?.getItem(DEVICE_ID_KEY)
    if (existing && existing.length >= 8) return existing
    const bytes = new Uint8Array(16)
    if (window.crypto?.getRandomValues) {
      window.crypto.getRandomValues(bytes)
    } else {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
    }
    const id = 'dev_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
    window.localStorage?.setItem(DEVICE_ID_KEY, id)
    return id
  } catch {
    return 'rit-fallback-device'
  }
}

export function getTrustedDeviceToken(email) {
  if (typeof window === 'undefined' || !email) return ''
  try {
    const key = TRUSTED_DEVICE_PREFIX + String(email).trim().toLowerCase()
    return window.localStorage?.getItem(key) || ''
  } catch {
    return ''
  }
}

export function setTrustedDeviceToken(email, token) {
  if (typeof window === 'undefined' || !email || !token) return
  try {
    const key = TRUSTED_DEVICE_PREFIX + String(email).trim().toLowerCase()
    window.localStorage?.setItem(key, String(token))
  } catch { /* ignore */ }
}

export function setPendingInviteCode(code) {
  if (typeof window === 'undefined') return
  try {
    const clean = String(code || '').trim().toUpperCase()
    if (clean) window.localStorage?.setItem(PENDING_INVITE_KEY, clean)
    else window.localStorage?.removeItem(PENDING_INVITE_KEY)
  } catch { /* ignore */ }
}

export function consumePendingInviteCode() {
  if (typeof window === 'undefined') return ''
  try {
    const code = window.localStorage?.getItem(PENDING_INVITE_KEY) || ''
    if (code) window.localStorage?.removeItem(PENDING_INVITE_KEY)
    return code.trim().toUpperCase()
  } catch {
    return ''
  }
}

export function parseRitDeepLink(rawUrl) {
  const s = String(rawUrl || '').trim()
  if (!s) return null
  try {
    const u = new URL(s)
    const proto = u.protocol.toLowerCase()
    const host = u.hostname.toLowerCase()
    const path = (u.pathname || '/').toLowerCase()

    // Ignore routine-share (/r) and NFC (/nfc) links handled by their dedicated hooks
    if (proto === 'rit:' || proto === 'opengym:') {
      if (host === 'r' || host === 'nfc' || path.startsWith('/r/') || path === '/r' || path.startsWith('/nfc')) {
        return null
      }
    } else if (proto === 'https:' || proto === 'http:') {
      const isRitHost =
        host === 'app.treinerit.duckdns.org' ||
        host === 'app.treinerit.com.br' ||
        host === 'treinerit.com.br' ||
        host.endsWith('.treinerit.com.br') ||
        host.endsWith('.treinerit.duckdns.org')
      if (!isRitHost) return null
      if (path === '/r' || path.startsWith('/r/') || path === '/nfc' || path.startsWith('/nfc/')) {
        return null
      }
    } else {
      return null
    }

    const sp = u.searchParams
    const tenantId = (sp.get('tenant') || sp.get('t') || '').trim().toLowerCase()
    const inviteCode = (sp.get('convite') || sp.get('invite') || sp.get('code') || '').trim().toUpperCase()
    const isSignupPath =
      host === 'cadastro' ||
      host === 'convite' ||
      path.includes('/cadastro') ||
      path.includes('/convite') ||
      Boolean(inviteCode)

    const hashRoute = u.hash && u.hash.startsWith('#/') ? u.hash.slice(1) : ''
    if (!tenantId && !inviteCode && !isSignupPath && !hashRoute) return null

    return {
      tenantId: tenantId || null,
      inviteCode: inviteCode || null,
      isSignup: isSignupPath,
      hashRoute: hashRoute || null
    }
  } catch {
    return null
  }
}

export function buildAndroidAppIntentUrl(searchStr = '') {
  const rawSearch = typeof searchStr === 'string' ? searchStr : (typeof window !== 'undefined' ? window.location.search : '')
  const fallback = typeof window !== 'undefined' ? window.location.href : 'https://app.treinerit.duckdns.org'
  const cleanQuery = rawSearch.startsWith('?') ? rawSearch : (rawSearch ? `?${rawSearch}` : '')
  return `intent://cadastro${cleanQuery}#Intent;scheme=rit;package=br.com.treinerit.app;S.browser_fallback_url=${encodeURIComponent(fallback)};end`
}

function cleanBaseUrl(rawUrl) {
  const s = String(rawUrl || '').trim()
  if (!s) return ''
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s
    const u = new URL(withScheme)
    return (u.origin + u.pathname.replace(/\/+$/, '')).toLowerCase()
  } catch {
    return ''
  }
}

export function isRitDefaultServer(rawUrl) {
  const clean = cleanBaseUrl(rawUrl)
  return Boolean(clean && clean === RIT_STUDENT_SERVER.toLowerCase())
}

export function extractSessionToken(body, headers) {
  if (typeof body?.token === 'string' && body.token.trim()) {
    return body.token.trim()
  }
  let rawCookie = ''
  if (headers) {
    if (typeof headers.get === 'function') {
      rawCookie = headers.get('set-cookie') || ''
    } else if (typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        if (String(k).toLowerCase() === 'set-cookie') {
          rawCookie = Array.isArray(v) ? v.join(', ') : String(v || '')
          break
        }
      }
    }
  }
  if (!rawCookie) return null
  const hostMatch = rawCookie.match(/(?:^|[,;\s])__Host-gymsid=([^;\s,]+)/)
  if (hostMatch && hostMatch[1]) return hostMatch[1].trim()
  const legacyMatch = rawCookie.match(/(?:^|[,;\s])gymsid=([^;\s,]+)/)
  if (legacyMatch && legacyMatch[1]) return legacyMatch[1].trim()
  return null
}

export async function clearNativeCookiesForUrl(url) {
  if (!MOBILE || !url) return
  try {
    const cap = await import('@capacitor/core')
    if (cap?.Capacitor?.isNativePlatform?.() && cap?.CapacitorCookies?.clearCookies) {
      await cap.CapacitorCookies.clearCookies({ url })
    }
  } catch { /* ignore */ }
}

export function rememberStudentNativeMode() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage?.setItem(NATIVE_MODE_KEY, 'student')
  } catch { /* ignore */ }
}

export function openPortalNativeApp(route = '/login') {
  if (typeof window === 'undefined') return
  try {
    window.localStorage?.setItem(NATIVE_MODE_KEY, 'portal')
  } catch { /* ignore */ }
  const clean = String(route || '/login').startsWith('/') ? String(route || '/login') : `/${route}`
  window.location.assign(`./portal/index.html#${clean}`)
}

export function shouldAutoOpenPortal() {
  if (!MOBILE || typeof window === 'undefined') return false
  if (!window.Capacitor?.isNativePlatform?.()) return false
  try {
    return window.localStorage?.getItem(NATIVE_MODE_KEY) === 'portal'
      && Boolean(window.localStorage?.getItem(ADMIN_TOKEN_KEY))
  } catch {
    return false
  }
}
