import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api, webauthnOK, passkeyLogin, passkeyRegister, passkeyError, bio } from '../lib/api.js'
import { hasData } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { DEMO, REPO } from '../lib/demo.js'
import { guestAllowed } from '../lib/guest.js'
import { useState, useRef, useEffect } from 'react'
import Icon from '../components/Icon.jsx'
import { Button, Segmented } from '../components/ui.jsx'
import { askAddDeviceData } from '../sheets.jsx'
import { passwordOn, PasswordRegisterForm, openPasswordSignIn } from '../components/PasswordAuth.jsx'
import { openDeviceLinkRedeem } from '../components/Passkeys.jsx'
import { openLostAccess } from '../components/LostAccess.jsx'
import { useBranding } from '../lib/branding.js'
import { MOBILE } from '../lib/mobile.js'
import { buildAndroidAppIntentUrl } from '../lib/rit-native.js'
import InstallPwaBanner from '../components/InstallPwaBanner.jsx'

function readInviteCodeFromUrl() {
  if (typeof window === 'undefined') return ''
  try {
    const sp = new URLSearchParams(window.location.search)
    const raw = sp.get('convite') || sp.get('invite') || sp.get('code') || ''
    return String(raw).trim().toUpperCase().slice(0, 40)
  } catch {
    return ''
  }
}

function clearInviteFromUrl() {
  if (typeof window === 'undefined' || !window.history?.replaceState) return
  try {
    const u = new URL(window.location.href)
    u.searchParams.delete('convite')
    u.searchParams.delete('invite')
    u.searchParams.delete('code')
    if (/\/cadastro\/?$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/cadastro\/?$/i, '') || '/'
    }
    window.history.replaceState({}, '', u.pathname + u.search + u.hash)
  } catch { /* ignore */ }
}

function RegisterSheet({ close, initialCode = '' }) {
  const { setUser, pushState, pullState, loadConfig } = useStore()
  const config = useStore(s => s.config)
  const cleanInitialCode = String(initialCode || '').trim().toUpperCase()
  const [name, setName] = useState('')
  const [inviteEmail, setInviteEmail] = useState('')
  const [code, setCode] = useState(cleanInitialCode)
  const inviteOnly = !!config?.invite_only
  const showCodeField = inviteOnly || Boolean(cleanInitialCode) || Boolean(String(code || '').trim())
  // A password is offered only where the instance allows it (#118), and is the only choice in a
  // browser that cannot make a passkey. Where both work, the passkey stays the first one (except
  // on custom B2B gym tenants where students receive a password at enrollment).
  const pwOn = passwordOn(config)
  const branding = useBranding()
  const [how, setHow] = useState(
    !webauthnOK() || ((branding.isCustomTenant || Boolean(cleanInitialCode)) && pwOn) ? 'password' : 'passkey'
  )
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])
  // Boot already fetched this; retry here only if that attempt failed, so the invite field still
  // appears on an instance whose config arrived late rather than never.
  useEffect(() => { loadConfig() }, [loadConfig])
  useEffect(() => {
    if (!cleanInitialCode) return
    let active = true
    api(`/api/invite/preview?code=${encodeURIComponent(cleanInitialCode)}`)
      .then(data => {
        if (!active) return
        if (data?.studentName) setName(prev => prev || data.studentName)
        if (data?.studentEmail) setInviteEmail(prev => prev || data.studentEmail)
      })
      .catch(() => { /* ignore preview errors; server validates on submit */ })
    return () => { active = false }
  }, [cleanInitialCode])
  const go = async () => {
    if (busyRef.current) return
    const n = name.trim()
    if (!n) { useUI.getState().toast(t('Enter a name')); return }
    if (inviteOnly && !code.trim()) { useUI.getState().toast(t('An invite code is required')); return }
    busyRef.current = true
    setBusy(true)
    try {
      const u = await passkeyRegister(n, code.trim())
      clearInviteFromUrl()
      setUser(u); close()
      if (hasData(useStore.getState().S)) { await pushState(); useUI.getState().toast(t('Profile created, and this device’s data moved into it')) }
      else { await pullState(); useUI.getState().toast(t('Welcome, {0}', u.name)) }
    } catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') useUI.getState().toast(passkeyError(e, t('Registration failed'))) }
    finally { busyRef.current = false; setBusy(false) }
  }
  const choose = pwOn && webauthnOK() && <>
    <Segmented options={[{ value: 'passkey', label: t('Passkey'), icon: 'fingerprint' }, { value: 'password', label: t('Password'), icon: 'key' }]}
      value={how} onChange={setHow} />
    <div style={{ height: 12 }} />
  </>
  if (pwOn && how === 'password') return <>
    <h3>{t('Create your profile')}</h3>
    {choose}
    <div className="muted small" style={{ marginBottom: 14 }}>Crie sua conta com seu nome, e-mail e código de convite do professor.</div>
    <PasswordRegisterForm
      close={close}
      inviteOnly={inviteOnly}
      name={name}
      setName={setName}
      code={code}
      setCode={setCode}
      initialEmail={inviteEmail}
      forceShowCode={Boolean(cleanInitialCode)}
      requireEmailOtp={true}
      onRegistered={clearInviteFromUrl}
    />
  </>
  return <>
    <h3>{t('Create your profile')}</h3>
    {choose}
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Pick a name, then confirm with {0}. The passkey lives on your device, so no password needed.', bio())}</div>
    <input ref={ref} className="input" placeholder={t('Your name')} maxLength={40} value={name} onChange={e => setName(e.target.value)} />
    {showCodeField && <>
      <div style={{ height: 10 }} />
      <input className="input" placeholder={t('Invite code')} maxLength={40} value={code}
        onChange={e => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }} />
      <div className="dim small" style={{ marginTop: 6 }}>
        {inviteOnly ? t('This app is invite-only. Enter the code you were given.') : t('Invite code linked to your gym profile.')}
      </div>
    </>}
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={go} disabled={busy}>{t('Create passkey')}</Button>
  </>
}

