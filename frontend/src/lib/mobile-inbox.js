// Native Android notification inbox bridge (RitInboxPlugin + RitInboxJob).
// Arms the persisted background JobScheduler worker and polls GET /api/notifications/pending
// while the app is open or resumed so trainer updates, weekly frequency summaries, assessments,
// and reminders arrive natively in the APK without requiring a browser Service Worker.
import { MOBILE } from './mobile.js'
import { remoteAuth } from './api.js'

export const INBOX_POLL_MS = 20000

let pluginP = null
const inboxPlugin = () => pluginP || (pluginP = (async () => {
  if (!MOBILE) return null
  const { registerPlugin, Capacitor } = await import('@capacitor/core')
  if (!Capacitor?.isNativePlatform?.()) return null
  return { RitInbox: registerPlugin('RitInbox') }
})().catch(() => null))

export async function armMobileInbox(userId = '') {
  const auth = remoteAuth()
  if (!MOBILE || !auth?.base) return false
  const p = await inboxPlugin()
  if (!p) return false
  try {
    await p.RitInbox.arm({ server: auth.base, headers: auth.headers || {}, userId: String(userId || '') })
    return true
  } catch {
    return false
  }
}

export async function pollMobileInbox() {
  const p = await inboxPlugin()
  if (!p) return { ok: false, notifications: [] }
  try {
    const res = await p.RitInbox.poll()
    const list = Array.isArray(res?.notifications) ? res.notifications : []
    return { ok: Boolean(res?.ok), latestId: Number(res?.latestId || 0), notifications: list }
  } catch {
    return { ok: false, notifications: [] }
  }
}

export async function disarmMobileInbox() {
  const p = await inboxPlugin()
  if (!p) return false
  try {
    await p.RitInbox.disarm()
    return true
  } catch {
    return false
  }
}

export function startMobileInbox({ userId = '', onUpdates = null, intervalMs = INBOX_POLL_MS } = {}) {
  if (!MOBILE) return () => {}
  let stopped = false
  let inFlight = false
  let appListener = null

  const runPoll = async () => {
    if (stopped || inFlight) return
    if (typeof document !== 'undefined' && document.hidden) return
    if (!remoteAuth()?.base) return
    inFlight = true
    try {
      const res = await pollMobileInbox()
      if (!stopped && res.notifications.length > 0 && typeof onUpdates === 'function') {
        onUpdates(res.notifications)
      }
    } finally {
      inFlight = false
    }
  }

  armMobileInbox(userId).then(armed => {
    if (armed && !stopped) runPoll()
  })

  const timer = setInterval(runPoll, Math.max(5000, intervalMs))
  const onFocus = () => { runPoll() }
  if (typeof window !== 'undefined') window.addEventListener('focus', onFocus)

  import('@capacitor/app')
    .then(({ App }) => App.addListener('appStateChange', ({ isActive }) => {
      if (isActive && !stopped) {
        armMobileInbox(userId).then(armed => { if (armed && !stopped) runPoll() })
      }
    }))
    .then(handle => {
      if (stopped) handle?.remove?.()
      else appListener = handle
    })
    .catch(() => {})

  return () => {
    stopped = true
    clearInterval(timer)
    if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus)
    try { appListener?.remove?.() } catch { /* ignore */ }
  }
}

export function _resetMobileInbox() { pluginP = null }
