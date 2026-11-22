/* Copiloto B2B de Prescrição para o Professor/Personal.
 *
 * Reaproveita a infraestrutura do Coach (`config.js`, `core/library.js`, adapters HTTP)
 * com fallback biomecânico determinístico sobre o catálogo real (~5.6k exercícios + customizados
 * da academia), sem expor dados sensíveis nem vídeos de execução do aluno (`set.media`).
 */
import { LIBRARY, LIB_BY_ID, equipmentAllows, isStretch } from './core/library.js';
import { load as loadCoachConfig, isEnabled as isCoachEnabled, accountFor, jobEnv } from './config.js';
import anthropicAdapter from './core/adapters/anthropic.js';
import openaiAdapter from './core/adapters/openai.js';
import geminiAdapter from './core/adapters/gemini.js';
import compatibleAdapter from './core/adapters/compatible.js';

const HTTP_ADAPTERS = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  gemini: geminiAdapter,
  compatible: compatibleAdapter
};

const EQUIPMENT_PRESETS = {
  full_gym: [],
  machines_cables: ['leverage machine', 'cable', 'smith machine', 'assisted', 'body weight', 'band'],
  dumbbells_bodyweight: ['dumbbell', 'body weight', 'kettlebell', 'band', 'medicine ball', 'stability ball'],
  home_minimal: ['body weight', 'band', 'dumbbell']
};

const GOAL_PARAMS = {
  hipertrofia: { label: 'Hipertrofia Muscular', setsComp: 4, setsIso: 3, reps: 10, repsMin: 8, repsMax: 12, restComp: 120, restIso: 75, prog: 'double', inc: 2.5 },
  forca: { label: 'Força Pura & Progressão de Carga', setsComp: 5, setsIso: 3, reps: 5, repsMin: 4, repsMax: 6, restComp: 180, restIso: 120, prog: 'linear', inc: 2.5 },
  emagrecimento: { label: 'Emagrecimento & Gasto Calórico', setsComp: 3, setsIso: 3, reps: 14, repsMin: 12, repsMax: 16, restComp: 60, restIso: 45, prog: 'double', inc: 2 },
  condicionamento: { label: 'Resistência & Condicionamento', setsComp: 3, setsIso: 2, reps: 15, repsMin: 12, repsMax: 20, restComp: 60, restIso: 45, prog: 'double', inc: 2 },
  adaptacao: { label: 'Adaptação / Retorno Seguro', setsComp: 3, setsIso: 2, reps: 12, repsMin: 10, repsMax: 15, restComp: 90, restIso: 60, prog: 'double', inc: 2 }
};

const LEVEL_MULTIPLIER = {
  iniciante: { setsDelta: -1, maxEx: 5, label: 'Iniciante' },
  intermediario: { setsDelta: 0, maxEx: 6, label: 'Intermediário' },
  avancado: { setsDelta: 0, maxEx: 7, label: 'Avançado' }
};

const CLINICAL_RULES = [
  {
    key: 'ombro',
    re: /ombro|manguito|supraespinal|bursite|tendinite.*ombro|shoulder|rotator/i,
    caution: 'Restrição de ombro detectada: priorizar pegada neutra/máquinas guiadas e evitar desenvolvimento atrás da nuca ou mergulho profundo em barras paralelas.',
    avoidRe: /behind neck|dips?\b|paralel|neck press|arnold/i
  },
  {
    key: 'joelho',
    re: /joelho|patela|condromal[aá]cia|menisco|lca|acl|knee/i,
    caution: 'Restrição de joelho detectada: evitar saltos/pliometria intensa e amplitudes dolorosas; monitorar alinhamento valgo dinâmico.',
    avoidRe: /jump|plyo|box jump|sissy|pistol/i
  },
  {
    key: 'lombar',
    re: /lombar|h[eé]rnia|ci[aá]tic|coluna|protus[aã]o|disc|lower back|spine/i,
    caution: 'Sensibilidade lombar detectada: reduzir carga axial livre (terra pesado / good morning) e priorizar remadas apoiadas e leg press controlado.',
    avoidRe: /good morning|barbell deadlift|levantamento terra tradicional|bent over.*barbell/i
  },
  {
    key: 'punho',
    re: /punho|carpo|tendinite.*m[aã]o|wrist/i,
    caution: 'Sensibilidade de punho detectada: preferir halteres neutros, cabos ou máquinas com apoio ergonômico.',
    avoidRe: /wrist curl|reverse barbell curl/i
  }
];

