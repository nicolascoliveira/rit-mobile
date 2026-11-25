// Native mobile & full-screen student authentication (Refined Dribbble #26399338 design):
// - Sign in with mandatory E-mail + Password (+ 6-digit OTP on new/untrusted device)
// - Self-service Forgot Password ("Esqueceu a senha?") via 6-digit OTP on WhatsApp & E-mail
// - Student Registration with Professor's Invite Code + Name + E-mail + 2 Password fields + 6-digit OTP
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { MIN_PASSWORD, looksLikeEmail, looksLikePhone, formatPhoneInput, passwordError, describeOtpChannel } from './PasswordAuth.jsx'
import {
  rememberStudentNativeMode,
  openPortalNativeApp,
  RIT_STUDENT_SERVER,
  getOrCreateDeviceId,
  getTrustedDeviceToken
} from '../lib/rit-native.js'
import { useSheetKeyboard } from '../lib/use-sheet-keyboard.js'
import { askAddDeviceData } from '../sheets.jsx'
import Icon from './Icon.jsx'

const MOBILE_SHEET_SETTLE_MS = 350
const FIELD_ATTRS = { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }

function readRememberedUsername() {
  try {
    if (typeof localStorage === 'undefined') return ''
    return localStorage.getItem('rit_last_username') || ''
  } catch {
    return ''
  }
}

export function RitAuthTopBar({ onBack, title }) {
  return (
    <div className="rit-auth-topbar">
      {onBack ? (
        <button
          type="button"
          className="rit-auth-back-btn"
          onClick={onBack}
          aria-label="Voltar"
          title="Voltar"
        >
          <Icon name="arrowLeft" size={20} />
        </button>
      ) : <div style={{ width: 36 }} />}
      {title ? (
        <span style={{ fontSize: 14, fontWeight: 500, color: 'rgba(245, 246, 247, 0.58)' }}>{title}</span>
      ) : null}
    </div>
  )
}

export function RitBrandMark({ logoUrl, height = 28 }) {
  return (
    <div className="rit-auth-brand">
      <img
        src={logoUrl || './rit-logo.png'}
        alt="Rit"
        style={{ height, width: 'auto', maxWidth: 160, objectFit: 'contain', display: 'block' }}
      />
    </div>
  )
}

export const RitAuthOrb = RitBrandMark

export function RitOtpBoxes({ value, onChange, onFocus, inputRef }) {
  const internalRef = useRef(null)
  const ref = inputRef || internalRef
  const clean = String(value || '').replace(/\D/g, '').slice(0, 6)
  const slots = Array.from({ length: 6 }, (_, i) => clean[i] || '')

  return (
    <div
      style={{ position: 'relative', cursor: 'text' }}
      onClick={() => ref.current?.focus()}
    >
      <div className="rit-otp-slots" aria-hidden="true">
        {slots.map((digit, idx) => {
          const isCurrent = idx === clean.length || (clean.length === 6 && idx === 5)
          return (
            <div
              key={idx}
              className={`rit-otp-slot${digit ? ' filled' : ''}${isCurrent ? ' active' : ''}`}
            >
              {digit || '·'}
            </div>
          )
        })}
      </div>
      <input
        ref={ref}
        className="rit-auth-input"
        name="otp-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="000000"
        maxLength={6}
        value={clean}
        onFocus={onFocus}
        onChange={e => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        {...FIELD_ATTRS}
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0,
          width: '100%',
          height: '100%',
          cursor: 'text',
          letterSpacing: '.3em'
        }}
      />
    </div>
  )
}

export function PasswordField({
  inputRef,
  value,
  onChange,
  placeholder,
  name,
  autoComplete = 'current-password',
  onFocus
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="rit-auth-input-wrap">
      <input
        ref={inputRef}
        className="rit-auth-input"
        type={show ? 'text' : 'password'}
        name={name}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onFocus={onFocus}
        onChange={onChange}
        style={{ paddingRight: 46 }}
      />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        className={`rit-auth-eye-btn${show ? ' active' : ''}`}
        title={show ? t('Hide password') : t('Show password')}
        aria-label={show ? t('Hide password') : t('Show password')}
      >
        <Icon name={show ? 'eyeOff' : 'eye'} size={19} />
      </button>
    </div>
  )
}

