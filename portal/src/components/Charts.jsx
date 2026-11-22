import React, { useId, useState } from 'react';

/**
 * Gráfico de Linha com área suave no estilo nativo do Rit (LineChart.jsx),
 * sem distorção de proporção e com inspeção interativa por hover/toque.
 */
export function LineChart({
  data = [],
  valueKey = 'value',
  labelKey = 'label',
  height = 175,
  color = 'var(--acc)',
  formatValue = v => String(v)
}) {
  const gradId = useId();
  const [activeIdx, setActiveIdx] = useState(null);

  if (!data.length) {
    return <div className="muted" style={{ padding: '24px 0', textAlign: 'center', fontSize: 14 }}>Sem dados no período</div>;
  }

  const values = data.map(d => Number(d[valueKey] || 0));
  const max = Math.max(...values, 1);
  const min = 0;
  const W = 560;
  const H = height;
  const padL = 16;
  const padR = 16;
  const padT = 22;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const pts = data.map((d, i) => {
    const x = data.length === 1 ? padL + plotW / 2 : padL + (i / (data.length - 1)) * plotW;
    const ratio = (Number(d[valueKey] || 0) - min) / (max - min || 1);
    const y = padT + plotH - ratio * plotH;
    return { x, y, raw: d, val: Number(d[valueKey] || 0) };
  });

  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${(padT + plotH).toFixed(1)} L${pts[0].x.toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

  const labelStep = Math.max(1, Math.ceil(data.length / 6));
  const activePt = activeIdx != null && pts[activeIdx] ? pts[activeIdx] : pts[pts.length - 1];

  return (
    <div className="b2b-chart-wrap" onMouseLeave={() => setActiveIdx(null)}>
      {activePt && (
        <div className="b2b-chart-Readout" aria-live="polite">
          <span className="muted">{String(activePt.raw[labelKey] || '')}</span>
          <b className="num" style={{ color: 'var(--label)', fontSize: 14 }}>{formatValue(activePt.val)}</b>
        </div>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} className="b2b-linechart" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {[0, 0.5, 1].map(fr => {
          const gy = padT + plotH * (1 - fr);
          return <line key={fr} x1={padL} x2={W - padR} y1={gy} y2={gy} stroke="var(--sep)" strokeDasharray="3 3" strokeWidth="1" />;
        })}

        <path d={areaPath} fill={`url(#${gradId})`} />
        <path d={linePath} fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />

        {activeIdx != null && pts[activeIdx] && (
          <line
            x1={pts[activeIdx].x}
            x2={pts[activeIdx].x}
            y1={padT}
            y2={padT + plotH}
            stroke={color}
            strokeOpacity="0.45"
            strokeDasharray="2 2"
            strokeWidth="1.2"
          />
        )}

        {pts.map((p, idx) => {
          const isSelected = activeIdx === idx;
          const pointLabel = `${String(p.raw[labelKey] || '')}: ${formatValue(p.val)}`;
          return (
            <g
              key={idx}
              role="button"
              tabIndex={0}
              aria-label={pointLabel}
              style={{ cursor: 'pointer', outline: 'none' }}
              onMouseEnter={() => setActiveIdx(idx)}
              onFocus={() => setActiveIdx(idx)}
              onClick={() => setActiveIdx(idx)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveIdx(idx);
                } else if (e.key === 'ArrowRight' && idx < pts.length - 1) {
                  e.preventDefault();
                  setActiveIdx(idx + 1);
                } else if (e.key === 'ArrowLeft' && idx > 0) {
                  e.preventDefault();
                  setActiveIdx(idx - 1);
                }
              }}
            >
              <circle cx={p.x} cy={p.y} r="12" fill="transparent" />
              <circle
                cx={p.x}
                cy={p.y}
                r={isSelected ? '5.2' : '3.6'}
                fill={isSelected ? color : 'var(--surface)'}
                stroke={color}
                strokeWidth="2.2"
              >
                <title>{pointLabel}</title>
              </circle>
              {(idx % labelStep === 0 || idx === pts.length - 1) && (
                <text
                  x={p.x}
                  y={H - 6}
                  textAnchor={idx === 0 ? 'start' : idx === pts.length - 1 ? 'end' : 'middle'}
                  fill={isSelected ? 'var(--label)' : 'var(--label-2)'}
                  fontWeight={isSelected ? '700' : '500'}
                  fontSize="12"
                >
                  {String(p.raw[labelKey] || '').slice(-5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Linha de barra proporcional estilo StatBars.jsx do Rit.
 */
export function BarRow({ label, value, max = 100, rightText, color = 'var(--acc)' }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (Number(value || 0) / max) * 100)) : 0;
  return (
    <div className="b2b-barrow">
      <div className="b2b-barrow-top">
        <span className="b2b-barrow-lbl">{label}</span>
        <span className="b2b-barrow-val num">{rightText ?? value}</span>
      </div>
      <div className="b2b-barrow-track">
        <div className="b2b-barrow-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

/**
 * Barra empilhada estilo StackBar do Rit.
 */
export function StackBar({ segments = [] }) {
  const total = segments.reduce((s, x) => s + Math.max(0, Number(x.value || 0)), 0) || 1;
  return (
    <div>
      <div className="b2b-stackbar">
        {segments.map((seg, idx) => {
          const pct = (Math.max(0, Number(seg.value || 0)) / total) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={seg.label || idx}
              className="b2b-stackbar-seg"
              style={{ width: `${pct}%`, background: seg.color }}
              title={`${seg.label}: ${seg.value}`}
            />
          );
        })}
      </div>
      <div className="b2b-legend">
        {segments.map((seg, idx) => (
          <div key={seg.label || idx} className="b2b-legend-item">
            <span className="b2b-legend-dot" style={{ background: seg.color }} />
            <span>{seg.label}</span>
            <b className="num">{seg.display ?? seg.value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}
