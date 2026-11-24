import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { pushSupported, enablePush } from '../lib/push.js'
import { effectiveRoutines, effectiveRoutineIds, nextTrainingDay, lastBW, setsDoneActive } from '../lib/history.js'
import { streakInfo } from '../lib/streak.js'
import { StreakFlame, StreakMeta, StreakParty } from '../components/Streak.jsx'
import { fmtNum, fmtDate, todayISO, isoOf, weekStartOf, weekDayOffset, DAYS, DAYN } from '../lib/format.js'
import { t, tn, dateLocale } from '../lib/i18n.js'
import { bwSheet, goalSheet, dayOverrideSheet, calendarSheet, startFlow, starterPlanSheet, bwDeltaColor, weighInsSheet } from '../sheets.jsx'
import LineChart from '../components/LineChart.jsx'
import Icon from '../components/Icon.jsx'
import CardHead from '../components/CardHead.jsx'
import QueueRow from '../components/QueueRow.jsx'
import MiniBodyMap from '../components/MiniBodyMap.jsx'
import { queueOf, queueView, weekTally, pinState } from '../lib/queue.js'
import { workoutsLeft } from '../lib/week-left.js'
import { WeeklySetsHomeLine } from '../components/WeeklySets.jsx'
import { RecapHomeCard } from '../components/Recap.jsx'
import { scheduleModeOf } from '../lib/rotation.js'
import { useConnectionTrouble } from '../components/SyncBanner.jsx'
import { Button } from '../components/ui.jsx'
import { tappable } from '../lib/use-sheet-keyboard.js'
import { glyphOf } from '../lib/glyphs.js'
import { dayNoteOf } from '../lib/day-notes.js'
import { weighInAt } from '../lib/bodyweight.js'
import WeightRate from '../components/WeightRate.jsx'
import { programmeChip } from '../lib/programmes.js'
import { SeasonDeco } from '../components/Seasonal.jsx'
import { WrappedHomeCard } from '../components/WrappedEntry.jsx'
import RecoveryHint from '../components/RecoveryHint.jsx'
import { ChallengesCard } from '../components/Challenges.jsx'
import { isOn } from '../lib/modules.js'
import { useBranding } from '../lib/branding.js'
import InstallPwaBanner from '../components/InstallPwaBanner.jsx'