export function MobilePasswordSignInSheet({
  close,
  initialUrl = RIT_STUDENT_SERVER,
  initialMode = 'signin',
  onSwitchToRegister = null,
  logoUrl = ''
}) {
  const signInMobileWithPassword = useStore(s => s.signInMobileWithPassword)
  const resetMobilePassword = useStore(s => s.resetMobilePassword)
  const sendMobileVerificationCode = useStore(s => s.sendMobileVerificationCode)
  const targetUrl = initialUrl || RIT_STUDENT_SERVER
  // modes: 'signin' | 'forgot' | 'reset'
  const [mode, setMode] = useState(initialMode || 'signin')
  const [name, setName] = useState(readRememberedUsername)
  const [pw, setPw] = useState('')
  const [rememberMe, setRememberMe] = useState(true)
  const [code, setCode] = useState('')
  const [next, setNext] = useState('')
  const [againPw, setAgainPw] = useState('')
  const [otpState, setOtpState] = useState(null)
  const [otpCode, setOtpCode] = useState('')
  const [forgotOtpState, setForgotOtpState] = useState(null)
  const [resendingChannel, setResendingChannel] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const nameRef = useRef(null)
  const pwRef = useRef(null)
  const onFocus = useSheetKeyboard(nameRef, true, { reveal: true })

  useEffect(() => {
    const tm = setTimeout(() => {
      if (name.trim() && mode === 'signin') pwRef.current?.focus()
      else nameRef.current?.focus()
    }, MOBILE_SHEET_SETTLE_MS)
    return () => clearTimeout(tm)
  }, [mode]) // eslint-disable-line react-hooks/exhaustive-deps

  const reset = mode === 'reset'
  const forgot = mode === 'forgot'

  const handleResendOtp = async (channel, purpose = 'login') => {
    const activeChallenge = purpose === 'reset' ? forgotOtpState : otpState
    if (busy || resendingChannel || !activeChallenge || typeof sendMobileVerificationCode !== 'function') return
    setResendingChannel(channel)
    setErr('')
    try {
      const res = await sendMobileVerificationCode(targetUrl, {
        purpose,
        email: name.trim(),
        ...(purpose === 'login' ? { password: pw, challengeId: activeChallenge.challengeId } : {}),
        channel
      })
      if (res?.challengeId) {
        if (purpose === 'reset') setForgotOtpState(res)
        else setOtpState(res)
        useUI.getState().toast(
          channel === 'whatsapp'
            ? 'Código reenviado para seu WhatsApp!'
            : 'Código reenviado para seu e-mail!'
        )
      }
    } catch (e) {
      setErr(passwordError(e))
    } finally {
      setResendingChannel('')
    }
  }

  const handleRequestForgotCode = async ev => {
    ev.preventDefault()
    if (busy) return
    const n = name.trim()
    if (!n) { setErr('Informe seu e-mail.'); return }
    if (!looksLikeEmail(n)) { setErr(t('That is not an e-mail address.')); return }
    if (typeof sendMobileVerificationCode !== 'function') {
      setMode('reset')
      return
    }
    setBusy(true)
    setErr('')
    try {
      const res = await sendMobileVerificationCode(targetUrl, {
        purpose: 'reset',
        email: n,
        channel: 'auto'
      })
      if (res?.challengeId) {
        setForgotOtpState(res)
        setCode('')
        setMode('reset')
      }
    } catch (e) {
      setErr(passwordError(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = async ev => {
    ev.preventDefault()
    if (busy) return
    const n = name.trim()

    if (!reset && !forgot && otpState) {
      const cleanOtp = otpCode.replace(/\D/g, '')
      if (cleanOtp.length !== 6) {
        setErr('Digite o código de verificação de 6 dígitos.')
        return
      }
      setBusy(true)
      setErr('')
      try {
        const u = await signInMobileWithPassword(targetUrl, n, pw, askAddDeviceData, {
          requireEmailOtp: true,
          deviceId: getOrCreateDeviceId(),
          challengeId: otpState.challengeId,
          otpCode: cleanOtp
        })
        rememberStudentNativeMode()
        close?.()
        useUI.getState().toast(t('Welcome back, {0}', u?.name || n))
      } catch (e) {
        const msg = passwordError(e)
        setErr(msg)
        if (e?.data?.code === 'staff-account') {
          useUI.getState().toast(msg)
          setTimeout(() => {
            close?.()
            openPortalNativeApp('/login')
          }, 600)
        }
      } finally {
        setBusy(false)
      }
      return
    }

    const bad = !n ? 'Informe seu e-mail.'
      : !looksLikeEmail(n) ? t('That is not an e-mail address.')
      : !reset && !pw ? t('Enter your password.')
      : reset && !code.trim() ? t('Enter the reset code.')
      : reset && [...next].length < MIN_PASSWORD ? t('Use at least {0} characters.', MIN_PASSWORD)
      : reset && next !== againPw ? t('The two passwords are not the same.')
      : ''
    if (bad) { setErr(bad); return }
    setBusy(true)
    setErr('')
    try {
      const resetPayload = forgotOtpState?.challengeId
        ? {
            name: n,
            code: code.trim(),
            next,
            challengeId: forgotOtpState.challengeId,
            otpCode: code.trim(),
            deviceId: getOrCreateDeviceId()
          }
        : { name: n, code: code.trim(), next }
      const res = reset
        ? await resetMobilePassword(targetUrl, resetPayload, askAddDeviceData)
        : await signInMobileWithPassword(targetUrl, n, pw, askAddDeviceData, {
            requireEmailOtp: true,
            deviceId: getOrCreateDeviceId(),
            trustedDeviceToken: typeof getTrustedDeviceToken === 'function' ? getTrustedDeviceToken(n) : ''
          })
      if (res?.verificationRequired) {
        setOtpState(res)
        setOtpCode('')
        return
      }
      if (!rememberMe) {
        try { localStorage.removeItem('rit_last_username') } catch { /* ignore */ }
      }
      rememberStudentNativeMode()
      close?.()
      useUI.getState().toast(t('Welcome back, {0}', res?.name || n))
    } catch (e) {
      const msg = passwordError(e)
      setErr(msg)
      if (e?.data?.code === 'staff-account') {
        useUI.getState().toast(msg)
        setTimeout(() => {
          close?.()
          openPortalNativeApp('/login')
        }, 600)
      }
    } finally {
      setBusy(false)
    }
  }

  // Screen: 6-Digit OTP Verification on New/Untrusted Device
  if (!reset && !forgot && otpState) {
    const { activeChannel, destinationText } = describeOtpChannel(otpState)
    return (
      <div className="kb-lift rit-auth-sheet">
        <RitAuthTopBar onBack={() => { setOtpState(null); setOtpCode(''); setErr('') }} />
        <RitBrandMark logoUrl={logoUrl} />
        <div className="rit-auth-header">
          <h3 className="rit-auth-title">Verifique seu Acesso</h3>
          <p className="rit-auth-subtitle">
            Enviamos um código de 6 dígitos {destinationText} para confirmar este aparelho.
          </p>
        </div>
        <form className="rit-auth-form" onSubmit={submit} noValidate>
          <div className="rit-auth-field">
            <label className="rit-auth-label">
              <span>Código de 6 dígitos<span className="rit-auth-label-req">*</span></span>
            </label>
            <RitOtpBoxes value={otpCode} onChange={setOtpCode} onFocus={onFocus} />
          </div>
          {err && <div role="alert" className="rit-auth-alert">{err}</div>}
          <button type="submit" className="rit-auth-pill" disabled={busy}>
            {busy ? t('Connecting…') : 'Confirmar código e entrar'}
          </button>
        </form>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
          {activeChannel !== 'whatsapp' && otpState.hasPhone && (
            <button
              type="button"
              className="rit-auth-pill-secondary"
              disabled={busy || Boolean(resendingChannel)}
              onClick={() => handleResendOtp('whatsapp', 'login')}
            >
              {resendingChannel === 'whatsapp' ? 'Enviando pelo WhatsApp…' : 'Não recebeu? Enviar pelo WhatsApp'}
            </button>
          )}
          {activeChannel === 'whatsapp' && (
            <button
              type="button"
              className="rit-auth-pill-secondary"
              disabled={busy || Boolean(resendingChannel)}
              onClick={() => handleResendOtp('email', 'login')}
            >
              {resendingChannel === 'email' ? 'Enviando por e-mail…' : 'Não recebeu? Enviar por e-mail'}
            </button>
          )}
          <button
            type="button"
            className="rit-auth-pill-secondary"
            disabled={busy || Boolean(resendingChannel)}
            onClick={() => handleResendOtp(activeChannel === 'whatsapp' ? 'whatsapp' : 'email', 'login')}
          >
            {resendingChannel
              ? 'Reenviando código…'
              : activeChannel === 'whatsapp'
                ? 'Reenviar código pelo WhatsApp'
                : 'Reenviar código por e-mail'}
          </button>
        </div>
      </div>
    )
  }

  // Screen: "Forgot Password?" Step 1 (Dribbble Screen 3)
  if (forgot) {
    return (
      <div className="kb-lift rit-auth-sheet">
        <RitAuthTopBar onBack={() => { setErr(''); setMode('signin') }} />
        <RitBrandMark logoUrl={logoUrl} />
        <div className="rit-auth-header">
          <h3 className="rit-auth-title">Esqueceu a Senha?</h3>
          <p className="rit-auth-subtitle">
            Digite seu e-mail cadastrado e enviaremos um código de 6 dígitos para o seu e-mail (com opção de envio pelo WhatsApp se preferir).
          </p>
        </div>
        <form className="rit-auth-form" onSubmit={handleRequestForgotCode} noValidate>
          <div className="rit-auth-field">
            <label className="rit-auth-label">
              <span>Endereço de e-mail<span className="rit-auth-label-req">*</span></span>
            </label>
            <input
              ref={nameRef}
              className="rit-auth-input"
              type="email"
              inputMode="email"
              name="username"
              autoComplete="username"
              placeholder="exemplo@gmail.com"
              maxLength={254}
              value={name}
              onFocus={onFocus}
              onChange={e => setName(e.target.value)}
              {...FIELD_ATTRS}
            />
          </div>
          {err && <div role="alert" className="rit-auth-alert">{err}</div>}
          <button type="submit" className="rit-auth-pill" disabled={busy}>
            {busy ? 'Enviando código…' : 'Enviar código'}
          </button>
        </form>
        <div className="rit-auth-footer">
          Já possui um código de recuperação?{' '}
          <button
            type="button"
            className="rit-auth-link-btn accent"
            onClick={() => { setErr(''); setMode('reset') }}
          >
            Digitar código
          </button>
          <div style={{ marginTop: 10 }}>
            Lembrou a senha?{' '}
            <button
              type="button"
              className="rit-auth-link-btn"
              onClick={() => { setErr(''); setMode('signin') }}
            >
              Voltar para o Login
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Screen: Sign In ("Welcome Back!") or Reset Password Step 2
  return (
    <div className="kb-lift rit-auth-sheet">
      <RitAuthTopBar
        onBack={() => {
          setErr('')
          if (reset) { setMode('signin'); setForgotOtpState(null) }
          else close?.()
        }}
      />
      <RitBrandMark logoUrl={logoUrl} />
      <div className="rit-auth-header">
        <h3 className="rit-auth-title">
          {reset ? t('Reset your password') : 'Bem-vindo de volta!'}
        </h3>
        <p className="rit-auth-subtitle">
          {reset
            ? (forgotOtpState
                ? `Digite o código de 6 dígitos enviado${forgotOtpState.maskedPhone ? ` ao WhatsApp (${forgotOtpState.maskedPhone})` : ''} e escolha sua nova senha.`
                : t('Enter the code your admin gave you and choose a new password. It signs you out everywhere else.'))
            : 'Entre com seu e-mail e senha para acessar seus treinos personalizados feitos para você.'}
        </p>
      </div>

      <form className="rit-auth-form" onSubmit={submit} noValidate>
        <div className="rit-auth-field">
          <label className="rit-auth-label">
            <span>Endereço de e-mail<span className="rit-auth-label-req">*</span></span>
          </label>
          <input
            ref={nameRef}
            className="rit-auth-input"
            type="email"
            inputMode="email"
            name="username"
            autoComplete="username"
            placeholder="exemplo@gmail.com"
            maxLength={254}
            value={name}
            onFocus={onFocus}
            onChange={e => setName(e.target.value)}
            {...FIELD_ATTRS}
          />
        </div>

        {reset ? (
          <>
            <div className="rit-auth-field">
              <label className="rit-auth-label">
                <span>Código de verificação<span className="rit-auth-label-req">*</span></span>
              </label>
              <input
                className="rit-auth-input"
                name="reset-code"
                autoComplete="one-time-code"
                placeholder={forgotOtpState ? '000000' : t('Reset code')}
                maxLength={20}
                value={code}
                onFocus={onFocus}
                onChange={e => setCode(e.target.value.toUpperCase())}
                {...FIELD_ATTRS}
                style={{ letterSpacing: '.18em', fontWeight: 700, textAlign: 'center' }}
              />
            </div>
            <div className="rit-auth-field">
              <label className="rit-auth-label">
                <span>Nova senha<span className="rit-auth-label-req">*</span></span>
              </label>
              <PasswordField
                inputRef={pwRef}
                name="new-password"
                autoComplete="new-password"
                placeholder={t('New password')}
                value={next}
                onFocus={onFocus}
                onChange={e => setNext(e.target.value)}
              />
            </div>
            <div className="rit-auth-field">
              <label className="rit-auth-label">
                <span>Confirmar nova senha<span className="rit-auth-label-req">*</span></span>
              </label>
              <PasswordField
                name="new-password-again"
                autoComplete="new-password"
                placeholder={t('Repeat the password')}
                value={againPw}
                onFocus={onFocus}
                onChange={e => setAgainPw(e.target.value)}
              />
            </div>
            {forgotOtpState && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {forgotOtpState.hasPhone && (
                  <button
                    type="button"
                    className="rit-auth-pill-secondary"
                    style={{ flex: 1, minHeight: 44, fontSize: 14 }}
                    disabled={busy || Boolean(resendingChannel)}
                    onClick={() => handleResendOtp('whatsapp', 'reset')}
                  >
                    Reenviar WhatsApp
                  </button>
                )}
                <button
                  type="button"
                  className="rit-auth-pill-secondary"
                  style={{ flex: 1, minHeight: 44, fontSize: 14 }}
                  disabled={busy || Boolean(resendingChannel)}
                  onClick={() => handleResendOtp('email', 'reset')}
                >
                  Reenviar E-mail
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="rit-auth-field">
              <label className="rit-auth-label">
                <span>Senha<span className="rit-auth-label-req">*</span></span>
              </label>
              <PasswordField
                inputRef={pwRef}
                name="password"
                autoComplete="current-password"
                placeholder={t('Password')}
                value={pw}
                onFocus={onFocus}
                onChange={e => setPw(e.target.value)}
              />
            </div>
            <div className="rit-auth-row-between">
              <label className="rit-auth-check-label">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={e => setRememberMe(e.target.checked)}
                />
                <span>Lembrar de mim</span>
              </label>
              <button
                type="button"
                className="rit-auth-link-btn"
                onClick={() => { setErr(''); setMode('forgot') }}
              >
                Esqueceu a senha?
              </button>
            </div>
          </>
        )}

        {err && <div role="alert" className="rit-auth-alert">{err}</div>}

        <button type="submit" className="rit-auth-pill" disabled={busy}>
          {busy ? t('Connecting…') : reset ? t('Set password & sign in') : t('Sign in')}
        </button>
      </form>

      <div className="rit-auth-footer">
        <button
          type="button"
          className="rit-auth-link-btn"
          style={{ color: 'rgba(245, 246, 247, 0.65)', fontWeight: 500 }}
          disabled={busy}
          onClick={() => { setErr(''); setMode(reset ? 'signin' : 'reset') }}
        >
          {reset ? t('Sign in with password') : t('Have a reset code from your admin?')}
        </button>
        {onSwitchToRegister && !reset && (
          <div style={{ marginTop: 12 }}>
            Ainda não tem uma conta?{' '}
            <button
              type="button"
              className="rit-auth-link-btn accent"
              onClick={onSwitchToRegister}
            >
              Criar conta
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export function MobileRegisterSheet({
  close,
  initialUrl = RIT_STUDENT_SERVER,
  initialCode = '',
  requireInvite = true,
  onSwitchToSignIn = null,
  logoUrl = ''
}) {
  const registerMobileWithPassword = useStore(s => s.registerMobileWithPassword)
  const sendMobileVerificationCode = useStore(s => s.sendMobileVerificationCode)
  const targetUrl = initialUrl || RIT_STUDENT_SERVER
  const cleanInitialCode = String(initialCode || '').trim().toUpperCase()
  const [code, setCode] = useState(cleanInitialCode)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [inviteOnly, setInviteOnly] = useState(Boolean(requireInvite))
  const [inviteInfo, setInviteInfo] = useState({ status: 'idle', tenantName: '', studentName: '', studentEmail: '' })
  const [otpState, setOtpState] = useState(null)
  const [otpCode, setOtpCode] = useState('')
  const [resendingChannel, setResendingChannel] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const codeRef = useRef(null)
  const nameRef = useRef(null)
  const onFocus = useSheetKeyboard(codeRef, true, { reveal: true })

  useEffect(() => {
    let active = true
    if (!requireInvite) {
      import('../lib/remote.js')
        .then(({ fetchRemoteConfig }) => fetchRemoteConfig(targetUrl))
        .then(cfg => { if (active && cfg?.invite_only) setInviteOnly(true) })
        .catch(() => {})
    }
    const tm = setTimeout(() => {
      if (cleanInitialCode) nameRef.current?.focus()
      else codeRef.current?.focus()
    }, MOBILE_SHEET_SETTLE_MS)
    return () => { active = false; clearTimeout(tm) }
  }, [targetUrl, requireInvite, cleanInitialCode])

  useEffect(() => {
    const clean = code.trim().toUpperCase()
    if (clean.length < 5) {
      setInviteInfo({ status: 'idle', tenantName: '', studentName: '', studentEmail: '' })
      return
    }
    let active = true
    setInviteInfo({ status: 'checking', tenantName: '', studentName: '', studentEmail: '' })
    const tm = setTimeout(async () => {
      try {
        const { previewRemoteInvite } = await import('../lib/remote.js')
        const data = await previewRemoteInvite(targetUrl, clean)
        if (!active) return
        if (data?.ok) {
          setInviteInfo({
            status: 'valid',
            tenantName: data.tenantName || '',
            studentName: data.studentName || '',
            studentEmail: data.studentEmail || ''
          })
          if (data.studentName) setName(prev => prev || data.studentName)
          if (data.studentEmail) setEmail(prev => prev || data.studentEmail)
        } else {
          setInviteInfo({ status: 'idle', tenantName: '', studentName: '', studentEmail: '' })
        }
      } catch (e) {
        if (!active) return
        if (e?.status === 400 || e?.status === 404 || e?.code === 'invite') {
          setInviteInfo({ status: 'invalid', tenantName: '', studentName: '', studentEmail: '' })
        } else {
          setInviteInfo({ status: 'idle', tenantName: '', studentName: '', studentEmail: '' })
        }
      }
    }, 250)
    return () => { active = false; clearTimeout(tm) }
  }, [code, targetUrl])

  const handleResendOtp = async channel => {
    if (busy || resendingChannel || typeof sendMobileVerificationCode !== 'function') return
    setResendingChannel(channel)
    setErr('')
    try {
      const res = await sendMobileVerificationCode(targetUrl, {
        purpose: 'register',
        email: email.trim(),
        phone: phone.trim(),
        requirePhone: true,
        name: name.trim(),
        password: pw,
        code: code.trim().toUpperCase(),
        channel
      })
      if (res?.challengeId) {
        setOtpState(res)
        useUI.getState().toast(
          channel === 'whatsapp'
            ? 'Código reenviado para seu WhatsApp!'
            : 'Código reenviado para seu e-mail!'
        )
      }
    } catch (e) {
      setErr(passwordError(e))
    } finally {
      setResendingChannel('')
    }
  }

  const submit = async ev => {
    ev.preventDefault()
    if (busy) return
    const n = name.trim()
    const mail = email.trim()
    const tel = phone.trim()
    const cleanCode = code.trim().toUpperCase()

    if (otpState) {
      const cleanOtp = otpCode.replace(/\D/g, '')
      if (cleanOtp.length !== 6) {
        setErr('Digite o código de verificação de 6 dígitos.')
        return
      }
      setBusy(true)
      setErr('')
      try {
        const u = await registerMobileWithPassword(
          targetUrl,
          {
            name: n,
            password: pw,
            code: cleanCode,
            email: mail,
            phone: tel,
            requirePhone: true,
            challengeId: otpState.challengeId,
            otpCode: cleanOtp,
            deviceId: typeof getOrCreateDeviceId === 'function' ? getOrCreateDeviceId() : '',
            requireEmailOtp: true
          },
          askAddDeviceData
        )
        rememberStudentNativeMode()
        close?.()
        useUI.getState().toast(t('Welcome, {0}', u?.name || n))
      } catch (e) {
        const msg = passwordError(e)
        setErr(msg)
        if (e?.data?.code === 'staff-account') {
          useUI.getState().toast(msg)
          setTimeout(() => {
            close?.()
            openPortalNativeApp('/login')
          }, 600)
        }
      } finally {
        setBusy(false)
      }
      return
    }

    const bad = inviteOnly && !cleanCode ? 'Informe o código de convite do seu personal ou academia.'
      : inviteInfo.status === 'invalid' ? 'Convite inválido, expirado ou já utilizado.'
      : !n ? t('Enter a name')
      : !mail ? 'Informe seu endereço de e-mail.'
      : !looksLikeEmail(mail) ? t('That is not an e-mail address.')
      : !tel ? 'Informe seu número de telefone (WhatsApp) com DDD.'
      : !looksLikePhone(tel) ? 'Informe um número de telefone (WhatsApp) válido com DDD.'
      : [...String(pw || '')].length < MIN_PASSWORD ? t('Use at least {0} characters.', MIN_PASSWORD)
      : pw !== again ? t('The two passwords are not the same.')
      : ''
    if (bad) { setErr(bad); return }
    setBusy(true)
    setErr('')
    try {
      if (typeof sendMobileVerificationCode === 'function') {
        const res = await sendMobileVerificationCode(targetUrl, {
          purpose: 'register',
          email: mail,
          phone: tel,
          requirePhone: true,
          name: n,
          password: pw,
          code: cleanCode,
          channel: 'auto'
        })
        if (res?.verificationRequired && res?.challengeId) {
          setOtpState(res)
          setOtpCode('')
          return
        }
      }
      const u = await registerMobileWithPassword(
        targetUrl,
        { name: n, password: pw, code: cleanCode, email: mail, phone: tel, requirePhone: true },
        askAddDeviceData
      )
      rememberStudentNativeMode()
      close?.()
      useUI.getState().toast(t('Welcome, {0}', u?.name || n))
    } catch (e) {
      setErr(passwordError(e))
    } finally {
      setBusy(false)
    }
  }

  // Screen: 6-Digit OTP Verification Step
  if (otpState) {
    const { activeChannel, destinationText } = describeOtpChannel(otpState)
    return (
      <div className="kb-lift rit-auth-sheet">
        <RitAuthTopBar onBack={() => { setOtpState(null); setOtpCode(''); setErr('') }} />
        <RitBrandMark logoUrl={logoUrl} />
        <div className="rit-auth-header">
          <h3 className="rit-auth-title">Confirme seu Código</h3>
          <p className="rit-auth-subtitle">
            Enviamos um código de 6 dígitos {destinationText}. Digite-o abaixo para ativar sua conta.
          </p>
        </div>
        <form className="rit-auth-form" onSubmit={submit} noValidate>
          <div className="rit-auth-field">
            <label className="rit-auth-label">
              <span>Código de 6 dígitos<span className="rit-auth-label-req">*</span></span>
            </label>
            <RitOtpBoxes value={otpCode} onChange={setOtpCode} onFocus={onFocus} />
          </div>
          {err && <div role="alert" className="rit-auth-alert">{err}</div>}
          <button type="submit" className="rit-auth-pill" disabled={busy}>
            {busy ? t('Connecting…') : 'Confirmar código e ativar conta'}
          </button>
        </form>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
          {activeChannel !== 'whatsapp' && otpState.hasPhone && (
            <button
              type="button"
              className="rit-auth-pill-secondary"
              disabled={busy || Boolean(resendingChannel)}
              onClick={() => handleResendOtp('whatsapp')}
            >
              {resendingChannel === 'whatsapp' ? 'Enviando pelo WhatsApp…' : 'Não recebeu? Enviar pelo WhatsApp'}
            </button>
          )}
          {activeChannel === 'whatsapp' && (
            <button
              type="button"
              className="rit-auth-pill-secondary"
              disabled={busy || Boolean(resendingChannel)}
              onClick={() => handleResendOtp('email')}
            >
              {resendingChannel === 'email' ? 'Enviando por e-mail…' : 'Não recebeu? Enviar por e-mail'}
            </button>
          )}
          <button
            type="button"
            className="rit-auth-pill-secondary"
            disabled={busy || Boolean(resendingChannel)}
            onClick={() => handleResendOtp(activeChannel === 'whatsapp' ? 'whatsapp' : 'email')}
          >
            {resendingChannel
              ? 'Reenviando código…'
              : activeChannel === 'whatsapp'
                ? 'Reenviar código pelo WhatsApp'
                : 'Reenviar código por e-mail'}
          </button>
        </div>
      </div>
    )
  }

  // Screen: Create Account (Refined Dribbble #26399338 with Invite Code + 2 Password fields)
  return (
    <div className="kb-lift rit-auth-sheet">
      <RitAuthTopBar onBack={close} />
      <RitBrandMark logoUrl={logoUrl} />
      <div className="rit-auth-header">
        <h3 className="rit-auth-title">Crie sua Conta</h3>
        <p className="rit-auth-subtitle">
          Ative o convite enviado pelo seu treinador ou academia para acessar sua ficha de treinos.
        </p>
      </div>

      <form className="rit-auth-form" onSubmit={submit} noValidate>
        <div className="rit-auth-field">
          <label className="rit-auth-label">
            <span>Código de Convite do Professor{inviteOnly && <span className="rit-auth-label-req">*</span>}</span>
          </label>
          <input
            ref={codeRef}
            className="rit-auth-input"
            name="invite-code"
            placeholder={inviteOnly ? 'Ex: RIT2026' : t('Invite code')}
            maxLength={40}
            value={code}
            onFocus={onFocus}
            onChange={e => setCode(e.target.value.toUpperCase())}
            {...FIELD_ATTRS}
            style={{ letterSpacing: '.08em', fontWeight: 500 }}
          />
          <div
            className={`rit-auth-helper${inviteInfo.status === 'valid' ? ' valid' : inviteInfo.status === 'invalid' ? ' invalid' : ''}`}
          >
            {inviteInfo.status === 'checking'
              ? 'Verificando código…'
              : inviteInfo.status === 'valid'
                ? `Código válido${inviteInfo.tenantName ? ` · ${inviteInfo.tenantName}` : ''}`
                : inviteInfo.status === 'invalid'
                  ? 'Convite inválido, expirado ou já utilizado.'
                  : inviteOnly
                    ? 'Peça o código de convite ao seu personal trainer ou academia.'
                    : 'Informe o código recebido do seu personal ou academia.'}
          </div>
        </div>

        <div className="rit-auth-field">
          <label className="rit-auth-label">
            <span>Nome completo<span className="rit-auth-label-req">*</span></span>
          </label>
          <input
            ref={nameRef}
            className="rit-auth-input"
            name="username"
            autoComplete="username"
            placeholder={t('Your name')}
            maxLength={40}
            value={name}
            onFocus={onFocus}
            onChange={e => setName(e.target.value)}
            {...FIELD_ATTRS}
          />
        </div>

        <div className="rit-auth-field">
          <label className="rit-auth-label">
            <span>Endereço de e-mail<span className="rit-auth-label-req">*</span></span>
          </label>
          <input
            className="rit-auth-input"
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            placeholder="exemplo@gmail.com"
            maxLength={254}
            value={email}
            onFocus={onFocus}
            onChange={e => setEmail(e.target.value)}
            {...FIELD_ATTRS}
          />
        </div>

        <div className="rit-auth-field">
          <label className="rit-auth-label">
            <span>Telefone (WhatsApp)<span className="rit-auth-label-req">*</span></span>
          </label>
          <input
            className="rit-auth-input"
            type="tel"
            name="phone"
            autoComplete="tel"
            inputMode="tel"
            placeholder="(11) 99999-9999"
            maxLength={20}
            value={phone}
            onFocus={onFocus}
            onChange={e => setPhone(formatPhoneInput(e.target.value))}
            {...FIELD_ATTRS}
          />
          <div className="rit-auth-helper">
            Usado para enviar seu código de verificação e avisos do treinador.
          </div>
        </div>

        <div className="rit-auth-field">
          <label className="rit-auth-label">
            <span>Senha<span className="rit-auth-label-req">*</span></span>
          </label>
          <PasswordField
            name="new-password"
            autoComplete="new-password"
            placeholder={t('Password')}
            value={pw}
            onFocus={onFocus}
            onChange={e => setPw(e.target.value)}
          />
        </div>

        <div className="rit-auth-field">
          <label className="rit-auth-label">
            <span>Confirmar senha<span className="rit-auth-label-req">*</span></span>
          </label>
          <PasswordField
            name="new-password-again"
            autoComplete="new-password"
            placeholder={t('Repeat the password')}
            value={again}
            onFocus={onFocus}
            onChange={e => setAgain(e.target.value)}
          />
        </div>

        {err && <div role="alert" className="rit-auth-alert">{err}</div>}

        <button type="submit" className="rit-auth-pill" disabled={busy}>
          {busy ? t('Connecting…') : t('Create profile')}
        </button>
      </form>

      {onSwitchToSignIn && (
        <div className="rit-auth-footer">
          Já tem uma conta?{' '}
          <button
            type="button"
            className="rit-auth-link-btn accent"
            onClick={onSwitchToSignIn}
          >
            Entrar
          </button>
        </div>
      )}
    </div>
  )
}

export const openMobileSignIn = (opts = {}) =>
  useUI.getState().openSheet(close => <MobilePasswordSignInSheet close={close} {...opts} />)

export const openMobileRegister = (opts = {}) =>
  useUI.getState().openSheet(close => <MobileRegisterSheet close={close} {...opts} />)