function extractClinicalFilters(clinicalText = '') {
  const cautions = [];
  const avoidPatterns = [];
  for (const rule of CLINICAL_RULES) {
    if (rule.re.test(clinicalText)) {
      cautions.push(rule.caution);
      avoidPatterns.push(rule.avoidRe);
    }
  }
  return { cautions, avoidPatterns };
}

function splitBlueprintsForDays(daysPerWeek, goalKey) {
  const d = Math.max(1, Math.min(6, Math.round(Number(daysPerWeek) || 3)));
  if (d === 1) {
    return [
      { name: 'Treino A — Full Body Base', glyph: 'figureStrength', days: [1], slots: ['chest', 'back', 'upper legs', 'shoulders', 'upper arms', 'waist'] }
    ];
  }
  if (d === 2) {
    return [
      { name: 'Treino A — Superiores Completo', glyph: 'figureStrength', days: [1], slots: ['chest', 'back', 'shoulders', 'upper arms', 'upper arms', 'waist'] },
      { name: 'Treino B — Inferiores & Core', glyph: 'figureLegs', days: [4], slots: ['upper legs', 'upper legs', 'upper legs', 'lower legs', 'waist', 'cardio'] }
    ];
  }
  if (d === 3) {
    return [
      { name: 'Treino A — Peito, Ombros & Tríceps', glyph: 'figurePush', days: [1], slots: ['chest', 'chest', 'shoulders', 'shoulders', 'upper arms', 'waist'] },
      { name: 'Treino B — Costas & Bíceps', glyph: 'figurePull', days: [3], slots: ['back', 'back', 'back', 'upper arms', 'upper arms', 'waist'] },
      { name: 'Treino C — Inferiores Completo', glyph: 'figureLegs', days: [5], slots: ['upper legs', 'upper legs', 'upper legs', 'lower legs', 'waist', ...(goalKey === 'emagrecimento' ? ['cardio'] : [])] }
    ];
  }
  if (d === 4) {
    return [
      { name: 'Treino A — Superiores (Força / Empurrar & Puxar)', glyph: 'figurePush', days: [1], slots: ['chest', 'back', 'shoulders', 'upper arms', 'upper arms', 'waist'] },
      { name: 'Treino B — Inferiores (Ênfase Quadríceps)', glyph: 'figureLegs', days: [2], slots: ['upper legs', 'upper legs', 'upper legs', 'lower legs', 'waist'] },
      { name: 'Treino C — Superiores (Volume & Ombros)', glyph: 'figurePull', days: [4], slots: ['back', 'chest', 'shoulders', 'shoulders', 'upper arms', 'upper arms'] },
      { name: 'Treino D — Inferiores (Posteriores & Glúteos)', glyph: 'figureLegs', days: [5], slots: ['upper legs', 'upper legs', 'upper legs', 'lower legs', 'cardio'] }
    ];
  }
  if (d === 5) {
    return [
      { name: 'Treino A — Peito & Tríceps', glyph: 'figurePush', days: [1], slots: ['chest', 'chest', 'chest', 'upper arms', 'upper arms', 'waist'] },
      { name: 'Treino B — Costas & Bíceps', glyph: 'figurePull', days: [2], slots: ['back', 'back', 'back', 'upper arms', 'upper arms', 'lower arms'] },
      { name: 'Treino C — Quadríceps & Panturrilha', glyph: 'figureLegs', days: [3], slots: ['upper legs', 'upper legs', 'upper legs', 'lower legs', 'waist'] },
      { name: 'Treino D — Ombros & Core', glyph: 'figureStrength', days: [4], slots: ['shoulders', 'shoulders', 'shoulders', 'chest', 'waist', 'waist'] },
      { name: 'Treino E — Posteriores, Glúteos & Condicionamento', glyph: 'figureLegs', days: [5], slots: ['upper legs', 'upper legs', 'upper legs', 'lower legs', 'cardio'] }
    ];
  }
  return [
    { name: 'Treino A — Push 1', glyph: 'figurePush', days: [1], slots: ['chest', 'chest', 'shoulders', 'upper arms', 'waist'] },
    { name: 'Treino B — Pull 1', glyph: 'figurePull', days: [2], slots: ['back', 'back', 'upper arms', 'lower arms', 'waist'] },
    { name: 'Treino C — Legs 1', glyph: 'figureLegs', days: [3], slots: ['upper legs', 'upper legs', 'upper legs', 'lower legs'] },
    { name: 'Treino D — Push 2', glyph: 'figurePush', days: [4], slots: ['shoulders', 'shoulders', 'chest', 'upper arms', 'waist'] },
    { name: 'Treino E — Pull 2', glyph: 'figurePull', days: [5], slots: ['back', 'back', 'back', 'upper arms', 'waist'] },
    { name: 'Treino F — Legs 2 & Cardio', glyph: 'figureLegs', days: [6], slots: ['upper legs', 'upper legs', 'lower legs', 'cardio'] }
  ];
}

