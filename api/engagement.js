/* Régua Autônoma de Engajamento & Retenção (Fase 3.3).
 *
 * Avalia periodicamente por academia ativa:
 *   1. Check-in semanal (sexta/domingo ou manual): resumo de treinos, tonelagem e PRs via WhatsApp/Push.
 *   2. Aniversário de ficha (~25 dias ou cycleDays - 5): alerta ao professor para renovar o ciclo.
 *   3. Régua automática de retenção (inativos >= autoChurnDays): dispara nudges respeitando `excusedOn`.
 *
 * Todas as mensagens usam chaves determinísticas de deduplicação (`dedupKey` no outbox + KV SQLite)
 * para garantir zero duplicidade mesmo após reinicializações do servidor.
 */
import { listStudents, readStudentState } from './trainer.js';
import { getTenantAccessState, listTenants, resolveTenantEvolutionSettings } from './tenants.js';
import { getSqliteKv, setSqliteKv } from './sqlite.js';
import {
  cleanWhatsAppPhone,
  enqueueWhatsAppBatch,
  formatChurnRecoveryWhatsAppMessage,
  formatRoutineExpiryTrainerMessage,
  formatWeeklyCheckinWhatsAppMessage
} from './whatsapp.js';
import { nudgePush, routineRenewalPush, weeklySummaryPush } from './push-messages.js';
import { excusedOn } from './nudge.js';

const MARKS_KV_KEY = 'engagement_marks_v1';
const MARKS_TTL_MS = 45 * 86400000;
const LB_TO_KG = 0.45359237;

function brtDateParts(nowMs = Date.now()) {
  const brt = new Date(nowMs - 3 * 3600 * 1000);
  const iso = brt.toISOString().slice(0, 10);
  const dow = brt.getUTCDay();
  const hour = brt.getUTCHours();
  // Chave de semana (segunda-feira base da semana atual)
  const mondayShift = (dow + 6) % 7;
  const mondayMs = brt.getTime() - mondayShift * 86400000;
  const weekIso = new Date(mondayMs).toISOString().slice(0, 10);
  return { iso, dow, hour, weekIso };
}

