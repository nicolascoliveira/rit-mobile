import { NUDGE_COPY } from './nudge-copy.js';
import { lineIndex } from './nudge.js';

const COPY = {
  en: {
    restTitle: 'Rest over 💪',
    restBody: 'Time for your next set.',
    testBody: 'Test notification ✅ This is what alerts look like.',
    dayFallbackTitle: 'Workout planned today',
    dayRoutineSuffix: 'today',
    dayBody: "It's on your plan. Let's go 💪",
  },
  'pt-BR': {
    restTitle: 'Descanso terminado 💪',
    restBody: 'Hora da próxima série.',
    testBody: 'Notificação de teste ✅ É assim que os alertas aparecem.',
    dayFallbackTitle: 'Treino planejado para hoje',
    dayRoutineSuffix: 'hoje',
    dayBody: 'Está no seu plano. Bora treinar 💪',
  },
};

const copyFor = lang => COPY[lang] || COPY.en;

// A routine's `emoji` field held a literal emoji until the glyph redesign; since then it holds
// an icon key ('dumbbell', 'figureRun') that the app renders as an SVG. A push notification has
// no SVG to render, so an unmapped key reaches the phone as its own name — "dumbbell Push
// today". Keys are ASCII and emoji are not, so anything ASCII is looked up here (falling back
// rather than printing a word), and anything else is already an emoji and passes through.
// Mirrors frontend/src/lib/glyphs.js: GLYPHS is the full set the picker offers.
const DEFAULT_EMOJI = '🏋️';
const GLYPH_EMOJI = {
  figureStrength: '🏋️', arm: '💪', abs: '💥', legs: '🦵', pullup: '🧗',
  dumbbell: '🏋️', barbell: '🏋️', kettlebell: '🏋️', plate: '🏋️', machine: '🏋️',
  figureRun: '🏃', bike: '🚴', swim: '🏊', boxing: '🥊', timer: '⏱️',
  stretch: '🤸', moon: '🌙', heart: '❤️', flame: '🔥', bolt: '⚡',
};

export function routineEmoji(value) {
  if (!value) return DEFAULT_EMOJI;
  if (!/^[A-Za-z]+$/.test(value)) return value;
  return GLYPH_EMOJI[value] || DEFAULT_EMOJI;
}

export function restTimerPush(lang) {
  const copy = copyFor(lang);
  return { title: copy.restTitle, body: copy.restBody, tag: 'rest-timer' };
}

export function testPush(lang) {
  return { title: 'Rit', body: copyFor(lang).testBody, tag: 'test' };
}

export function dayReminderPush(lang, routine) {
  const copy = copyFor(lang);
  return {
    title: routine
      ? `${routineEmoji(routine.emoji)} ${routine.name} ${copy.dayRoutineSuffix}`
      : copy.dayFallbackTitle,
    body: copy.dayBody,
    tag: 'day-reminder',
  };
}

// The missed-workout nudge (nudge.js). Its copy is translated in the frontend packs and generated
// into nudge-copy.js, so every language the app speaks has it — unlike the strings above, which
// predate that and fall back to English. de-CH is de with ß written ss, as in the frontend
// (lib/i18n-core.js DERIVED_LOCALES).
const nudgeCopyFor = lang => {
  if (lang === 'de-CH') {
    const ch = s => s.replace(/ß/g, 'ss');
    return Object.fromEntries(Object.entries(NUDGE_COPY.de).map(([k, c]) => [k, { title: ch(c.title), lines: c.lines.map(ch) }]));
  }
  return NUDGE_COPY[lang] || NUDGE_COPY.en;
};
export function nudgePush(lang, tone, routine, iso) {
  const copy = nudgeCopyFor(lang)[NUDGE_COPY.en[tone] ? tone : 'friendly'];
  const line = copy.lines[lineIndex(iso, copy.lines.length)];
  const name = routine?.name || 'Rit';
  return { title: copy.title, body: line.replace('{0}', () => name), tag: 'nudge' };
}

