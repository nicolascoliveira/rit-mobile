import { MOBILE } from './mobile.js'

export const RIT_STUDENT_SERVER = 'https://app.treinerit.duckdns.org'
const NATIVE_MODE_KEY = 'rit_native_mode'
const ADMIN_TOKEN_KEY = 'rit_admin_token'

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
