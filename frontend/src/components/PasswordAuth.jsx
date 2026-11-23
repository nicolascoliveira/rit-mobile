// Name-and-password sign-in next to passkeys (#118), on an instance that offers it
// (GET /api/config → `password_login`). Everything a password needs on screen lives here:
// signing in, redeeming the one-time code an admin hands out, creating a profile with a
// password, and the Settings row that sets, changes or removes one — and the "confirm it is you"
// step (ProveOwner) that Settings asks for before a way in is added or removed, where the
// password is one of the two answers — and the optional sign-in e-mail a profile may type there
// instead of its name (EmailRow). Passkeys stay the default wherever this appears; the rules
// themselves are the server's (api/password.js and the password block in api/server.js), this
// only words them.
import { useEffect, useRef, useState } from 'react'
import { useStore, hasData } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { dateLocale } from '../lib/i18n-core.js'
import { api, webauthnOK, passkeyAssertion, passwordLogin, passwordRegister, passwordResetRedeem, sendVerificationCode } from '../lib/api.js'
import { getOrCreateDeviceId, getTrustedDeviceToken } from '../lib/rit-native.js'
import { askAddDeviceData } from '../sheets.jsx'
import Icon from './Icon.jsx'
import { Row, Button } from './ui.jsx'

// The server's floor (api/password.js MIN_LENGTH), checked here first so the common mistake is
// answered without a round trip. The server still decides.
export const MIN_PASSWORD = 10
export const passwordOn = config => !!config?.password_login
// An address the way the server stores and compares it (nameKey in api/password.js): NFKC,
// trimmed, lower-cased.
export const foldEmail = s => String(s || '').normalize('NFKC').trim().toLowerCase()
// The server's own check (normalizeEmail and EMAIL_RE in api/password.js), so what passes here is
// what the server takes; a test holds the two together. The server still decides.
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@(?=.{1,253}$)[^\s@<>()[\]\\,;:"._-][^\s@<>()[\]\\,;:"]*\.[^\s@<>()[\]\\,;:".]{2,}$/u
export const looksLikeEmail = s => {
  const e = foldEmail(s)
  return !!e && [...e].length <= 254 && EMAIL_RE.test(e) && !e.includes('..')
}

const ui = () => useUI.getState()
const toast = m => ui().toast(m)
const length = s => [...String(s || '')].length
const errStyle = { color: 'var(--red)', marginTop: 10 }

// "in 5 minutes" in the UI language, for how long a pause (429, Retry-After) still lasts.
function fmtIn(sec) {
  const [n, unit] = sec < 60 ? [Math.max(1, Math.round(sec)), 'second'] : sec < 3600 ? [Math.ceil(sec / 60), 'minute'] : [Math.ceil(sec / 3600), 'hour']
  try { return new Intl.RelativeTimeFormat(dateLocale(), { numeric: 'always' }).format(n, unit) }
  catch { return n + ' ' + unit }
}

// The server's answer in the UI language. Every password route sends a stable `code` beside its
// English message (api/openapi.yaml, Error.code); an answer without one is shown as it came.
export function passwordError(e) {
  const code = e?.data?.code
  if (e?.status === 429 || code === 'locked') return t('Too many attempts. Try again {0}.', fmtIn(e?.data?.retryAfter || 60))
  switch (code) {
    case 'bad-credentials': return t('Wrong name, e-mail or password.')
    case 'too-short': return t('Use at least {0} characters.', MIN_PASSWORD)
    case 'too-long': return t('That password is too long.')
    case 'too-common': return t('That password is too easy to guess. Try a longer one, or a few random words strung together.')
    case 'name-taken': return t('Another profile already signs in with this name.')
    case 'email-invalid': return t('That is not an e-mail address.')
    case 'email-taken': return t('Another profile already uses this e-mail address.')
    case 'email-not-found': return 'Nenhuma conta encontrada com este endereço de e-mail.'
    case 'invite': return t('That invite code is not valid.')
    case 'current-required': case 'current-wrong': return t('Your current password is not right.')
    case 'passkey': case 'passkey-required': return t('Your passkey could not be confirmed.')
    case 'last-way-in': return t('This password is the only way into your profile, so it cannot be removed.')
    case 'reset-invalid': return t('That reset code is wrong or has expired. Ask your admin for a new one.')
    case 'otp-invalid': return 'Código de verificação de 6 dígitos inválido ou expirado.'
    case 'disabled': return t('This account has been disabled.')
    case 'busy': return t('The server is busy. Try again in a moment.')
  }
  return e?.message || t('Sign-in failed')
}
// A passkey prompt the person closed is their answer, not an error worth a line in red.
const dismissed = e => e?.name === 'NotAllowedError' || e?.name === 'AbortError'

// Signed in: the same steps as a passkey sign-in (Login.jsx) — and the same account coming back
// merges what this device kept for it (adoptProfile).
async function signedIn(u, close) {
  const st = useStore.getState()
  try {
    if (u?.name) localStorage.setItem('rit_last_username', u.name)
  } catch { /* ignore */ }
  st.setUser(u, { adopt: true })
  close()
  await st.adoptProfile(askAddDeviceData)
  toast(t('Welcome back, {0}', u.name))
}

const field = { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }
const codeStyle = { letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }

/* Sign in with name (or the profile's sign-in e-mail) and password, or — one tap away — redeem a reset code from the admin, which
   sets a new password and signs in. `onPasskey`, when given, offers the passkey instead. The
   inputs carry the autocomplete names password managers look for, inside a real form. */
export function PasswordSignInSheet({ close, onPasskey, requireEmailOtp = false, onSwitchToRegister = null }) {
  const [mode, setMode] = useState('signin')   // 'signin' | 'forgot' | 'reset'
  const [name, setName] = useState(() => {
    try {
      if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') return ''
      return localStorage.getItem('rit_last_username') || ''
    } catch { return '' }
  })
  const [pw, setPw] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [rememberMe, setRememberMe] = useState(true)
  const [code, setCode] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [otpState, setOtpState] = useState(null)
  const [otpCode, setOtpCode] = useState('')
  const [forgotOtpState, setForgotOtpState] = useState(null)
  const [resendingChannel, setResendingChannel] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const nameRef = useRef(null)
  const pwRef = useRef(null)
  useEffect(() => {
    setTimeout(() => {
      if (name.trim()) pwRef.current?.focus()
      else nameRef.current?.focus()
    }, 250)
  }, [])
  const reset = mode === 'reset'
  const forgot = mode === 'forgot'

  const handleResendOtp = async (channel, purpose = 'login') => {
    const activeChallenge = purpose === 'reset' ? forgotOtpState : otpState
    if (busy || resendingChannel || !activeChallenge) return
    setResendingChannel(channel)
    setErr(null)
    try {
      const res = await sendVerificationCode({
        purpose,
        email: name.trim(),
        ...(purpose === 'login' ? { password: pw, challengeId: activeChallenge.challengeId } : {}),
        channel
      })
      if (res?.challengeId) {
        if (purpose === 'reset') setForgotOtpState(res)
        else setOtpState(res)
        toast(channel === 'whatsapp' ? 'Código reenviado para seu WhatsApp!' : 'Código reenviado para seu e-mail!')
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
    setBusy(true); setErr(null)
    try {
      const res = await sendVerificationCode({
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
      setBusy(true); setErr(null)
      try {
        const u = await passwordLogin(n, pw, {
          requireEmailOtp: true,
          deviceId: getOrCreateDeviceId(),
          challengeId: otpState.challengeId,
          otpCode: cleanOtp
        })
        if (rememberMe) {
          try { localStorage.setItem('rit_last_username', n) } catch { /* ignore */ }
        }
        await signedIn(u, close)
      } catch (e) {
        setErr(passwordError(e))
      } finally {
        setBusy(false)
      }
      return
    }
    const bad = !n ? (requireEmailOtp ? 'Informe seu e-mail.' : t('Enter your name or e-mail.'))
      : requireEmailOtp && !looksLikeEmail(n) ? t('That is not an e-mail address.')
      : !reset && !pw ? t('Enter your password.')
      : reset && !code.trim() ? t('Enter the reset code.')
      : reset && length(next) < MIN_PASSWORD ? t('Use at least {0} characters.', MIN_PASSWORD)
      // A typo here is only found at the next sign-in, and fixing it takes another code.
      : reset && next !== again ? t('The two passwords are not the same.')
      : null
    if (bad) { setErr(bad); return }
    setBusy(true); setErr(null)
    try {
      const res = reset
        ? (forgotOtpState?.challengeId
            ? await passwordResetRedeem(n, code.trim(), next, {
                challengeId: forgotOtpState.challengeId,
                otpCode: code.trim(),
                deviceId: getOrCreateDeviceId()
              })
            : await passwordResetRedeem(n, code.trim(), next))
        : requireEmailOtp
          ? await passwordLogin(n, pw, {
              requireEmailOtp: true,
              deviceId: getOrCreateDeviceId(),
              trustedDeviceToken: getTrustedDeviceToken(n)
            })
          : await passwordLogin(n, pw)
      if (res?.verificationRequired) {
        setOtpState(res)
        setOtpCode('')
        return
      }
      if (rememberMe) {
        try { localStorage.setItem('rit_last_username', n) } catch { /* ignore */ }
      } else {
        try { localStorage.removeItem('rit_last_username') } catch { /* ignore */ }
      }
      await signedIn(res, close)
    }
    catch (e) { setErr(passwordError(e)) }
    finally { setBusy(false) }
  }

  if (forgot) {
    return <>
      <h3>Esqueceu a Senha?</h3>
      <div className="muted small" style={{ marginBottom: 14, fontSize: 14, lineHeight: 1.45 }}>
        Digite seu e-mail cadastrado e enviaremos um código de 6 dígitos no seu WhatsApp e e-mail para criar uma nova senha.
      </div>
      <form className="rit-auth-form" onSubmit={handleRequestForgotCode} noValidate>
        <div className="rit-auth-field">
          <label className="rit-auth-label">
            <span>Endereço de e-mail<span className="rit-auth-label-req">*</span></span>
          </label>
          <input
            ref={nameRef}
            className="input rit-auth-input"
            type="email"
            inputMode="email"
            name="username"
            autoComplete="username"
            placeholder="exemplo@gmail.com"
            maxLength={254}
            value={name}
            onChange={e => setName(e.target.value)}
            {...field}
          />
        </div>
        {err && <div className="small rit-auth-alert" role="alert" style={errStyle}>{err}</div>}
        <button type="submit" className="rit-auth-pill" disabled={busy}>
          {busy ? 'Enviando código…' : 'Enviar código'}
        </button>
      </form>
      <div className="rit-auth-footer">
        <button
          type="button"
          className="rit-auth-link-btn"
          onClick={() => { setErr(null); setMode('signin') }}
        >
          Voltar para o Login
        </button>
      </div>
    </>
  }

  if (!reset && otpState) {
    return <>
      <h3>Verifique seu acesso</h3>
      <div className="muted small" style={{ marginBottom: 14, lineHeight: 1.45, fontSize: 14 }}>
        Enviamos um código de 6 dígitos para confirmar este aparelho
        {otpState.maskedPhone ? ` no WhatsApp (${otpState.maskedPhone})` : ''}
        {otpState.maskedEmail ? `${otpState.maskedPhone ? ' e ' : ' '}no e-mail (${otpState.maskedEmail})` : ''}.
      </div>
      <form onSubmit={submit} noValidate>
        <input
          className="input"
          name="otp-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000000"
          maxLength={6}
          value={otpCode}
          onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          style={{ ...codeStyle, fontSize: 20, letterSpacing: '.28em' }}
        />
        {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
        <div style={{ height: 12 }} />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t('Connecting…') : 'Confirmar código e entrar'}
        </Button>
      </form>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        {otpState.hasPhone && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy || Boolean(resendingChannel)}
            onClick={() => handleResendOtp('whatsapp')}
          >
            {resendingChannel === 'whatsapp' ? 'Enviando no WhatsApp…' : '📲 Reenviar código por WhatsApp'}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={busy || Boolean(resendingChannel)}
          onClick={() => handleResendOtp('email')}
        >
          {resendingChannel === 'email' ? 'Enviando por E-mail…' : '✉️ Reenviar código por E-mail'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="dim"
          disabled={busy}
          onClick={() => { setOtpState(null); setOtpCode(''); setErr(null) }}
        >
          Voltar e alterar e-mail
        </Button>
      </div>
    </>
  }

  return <>
    <h3>{reset ? t('Reset your password') : t('Sign in with password')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>{reset
      ? t('Enter the code your admin gave you and choose a new password. It signs you out everywhere else.')
      : requireEmailOtp
        ? 'Acesse com seu e-mail cadastrado e sua senha.'
        : t('Use your profile name (or the e-mail you added to it) and your password.')}</div>
    <form onSubmit={submit} noValidate>
      {/* One field for both: the server looks an entry with an "@" up as an e-mail first. Not
          type="email", which would refuse a plain name. */}
      <input ref={nameRef} className="input" type={requireEmailOtp ? 'email' : 'text'} inputMode={requireEmailOtp ? 'email' : undefined}
        name="username" autoComplete="username" placeholder={requireEmailOtp ? 'Seu e-mail' : t('Name or e-mail')} maxLength={254}
        value={name} onChange={e => setName(e.target.value)} {...field} />
      <div style={{ height: 10 }} />
      {reset ? <>
        <input className="input" name="reset-code" autoComplete="one-time-code" placeholder={t('Reset code')} maxLength={20}
          value={code} onChange={e => setCode(e.target.value.toUpperCase())} {...field} style={codeStyle} />
        <div style={{ height: 10 }} />
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <input className="input" type={showPw ? 'text' : 'password'} name="new-password" autoComplete="new-password" placeholder={t('New password')}
            value={next} onChange={e => setNext(e.target.value)} style={{ paddingRight: 42, width: '100%' }} />
          <button
            type="button"
            onClick={() => setShowPw(s => !s)}
            style={{
              position: 'absolute',
              right: 4,
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 8,
              color: showPw ? 'var(--acc)' : 'var(--muted)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            title={showPw ? t('Hide password') : t('Show password')}
            aria-label={showPw ? t('Hide password') : t('Show password')}
          >
            <Icon name={showPw ? 'eyeOff' : 'eye'} size={20} />
          </button>
        </div>
        <div style={{ height: 10 }} />
        <input className="input" type={showPw ? 'text' : 'password'} name="new-password-again" autoComplete="new-password" placeholder={t('Repeat the password')}
          value={again} onChange={e => setAgain(e.target.value)} />
        <div className="dim small" style={{ marginTop: 6 }}>{t('At least {0} characters. A few unrelated words make a good one.', MIN_PASSWORD)}</div>
      </> : <>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <input ref={pwRef} className="input" type={showPw ? 'text' : 'password'} name="password" autoComplete="current-password" placeholder={t('Password')}
            value={pw} onChange={e => setPw(e.target.value)} style={{ paddingRight: 42, width: '100%' }} />
          <button
            type="button"
            onClick={() => setShowPw(s => !s)}
            style={{
              position: 'absolute',
              right: 4,
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 8,
              color: showPw ? 'var(--acc)' : 'var(--muted)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            title={showPw ? t('Hide password') : t('Show password')}
            aria-label={showPw ? t('Hide password') : t('Show password')}
          >
            <Icon name={showPw ? 'eyeOff' : 'eye'} size={20} />
          </button>
        </div>
        {requireEmailOtp && (
          <div className="rit-auth-row-between" style={{ marginTop: 10 }}>
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
              onClick={() => { setErr(null); setMode('forgot') }}
            >
              Esqueceu a senha?
            </button>
          </div>
        )}
        <div className="dim small" style={{ marginTop: 8, textAlign: 'start', lineHeight: 1.4 }}>
          {t('First time here? Your coach or gym set your initial password (usually {0}). Ask them if you’re unsure.', 'treino2026')}
        </div>
      </>}
      {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
      <div style={{ height: 12 }} />
      <Button type="submit" variant="primary" disabled={busy}>{reset ? t('Set password & sign in') : t('Sign in')}</Button>
    </form>
    <div style={{ height: 8 }} />
    <Button type="button" variant="ghost" className="dim" onClick={() => { setErr(null); setForgotOtpState(null); setMode(reset ? 'signin' : 'reset') }}>
      {reset ? t('Sign in with password') : t('Have a reset code from your admin?')}</Button>
    {onPasskey && !reset && webauthnOK() && <>
      <div style={{ height: 8 }} />
      <Button type="button" icon="fingerprint" onClick={() => { close(); onPasskey() }}>{t('Sign in with passkey')}</Button>
    </>}
    {onSwitchToRegister && !reset && (
      <div className="rit-auth-footer" style={{ marginTop: 12 }}>
        Ainda não tem uma conta?{' '}
        <button type="button" className="rit-auth-link-btn accent" onClick={onSwitchToRegister}>
          Criar conta
        </button>
      </div>
    )}
  </>
}
export const openPasswordSignIn = (onPasskey, opts = {}) =>
  ui().openSheet(close => <PasswordSignInSheet close={close} onPasskey={onPasskey} {...opts} />)

/* The password half of creating a profile. Name and invite code are the caller's state, so
   switching between passkey and password on the sign-up sheet keeps what was typed. */
export function PasswordRegisterForm({
  close,
  inviteOnly,
  name,
  setName,
  code,
  setCode,
  initialEmail = '',
  forceShowCode = false,
  requireEmailOtp = false,
  onRegistered = null
}) {
  const [email, setEmail] = useState(initialEmail || '')
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [otpState, setOtpState] = useState(null)
  const [otpCode, setOtpCode] = useState('')
  const [resendingChannel, setResendingChannel] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  useEffect(() => {
    if (initialEmail && !email) setEmail(initialEmail)
  }, [initialEmail]) // eslint-disable-line react-hooks/exhaustive-deps
  const showCodeField = Boolean(inviteOnly || forceShowCode || String(code || '').trim())

  const handleResendOtp = async channel => {
    if (busy || resendingChannel) return
    setResendingChannel(channel)
    setErr(null)
    try {
      const res = await sendVerificationCode({
        purpose: 'register',
        email: email.trim(),
        name: name.trim(),
        password: pw,
        code: code.trim().toUpperCase(),
        channel
      })
      if (res?.challengeId) {
        setOtpState(res)
        toast(channel === 'whatsapp' ? 'Código reenviado para seu WhatsApp!' : 'Código reenviado para seu e-mail!')
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
    if (requireEmailOtp && otpState) {
      const cleanOtp = otpCode.replace(/\D/g, '')
      if (cleanOtp.length !== 6) {
        setErr('Digite o código de verificação de 6 dígitos.')
        return
      }
      setBusy(true); setErr(null)
      try {
        const u = await passwordRegister(n, pw, code.trim(), mail, {
          requireEmailOtp: true,
          deviceId: getOrCreateDeviceId(),
          challengeId: otpState.challengeId,
          otpCode: cleanOtp
        })
        if (typeof onRegistered === 'function') onRegistered(u)
        const st = useStore.getState()
        st.setUser(u); close()
        if (hasData(useStore.getState().S)) { await st.pushState(); toast(t('Profile created, and this device’s data moved into it')) }
        else { await st.pullState(); toast(t('Welcome, {0}', u.name)) }
      } catch (e) {
        setErr(passwordError(e))
      } finally {
        setBusy(false)
      }
      return
    }
    const bad = !n ? t('Enter a name')
      : requireEmailOtp && !mail ? 'Informe seu endereço de e-mail.'
      : mail && !looksLikeEmail(mail) ? t('That is not an e-mail address.')
      : inviteOnly && !code.trim() ? t('An invite code is required')
      : length(pw) < MIN_PASSWORD ? t('Use at least {0} characters.', MIN_PASSWORD)
      : pw !== again ? t('The two passwords are not the same.')
      : null
    if (bad) { setErr(bad); return }
    setBusy(true); setErr(null)
    try {
      if (requireEmailOtp) {
        const res = await sendVerificationCode({
          purpose: 'register',
          email: mail,
          name: n,
          password: pw,
          code: code.trim().toUpperCase(),
          channel: 'auto'
        })
        if (res?.verificationRequired && res?.challengeId) {
          setOtpState(res)
          setOtpCode('')
          return
        }
      }
      const u = await passwordRegister(n, pw, code.trim(), mail)
      if (typeof onRegistered === 'function') onRegistered(u)
      const st = useStore.getState()
      st.setUser(u); close()
      if (hasData(useStore.getState().S)) { await st.pushState(); toast(t('Profile created, and this device’s data moved into it')) }
      else { await st.pullState(); toast(t('Welcome, {0}', u.name)) }
    } catch (e) { setErr(passwordError(e)) }
    finally { setBusy(false) }
  }

  if (requireEmailOtp && otpState) {
    return <form onSubmit={submit} noValidate>
      <div className="muted small" style={{ marginBottom: 12, lineHeight: 1.45, fontSize: 14 }}>
        Enviamos seu código de verificação de 6 dígitos
        {otpState.maskedPhone ? ` para o WhatsApp (${otpState.maskedPhone})` : ''}
        {otpState.maskedEmail ? `${otpState.maskedPhone ? ' e ' : ' '}para o e-mail (${otpState.maskedEmail})` : ''}.
      </div>
      <input
        className="input"
        name="otp-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="000000"
        maxLength={6}
        value={otpCode}
        onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
        style={{ ...codeStyle, fontSize: 20, letterSpacing: '.28em' }}
      />
      {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
      <div style={{ height: 12 }} />
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? t('Connecting…') : 'Confirmar código e criar conta'}
      </Button>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        {otpState.hasPhone && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy || Boolean(resendingChannel)}
            onClick={() => handleResendOtp('whatsapp')}
          >
            {resendingChannel === 'whatsapp' ? 'Enviando no WhatsApp…' : '📲 Reenviar código por WhatsApp'}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={busy || Boolean(resendingChannel)}
          onClick={() => handleResendOtp('email')}
        >
          {resendingChannel === 'email' ? 'Enviando por E-mail…' : '✉️ Reenviar código por E-mail'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="dim"
          disabled={busy}
          onClick={() => { setOtpState(null); setOtpCode(''); setErr(null) }}
        >
          Voltar e revisar dados
        </Button>
      </div>
    </form>
  }

  return <form onSubmit={submit} noValidate>
    <input className="input" name="username" autoComplete="username" placeholder={t('Your name')} maxLength={40}
      value={name} onChange={e => setName(e.target.value)} {...field} />
    <div style={{ height: 10 }} />
    <input className="input" type="email" name="email" autoComplete="email" inputMode="email"
      placeholder={requireEmailOtp ? 'Seu e-mail (obrigatório)' : t('E-mail (optional)')} maxLength={254}
      value={email} onChange={e => setEmail(e.target.value)} {...field} />
    <div className="dim small" style={{ marginTop: 6 }}>
      {requireEmailOtp
        ? 'Usado para entrar na sua conta e receber o código de verificação.'
        : t('Lets you sign in with it instead of your name. Nothing is ever sent to it.')}
    </div>
    {showCodeField && <>
      <div style={{ height: 10 }} />
      <input className="input" placeholder={t('Invite code')} maxLength={40} value={code}
        onChange={e => setCode(e.target.value.toUpperCase())} style={codeStyle} />
      <div className="dim small" style={{ marginTop: 6 }}>
        {inviteOnly
          ? t('This app is invite-only. Enter the code you were given.')
          : t('Invite code linked to your gym profile.')}
      </div>
    </>}
    <div style={{ height: 10 }} />
    <input className="input" type="password" name="new-password" autoComplete="new-password" placeholder={t('Password')}
      value={pw} onChange={e => setPw(e.target.value)} />
    <div style={{ height: 10 }} />
    <input className="input" type="password" name="new-password-again" autoComplete="new-password" placeholder={t('Repeat the password')}
      value={again} onChange={e => setAgain(e.target.value)} />
    <div className="dim small" style={{ marginTop: 6 }}>{t('At least {0} characters. A few unrelated words make a good one.', MIN_PASSWORD)}</div>
    {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
    <div style={{ height: 12 }} />
    <Button type="submit" variant="primary" disabled={busy}>{t('Create profile')}</Button>
  </form>
}

// The same form on its own sheet — Settings, in a browser that cannot make a passkey.
function PasswordRegisterSheet({ close }) {
  const config = useStore(s => s.config)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  return <>
    <h3>{t('Create your profile')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Pick a name and a password. You sign in with both.')}</div>
    <PasswordRegisterForm close={close} inviteOnly={!!config?.invite_only} name={name} setName={setName} code={code} setCode={setCode} />
  </>
}
export const openPasswordRegister = () => ui().openSheet(close => <PasswordRegisterSheet close={close} />)

/* "Confirm it is you" — what the server asks before anything that adds or takes away a way in
   (proveOwner in api/server.js): a passkey this profile already has, or its current password
   where that counts. `passkey`: the profile has one. `password`: its password counts as proof —
   set, and the instance takes passwords (GET /api/account/passkeys → `password`). Hands the body
   the server takes to `onProof` — for a removal, the removal itself — and shows the refusal,
   worded by `explain`, when that throws. For a removal this step is the confirmation too, so
   `danger` colours it and `submitText` names the action on the password's button.

   A proof is made on the tap, for the one request it goes with, and never kept. A passkey prompt
   still open when the sheet closes is called off, and whatever a prompt answers after that is
   dropped: someone who backed out of removing a passkey must not have it removed by a prompt
   they no longer see. */
export function ProveOwner({ passkey, password, onProof, explain = passwordError, danger = false, submitText }) {
  const name = useStore(s => s.user?.name) || ''
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const live = useRef(true)
  const prompt = useRef(null)   // the AbortController of a passkey prompt still open
  useEffect(() => {
    // Set here, not only initially: StrictMode unmounts and mounts again, and the first cleanup
    // must not leave the sheet thinking it is gone.
    live.current = true
    return () => { live.current = false; prompt.current?.abort() }
  }, [])
  const run = async proof => {
    if (busy) return
    setBusy(true); setErr(null)
    const ctl = new AbortController()
    prompt.current = ctl
    try {
      const body = await proof(ctl.signal)
      if (!live.current) return
      await onProof(body)
    } catch (e) { if (live.current && !dismissed(e)) setErr(explain(e)) }
    finally {
      if (prompt.current === ctl) prompt.current = null
      if (live.current) setBusy(false)
    }
  }
  const withPasskey = !!passkey && webauthnOK()
  const withPassword = ev => {
    ev.preventDefault()
    if (!pw) { setErr(t('Enter your password.')); return }
    run(async () => ({ current: pw }))
  }
  // A removal's buttons are red whichever proof carries it: each of them removes.
  const main = danger ? 'danger' : 'primary'
  return <>
    {withPasskey && <Button variant={main} icon="fingerprint" disabled={busy} onClick={() => run(signal => passkeyAssertion({ signal }))}>{t('Confirm with a passkey')}</Button>}
    {password && <form onSubmit={withPassword} noValidate>
      {withPasskey && <div className="dim small" style={{ margin: '14px 0 8px', textAlign: 'center' }}>{t('or with your password')}</div>}
      {/* Tells a password manager which account the password belongs to. */}
      <input type="text" name="username" autoComplete="username" value={name} readOnly hidden />
      <input className="input" type="password" name="current-password" autoComplete="current-password" placeholder={t('Current password')}
        value={pw} onChange={e => setPw(e.target.value)} />
      <div style={{ height: 10 }} />
      <Button type="submit" variant={withPasskey && !danger ? 'plain' : main} disabled={busy}>{submitText || t('Continue')}</Button>
    </form>}
    {/* A profile with no passkey whose password no longer counts — the instance switched
        passwords off — has nothing left to answer with (docs/SELF_HOSTING.md). */}
    {!withPasskey && !password && <div className="dim small">{passkey
      ? t('This browser cannot confirm with your passkey. Do this on a device that holds one.')
      : t('This profile has no passkey, and this server does not take passwords, so nothing here can confirm that it is you. Ask your admin.')}</div>}
    {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
  </>
}

/* Settings' account rows read the server as the screen opens. One that found the server down
   has nothing to show, and stayed missing until Settings was left and opened again, while the
   block above it already said "All synced". It asks again whenever the store hears from the
   server — a push or pull that landed, a check that found both sides in step — until it gets
   an answer. A refusal (a server from before the route, a 403) is an answer: asking again
   would only get the same one. */
export const notReached = e => e?.status == null || e.status >= 500
export function useAgainOnceReached(unreached, load) {
  const reachedAt = useStore(s => s.sync?.lastSynced)
  useEffect(() => { if (unreached) load() }, [reachedAt])
}

/* ------------------------------------------------------------------- Settings -------------
   Settings → Account → Password, for a signed-in browser. A first password needs a passkey
   ceremony right now (a session on its own could be a copied cookie); a change needs the
   current password, or the passkey when it was forgotten. Saving signs every other device out,
   which the sheet says before anyone taps. */
// `version` changes when the profile's passkeys do (Settings, components/Passkeys.jsx): whether the
// password may be removed depends on them, so the row asks again.
export function PasswordRow({ version = 0 }) {
  const [st, setSt] = useState(null)   // GET /api/account/password
  const [unreached, setUnreached] = useState(false)
  const load = () => api('/api/account/password').then(r => { setSt(r); setUnreached(false) }).catch(e => setUnreached(notReached(e)))
  useEffect(() => { load() }, [version])
  useAgainOnceReached(unreached, load)
  if (!st) return null
  // Nothing here could set a first password without a passkey ceremony.
  if (!st.set && (!webauthnOK() || !st.passkeys)) return null
  const blocked = !st.set && st.nameTaken
  const subtitle = blocked ? t('Another profile already signs in with this name.')
    : st.set ? t('Set · sign in as “{0}”', st.name)
    : t('Not set. Handy for signing in where passkeys don’t work.')
  return <>
    <Row icon="key" iconTint="var(--orange)" title={t('Password')} subtitle={subtitle} accessory={blocked ? 'none' : 'chevron'}
      onClick={blocked ? undefined : () => ui().openSheet(close => <PasswordSheet status={st} close={close} done={load} />)} />
    {/* The server only signs in by an address that belongs to a profile with a password, so
        without one the row is left out; one already saved stays reachable to change or remove. */}
    {(st.set || st.email) && <EmailRow status={st} done={load} />}
  </>
}

export function PasswordSheet({ status, close, done }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const save = async withPasskey => {
    if (busy) return
    const bad = !withPasskey && !current ? t('Enter your password.')
      : length(next) < MIN_PASSWORD ? t('Use at least {0} characters.', MIN_PASSWORD)
      : next !== again ? t('The two passwords are not the same.')
      : null
    if (bad) { setErr(bad); return }
    setBusy(true); setErr(null)
    try {
      const proof = withPasskey ? await passkeyAssertion() : { current }
      await api('/api/account/password', { method: 'POST', body: JSON.stringify({ next, ...proof }) })
      close(); done()
      toast(t('Password saved. You’re now signed out everywhere else.'))
    } catch (e) { if (!dismissed(e)) setErr(passwordError(e)) }
    finally { setBusy(false) }
  }
  const remove = () => ui().openSheet(c => <RemovePasswordSheet status={status} close={c} done={() => { close(); done() }} />)
  return <>
    <h3>{status.set ? t('Change password') : t('Set a password')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {t('Sign in as “{0}” with it on devices where passkeys do not work. Saving signs you out everywhere else, and paired phones have to be paired again.', status.name)}
    </div>
    <form onSubmit={ev => { ev.preventDefault(); save(!status.set) }} noValidate>
      {/* Tells a password manager which account the new password belongs to. */}
      <input type="text" name="username" autoComplete="username" value={status.name} readOnly hidden />
      {status.set && <>
        <input className="input" type="password" name="current-password" autoComplete="current-password" placeholder={t('Current password')}
          value={current} onChange={e => setCurrent(e.target.value)} />
        <div style={{ height: 10 }} />
      </>}
      <input className="input" type="password" name="new-password" autoComplete="new-password" placeholder={t('New password')}
        value={next} onChange={e => setNext(e.target.value)} />
      <div style={{ height: 10 }} />
      <input className="input" type="password" name="new-password-again" autoComplete="new-password" placeholder={t('Repeat the password')}
        value={again} onChange={e => setAgain(e.target.value)} />
      <div className="dim small" style={{ marginTop: 6 }}>{t('At least {0} characters. A few unrelated words make a good one.', MIN_PASSWORD)}</div>
      {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
      <div style={{ height: 12 }} />
      <Button type="submit" variant="primary" disabled={busy}>{status.set ? t('Save') : t('Confirm with passkey & save')}</Button>
    </form>
    {status.set && status.passkeys > 0 && webauthnOK() && <>
      <div style={{ height: 8 }} />
      <Button type="button" variant="ghost" className="dim" disabled={busy} onClick={() => save(true)}>{t('Forgot it? Confirm with your passkey instead')}</Button>
    </>}
    {status.set && status.passkeys > 0 && <>
      <div style={{ height: 8 }} />
      <button type="button" className="btn danger" disabled={busy} onClick={remove}>{t('Remove password')}</button>
    </>}
  </>
}

/* Removing the password asks for the proof setting one does (proveOwner in api/server.js): a
   copied session must not take away the owner's way in where passkeys do not work. The proof is
   the confirmation, so it is asked on the sheet that says what removing means — the password
   itself, or a passkey of this profile. Only offered while a passkey remains (the last way in
   stays), and the password counts here: this row exists only while the instance takes them. */
function RemovePasswordSheet({ status, close, done }) {
  const remove = async proof => {
    await api('/api/account/password', { method: 'DELETE', body: JSON.stringify(proof) })
    close(); done()
    toast(t('Password removed'))
  }
  return <>
    <h3>{t('Remove your password?')}</h3>
    <div className="muted small" style={{ marginBottom: 6 }}>{t('Only your passkeys sign in to this profile afterwards.')}</div>
    <div className="dim small" style={{ marginBottom: 14 }}>{t('First confirm that it is you.')}</div>
    <ProveOwner passkey={status.passkeys > 0} password danger submitText={t('Remove')} onProof={remove} />
    <div style={{ height: 8 }} />
    <Button type="button" variant="ghost" className="dim" onClick={close}>{t('Cancel')}</Button>
  </>
}

/* Settings → Account → Sign-in e-mail, right under the password (and shown on the same terms:
   only while the instance takes passwords, and only where something here can confirm it is the
   owner). An address typed at "Sign in with password" instead of the profile name. Nothing is
   ever sent to it — there is no mail server behind openGym — so it is not verified either, and a
   forgotten password is still reset by the admin's code. Setting, changing and removing it ask
   the proof a password does (ProveOwner): a copied session must not choose how the owner signs
   in. `status` is GET /api/account/password, whose `email` only the owner ever gets. */
export function EmailRow({ status, done }) {
  const subtitle = status.email && !status.set ? t('“{0}” is saved, but signs in only once this profile has a password.', status.email)
    : status.email ? t('Sign in with “{0}” instead of your name', status.email)
    : t('Not set. Lets you sign in with an e-mail instead of your name.')
  return <Row icon="envelope" iconTint="var(--blue)" title={t('Sign-in e-mail')} subtitle={subtitle} accessory="chevron"
    onClick={() => ui().openSheet(close => <EmailSheet status={status} close={close} done={done} />)} />
}

// Two steps: the address first, checked here before any passkey prompt opens, then the proof,
// which carries the save. An address in use is only refused after the proof (the server's rule,
// so that asking costs something), and is said on the proof step.
export function EmailSheet({ status, close, done }) {
  const [email, setEmail] = useState(status.email || '')
  const [step, setStep] = useState('edit')   // 'edit' | 'confirm'
  const [err, setErr] = useState(null)
  const clean = email.trim()
  const next = ev => {
    ev.preventDefault()
    const bad = !clean || !looksLikeEmail(clean) ? t('That is not an e-mail address.')
      : foldEmail(clean) === status.email ? t('That is already your sign-in e-mail.')
      : null
    if (bad) { setErr(bad); return }
    setErr(null); setStep('confirm')
  }
  const save = async proof => {
    await api('/api/account/email', { method: 'POST', body: JSON.stringify({ email: clean, ...proof }) })
    close(); done()
    toast(t('E-mail saved'))
  }
  const remove = () => ui().openSheet(c => <RemoveEmailSheet status={status} close={c} done={() => { close(); done() }} />)
  return <>
    <h3>{status.email ? t('Change sign-in e-mail') : t('Add a sign-in e-mail')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {t('Type it at “Sign in with password” instead of your profile name. We never send anything to it; a forgotten password is still reset by your admin.')}
    </div>
    {step === 'edit' ? <>
      <form onSubmit={next} noValidate>
        <input className="input" type="email" name="email" autoComplete="email" inputMode="email" placeholder={t('E-mail address')} maxLength={254}
          value={email} onChange={e => setEmail(e.target.value)} {...field} />
        {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
        <div style={{ height: 12 }} />
        <Button type="submit" variant="primary">{t('Continue')}</Button>
      </form>
      {status.email && <>
        <div style={{ height: 8 }} />
        <button type="button" className="btn danger" onClick={remove}>{t('Remove e-mail')}</button>
      </>}
    </> : <>
      <div className="small" style={{ marginBottom: 6, fontWeight: 600, overflowWrap: 'anywhere' }}>{clean}</div>
      <div className="dim small" style={{ marginBottom: 14 }}>{t('First confirm that it is you.')}</div>
      <ProveOwner passkey={status.passkeys > 0} password={!!status.set} submitText={t('Save')} onProof={save} />
      <div style={{ height: 8 }} />
      <Button type="button" variant="ghost" className="dim" onClick={() => setStep('edit')}>{t('Back')}</Button>
    </>}
  </>
}

function RemoveEmailSheet({ status, close, done }) {
  const remove = async proof => {
    await api('/api/account/email', { method: 'DELETE', body: JSON.stringify(proof) })
    close(); done()
    toast(t('E-mail removed'))
  }
  return <>
    <h3>{t('Remove your sign-in e-mail?')}</h3>
    <div className="muted small" style={{ marginBottom: 6 }}>{t('Afterwards you sign in with your profile name only.')}</div>
    <div className="dim small" style={{ marginBottom: 14 }}>{t('First confirm that it is you.')}</div>
    <ProveOwner passkey={status.passkeys > 0} password={!!status.set} danger submitText={t('Remove')} onProof={remove} />
    <div style={{ height: 8 }} />
    <Button type="button" variant="ghost" className="dim" onClick={close}>{t('Cancel')}</Button>
  </>
}