function loadMarks(dataDir) {
  const raw = getSqliteKv(dataDir, MARKS_KV_KEY, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
}

function saveMarks(dataDir, marks, nowMs = Date.now()) {
  const cutoff = nowMs - MARKS_TTL_MS;
  const pruned = {};
  for (const [k, ts] of Object.entries(marks || {})) {
    if (Number(ts) >= cutoff) pruned[k] = Number(ts);
  }
  setSqliteKv(dataDir, MARKS_KV_KEY, pruned);
}

/**
 * Calcula estatísticas dos últimos 7 dias do aluno para o Check-in Semanal.
 */
export function computeStudentWeeklyStats(state, nowMs = Date.now()) {
  const brtToday = brtDateParts(nowMs).iso;
  const sevenDaysAgoIso = brtDateParts(nowMs - 6 * 86400000).iso;
  const workouts = Array.isArray(state?.workouts) ? state.workouts : [];
  const weekPlan = state?.week && typeof state.week === 'object' ? state.week : {};
  const plannedDays = Object.values(weekPlan).filter(Boolean).length;

  let workoutsCount = 0;
  let totalVolKg = 0;
  let prsCount = 0;
  for (const w of workouts) {
    if (!w || typeof w !== 'object') continue;
    const d = String(w.d || '').slice(0, 10);
    if (!d || d < sevenDaysAgoIso || d > brtToday) continue;
    workoutsCount += 1;
    let wVol = Number(w.vol);
    if (!Number.isFinite(wVol) || wVol <= 0) {
      wVol = 0;
      for (const e of Array.isArray(w.entries) ? w.entries : []) {
        for (const s of Array.isArray(e?.sets) ? e.sets : []) {
          if (s && s.done !== false && !s.warmup) {
            const sw = Number(s.w) || 0;
            const sr = Number(s.r) || 0;
            if (sw > 0 && sr > 0) wVol += sw * sr;
          }
        }
      }
    }
    totalVolKg += wVol;
    if (Array.isArray(w.prs)) prsCount += w.prs.length;
    else if (Number.isFinite(Number(w.prsCount))) prsCount += Number(w.prsCount);
  }

  return {
    windowStart: sevenDaysAgoIso,
    windowEnd: brtToday,
    workoutsCount,
    plannedDays,
    totalVolKg: Math.round(totalVolKg * (state?.unit === 'lb' ? LB_TO_KG : 1)),
    prsCount
  };
}

/**
 * Executa as regras de engajamento configuradas para uma academia específica.
 */
export async function evaluateTenantEngagement({
  dataDir,
  tenant,
  db,
  stateOps = null,
  sendPushFn = null,
  nowMs = Date.now(),
  forceWeekly = false,
  dryRun = false
}) {
  const result = {
    tenantId: tenant?.id || 'default',
    weeklyQueued: 0,
    weeklyPushSent: 0,
    expiryAlertsQueued: 0,
    churnNudgesQueued: 0,
    churnPushSent: 0,
    skippedExcused: 0,
    actions: []
  };
  if (!tenant?.id || tenant.id === 'default') return result;

  const access = getTenantAccessState(dataDir, tenant.id, nowMs);
  if (access.blocked) return result;

  const s = tenant.settings || {};
  const runWeekly = Boolean(s.autoWeeklyCheckin || forceWeekly);
  const runExpiry = Boolean(s.autoRoutineExpiryAlert);
  const runChurn = Boolean(s.autoChurnNudge);
  if (!runWeekly && !runExpiry && !runChurn) return result;

  const { iso: todayIso, dow, hour, weekIso } = brtDateParts(nowMs);
  const isWeeklyDay = forceWeekly || ((dow === 5 || dow === 0) && hour >= 9);
  const churnThreshold = Math.max(1, Number(s.churnDaysThreshold || 5));
  const autoChurnDays = Math.max(3, Number(s.autoChurnDays || 7));
  const routineCycleDays = Math.max(7, Number(s.routineCycleDays || 30));
  const alertAtAgeDays = Math.max(7, routineCycleDays - 5);

  const evo = resolveTenantEvolutionSettings(dataDir, tenant.id);
  const hasWa = Boolean(evo.evolutionUrl && evo.evolutionInstance);
  const tenantSettings = { ...s, ...evo };

  const users = Array.isArray(db?.users) ? db.users : [];
  const staffById = new Map(
    users
      .filter(u => (u.tenantId || 'default') === tenant.id && u.role !== 'student' && !u.disabled)
      .map(u => [u.id, u])
  );
  const fallbackOwner = users.find(
    u => (u.tenantId || 'default') === tenant.id && (u.role === 'gym_owner' || u.role === 'gym_manager') && !u.disabled && cleanWhatsAppPhone(u.phone)
  ) || null;

  const students = listStudents(db, dataDir, {
    tenantId: tenant.id,
    includeDisabled: false,
    churnDaysThreshold: churnThreshold,
    routineCycleDays,
    stateOps,
    nowMs
  });

  const marks = loadMarks(dataDir);
  let marksChanged = false;
  const waWeeklyItems = [];
  const waExpiryItems = [];
  const waChurnItems = [];

  for (const st of students) {
    const state = readStudentState(dataDir, st.id, stateOps);
    const trainer = st.assignedTrainerId ? staffById.get(st.assignedTrainerId) : null;
    const trainerName = trainer?.name || st.assignedTrainerName || '';
    const phone = cleanWhatsAppPhone(st.phone);
    const lang = state?.lang || 'pt';

    // 1. Check-in Semanal (sexta/domingo)
    if (runWeekly && isWeeklyDay) {
      const weeklyKey = `weekly:${tenant.id}:${st.id}:${todayIso}`;
      const stats = computeStudentWeeklyStats(state, nowMs);
      if (!marks[weeklyKey] && (stats.workoutsCount > 0 || st.routineCount > 0)) {
        result.actions.push({ type: 'weekly_checkin', studentId: st.id, studentName: st.name, stats });
        if (!dryRun) {
          marks[weeklyKey] = nowMs;
          marksChanged = true;
          if (hasWa && phone) {
            waWeeklyItems.push({
              phone,
              userId: st.id,
              targetName: st.name,
              dedupKey: weeklyKey,
              message: formatWeeklyCheckinWhatsAppMessage({
                studentName: st.name,
                workoutsCount: stats.workoutsCount,
                plannedDays: stats.plannedDays,
                totalVolKg: stats.totalVolKg,
                prsCount: stats.prsCount,
                tenantName: tenant.name,
                trainerName
              })
            });
          }
          if (typeof sendPushFn === 'function') {
            try {
              await sendPushFn(st.id, weeklySummaryPush(lang, stats));
              result.weeklyPushSent += 1;
            } catch { /* ignore push errors */ }
          }
        }
      }
    }

    // 2. Aniversário / Vencimento próximo de ficha (avisa professor e push opcional)
    if (runExpiry && st.routineAgeDays !== null && st.routineAgeDays >= alertAtAgeDays) {
      const expiryKey = `expiry:${tenant.id}:${st.id}:${weekIso}`;
      if (!marks[expiryKey]) {
        const targetStaff = trainer && cleanWhatsAppPhone(trainer.phone) ? trainer : fallbackOwner;
        const staffPhone = cleanWhatsAppPhone(targetStaff?.phone || tenant.phone);
        const routineName = Array.isArray(st.routineNames) && st.routineNames.length ? st.routineNames.join(', ') : 'Ficha atual';
        result.actions.push({
          type: 'routine_expiry',
          studentId: st.id,
          studentName: st.name,
          routineAgeDays: st.routineAgeDays
        });
        if (!dryRun) {
          marks[expiryKey] = nowMs;
          marksChanged = true;
          if (hasWa && staffPhone) {
            waExpiryItems.push({
              phone: staffPhone,
              userId: targetStaff?.id || null,
              targetName: targetStaff?.name || tenant.name,
              dedupKey: expiryKey,
              message: formatRoutineExpiryTrainerMessage({
                trainerName: targetStaff?.name || trainerName || 'Professor',
                studentName: st.name,
                routineName,
                daysAge: st.routineAgeDays,
                cycleDays: routineCycleDays,
                tenantName: tenant.name
              })
            });
          }
          if (typeof sendPushFn === 'function') {
            try {
              await sendPushFn(st.id, routineRenewalPush(lang, { daysSince: st.routineAgeDays, trainerName }));
            } catch { /* ignore */ }
          }
        }
      }
    }

    // 3. Nudge automático de retenção respeitando `excusedOn`
    if (runChurn && !st.disabled && Number(st.daysInactive) >= autoChurnDays) {
      if (excusedOn(state, todayIso) || st.excused || st.churnStatus === 'excused') {
        result.skippedExcused += 1;
      } else {
        const churnKey = `churn_auto:${tenant.id}:${st.id}:${weekIso}`;
        if (!marks[churnKey]) {
          result.actions.push({
            type: 'churn_nudge',
            studentId: st.id,
            studentName: st.name,
            daysInactive: st.daysInactive
          });
          if (!dryRun) {
            marks[churnKey] = nowMs;
            marksChanged = true;
            if (hasWa && phone) {
              waChurnItems.push({
                phone,
                userId: st.id,
                targetName: st.name,
                dedupKey: churnKey,
                message: formatChurnRecoveryWhatsAppMessage({
                  studentName: st.name,
                  daysInactive: st.daysInactive,
                  tenantName: tenant.name,
                  trainerName
                })
              });
            }
            if (typeof sendPushFn === 'function') {
              try {
                const topRoutine = Array.isArray(state?.routines) && state.routines[0]?.name ? state.routines[0].name : '';
                await sendPushFn(st.id, nudgePush(lang, st.daysInactive >= 14 ? 'long' : 'soft', topRoutine));
                result.churnPushSent += 1;
              } catch { /* ignore */ }
            }
          }
        }
      }
    }
  }

  if (!dryRun) {
    if (waWeeklyItems.length) {
      const q = enqueueWhatsAppBatch({ dataDir, tenantId: tenant.id, kind: 'weekly_checkin', items: waWeeklyItems, tenantSettings });
      result.weeklyQueued = q.count || 0;
    }
    if (waExpiryItems.length) {
      const q = enqueueWhatsAppBatch({ dataDir, tenantId: tenant.id, kind: 'routine_expiry_alert', items: waExpiryItems, tenantSettings });
      result.expiryAlertsQueued = q.count || 0;
    }
    if (waChurnItems.length) {
      const q = enqueueWhatsAppBatch({ dataDir, tenantId: tenant.id, kind: 'auto_churn_nudge', items: waChurnItems, tenantSettings });
      result.churnNudgesQueued = q.count || 0;
    }
    if (marksChanged) saveMarks(dataDir, marks, nowMs);
  }

  return result;
}

/**
 * Executa a régua autônoma para todas as academias elegíveis da instância.
 */
export async function runAllTenantsEngagementTick({
  dataDir,
  db,
  stateOps = null,
  sendPushFn = null,
  nowMs = Date.now()
}) {
  const tenants = listTenants(dataDir);
  const summaries = [];
  for (const t of tenants) {
    if (!t || !t.id || t.id === 'default') continue;
    const s = t.settings || {};
    if (!s.autoWeeklyCheckin && !s.autoRoutineExpiryAlert && !s.autoChurnNudge) continue;
    try {
      const summary = await evaluateTenantEngagement({
        dataDir,
        tenant: t,
        db,
        stateOps,
        sendPushFn,
        nowMs
      });
      summaries.push(summary);
    } catch { /* isolate tenant errors */ }
  }
  return summaries;
}