export default function Login() {
  const { setUser, adoptProfile, setGuest } = useStore()
  const config = useStore(s => s.config)
  const canGuest = guestAllowed(config)
  const pwOn = passwordOn(config)
  const [signingIn, setSigningIn] = useState(false)
  const signInRef = useRef(false)
  const autoOpenedInviteRef = useRef(false)
  useEffect(() => {
    if (DEMO || autoOpenedInviteRef.current) return
    const urlInvite = readInviteCodeFromUrl()
    if (!urlInvite) return
    autoOpenedInviteRef.current = true
    useUI.getState().openSheet(close => <RegisterSheet close={close} initialCode={urlInvite} />)
  }, [])
  const register = () => useUI.getState().openSheet(close => <RegisterSheet close={close} initialCode={readInviteCodeFromUrl()} />)
  const signIn = async () => {
    if (signInRef.current) return
    signInRef.current = true
    setSigningIn(true)
    try {
      const u = await passkeyLogin();
      try { if (u?.name) localStorage.setItem('rit_last_username', u.name) } catch { /* ignore */ }
      setUser(u, { adopt: true });
      await adoptProfile(askAddDeviceData);
      useUI.getState().toast(t('Welcome back, {0}', u.name))
    }
    catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') useUI.getState().toast(passkeyError(e, t('Sign-in failed'))) }
    finally { signInRef.current = false; setSigningIn(false) }
  }
  const lastUser = typeof localStorage !== 'undefined' ? (localStorage.getItem('rit_last_username') || '') : ''
  const branding = useBranding()
  const titleText = branding.isCustomTenant && branding.gymName ? branding.gymName : 'Rit'
  const subText = branding.isCustomTenant && branding.slogan ? branding.slogan : t('Your workouts. Your weights. Your profile.')
  const isLightTheme = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light'
  const head = <>
    {branding.isCustomTenant && branding.logoUrl && !branding.logoUrl.startsWith('blob:') ? (
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <img src={branding.logoUrl} alt="" style={{ width: 64, height: 64, borderRadius: 16, objectFit: 'cover' }} />
      </div>
    ) : !branding.isCustomTenant ? (
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 4 }}>
        <img src={DEMO && isLightTheme ? './rit-logo-light.png' : './rit-logo.png'} alt="Rit" style={{ height: 42, width: 'auto', objectFit: 'contain' }} />
      </div>
    ) : (
      <div style={{ fontSize: 54, display: 'flex', justifyContent: 'center', color: 'var(--acc-ink)' }}><Icon name="dumbbell" /></div>
    )}
    <h1 className="t-large" style={{ fontWeight: 700, margin: '10px 0 4px', ...(branding.isCustomTenant ? {} : { display: 'none' }) }}>{titleText}</h1>
  </>
  const wrap = { display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: '78vh', textAlign: 'center' }

  // Demo build: no backend to sign in against — the only way in is the local guest profile.
  if (DEMO) return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: 30 }}>{t('Live demo. Everything stays in this browser.')}</div>
      <Button variant="primary" icon="play" onClick={() => setGuest(true)}>{t('Start the demo')}</Button>
      <div className="card small muted" style={{ textAlign: 'start', marginTop: 16 }}>
        {t('Ambiente de demonstração. Seus dados de treino ficam salvos no navegador para você testar todos os recursos do Rit.')}
      </div>
    </div>
  )

  const isAndroidBrowser = !MOBILE && typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '')
  const hasUrlInviteOrTenant = typeof window !== 'undefined' && (
    Boolean(readInviteCodeFromUrl()) ||
    /\/cadastro/i.test(window.location.pathname || '') ||
    /[?&]tenant=/i.test(window.location.search || '')
  )

  return (
    <div className="narrow" style={{ paddingTop: 12, paddingBottom: 18 }}>
      <div className="rit-auth-shell" style={wrap}>
        <div>
          <div style={{ paddingTop: 12, marginBottom: 22 }}>
            {head}
          </div>
          <div className="muted" style={{ marginBottom: lastUser ? 16 : 24, fontSize: 15 }}>{subText}</div>
          {isAndroidBrowser && hasUrlInviteOrTenant && (
            <div
              className="card"
              style={{
                marginBottom: 18,
                padding: 14,
                border: '1px solid color-mix(in srgb, var(--acc) 35%, transparent)',
                background: 'color-mix(in srgb, var(--acc) 10%, var(--card))',
                textAlign: 'center'
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                Já tem o aplicativo Rit instalado no celular?
              </div>
              <a
                href={buildAndroidAppIntentUrl()}
                className="rit-auth-pill"
                style={{ textDecoration: 'none' }}
              >
                📲 Abrir direto no Aplicativo Rit
              </a>
            </div>
          )}
          {lastUser && (
            <div style={{ marginBottom: 18 }}>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: 'color-mix(in srgb, var(--acc) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--acc) 28%, transparent)',
                color: 'var(--acc-ink, var(--acc))',
                padding: '5px 14px',
                borderRadius: 20,
                fontSize: '.92rem',
                fontWeight: 600
              }}>
                👋 {t('Olá, {0}!', lastUser.split(' ')[0].split('@')[0])}
              </span>
            </div>
          )}
        </div>
        <div>
          {webauthnOK() ? <>
            {pwOn ? (
              <>
                <Button variant="primary" icon="key" onClick={() => openPasswordSignIn(undefined, { requireEmailOtp: true })}>{t('Sign in with password')}</Button>
                <div style={{ height: 10 }} />
                <Button icon="fingerprint" onClick={signIn} disabled={signingIn}>{t('Sign in with passkey')}</Button>
                <div style={{ height: 10 }} />
              </>
            ) : (
              <>
                <Button variant="primary" icon="fingerprint" onClick={signIn} disabled={signingIn}>{t('Sign in with passkey')}</Button>
                <div style={{ height: 10 }} />
              </>
            )}
            <Button icon="plusCircle" onClick={register}>{t('Create new profile')}</Button>
            {/* Already signed in on another device: a code from there gives this one a passkey of
                its own (#95), instead of a new, empty profile. */}
            <div style={{ height: 10 }} />
            <Button variant="ghost" className="dim" icon="qr" onClick={openDeviceLinkRedeem}>{t('Use a code from your other device')}</Button>
            {/* No device signs you in any more (#584): what to try, and where a recovery code goes. */}
            <Button variant="ghost" className="dim" onClick={openLostAccess}>{t('Lost access?')}</Button>
            {canGuest && <div style={{ height: 4 }} />}
          </> : pwOn ? <>
            {/* Plain http on a LAN address, or a browser without passkey support: the password is
                the way in, and the only way to create a profile from here. */}
            <div className="card small muted" style={{ textAlign: 'start', marginBottom: 14 }}>{t("This browser doesn't support passkeys. Sign in with your name and password instead.")}</div>
            <Button variant="primary" icon="key" onClick={() => openPasswordSignIn(undefined, { requireEmailOtp: true })}>{t('Sign in with password')}</Button>
            <div style={{ height: 10 }} />
            <Button icon="plusCircle" onClick={register}>{t('Create new profile')}</Button>
            <Button variant="ghost" className="dim" onClick={openLostAccess}>{t('Lost access?')}</Button>
            {canGuest && <div style={{ height: 10 }} />}
          </> : <div className="card small muted" style={{ textAlign: 'start' }}>{canGuest
            ? t("This browser doesn't do passkeys, but you can still use openGym locally on this device.").replace(/\bopenGym\b/g, 'Rit')
            // Without passkeys and without the guest entrance there is no way in from this browser,
            // so say that plainly instead of offering a local profile that cannot be created.
            : t("This browser doesn't support passkeys, and this instance requires an account. Try a browser or device with passkey support.")}</div>}
          {canGuest && <Button variant="ghost" className="dim" onClick={() => setGuest(true)}>{t('Continue without account')}</Button>}
          <InstallPwaBanner />
          {branding.isCustomTenant && branding.contactPhone && (
            <div style={{ marginTop: 14 }}>
              <a
                href={`https://wa.me/${(() => { const d = String(branding.contactPhone).replace(/\D/g, '').replace(/^00/, ''); return (d.length === 10 || d.length === 11) ? '55' + d : d })()}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn ghost sm dim"
                style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <span>Dúvidas no acesso? Falar no WhatsApp</span>
              </a>
            </div>
          )}
          <div className="dim small" style={{ marginTop: 18, lineHeight: 1.5 }}>{pwOn ? t('Passkeys use {0}. A password works too, where passkeys do not.', bio()) : t('Passkeys use {0}. No passwords to remember.', bio())}<br />{t('Each profile keeps its own plan, workouts & body weight.')}</div>
        </div>
      </div>
    </div>
  )
}
