import { useState } from 'react'
import { useUI } from '../store/useUI.js'
import { vibrate } from '../lib/sound.js'
import './verao.css'

const SUMMER_TIPS = [
  '☀️ Projeto Verão: nos dias mais quentes, aumente sua hidratação em +500ml durante o treino!',
  '🔥 Constância de verão: cada série concluída hoje constrói o resultado do ano inteiro.',
  '💧 Dica de performance: repor água e eletrólitos entre as séries mantém sua força até o fim do treino.',
  '⚡ Energia máxima! Aproveite o clima de verão para bater sua meta semanal de treinos.',
]

const SunIcon = () => (
  <svg className="vr-sunsvg" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <defs>
      <radialGradient id="vr-sun-g" cx="50%" cy="45%" r="55%">
        <stop offset="0%" stopColor="#fde047" />
        <stop offset="100%" stopColor="#f97316" />
      </radialGradient>
    </defs>
    <g stroke="#f59e0b" strokeWidth="2.2" strokeLinecap="round">
      <line x1="16" y1="2.5" x2="16" y2="6" />
      <line x1="16" y1="26" x2="16" y2="29.5" />
      <line x1="2.5" y1="16" x2="6" y2="16" />
      <line x1="26" y1="16" x2="29.5" y2="16" />
      <line x1="6.4" y1="6.4" x2="8.9" y2="8.9" />
      <line x1="23.1" y1="23.1" x2="25.6" y2="25.6" />
      <line x1="25.6" y1="6.4" x2="23.1" y2="8.9" />
      <line x1="8.9" y1="23.1" x2="6.4" y2="25.6" />
    </g>
    <circle cx="16" cy="16" r="7.2" fill="url(#vr-sun-g)" />
  </svg>
)

const WaveIcon = () => (
  <svg className="vr-wavesvg" viewBox="0 0 48 16" aria-hidden="true" focusable="false">
    <path
      d="M2 10c4.5-4 9-4 13.5 0s9 4 13.5 0 9-4 13.5 0"
      fill="none"
      stroke="#f59e0b"
      strokeWidth="2.2"
      strokeLinecap="round"
    />
  </svg>
)

export function Layer({ hidden = false }) {
  if (hidden) return null
  return (
    <div className="vr-layer" aria-hidden="true">
      <div className="vr-glow" />
    </div>
  )
}

export function Deco({ spot }) {
  const [pop, setPop] = useState(false)
  const [idx, setIdx] = useState(0)

  if (spot === 'home-hero') {
    const tap = e => {
      e.stopPropagation()
      vibrate([12])
      setPop(true)
      setTimeout(() => setPop(false), 550)
      const msg = SUMMER_TIPS[idx % SUMMER_TIPS.length]
      setIdx(n => n + 1)
      useUI.getState().toast(msg)
    }
    return (
      <div style={{ display: 'inline-flex', alignItems: 'center', marginTop: 6 }}>
        <button
          type="button"
          className={'vr-sun-btn' + (pop ? ' vr-sun-pop' : '')}
          onClick={tap}
          title="Dica do Projeto Verão"
        >
          <SunIcon />
          <span>Projeto Verão</span>
        </button>
      </div>
    )
  }

  if (spot === 'home-streak' || spot === 'workout-finish') {
    return (
      <span className="vr-badge" aria-hidden="true">
        <WaveIcon />
      </span>
    )
  }

  return null
}
