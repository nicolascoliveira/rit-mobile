// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Media, { Thumb } from './Media.jsx'
import { hasWorkoutMedia } from './WorkoutThumb.jsx'
import { createMediaStore, memoryBackend, _setMediaStore } from '../lib/media-store.js'
import {
  allExercises,
  EXIDX,
  getTenantOverride,
  isCustomEx,
  isTenantCustomEx,
  registerTenantExercises,
} from '../lib/exercises.js'
import { useStore } from '../store/useStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const H = c => c.repeat(64)
const MAIN = H('a')
const POSTER = H('b')
const IMG_HASH = H('c')

const still = { hash: POSTER, mime: 'image/webp', size: 120, width: 48, height: 36 }
const uploadedPhoto = { kind: 'image', hash: IMG_HASH, mime: 'image/webp', size: 120, width: 80, height: 60, at: 1 }
const uploadedClip = { kind: 'video', hash: MAIN, mime: 'video/mp4', size: 240, width: 64, height: 36, dur: 4.5, codec: 'avc1', poster: still, at: 2 }

const settle = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

let host, root, media, made, originalTenantEx

describe('Tenant exercise overrides & custom tx_ exercises (Bloco 2)', () => {
  beforeEach(() => {
    window.happyDOM.settings.disableIframePageLoading = true
    originalTenantEx = useStore.getState().tenantExercises
    made = []
    media = createMediaStore(memoryBackend(), {
      objectURL: {
        createObjectURL: () => {
          const u = 'blob:tenant/' + made.length
          made.push(u)
          return u
        },
        revokeObjectURL: () => {},
      },
      canPlayType: type => (type.includes('mp4') ? 'probably' : ''),
    })
    _setMediaStore(media)
    HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve())
    HTMLMediaElement.prototype.pause = vi.fn()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    _setMediaStore(null)
    registerTenantExercises([], {})
    useStore.setState({ tenantExercises: originalTenantEx })
  })

  it('sobrescreve o vídeo de exercício do catálogo via override da academia sem marcá-lo como custom do aluno', async () => {
    const builtinEx = EXIDX['0025']
    expect(builtinEx).toBeTruthy()
    for (const h of [MAIN, POSTER]) await media.put(h, new Blob(['x']), { mime: h === MAIN ? 'video/mp4' : 'image/webp', pending: false })

    const overrides = {
      '0025': {
        exerciseId: '0025',
        media: uploadedClip,
        url: 'https://www.youtube.com/watch?v=99QhMQoxmOk',
        note: 'Cotovelos a 45 graus.',
      },
    }
    registerTenantExercises([], overrides)
    useStore.setState({
      S: { ...useStore.getState().S, gifSize: 'full' },
      tenantExercises: { customExercises: [], overrides },
    })

    expect(isCustomEx(builtinEx)).toBe(false)
    expect(isTenantCustomEx(builtinEx)).toBe(false)
    expect(getTenantOverride('0025')?.note).toBe('Cotovelos a 45 graus.')

    await act(async () => { root.render(<Media ex={builtinEx} />) })
    await settle()

    // Vídeo enviado pelo professor aparece no lugar do GIF padrão, junto com o embed do YouTube
    const video = host.querySelector('.exmedia video')
    expect(video).toBeTruthy()
    expect(video.getAttribute('src') || video.currentSrc).toMatch(/^blob:tenant\//)
    expect(host.querySelector('.youtube-video button')).toBeTruthy()
  })

  it('mantém exercícios próprios tx_ da academia read-only para o aluno e visíveis no catálogo e Thumb', async () => {
    await media.put(IMG_HASH, new Blob(['x']), { mime: 'image/webp', pending: false })
    const customExercises = [
      {
        id: 'tx_supino_maq',
        n: 'Supino Máquina Academia',
        bp: 'chest',
        eq: 'leverage machine',
        cat: 'strength',
        custom: true,
        tenantCustom: true,
        media: uploadedPhoto,
        url: '',
        note: 'Banco na posição 3',
      },
    ]
    registerTenantExercises(customExercises, {})
    useStore.setState({
      S: { ...useStore.getState().S, gifSize: 'full' },
      tenantExercises: { customExercises, overrides: {} },
    })

    const tx = EXIDX.tx_supino_maq
    expect(tx).toBeTruthy()
    expect(isTenantCustomEx(tx)).toBe(true)
    expect(isCustomEx(tx)).toBe(false)
    expect(hasWorkoutMedia(tx)).toBe(true)

    const merged = allExercises({ customEx: [] })
    expect(merged.some(e => e.id === 'tx_supino_maq')).toBe(true)

    // Thumb para imagem sem poster dedicado ainda renderiza a própria imagem da academia
    await act(async () => { root.render(<Thumb ex={tx} size={42} />) })
    await settle()
    const thumbImg = host.querySelector('img')
    expect(thumbImg).toBeTruthy()
    expect(thumbImg.getAttribute('src')).toMatch(/^blob:tenant\//)
  })

  it('aceita link do YouTube vindo de entry.target.note (campo singular usado nas prescrições B2B)', async () => {
    const builtinEx = EXIDX['0025']
    const entryTargetNote = 'https://youtu.be/ek9I3ORMU3g'
    await act(async () => {
      root.render(<Media ex={builtinEx} notes={entryTargetNote} />)
    })
    await settle()
    expect(host.querySelector('.youtube-video button')).toBeTruthy()
  })
})

