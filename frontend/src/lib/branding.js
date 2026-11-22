import { useEffect, useState } from 'react'
import { customAccentVars, cleanHex } from './accent.js'
import { appBase } from './app-base.js'
import { MOBILE } from './mobile.js'
import { nativeFetch } from './capacitor-fetch.js'

const TENANT_STORAGE_KEY = 'rit_active_tenant'
const LEGACY_STORAGE_KEY = 'opengym_active_tenant'

export const DEFAULT_BRANDING = {
  gymName: 'Rit',
  slogan: '',
  primaryColor: '#D0FF00',
  accentColor: '#a8cc00',
  logoUrl: '',
  contactPhone: '',
  address: '',
  instagram: '',
  seasonalTheme: 'auto',
  accountType: 'gym',
  isCustomTenant: false,
  tenantId: 'default'
}

let currentBranding = { ...DEFAULT_BRANDING }
const listeners = new Set()
let lockedTenant = null
let appliedBrandingAccent = false

export function cleanTenantSlug(raw) {
  if (!raw || typeof raw !== 'string') return ''
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 50)
}

function syncTenantStorage(slug) {
  if (typeof window === 'undefined') return
  const clean = cleanTenantSlug(slug)
  try {
    if (!clean || clean === 'default') {
      sessionStorage.removeItem(TENANT_STORAGE_KEY)
      sessionStorage.removeItem(LEGACY_STORAGE_KEY)
      localStorage?.removeItem(TENANT_STORAGE_KEY)
      localStorage?.removeItem(LEGACY_STORAGE_KEY)
    } else {
      sessionStorage.setItem(TENANT_STORAGE_KEY, clean)
      localStorage?.setItem(TENANT_STORAGE_KEY, clean)
    }
  } catch { /* ignore */ }
}

/**
 * Atualiza o parâmetro `?tenant=` da URL via `history.replaceState` para espelhar
 * o tenant real do usuário autenticado (ou remove `?tenant=` quando for `default`),
 * preservando path e hash route (`#/workout`, `#/r/...`) sem recarregar a página.
 */
export function syncTenantUrl(targetSlug) {
  if (typeof window === 'undefined' || !window.location?.href) return false
  const clean = cleanTenantSlug(targetSlug)
  const desired = (!clean || clean === 'default') ? '' : clean
  try {
    const url = new URL(window.location.href)
    const curRaw = url.searchParams.get('tenant')
    const curClean = curRaw ? cleanTenantSlug(curRaw) : ''
    const normalizedCur = (!curClean || curClean === 'default') ? '' : curClean
    if (desired === normalizedCur && (curRaw === null ? desired === '' : curRaw === desired)) return false
    if (desired) url.searchParams.set('tenant', desired)
    else url.searchParams.delete('tenant')
    const next = url.pathname + url.search + url.hash
    window.history?.replaceState?.(null, '', next)
    return true
  } catch { return false }
}

/**
 * Trava o cliente no tenant do usuário autenticado (quando não superadmin),
 * corrigindo storage e URL automaticamente para impedir cross-tenant via `?tenant=`.
 */
export function lockTenantForUser(user) {
  if (user && user.saasRole !== 'superadmin') {
    const clean = cleanTenantSlug(user.tenantId)
    const target = clean || 'default'
    const changed = lockedTenant !== target
    lockedTenant = target
    syncTenantStorage(target)
    syncTenantUrl(target)
    if (changed) {
      lastFetchedSlug = null
      lastBrandingFetchTs = 0
    }
    return target
  }
  lockedTenant = null
  return null
}

/**
 * Destrava e limpa preferência de tenant ao encerrar sessão (preserva `?tenant=` explícito na URL).
 */
export function unlockTenant({ clearStorageIfNoUrl = true } = {}) {
  lockedTenant = null
  lastFetchedSlug = null
  lastBrandingFetchTs = 0
  if (!clearStorageIfNoUrl || typeof window === 'undefined') return
  try {
    const sp = new URLSearchParams(window.location.search)
    if (!sp.get('tenant')) syncTenantStorage('')
  } catch { /* ignore */ }
}

export function getActiveTenantSlug() {
  if (lockedTenant !== null) {
    return lockedTenant === 'default' ? '' : lockedTenant
  }
  try {
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search)
      const fromUrl = sp.get('tenant')
      if (fromUrl) {
        const clean = cleanTenantSlug(fromUrl)
        if (clean === 'default') {
          syncTenantStorage('')
          return ''
        }
        if (clean) {
          syncTenantStorage(clean)
          return clean
        }
      }
      // Se não veio por query param, verifica se o host é um subdomínio de academia (ex: ironpower.rit.com.br)
      const host = (window.location.hostname || '').toLowerCase()
      if (host && host !== 'localhost' && host !== '127.0.0.1') {
        const parts = host.split('.')
        if (parts.length >= 3) {
          const sub = parts[0]
          if (sub && sub !== 'www' && sub !== 'api' && sub !== 'app' && sub !== 'gestao' && sub !== 'portal' && sub !== 'painel' && sub !== 'admin' && !/^\d+$/.test(sub)) {
            const cleanSub = sub.replace(/[^a-z0-9_-]/g, '')
            if (cleanSub) return cleanSub
          }
        }
      }

      return (
        sessionStorage.getItem(TENANT_STORAGE_KEY) ||
        (typeof localStorage !== 'undefined' && localStorage.getItem(TENANT_STORAGE_KEY)) ||
        sessionStorage.getItem(LEGACY_STORAGE_KEY) ||
        (typeof localStorage !== 'undefined' && localStorage.getItem(LEGACY_STORAGE_KEY)) ||
        ''
      )
    }
  } catch { /* ignore */ }
  return ''
}

