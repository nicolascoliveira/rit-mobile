import { MOBILE } from './mobile.js'

export const RIT_STUDENT_SERVER = 'https://app.treinerit.com.br'
const NATIVE_MODE_KEY = 'rit_native_mode'
const ADMIN_TOKEN_KEY = 'rit_admin_token'

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
