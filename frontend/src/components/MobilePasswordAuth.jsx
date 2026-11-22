// Native mobile student password sign-in, password reset, and registration sheets
// (mirrors the normal web flow without requiring a 5-minute browser pairing code).
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { MIN_PASSWORD, looksLikeEmail, passwordError } from './PasswordAuth.jsx'
import { rememberStudentNativeMode, RIT_STUDENT_SERVER } from '../lib/rit-native.js'
import { useSheetKeyboard } from '../lib/use-sheet-keyboard.js'
import { askAddDeviceData } from '../sheets.jsx'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

// Matches the settle delay before focusing an input inside a bottom sheet (sheetup is 340 ms).
const MOBILE_SHEET_SETTLE_MS = 400
const FIELD_ATTRS = { autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false }
const CODE_STYLE = { letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }
const NOTE_STYLE = { fontSize: 14, lineHeight: 1.45 }
const ERR_STYLE = { color: 'var(--red)', marginTop: 10, fontSize: 14, lineHeight: 1.45, overflowWrap: 'anywhere' }

function readRememberedUsername() {
  try {
    if (typeof localStorage === 'undefined') return ''
    return localStorage.getItem('rit_last_username') || ''
  } catch {
    return ''
  }
}

function PasswordField({ inputRef, value, onChange, placeholder, name, autoComplete = 'current-password', onFocus }) {
  const [show, setShow] = useState(false)
  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <input
        ref={inputRef}
        className="input"
        type={show ? 'text' : 'password'}
        name={name}
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onFocus={onFocus}
        onChange={onChange}
        style={{ paddingRight: 44, width: '100%' }}
      />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        style={{
          position: 'absolute',
          right: 4,
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          minWidth: 40,
          minHeight: 40,
          padding: 8,
          color: show ? 'var(--acc)' : 'var(--muted)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
        title={show ? t('Hide password') : t('Show password')}
        aria-label={show ? t('Hide password') : t('Show password')}
      >
        <Icon name={show ? 'eyeOff' : 'eye'} size={20} />
      </button>
    </div>
  )
}

export function MobilePasswordSignInSheet({ close, initialUrl = RIT_STUDENT_SERVER, again = false }) {
  const signInMobileWithPassword = useStore(s => s.signInMobileWithPassword)
  const resetMobilePassword = useStore(s => s.resetMobilePassword)
  const targetUrl = initialUrl || RIT_STUDENT_SERVER
  const [mode, setMode] = useState('signin')
  const [name, setName] = useState(readRememberedUsername)
  const [pw, setPw] = useState('')
  const [code, setCode] = useState('')
  const [next, setNext] = useState('')
  const [againPw, setAgainPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const nameRef = useRef(null)
  const pwRef = useRef(null)
  const onFocus = useSheetKeyboard(nameRef, true, { reveal: true })

  useEffect(() => {
    const tm = setTimeout(() => {
      if (name.trim()) pwRef.current?.focus()
      else nameRef.current?.focus()
    }, MOBILE_SHEET_SETTLE_MS)
    return () => clearTimeout(tm)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const reset = mode === 'reset'
  const submit = async ev => {
    ev.preventDefault()
    if (busy) return
    const n = name.trim()
    const bad = !n ? t('Enter your name or e-mail.')
      : !reset && !pw ? t('Enter your password.')
      : reset && !code.trim() ? t('Enter the reset code.')
      : reset && [...next].length < MIN_PASSWORD ? t('Use at least {0} characters.', MIN_PASSWORD)
      : reset && next !== againPw ? t('The two passwords are not the same.')
      : ''
    if (bad) { setErr(bad); return }
    setBusy(true)
    setErr('')
    try {
      const u = reset
        ? await resetMobilePassword(targetUrl, { name: n, code: code.trim(), next }, askAddDeviceData)
        : await signInMobileWithPassword(targetUrl, n, pw, askAddDeviceData)
      rememberStudentNativeMode()
      close()
      useUI.getState().toast(t('Welcome back, {0}', u?.name || n))
    } catch (e) {
      setErr(passwordError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kb-lift">
      <h3>{reset ? t('Reset your password') : t('Sign in with password')}</h3>
      <div className="muted" style={{ ...NOTE_STYLE, marginBottom: 14 }}>
        {reset
          ? t('Enter the code your admin gave you and choose a new password. It signs you out everywhere else.')
          : t('Use your profile name (or the e-mail you added to it) and your password.')}
      </div>
      <form onSubmit={submit} noValidate>
        <input
          ref={nameRef}
          className="input"
          name="username"
          autoComplete="username"
          placeholder={t('Name or e-mail')}
          maxLength={254}
          value={name}
          onFocus={onFocus}
          onChange={e => setName(e.target.value)}
          {...FIELD_ATTRS}
        />
        <div style={{ height: 10 }} />
        {reset ? (
          <>
            <input
              className="input"
              name="reset-code"
              autoComplete="one-time-code"
              placeholder={t('Reset code')}
              maxLength={20}
              value={code}
              onFocus={onFocus}
              onChange={e => setCode(e.target.value.toUpperCase())}
              {...FIELD_ATTRS}
              style={CODE_STYLE}
            />
            <div style={{ height: 10 }} />
            <PasswordField
              inputRef={pwRef}
              name="new-password"
              autoComplete="new-password"
              placeholder={t('New password')}
              value={next}
              onFocus={onFocus}
              onChange={e => setNext(e.target.value)}
            />
            <div style={{ height: 10 }} />
            <PasswordField
              name="new-password-again"
              autoComplete="new-password"
              placeholder={t('Repeat the password')}
              value={againPw}
              onFocus={onFocus}
              onChange={e => setAgainPw(e.target.value)}
            />
            <div className="dim" style={{ ...NOTE_STYLE, marginTop: 6 }}>
              {t('At least {0} characters. A few unrelated words make a good one.', MIN_PASSWORD)}
            </div>
          </>
        ) : (
          <>
            <PasswordField
              inputRef={pwRef}
              name="password"
              autoComplete="current-password"
              placeholder={t('Password')}
              value={pw}
              onFocus={onFocus}
              onChange={e => setPw(e.target.value)}
            />
            <div className="dim" style={{ ...NOTE_STYLE, marginTop: 8, textAlign: 'start' }}>
              {t('First time here? Your coach or gym set your initial password (usually {0}). Ask them if you’re unsure.', 'treino2026')}
            </div>
          </>
        )}
        {err && <div role="alert" style={ERR_STYLE}>{err}</div>}
        <div style={{ height: 12 }} />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t('Connecting…') : reset ? t('Set password & sign in') : t('Sign in')}
        </Button>
      </form>
      <div style={{ height: 8 }} />
      <Button
        type="button"
        variant="ghost"
        className="dim"
        disabled={busy}
        onClick={() => { setErr(''); setMode(reset ? 'signin' : 'reset') }}
      >
        {reset ? t('Sign in with password') : t('Have a reset code from your admin?')}
      </Button>
    </div>
  )
}

export function MobileRegisterSheet({ close, initialUrl = RIT_STUDENT_SERVER, initialCode = '', requireInvite = true }) {
  const registerMobileWithPassword = useStore(s => s.registerMobileWithPassword)
  const targetUrl = initialUrl || RIT_STUDENT_SERVER
  const cleanInitialCode = String(initialCode || '').trim().toUpperCase()
  const [code, setCode] = useState(cleanInitialCode)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [inviteOnly, setInviteOnly] = useState(Boolean(requireInvite))
  const [inviteInfo, setInviteInfo] = useState({ status: 'idle', tenantName: '', studentName: '' })
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
      setInviteInfo({ status: 'idle', tenantName: '', studentName: '' })
      return
    }
    let active = true
    setInviteInfo({ status: 'checking', tenantName: '', studentName: '' })
    const tm = setTimeout(async () => {
      try {
        const { previewRemoteInvite } = await import('../lib/remote.js')
        const data = await previewRemoteInvite(targetUrl, clean)
        if (!active) return
        if (data?.ok) {
          setInviteInfo({ status: 'valid', tenantName: data.tenantName || '', studentName: data.studentName || '' })
          if (data.studentName) setName(prev => prev || data.studentName)
        } else {
          setInviteInfo({ status: 'idle', tenantName: '', studentName: '' })
        }
      } catch (e) {
        if (!active) return
        if (e?.status === 400 || e?.status === 404 || e?.code === 'invite') {
          setInviteInfo({ status: 'invalid', tenantName: '', studentName: '' })
        } else {
          setInviteInfo({ status: 'idle', tenantName: '', studentName: '' })
        }
      }
    }, 250)
    return () => { active = false; clearTimeout(tm) }
  }, [code, targetUrl])

  const submit = async ev => {
    ev.preventDefault()
    if (busy) return
    const n = name.trim()
    const mail = email.trim()
    const cleanCode = code.trim().toUpperCase()
    const bad = inviteOnly && !cleanCode ? 'Informe o código de convite do seu personal ou academia.'
      : inviteInfo.status === 'invalid' ? 'Convite inválido, expirado ou já utilizado.'
      : !n ? t('Enter a name')
      : mail && !looksLikeEmail(mail) ? t('That is not an e-mail address.')
      : [...String(pw || '')].length < MIN_PASSWORD ? t('Use at least {0} characters.', MIN_PASSWORD)
      : pw !== again ? t('The two passwords are not the same.')
      : ''
    if (bad) { setErr(bad); return }
    setBusy(true)
    setErr('')
    try {
      const u = await registerMobileWithPassword(targetUrl, { name: n, password: pw, code: cleanCode, email: mail }, askAddDeviceData)
      rememberStudentNativeMode()
      close()
      useUI.getState().toast(t('Welcome, {0}', u?.name || n))
    } catch (e) {
      setErr(passwordError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="kb-lift">
      <h3>{t('Create your profile')}</h3>
      <div className="muted" style={{ ...NOTE_STYLE, marginBottom: 14 }}>
        Acesso exclusivo para alunos. Informe o código de convite enviado pelo seu personal ou academia.
      </div>
      <form onSubmit={submit} noValidate>
        <input
          ref={codeRef}
          className="input"
          name="invite-code"
          placeholder={inviteOnly ? 'Código de convite (obrigatório)' : t('Invite code')}
          maxLength={40}
          value={code}
          onFocus={onFocus}
          onChange={e => setCode(e.target.value.toUpperCase())}
          {...FIELD_ATTRS}
          style={CODE_STYLE}
        />
        <div
          className={inviteInfo.status === 'invalid' ? '' : 'dim'}
          style={{
            ...NOTE_STYLE,
            marginTop: 6,
            color: inviteInfo.status === 'valid'
              ? 'var(--acc-ink, var(--acc))'
              : inviteInfo.status === 'invalid'
                ? 'var(--red)'
                : undefined
          }}
        >
          {inviteInfo.status === 'checking'
            ? 'Verificando código…'
            : inviteInfo.status === 'valid'
              ? `Código válido${inviteInfo.tenantName ? ` · ${inviteInfo.tenantName}` : ''}`
              : inviteInfo.status === 'invalid'
                ? 'Convite inválido, expirado ou já utilizado.'
                : inviteOnly
                  ? 'Obrigatório. Peça o código de convite ao seu personal trainer ou academia.'
                  : 'Opcional. Informe se recebeu um código do seu personal ou academia.'}
        </div>
        <div style={{ height: 10 }} />
        <input
          ref={nameRef}
          className="input"
          name="username"
          autoComplete="username"
          placeholder={t('Your name')}
          maxLength={40}
          value={name}
          onFocus={onFocus}
          onChange={e => setName(e.target.value)}
          {...FIELD_ATTRS}
        />
        <div style={{ height: 10 }} />
        <input
          className="input"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          placeholder={t('E-mail (optional)')}
          maxLength={254}
          value={email}
          onFocus={onFocus}
          onChange={e => setEmail(e.target.value)}
          {...FIELD_ATTRS}
        />
        <div className="dim" style={{ ...NOTE_STYLE, marginTop: 6 }}>
          {t('Lets you sign in with it instead of your name. Nothing is ever sent to it.')}
        </div>
        <div style={{ height: 10 }} />
        <PasswordField
          name="new-password"
          autoComplete="new-password"
          placeholder={t('Password')}
          value={pw}
          onFocus={onFocus}
          onChange={e => setPw(e.target.value)}
        />
        <div style={{ height: 10 }} />
        <PasswordField
          name="new-password-again"
          autoComplete="new-password"
          placeholder={t('Repeat the password')}
          value={again}
          onFocus={onFocus}
          onChange={e => setAgain(e.target.value)}
        />
        <div className="dim" style={{ ...NOTE_STYLE, marginTop: 6 }}>
          {t('At least {0} characters. A few unrelated words make a good one.', MIN_PASSWORD)}
        </div>
        {err && <div role="alert" style={ERR_STYLE}>{err}</div>}
        <div style={{ height: 12 }} />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t('Connecting…') : t('Create profile')}
        </Button>
      </form>
    </div>
  )
}

export const openMobileSignIn = (opts = {}) =>
  useUI.getState().openSheet(close => <MobilePasswordSignInSheet close={close} {...opts} />)

export const openMobileRegister = (opts = {}) =>
  useUI.getState().openSheet(close => <MobileRegisterSheet close={close} {...opts} />)
