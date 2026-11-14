import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { webauthnOK, passkeyLogin, passkeyRegister, passkeyError, bio } from '../lib/api.js'
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
import InstallPwaBanner from '../components/InstallPwaBanner.jsx'

function RegisterSheet({ close }) {
  const { setUser, pushState, pullState, loadConfig } = useStore()
  const config = useStore(s => s.config)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const inviteOnly = !!config?.invite_only
  // A password is offered only where the instance allows it (#118), and is the only choice in a
  // browser that cannot make a passkey. Where both work, the passkey stays the first one (except
  // on custom B2B gym tenants where students receive a password at enrollment).
  const pwOn = passwordOn(config)
  const branding = useBranding()
  const [how, setHow] = useState(
    !webauthnOK() || (branding.isCustomTenant && pwOn) ? 'password' : 'passkey'
  )
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])
  // Boot already fetched this; retry here only if that attempt failed, so the invite field still
  // appears on an instance whose config arrived late rather than never.
  useEffect(() => { loadConfig() }, [loadConfig])
  const go = async () => {
    if (busyRef.current) return
    const n = name.trim()
    if (!n) { useUI.getState().toast(t('Enter a name')); return }
    if (inviteOnly && !code.trim()) { useUI.getState().toast(t('An invite code is required')); return }
    busyRef.current = true
    setBusy(true)
    try {
      const u = await passkeyRegister(n, code.trim())
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
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Pick a name and a password. You sign in with both.')}</div>
    <PasswordRegisterForm close={close} inviteOnly={inviteOnly} name={name} setName={setName} code={code} setCode={setCode} />
  </>
  return <>
    <h3>{t('Create your profile')}</h3>
    {choose}
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Pick a name, then confirm with {0}. The passkey lives on your device, so no password needed.', bio())}</div>
    <input ref={ref} className="input" placeholder={t('Your name')} maxLength={40} value={name} onChange={e => setName(e.target.value)} />
    {inviteOnly && <>
      <div style={{ height: 10 }} />
      <input className="input" placeholder={t('Invite code')} maxLength={40} value={code}
        onChange={e => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }} />
      <div className="dim small" style={{ marginTop: 6 }}>{t('This app is invite-only. Enter the code you were given.')}</div>
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
  const register = () => useUI.getState().openSheet(close => <RegisterSheet close={close} />)
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
        <img src={isLightTheme ? './rit-logo-light.png' : './rit-logo.png'} alt="Rit" style={{ height: 52, width: 'auto', objectFit: 'contain' }} />
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

  return (
    <div className="narrow" style={wrap}>
      {head}
      <div className="muted" style={{ marginBottom: lastUser ? 20 : 34 }}>{subText}</div>
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
            👋 {t('Olá, {0}!', lastUser.split(' ')[0])}
          </span>
        </div>
      )}
      {webauthnOK() ? <>
        {pwOn ? (
          <>
            <Button variant="primary" icon="key" onClick={() => openPasswordSignIn()}>{t('Sign in with password')}</Button>
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
        <Button variant="primary" icon="key" onClick={() => openPasswordSignIn()}>{t('Sign in with password')}</Button>
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
      <div className="dim small" style={{ marginTop: 22, lineHeight: 1.5 }}>{pwOn ? t('Passkeys use {0}. A password works too, where passkeys do not.', bio()) : t('Passkeys use {0}. No passwords to remember.', bio())}<br />{t('Each profile keeps its own plan, workouts & body weight.')}</div>
    </div>
  )
}
