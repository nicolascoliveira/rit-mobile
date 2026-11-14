// The sheet every shared picture goes out through: a preview of the picture, 9:16 or 1:1, dark or
// light, and Share. The workout card (after a workout, and in History) and Your year both use it,
// so a picture looks and leaves the same way wherever it was made. The picture is drawn on the
// device (`render`), shown before it goes anywhere, and handed to the share sheet as a PNG.
import { useEffect, useRef, useState } from 'react'
import { t } from '../lib/i18n.js'
import { Button, Segmented } from './ui.jsx'
import { shareImage } from '../lib/share-image.js'
import { FORMAT_IDS, STYLE_IDS } from '../lib/card-draw.js'
import { useBranding } from '../lib/branding.js'

// The last format and look picked, per device: a person who posts Stories keeps posting Stories.
const PREF = 'og_share_card'
function readPref() {
  try {
    const v = JSON.parse(localStorage.getItem(PREF) || '{}')
    return { format: FORMAT_IDS.includes(v.format) ? v.format : 'story', style: STYLE_IDS.includes(v.style) ? v.style : 'dark' }
  } catch (e) { return { format: 'story', style: 'dark' } }
}
function writePref(p) { try { localStorage.setItem(PREF, JSON.stringify(p)) } catch (e) { /* no storage: not remembered */ } }

/**
 * `render({ format, style })` resolves to a PNG blob (or null when it could not be drawn); `deps`
 * are what else should redraw it (a switch in `children`). `name` is the file name, `shareTitle`
 * what the share sheet is told it is.
 */
export default function ShareCardSheet({ title, render, deps = [], name, shareTitle, close, toast, children }) {
  const branding = useBranding()
  const [pref, setPref] = useState(readPref)
  const [img, setImg] = useState(null)
  const [busy, setBusy] = useState(false)
  const shown = useRef(null)
  const set = patch => setPref(p => { const next = { ...p, ...patch }; writePref(next); return next })
  useEffect(() => {
    let alive = true
    Promise.resolve()
      .then(() => render(pref))
      .then(blob => {
        if (!alive) return
        if (!blob) { setImg(prev => ({ ...prev, failed: true })); return }
        // The last picture stays up while the next one is drawn, so a toggle never blanks the sheet.
        if (shown.current) URL.revokeObjectURL(shown.current)
        shown.current = URL.createObjectURL(blob)
        setImg({ blob, url: shown.current })
      })
      .catch(() => { if (alive) setImg(prev => ({ ...prev, failed: true })) })
    return () => { alive = false }
  }, [pref.format, pref.style, branding?.gymName, branding?.logoUrl, branding?.primaryColor, ...deps]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (shown.current) URL.revokeObjectURL(shown.current) }, [])
  const share = async () => {
    setBusy(true)
    await shareImage(img.blob, name, shareTitle, toast)
    setBusy(false)
    close?.()
  }
  const downloadDirect = () => {
    if (!img?.blob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(img.blob)
    a.download = name || 'rit-story-workout.png'
    a.click()
    URL.revokeObjectURL(a.href)
    toast?.(t('Image saved'))
  }
  return <>
    <h3>{title}</h3>
    {branding?.isCustomTenant && branding?.gymName && (
      <div className="small muted" style={{ marginBottom: 8 }}>
        ✨ Card oficial <b>{branding.gymName}</b> pronto para Stories e Status
      </div>
    )}
    <div className={'share-card share-' + pref.format}>
      {img?.url
        ? <img src={img.url} alt={t('Preview of the image to share')} />
        : img?.failed ? <div className="share-card-ph small muted">{t('Could not create the image')}</div>
          : <div className="share-card-ph" aria-hidden="true" />}
    </div>
    <div className="share-opts">
      <Segmented value={pref.format} onChange={format => set({ format })}
        options={[{ value: 'story', label: t('Story 9:16') }, { value: 'square', label: t('Square 1:1') }]} />
      <Segmented value={pref.style} onChange={style => set({ style })}
        options={[{ value: 'dark', icon: 'moon', label: t('Dark') }, { value: 'light', icon: 'sun', label: t('Light') }]} />
    </div>
    {children}
    <div style={{ display: 'flex', gap: 8 }}>
      <div style={{ flex: 1 }}>
        <Button variant="primary" icon="share" disabled={!img?.blob || busy} onClick={share}>{t('Share')}</Button>
      </div>
      <Button variant="tinted" icon="download" disabled={!img?.blob || busy} onClick={downloadDirect} aria-label={t('Download')}>
        PNG
      </Button>
    </div>
  </>
}