function buildValidCandidatePool({ equipmentList, avoidPatterns, tenantCustomExercises, catalogueIndex }) {
  const ptById = catalogueIndex?.byId instanceof Map ? catalogueIndex.byId : new Map();
  const validMap = new Map();
  const byBodyPart = new Map();

  const pushCandidate = (entry) => {
    if (!entry?.id) return;
    validMap.set(entry.id, entry);
    const bp = String(entry.bp || 'other').toLowerCase();
    if (!byBodyPart.has(bp)) byBodyPart.set(bp, []);
    byBodyPart.get(bp).push(entry);
  };

  for (const rawCustom of Array.isArray(tenantCustomExercises) ? tenantCustomExercises : []) {
    if (!rawCustom?.id || !rawCustom?.name) continue;
    pushCandidate({
      id: String(rawCustom.id),
      name: String(rawCustom.name),
      bp: String(rawCustom.bodyPart || rawCustom.bp || 'other').toLowerCase(),
      eq: 'custom',
      custom: true,
      ...(rawCustom.url ? { customUrl: rawCustom.url } : {})
    });
  }

  for (const item of LIBRARY) {
    if (!item || !item.id || isStretch(item)) continue;
    if (equipmentList.length && !equipmentAllows(equipmentList, item.id)) continue;
    const catRow = ptById.get(item.id);
    const ptName = catRow?.pt || catRow?.name || item.n;
    const searchStr = `${item.n} ${ptName}`;
    if (avoidPatterns.some(re => re.test(searchStr))) continue;
    pushCandidate({
      id: item.id,
      name: ptName,
      bp: String(item.bp || catRow?.bodyPart || 'other').toLowerCase(),
      eq: String(item.eq || '').toLowerCase(),
      custom: false
    });
  }

  // Caso filtro clínico/equipamento deixe alguma categoria vazia, recarrega catálogo sem filtro restritivo
  if (validMap.size < 20) {
    for (const item of LIBRARY.slice(0, 200)) {
      if (!item || validMap.has(item.id) || isStretch(item)) continue;
      const catRow = ptById.get(item.id);
      pushCandidate({
        id: item.id,
        name: catRow?.pt || catRow?.name || item.n,
        bp: String(item.bp || 'other').toLowerCase(),
        eq: String(item.eq || '').toLowerCase(),
        custom: false
      });
    }
  }

  return { validMap, byBodyPart };
}

function summarizeRecentHistory(studentState, ptById) {
  const workouts = Array.isArray(studentState?.workouts) ? studentState.workouts.slice(-8) : [];
  const trainedNames = [];
  for (const w of workouts) {
    for (const e of Array.isArray(w?.entries) ? w.entries : []) {
      const n = ptById?.get(e?.id)?.pt || e?.name || e?.id;
      if (n && !trainedNames.includes(n)) trainedNames.push(n);
      if (trainedNames.length >= 16) break;
    }
    if (trainedNames.length >= 16) break;
  }
  return trainedNames;
}