export function prescriptionPush(lang, { trainerName = '', tenantName = '', routines = [] } = {}) {
  const names = (Array.isArray(routines) ? routines : [])
    .map(r => (typeof r === 'string' ? r : r?.name))
    .map(s => String(s || '').trim())
    .filter(Boolean);
  const count = names.length || 1;
  const preview = names.length > 3
    ? `${names.slice(0, 3).join(', ')} (+${names.length - 3})`
    : names.join(', ');
  const isEn = typeof lang === 'string' && lang.toLowerCase().startsWith('en');

  if (isEn) {
    const sender = trainerName ? `Coach ${trainerName}` : (tenantName || 'Your gym');
    return {
      title: count > 1 ? `📋 ${count} new workouts ready on Rit!` : '📋 New workout ready on Rit!',
      body: preview
        ? `${sender} updated your plan: ${preview}. Tap to start!`
        : `${sender} published a new workout plan for you. Tap to start!`,
      tag: 'prescription-update',
      url: '#/',
    };
  }

  const sender = trainerName ? `Prof. ${trainerName}` : (tenantName || 'Sua academia');
  return {
    title: count > 1 ? `📋 ${count} novas fichas liberadas no Rit!` : '📋 Nova ficha liberada no Rit!',
    body: preview
      ? `${sender} atualizou seu plano: ${preview}. Toque para conferir!`
      : `${sender} atualizou seu plano de treino. Toque para conferir!`,
    tag: 'prescription-update',
    url: '#/',
  };
}

export function weeklySummaryPush(lang, { workoutsCount = 0, plannedDays = 0, totalVolKg = 0, prsCount = 0 } = {}) {
  const isEn = typeof lang === 'string' && lang.toLowerCase().startsWith('en');
  const volText = totalVolKg > 0 ? ` (${Math.round(totalVolKg).toLocaleString('pt-BR')} kg)` : '';
  const prText = prsCount > 0 ? (isEn ? `, ${prsCount} PR(s)` : ` e ${prsCount} recorde(s)`) : '';
  if (isEn) {
    return {
      title: `Weekly recap: ${workoutsCount}${plannedDays ? `/${plannedDays}` : ''} sessions`,
      body: `Great consistency this week${volText}${prText}. Check your progress in Rit.`,
      tag: 'weekly-summary',
      url: '#/'
    };
  }
  return {
    title: `Resumo da semana: ${workoutsCount}${plannedDays ? `/${plannedDays}` : ''} treinos`,
    body: `Parabéns pela constância${volText}${prText}! Confira sua evolução completa no Rit.`,
    tag: 'weekly-summary',
    url: '#/'
  };
}

export function routineRenewalPush(lang, { daysSince = 25, trainerName = '' } = {}) {
  const isEn = typeof lang === 'string' && lang.toLowerCase().startsWith('en');
  if (isEn) {
    return {
      title: 'Time to refresh your workout plan',
      body: `Your current plan has been running for ${daysSince} days. Talk to your coach for your next progression cycle.`,
      tag: 'routine-renewal',
      url: '#/'
    };
  }
  const by = trainerName ? ` com Prof. ${trainerName}` : '';
  return {
    title: 'Hora de evoluir sua ficha de treino',
    body: `Sua ficha atual já completou ${daysSince} dias de ciclo. Combine a renovação${by} para o próximo nível!`,
    tag: 'routine-renewal',
    url: '#/'
  };
}

export function videoReviewPush(lang, { exerciseName = 'Exercício', trainerName = '', status = 'reviewed' } = {}) {
  const isEn = typeof lang === 'string' && lang.toLowerCase().startsWith('en');
  const who = trainerName ? (isEn ? `Coach ${trainerName}` : `Prof. ${trainerName}`) : (isEn ? 'Your coach' : 'Seu professor');
  if (isEn) {
    return {
      title: status === 'adjust_needed' ? `Form tip on ${exerciseName}` : `Form reviewed: ${exerciseName}`,
      body: `${who} left feedback on your execution video. Tap to read.`,
      tag: 'video-review',
      url: '#/history'
    };
  }
  return {
    title: status === 'adjust_needed' ? `Ajuste técnico: ${exerciseName}` : `Execução analisada: ${exerciseName}`,
    body: `${who} enviou uma análise do seu vídeo de treino. Confira no app!`,
    tag: 'video-review',
    url: '#/history'
  };
}

export function assessmentPush(lang, { trainerName = '', weightKg = null, bodyFat = null } = {}) {
  const isEn = typeof lang === 'string' && lang.toLowerCase().startsWith('en');
  const who = trainerName ? (isEn ? `Coach ${trainerName}` : `Prof. ${trainerName}`) : (isEn ? 'Your gym' : 'Sua academia');
  const parts = [];
  if (weightKg) parts.push(`${weightKg} kg`);
  if (bodyFat) parts.push(`${bodyFat}% BF`);
  const summary = parts.length ? ` (${parts.join(', ')})` : '';
  if (isEn) {
    return {
      title: 'New physical assessment logged',
      body: `${who} updated your measurements${summary}. Check your progress!`,
      tag: 'assessment-update',
      url: '#/measurements'
    };
  }
  return {
    title: 'Nova avaliação física registrada',
    body: `${who} atualizou suas medidas${summary}. Confira seu comparativo no Rit!`,
    tag: 'assessment-update',
    url: '#/measurements'
  };
}
