import { t } from '../lib/i18n.js'
import { MOBILE } from '../lib/mobile.js'
import { getDeferredInstallPrompt, runNativeInstallPrompt, usePwaInstall } from '../lib/pwa-install.js'
import { useUI } from '../store/useUI.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

export function PwaGuideSheet({ close, appName = 'Rit' }) {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : ''
  const isIOS = /iPhone|iPad|iPod/i.test(ua)
  const isAndroidBrowser = /Android/i.test(ua)

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>{t('Install {0} on your phone', appName)}</h3>
      <div className="muted small" style={{ marginBottom: 14, lineHeight: 1.5 }}>
        {t('Add the app to your home screen to open full-screen, get alerts and check workouts even offline.')}
      </div>

      {isIOS ? (
        <div className="card" style={{ padding: 14, marginBottom: 14, textAlign: 'start', lineHeight: 1.6 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>{t('On iPhone / iPad (Safari):')}</div>
          <div className="small">{t('1. Tap Share (square with up arrow) in Safari’s bottom bar.')}</div>
          <div className="small" style={{ marginTop: 6 }}>{t('2. Scroll down and tap “Add to Home Screen”.')}</div>
          <div className="small" style={{ marginTop: 6 }}>{t('3. Tap Add in the top right corner.')}</div>
        </div>
      ) : (
        <div className="card" style={{ padding: 14, marginBottom: 14, textAlign: 'start', lineHeight: 1.6 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            {isAndroidBrowser ? t('On Android (Chrome):') : t('In Chrome or Edge: the install icon in the address bar')}
          </div>
          <div className="small">
            {isAndroidBrowser
              ? t('Tap the ⋮ menu at the top right and choose “Install app” or “Add to Home screen”.')
              : t('Use the install icon in your browser address bar, or open the browser menu and select “Install app”.')}
          </div>
          {!isAndroidBrowser && (
            <div className="small" style={{ marginTop: 8 }}>
              {t('On iPhone / iPad (Safari):')} {t('In Safari: Share → Add to Home Screen')}
            </div>
          )}
        </div>
      )}

      <Button variant="primary" onClick={close}>{t('Got it')}</Button>
    </div>
  )
}

export async function triggerPwaInstall(appName = 'Rit') {
  if (getDeferredInstallPrompt()) {
    const status = await runNativeInstallPrompt()
    if (status === 'accepted' || status === 'dismissed') return status
  }
  useUI.getState().openSheet(close => <PwaGuideSheet close={close} appName={appName} />)
  return 'guide'
}

export default function InstallPwaBanner({ compact = false }) {
  const { appName, standalone } = usePwaInstall()

  if (MOBILE || standalone || (typeof process !== 'undefined' && process.env.NODE_ENV === 'test')) return null

  return (
    <div style={{ marginTop: compact ? 8 : 12 }}>
      <button
        type="button"
        onClick={() => triggerPwaInstall(appName)}
        className="btn ghost sm"
        style={{
          width: '100%',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          border: '1px dashed var(--line-2, rgba(255,255,255,0.16))',
          borderRadius: 12,
          padding: '10px 14px',
          fontWeight: 600,
          color: 'var(--acc-ink, #a3e635)'
        }}
      >
        <span><Icon name="download" /> {t('Install {0} on your phone', appName)}</span>
      </button>
    </div>
  )
}
