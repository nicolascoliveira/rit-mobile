// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  vi.stubEnv('VITE_MOBILE', '1')
  return {
    httpCalls: [],
    httpHandler: null,
    clearCookies: vi.fn(async () => {}),
    savedRemote: null,
    loadRemoteFile: vi.fn(async () => h.savedRemote),
    saveRemoteFile: vi.fn(async v => { h.savedRemote = v })
  }
})

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true },
  CapacitorHttp: {
    request: async opts => {
      h.httpCalls.push(opts)
      return h.httpHandler(opts)
    }
  },
  CapacitorCookies: {
    clearCookies: (...args) => h.clearCookies(...args)
  }
}))

vi.mock('./mobile.js', () => ({
  MOBILE: true,
  loadRemoteFile: (...args) => h.loadRemoteFile(...args),
  saveRemoteFile: (...args) => h.saveRemoteFile(...args)
}))

import {
  extractSessionToken,
  isRitDefaultServer,
  RIT_STUDENT_SERVER,
  parseRitDeepLink,
  getOrCreateDeviceId,
  getTrustedDeviceToken,
  setTrustedDeviceToken
} from './rit-native.js'
import { connectWithPassword, registerWithPassword, resetPasswordAndConnect, previewRemoteInvite } from './remote.js'
import { remoteAuth, setRemoteAuth } from './api.js'

const USER = { id: 'u-stu-1', name: 'lucas', tenantId: 'academia-x', saasRole: 'student', role: 'student' }

beforeEach(() => {
  h.httpCalls = []
  h.savedRemote = null
  h.clearCookies.mockClear()
  h.saveRemoteFile.mockClear()
  h.loadRemoteFile.mockClear()
  localStorage.clear()
  setRemoteAuth('', null)
})

afterEach(() => {
  setRemoteAuth('', null)
})

describe('rit-native token extraction and server check', () => {
  it('detects only the default Rit server URL as Rit default', () => {
    expect(isRitDefaultServer('https://app.treinerit.com.br')).toBe(true)
    expect(isRitDefaultServer('app.treinerit.com.br/')).toBe(true)
    expect(isRitDefaultServer('https://gym.example.com')).toBe(false)
    expect(isRitDefaultServer('')).toBe(false)
    expect(isRitDefaultServer(null)).toBe(false)
  })

  it('prefers direct JSON token when present', () => {
    expect(extractSessionToken({ token: 'DIRECT-B-TOKEN' }, { get: () => '__Host-gymsid=COOKIE-TOK; Path=/' })).toBe('DIRECT-B-TOKEN')
  })

  it('extracts __Host-gymsid ignoring expired legacy gymsid in combined Set-Cookie header', () => {
    const dual1 = '__Host-gymsid=HOST-TOK.sig123; Path=/; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax, gymsid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'
    const dual2 = 'gymsid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax, __Host-gymsid=HOST-TOK.sig456; Path=/; HttpOnly'
    expect(extractSessionToken({}, { 'set-cookie': dual1 })).toBe('HOST-TOK.sig123')
    expect(extractSessionToken({}, { 'Set-Cookie': dual2 })).toBe('HOST-TOK.sig456')
    expect(extractSessionToken({}, { get: () => 'gymsid=HTTP-TOK.abc; Path=/; HttpOnly' })).toBe('HTTP-TOK.abc')
    expect(extractSessionToken({}, { 'set-cookie': 'gymsid=; Path=/; Max-Age=0' })).toBeNull()
  })

  it('parses WhatsApp student invite and tenant deep links for Android App Links and rit:// scheme', () => {
    expect(parseRitDeepLink('https://app.treinerit.duckdns.org/cadastro?tenant=academia-iron&convite=rit889')).toEqual({
      tenantId: 'academia-iron',
      inviteCode: 'RIT889',
      isSignup: true,
      hashRoute: null
    })
    expect(parseRitDeepLink('https://app.treinerit.com.br/cadastro?tenant=personal-vip&convite=VIP777')).toEqual({
      tenantId: 'personal-vip',
      inviteCode: 'VIP777',
      isSignup: true,
      hashRoute: null
    })
    expect(parseRitDeepLink('rit://cadastro?tenant=studio-fit&convite=FIT100')).toEqual({
      tenantId: 'studio-fit',
      inviteCode: 'FIT100',
      isSignup: true,
      hashRoute: null
    })
    expect(parseRitDeepLink('https://app.treinerit.duckdns.org/?tenant=academia-iron#/plan')).toEqual({
      tenantId: 'academia-iron',
      inviteCode: null,
      isSignup: false,
      hashRoute: '/plan'
    })
    // Routine share (/r) and NFC (/nfc) are delegated to their own hooks
    expect(parseRitDeepLink('https://app.treinerit.com.br/r#1.d.abc')).toBeNull()
    expect(parseRitDeepLink('rit://r#1.d.abc')).toBeNull()
    expect(parseRitDeepLink('https://evil.example.com/cadastro?convite=X')).toBeNull()
  })

  it('persists deviceId and per-email trustedDeviceToken in localStorage', () => {
    const devId = getOrCreateDeviceId()
    expect(devId).toMatch(/^dev_[0-9a-f]{32}$/)
    expect(getOrCreateDeviceId()).toBe(devId)

    setTrustedDeviceToken('Aluno@TreineRit.com.br', 'td_tok_123')
    expect(getTrustedDeviceToken('aluno@treinerit.com.br')).toBe('td_tok_123')
  })
})