export function getBranding() {
  return currentBranding
}

export function subscribeBranding(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useBranding() {
  const [b, setB] = useState(currentBranding)
  useEffect(() => subscribeBranding(setB), [])
  return b
}

export function applyGymBranding(branding, theme = 'dark', meta = {}) {
  if (!branding || typeof branding !== 'object') return
  const tenantId = meta.tenantId || currentBranding.tenantId || 'default'
  const isCustomTenant = Boolean(
    meta.isCustomTenant !== undefined
      ? meta.isCustomTenant
      : (tenantId !== 'default' || (branding.gymName && branding.gymName !== 'Rit' && branding.gymName !== 'openGym'))
  )

  currentBranding = {
    ...DEFAULT_BRANDING,
    ...branding,
    accountType: meta.accountType || branding.accountType || currentBranding.accountType || 'gym',
    tenantId,
    isCustomTenant
  }

  if (typeof document !== 'undefined') {
    if (isCustomTenant && currentBranding.gymName) {
      document.title = currentBranding.slogan
        ? `${currentBranding.gymName} — ${currentBranding.slogan}`
        : currentBranding.gymName
      const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]')
      if (appleTitle) appleTitle.setAttribute('content', currentBranding.gymName)
    } else {
      document.title = 'Rit'
    }

    const root = document.documentElement
    const hex = cleanHex(currentBranding.primaryColor)
    if (isCustomTenant && hex) {
      const vars = customAccentVars(hex, root.dataset.theme || theme)
      if (vars) {
        root.dataset.accent = 'custom'
        appliedBrandingAccent = true
        for (const [k, v] of Object.entries(vars)) {
          root.style.setProperty(k, v)
        }
      }
    } else if (appliedBrandingAccent) {
      appliedBrandingAccent = false
      if (root.dataset.accent === 'custom') delete root.dataset.accent
      for (const k of ['--acc', '--acc-2', '--on-acc', '--acc-ink']) {
        root.style.removeProperty(k)
      }
    }
  }

  for (const fn of listeners) {
    try { fn(currentBranding) } catch { /* ignore */ }
  }
}

let lastBrandingFetchTs = 0;
let lastFetchedSlug = null;
let brandingApiBase = '';

export function setBrandingApiBase(base) {
  brandingApiBase = String(base || '').replace(/\/+$/, '');
}

export async function initGymBranding(force = false) {
  const slug = getActiveTenantSlug();
  const now = Date.now();
  if (!force && lastFetchedSlug === slug && now - lastBrandingFetchTs < 60000) return currentBranding;
  if (MOBILE && !brandingApiBase) return currentBranding;
  lastBrandingFetchTs = now;
  lastFetchedSlug = slug;
  try {
    const reqFetch = MOBILE && brandingApiBase ? nativeFetch : (typeof fetch === 'function' ? fetch : null);
    if (!reqFetch) return DEFAULT_BRANDING;
    const headers = {};
    if (slug) headers['X-Tenant-Id'] = slug;
    const qs = slug ? `?tenant=${encodeURIComponent(slug)}` : '';
    const basePrefix = (brandingApiBase || appBase()).replace(/\/$/, '');
    const res = await reqFetch(basePrefix + '/api/tenant/branding' + qs, { headers });
    if (res.ok) {
      const data = await res.json();
      if (data?.branding) {
        const resolvedTenant = cleanTenantSlug(data.tenant_id) || slug || 'default';
        if (data.locked) {
          lockedTenant = resolvedTenant;
          syncTenantStorage(resolvedTenant);
          syncTenantUrl(resolvedTenant);
          lastFetchedSlug = resolvedTenant === 'default' ? '' : resolvedTenant;
        }
        const nextBranding = { ...data.branding };
        if (typeof nextBranding.logoUrl === 'string' && nextBranding.logoUrl.startsWith('/') && /^https?:\/\//i.test(brandingApiBase)) {
          nextBranding.logoUrl = brandingApiBase + nextBranding.logoUrl;
        }
        applyGymBranding(nextBranding, 'dark', {
          tenantId: resolvedTenant,
          accountType: data.accountType || 'gym',
          isCustomTenant: resolvedTenant !== 'default' || (nextBranding.gymName && nextBranding.gymName !== 'Rit' && nextBranding.gymName !== 'openGym')
        });
        return currentBranding;
      }
    }
  } catch {
    // Offline or standalone demo build — keep default branding silently
  }
  return currentBranding;
}
