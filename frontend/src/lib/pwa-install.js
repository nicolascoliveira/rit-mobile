import { useEffect, useState } from 'react'
import { useBranding } from './branding.js'

let deferredInstallPrompt = null
const promptListeners = new Set()

function notifyPromptListeners(ev) {
  for (const fn of promptListeners) fn(ev)
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault?.()
    deferredInstallPrompt = e
    notifyPromptListeners(e)
  })
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null
    notifyPromptListeners(null)
  })
}

export function isStandaloneMode() {
  if (typeof window === 'undefined') return false
  try {
    return Boolean(
      window.matchMedia?.('(display-mode: standalone)').matches ||
      window.navigator?.standalone === true
    )
  } catch {
    return false
  }
}

export function getDeferredInstallPrompt() {
  return deferredInstallPrompt
}

export async function runNativeInstallPrompt() {
  if (!deferredInstallPrompt) return 'unavailable'
  try {
    await deferredInstallPrompt.prompt()
    const choice = await deferredInstallPrompt.userChoice
    if (choice?.outcome === 'accepted') {
      deferredInstallPrompt = null
      notifyPromptListeners(null)
      return 'accepted'
    }
    return 'dismissed'
  } catch {
    return 'unavailable'
  }
}

export function usePwaInstall() {
  const branding = useBranding()
  const [promptEvent, setPromptEvent] = useState(deferredInstallPrompt)
  const [standalone, setStandalone] = useState(isStandaloneMode)

  useEffect(() => {
    setPromptEvent(deferredInstallPrompt)
    setStandalone(isStandaloneMode())
    const onPrompt = e => setPromptEvent(e)
    promptListeners.add(onPrompt)
    const mq = window.matchMedia?.('(display-mode: standalone)')
    const onChange = () => setStandalone(isStandaloneMode())
    mq?.addEventListener?.('change', onChange)
    return () => {
      promptListeners.delete(onPrompt)
      mq?.removeEventListener?.('change', onChange)
    }
  }, [])

  const appName = branding?.isCustomTenant && branding?.gymName ? branding.gymName : 'Rit'
  return {
    appName,
    promptEvent,
    hasNativePrompt: Boolean(promptEvent),
    standalone
  }
}