function extractFirstJson(rawText) {
  const s = String(rawText || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : s;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeLlmWorkouts(parsed, validMap, goalSpec, levelSpec) {
  if (!parsed || !Array.isArray(parsed.workouts) || !parsed.workouts.length) return null;
  const out = [];
  const usedNames = new Set();

  for (let i = 0; i < Math.min(parsed.workouts.length, 6); i++) {
    const rw = parsed.workouts[i];
    if (!rw || typeof rw !== 'object') continue;
    const rawEx = Array.isArray(rw.ex) ? rw.ex : [];
    const seenIds = new Set();
    const ex = [];

    for (const item of rawEx) {
      const id = String(item?.id || '').trim();
      const catalogEx = validMap.get(id);
      if (!catalogEx || seenIds.has(id)) continue;
      seenIds.add(id);

      const setsRaw = Number(item.sets);
      const repsRaw = Number(item.reps);
      const restRaw = Number(item.rest);
      const sets = Number.isFinite(setsRaw) ? Math.max(1, Math.min(8, Math.round(setsRaw))) : Math.max(2, goalSpec.setsComp + levelSpec.setsDelta);
      const reps = Number.isFinite(repsRaw) ? Math.max(1, Math.min(40, Math.round(repsRaw))) : goalSpec.reps;
      const rest = Number.isFinite(restRaw) ? Math.max(20, Math.min(360, Math.round(restRaw))) : goalSpec.restComp;

      ex.push({
        id: catalogEx.id,
        name: catalogEx.name,
        sets,
        reps,
        repsMin: goalSpec.repsMin,
        repsMax: goalSpec.repsMax,
        rest,
        prog: ['linear', 'double', 'time', 'off'].includes(item.prog) ? item.prog : goalSpec.prog,
        inc: Number.isFinite(Number(item.inc)) ? Math.max(0.5, Math.min(20, Number(item.inc))) : goalSpec.inc,
        ...(catalogEx.custom ? { custom: true, ...(catalogEx.customUrl ? { customUrl: catalogEx.customUrl } : {}) } : {})
      });
      if (ex.length >= levelSpec.maxEx + 2) break;
    }

    if (!ex.length) continue;
    let name = String(rw.name || `Treino ${String.fromCharCode(65 + out.length)}`).trim().slice(0, 72);
    if (usedNames.has(name)) name = `${name} (${out.length + 1})`;
    usedNames.add(name);

    const days = Array.isArray(rw.days)
      ? rw.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
      : [];

    out.push({
      id: `ai_${out.length + 1}_${Date.now().toString(36)}`,
      name,
      glyph: String(rw.glyph || 'figureStrength'),
      emoji: String(rw.glyph || 'figureStrength'),
      days: Array.from(new Set(days)),
      ex
    });
  }

  return out.length ? out : null;
}

function buildDeterministicSplit({ daysPerWeek, goalKey, levelKey, focusMuscles, sessionMin, validPool, lastWeightsByEx }) {
  const goalSpec = GOAL_PARAMS[goalKey] || GOAL_PARAMS.hipertrofia;
  const levelSpec = LEVEL_MULTIPLIER[levelKey] || LEVEL_MULTIPLIER.intermediario;
  const blueprint = splitBlueprintsForDays(daysPerWeek, goalKey);
  const { validMap, byBodyPart } = validPool;
  const targetMaxEx = Math.max(3, Math.min(levelSpec.maxEx, Math.floor((Number(sessionMin) || 55) / 8)));
  const focusLower = Array.isArray(focusMuscles) ? focusMuscles.map(x => String(x || '').toLowerCase()) : [];

  const globalUsed = new Set();
  const workouts = [];

  for (let wIdx = 0; wIdx < blueprint.length; wIdx++) {
    const bpDay = blueprint[wIdx];
    const ex = [];
    const dayUsed = new Set();
    const slotQueue = bpDay.slots.slice(0, targetMaxEx);

    if (focusLower.length && slotQueue.length < targetMaxEx) {
      const f = focusLower[wIdx % focusLower.length];
      if (byBodyPart.has(f)) slotQueue.push(f);
    }

    for (let sIdx = 0; sIdx < slotQueue.length; sIdx++) {
      const bodyPart = slotQueue[sIdx];
      const candidates = byBodyPart.get(bodyPart) || Array.from(validMap.values());
      if (!candidates.length) continue;

      let picked = candidates.find(c => !dayUsed.has(c.id) && !globalUsed.has(c.id));
      if (!picked) picked = candidates.find(c => !dayUsed.has(c.id));
      if (!picked) continue;

      dayUsed.add(picked.id);
      globalUsed.add(picked.id);

      const isCompound = sIdx < 2;
      const setsBase = isCompound ? goalSpec.setsComp : goalSpec.setsIso;
      const sets = Math.max(2, Math.min(6, setsBase + levelSpec.setsDelta));
      const knownWeight = Number(lastWeightsByEx?.[picked.id]?.w);

      ex.push({
        id: picked.id,
        name: picked.name,
        sets,
        reps: goalSpec.reps,
        repsMin: goalSpec.repsMin,
        repsMax: goalSpec.repsMax,
        rest: isCompound ? goalSpec.restComp : goalSpec.restIso,
        prog: bodyPart === 'cardio' ? 'time' : goalSpec.prog,
        inc: goalSpec.inc,
        ...(Number.isFinite(knownWeight) && knownWeight > 0 ? { weight: knownWeight } : {}),
        ...(picked.custom ? { custom: true, ...(picked.customUrl ? { customUrl: picked.customUrl } : {}) } : {})
      });
    }

    if (ex.length) {
      workouts.push({
        id: `b2b_${wIdx + 1}_${Date.now().toString(36)}`,
        name: bpDay.name,
        glyph: bpDay.glyph,
        emoji: bpDay.glyph,
        days: bpDay.days,
        ex
      });
    }
  }

  return workouts;
}

/**
 * Gera sugestão estruturada de fichas para o Construtor Visual do professor.
 * Se o Coach LLM HTTP estiver configurado e responder JSON válido, utiliza o modelo;
 * caso contrário, utiliza o Motor Biomecânico determinístico com o mesmo catálogo oficial.
 */
export async function suggestTrainerWorkouts({
  student = null,
  studentState = null,
  params = {},
  tenantCustomExercises = [],
  catalogueIndex = null,
  fetchImpl = globalThis.fetch,
  mode = 'auto'
} = {}) {
  const goalKey = Object.prototype.hasOwnProperty.call(GOAL_PARAMS, String(params.goal || '').toLowerCase())
    ? String(params.goal).toLowerCase()
    : 'hipertrofia';
  const levelKey = Object.prototype.hasOwnProperty.call(LEVEL_MULTIPLIER, String(params.level || '').toLowerCase())
    ? String(params.level).toLowerCase()
    : 'intermediario';
  const daysPerWeek = Math.max(1, Math.min(6, Math.round(Number(params.daysPerWeek || 3))));
  const sessionMin = Math.max(25, Math.min(120, Math.round(Number(params.sessionMin || 55))));
  const equipmentPreset = Object.prototype.hasOwnProperty.call(EQUIPMENT_PRESETS, String(params.equipmentPreset || ''))
    ? String(params.equipmentPreset)
    : 'full_gym';
  const focusMuscles = Array.isArray(params.focusMuscles) ? params.focusMuscles.slice(0, 4) : [];

  const clinicalText = [
    params.clinicalNotes || '',
    student?.notes || '',
    student?.goal ? `Objetivo cadastro: ${student.goal}` : ''
  ].filter(Boolean).join(' | ').slice(0, 600);

  const { cautions, avoidPatterns } = extractClinicalFilters(clinicalText);
  const equipmentList = EQUIPMENT_PRESETS[equipmentPreset] || [];
  const validPool = buildValidCandidatePool({
    equipmentList,
    avoidPatterns,
    tenantCustomExercises,
    catalogueIndex
  });

  const goalSpec = GOAL_PARAMS[goalKey];
  const levelSpec = LEVEL_MULTIPLIER[levelKey];
  const ptById = catalogueIndex?.byId instanceof Map ? catalogueIndex.byId : new Map();

  let engine = 'biomechanical_engine';
  let providerUsed = null;
  let rationale = `Divisão em ${daysPerWeek} treino(s)/semana orientada a ${goalSpec.label} (${levelSpec.label}), com ${sessionMin} min estimados por sessão e progressão ${goalSpec.prog === 'linear' ? 'linear' : 'dupla'}.`;
  let llmWorkouts = null;

  if (mode !== 'rules' && isCoachEnabled()) {
    try {
      const cfg = loadCoachConfig();
      const pid = cfg?.provider;
      const adapter = HTTP_ADAPTERS[pid];
      if (adapter && cfg) {
        const acct = accountFor('trainer_b2b');
        const canCall = Boolean(cfg.providers?.[pid] && acct && !acct.refused);
        if (canCall) {
          const compactLib = [];
          for (const [bp, list] of validPool.byBodyPart.entries()) {
            const take = bp === 'cardio' || bp === 'lower legs' ? 6 : 14;
            for (const ex of list.slice(0, take)) {
              compactLib.push({ id: ex.id, n: ex.name, bp: ex.bp, eq: ex.eq });
              if (compactLib.length >= 130) break;
            }
            if (compactLib.length >= 130) break;
          }
          const recentEx = summarizeRecentHistory(studentState, ptById);
          const system = [
            'Você é um especialista em fisiologia do exercício e biomecânica auxiliando um Personal Trainer brasileiro.',
            'Retorne APENAS JSON válido no formato: { "rationale": "string curta pt-BR", "workouts": [ { "name": "Treino A — ...", "glyph": "figureStrength|figurePush|figurePull|figureLegs", "days": [1], "ex": [ { "id": "<CATALOG_ID>", "sets": 3, "reps": 10, "rest": 90, "prog": "double|linear|time" } ] } ] }.',
            'REGRA RÍGIDA: use EXCLUSIVAMENTE ids presentes na lista LIBRARY fornecida. Nunca invente ids.'
          ].join('\n');
          const prompt = JSON.stringify({
            objetivo: goalSpec.label,
            nivel: levelSpec.label,
            frequenciaSemanal: daysPerWeek,
            duracaoMin: sessionMin,
            foco: focusMuscles,
            observacoesClinicas: clinicalText.slice(0, 400),
            exerciciosRecentesAluno: recentEx,
            LIBRARY: compactLib
          });
          const env = jobEnv('', acct);
          const res = await adapter.invoke({
            cfg,
            prompt,
            system,
            env,
            model: cfg.providers?.[pid]?.model,
            maxTokens: 3200,
            timeoutMs: 35000,
            fetch: fetchImpl
          });
          if (res?.code === 0 && res.text) {
            const parsed = extractFirstJson(res.text);
            const normalized = normalizeLlmWorkouts(parsed, validPool.validMap, goalSpec, levelSpec);
            if (normalized && normalized.length) {
              llmWorkouts = normalized;
              engine = 'ai_coach';
              providerUsed = pid;
              if (typeof parsed?.rationale === 'string' && parsed.rationale.trim()) {
                rationale = parsed.rationale.trim().slice(0, 400);
              }
            }
          }
        }
      }
    } catch {
      // Fallback transparente para o motor biomecânico local
    }
  }

  const workouts = llmWorkouts || buildDeterministicSplit({
    daysPerWeek,
    goalKey,
    levelKey,
    focusMuscles,
    sessionMin,
    validPool,
    lastWeightsByEx: studentState?.exWeights || {}
  });

  return {
    ok: true,
    engine,
    providerUsed,
    rationale,
    cautions,
    goal: goalKey,
    level: levelKey,
    equipmentPreset,
    workouts
  };
}
