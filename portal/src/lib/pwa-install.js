import { useCallback, useEffect, useState } from 'react';
import { isNativePortalApp } from './native.js';

let deferredInstallPrompt = null;
const promptListeners = new Set();
let swRegistered = false;

function notifyPromptListeners(ev) {
  for (const fn of promptListeners) fn(ev);
}

const INSTALLED_STORAGE_KEY = 'rit_portal_pwa_installed';

function readInstalledFlag() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage?.getItem(INSTALLED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeInstalledFlag(val) {
  if (typeof window === 'undefined') return;
  try {
    if (val) window.localStorage?.setItem(INSTALLED_STORAGE_KEY, '1');
    else window.localStorage?.removeItem(INSTALLED_STORAGE_KEY);
  } catch {
    /* ignore storage restrictions */
  }
}

export function isStandaloneMode() {
  if (isNativePortalApp()) return true;
  if (typeof window === 'undefined') return false;
  try {
    const standalone = Boolean(
      window.matchMedia?.('(display-mode: standalone)').matches ||
      window.matchMedia?.('(display-mode: window-controls-overlay)').matches ||
      window.navigator?.standalone === true
    );
    if (standalone) writeInstalledFlag(true);
    return standalone;
  } catch {
    return false;
  }
}

export function isIosDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  // iPadOS em modo desktop reporta MacIntel + multi-touch
  return /Macintosh/i.test(ua) && Number(navigator.maxTouchPoints || 0) > 1;
}

export function isAndroidDevice() {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent || '');
}

export function getDeferredInstallPrompt() {
  return deferredInstallPrompt;
}

export async function runNativeInstallPrompt() {
  if (!deferredInstallPrompt) return 'unavailable';
  try {
    await deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice?.outcome === 'accepted') {
      deferredInstallPrompt = null;
      notifyPromptListeners(null);
      return 'accepted';
    }
    return 'dismissed';
  } catch {
    return 'unavailable';
  }
}

export function registerPortalServiceWorker() {
  if (isNativePortalApp()) return;
  if (swRegistered || typeof window === 'undefined') return;
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') return;
  if (!('serviceWorker' in navigator)) return;

  swRegistered = true;
  const doRegister = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      /* Falha silenciosa em ambientes sem HTTPS/localhost */
    });
  };
  if (document.readyState === 'complete') {
    doRegister();
  } else {
    window.addEventListener('load', doRegister, { once: true });
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    writeInstalledFlag(false);
    deferredInstallPrompt = e;
    notifyPromptListeners(e);
  });
  window.addEventListener('appinstalled', () => {
    writeInstalledFlag(true);
    deferredInstallPrompt = null;
    notifyPromptListeners(null);
  });
}

export function useOnlineStatus() {
  const [online, setOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true));

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return online;
}

export function usePortalPwaInstall() {
  const [promptEvent, setPromptEvent] = useState(deferredInstallPrompt);
  const [standalone, setStandalone] = useState(isStandaloneMode);
  const [installedBefore, setInstalledBefore] = useState(readInstalledFlag);

  useEffect(() => {
    setPromptEvent(deferredInstallPrompt);
    setStandalone(isStandaloneMode());
    setInstalledBefore(readInstalledFlag());

    const onPrompt = e => {
      setPromptEvent(e);
      setInstalledBefore(readInstalledFlag());
    };
    promptListeners.add(onPrompt);

    const mq = window.matchMedia?.('(display-mode: standalone)');
    const onChange = () => {
      setStandalone(isStandaloneMode());
      setInstalledBefore(readInstalledFlag());
    };
    mq?.addEventListener?.('change', onChange);
    window.addEventListener('appinstalled', onChange);

    return () => {
      promptListeners.delete(onPrompt);
      mq?.removeEventListener?.('change', onChange);
      window.removeEventListener('appinstalled', onChange);
    };
  }, []);

  const isIOS = isIosDevice();
  const isAndroid = isAndroidDevice();
  const alreadyInstalled = standalone || (!promptEvent && installedBefore);
  // Mostramos o controle sempre que não estiver instalado e estiver no browser com suporte potencial
  // (prompt nativo Chrome/Edge/Android, iOS Safari fora de standalone, ou browser desktop)
  const canInstall = !alreadyInstalled && Boolean(promptEvent || isIOS || isAndroid || (typeof window !== 'undefined' && 'serviceWorker' in navigator));

  const triggerNativeInstall = useCallback(async () => {
    return runNativeInstallPrompt();
  }, []);

  return {
    standalone,
    canInstall,
    hasNativePrompt: Boolean(promptEvent),
    isIOS,
    isAndroid,
    triggerNativeInstall
  };
}
