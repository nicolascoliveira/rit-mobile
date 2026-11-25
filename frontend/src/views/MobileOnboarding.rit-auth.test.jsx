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
  isRitDefaultServer: u => u === 'https://app.treinerit.com.br',
  getOrCreateDeviceId: () => 'dev_test_123456',
  getTrustedDeviceToken: () => ''
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
  it('renders exclusive student login/invite signup and Rit Painel without free offline or self-hosted bypasses', () => {
    act(() => root.render(<MobileOnboarding />))

    expect(buttonByText('Sign in with password')).toBeTruthy()
    expect(buttonByText('Criar conta com código de convite')).toBeTruthy()
    expect(buttonByText('Rit Painel (Personal / Academia)')).toBeTruthy()
    expect(buttonByText('Use on this device')).toBeUndefined()
    expect(buttonByText('Connect to my server')).toBeUndefined()
    expect(host.textContent).toContain('Acesso exclusivo para alunos de personal trainers e academias.')

    act(() => { buttonByText('Rit Painel (Personal / Academia)').click() })
    expect(h.openPortalNativeApp).toHaveBeenCalledWith('/login')

    act(() => { buttonByText('Sign in with password').click() })
    expect(h.rememberStudentNativeMode).toHaveBeenCalled()
    expect(useUI.getState().sheets).toHaveLength(1)
  })

  it('blocks registration without a trainer/gym invite code or with an invalid invite code', async () => {
    vi.useFakeTimers()
    const registerMobileWithPassword = vi.fn()
    useStore.setState({ registerMobileWithPassword })
    const close = vi.fn()

    await act(async () => root.render(<MobileRegisterSheet close={close} />))
    type(host.querySelector('input[name="username"]'), 'Visitante')
    type(host.querySelector('input[name="new-password"]'), 'senhasegura123')
    type(host.querySelector('input[name="new-password-again"]'), 'senhasegura123')

    await act(async () => { buttonByText('Create profile').click() })
    expect(registerMobileWithPassword).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('código de convite')
    expect(close).not.toHaveBeenCalled()

    h.previewRemoteInvite.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404, code: 'invite' }))
    type(host.querySelector('input[name="invite-code"]'), 'FAKE99')
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    await act(async () => { buttonByText('Create profile').click() })
    expect(registerMobileWithPassword).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Convite inválido')
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
      expect.any(Function),
      expect.objectContaining({
        requireEmailOtp: true,
        deviceId: 'dev_test_123456'
      })
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

  it('previews trainer invite code, enforces mandatory email + 6-digit OTP verification, and registers account', async () => {
    vi.useFakeTimers()
    h.previewRemoteInvite.mockResolvedValueOnce({
      ok: true,
      code: 'RIT500',
      tenantName: 'Studio Atlas',
      studentName: 'Mariana'
    })
    const sendMobileVerificationCode = vi.fn().mockResolvedValueOnce({
      ok: true,
      verificationRequired: true,
      challengeId: 'chal_reg_1',
      maskedEmail: 'm***i@atlas.br',
      maskedPhone: '+55 (11) *****-9988',
      hasPhone: true
    })
    const registerMobileWithPassword = vi.fn().mockResolvedValueOnce({ id: 'u9', name: 'Mariana' })
    useStore.setState({ registerMobileWithPassword, sendMobileVerificationCode })
    const close = vi.fn()

    await act(async () => root.render(<MobileRegisterSheet close={close} />))
    const inviteInput = host.querySelector('input[name="invite-code"]')
    type(inviteInput, 'rit500')
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })

    expect(h.previewRemoteInvite).toHaveBeenCalledWith('https://app.treinerit.com.br', 'RIT500')
    expect(host.textContent).toContain('Código válido · Studio Atlas')
    const nameInput = host.querySelector('input[name="username"]')
    expect(nameInput.value).toBe('Mariana')

    // Missing email must be rejected
    type(host.querySelector('input[name="new-password"]'), 'senhasegura123')
    type(host.querySelector('input[name="new-password-again"]'), 'senhasegura123')
    await act(async () => { buttonByText('Create profile').click() })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('e-mail')
    expect(sendMobileVerificationCode).not.toHaveBeenCalled()

    // Missing phone must be rejected
    type(host.querySelector('input[name="email"]'), 'mari@atlas.br')
    await act(async () => { buttonByText('Create profile').click() })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('telefone')
    expect(sendMobileVerificationCode).not.toHaveBeenCalled()

    const phoneInput = host.querySelector('input[name="phone"]')
    expect(phoneInput).toBeTruthy()
    type(phoneInput, '11988776655')
    expect(phoneInput.value).toBe('(11) 98877-6655')

    await act(async () => { buttonByText('Create profile').click() })
    expect(sendMobileVerificationCode).toHaveBeenCalledWith(
      'https://app.treinerit.com.br',
      expect.objectContaining({
        purpose: 'register',
        email: 'mari@atlas.br',
        phone: '(11) 98877-6655',
        requirePhone: true,
        name: 'Mariana',
        code: 'RIT500'
      })
    )

    // Now on the 6-digit OTP confirmation screen (Email primary + WhatsApp alternative)
    const otpInput = host.querySelector('input[name="otp-code"]')
    expect(otpInput).toBeTruthy()
    expect(buttonByText('Não recebeu? Enviar pelo WhatsApp')).toBeTruthy()
    expect(buttonByText('Reenviar código por e-mail')).toBeTruthy()

    type(otpInput, '654321')
    await act(async () => { buttonByText('Confirmar código e ativar conta').click() })

    expect(registerMobileWithPassword).toHaveBeenCalledWith(
      'https://app.treinerit.com.br',
      {
        name: 'Mariana',
        password: 'senhasegura123',
        code: 'RIT500',
        email: 'mari@atlas.br',
        phone: '(11) 98877-6655',
        requirePhone: true,
        challengeId: 'chal_reg_1',
        otpCode: '654321',
        deviceId: 'dev_test_123456',
        requireEmailOtp: true
      },
      expect.any(Function)
    )
    expect(close).toHaveBeenCalled()
    expect(useUI.getState().toastMsg).toBe('Welcome, Mariana')
  })

  it('supports self-service Forgot Password ("Esqueceu a senha?") via 6-digit OTP code', async () => {
    const sendMobileVerificationCode = vi.fn().mockResolvedValueOnce({
      ok: true,
      verificationRequired: true,
      purpose: 'reset',
      challengeId: 'chal_rst_99',
      maskedEmail: 'c***s@rit.com',
      maskedPhone: '(11) 9****-1122',
      hasPhone: true
    })
    const resetMobilePassword = vi.fn().mockResolvedValueOnce({ id: 'u1', name: 'Carlos' })
    useStore.setState({ sendMobileVerificationCode, resetMobilePassword })
    const close = vi.fn()

    act(() => root.render(<MobilePasswordSignInSheet close={close} />))
    await act(async () => { buttonByText('Esqueceu a senha?').click() })
    expect(host.textContent).toContain('Esqueceu a Senha?')

    type(host.querySelector('input[name="username"]'), 'carlos@rit.com')
    await act(async () => { buttonByText('Enviar código').click() })
    expect(sendMobileVerificationCode).toHaveBeenCalledWith(
      'https://app.treinerit.com.br',
      expect.objectContaining({
        purpose: 'reset',
        email: 'carlos@rit.com'
      })
    )

    type(host.querySelector('input[name="reset-code"]'), '789012')
    type(host.querySelector('input[name="new-password"]'), 'novasenha1234')
    type(host.querySelector('input[name="new-password-again"]'), 'novasenha1234')
    await act(async () => { buttonByText('Set password & sign in').click() })

    expect(resetMobilePassword).toHaveBeenCalledWith(
      'https://app.treinerit.com.br',
      expect.objectContaining({
        name: 'carlos@rit.com',
        code: '789012',
        next: 'novasenha1234',
        challengeId: 'chal_rst_99',
        otpCode: '789012',
        deviceId: 'dev_test_123456'
      }),
      expect.any(Function)
    )
    expect(close).toHaveBeenCalled()
  })

  it('redirects trainer/staff accounts automatically to Rit Painel when API returns staff-account (403)', async () => {
    vi.useFakeTimers()
    const staffErr = Object.assign(
      new Error('Esta conta é de Professor/Gestão. Redirecionando para o Rit Painel...'),
      { status: 403, data: { code: 'staff-account', portalUrl: 'https://painel.treinerit.com.br/login' } }
    )
    const signInMobileWithPassword = vi.fn().mockRejectedValueOnce(staffErr)
    useStore.setState({ signInMobileWithPassword })
    const close = vi.fn()

    act(() => root.render(<MobilePasswordSignInSheet close={close} />))
    const inputs = host.querySelectorAll('input')
    type(inputs[0], 'prof@academia.com')
    type(inputs[1], 'SenhaProf12345!')
    await act(async () => { buttonByText('Sign in').click() })

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Professor/Gestão')
    expect(useUI.getState().toastMsg).toContain('Rit Painel')
    expect(h.openPortalNativeApp).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(650) })
    expect(close).toHaveBeenCalled()
    expect(h.openPortalNativeApp).toHaveBeenCalledWith('/login')
  })
})
