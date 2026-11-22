// @vitest-environment happy-dom
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { _setLangState } from '../lib/i18n-core.js'

const h = vi.hoisted(() => ({
  openPortalNativeApp: vi.fn(),
  rememberStudentNativeMode: vi.fn(),
  previewRemoteInvite: vi.fn(),
  fetchRemoteConfig: vi.fn()
}))

vi.mock('../lib/rit-native.js', () => ({
  RIT_STUDENT_SERVER: 'https://app.treinerit.com.br',
  openPortalNativeApp: (...a) => h.openPortalNativeApp(...a),
  rememberStudentNativeMode: (...a) => h.rememberStudentNativeMode(...a),
  isRitDefaultServer: u => u === 'https://app.treinerit.com.br'
}))

vi.mock('../lib/remote.js', async () => {
  const actual = await vi.importActual('../lib/remote.js')
  return {
    ...actual,
    previewRemoteInvite: (...a) => h.previewRemoteInvite(...a),
    fetchRemoteConfig: (...a) => h.fetchRemoteConfig(...a)
  }
})

import MobileOnboarding from './MobileOnboarding.jsx'
import { MobilePasswordSignInSheet, MobileRegisterSheet } from '../components/MobilePasswordAuth.jsx'

let root, host
const type = (el, value) => act(() => {
  Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
const buttonByText = label => [...host.querySelectorAll('button')].find(b => b.textContent.includes(label))

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  _setLangState('en', null, null, null)
  localStorage.clear()
  useUI.setState({ sheets: [], toastMsg: '' })
  h.openPortalNativeApp.mockClear()
  h.rememberStudentNativeMode.mockClear()
  h.previewRemoteInvite.mockReset()
  h.fetchRemoteConfig.mockResolvedValue({ invite_only: false })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('MobileOnboarding & web-like mobile password auth', () => {
  it('renders password login, account creation, and Rit Painel without requiring pairing code first', () => {
    const chooseLocalMode = vi.fn()
    useStore.setState({ chooseLocalMode })
    act(() => root.render(<MobileOnboarding />))

    expect(buttonByText('Sign in with password')).toBeTruthy()
    expect(buttonByText('Create new profile')).toBeTruthy()
    expect(buttonByText('Rit Painel (Personal / Academia)')).toBeTruthy()
    expect(buttonByText('Use on this device')).toBeTruthy()
    expect(buttonByText('Connect to my server')).toBeTruthy()

    act(() => { buttonByText('Rit Painel (Personal / Academia)').click() })
    expect(h.openPortalNativeApp).toHaveBeenCalledWith('/login')

    act(() => { buttonByText('Use on this device').click() })
    expect(h.rememberStudentNativeMode).toHaveBeenCalled()
    expect(chooseLocalMode).toHaveBeenCalled()

    act(() => { buttonByText('Sign in with password').click() })
    expect(useUI.getState().sheets).toHaveLength(1)
  })

  it('signs in with password and supports reset-code mode', async () => {
    const signInMobileWithPassword = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('bad'), { status: 401, data: { code: 'bad-credentials' } }))
      .mockResolvedValueOnce({ id: 'u1', name: 'Carlos' })
    const resetMobilePassword = vi.fn().mockResolvedValueOnce({ id: 'u1', name: 'Carlos' })
    useStore.setState({ signInMobileWithPassword, resetMobilePassword })
    const close = vi.fn()

    act(() => root.render(<MobilePasswordSignInSheet close={close} />))
    const inputs = host.querySelectorAll('input')
    type(inputs[0], 'carlos@rit.com')
    type(inputs[1], 'wrong-pass-1')
    await act(async () => { buttonByText('Sign in').click() })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Wrong name, e-mail or password.')
    expect(close).not.toHaveBeenCalled()

    type(inputs[1], 'correct-pass-1')
    await act(async () => { buttonByText('Sign in').click() })
    expect(signInMobileWithPassword).toHaveBeenLastCalledWith(
      'https://app.treinerit.com.br',
      'carlos@rit.com',
      'correct-pass-1',
      expect.any(Function)
    )
    expect(close).toHaveBeenCalled()
    expect(useUI.getState().toastMsg).toBe('Welcome back, Carlos')

    close.mockClear()
    await act(async () => { buttonByText('Have a reset code from your admin?').click() })
    const resetInputs = host.querySelectorAll('input')
    type(resetInputs[0], 'carlos@rit.com')
    type(resetInputs[1], 'RST999')
    type(resetInputs[2], 'brandnewpass10')
    type(resetInputs[3], 'brandnewpass10')
    await act(async () => { buttonByText('Set password & sign in').click() })
    expect(resetMobilePassword).toHaveBeenCalledWith(
      'https://app.treinerit.com.br',
      { name: 'carlos@rit.com', code: 'RST999', next: 'brandnewpass10' },
      expect.any(Function)
    )
    expect(close).toHaveBeenCalled()
  })

  it('previews trainer invite code, auto-fills student name, and registers account', async () => {
    vi.useFakeTimers()
    h.previewRemoteInvite.mockResolvedValueOnce({
      ok: true,
      code: 'RIT500',
      tenantName: 'Studio Atlas',
      studentName: 'Mariana'
    })
    const registerMobileWithPassword = vi.fn().mockResolvedValueOnce({ id: 'u9', name: 'Mariana' })
    useStore.setState({ registerMobileWithPassword })
    const close = vi.fn()

    await act(async () => root.render(<MobileRegisterSheet close={close} />))
    const inviteInput = host.querySelector('input[name="invite-code"]')
    type(inviteInput, 'rit500')
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    expect(h.previewRemoteInvite).toHaveBeenCalledWith('https://app.treinerit.com.br', 'RIT500')
    expect(host.textContent).toContain('Código válido · Studio Atlas')
    const nameInput = host.querySelector('input[name="username"]')
    expect(nameInput.value).toBe('Mariana')

    type(host.querySelector('input[name="email"]'), 'mari@atlas.br')
    type(host.querySelector('input[name="new-password"]'), 'senhasegura123')
    type(host.querySelector('input[name="new-password-again"]'), 'senhasegura123')

    await act(async () => { buttonByText('Create profile').click() })
    expect(registerMobileWithPassword).toHaveBeenCalledWith(
      'https://app.treinerit.com.br',
      {
        name: 'Mariana',
        password: 'senhasegura123',
        code: 'RIT500',
        email: 'mari@atlas.br'
      },
      expect.any(Function)
    )
    expect(close).toHaveBeenCalled()
    expect(useUI.getState().toastMsg).toBe('Welcome, Mariana')
  })
})