// Home = what to do now + a quick glance. Deep charts & history live in Stats.
export default function Home() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  const branding = useBranding()
  // The banner switched off and the sync stuck: a dot on the gear (Settings → Show connection status).
  const trouble = useConnectionTrouble()
  const [weekOffset, setWeekOffset] = useState(0)
  const toast = useUI(s => s.toast)
  const [pushDismissed, setPushDismissed] = useState(() => {
    try { return localStorage.getItem('rit_push_prompt_dismissed') === '1' } catch { return false }
  })
  const [pushBusy, setPushBusy] = useState(false)
  const [pushGranted, setPushGranted] = useState(() =>
    typeof Notification !== 'undefined' ? Notification.permission === 'granted' : false
  )
  const canAskPush = Boolean(
    user &&
    !pushDismissed &&
    !pushGranted &&
    pushSupported() &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'default'
  )
  const handleActivatePush = async () => {
    if (pushBusy) return
    setPushBusy(true)
    try {
      await enablePush()
      setPushGranted(true)
      try { localStorage.setItem('rit_push_prompt_dismissed', '1') } catch { /* ignore */ }
      toast('Notificações ativadas neste celular!')
    } catch (e) {
      toast(e?.message || 'Não foi possível ativar as notificações')
      if (typeof Notification !== 'undefined' && Notification.permission !== 'default') {
        setPushDismissed(true)
      }
    } finally {
      setPushBusy(false)
    }
  }
  const dismissPushPrompt = () => {
    setPushDismissed(true)
    try { localStorage.setItem('rit_push_prompt_dismissed', '1') } catch { /* ignore */ }
  }
  const [seenNoticeId, setSeenNoticeId] = useState(() => {
    try { return localStorage.getItem('rit_seen_prescription_id') || '' } catch { return '' }
  })
  const pNotice = S?.prescriptionNotice
  const showPrescriptionNotice = Boolean(pNotice?.id && pNotice.id !== seenNoticeId)
  const dismissPrescriptionNotice = () => {
    if (!pNotice?.id) return
    setSeenNoticeId(pNotice.id)
    try { localStorage.setItem('rit_seen_prescription_id', pNotice.id) } catch { /* ignore */ }
  }
  const [seenReviewAt, setSeenReviewAt] = useState(() => {
    try { return Number(localStorage.getItem('rit_seen_video_review_at') || 0) } catch { return 0 }
  })
  const latestVideoReview = (() => {
    const map = S?.videoReviews
    if (!map || typeof map !== 'object') return null
    const list = Object.values(map).filter(r => r && r.comment && Number(r.at) > 0)
    if (!list.length) return null
    list.sort((a, b) => Number(b.at) - Number(a.at))
    return list[0]
  })()
  const showVideoReviewNotice = Boolean(latestVideoReview?.at && Number(latestVideoReview.at) > seenReviewAt)
  const dismissVideoReviewNotice = () => {
    if (!latestVideoReview?.at) return
    const ts = Number(latestVideoReview.at)
    setSeenReviewAt(ts)
    try { localStorage.setItem('rit_seen_video_review_at', String(ts)) } catch { /* ignore */ }
  }
  useEffect(() => {
    if (!pNotice?.id || typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    let alreadyNotified = ''
    try { alreadyNotified = localStorage.getItem('rit_notified_prescription_id') || '' } catch { /* ignore */ }
    if (alreadyNotified === pNotice.id || seenNoticeId === pNotice.id) return
    try { localStorage.setItem('rit_notified_prescription_id', pNotice.id) } catch { /* ignore */ }
    const names = Array.isArray(pNotice.routineNames) ? pNotice.routineNames.join(', ') : ''
    const sender = pNotice.trainerName ? `Prof. ${pNotice.trainerName}` : 'Sua academia'
    navigator.serviceWorker.ready.then(reg => reg.showNotification(
      (pNotice.routineNames?.length || 0) > 1
        ? `📋 ${pNotice.routineNames.length} novas fichas liberadas no Rit!`
        : '📋 Nova ficha liberada no Rit!',
      {
        body: names ? `${sender} atualizou seu plano: ${names}. Toque para conferir!` : `${sender} atualizou seu plano de treino.`,
        icon: 'icon-512.png',
        badge: 'icon-180.png',
        tag: 'prescription-update',
        renotify: true
      }
    )).catch(() => { })
  }, [pNotice?.id, seenNoticeId])

  const today = new Date()
  // A weekday can hold several routines. `todayRoutines` is the whole day; `routine` is the
  // first, kept for the one-routine glyph. The derived session name joins them (§9).
  const todayRoutines = effectiveRoutines(S, todayISO())
  const routine = todayRoutines[0] || null
  const todayName = todayRoutines.map(r => r.name).join(' + ')
  // A fulfilled pin (a coach session pinned to today and since done) reads as no override.
  const todayOvr = S.dayPlan[todayISO()] !== undefined && pinState(S, S.dayPlan[todayISO()]) !== 'done'
  // An open editor on a saved workout (lib/session-edit.js) holds S.active too, but it is not a
  // session in progress: the row takes you back to it as an edit, the way the tab bar does.
  const editingSaved = !!S.active?.editingWorkoutId
  const bw = lastBW(S)
  const prevBW = S.bodyweight.length > 1 ? S.bodyweight[S.bodyweight.length - 2] : null
  const delta = bw && prevBW ? bw.w - prevBW.w : null

  const ws = weekStartOf(S)
  // The first day of the shown week. Named for the role, not for Monday — which day that is
  // is the setting.
  const wkStart = new Date(today)
  wkStart.setDate(today.getDate() - weekDayOffset(today.getDay(), ws) + weekOffset * 7)
  const doneDays = new Set(S.workouts.map(w => w.d))
  // The last session logged for today, if any — what the row below reports instead of asking
  // you to start the one you already did. Last wins, so a second session names itself. Only once
  // today's plan is covered, though: a freestyle session on a planned day, or the rotation's
  // first session done when its next one is today's too, leaves the row offering what is still
  // to do, as Start and the progress row already do. A queue session is never "covered" by an
  // earlier workout: the queue only names one it does not count as done yet.
  const loggedToday = S.workouts.filter(w => w.d === todayISO())
  const queueIds = queueOf(S)?.ids || []
  const coveredToday = id => !queueIds.includes(id) && loggedToday.some(w => (Array.isArray(w.routineIds) ? w.routineIds : [w.routineId]).includes(id))
  const doneToday = (todayRoutines.every(r => coveredToday(r.id)) && loggedToday.at(-1)) || null
  const strip = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(wkStart); d.setDate(wkStart.getDate() + i)
    const iso = isoOf(d)
    const eff = effectiveRoutineIds(S, iso).length > 0, ovr = S.dayPlan[iso] !== undefined, done = doneDays.has(iso)
    // A day off with a note (#261) reads as excused, not as a plan that went by.
    const dot = done ? ' done' : dayNoteOf(S, iso) ? ' noted' : ovr && eff ? ' ovr' : eff ? ' plan' : ''
    strip.push(<div key={i} className={'wday' + (iso === todayISO() ? ' today' : '')} {...tappable(() => dayOverrideSheet(iso))}>
      <div className="lbl">{t(DAYS[d.getDay()])}</div><div className="num">{d.getDate()}</div><div className={'dot' + dot} /></div>)
  }
  const wkEnd = new Date(wkStart); wkEnd.setDate(wkStart.getDate() + 6)
  const wkLabel = weekOffset === 0 ? t('This week') : `${wkStart.getDate()} ${wkStart.toLocaleDateString(dateLocale(), { month: 'short' })} – ${wkEnd.getDate()} ${wkEnd.toLocaleDateString(dateLocale(), { month: 'short' })}`

  // A coach week (S.queue) read through the same tolerant reader QueueRow uses, so a malformed
  // queue from another client shows the weekday dots, never an empty card.
  const queue = queueView(S, todayISO())
  // This card shows one thing or the other — QueueRow for a live queue, or Rotation chosen with
  // nothing built yet (S.scheduleMode), in which case there is no queue for QueueRow to render and
  // an empty-state card takes its place. Plan does the same in rotation mode: no weekday grid, only
  // the days that add a routine the loop does not have (Plan.jsx, "Also on fixed days").
  const rotating = scheduleModeOf(S) === 'rotation'
  // A planner-written queue (no rotationId) still names its weekday when it hasn't started yet —
  // that copy predates rotation and stays as it is. Our own rotation has no weekday of its own
  // (lib/rotation.js): naming one here — including on the pass's own one-day empty gap (THE
  // ONE-DAY BOUNDARY, rotation.js) or before a first routine is even added — would be the
  // fixed-week model leaking into a schedule that was never weekday-based.
  const liveQ = queueOf(S)
  const plannerQueue = !!queue && !liveQ?.rotationId
  // Ownership, not mere presence of a rotationId: a stale id left over from a rebuilt rotation
  // would otherwise still read as "this app manages it" (lib/rotation.js).
  const managedQueue = !!liveQ && !!S.rotation && liveQ.rotationId === S.rotation.id
  // On a rest day, saying when you train next beats leaving the row as a full stop.
  const next = !S.active && !todayRoutines.length && !(rotating && !plannerQueue) ? nextTrainingDay(S, todayISO()) : null
  // The streak card's fraction: this calendar week's workouts over the weekdays with a plan, or,
  // in a coach week, the queue's sessions and your own days together (lib/queue.js weekTally).
  const tally = weekTally(S, todayISO())
  const { done: doneThisWeek, planned: plannedPerWeek } = tally
  const left = workoutsLeft(S, todayISO())
  // The streak with its best run and freezes (lib/streak.js), read back from the workouts.
  const todayKey = todayISO()
  const streak = useMemo(() => streakInfo(S, todayKey), [S.workouts, S.weekStart, todayKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // Settings → Modules (lib/modules.js): what a module switched off hides here.
  const on = id => isOn(S, id)
  const bwPoints = S.bodyweight.slice(-30).map(b => ({ t: weighInAt(b), y: b.w, d: b.d }))

  // today's session shown right under the week strip
  const onToday = () => { if (S.active) nav('/workout'); else if (todayRoutines.length) startFlow(effectiveRoutineIds(S, todayISO())); else dayOverrideSheet(todayISO()) }
  // A chip on the coach week's progress row starts that one routine, in any order. A session
  // already in progress wins, as on the today row — starting another would overwrite it.
  const progChip = programmeChip(S)
  const onQueueStart = id => { if (S.active) nav('/workout'); else startFlow([id]) }

  return <div className="narrow">
    {branding.isCustomTenant && branding.gymName && (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '10px 14px',
          marginBottom: 10,
          borderRadius: 14,
          background: 'var(--surface)',
          border: '1px solid color-mix(in srgb, var(--acc) 28%, transparent)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 180px' }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                background: 'var(--acc)',
                color: 'var(--on-acc)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                overflow: 'hidden'
              }}
            >
              {branding.logoUrl && !branding.logoUrl.startsWith('blob:') ? (
                <img
                  src={branding.logoUrl}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={e => { e.currentTarget.style.display = 'none' }}
                />
              ) : (
                <Icon name="dumbbell" />
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {branding.gymName}
                </span>
                <span style={{ fontSize: 14, background: 'var(--surface-3)', color: 'var(--acc-ink)', padding: '2px 7px', borderRadius: 6, fontWeight: 700 }}>
                  Rit
                </span>
              </div>
              <div className="muted small" style={{ fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {branding.slogan || (branding.accountType === 'personal' ? 'Consultoria & Treinos' : 'App Oficial da Academia')}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', maxWidth: '100%' }}>
            {branding.instagram && (
              <a
                href={`https://instagram.com/${String(branding.instagram).replace(/^@/, '').trim()}`}
                target="_blank"
                rel="noopener noreferrer"
                className="tag"
                style={{ textDecoration: 'none', maxWidth: '100%', overflowWrap: 'anywhere' }}
              >
                {String(branding.instagram).startsWith('@') ? branding.instagram : `@${branding.instagram}`}
              </a>
            )}
            {branding.contactPhone && (
              <a
                href={`https://wa.me/${String(branding.contactPhone).replace(/\D/g, '').replace(/^(?!55)/, '55')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="tag acc"
                style={{ textDecoration: 'none', flexShrink: 0 }}
              >
                WhatsApp
              </a>
            )}
          </div>
        </div>
        {branding.address && (
          <div
            className="muted small"
            style={{
              fontSize: 14,
              paddingTop: 6,
              borderTop: 'var(--hair) solid var(--sep)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {branding.address}
          </div>
        )}
      </div>
    )}
    <div className="hdr">
      <SeasonDeco spot="header-bats" />
      <div><h1>{user ? t('Hi {0}', user.name) : (branding.isCustomTenant && branding.gymName ? branding.gymName : 'Rit')}</h1><div className="sub">{today.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}</div></div>
      <button className="iconbtn" data-tour="settings-gear" onClick={() => nav('/settings')} aria-label={trouble ? t('Settings') + ', ' + t('Connection problem') : t('Settings')}><Icon name="gear" />{trouble && <span className="tab-dot" aria-hidden="true" />}</button>
    </div>

    {showPrescriptionNotice && (
      <div
        className="card"
        role="status"
        aria-live="polite"
        style={{
          border: '1px solid color-mix(in srgb, var(--acc) 45%, var(--sep))',
          display: 'flex',
          flexDirection: 'column',
          gap: 10
        }}
      >
        <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          <span className="lrow-i" style={{ background: 'var(--acc)', color: 'var(--on-acc)', flexShrink: 0 }}>
            <Icon name="clipboard" />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              {(pNotice?.routineNames?.length || 0) > 1 ? 'Novas fichas de treino liberadas!' : 'Nova ficha de treino liberada!'}
            </div>
            <div className="muted" style={{ fontSize: 14, marginTop: 2, lineHeight: 1.4 }}>
              {pNotice?.trainerName ? `Prof. ${pNotice.trainerName} atualizou seu plano` : 'Sua academia atualizou seu plano'}
              {Array.isArray(pNotice?.routineNames) && pNotice.routineNames.length > 0
                ? `: ${pNotice.routineNames.join(', ')}`
                : ''}
            </div>
          </div>
          <button
            type="button"
            className="iconbtn"
            style={{ width: 36, height: 36, flexShrink: 0 }}
            onClick={dismissPrescriptionNotice}
            aria-label="Dispensar aviso"
          >
            <Icon name="xmark" />
          </button>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Button
            size="sm"
            variant="primary"
            icon="dumbbell"
            onClick={() => {
              dismissPrescriptionNotice()
              nav('/plan')
            }}
          >
            Ver minhas fichas
          </Button>
          <Button size="sm" variant="ghost" onClick={dismissPrescriptionNotice}>
            Entendi
          </Button>
        </div>
      </div>
    )}

    {showVideoReviewNotice && (
      <div
        className="card"
        role="status"
        aria-live="polite"
        style={{
          border: '1px solid color-mix(in srgb, var(--acc) 45%, var(--sep))',
          display: 'flex',
          flexDirection: 'column',
          gap: 10
        }}
      >
        <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          <span className="lrow-i" style={{ background: 'var(--acc)', color: 'var(--on-acc)', flexShrink: 0 }}>
            <Icon name="check" />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              {latestVideoReview.status === 'adjust_needed'
                ? 'Ajuste técnico enviado pelo professor'
                : 'Execução de vídeo avaliada pelo professor'}
            </div>
            <div className="muted" style={{ fontSize: 14, marginTop: 3, lineHeight: 1.45 }}>
              {latestVideoReview.trainerName ? `Prof. ${latestVideoReview.trainerName}: ` : ''}
              "{latestVideoReview.comment}"
            </div>
          </div>
          <button
            type="button"
            className="iconbtn"
            style={{ width: 36, height: 36, flexShrink: 0 }}
            onClick={dismissVideoReviewNotice}
            aria-label="Dispensar parecer técnico"
          >
            <Icon name="xmark" />
          </button>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Button size="sm" variant="primary" icon="check" onClick={dismissVideoReviewNotice}>
            Entendi
          </Button>
        </div>
      </div>
    )}

    {canAskPush && (
      <div
        className="card"
        style={{
          border: '1px solid var(--sep)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10
        }}
      >
        <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          <span className="lrow-i" style={{ background: 'var(--acc)', color: 'var(--on-acc)', flexShrink: 0 }}>
            <Icon name="bell" />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Receber avisos de novos treinos?</div>
            <div className="muted" style={{ fontSize: 14, marginTop: 2, lineHeight: 1.4 }}>
              Ative as notificações para receber um alerta no celular sempre que seu professor liberar fichas novas.
            </div>
          </div>
          <button
            type="button"
            className="iconbtn"
            style={{ width: 36, height: 36, flexShrink: 0 }}
            onClick={dismissPushPrompt}
            aria-label="Fechar aviso"
          >
            <Icon name="xmark" />
          </button>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Button size="sm" variant="primary" icon="bell" disabled={pushBusy} onClick={handleActivatePush}>
            {pushBusy ? 'Ativando...' : 'Ativar notificações'}
          </Button>
          <Button size="sm" variant="ghost" onClick={dismissPushPrompt}>
            Agora não
          </Button>
        </div>
      </div>
    )}

    <div className="card">
      {/* A running programme (lib/programmes.js) wrote this week's plan: where it stands, one tap from its screen. */}
      {progChip && <button type="button" className="chip ichip prog-chip" onClick={() => nav('/plan/programmes')}><Icon name="calendar" /><span>{progChip}</span></button>}
      {/* A coach week runs by order, not by weekday, so its progress row stands in for the
          seven dots (components/QueueRow.jsx). The today row below stays as it is: the queue's
          next session reaches it through effectiveRoutineIds like any planned routine. */}
      {rotating ? (queue ? <QueueRow S={S} today={todayISO()} onStart={onQueueStart} managed={managedQueue} /> : <div className="empty">
        {t('No rotation yet. Add routines to it in Plan.')}
        <div style={{ marginTop: 10 }}><Button size="sm" variant="tinted" onClick={() => nav('/plan')}>{t('Set up in Plan')}</Button></div>
      </div>) : <>
        <div className="row between" style={{ marginBottom: 8 }}>
          <button className="iconbtn" style={{ width: 36, height: 36, fontSize: 'var(--fs-subhead)' }} onClick={() => setWeekOffset(w => w - 1)} aria-label={t('Previous week')}><Icon name="chevronLeft" /></button>
          <div className="small muted" style={{ fontWeight: 500 }}>{wkLabel}</div>
          <button className="iconbtn" style={{ width: 36, height: 36, fontSize: 'var(--fs-subhead)' }} onClick={() => setWeekOffset(w => w + 1)} aria-label={t('Next week')}><Icon name="chevronRight" /></button>
        </div>
        <div className="week">{strip}</div>
      </>}
      {/* The week's plan as a countdown (#753, lib/week-left.js): "2 of 4 left this week". */}
      {left && <div className={'small dim wkleft' + (left.left > 0 ? '' : ' done')}>
        {left.left > 0 ? tn('{0} of {1} left this week', '{0} of {1} left this week', left.left, left.of) : t('All done this week. Nice.')}
      </div>}
      {/* Once today's session is logged the row stops asking for it. The week strip already
          knew (its dot goes 'done'); this row did not, so a finished day kept showing the
          routine name behind a green Start tag and read as still outstanding (issue #4).
          An in-progress session still wins — that one is happening right now. Tapping the
          row keeps working, so a second session in one day is a tap away, just not urged. */}
      <div className="today-row" data-tour="today" {...tappable(onToday)}>
        <div className="row" style={{ gap: 9, minWidth: 0 }}>
          <span className="lrow-i" style={{ background: S.active ? 'var(--orange)' : doneToday ? 'var(--surface-3)' : routine ? 'var(--acc)' : 'var(--surface-3)',
            // the rest day's moon on the grey square: white on #e3e3e8 vanished in the light theme
            ...(!S.active && !doneToday && !routine ? { color: 'var(--label-2)' } : {}) }}>
            <Icon name={S.active ? (editingSaved ? 'pencil' : 'play') : doneToday ? 'checkCircle' : routine ? glyphOf(routine.emoji) : 'moon'}
              style={doneToday && !S.active ? { color: 'var(--green)' } : undefined} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="lbl2">{t('Today')}</div>
            <div className="ttl">{S.active ? (editingSaved ? S.active.name : t('{0} (in progress)', S.active.name))
              : doneToday ? (doneToday.name ? t('{0} (done)', doneToday.name) : t('Workout done'))
              : routine ? todayName : t('Rest day')}{todayOvr && routine && !doneToday ? ' · ' + t('rescheduled') : ''}</div>
            {(routine?.prescribedBy?.name || routine?.prescribedBy?.trainerName) && !S.active && !doneToday && (
              <div className="ss muted" style={{ fontSize: '14px', marginTop: 1, color: 'var(--acc-ink)' }}>
                Prescrito pelo Prof. {routine.prescribedBy.name || routine.prescribedBy.trainerName}
              </div>
            )}
            {next && !doneToday && <div className="ss">{t('Next session: {0}, {1}', t(DAYN[next.weekday]), next.routine.name)}</div>}
          </div>
        </div>
        {S.active ? <span className="tag" style={{ color: 'var(--orange)', background: 'color-mix(in srgb,var(--orange) 16%,transparent)' }}>{editingSaved ? t('Edit') : t('Resume')}</span>
          : doneToday ? <span className="tag" style={{ color: 'var(--green)', background: 'color-mix(in srgb,var(--green) 16%,transparent)' }}>{t('Done')}</span>
          : routine ? <span className="row" style={{ gap: 8 }}><MiniBodyMap routines={todayRoutines} body={S.body} /><span className="tag acc">{t('Start')}</span></span>
          : <Icon name="plus" className="chev" />}
      </div>
      {/* The row above starts today's plan in one tap, and so does the Start button in the tab
          bar — which is the whole problem when you want something else. Both jump straight into
          the planned session whenever there is one, so the Start screen (a freestyle session,
          and your other routines) is only reachable on a day with nothing planned. The one other
          way in, "Choose a different workout" on the weigh-in sheet, does not exist when the
          weigh-in is switched off. This is that door, and it starts nothing on its own. */}
      {!S.active && <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
        {branding.isCustomTenant && S.routines.length > 0 && !todayRoutines.length && !doneToday && (
          <Button size="sm" variant="tinted" icon="dumbbell" onClick={() => nav('/plan')}>
            {t('Ver minhas fichas ({0})', S.routines.length)}
          </Button>
        )}
        <Button size="sm" variant="ghost" className="dim" icon="swap" onClick={() => nav('/workout')}>
          {t('Choose a different workout')}
        </Button>
      </div>}
      <SeasonDeco spot="home-hero" />
    </div>

    {/* Monday: Your week; the 1st: Your month (lib/recap.js). Off in Settings → Look & Home. */}
    <RecapHomeCard S={S} />

    {/* Christmas (lib/seasonal.js): the advent calendar's card, 1 to 24 December, from the theme's chunk. */}
    <SeasonDeco spot="home-advent" />

    {/* December and January: the year in openGym is ready (lib/wrapped.js homeCardYear). */}
    {on('motivation') && <WrappedHomeCard S={S} />}

    {/* What has rested and what is still recovering, kindly (lib/recovery-hint.js). */}
    {on('health') && <RecoveryHint S={S} />}

    {/* This month's three challenges and how far you are (lib/challenges.js). */}
    <ChallengesCard S={S} />

    {/* Jump to the gym check-in cards (QR membership codes). Shown here as a quick tap on
        arrival at the gym; folds away per user via the "Gym check-in" switch in Settings. */}
    {on('checkin') && (
      <div className="card tap-host checkin-card">
        <CardHead icon="qr" tint="var(--blue)" eyebrow={t('At the gym')} title={t('Check in')} open={{ onClick: () => nav('/checkin') }}
          action={<Icon name="chevronRight" className="chev" />} />
      </div>
    )}

    {!S.routines.length && !S.active && (
      branding.isCustomTenant ? (
        <div className="card">
          <CardHead
            icon="clipboard"
            title={t('Aguardando sua ficha de treino')}
            sub={t('A equipe da {0} está preparando seu plano de treino personalizado.', branding.gymName || 'Rit')}
          />
          {branding.contactPhone && (
            <>
              <Button
                variant="primary"
                icon="whatsapp"
                onClick={() => {
                  const digits = String(branding.contactPhone).replace(/\D/g, '').replace(/^(?!55)/, '55');
                  window.open(`https://wa.me/${digits}`, '_blank', 'noopener,noreferrer');
                }}
              >
                {t('Falar com a academia no WhatsApp')}
              </Button>
              <div style={{ height: 8 }} />
            </>
          )}
          <Button variant={branding.contactPhone ? 'ghost' : 'primary'} onClick={() => nav('/workout')}>
            {t('Iniciar treino livre')}
          </Button>
        </div>
      ) : (
        <div className="card">
          <CardHead icon="calendar" title={t('Welcome!')} sub={t('Set up your weekly routine to get going, or grab a ready-made starter plan.')} />
          <Button variant="primary" icon="clipboard" onClick={starterPlanSheet}>{t('Load starter plan')}</Button>
          <div style={{ height: 8 }} /><Button onClick={() => nav('/plan')}>{t('Build my own plan')}</Button>
        </div>
      )
    )}

    {on('body') && S.showWeightCard !== false && <div className="card">
      {/* one trailing action, Log; the goal lives with the goal line and the weigh-ins below (P2) */}
      <CardHead icon="scale" tint="var(--teal)" title={t('Body weight')} className="bw-head"
        action={<Button size="sm" icon="plus" onClick={() => bwSheet()}>{t('Log')}</Button>} />
      {bw ? <>
        <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
          <div className="big">{fmtNum(bw.w)} <span className="muted" style={{ fontSize: 'var(--fs-callout)' }}>{S.unit}</span></div>
          {/* only when it actually moved — an unchanged weight used to read as "− 0" */}
          {!!delta && (
            <span className="small row" style={{ gap: 2, fontWeight: 500, color: bwDeltaColor(delta, bw.w) }}>
              <Icon name={delta > 0 ? 'arrowUp' : 'arrowDown'} style={{ fontSize: 'var(--fs-caption)' }} />
              {fmtNum(Math.abs(delta))}
            </span>
          )}
          <span className="dim small" style={{ marginInlineStart: 'auto' }}>{fmtDate(bw.d, true)}</span>
        </div>
        {S.targetW && (
          <div className="small row" style={{ color: 'var(--gold-ink)', marginTop: 4, gap: 5 }}>
            <Icon name="target" style={{ fontSize: 'var(--fs-footnote)' }} />
            <span>{t('Goal')} {fmtNum(S.targetW)} {S.unit} · {Math.abs(S.targetW - bw.w) < 0.05 ? t('reached!') : t(S.targetW > bw.w ? '{0} to gain' : '{0} to lose', fmtNum(Math.abs(S.targetW - bw.w)) + ' ' + S.unit)}</span>
          </div>
        )}
        <div className="chart" style={{ marginTop: 8 }}><LineChart points={bwPoints} h={130} unit={S.unit} goal={S.targetW} /></div>
        {/* the weekly rate and, with one set, how it sits in its corridor (#759) */}
        <WeightRate S={S} />
        {/* every weigh-in, week by week with its average (Discord 'Weight') */}
        <div className="row between" style={{ marginTop: 4 }}>
          <Button size="sm" variant="ghost" icon="target" className="bw-goal" style={S.targetW ? { color: 'var(--gold-ink)' } : undefined} onClick={goalSheet}>{S.targetW ? fmtNum(S.targetW) : t('Goal')}</Button>
          <Button size="sm" variant="ghost" trailingIcon="chevronRight" data-tour="home-weighins" onClick={weighInsSheet}>{t('All weigh-ins')}</Button>
        </div>
      </> : <>
        <div className="muted small">{S.weighIn === false
          ? t('No weigh-ins yet. Log your weight to start the curve.')
          : t("No weigh-ins yet. Log your weight to start the curve (we also ask before every workout).")}</div>
        <Button size="sm" variant="ghost" icon="target" className="bw-goal" style={{ marginTop: 6, ...(S.targetW ? { color: 'var(--gold-ink)' } : {}) }} onClick={goalSheet}>{S.targetW ? fmtNum(S.targetW) : t('Goal')}</Button>
      </>}
    </div>}

    {/* The streak opens its calendar from its text (CardHead open); the weekly-sets line and the
        party banner are buttons of their own beside it, not inside a card that is a button. */}
    {on('motivation') ? <div className="card tap-host streak-card">
      <SeasonDeco spot="home-streak" />
      {/* in season, a Santa hat on the flame (components/Seasonal.jsx) */}
      <CardHead className="streak-head" glyph={<span className="streak-flame-wrap"><StreakFlame lit={streak.current > 0} /><SeasonDeco spot="streak-flame" /></span>}
        title={t('{0} week streak', streak.current)} open={{ onClick: () => calendarSheet(), haspopup: 'dialog' }}
        sub={<>{doneThisWeek}{plannedPerWeek ? ' / ' + plannedPerWeek : ''} {t('this week')} · {tn('{0} workout total', '{0} workouts total', S.workouts.length)}</>}
        action={<Icon name="calendar" className="chev" style={{ fontSize: 'var(--fs-title3)' }} />} />
      {(streak.best > 0 || streak.freezes > 0) && <div className="muted small card-head-indent streak-meta-line"><StreakMeta info={streak} /></div>}
      <StreakParty S={S} info={streak} tally={tally} />
      {/* Settings → Look & Home → Weekly sets on Home (lib/muscle-targets.js): the muscle with
          the most room this week, one tap from the Stats card. */}
      {/* Straight to Stats → Lifts, where the card is, not to the top of Overview (P5 deep link). */}
      {S.homeMuscleSets === true && <WeeklySetsHomeLine S={S} onOpen={() => nav('/stats?section=lifts')} />}
    </div>
      // Motivation off: no streak card, but the weekly sets line it carried keeps a card of its own.
      : S.homeMuscleSets === true && <div className="card wsets-solo"><WeeklySetsHomeLine S={S} onOpen={() => nav('/stats?section=lifts')} /></div>}
    <InstallPwaBanner />
  </div>
}