describe('native mobile password authentication', () => {
  it('logs in via Set-Cookie (handles null HTTP status key in Android headers) and upgrades silently to mobile bearer token', async () => {
    h.httpHandler = async opts => {
      if (opts.url === `${RIT_STUDENT_SERVER}/api/login/password`) {
        expect(opts.data).toMatchObject({ name: 'lucas', password: 'secret-password-123', mobile: true })
        return {
          status: 200,
          headers: {
            null: 'HTTP/1.1 200 OK',
            'Set-Cookie': '__Host-gymsid=COOKIE-SIG-1; Path=/; HttpOnly; Secure, gymsid=; Path=/; Max-Age=0'
          },
          data: JSON.stringify({ user: USER })
        }
      }
      if (opts.url === `${RIT_STUDENT_SERVER}/api/pair/create`) {
        expect(opts.headers.Authorization).toBe('Bearer COOKIE-SIG-1')
        expect(opts.data).toEqual({ current: 'secret-password-123' })
        return { status: 200, headers: {}, data: JSON.stringify({ code: 'UPGRADE99' }) }
      }
      if (opts.url === `${RIT_STUDENT_SERVER}/api/pair/redeem`) {
        expect(opts.data).toEqual({ code: 'UPGRADE99' })
        return { status: 200, headers: {}, data: JSON.stringify({ token: 'BEARER-B-90D', user: USER }) }
      }
      throw new Error('Unexpected URL: ' + opts.url)
    }

    const user = await connectWithPassword(RIT_STUDENT_SERVER, 'lucas', 'secret-password-123')
    expect(user).toEqual(USER)
    expect(h.clearCookies).toHaveBeenCalledWith({ url: RIT_STUDENT_SERVER })
    expect(h.saveRemoteFile).toHaveBeenCalledWith({
      mode: 'remote',
      base: RIT_STUDENT_SERVER,
      token: 'BEARER-B-90D',
      user: USER
    })
    expect(remoteAuth()).toMatchObject({
      base: RIT_STUDENT_SERVER,
      headers: { Authorization: 'Bearer BEARER-B-90D' }
    })
    expect(localStorage.getItem('rit_last_username')).toBe('lucas')
  })

  it('falls back cleanly to cookie token when pair upgrade fails', async () => {
    h.httpHandler = async opts => {
      if (opts.url.endsWith('/api/login/password')) {
        return {
          status: 200,
          headers: { 'Set-Cookie': '__Host-gymsid=COOKIE-FALLBACK; Path=/; HttpOnly' },
          data: JSON.stringify({ user: USER })
        }
      }
      if (opts.url.endsWith('/api/pair/create')) {
        return { status: 500, headers: {}, data: JSON.stringify({ error: 'temporary' }) }
      }
      throw new Error('Unexpected URL: ' + opts.url)
    }

    const user = await connectWithPassword('', 'lucas', 'secret-password-123')
    expect(user).toEqual(USER)
    expect(h.saveRemoteFile).toHaveBeenCalledWith({
      mode: 'remote',
      base: RIT_STUDENT_SERVER,
      token: 'COOKIE-FALLBACK',
      user: USER
    })
  })

  it('uses direct JSON token without extra pair round-trips when server returns body.token', async () => {
    h.httpHandler = async opts => {
      expect(opts.url).toBe(`${RIT_STUDENT_SERVER}/api/login/password`)
      return {
        status: 200,
        headers: { 'Set-Cookie': '__Host-gymsid=COOKIE-IGNORED; Path=/' },
        data: JSON.stringify({ user: USER, token: 'DIRECT-MOBILE-B' })
      }
    }

    await connectWithPassword(RIT_STUDENT_SERVER, 'lucas', 'secret-password-123')
    expect(h.httpCalls).toHaveLength(1)
    expect(h.saveRemoteFile).toHaveBeenCalledWith({
      mode: 'remote',
      base: RIT_STUDENT_SERVER,
      token: 'DIRECT-MOBILE-B',
      user: USER
    })
  })

  it('surfaces bad-credentials errors on invalid login', async () => {
    h.httpHandler = async () => ({
      status: 401,
      headers: {},
      data: JSON.stringify({ error: 'wrong name or password', code: 'bad-credentials' })
    })

    await expect(connectWithPassword(RIT_STUDENT_SERVER, 'lucas', 'wrong')).rejects.toMatchObject({
      status: 401,
      code: 'bad-credentials',
      data: { code: 'bad-credentials' }
    })
    expect(h.saveRemoteFile).not.toHaveBeenCalled()
  })

  it('registers with invite code + optional email and supports password reset', async () => {
    h.httpHandler = async opts => {
      if (opts.url.endsWith('/api/register/password')) {
        expect(opts.data).toEqual({
          name: 'Ana',
          password: 'new-strong-password',
          code: 'CONV123',
          email: 'ana@example.com',
          mobile: true
        })
        return {
          status: 200,
          headers: {},
          data: JSON.stringify({ user: { id: 'u2', name: 'Ana' }, token: 'REG-TOK' })
        }
      }
      if (opts.url.endsWith('/api/login/password-reset')) {
        expect(opts.data).toEqual({
          name: 'Ana',
          code: 'RST456',
          next: 'reset-strong-password',
          mobile: true
        })
        return {
          status: 200,
          headers: { 'Set-Cookie': '__Host-gymsid=RST-COOKIE; Path=/' },
          data: JSON.stringify({ user: { id: 'u2', name: 'Ana' } })
        }
      }
      if (opts.url.endsWith('/api/pair/create')) {
        expect(opts.data).toEqual({ current: 'reset-strong-password' })
        return { status: 200, headers: {}, data: JSON.stringify({ code: 'P2' }) }
      }
      if (opts.url.endsWith('/api/pair/redeem')) {
        return { status: 200, headers: {}, data: JSON.stringify({ token: 'RST-BEARER', user: { id: 'u2', name: 'Ana' } }) }
      }
      if (opts.url.includes('/api/invite/preview?code=CONV123')) {
        return {
          status: 200,
          headers: {},
          data: JSON.stringify({ ok: true, code: 'CONV123', tenantName: 'Academia Força', studentName: 'Ana' })
        }
      }
      throw new Error('Unexpected URL: ' + opts.url)
    }

    const preview = await previewRemoteInvite(RIT_STUDENT_SERVER, 'conv123')
    expect(preview.tenantName).toBe('Academia Força')

    const regUser = await registerWithPassword(RIT_STUDENT_SERVER, {
      name: 'Ana',
      password: 'new-strong-password',
      code: 'conv123',
      email: 'ana@example.com'
    })
    expect(regUser).toEqual({ id: 'u2', name: 'Ana' })

    const rstUser = await resetPasswordAndConnect(RIT_STUDENT_SERVER, {
      name: 'Ana',
      code: 'rst456',
      next: 'reset-strong-password'
    })
    expect(rstUser).toEqual({ id: 'u2', name: 'Ana' })
    expect(h.saveRemoteFile).toHaveBeenLastCalledWith({
      mode: 'remote',
      base: RIT_STUDENT_SERVER,
      token: 'RST-BEARER',
      user: { id: 'u2', name: 'Ana' }
    })
  })
})
