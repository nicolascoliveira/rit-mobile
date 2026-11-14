// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cleanTenantSlug,
  getActiveTenantSlug,
  lockTenantForUser,
  syncTenantUrl,
  unlockTenant,
} from './branding.js'

describe('cross-tenant URL lock & redirect (Bloco 1)', () => {
  beforeEach(() => {
    unlockTenant({ clearStorageIfNoUrl: true })
    localStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    unlockTenant({ clearStorageIfNoUrl: true })
    localStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  it('permite preview via ?tenant= enquanto o visitante está deslogado', () => {
    window.history.replaceState(null, '', '/?tenant=GabrielLeite#/login')
    expect(cleanTenantSlug('GabrielLeite')).toBe('gabrielleite')
    expect(getActiveTenantSlug()).toBe('gabrielleite')
  })

  it('prende aluno autenticado na própria academia e redireciona a URL preservando a rota hash', () => {
    window.history.replaceState(null, '', '/?tenant=gabrielleite#/workout')
    const locked = lockTenantForUser({ id: 'u1', tenantId: 'teste', saasRole: 'student' })

    expect(locked).toBe('teste')
    expect(getActiveTenantSlug()).toBe('teste')
    expect(localStorage.getItem('rit_active_tenant')).toBe('teste')
    expect(window.location.search).toBe('?tenant=teste')
    expect(window.location.hash).toBe('#/workout')
  })

  it('remove ?tenant= da URL quando o usuário autenticado pertence ao tenant default', () => {
    window.history.replaceState(null, '', '/?tenant=gabrielleite&ref=promo#/stats')
    const locked = lockTenantForUser({ id: 'u2', tenantId: null, saasRole: 'student' })

    expect(locked).toBe('default')
    expect(getActiveTenantSlug()).toBe('')
    expect(localStorage.getItem('rit_active_tenant')).toBeNull()
    expect(window.location.search).toBe('?ref=promo')
    expect(window.location.hash).toBe('#/stats')
  })

  it('mantém preview liberado para superadmin e limpa trava ao fazer logout', () => {
    window.history.replaceState(null, '', '/?tenant=gabrielleite#/plan')
    const superLocked = lockTenantForUser({ id: 'u_sup', tenantId: 'default', saasRole: 'superadmin' })

    expect(superLocked).toBeNull()
    expect(getActiveTenantSlug()).toBe('gabrielleite')
    expect(window.location.search).toBe('?tenant=gabrielleite')

    // Ao logar como aluno comum, trava e reescreve
    lockTenantForUser({ id: 'u1', tenantId: 'teste', saasRole: 'student' })
    expect(window.location.search).toBe('?tenant=teste')

    // Ao sair sem ?tenant= na URL, limpa o storage; se URL ainda tem ?tenant=teste, usa URL
    window.history.replaceState(null, '', '/#/login')
    unlockTenant({ clearStorageIfNoUrl: true })
    expect(getActiveTenantSlug()).toBe('')
    expect(localStorage.getItem('rit_active_tenant')).toBeNull()

    expect(syncTenantUrl('academia-b')).toBe(true)
    expect(window.location.search).toBe('?tenant=academia-b')
  })
})
