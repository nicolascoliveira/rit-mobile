import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  resolveTenantId,
  resolveEffectiveTenantId,
  sanitizeTenantId,
  getTenantDir,
  getTenant,
  resolveTenantEvolutionSettings,
  loadTenantBranding,
  saveTenantBranding,
  listTenants,
  createTenant,
  updateTenant,
  deleteTenant,
  recordTenantInvoice,
  reservePixCheckoutInvoice,
  finalizePixCheckoutInvoice,
  failPixCheckoutInvoice,
  confirmTenantPayment,
  parseMpExternalReference,
  isMpPaymentAlreadyPaid,
  applyGatewayPaymentUpdate,
  listSaasPlans,
  upsertSaasPlan,
  loadSaasStore,
  saveSaasStore,
  isTenantSuspended,
  getTenantAccessState,
  isPersonalPlan,
  DomainError,
  DEFAULT_BRANDING
} from './tenants.js';
import {
  getSqliteInstance,
  runInTransaction,
  upsertUserSqlite,
  deleteUserSqlite,
  upsertInviteSqlite,
  deleteInviteSqlite,
  isSqliteUniqueConstraintError,
  registerWebhookEventSqlite,
  acquireApiIdempotencySqlite,
  completeApiIdempotencySqlite,
  markApiIdempotencyRetryableSqlite,
  getApiIdempotencyRecordSqlite
} from './sqlite.js';
import { scheduleWebhookFlush } from './webhook-worker.js';
import { HASH_RE, MediaError } from './media.js';
import {
  TENANT_CUSTOM_EX_PREFIX,
  tenantMediaBucket,
  listTenantExerciseOverrides,
  upsertTenantExerciseOverride,
  deleteTenantExerciseOverride,
  listTenantCustomExercises,
  upsertTenantCustomExercise,
  deleteTenantCustomExercise,
  getTenantExercisesPayload,
  clearTenantExercisesData
} from './exercise-media.js';
import {
  isTrainerOrAdmin,
  isGymManagerOrOwner,
  loadTemplates,
  importDefaultTemplates,
  upsertTemplate,
  removeTemplate,
  listStudents,
  readStudentState,
  saveStudentState,
  prescribeRoutineToStudent,
  prescribeRoutinesBatchToStudent,
  removeStudentRoutine,
  updateStudentWeekSchedule,
  normalizeBodyweightSeries,
  computeBodyComparison,
  recordStudentAssessment,
  archiveStudentRoutines,
  buildExerciseLoadHistory,
  collectStudentFormVideos,
  saveStudentVideoReview,
  isMediaHashInStudentState
} from './trainer.js';
import {
  prescriptionPush,
  assessmentPush,
  videoReviewPush,
  weeklySummaryPush
} from './push-messages.js';
import {
  computeStudentWeeklyStats,
  evaluateTenantEngagement
} from './engagement.js';
import { MAX_STUDENT_IMPORT_ROWS, parseStudentImportRows } from './student-import.js';
import {
  hashPassword,
  verifyPassword,
  normalizeEmail,
  nameKey,
  passwordProblem,
  MIN_LENGTH,
  MAX_LENGTH,
  makeResetCode,
  hashResetCode,
  RESET_TTL_MS
} from './password.js';
import {
  cleanWhatsAppPhone,
  validateEvolutionUrl,
  sendEvolutionTextMessage,
  testEvolutionConnection,
  fetchEvolutionQrCode,
  disconnectEvolutionInstance,
  fetchEvolutionInstances,
  dispatchWhatsAppWithRetry,
  enqueueWhatsAppBatch,
  flushWhatsAppOutbox,
  getTenantWhatsAppOutbox,
  notifyRoutinePrescribed,
  buildStudentInviteSignupUrl,
  formatStudentWelcomeWhatsAppMessage,
  notifyStudentWelcomeInvite,
  formatChurnRecoveryWhatsAppMessage,
  formatWeeklyCheckinWhatsAppMessage,
  formatAssessmentSummaryWhatsAppMessage,
  formatVideoReviewWhatsAppMessage
} from './whatsapp.js';
import {
  createPixPayment,
  getPayment,
  verifyWebhookSignature,
  isMercadoPagoConfigured,
  isPixSimulationAllowed
} from './mercadopago.js';
import { EXERCISES } from './coach/core/library-data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- Catálogo de Exercícios em Memória (5.632 exercícios + PT-BR) ---------- */
export const BP_LABELS_PT = {
  chest: 'Peito',
  back: 'Costas',
  'upper legs': 'Pernas (Coxa & Glúteo)',
  'lower legs': 'Panturrilhas',
  shoulders: 'Ombros',
  'upper arms': 'Braços (Bíceps & Tríceps)',
  'lower arms': 'Antebraços',
  waist: 'Abdômen & Core',
  cardio: 'Cardio',
  'full body': 'Corpo Inteiro',
  neck: 'Pescoço'
};

export const EQ_LABELS_PT = {
  barbell: 'Barra',
  dumbbell: 'Halteres',
  cable: 'Polia / Cabo',
  'leverage machine': 'Máquina Articulada',
  'smith machine': 'Barra Guiada (Smith)',
  'sled machine': 'Leg Press / Trenó',
  'body weight': 'Peso do Corpo',
  band: 'Faixa Elástica',
  kettlebell: 'Kettlebell',
  'ez barbell': 'Barra W',
  'olympic barbell': 'Barra Olímpica',
  'medicine ball': 'Medicine Ball',
  'stability ball': 'Bola Suíça',
  assisted: 'Graviton / Assistido',
  rope: 'Corda',
  weighted: 'Com Carga Extra'
};

let _catalogueCache = null;
const foldSearch = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

export function getCatalogueIndex() {
  if (_catalogueCache) return _catalogueCache;
  let ptMap = {};
  const candidateFiles = [
    path.join(__dirname, '..', 'catalogue', 'i18n', 'pt-BR.json'),
    path.join(__dirname, 'i18n', 'pt-BR.json')
  ];
  try {
    const ptFile = candidateFiles.find(f => fs.existsSync(f));
    if (ptFile) {
      ptMap = JSON.parse(fs.readFileSync(ptFile, 'utf8'));
    }
  } catch (e) {
    console.warn('Catálogo PT-BR não carregado:', e.message);
  }

  const items = EXERCISES.map((ex, idx) => {
    const pt = ptMap[ex.id];
    const rawName = pt?.name || ex.n;
    const displayName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    const bpLabel = BP_LABELS_PT[ex.bp] || ex.bp;
    const eqLabel = EQ_LABELS_PT[ex.eq] || ex.eq;
    return {
      id: ex.id,
      name: displayName,
      enName: ex.n,
      bp: ex.bp,
      bpLabel,
      tg: ex.tg,
      eq: ex.eq,
      eqLabel,
      tier: idx < 1240 ? 1 : (idx < 4549 ? 2 : 3),
      instructions: Array.isArray(pt?.instructions) ? pt.instructions.slice(0, 5) : [],
      thumb: `/exercise-media/still/${ex.id}.webp`,
      _f: foldSearch(displayName),
      _q: foldSearch(`${displayName} ${ex.n} ${bpLabel} ${eqLabel} ${ex.tg}`)
    };
  });

  const byId = new Map(items.map(it => [it.id, it]));
  _catalogueCache = { items, byId };
  return _catalogueCache;
}

function toPublicExercise(it) {
  const { _q, _f, ...rest } = it;
  return rest;
}

function saasPublicUser(u, isAdminFn) {
  if (!u) return null;
  const isSuper = u.saasRole === 'superadmin' || (isAdminFn?.(u) && !u.tenantId);
  return {
    id: u.id,
    name: u.name,
    email: u.email || '',
    phone: u.phone || '',
    saasRole: isSuper ? 'superadmin' : (u.saasRole || (u.role === 'trainer' ? 'trainer' : 'student')),
    role: u.role || (u.saasRole === 'trainer' ? 'trainer' : 'student'),
    tenantId: u.tenantId || null,
    admin: Boolean(isSuper || isAdminFn?.(u))
  };
}

/**
 * Cria dados realistas de demonstração B2B (idempotente).
 */
export async function ensureSaasDemoSeed({ dataDir, db, saveDb, stateOps }) {
  if (process.env.SAAS_DEMO !== '1' && process.env.SAAS_AUTO_SEED !== '1') {
    return { skipped: true, reason: 'Modo demonstração inativo (SAAS_DEMO !== 1)' };
  }
  const store = loadSaasStore(dataDir);
  if (store.seededAt && Object.keys(store.tenants).length > 0) {
    return { alreadySeeded: true, tenants: Object.keys(store.tenants).length };
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const isoDaysAgo = d => new Date(now - d * 86400000).toISOString().slice(0, 10);

  // Hash único reutilizado nos perfis demo para boot instantâneo (< 150ms)
  const defaultPwHash = await hashPassword('rit2026');

  // 1. Garante Super Admin Dono do SaaS
  let superAdmin = db.users.find(u => u.saasRole === 'superadmin' || u.email === 'admin@rit.com.br');
  if (!superAdmin) {
    superAdmin = {
      id: 'u_saas_owner',
      name: 'Nicolas Oliveira',
      email: 'admin@rit.com.br',
      saasRole: 'superadmin',
      admin: true,
      owner: !db.users.some(u => u.owner),
      created: new Date(now - 120 * 86400000).toISOString(),
      pw: { h: defaultPwHash, set: nowIso }
    };
    db.users.push(superAdmin);
  } else {
    superAdmin.saasRole = 'superadmin';
    if (!superAdmin.pw) superAdmin.pw = { h: defaultPwHash, set: nowIso };
  }

  // 2. Academias Clientes
  const demoGyms = [
    {
      id: 'ironpower',
      name: 'Iron Power Matriz',
      document: '34.812.901/0001-40',
      ownerName: 'Carlos Eduardo Mendes',
      ownerEmail: 'carlos@ironpower.com.br',
      phone: '11998765432',
      city: 'São Paulo, SP',
      address: 'Av. Paulista, 1450 — Bela Vista',
      planId: 'pro',
      mrr: 269,
      status: 'active',
      primaryColor: '#D0FF00',
      slogan: 'Performance e hipertrofia sem atalhos',
      createdAt: new Date(now - 95 * 86400000).toISOString(),
      invoices: [
        { id: 'inv_ip_3', refMonth: nowIso.slice(0, 7), amount: 269, status: 'paid', paidAt: new Date(now - 4 * 86400000).toISOString(), method: 'PIX', note: 'Mensalidade Academia Completa' },
        { id: 'inv_ip_2', refMonth: new Date(now - 32 * 86400000).toISOString().slice(0, 7), amount: 269, status: 'paid', paidAt: new Date(now - 34 * 86400000).toISOString(), method: 'PIX', note: 'Mensalidade Academia Completa' },
        { id: 'inv_ip_1', refMonth: new Date(now - 62 * 86400000).toISOString().slice(0, 7), amount: 269, status: 'paid', paidAt: new Date(now - 64 * 86400000).toISOString(), method: 'Cartão', note: 'Adesão Academia Completa' }
      ],
      trainers: [
        { id: 'u_tr_marcos', name: 'Prof. Marcos Silva', email: 'marcos@ironpower.com.br', cref: '098412-G/SP', specialty: 'Hipertrofia & Biomecânica' },
        { id: 'u_tr_juliana', name: 'Profa. Juliana Costa', email: 'juliana@ironpower.com.br', cref: '114209-G/SP', specialty: 'Emagrecimento & Glúteos' }
      ],
      students: [
        { id: 'u_st_lucas', name: 'Lucas Oliveira', email: 'lucas@aluno.com', phone: '11988112233', goal: 'Hipertrofia', trainerId: 'u_tr_marcos', workoutDaysAgo: [0, 1, 3, 5, 7, 9, 11, 14], split: 'abc' },
        { id: 'u_st_mariana', name: 'Mariana Santos', email: 'mariana@aluno.com', phone: '11988223344', goal: 'Definição & Glúteos', trainerId: 'u_tr_juliana', workoutDaysAgo: [1, 2, 4, 6, 8, 11], split: 'abc' },
        { id: 'u_st_rafael', name: 'Rafael Almeida', email: 'rafael@aluno.com', phone: '11988334455', goal: 'Força Pura', trainerId: 'u_tr_marcos', workoutDaysAgo: [6, 10, 14, 18], split: 'abc' },
        { id: 'u_st_camila', name: 'Camila Rocha', email: 'camila@aluno.com', phone: '11988445566', goal: 'Condicionamento', trainerId: 'u_tr_juliana', workoutDaysAgo: [12, 19, 25], split: 'adapt' },
        { id: 'u_st_pedro', name: 'Pedro Henrique', email: 'pedro@aluno.com', phone: '11988556677', goal: 'Adaptação Iniciante', trainerId: 'u_tr_marcos', workoutDaysAgo: [0, 2, 5, 8], split: 'adapt' },
        { id: 'u_st_fernanda', name: 'Fernanda Lima', email: 'fernanda@aluno.com', phone: '11988667788', goal: 'Emagrecimento', trainerId: 'u_tr_juliana', workoutDaysAgo: [8, 15, 22], split: 'adapt' }
      ]
    },
    {
      id: 'studiopulse',
      name: 'Studio Pulse Boutique',
      document: '48.209.115/0001-18',
      ownerName: 'Renata Alencar',
      ownerEmail: 'renata@studiopulse.com.br',
      phone: '21997112200',
      city: 'Rio de Janeiro, RJ',
      address: 'Rua Garcia d\'Ávila, 88 — Ipanema',
      planId: 'pro',
      mrr: 269,
      status: 'active',
      primaryColor: '#38bdf8',
      slogan: 'Treinamento personalizado de alto padrão',
      createdAt: new Date(now - 65 * 86400000).toISOString(),
      invoices: [
        { id: 'inv_sp_2', refMonth: nowIso.slice(0, 7), amount: 269, status: 'paid', paidAt: new Date(now - 2 * 86400000).toISOString(), method: 'PIX', note: 'Mensalidade Academia Completa' },
        { id: 'inv_sp_1', refMonth: new Date(now - 32 * 86400000).toISOString().slice(0, 7), amount: 269, status: 'paid', paidAt: new Date(now - 32 * 86400000).toISOString(), method: 'PIX', note: 'Mensalidade Academia Completa' }
      ],
      trainers: [
        { id: 'u_tr_thiago', name: 'Prof. Thiago Nunes', email: 'thiago@studiopulse.com.br', cref: '052310-G/RJ', specialty: 'Personal Premium & Reabilitação' }
      ],
      students: [
        { id: 'u_st_beatriz', name: 'Beatriz Vasconcelos', email: 'beatriz@pulse.com', phone: '21996554433', goal: 'Longevidade & Tônus', trainerId: 'u_tr_thiago', workoutDaysAgo: [0, 2, 4, 7, 9], split: 'abc' },
        { id: 'u_st_gustavo', name: 'Gustavo Ribeiro', email: 'gustavo@pulse.com', phone: '21996443322', goal: 'Hipertrofia', trainerId: 'u_tr_thiago', workoutDaysAgo: [1, 3, 6, 9, 12], split: 'abc' },
        { id: 'u_st_helena', name: 'Helena Castro', email: 'helena@pulse.com', phone: '21996332211', goal: 'Pós-reabilitação', trainerId: 'u_tr_thiago', workoutDaysAgo: [7, 14], split: 'adapt' }
      ]
    },
    {
      id: 'arenacross',
      name: 'Arena Cross & Funcional',
      document: '51.903.442/0001-09',
      ownerName: 'Bruno Ferreira',
      ownerEmail: 'bruno@arenacross.com.br',
      phone: '31995118899',
      city: 'Belo Horizonte, MG',
      address: 'Av. do Contorno, 6120 — Savassi',
      planId: 'starter',
      mrr: 169,
      status: 'trial',
      primaryColor: '#fb923c',
      slogan: 'Condicionamento real todos os dias',
      createdAt: new Date(now - 6 * 86400000).toISOString(),
      invoices: [],
      trainers: [],
      students: [
        { id: 'u_st_diego', name: 'Diego Martins', email: 'diego@arena.com', phone: '31988110022', goal: 'Condicionamento', trainerId: null, workoutDaysAgo: [1, 3, 5], split: 'adapt' },
        { id: 'u_st_larissa', name: 'Larissa Teixeira', email: 'larissa@arena.com', phone: '31988110033', goal: 'Força Funcional', trainerId: null, workoutDaysAgo: [2, 4], split: 'adapt' }
      ]
    },
    {
      id: 'fitclub',
      name: 'FitClub Centro',
      document: '29.110.774/0001-82',
      ownerName: 'Paulo Henrique Souza',
      ownerEmail: 'paulo@fitclub.com.br',
      phone: '41991234567',
      city: 'Curitiba, PR',
      address: 'Rua XV de Novembro, 410 — Centro',
      planId: 'starter',
      mrr: 169,
      status: 'past_due',
      primaryColor: '#f43f5e',
      slogan: 'Sua academia no coração da cidade',
      createdAt: new Date(now - 45 * 86400000).toISOString(),
      invoices: [
        { id: 'inv_fc_2', refMonth: nowIso.slice(0, 7), amount: 169, status: 'overdue', paidAt: null, method: 'PIX', note: 'Vencida há 5 dias' },
        { id: 'inv_fc_1', refMonth: new Date(now - 32 * 86400000).toISOString().slice(0, 7), amount: 169, status: 'paid', paidAt: new Date(now - 33 * 86400000).toISOString(), method: 'PIX', note: 'Adesão Estúdio' }
      ],
      trainers: [],
      students: [
        { id: 'u_st_igor', name: 'Igor Batista', email: 'igor@fitclub.com', phone: '41988776655', goal: 'Hipertrofia', trainerId: null, workoutDaysAgo: [9, 16], split: 'adapt' }
      ]
    },
    {
      id: 'thiagopersonal',
      accountType: 'personal',
      name: 'Thiago Mendes Personal',
      document: '382.910.448-12',
      ownerName: 'Thiago Mendes',
      ownerEmail: 'thiago@personal.com.br',
      phone: '11994448877',
      city: 'São Paulo, SP',
      address: 'Consultoria Online & Presencial — CREF 142890-G/SP',
      planId: 'personal-pro',
      mrr: 49,
      status: 'active',
      primaryColor: '#D0FF00',
      slogan: 'Consultoria individual e periodização sob medida',
      createdAt: new Date(now - 28 * 86400000).toISOString(),
      invoices: [
        { id: 'inv_tp_1', refMonth: nowIso.slice(0, 7), amount: 49, status: 'paid', paidAt: new Date(now - 3 * 86400000).toISOString(), method: 'PIX', note: 'Assinatura Personal Completo' }
      ],
      trainers: [],
      students: [
        { id: 'u_st_bruna', name: 'Bruna Cavalcanti', email: 'bruna@consultoria.com', phone: '11988001122', goal: 'Definição & Glúteos (Online)', trainerId: null, workoutDaysAgo: [0, 2, 4, 7, 10], split: 'abc' },
        { id: 'u_st_rodrigo', name: 'Rodrigo Tavares', email: 'rodrigo@consultoria.com', phone: '11988003344', goal: 'Hipertrofia Presencial', trainerId: null, workoutDaysAgo: [1, 3, 6, 9], split: 'abc' },
        { id: 'u_st_patricia', name: 'Patrícia Moura', email: 'patricia@consultoria.com', phone: '11988005566', goal: 'Recondicionamento & Postura', trainerId: null, workoutDaysAgo: [8, 15], split: 'adapt' }
      ]
    }
  ];

  for (const g of demoGyms) {
    const tDir = getTenantDir(dataDir, g.id);
    const templates = loadTemplates(tDir, { seedIfMissing: true });

    // Owner user
    const ownerId = `u_owner_${g.id}`;
    if (!db.users.some(u => u.id === ownerId || u.email === g.ownerEmail)) {
      db.users.push({
        id: ownerId,
        name: g.ownerName,
        email: g.ownerEmail,
        phone: g.phone,
        tenantId: g.id,
        saasRole: 'gym_owner',
        role: 'trainer',
        created: g.createdAt,
        pw: { h: defaultPwHash, set: g.createdAt }
      });
    }

    try {
      createTenant(dataDir, {
        ...g,
        ownerUserId: ownerId
      });
    } catch { /* ignore if exists */ }

    for (const tr of g.trainers) {
      if (!db.users.some(u => u.id === tr.id || u.email === tr.email)) {
        db.users.push({
          id: tr.id,
          name: tr.name,
          email: tr.email,
          cref: tr.cref,
          specialty: tr.specialty,
          tenantId: g.id,
          saasRole: 'trainer',
          role: 'trainer',
          created: g.createdAt,
          pw: { h: defaultPwHash, set: g.createdAt }
        });
      }
    }

    for (const st of g.students) {
      if (!db.users.some(u => u.id === st.id || u.email === st.email)) {
        db.users.push({
          id: st.id,
          name: st.name,
          email: st.email,
          phone: st.phone,
          goal: st.goal,
          assignedTrainerId: st.trainerId || ownerId,
          tenantId: g.id,
          saasRole: 'student',
          role: 'student',
          created: new Date(now - 35 * 86400000).toISOString(),
          pw: { h: defaultPwHash, set: nowIso }
        });
      }

      const existingState = readStudentState(dataDir, st.id, stateOps);
      if (!existingState) {
        const trainerObj = g.trainers.find(x => x.id === st.trainerId) || { id: ownerId, name: g.ownerName };
        if (st.split === 'abc' && templates.length >= 4) {
          prescribeRoutineToStudent(dataDir, st.id, { routine: templates[1], days: [1, 4], trainerUser: trainerObj }, stateOps);
          prescribeRoutineToStudent(dataDir, st.id, { routine: templates[2], days: [2, 5], trainerUser: trainerObj }, stateOps);
          prescribeRoutineToStudent(dataDir, st.id, { routine: templates[3], days: [3, 6], trainerUser: trainerObj }, stateOps);
        } else if (templates[0]) {
          prescribeRoutineToStudent(dataDir, st.id, { routine: templates[0], days: [1, 3, 5], trainerUser: trainerObj }, stateOps);
        }

        // Adiciona treinos históricos reais para alimentar gráficos e anti-evasão
        const curState = readStudentState(dataDir, st.id, stateOps) || { routines: [], week: {}, workouts: [] };
        const workouts = st.workoutDaysAgo.map((dAgo, idx) => {
          const dateStr = isoDaysAgo(dAgo);
          const routineUsed = curState.routines[idx % Math.max(1, curState.routines.length)];
          return {
            id: `w_${st.id}_${idx}`,
            d: dateStr,
            rid: routineUsed?.id || null,
            name: routineUsed?.name || 'Treino Musculação',
            dur: 2700 + (idx % 3) * 420,
            entries: [
              {
                id: '0025',
                sets: [
                  { w: 40 + (st.workoutDaysAgo.length - idx) * 2, r: 10, done: true },
                  { w: 40 + (st.workoutDaysAgo.length - idx) * 2, r: 10, done: true },
                  { w: 40 + (st.workoutDaysAgo.length - idx) * 2, r: 9, done: true }
                ]
              },
              {
                id: '0575',
                sets: [
                  { w: 100 + (st.workoutDaysAgo.length - idx) * 5, r: 12, done: true },
                  { w: 100 + (st.workoutDaysAgo.length - idx) * 5, r: 12, done: true },
                  { w: 100 + (st.workoutDaysAgo.length - idx) * 5, r: 10, done: true }
                ]
              }
            ]
          };
        }).sort((a, b) => a.d.localeCompare(b.d));

        curState.workouts = workouts;
        curState.bw = [
          { d: isoDaysAgo(28), w: 78.4 },
          { d: isoDaysAgo(14), w: 77.9 },
          { d: isoDaysAgo(3), w: 77.5 }
        ];
        saveStudentState(dataDir, st.id, curState, stateOps);
      }
    }
  }

  const finalStore = loadSaasStore(dataDir);
  finalStore.seededAt = nowIso;
  saveSaasStore(dataDir, finalStore);
  saveDb();

  return { alreadySeeded: false, tenants: demoGyms.length };
}

export function createSaasRoutes({
  json,
  readBody,
  readRawBody = null,
  readSession,
  isAdmin,
  db,
  saveDb,
  dataDir,
  audit = () => { },
  makeSession = null,
  sessionCookie = null,
  stateOps = null,
  livePresence = null,
  removeAccount = null,
  sendPush = null,
  onUserDisabled = null,
  auditReader = null,
  sendPushFn = null,
  passwordAttempt = null,
  acctKey = u => 'acct:' + u.id,
  mediaStore = null,
  mediaConfigObj = null,
  mediaBurst = null,
  mediaThrottleFn = null,
  sendMediaFileFn = null
}) {
  const recentPrescriptionPushByStudent = new Map();
  const replyDomainError = (targetRes, err, fallbackStatus = 400, replyFn = json) => {
    if (err instanceof DomainError || err?.name === 'DomainError') {
      return replyFn(targetRes, err.httpStatus || fallbackStatus, {
        error: err.message,
        ...(err.code ? { code: err.code } : {})
      });
    }
    if (isSqliteUniqueConstraintError(err)) {
      return replyFn(targetRes, 409, { error: 'Registro duplicado no sistema.', code: 'conflict' });
    }
    const rawMsg = String(err?.message || '');
    if (err?.code === 'ERR_SQLITE_ERROR' || /SQLITE_|policy:|no such table|syntax error|constraint failed/i.test(rawMsg)) {
      console.error('[saas-route-error]', rawMsg);
      return replyFn(targetRes, 500, { error: 'Erro interno ao processar operação.' });
    }
    return replyFn(targetRes, fallbackStatus, { error: rawMsg || 'Erro ao processar requisição.' });
  };
  const B2B_PASSWORD_ERRORS = {
    'too-short': `A senha deve ter no mínimo ${MIN_LENGTH} caracteres.`,
    'too-long': `A senha deve ter no máximo ${MAX_LENGTH} caracteres.`,
    'too-common': 'Esta senha é muito comum ou previsível (evite sequências simples ou o próprio nome).'
  };
  const b2bPasswordError = (pw, labelName = '') => {
    const problem = passwordProblem(pw, labelName);
    return problem ? { code: problem, error: B2B_PASSWORD_ERRORS[problem] || B2B_PASSWORD_ERRORS['too-short'] } : null;
  };
  const sha256Equal = (a, b) => {
    const da = crypto.createHash('sha256').update(String(a)).digest();
    const dbuf = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(da, dbuf);
  };
  const generateTempPassword = () => 'Rit#' + crypto.randomBytes(6).toString('base64url');
  const resolveEnvEvolutionKey = () => String(
    process.env.EVOLUTION_API_KEY ||
    (process.env.NODE_ENV === 'production' ? '' : 'rit-secret-key')
  ).trim();

  const sanitizeTenantForRole = (tenant, canManage) => {
    if (!tenant || canManage || !tenant.settings || typeof tenant.settings !== 'object') {
      return tenant;
    }
    const {
      evolutionUrl: _u,
      evolutionInstance: _i,
      evolutionApiKey: _k,
      evolutionApiKeyEnc: _e,
      clearEvolutionApiKey: _c,
      ...safeSettings
    } = tenant.settings;
    return {
      ...tenant,
      settings: {
        ...safeSettings,
        hasEvolutionApiKey: false
      }
    };
  };

  const hasSqliteDir = Boolean(dataDir && fs.existsSync(dataDir));

  const canonicalizeForHash = val => {
    if (val === null || val === undefined || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(canonicalizeForHash);
    const sorted = {};
    for (const k of Object.keys(val).sort()) {
      const v = val[k];
      if (v !== undefined) sorted[k] = canonicalizeForHash(v);
    }
    return sorted;
  };

  const hashJsonPayload = val => crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalizeForHash(val ?? {})))
    .digest('hex');

  const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));

  const readWebhookRawBody = async req => {
    if (Buffer.isBuffer(req?.rawBody)) {
      return { rawBuf: req.rawBody, rawText: req.rawBody.toString('utf8') };
    }
    if (typeof req?.rawBody === 'string') {
      return { rawBuf: Buffer.from(req.rawBody, 'utf8'), rawText: req.rawBody };
    }
    if (req?.body !== undefined && typeof req?.on !== 'function') {
      const rawText = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      return { rawBuf: Buffer.from(rawText, 'utf8'), rawText };
    }
    if (typeof readRawBody === 'function') {
      return readRawBody(req);
    }
    if (typeof req?.on === 'function') {
      return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', d => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
        req.on('end', () => {
          const rawBuf = Buffer.concat(chunks);
          resolve({ rawBuf, rawText: rawBuf.toString('utf8') });
        });
        req.on('error', reject);
      });
    }
    return { rawBuf: Buffer.alloc(0), rawText: '' };
  };

  /**
   * Wrapper idempotente para endpoints de criação/pagamento/assinatura:
   * - Aceita `Idempotency-Key` no header HTTP;
   * - Serializa requisições concorrentes com a mesma chave aguardando conclusão;
   * - Reproduz status + corpo exatos com `Idempotency-Replayed: true` em retries;
   * - Rejeita com 422 se a mesma chave for reutilizada com parâmetros diferentes;
   * - Preserva o mesmo `gateway_idempotency_key` (UUID v4) caso o handler falhe com 5xx.
   */
  const withIdempotency = (req, res, { routeKey, authFn = null }, handler) => {
    return (async () => {
      const actor = authFn ? authFn(req, res) : { id: 'public_signup' };
      if (!actor) return;

      const rawKeyHeader = req?.headers?.['idempotency-key'];
      const clientKey = rawKeyHeader ? String(Array.isArray(rawKeyHeader) ? rawKeyHeader[0] : rawKeyHeader).trim() : '';

      const body = await readBody(req);

      if (!clientKey || !hasSqliteDir) {
        return handler({
          req,
          res,
          actor,
          body,
          gwIdempotencyKey: null,
          replyJson: json
        });
      }

      if (clientKey.length > 128 || /[\s\x00-\x1f\x7f]/.test(clientKey)) {
        return json(res, 400, { error: 'Cabeçalho Idempotency-Key inválido' });
      }

      const actorId = String(actor.id || actor.userId || actor.tenantId || 'anon');
      const scopeKey = crypto.createHash('sha256').update(`${routeKey}:${actorId}:${clientKey}`).digest('hex');
      const requestHash = hashJsonPayload(body);

      let acq = acquireApiIdempotencySqlite(dataDir, {
        scopeKey,
        clientKey,
        route: routeKey,
        actorId,
        requestHash
      });

      const waitDeadline = Date.now() + 5000;
      while (acq.action === 'in_flight' && Date.now() < waitDeadline) {
        await sleepMs(20);
        const cur = getApiIdempotencyRecordSqlite(dataDir, scopeKey);
        if (!cur) {
          acq = acquireApiIdempotencySqlite(dataDir, { scopeKey, clientKey, route: routeKey, actorId, requestHash });
          break;
        }
        if (cur.status === 'completed') {
          acq = { action: 'replay', record: cur };
          break;
        }
        if (cur.status === 'retryable') {
          acq = acquireApiIdempotencySqlite(dataDir, { scopeKey, clientKey, route: routeKey, actorId, requestHash });
          break;
        }
      }

      if (acq.action === 'mismatch') {
        return json(res, 422, {
          error: 'Idempotency-Key já utilizada com parâmetros diferentes',
          code: 'idempotency_payload_mismatch'
        });
      }

      if (acq.action === 'in_flight') {
        return json(res, 409, {
          error: 'Requisição com esta Idempotency-Key ainda está em andamento',
          inFlight: true
        });
      }

      if (acq.action === 'replay') {
        let replayedBody = {};
        try {
          replayedBody = JSON.parse(acq.record?.response_body || '{}');
        } catch {
          replayedBody = {};
        }
        return json(res, Number(acq.record?.response_status || 200), replayedBody, {
          'Idempotency-Replayed': 'true'
        });
      }

      const gwIdempotencyKey = acq.record?.gateway_idempotency_key || crypto.randomUUID();
      let captured = null;
      const replyJson = (targetRes, statusCode, payload, extraHeaders) => {
        captured = { statusCode: Number(statusCode || 200), payload };
        return json(targetRes, statusCode, payload, extraHeaders);
      };

      try {
        await handler({ req, res, actor, body, gwIdempotencyKey, replyJson });
      } catch (err) {
        markApiIdempotencyRetryableSqlite(dataDir, scopeKey);
        throw err;
      }

      if (!captured) {
        markApiIdempotencyRetryableSqlite(dataDir, scopeKey);
        return;
      }

      const isTransient = captured.statusCode >= 500
        || captured.statusCode === 429
        || captured.statusCode === 408
        || (captured.statusCode === 409 && Boolean(captured.payload?.inFlight));

      if (isTransient) {
        markApiIdempotencyRetryableSqlite(dataDir, scopeKey);
      } else {
        completeApiIdempotencySqlite(dataDir, scopeKey, captured.statusCode, captured.payload);
      }
    })();
  };

  // Sincroniza registros que existam apenas no objeto `db` em memória (ex.: fixtures de teste) para dentro do SQLite
  // antes de aplicar locks e índices únicos em `BEGIN IMMEDIATE`.
  const syncMissingCoreRowsToSqlite = inst => {
    for (const u of (db.users || [])) {
      if (!u || !u.id) continue;
      if (!inst.stmts.getUser.get(String(u.id))) {
        try {
          upsertUserSqlite(dataDir, u, null);
        } catch (err) {
          if (!isSqliteUniqueConstraintError(err)) throw err;
        }
      }
    }
    db.invites = db.invites || [];
    for (const inv of db.invites) {
      if (!inv || !inv.code) continue;
      if (!inst.stmts.getInvite.get(String(inv.code))) {
        upsertInviteSqlite(dataDir, inv, null);
      }
    }
  };

  const runDbMutation = fn => {
    if (!hasSqliteDir) return fn(null);
    const inst = getSqliteInstance(dataDir);
    return runInTransaction(inst, () => {
      syncMissingCoreRowsToSqlite(inst);
      return fn(inst);
    });
  };

  const resolvePublicAppUrl = () => String(
    process.env.PUBLIC_APP_URL || process.env.ORIGIN || 'https://app.treinerit.com.br'
  ).trim().replace(/\/+$/, '');

  const toStudentDto = u => ({
    id: u.id,
    name: u.name,
    email: u.email || '',
    phone: u.phone || '',
    goal: u.goal || '',
    tenantId: u.tenantId,
    inviteCode: u.inviteCode || null,
    welcomeWhatsapp: u.welcomeWhatsapp || null,
    onboardedAt: u.onboardedAt || null
  });

  const issueStudentInvite = ({
    tenantId,
    student,
    createdBy = null,
    reusePending = false
  }) => {
    db.invites = db.invites || [];
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const pendingForStudent = db.invites.filter(
      i => i && i.tenantId === tenantId && i.studentId === student.id && !i.usedBy && !i.revoked
    );

    if (reusePending) {
      const reusable = pendingForStudent.find(i => !i.expiresAt || Date.parse(i.expiresAt) > nowMs);
      if (reusable) {
        for (const extra of pendingForStudent) {
          if (extra.code !== reusable.code) {
            extra.revoked = true;
            extra.revokedAt = nowIso;
            if (hasSqliteDir) upsertInviteSqlite(dataDir, extra, null);
          }
        }
        student.inviteCode = reusable.code;
        return reusable;
      }
    }

    for (const oldInv of pendingForStudent) {
      oldInv.revoked = true;
      oldInv.revokedAt = nowIso;
      if (hasSqliteDir) upsertInviteSqlite(dataDir, oldInv, null);
    }

    let gen;
    do {
      gen = crypto.randomBytes(4).toString('hex').toUpperCase();
    } while (db.invites.some(i => i.code === gen));

    const created = {
      code: gen,
      note: `Matrícula: ${String(student.name || '').slice(0, 45)}`,
      tenantId,
      studentId: student.id,
      studentName: student.name,
      createdBy,
      created: nowIso,
      expiresAt: new Date(nowMs + 30 * 86400000).toISOString()
    };
    if (hasSqliteDir) upsertInviteSqlite(dataDir, created, null);
    db.invites.push(created);
    student.inviteCode = gen;
    return created;
  };

  const isSuperAdmin = u => {
    if (!u) return false;
    if (u.saasRole === 'superadmin') return true;
    if (isAdmin(u) && !u.tenantId) return true;
    return false;
  };

  const isStudentAccount = u =>
    Boolean(u) &&
    !isSuperAdmin(u) &&
    !isTrainerOrAdmin(u) &&
    u.saasRole !== 'manager' &&
    (!u.saasRole || u.saasRole === 'student');

  const isActiveTenantStaff = (u, tenantId) =>
    Boolean(u) &&
    !u.disabled &&
    !isSuperAdmin(u) &&
    u.tenantId === tenantId &&
    (
      u.saasRole === 'gym_owner' ||
      u.saasRole === 'gym_manager' ||
      u.saasRole === 'trainer' ||
      u.role === 'trainer'
    );

  const validateAssignedTrainer = (rawId, tenantId, usersList = db.users) => {
    if (rawId === undefined || rawId === null) return { ok: true, assignedTrainerId: null };
    if (typeof rawId !== 'string') {
      return {
        ok: false,
        crossTenant: false,
        staff: null,
        error: 'Identificador do professor responsável inválido.',
        code: 'invalid-assigned-trainer'
      };
    }
    const trimmed = rawId.trim();
    if (!trimmed) return { ok: true, assignedTrainerId: null };
    const staff = usersList.find(u => u.id === trimmed);
    if (!staff || !isActiveTenantStaff(staff, tenantId)) {
      const crossTenant = Boolean(staff && staff.tenantId && staff.tenantId !== tenantId);
      return {
        ok: false,
        crossTenant,
        staff: staff || null,
        error: 'Professor responsável inválido, inativo ou não pertence a esta academia.',
        code: 'invalid-assigned-trainer'
      };
    }
    return { ok: true, assignedTrainerId: staff.id };
  };

  const isTrainerPortfolioRestricted = ctx => Boolean(
    ctx?.tenant?.settings?.restrictTrainerToAssigned
    && !ctx?.superUser
    && !isGymManagerOrOwner(ctx?.user)
  );

  const filterStudentsByPortfolio = (ctx, list) => (
    isTrainerPortfolioRestricted(ctx)
      ? list.filter(s => s.assignedTrainerId === ctx.user?.id)
      : list
  );

  const requireTenantStudent = (req, res, ctx, studentId, auditTag = 'student-target') => {
    const target = db.users.find(
      u => u.id === studentId && (ctx.superUser && ctx.tenantId === 'default' ? true : u.tenantId === ctx.tenantId)
    );
    if (!target) {
      json(res, 404, { error: 'Aluno não encontrado nesta unidade' });
      return null;
    }
    if (!isStudentAccount(target)) {
      audit(req, 'gym.denied', { ok: false, user: ctx.user, target, msg: `${auditTag}-on-non-student` });
      json(res, 403, { error: 'Operação permitida apenas para contas de aluno.', code: 'non-student-target' });
      return null;
    }
    if (isTrainerPortfolioRestricted(ctx) && target.assignedTrainerId !== ctx.user?.id) {
      audit(req, 'gym.denied', { ok: false, user: ctx.user, target, msg: `${auditTag}:trainer-scope-restricted` });
      json(res, 403, { error: 'Acesso restrito aos alunos da sua carteira neste modo de equipe.', code: 'trainer-scope-restricted' });
      return null;
    }
    return target;
  };

  const requireSuperAdmin = (req, res) => {
    const user = readSession(req);
    if (!user) {
      json(res, 401, { error: 'Sessão expirada ou não autenticada' });
      return null;
    }
    if (!isSuperAdmin(user)) {
      audit(req, 'saas.admin.denied', { ok: false, user });
      json(res, 403, { error: 'Acesso restrito ao Dono do Sistema (Super Admin)' });
      return null;
    }
    return user;
  };

  /**
   * Resolve contexto da academia para rotas `/api/gym/*` e `/api/trainer/*`.
   * - Super Admin pode inspecionar qualquer academia enviando `x-tenant-id` ou `?tenant=`.
   * - Gestor/Professor de academia fica estritamente isolado no seu `user.tenantId`.
   */
  const requireGymContext = (req, res, { managerOnly = false } = {}) => {
    const user = readSession(req);
    if (!user) {
      json(res, 401, { error: 'not signed in' });
      return null;
    }

    if (managerOnly ? !isGymManagerOrOwner(user) : !isTrainerOrAdmin(user)) {
      audit(req, 'gym.denied', { ok: false, user });
      json(res, 403, { error: managerOnly ? 'Acesso restrito ao Gestor da Academia' : 'forbidden: requer privilégio de treinador ou gestor' });
      return null;
    }

    const superUser = isSuperAdmin(user);
    const requestedTenant = resolveTenantId(req);
    const tenantId = superUser
      ? (requestedTenant !== 'default' ? requestedTenant : (listTenants(dataDir, db)[0]?.id || 'default'))
      : (user.tenantId || null);

    if (!superUser && (!tenantId || tenantId === 'default')) {
      json(res, 403, { error: 'forbidden: usuário não está vinculado a uma academia ou unidade ativa' });
      return null;
    }

    if (!superUser) {
      const access = getTenantAccessState(dataDir, tenantId);
      if (access.blocked) {
        const msg = access.reason === 'trial_expired'
          ? 'O período de degustação desta academia expirou. Regularize a assinatura via PIX para reativar.'
          : access.reason === 'past_due'
            ? 'O acesso desta academia está bloqueado por pendência financeira. Regularize via PIX para continuar.'
            : 'O acesso desta academia encontra-se suspenso. Entre em contato com o suporte.';
        json(res, 403, {
          error: msg,
          code: access.reason === 'trial_expired' ? 'trial-expired' : (access.reason === 'past_due' ? 'past-due' : 'tenant-suspended'),
          billingRequired: access.billingOnly,
          blockReason: access.reason
        });
        return null;
      }
    }

    const tenantDir = getTenantDir(dataDir, tenantId);
    const tenant = tenantId !== 'default' ? getTenant(dataDir, tenantId) : null;
    // Se stateOps existe (produção no server.js), lê/grava o state unificado em dataDir (`DATA/state-<uid>.json`).
    // Caso contrário (testes isolados sem stateOps), usa tenantDir para compatibilidade.
    const stateStorageDir = stateOps ? dataDir : tenantDir;

    return {
      user,
      superUser,
      tenantId,
      tenantDir,
      tenant,
      stateStorageDir
    };
  };

  async function sendStudentWhatsApp(ctx, student, { phone, kind, dedupKey, message }) {
    const evolution = resolveTenantEvolutionSettings(dataDir, ctx.tenantId);
    const result = await dispatchWhatsAppWithRetry({
      dataDir,
      tenantId: ctx.tenantId,
      tenantSettings: { ...(ctx.tenant?.settings || {}), ...evolution },
      recipientName: student.name,
      phone,
      kind,
      dedupKey,
      message
    });
    return { ...result, sent: Boolean(result.ok && !result.skipped) };
  }

  return {
    /* =====================================================================
     * 1. AUTENTICAÇÃO B2B, BOOTSTRAP & CATÁLOGO DE EXERCÍCIOS
     * ===================================================================== */
    'GET /api/saas/bootstrap': async (req, res) => {
      const store = loadSaasStore(dataDir);
      const tenants = listTenants(dataDir, db);
      const hasSuperAdmin = db.users.some(u => isSuperAdmin(u));
      const demoAllowed = process.env.SAAS_DEMO === '1';
      const configuredSetupToken = String(process.env.SETUP_ADMIN_TOKEN || '').trim();
      const isProdEnv = process.env.NODE_ENV === 'production';
      const setupTokenRequired = !hasSuperAdmin && (Boolean(configuredSetupToken) || isProdEnv);
      const setupDisabled = !hasSuperAdmin && isProdEnv && configuredSetupToken.length < 12;

      json(res, 200, {
        ok: true,
        platform: store.platform,
        hasSuperAdmin,
        setupTokenRequired,
        setupDisabled,
        seeded: Boolean(store.seededAt),
        demoAllowed,
        plans: store.plans,
        gyms: demoAllowed
          ? tenants.map(t => ({
            id: t.id,
            accountType: t.accountType || 'gym',
            name: t.name,
            status: t.status,
            planName: t.planName,
            ownerEmail: t.ownerEmail,
            primaryColor: t.branding?.primaryColor || DEFAULT_BRANDING.primaryColor,
            studentCount: t.studentCount
          }))
          : []
      });
    },

    'POST /api/saas/demo/seed': async (req, res) => {
      if (process.env.SAAS_DEMO !== '1') {
        return json(res, 403, { error: 'Modo demonstração desativado nesta instância' });
      }
      const result = await ensureSaasDemoSeed({ dataDir, db, saveDb, stateOps });
      json(res, 200, { ok: true, ...result });
    },

    'POST /api/saas/auth/setup-admin': async (req, res) => {
      if (db.users.some(u => isSuperAdmin(u))) {
        return json(res, 403, { error: 'O administrador da plataforma já foi configurado.' });
      }

      const body = await readBody(req);
      const configuredSetupToken = String(process.env.SETUP_ADMIN_TOKEN || '').trim();
      const isProdEnv = process.env.NODE_ENV === 'production';
      if (isProdEnv && configuredSetupToken.length < 12) {
        audit(req, 'saas.admin.setup_denied', { ok: false, msg: 'setup-disabled-no-token' });
        return json(res, 403, {
          error: 'Setup inicial bloqueado em produção sem SETUP_ADMIN_TOKEN válido (>= 12 caracteres) no servidor.',
          code: 'setup-token-not-configured'
        });
      }
      if (configuredSetupToken) {
        const headerTok = req.headers?.['x-setup-token'];
        const suppliedTok = String(body?.setupToken ?? (Array.isArray(headerTok) ? headerTok[0] : headerTok) ?? '').trim();
        if (!suppliedTok || !sha256Equal(suppliedTok, configuredSetupToken)) {
          audit(req, 'saas.admin.setup_denied', { ok: false, msg: 'invalid-setup-token' });
          return json(res, 403, {
            error: 'Token de configuração inicial (SETUP_ADMIN_TOKEN) ausente ou inválido.',
            code: 'invalid-setup-token'
          });
        }
      }

      const email = normalizeEmail(body?.email || '');
      const password = String(body?.password || '');
      const name = String(body?.name || 'Administrador Geral').trim();

      if (!email || !email.includes('@')) {
        return json(res, 400, { error: 'Informe um e-mail válido para o administrador.' });
      }
      const pwErr = b2bPasswordError(password, name);
      if (pwErr) {
        return json(res, 400, pwErr);
      }

      const h = await hashPassword(password);
      const nowIso = new Date().toISOString();
      let superAdminUser;
      try {
        superAdminUser = runDbMutation(() => {
          if (db.users.some(u => isSuperAdmin(u))) {
            const err = new Error('O administrador da plataforma já foi configurado.');
            err.httpStatus = 403;
            throw err;
          }
          const created = {
            id: 'u_' + crypto.randomBytes(6).toString('hex'),
            name,
            email,
            saasRole: 'superadmin',
            role: 'admin',
            admin: true,
            owner: !db.users.some(u => u.owner),
            created: nowIso,
            pw: { h, set: nowIso },
            sv: 1
          };
          if (hasSqliteDir) upsertUserSqlite(dataDir, created, null);
          db.users.push(created);
          saveDb();
          return created;
        });
      } catch (err) {
        if (err?.httpStatus === 403 || isSqliteUniqueConstraintError(err)) {
          return json(res, 403, { error: 'O administrador da plataforma já foi configurado.' });
        }
        throw err;
      }

      audit(req, 'saas.admin.setup_initial', { user: superAdminUser, msg: email });

      const token = makeSession ? makeSession(superAdminUser, 'b') : null;
      json(res, 200, {
        ok: true,
        token,
        user: saasPublicUser(superAdminUser, isAdmin),
        message: 'Administrador configurado com sucesso!'
      }, sessionCookie ? { 'Set-Cookie': sessionCookie(superAdminUser) } : undefined);
    },

    /**
     * Auto-cadastro B2B (Criação de conta self-service de Academia / Studio / Personal Trainer).
     * Cria o tenant em período de teste gratuito (`status: 'trial'`), cria o usuário proprietário
     * (`saasRole: 'gym_owner'`), provisiona os modelos de treino iniciais e já retorna sessão ativa.
     */
    'POST /api/saas/auth/register': (req, res) => withIdempotency(
      req,
      res,
      { routeKey: 'POST /api/saas/auth/register', authFn: null },
      async ({ body, replyJson }) => {
        const RESERVED_SLUGS = new Set([
          'default', 'admin', 'superadmin', 'api', 'painel', 'portal',
          'cadastro', 'criar-conta', 'signup', 'login', 'entrar',
          'app', 'www', 'rit', 'sistema', 'setup-superadmin', 'site'
        ]);

        const rawAccountType = String(body?.accountType || '').trim().toLowerCase();
        if (rawAccountType && rawAccountType !== 'gym' && rawAccountType !== 'personal') {
          return replyJson(res, 400, { error: 'Tipo de conta inválido (use "gym" ou "personal").' });
        }

        const plans = listSaasPlans(dataDir);
        const requestedPlanRaw = String(body?.planId || '').trim().toLowerCase();
        let accountType = rawAccountType === 'personal' ? 'personal' : 'gym';
        if (!rawAccountType && requestedPlanRaw && requestedPlanRaw.startsWith('personal')) {
          accountType = 'personal';
        }

        const defaultPlanId = accountType === 'personal'
          ? (plans.find(p => p.accountType === 'personal')?.id || 'personal')
          : (plans.find(p => p.accountType !== 'personal' && p.id === 'starter')?.id || plans[0]?.id || 'starter');
        const targetPlanId = requestedPlanRaw || defaultPlanId;
        const plan = plans.find(p => p.id === targetPlanId);
        if (!plan) {
          return replyJson(res, 400, { error: 'Plano selecionado inválido.', code: 'invalid-plan' });
        }
        if (rawAccountType && requestedPlanRaw) {
          const planAccountType = isPersonalPlan(plan) ? 'personal' : 'gym';
          if (planAccountType !== accountType) {
            return replyJson(res, 422, {
              error: 'O plano selecionado não é compatível com o tipo de conta escolhido.',
              code: 'plan-account-type-mismatch'
            });
          }
        }

        const gymName = String(body?.gymName || body?.name || body?.businessName || '').trim();
        if (gymName.length < 2) {
          return replyJson(res, 400, {
            error: accountType === 'personal'
              ? 'Informe seu nome ou o nome da sua consultoria (mínimo 2 caracteres).'
              : 'Informe o nome da sua academia ou studio (mínimo 2 caracteres).'
          });
        }

        const ownerName = String(body?.ownerName || (accountType === 'personal' ? gymName : '')).trim();
        if (ownerName.length < 2) {
          return replyJson(res, 400, { error: 'Informe o nome completo do responsável (mínimo 2 caracteres).' });
        }

        const email = normalizeEmail(body?.email || body?.identifier || '');
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return replyJson(res, 400, { error: 'Informe um e-mail válido.' });
        }

        const password = String(body?.password || '');
        const pwErr = b2bPasswordError(password, ownerName || gymName);
        if (pwErr) {
          return replyJson(res, 400, pwErr);
        }

        const rawExplicitSlug = body?.slug !== undefined ? body.slug : body?.id;
        const hasExplicitSlug = rawExplicitSlug !== undefined && String(rawExplicitSlug).trim() !== '';
        const explicitSlug = hasExplicitSlug ? sanitizeTenantId(rawExplicitSlug) : '';
        if (hasExplicitSlug && (!explicitSlug || explicitSlug.length < 2 || RESERVED_SLUGS.has(explicitSlug))) {
          return replyJson(res, 400, {
            error: 'Identificador/URL inválido ou reservado (use letras minúsculas, números e hífens, mín. 2 caracteres).'
          });
        }

        const phone = String(body?.phone || '').trim().slice(0, 40);
        const city = String(body?.city || '').trim().slice(0, 80);

        // Pre-check rápido antes de gastar CPU com scrypt
        if (db.users.some(u => normalizeEmail(u.email || '') === email)) {
          return replyJson(res, 409, {
            error: 'Já existe uma conta cadastrada com este e-mail.',
            code: 'email-in-use'
          });
        }

        const pwHash = await hashPassword(password);

        let result;
        try {
          result = runDbMutation(() => {
            if (db.users.some(u => normalizeEmail(u.email || '') === email)) {
              const conflictErr = new Error('Já existe uma conta cadastrada com este e-mail.');
              conflictErr.httpStatus = 409;
              conflictErr.code = 'email-in-use';
              throw conflictErr;
            }

            const existingIds = new Set(listTenants(dataDir, db).map(t => t.id));
            let cleanSlug = explicitSlug;
            if (hasExplicitSlug) {
              if (existingIds.has(cleanSlug)) {
                const slugErr = new Error('Este identificador/URL já está em uso por outra conta.');
                slugErr.httpStatus = 409;
                slugErr.code = 'slug-in-use';
                throw slugErr;
              }
            } else {
              let base = sanitizeTenantId(gymName) || (accountType === 'personal' ? 'personal' : 'academia');
              if (base.length < 2) base = accountType === 'personal' ? 'personal' : 'academia';
              if (RESERVED_SLUGS.has(base)) base = `${base}-fit`;
              cleanSlug = base;
              let suffix = 2;
              while (existingIds.has(cleanSlug) || RESERVED_SLUGS.has(cleanSlug)) {
                if (suffix > 50) {
                  cleanSlug = `${base}-${crypto.randomBytes(3).toString('hex')}`;
                  break;
                }
                cleanSlug = `${base}-${suffix++}`;
              }
            }

            const nowIso = new Date().toISOString();
            const ownerId = 'u_' + crypto.randomBytes(8).toString('hex');
            const ownerUser = {
              id: ownerId,
              name: ownerName,
              email,
              tenantId: cleanSlug,
              saasRole: 'gym_owner',
              role: 'trainer',
              owner: true,
              phone,
              createdAt: nowIso,
              pw: { h: pwHash, set: nowIso },
              sv: 1
            };

            const createdTenant = createTenant(dataDir, {
              id: cleanSlug,
              name: gymName,
              gymName,
              accountType,
              ownerName,
              ownerEmail: email,
              phone,
              city,
              planId: plan.id,
              status: 'trial',
              trialDays: 14,
              ownerUserId: ownerId
            });

            if (hasSqliteDir) upsertUserSqlite(dataDir, ownerUser, null);
            db.users.push(ownerUser);
            saveDb();

            return { createdTenant, ownerUser };
          });
        } catch (err) {
          if (isSqliteUniqueConstraintError(err)) {
            return replyJson(res, 409, {
              error: 'Já existe uma conta cadastrada com este e-mail.',
              code: 'email-in-use'
            });
          }
          const statusCode = err?.httpStatus || (/já está em uso|já existe uma academia/i.test(String(err?.message || '')) ? 409 : 400);
          return replyJson(res, statusCode, {
            error: err?.message || 'Não foi possível criar a conta.',
            ...(err?.code ? { code: err.code } : {})
          });
        }

        const tDir = getTenantDir(dataDir, result.createdTenant.id);
        loadTemplates(tDir, { seedIfMissing: true });

        audit(req, 'saas.auth.register', {
          user: result.ownerUser,
          msg: `${result.createdTenant.id}:${accountType}:${plan.id}`
        });

        const token = makeSession ? makeSession(result.ownerUser, 'b') : null;
        return replyJson(res, 201, {
          ok: true,
          isNewSignup: true,
          token,
          user: saasPublicUser(result.ownerUser, isAdmin),
          tenant: sanitizeTenantForRole(result.createdTenant, true),
          message: 'Conta criada com sucesso! Seus 14 dias grátis começaram.'
        }, sessionCookie ? { 'Set-Cookie': sessionCookie(result.ownerUser) } : undefined);
      }
    ),

    'POST /api/saas/auth/login': async (req, res) => {
      const body = await readBody(req);
      const ident = nameKey(body?.identifier || body?.email || body?.name || '');
      const password = String(body?.password || '');
      const headerTenant = resolveTenantId(req);
      const tenantHint = body?.tenantId
        ? sanitizeTenantId(body.tenantId)
        : (headerTenant !== 'default' ? headerTenant : null);

      if (!ident || !password) {
        return json(res, 400, { error: 'Informe seu e-mail (ou usuário) e senha.' });
      }

      const isEmailMatch = u =>
        (u.email && nameKey(u.email) === ident) ||
        (!u.email && isSuperAdmin(u) && ident === 'admin@rit.com.br');

      const emailCandidates = db.users.filter(u => u.pw?.h && isEmailMatch(u));
      let candidates;
      if (emailCandidates.length > 0) {
        candidates = emailCandidates;
        if (candidates.length > 1 && tenantHint && tenantHint !== 'default') {
          const scoped = candidates.filter(u => isSuperAdmin(u) || u.tenantId === tenantHint);
          if (scoped.length > 0) candidates = scoped;
        }
        if (candidates.length > 1) {
          const b2bOnly = candidates.filter(u => !isStudentAccount(u));
          if (b2bOnly.length === 1) candidates = b2bOnly;
        }
      } else {
        candidates = db.users.filter(u => {
          if (!u.pw?.h || nameKey(u.name) !== ident) return false;
          if (tenantHint && tenantHint !== 'default' && !isSuperAdmin(u)) {
            return u.tenantId === tenantHint;
          }
          return true;
        });
      }

      if (candidates.length > 1) {
        const ambKey = 'amb:' + ident;
        const ambCheck = passwordAttempt ? passwordAttempt(req, res, ambKey) : null;
        if (passwordAttempt && !ambCheck) return;
        if (ambCheck) {
          await ambCheck.verify(password, null);
          ambCheck.failed(null, 'identificador-ambiguo', 'ambiguous-name', { ev: 'saas.login.fail' });
        } else {
          await verifyPassword(password, null);
          audit(req, 'saas.login.fail', { ok: false, msg: 'identificador-ambiguo' });
        }
        return json(res, 409, {
          error: 'Existem múltiplas contas com este nome. Entre usando seu e-mail cadastrado.',
          code: 'ambiguous-identifier'
        });
      }

      const target = candidates[0] || null;
      const throttleKey = target ? acctKey(target) : 'id:' + ident;
      const check = passwordAttempt ? passwordAttempt(req, res, throttleKey) : null;
      if (passwordAttempt && !check) return;

      const valid = check
        ? await check.verify(password, target?.pw?.h)
        : await verifyPassword(password, target?.pw?.h);

      if (!target || !valid) {
        if (check) {
          check.failed(target, 'credenciais-invalidas', ident.includes('@') ? 'unknown-email' : 'unknown-name', { ev: 'saas.login.fail' });
        } else {
          audit(req, 'saas.login.fail', { ok: false, msg: 'credenciais-invalidas' });
        }
        return json(res, 401, { error: 'Credenciais inválidas. Verifique seu e-mail e senha.' });
      }

      if (target.disabled) {
        check?.void();
        return json(res, 403, { error: 'Esta conta está desativada.' });
      }

      if (!isSuperAdmin(target) && !isTrainerOrAdmin(target)) {
        check?.void();
        return json(res, 403, {
          error: 'Esta conta é de Aluno. Redirecionando para o App de Treino do Aluno...',
          code: 'student-account',
          tenantId: target.tenantId || ''
        });
      }

      const loginAccess = target.tenantId && !isSuperAdmin(target)
        ? getTenantAccessState(dataDir, target.tenantId)
        : null;
      const canAccessBillingOnly = isGymManagerOrOwner(target) || target.saasRole === 'manager';
      if (loginAccess?.blocked && !(loginAccess.billingOnly && canAccessBillingOnly)) {
        check?.void();
        const errMsg = loginAccess.reason === 'trial_expired'
          ? 'O período de degustação desta academia expirou. Solicite ao gestor a regularização da assinatura.'
          : loginAccess.reason === 'past_due'
            ? 'O acesso desta academia está bloqueado por pendência financeira. Solicite ao gestor a regularização.'
            : 'O acesso desta academia está suspenso. Contate o administrador da plataforma.';
        return json(res, 403, { error: errMsg, code: loginAccess.reason || 'tenant-suspended' });
      }

      check?.ok();
      const token = makeSession ? makeSession(target, 'b') : 'dev-token-' + target.id;
      const tenant = target.tenantId ? getTenant(dataDir, target.tenantId) : null;
      const safeTenant = sanitizeTenantForRole(tenant, isSuperAdmin(target) || isGymManagerOrOwner(target));
      const billingOnly = Boolean(loginAccess?.blocked && loginAccess.billingOnly);
      if (safeTenant && loginAccess?.blocked) {
        safeTenant.accessBlocked = true;
        safeTenant.blockReason = loginAccess.reason;
      }
      audit(req, 'saas.login.ok', { user: target });

      json(res, 200, {
        ok: true,
        token,
        user: saasPublicUser(target, isAdmin),
        tenant: safeTenant,
        billingOnly,
        ...(loginAccess?.blocked ? { accessBlocked: true, blockReason: loginAccess.reason } : {}),
        plans: listSaasPlans(dataDir)
      }, sessionCookie ? { 'Set-Cookie': sessionCookie(target) } : undefined);
    },

    'POST /api/saas/auth/demo-login': async (req, res) => {
      if (process.env.SAAS_DEMO !== '1') {
        return json(res, 403, { error: 'Acesso rápido de demonstração desativado' });
      }
      await ensureSaasDemoSeed({ dataDir, db, saveDb, stateOps });
      const body = await readBody(req);
      const mode = body?.mode || 'superadmin';
      let target = null;

      if (mode === 'superadmin') {
        target = db.users.find(u => isSuperAdmin(u));
      } else {
        const slug = sanitizeTenantId(body?.tenantId || 'ironpower');
        if (isTenantSuspended(dataDir, slug)) {
          return json(res, 403, { error: 'Esta academia está suspensa no momento. Reative-a pelo Painel do Dono do Sistema.' });
        }
        target = db.users.find(u => u.tenantId === slug && u.saasRole === 'gym_owner')
          || db.users.find(u => u.tenantId === slug && isTrainerOrAdmin(u));
      }

      if (!target) {
        return json(res, 404, { error: 'Perfil de demonstração não encontrado' });
      }

      const token = makeSession ? makeSession(target, 'b') : 'dev-token-' + target.id;
      const tenant = target.tenantId ? getTenant(dataDir, target.tenantId) : null;
      const safeTenant = sanitizeTenantForRole(tenant, isSuperAdmin(target) || isGymManagerOrOwner(target));
      audit(req, 'saas.demo.login', { user: target });

      json(res, 200, {
        ok: true,
        token,
        user: saasPublicUser(target, isAdmin),
        tenant: safeTenant,
        plans: listSaasPlans(dataDir)
      }, sessionCookie ? { 'Set-Cookie': sessionCookie(target) } : undefined);
    },

    'GET /api/saas/auth/me': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      if (!isSuperAdmin(user) && !isTrainerOrAdmin(user)) {
        return json(res, 403, { error: 'Conta sem acesso ao painel administrativo' });
      }
      const superUser = isSuperAdmin(user);
      const reqTenant = resolveTenantId(req);
      const activeTenantId = superUser
        ? (reqTenant !== 'default' ? reqTenant : null)
        : (user.tenantId || null);
      const access = (!superUser && activeTenantId) ? getTenantAccessState(dataDir, activeTenantId) : null;
      const canAccessBillingOnly = superUser || isGymManagerOrOwner(user) || user.saasRole === 'manager';
      if (access?.blocked && !(access.billingOnly && canAccessBillingOnly)) {
        return json(res, 403, { error: 'O acesso desta academia encontra-se suspenso.', code: access.reason || 'tenant-suspended' });
      }
      const tenant = activeTenantId ? getTenant(dataDir, activeTenantId) : null;
      const safeTenant = sanitizeTenantForRole(tenant, superUser || isGymManagerOrOwner(user));
      const billingOnly = Boolean(!superUser && access?.blocked && access.billingOnly);
      if (safeTenant && access?.blocked) {
        safeTenant.accessBlocked = true;
        safeTenant.blockReason = access.reason;
      }

      json(res, 200, {
        ok: true,
        user: saasPublicUser(user, isAdmin),
        tenant: safeTenant,
        billingOnly,
        ...(access?.blocked ? { accessBlocked: true, blockReason: access.reason } : {}),
        impersonating: Boolean(superUser && activeTenantId),
        plans: listSaasPlans(dataDir)
      });
    },

    'GET /api/saas/catalogue': async (req, res) => {
      const user = readSession(req);
      if (!user || !isTrainerOrAdmin(user)) {
        return json(res, 401, { error: 'not signed in' });
      }
      if (!isSuperAdmin(user) && user.tenantId && getTenantAccessState(dataDir, user.tenantId).blocked) {
        return json(res, 403, { error: 'O acesso desta academia encontra-se suspenso ou com assinatura pendente.' });
      }
      const { items, byId } = getCatalogueIndex();
      const qObj = new URL(req.url || '/api/saas/catalogue', 'http://x').searchParams;

      const superUser = isSuperAdmin(user);
      const reqTenant = resolveTenantId(req);
      const activeTenantId = superUser
        ? (reqTenant !== 'default' ? reqTenant : (listTenants(dataDir, db)[0]?.id || 'default'))
        : (user.tenantId || 'default');

      const tenantData = hasSqliteDir
        ? getTenantExercisesPayload(dataDir, activeTenantId)
        : { tenantId: activeTenantId, overrides: {}, customExercises: [] };
      const overrides = tenantData.overrides || {};

      const toTenantCatalogueItem = c => {
        const bpLabel = BP_LABELS_PT[c.bp] || 'Outro';
        const eqLabel = EQ_LABELS_PT[c.eq] || 'Outro';
        const thumb = c.media?.poster?.hash
          ? `/api/gym/media/${c.media.poster.hash}`
          : (c.media?.kind === 'image' && c.media?.hash ? `/api/gym/media/${c.media.hash}` : null);
        return {
          id: c.id,
          name: c.name,
          enName: c.name,
          bp: c.bp || 'other',
          bpLabel,
          tg: c.tg || 'other',
          eq: c.eq || 'other',
          eqLabel,
          tier: 0,
          instructions: c.desc ? [c.desc] : [],
          desc: c.desc || '',
          thumb,
          tenantCustom: true,
          customMedia: c.media || null,
          customUrl: c.url || '',
          customNote: c.desc || '',
          hasCustomVideo: Boolean(c.media || c.url),
          updatedAt: c.updatedAt || 0,
          _f: foldSearch(c.name),
          _q: foldSearch(`${c.name} ${bpLabel} ${eqLabel} ${c.tg || ''} ${c.desc || ''}`)
        };
      };

      const customItems = (tenantData.customExercises || []).map(toTenantCatalogueItem);
      const customById = new Map(customItems.map(it => [it.id, it]));

      const withOverride = it => {
        if (!it) return null;
        if (it.tenantCustom) return it;
        const ov = overrides[it.id];
        if (!ov) return it;
        return {
          ...it,
          hasCustomVideo: Boolean(ov.media || ov.url),
          customMedia: ov.media || null,
          customUrl: ov.url || '',
          customNote: ov.note || '',
          customUpdatedAt: ov.updatedAt || 0
        };
      };

      // Busca direta por lista de IDs
      const idsParam = qObj.get('ids');
      if (idsParam) {
        const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 100);
        const found = ids
          .map(id => customById.get(id) || withOverride(byId.get(id)))
          .filter(Boolean)
          .map(toPublicExercise);
        return json(res, 200, { ok: true, exercises: found, total: found.length });
      }

      const q = foldSearch(qObj.get('q') || '');
      const bp = (qObj.get('bp') || '').trim().toLowerCase();
      const eq = (qObj.get('eq') || '').trim().toLowerCase();
      const customOnly = qObj.get('customOnly') === '1' || qObj.get('customOnly') === 'true';
      const offset = Math.max(0, Number(qObj.get('offset')) || 0);
      const limit = Math.max(1, Math.min(120, Number(qObj.get('limit')) || 48));

      const terms = q ? q.split(/\s+/).filter(Boolean) : [];
      const filtered = [];
      const pool = customOnly
        ? [...customItems, ...items.filter(it => Boolean(overrides[it.id])).map(withOverride)]
        : [...customItems, ...items];

      for (const rawIt of pool) {
        const it = withOverride(rawIt);
        if (bp && it.bp !== bp) continue;
        if (eq && it.eq !== eq) continue;
        if (terms.length > 0) {
          let ok = true;
          for (const t of terms) {
            if (!it._q.includes(t)) { ok = false; break; }
          }
          if (!ok) continue;
        }
        filtered.push(it);
      }

      if (terms.length > 0 && filtered.length > 1) {
        filtered.sort((a, b) => {
          const scoreA = (a._f.startsWith(q) ? 0 : a._f.includes(q) ? 1 : 2) * 100 + a.tier * 10 + Math.min(40, a.name.length);
          const scoreB = (b._f.startsWith(q) ? 0 : b._f.includes(q) ? 1 : 2) * 100 + b.tier * 10 + Math.min(40, b.name.length);
          return scoreA - scoreB;
        });
      }

      const page = filtered.slice(offset, offset + limit).map(toPublicExercise);

      json(res, 200, {
        ok: true,
        exercises: page,
        total: filtered.length,
        offset,
        limit,
        hasMore: offset + page.length < filtered.length,
        bodyParts: Object.entries(BP_LABELS_PT).map(([id, label]) => ({ id, label })),
        equipments: Object.entries(EQ_LABELS_PT).map(([id, label]) => ({ id, label }))
      });
    },

    'GET /api/tenant/exercises': async (req, res) => {
      const user = readSession(req);
      if (!user) return json(res, 401, { error: 'not signed in' });
      const tenantId = resolveEffectiveTenantId(req, user);
      if (!isSuperAdmin(user) && tenantId !== 'default' && getTenantAccessState(dataDir, tenantId).blocked) {
        return json(res, 403, { error: 'O acesso desta academia encontra-se suspenso ou com assinatura pendente.' });
      }
      const payload = hasSqliteDir
        ? getTenantExercisesPayload(dataDir, tenantId)
        : { tenantId, overrides: {}, customExercises: [] };
      json(res, 200, {
        ok: true,
        tenant_id: tenantId,
        overrides: payload.overrides || {},
        customExercises: payload.customExercises || []
      });
    },

    /* =====================================================================
     * 2. WHITE-LABEL / BRANDING PÚBLICO PARA O APP DO ALUNO
     * ===================================================================== */
    'GET /api/tenant/branding': async (req, res) => {
      const sessionUsr = readSession(req);
      const tenantId = resolveEffectiveTenantId(req, sessionUsr);
      const tenantLocked = Boolean(sessionUsr && sessionUsr.saasRole !== 'superadmin');

      if (tenantId === 'default') {
        const defaultDir = path.join(dataDir, 'tenants', 'default');
        const branding = fs.existsSync(defaultDir) ? loadTenantBranding(defaultDir) : { ...DEFAULT_BRANDING };
        return json(res, 200, {
          ok: true,
          tenant_id: 'default',
          status: 'active',
          branding,
          ...(tenantLocked ? { locked: true } : {})
        });
      }

      const tenant = getTenant(dataDir, tenantId);
      if (!tenant) {
        // Não cria diretórios em disco para slugs inexistentes/aleatórios
        return json(res, 200, {
          ok: true,
          tenant_id: tenantId,
          status: 'active',
          branding: { ...DEFAULT_BRANDING },
          ...(tenantLocked ? { locked: true } : {})
        });
      }

      // Nunca expor credenciais sensíveis (ex.: evolutionUrl/evolutionApiKey) em endpoint público
      const publicSettings = {
        inviteOnly: Boolean(tenant.settings?.inviteOnly),
        allowGuest: Boolean(tenant.settings?.allowGuest),
        welcomeMessage: String(tenant.settings?.welcomeMessage || '')
      };

      json(res, 200, {
        ok: true,
        tenant_id: tenantId,
        accountType: tenant.accountType || 'gym',
        status: tenant.status,
        branding: tenant.branding,
        settings: publicSettings,
        ...(tenantLocked ? { locked: true } : {})
      });
    },

    'PUT /api/tenant/branding': async (req, res) => {
      const ctx = requireGymContext(req, res, { managerOnly: true });
      if (!ctx) return;
      const body = await readBody(req);
      let updatedBranding;
      if (ctx.tenantId !== 'default' && getTenant(dataDir, ctx.tenantId)) {
        const updatedTenant = updateTenant(dataDir, ctx.tenantId, { branding: body });
        updatedBranding = updatedTenant.branding;
      } else {
        updatedBranding = saveTenantBranding(ctx.tenantDir, body);
      }
      audit(req, 'tenant.branding.update', { user: ctx.user, msg: ctx.tenantId });
      json(res, 200, { ok: true, branding: updatedBranding });
    },

    /* =====================================================================
     * 3. PAINEL DO DONO DO SISTEMA (SUPER ADMIN B2B)
     * ===================================================================== */
    'GET /api/saas/admin/overview': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;

      const store = loadSaasStore(dataDir);
      const tenants = listTenants(dataDir, db);
      const stateStorageDir = stateOps ? dataDir : dataDir;
      const nowMs = Date.now();
      const thirtyDaysAgo = new Date(nowMs - 30 * 86400000).toISOString().slice(0, 10);

      let mrr = 0;
      let activeGyms = 0;
      let trialGyms = 0;
      let pastDueGyms = 0;
      let suspendedGyms = 0;
      let totalStudents = 0;
      let activeStudents30d = 0;
      let totalTrainers = 0;
      let totalWorkoutsLogged = 0;
      let workoutsLast30d = 0;
      let liveTrainingNow = 0;

      const enrichedTenants = tenants.map(t => {
        if (t.status === 'active') { activeGyms++; mrr += Number(t.mrr || 0); }
        else if (t.status === 'trial') trialGyms++;
        else if (t.status === 'past_due') { pastDueGyms++; mrr += Number(t.mrr || 0); }
        else if (t.status === 'suspended') suspendedGyms++;

        const gymStudents = listStudents(db, stateStorageDir, {
          tenantId: t.id,
          includeDisabled: true,
          churnDaysThreshold: t.settings?.churnDaysThreshold || 5,
          stateOps,
          livePresence,
          nowMs
        });

        const active30 = gymStudents.filter(s => s.workoutsLast30d > 0).length;
        const atRisk = gymStudents.filter(s => s.churnStatus === 'critical' || s.churnStatus === 'warning').length;
        const wTotal = gymStudents.reduce((acc, s) => acc + s.workoutCount, 0);
        const w30 = gymStudents.reduce((acc, s) => acc + s.workoutsLast30d, 0);
        const liveCount = gymStudents.filter(s => s.trainingNow).length;

        totalStudents += gymStudents.length;
        activeStudents30d += active30;
        totalTrainers += t.trainerCount;
        totalWorkoutsLogged += wTotal;
        workoutsLast30d += w30;
        liveTrainingNow += liveCount;

        return {
          ...t,
          studentCount: gymStudents.length,
          activeStudents30d: active30,
          atRiskCount: atRisk,
          workoutCount: wTotal,
          workoutsLast30d: w30,
          liveTrainingNow: liveCount
        };
      });

      // Série histórica de MRR dos últimos 6 meses
      const mrrSeries = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(nowMs - i * 30 * 86400000);
        const ym = d.toISOString().slice(0, 7);
        const monthEndIso = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59).toISOString();
        const monthMrr = enrichedTenants
          .filter(t => (t.status === 'active' || t.status === 'past_due') && String(t.createdAt) <= monthEndIso)
          .reduce((sum, t) => sum + Number(t.mrr || 0), 0);
        mrrSeries.push({ label: ym, value: i === 0 ? mrr : monthMrr });
      }

      // Distribuição por plano
      const planBreakdown = store.plans.map(p => {
        const count = enrichedTenants.filter(t => t.planId === p.id).length;
        const revenue = enrichedTenants
          .filter(t => t.planId === p.id && (t.status === 'active' || t.status === 'past_due'))
          .reduce((s, t) => s + Number(t.mrr || 0), 0);
        return { id: p.id, name: p.name, count, revenue, priceMonthly: p.priceMonthly };
      });

      // Últimas faturas de todas as academias
      const recentInvoices = enrichedTenants
        .flatMap(t => (t.invoices || []).map(inv => ({ ...inv, tenantId: t.id, tenantName: t.name })))
        .sort((a, b) => String(b.paidAt || b.createdAt || b.refMonth).localeCompare(String(a.paidAt || a.createdAt || a.refMonth)))
        .slice(0, 25);

      json(res, 200, {
        ok: true,
        platform: store.platform,
        plans: store.plans,
        metrics: {
          mrr,
          arr: mrr * 12,
          totalGyms: enrichedTenants.length,
          activeGyms,
          trialGyms,
          pastDueGyms,
          suspendedGyms,
          totalStudents,
          activeStudents30d,
          totalTrainers,
          totalWorkoutsLogged,
          workoutsLast30d,
          liveTrainingNow,
          thirtyDaysAgo
        },
        mrrSeries,
        planBreakdown,
        tenants: enrichedTenants,
        recentInvoices
      });
    },

    'GET /api/saas/admin/tenants': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const tenants = listTenants(dataDir, db);
      json(res, 200, { ok: true, tenants });
    },

    'POST /api/saas/admin/tenants': (req, res) => withIdempotency(
      req,
      res,
      { routeKey: 'POST /api/saas/admin/tenants', authFn: requireSuperAdmin },
      async ({ actor: admin, body, replyJson }) => {
        try {
          const cleanSlug = sanitizeTenantId(body?.id || body?.slug || '');
          if (!cleanSlug || cleanSlug === 'default') {
            return replyJson(res, 400, { error: 'Informe um slug/identificador válido (ex: ironpower)' });
          }

          const ownerEmail = body?.ownerEmail ? normalizeEmail(body.ownerEmail) : null;
          if (body?.ownerEmail && !ownerEmail) {
            return replyJson(res, 400, { error: 'E-mail do gestor inválido' });
          }
          if (ownerEmail && db.users.some(u => u.email === ownerEmail)) {
            return replyJson(res, 409, { error: 'Já existe um usuário com este e-mail no sistema' });
          }

          let ownerUser = null;
          let generatedOwnerPassword = null;
          if (ownerEmail || body?.ownerName) {
            const suppliedPw = body?.ownerPassword !== undefined && String(body.ownerPassword).trim() !== ''
              ? String(body.ownerPassword)
              : null;
            if (suppliedPw !== null) {
              const pwErr = b2bPasswordError(suppliedPw, String(body?.ownerName || cleanSlug));
              if (pwErr) return replyJson(res, 400, pwErr);
            }
            const rawPw = suppliedPw || generateTempPassword();
            if (!suppliedPw) generatedOwnerPassword = rawPw;
            const h = await hashPassword(rawPw);
            const nowIso = new Date().toISOString();
            ownerUser = {
              id: 'u_owner_' + cleanSlug + '_' + crypto.randomBytes(3).toString('hex'),
              name: String(body.ownerName || `Gestor ${body.name || cleanSlug}`).trim(),
              ...(ownerEmail ? { email: ownerEmail } : {}),
              phone: String(body.phone || '').trim(),
              tenantId: cleanSlug,
              saasRole: 'gym_owner',
              role: 'trainer',
              created: nowIso,
              pw: { h, set: nowIso }
            };
          }

          const created = runDbMutation(() => {
            if (ownerUser?.email && db.users.some(u => u.email === ownerUser.email)) {
              const conflictErr = new Error('Já existe um usuário com este e-mail no sistema');
              conflictErr.httpStatus = 409;
              throw conflictErr;
            }
            const tenantCreated = createTenant(dataDir, {
              ...body,
              id: cleanSlug,
              ownerEmail: ownerEmail || '',
              ownerUserId: ownerUser?.id || null
            });
            if (ownerUser) {
              if (hasSqliteDir) upsertUserSqlite(dataDir, ownerUser, null);
              db.users.push(ownerUser);
              saveDb();
            }
            return tenantCreated;
          });

          // Provisiona modelos de treino padrão para a nova academia
          const tDir = getTenantDir(dataDir, created.id);
          loadTemplates(tDir, { seedIfMissing: true });

          audit(req, 'saas.tenant.create', { user: admin, msg: created.id });
          replyJson(res, 201, {
            ok: true,
            tenant: created,
            ownerCreated: Boolean(ownerUser),
            ...(generatedOwnerPassword ? { initialOwnerPassword: generatedOwnerPassword } : {})
          });
        } catch (e) {
          if (e?.httpStatus === 409 || isSqliteUniqueConstraintError(e)) {
            return replyJson(res, 409, { error: 'Já existe um usuário com este e-mail ou nome de acesso no sistema' });
          }
          replyDomainError(res, e, 400, replyJson);
        }
      }
    ),

    'PUT /api/saas/admin/tenants': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const id = body?.id;
      if (!id) return json(res, 400, { error: 'Identificador da academia (id) é obrigatório' });
      try {
        const updated = updateTenant(dataDir, id, body);
        audit(req, 'saas.tenant.update', { user: admin, msg: id });
        json(res, 200, { ok: true, tenant: updated });
      } catch (e) {
        replyDomainError(res, e, 400, json);
      }
    },

    'POST /api/saas/admin/tenants/status': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const { id, status } = body || {};
      if (!id || !['active', 'trial', 'past_due', 'suspended'].includes(status)) {
        return json(res, 400, { error: 'Informe id e status válido (active, trial, past_due, suspended)' });
      }
      try {
        const updated = updateTenant(dataDir, id, { status });
        audit(req, 'saas.tenant.status', { user: admin, msg: `${id} -> ${status}` });
        json(res, 200, { ok: true, tenant: updated });
      } catch (e) {
        replyDomainError(res, e, 400, json);
      }
    },

    'POST /api/saas/admin/tenants/owner-password': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const { tenantId, password, ownerEmail, ownerName } = body || {};
      if (!tenantId) {
        return json(res, 400, { error: 'Informe o identificador da academia (tenantId).' });
      }
      const cleanId = sanitizeTenantId(tenantId);
      const tenant = getTenant(dataDir, cleanId);
      if (!tenant) return json(res, 404, { error: 'Academia não encontrada' });

      const pwErr = b2bPasswordError(String(password || ''), String(ownerName || tenant.ownerName || ''));
      if (pwErr) {
        return json(res, 400, pwErr);
      }

      const h = await hashPassword(String(password));
      const nowIso = new Date().toISOString();
      let ownerUser;
      try {
        ownerUser = runDbMutation(() => {
          const freshTenant = getTenant(dataDir, cleanId) || tenant;
          let found = db.users.find(u => u.tenantId === cleanId && u.saasRole === 'gym_owner');
          if (!found) {
            const normEmail = normalizeEmail(ownerEmail || freshTenant.ownerEmail || `gestor@${cleanId}.com.br`);
            found = {
              id: 'u_owner_' + cleanId + '_' + crypto.randomBytes(3).toString('hex'),
              name: String(ownerName || freshTenant.ownerName || `Gestor ${freshTenant.name}`).trim(),
              ...(normEmail ? { email: normEmail } : {}),
              tenantId: cleanId,
              saasRole: 'gym_owner',
              role: 'trainer',
              created: nowIso,
              pw: { h, set: nowIso }
            };
            if (hasSqliteDir) upsertUserSqlite(dataDir, found, null);
            db.users.push(found);
            updateTenant(dataDir, cleanId, { ownerUserId: found.id, ownerEmail: normEmail || freshTenant.ownerEmail, ownerName: found.name });
          } else {
            found.pw = { h, set: nowIso };
            found.sv = (found.sv || 0) + 1;
            if (ownerName) found.name = String(ownerName).trim();
            if (hasSqliteDir) upsertUserSqlite(dataDir, found, null);
          }
          saveDb();
          return found;
        });
      } catch (err) {
        if (isSqliteUniqueConstraintError(err)) {
          return json(res, 409, { error: 'E-mail ou nome de acesso do gestor já em uso' });
        }
        throw err;
      }
      audit(req, 'saas.tenant.owner-pw', { user: admin, msg: cleanId });
      json(res, 200, { ok: true, owner: { id: ownerUser.id, name: ownerUser.name, email: ownerUser.email } });
    },

    'POST /api/saas/admin/tenants/invoice': (req, res) => withIdempotency(
      req,
      res,
      { routeKey: 'POST /api/saas/admin/tenants/invoice', authFn: requireSuperAdmin },
      async ({ actor: admin, body, replyJson }) => {
        const { tenantId, ...invoiceInput } = body || {};
        if (!tenantId) return replyJson(res, 400, { error: 'tenantId é obrigatório' });
        try {
          const invoice = recordTenantInvoice(dataDir, tenantId, invoiceInput);
          audit(req, 'saas.tenant.invoice', { user: admin, msg: `${tenantId} R$${invoice.amount}` });
          replyJson(res, 200, { ok: true, invoice, tenant: getTenant(dataDir, tenantId) });
        } catch (e) {
          replyDomainError(res, e, 400, replyJson);
        }
      }
    ),

    'DELETE /api/saas/admin/tenants': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const id = sanitizeTenantId(body?.id || '');
      if (!id || id === 'default') return json(res, 400, { error: 'id inválido' });
      try {
        const tenantUsers = db.users.filter(u => u.tenantId === id);
        for (const u of tenantUsers) {
          if (removeAccount) removeAccount(u);
          else db.users = db.users.filter(x => x.id !== u.id);
        }
        db.invites = (db.invites || []).filter(i => i.tenantId !== id);
        saveDb();
        if (hasSqliteDir) clearTenantExercisesData(dataDir, id);
        mediaStore?.removeUser?.(tenantMediaBucket(id));
        deleteTenant(dataDir, id);
        audit(req, 'saas.tenant.delete', { user: admin, msg: id });
        json(res, 200, { ok: true });
      } catch (e) {
        replyDomainError(res, e, 400, json);
      }
    },

    'GET /api/saas/admin/plans': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      json(res, 200, { ok: true, plans: listSaasPlans(dataDir) });
    },

    'PUT /api/saas/admin/plans': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      try {
        const plan = upsertSaasPlan(dataDir, body || {});
        audit(req, 'saas.plan.update', { user: admin, msg: plan.id });
        json(res, 200, { ok: true, plan, plans: listSaasPlans(dataDir) });
      } catch (e) {
        replyDomainError(res, e, 400, json);
      }
    },

    'PUT /api/saas/admin/platform': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      const store = loadSaasStore(dataDir);
      store.platform = {
        ...store.platform,
        name: String(body?.name ?? store.platform.name).trim(),
        supportEmail: String(body?.supportEmail ?? store.platform.supportEmail).trim(),
        supportPhone: String(body?.supportPhone ?? store.platform.supportPhone).trim(),
        trialDays: Math.max(1, Math.min(90, Number(body?.trialDays ?? store.platform.trialDays ?? 14)))
      };
      saveSaasStore(dataDir, store);
      audit(req, 'saas.platform.update', { user: admin });
      json(res, 200, { ok: true, platform: store.platform });
    },

    'GET /api/saas/admin/audit': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const events = typeof auditReader === 'function' ? auditReader(120) : [];
      json(res, 200, { ok: true, events });
    },

    /* =====================================================================
     * GATEWAY CENTRAL WHATSAPP RIT (SUPER ADMIN)
     * ===================================================================== */
    'GET /api/saas/admin/whatsapp/status': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;

      const url = (process.env.EVOLUTION_API_URL || 'http://localhost:8082').replace(/\/+$/, '');
      const key = resolveEnvEvolutionKey();
      const instance = (process.env.EVOLUTION_INSTANCE || 'rit').trim();
      if (!key) {
        return json(res, 503, { ok: false, connected: false, error: 'Chave da Evolution API (EVOLUTION_API_KEY) não configurada no servidor.' });
      }

      const status = await testEvolutionConnection({ url, apiKey: key, instance });
      let instanceInfo = null;

      if (status.ok && status.state === 'open') {
        const instRes = await fetchEvolutionInstances({ url, apiKey: key, instance, allowPlatformFallback: true });
        const list = instRes.ok ? instRes.instances : [];
        const inst = list.find(i => i.name === instance);
        if (inst) {
          instanceInfo = {
            ownerJid: inst.ownerJid || null,
            profileName: inst.profileName || null,
            phone: inst.ownerJid ? inst.ownerJid.split('@')[0] : null
          };
        }
      }

      json(res, 200, {
        ok: true,
        connected: status.ok && status.state === 'open',
        state: status.state || 'close',
        instance,
        instanceInfo
      });
    },

    'GET /api/saas/admin/whatsapp/qr': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;

      const qrRes = await fetchEvolutionQrCode({
        url: process.env.EVOLUTION_API_URL,
        apiKey: process.env.EVOLUTION_API_KEY,
        instance: process.env.EVOLUTION_INSTANCE
      });
      if (!qrRes.ok) {
        return json(res, qrRes.status === 400 || qrRes.status === 503 ? qrRes.status : 502, { ok: false, error: qrRes.error });
      }
      json(res, 200, {
        ok: true,
        connected: qrRes.connected,
        base64: qrRes.base64,
        code: qrRes.code,
        count: qrRes.count
      });
    },

    'POST /api/saas/admin/whatsapp/disconnect': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;

      const url = (process.env.EVOLUTION_API_URL || 'http://localhost:8082').replace(/\/+$/, '');
      const key = resolveEnvEvolutionKey();
      const instance = (process.env.EVOLUTION_INSTANCE || 'rit').trim();
      if (!key) {
        return json(res, 503, { ok: false, error: 'Chave da Evolution API (EVOLUTION_API_KEY) não configurada no servidor.' });
      }

      const discRes = await disconnectEvolutionInstance({ url, apiKey: key, instance, allowPlatformFallback: true });
      if (!discRes.ok) {
        return json(res, discRes.status === 400 || discRes.status === 503 ? discRes.status : 502, { ok: false, error: discRes.error });
      }
      audit(req, 'saas.whatsapp.disconnect', { user: admin });
      json(res, 200, { ok: true, message: 'WhatsApp desconectado com sucesso' });
    },

    'POST /api/saas/admin/whatsapp/test': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;

      const body = await readBody(req);
      const clean = cleanWhatsAppPhone(body?.phone);
      if (!clean) return json(res, 400, { error: 'Telefone inválido para teste' });

      const testMsg = `⚡ *Notificações WhatsApp • Rit*\n\n`
        + `Olá! O canal oficial de notificações da Rit está ativo e conectado com sucesso! ✅\n\n`
        + `Os relatórios de treino concluído dos alunos e mensagens aos professores serão entregues por este canal.\n\n`
        + `_Rit • Aplicativo de Treinos & Gestão Fitness_`;

      const result = await sendEvolutionTextMessage({
        phone: clean,
        message: testMsg
      });

      if (!result.ok) {
        return json(res, 400, { error: result.error || 'Falha ao enviar mensagem de teste' });
      }

      audit(req, 'saas.whatsapp.test', { user: admin, msg: clean });
      json(res, 200, { ok: true, sentTo: clean, message: 'Mensagem de teste enviada com sucesso!' });
    },

    'POST /api/saas/admin/whatsapp/send': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;

      const body = await readBody(req);
      const clean = cleanWhatsAppPhone(body?.phone);
      if (!clean) return json(res, 400, { error: 'Telefone inválido' });
      const rawMsg = String(body?.message || '').trim();
      if (!rawMsg) return json(res, 400, { error: 'Mensagem não pode estar vazia' });

      const result = await sendEvolutionTextMessage({
        phone: clean,
        message: rawMsg
      });

      if (!result.ok) {
        return json(res, 400, { error: result.error || 'Falha ao enviar mensagem' });
      }

      audit(req, 'saas.whatsapp.send', { user: admin, msg: clean });
      json(res, 200, { ok: true, sentTo: clean, message: 'Mensagem enviada com sucesso!' });
    },

    'GET /api/saas/admin/mercadopago/status': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;

      const configured = isMercadoPagoConfigured();
      const token = (process.env.MERCADO_PAGO_ACCESS_TOKEN || '').trim();
      const maskedToken = configured ? `APP_USR-...${token.slice(-6)}` : null;
      const reqHost = req.headers.host || 'localhost';
      const defaultProtocol = reqHost.includes('localhost') ? 'http' : 'https';
      const origin = process.env.ORIGIN || `${defaultProtocol}://${reqHost}`;
      const webhookUrl = `${origin.replace(/\/+$/, '')}/api/saas/billing/webhook`;

      json(res, 200, {
        ok: true,
        configured,
        maskedToken,
        webhookUrl,
        hasWebhookSecret: Boolean(process.env.MERCADO_PAGO_WEBHOOK_SECRET)
      });
    },

    /* =====================================================================
     * COBRANÇA PIX & ASSINATURAS (INTEGRAÇÃO MERCADO PAGO)
     * ===================================================================== */
    ...(() => {
      const requireBillingAuth = (req, res) => {
        const user = readSession(req);
        if (!user) {
          json(res, 401, { error: 'not signed in' });
          return null;
        }
        if (!isSuperAdmin(user) && !isGymManagerOrOwner(user) && user.saasRole !== 'manager') {
          audit(req, 'saas.billing.denied', { ok: false, user });
          json(res, 403, { error: 'Acesso financeiro restrito ao gestor da academia' });
          return null;
        }
        if (!isSuperAdmin(user) && user.tenantId) {
          const access = getTenantAccessState(dataDir, user.tenantId);
          if (access.blocked && !access.billingOnly) {
            audit(req, 'saas.billing.denied_suspended', { ok: false, user });
            json(res, 403, { error: 'Esta academia foi suspensa administrativamente. Entre em contato com o suporte.' });
            return null;
          }
        }
        return user;
      };

      const tryConfirmFromMercadoPago = (tenant, mpData, opts = {}) => {
        const resUpdate = applyGatewayPaymentUpdate(dataDir, tenant.id, mpData, opts);
        if (!resUpdate || resUpdate.outcome === 'ignored' || resUpdate.outcome === 'pending' || resUpdate.outcome === 'in_process') {
          return null;
        }
        if (resUpdate.amountMismatch) return resUpdate;
        if (resUpdate.outcome === 'approved') return resUpdate;
        return null;
      };

      return {
        /**
         * Gera uma nova cobrança PIX para assinatura mensal ou anual com desconto.
         */
        'POST /api/saas/billing/checkout-pix': (req, res) => withIdempotency(
          req,
          res,
          { routeKey: 'POST /api/saas/billing/checkout-pix', authFn: requireBillingAuth },
          async ({ actor: user, body, gwIdempotencyKey, replyJson }) => {
            const superUser = isSuperAdmin(user);
            const targetTenantId = superUser && body?.tenantId ? sanitizeTenantId(body.tenantId) : (user.tenantId || null);

            if (!targetTenantId || targetTenantId === 'default') {
              return replyJson(res, 400, { error: 'Identificador de academia ou personal não informado' });
            }

            const tenant = getTenant(dataDir, targetTenantId);
            if (!tenant) return replyJson(res, 404, { error: 'Academia ou personal não encontrado' });

            if (process.env.NODE_ENV === 'production' && !isPixSimulationAllowed() && !isMercadoPagoConfigured()) {
              return replyJson(res, 503, { error: 'Gateway de pagamento Mercado Pago não configurado nesta instância.' });
            }

            const plans = listSaasPlans(dataDir);
            const requestedPlanId = body?.planId !== undefined && body?.planId !== null
              ? String(body.planId).trim()
              : '';
            if (requestedPlanId && !plans.some(p => p.id === requestedPlanId)) {
              return replyJson(res, 400, { error: 'Plano inválido ou inexistente' });
            }
            const planId = requestedPlanId || String(tenant.planId || 'starter').trim();
            const plan = plans.find(p => p.id === planId) || plans.find(p => p.id === 'starter') || plans[0];

            const activeStudents = db.users.filter(
              u => u.tenantId === tenant.id && isStudentAccount(u) && !u.disabled
            ).length;
            const activeTrainers = db.users.filter(
              u => u.tenantId === tenant.id && !isSuperAdmin(u) && (u.saasRole === 'trainer' || u.saasRole === 'gym_manager' || u.saasRole === 'gym_owner' || u.role === 'trainer') && !u.disabled
            ).length;
            const effectiveMaxStudents = plan.id === tenant.planId && tenant.limits?.maxStudents
              ? Number(tenant.limits.maxStudents)
              : Number(plan.maxStudents || 0);
            const effectiveMaxTrainers = plan.id === tenant.planId && tenant.limits?.maxTrainers
              ? Number(tenant.limits.maxTrainers)
              : Number(plan.maxTrainers || 0);
            if ((effectiveMaxStudents > 0 && activeStudents > effectiveMaxStudents) || (effectiveMaxTrainers > 0 && activeTrainers > effectiveMaxTrainers)) {
              return replyJson(res, 422, {
                error: `Seu plano selecionado (${plan.name}) comporta até ${effectiveMaxStudents} alunos ativos e ${effectiveMaxTrainers} profissionais, mas você possui ${activeStudents} alunos e ${activeTrainers} profissionais ativos.`,
                code: 'plan-capacity-exceeded',
                activeStudents,
                activeTrainers,
                maxStudents: effectiveMaxStudents,
                maxTrainers: effectiveMaxTrainers
              });
            }

            const cycle = body?.cycle === 'annual' ? 'annual' : 'monthly';
            const monthlyRate = Number(cycle === 'annual' ? (plan.priceAnnualMonthly || plan.priceMonthly) : plan.priceMonthly);
            const totalAmount = cycle === 'annual' ? Number((monthlyRate * 12).toFixed(2)) : Number(monthlyRate.toFixed(2));
            const cycleLabel = cycle === 'annual' ? 'Anual' : 'Mensal';
            const note = cycle === 'annual'
              ? `Assinatura Anual - ${plan.name} (12x R$ ${monthlyRate}/mês com desconto)`
              : `Assinatura Mensal - ${plan.name}`;

            // Reserva atomicamente um único checkout PIX aberto por academia+plano antes de chamar o Mercado Pago
            const reserveOpts = {
              planId: plan.id,
              cycle,
              amount: totalAmount,
              method: 'PIX',
              note,
              refMonth: new Date().toISOString().slice(0, 7),
              gatewayIdempotencyKey: gwIdempotencyKey
            };
            let reservation = reservePixCheckoutInvoice(dataDir, tenant.id, reserveOpts);
            if (
              reservation.status === 'reused' &&
              String(reservation.invoice?.mpPaymentId || '').startsWith('mp_sim_') &&
              (isMercadoPagoConfigured() || (process.env.NODE_ENV === 'production' && !isPixSimulationAllowed()))
            ) {
              failPixCheckoutInvoice(dataDir, tenant.id, reservation.invoice.id);
              reservation = reservePixCheckoutInvoice(dataDir, tenant.id, reserveOpts);
            }

            if (reservation.status === 'in_flight') {
              return replyJson(res, 409, {
                error: 'Cobrança PIX já está sendo gerada para este plano. Aguarde alguns segundos.',
                inFlight: true,
                invoice: reservation.invoice
              });
            }

            if (reservation.status === 'reused') {
              const reusedInv = reservation.invoice;
              const reusedCycle = reusedInv.cycle === 'annual' ? 'annual' : 'monthly';
              const reusedCycleLabel = reusedCycle === 'annual' ? 'Anual' : 'Mensal';
              return replyJson(res, 200, {
                ok: true,
                reused: true,
                invoice: reusedInv,
                pix: {
                  paymentId: reusedInv.mpPaymentId,
                  amount: reusedInv.amount,
                  cycle: reusedCycle,
                  cycleLabel: reusedCycleLabel,
                  planId: reusedInv.planId || plan.id,
                  planName: reusedInv.planName || plan.name,
                  qrCode: reusedInv.qrCode,
                  qrCodeBase64: reusedInv.qrCodeBase64,
                  ticketUrl: reusedInv.ticketUrl,
                  expiresAt: reusedInv.expiresAt,
                  mock: String(reusedInv.mpPaymentId || '').startsWith('mp_sim_'),
                  simulationAllowed: isPixSimulationAllowed()
                }
              });
            }

            const invId = reservation.invoice.id;
            const externalReference = `rit:${tenant.id}:${invId}:${cycle}:${plan.id}`;

            // Determina a URL de retorno para webhook do Mercado Pago
            const reqHost = req.headers.host || 'localhost';
            const defaultProtocol = reqHost.includes('localhost') ? 'http' : 'https';
            const origin = process.env.ORIGIN || `${defaultProtocol}://${reqHost}`;
            const notificationUrl = `${origin.replace(/\/+$/, '')}/api/saas/billing/webhook`;

            let pixResult;
            try {
              pixResult = await createPixPayment({
                amount: totalAmount,
                description: `Rit - ${plan.name} (${cycleLabel})`,
                payerEmail: tenant.ownerEmail || 'financeiro@treinerit.com.br',
                payerName: tenant.ownerName || tenant.name || 'Cliente Rit',
                payerDoc: tenant.document || '',
                externalReference,
                notificationUrl,
                idempotencyKey: reservation.idempotencyKey
              });
            } catch (err) {
              failPixCheckoutInvoice(dataDir, tenant.id, invId);
              return replyJson(res, err.statusCode || 502, { error: err.message || 'Falha ao comunicar com o Mercado Pago' });
            }

            // Finaliza a fatura reservada com os metadados do PIX emitido pelo Mercado Pago
            const invoice = finalizePixCheckoutInvoice(dataDir, tenant.id, invId, {
              mpPaymentId: pixResult.id,
              qrCode: pixResult.qrCode,
              qrCodeBase64: pixResult.qrCodeBase64,
              ticketUrl: pixResult.ticketUrl,
              expiresAt: pixResult.dateOfExpiration,
              note
            });

            audit(req, 'saas.billing.checkout_pix', {
              user,
              msg: `${tenant.id} plano ${plan.id} ${cycle} R$${totalAmount}`
            });

            replyJson(res, 200, {
              ok: true,
              invoice,
              pix: {
                paymentId: pixResult.id,
                amount: totalAmount,
                cycle,
                cycleLabel,
                planId: plan.id,
                planName: plan.name,
                qrCode: pixResult.qrCode,
                qrCodeBase64: pixResult.qrCodeBase64,
                ticketUrl: pixResult.ticketUrl,
                expiresAt: pixResult.dateOfExpiration,
                mock: Boolean(pixResult.mock),
                simulationAllowed: isPixSimulationAllowed()
              }
            });
          }
        ),

        /**
         * Retorna o status de faturamento da academia/personal, faturas recentes e planos disponíveis.
         */
        'GET /api/saas/billing/status': async (req, res) => {
          const user = requireBillingAuth(req, res);
          if (!user) return;

          const qObj = new URL(req.url || '/api/saas/billing/status', 'http://x').searchParams;
          const superUser = isSuperAdmin(user);
          const reqTenant = qObj.get('tenantId') || resolveTenantId(req);
          const targetTenantId = superUser && reqTenant !== 'default' ? reqTenant : (user.tenantId || null);

          if (!targetTenantId || targetTenantId === 'default') {
            return json(res, 400, { error: 'Identificador de academia ou personal não informado' });
          }

          const tenant = getTenant(dataDir, targetTenantId);
          if (!tenant) return json(res, 404, { error: 'Academia ou personal não encontrado' });

          // Se houver uma fatura pendente com mpPaymentId, verifica status no Mercado Pago
          const pendingPix = (tenant.invoices || []).find(i => i.status === 'pending' && i.mpPaymentId);
          if (pendingPix && isMercadoPagoConfigured() && !pendingPix.mpPaymentId.startsWith('mp_sim_')) {
            try {
              const mpData = await getPayment(pendingPix.mpPaymentId);
              const resConfirm = tryConfirmFromMercadoPago(tenant, mpData, {
                invoiceId: pendingPix.id,
                mpPaymentId: pendingPix.mpPaymentId,
                cycle: pendingPix.cycle,
                planId: pendingPix.planId
              });
              if (resConfirm && !resConfirm.amountMismatch) {
                const refreshed = resConfirm.tenant;
                const refreshedAccess = getTenantAccessState(dataDir, refreshed.id);
                return json(res, 200, {
                  ok: true,
                  tenantId: refreshed.id,
                  name: refreshed.name,
                  accountType: refreshed.accountType,
                  status: refreshed.status,
                  planId: refreshed.planId,
                  mrr: refreshed.mrr,
                  nextBillingAt: refreshed.nextBillingAt,
                  trialEndsAt: refreshed.trialEndsAt,
                  isSuspended: refreshedAccess.blocked,
                  accessBlocked: refreshedAccess.blocked,
                  blockReason: refreshedAccess.reason,
                  billingOnly: refreshedAccess.billingOnly,
                  invoices: refreshed.invoices || [],
                  availablePlans: listSaasPlans(dataDir),
                  mercadoPagoConfigured: isMercadoPagoConfigured(),
                  simulationAllowed: isPixSimulationAllowed()
                });
              }
            } catch { /* ignora erro transitório de consulta */ }
          }

          const tenantAccess = getTenantAccessState(dataDir, tenant.id);
          json(res, 200, {
            ok: true,
            tenantId: tenant.id,
            name: tenant.name,
            accountType: tenant.accountType,
            status: tenant.status,
            planId: tenant.planId,
            mrr: tenant.mrr,
            nextBillingAt: tenant.nextBillingAt,
            trialEndsAt: tenant.trialEndsAt,
            isSuspended: tenantAccess.blocked,
            accessBlocked: tenantAccess.blocked,
            blockReason: tenantAccess.reason,
            billingOnly: tenantAccess.billingOnly,
            invoices: tenant.invoices || [],
            availablePlans: listSaasPlans(dataDir),
            mercadoPagoConfigured: isMercadoPagoConfigured(),
            simulationAllowed: isPixSimulationAllowed()
          });
        },

        /**
         * Consulta detalhes e dados de PIX de uma fatura específica.
         */
        'GET /api/saas/billing/invoice': async (req, res) => {
          const user = requireBillingAuth(req, res);
          if (!user) return;

          const qObj = new URL(req.url || '/api/saas/billing/invoice', 'http://x').searchParams;
          const invId = qObj.get('id');
          if (!invId) return json(res, 400, { error: 'id da fatura não informado' });

          const superUser = isSuperAdmin(user);
          const targetTenantId = superUser && qObj.get('tenantId') ? sanitizeTenantId(qObj.get('tenantId')) : (user.tenantId || null);

          if (!targetTenantId || targetTenantId === 'default') {
            return json(res, 400, { error: 'Identificador de academia ou personal não informado' });
          }

          const tenant = getTenant(dataDir, targetTenantId);
          if (!tenant) return json(res, 404, { error: 'Academia ou personal não encontrado' });

          const invoice = (tenant.invoices || []).find(i => i.id === invId);
          if (!invoice) return json(res, 404, { error: 'Fatura não encontrada' });

          // Se a fatura estiver pendente com mpPaymentId, confere se já foi paga
          if (invoice.status === 'pending' && invoice.mpPaymentId && isMercadoPagoConfigured() && !invoice.mpPaymentId.startsWith('mp_sim_')) {
            try {
              const mpData = await getPayment(invoice.mpPaymentId);
              const resConfirm = tryConfirmFromMercadoPago(tenant, mpData, {
                invoiceId: invoice.id,
                mpPaymentId: invoice.mpPaymentId,
                cycle: invoice.cycle,
                planId: invoice.planId
              });
              if (resConfirm && !resConfirm.amountMismatch) {
                return json(res, 200, { ok: true, invoice: resConfirm.invoice, paidNow: !resConfirm.alreadyPaid });
              }
            } catch { /* ignora */ }
          }

          json(res, 200, { ok: true, invoice });
        },

        /**
         * Webhook oficial para notificações assíncronas do Mercado Pago.
         * 1) Valida assinatura HMAC estritamente sobre os bytes brutos antes de parsear ou filtrar;
         * 2) Registra `event_id` único primeiro em `webhook_events` (duplicatas devolvem 200 imediato);
         * 3) Responde 200 rápido e delega consulta autoritativa ao gateway (`getPayment`) + WhatsApp para fila SQLite assíncrona.
         */
        'POST /api/saas/billing/webhook': async (req, res) => {
          const { rawBuf, rawText } = await readWebhookRawBody(req);
          const qObj = new URL(req.url || '/api/saas/billing/webhook', 'http://x').searchParams;

          const sigOk = verifyWebhookSignature({
            headers: req.headers,
            query: Object.fromEntries(qObj.entries()),
            rawBody: rawBuf,
            dataId: qObj.get('data.id') || qObj.get('id') || ''
          });
          if (!sigOk) {
            console.warn('Webhook do Mercado Pago rejeitado por assinatura inválida');
            return json(res, 401, { error: 'Assinatura de webhook inválida' });
          }

          let body = {};
          if (rawText && rawText.trim()) {
            try {
              body = JSON.parse(rawText);
            } catch {
              return json(res, 400, { error: 'Payload JSON inválido' });
            }
          }

          const paymentId = String(qObj.get('data.id') || qObj.get('id') || body?.data?.id || body?.id || '').trim();
          const actionType = String(qObj.get('type') || body?.type || body?.action || '').trim();
          const payloadHash = crypto.createHash('sha256').update(rawBuf).digest('hex');

          const explicitEventId = (body?.data?.id !== undefined && body?.id !== undefined && String(body.id) !== String(body.data.id))
            ? String(body.id).trim()
            : '';
          const reqIdHeader = req.headers?.['x-request-id'];
          const reqId = reqIdHeader ? String(Array.isArray(reqIdHeader) ? reqIdHeader[0] : reqIdHeader).trim() : '';
          const eventId = explicitEventId
            ? `mp:evt:${explicitEventId.slice(0, 100)}`
            : reqId
              ? `mp:req:${reqId.slice(0, 80)}:${paymentId.slice(0, 48) || 'none'}:${payloadHash.slice(0, 16)}`
              : `mp:hash:${paymentId.slice(0, 48) || 'none'}:${actionType.slice(0, 40) || 'webhook'}:${payloadHash.slice(0, 24)}`;

          if (!paymentId || (actionType && !String(actionType).includes('payment'))) {
            if (hasSqliteDir) {
              const ignoredResult = {
                ok: true,
                ignored: true,
                ...(paymentId ? { actionType } : { reason: 'Nenhum payment ID na notificação' })
              };
              const reg = registerWebhookEventSqlite(dataDir, {
                eventId,
                provider: 'mercadopago',
                actionType: actionType || null,
                resourceId: paymentId || null,
                payloadHash,
                rawPayload: rawText || '{}',
                initialStatus: 'ignored',
                resultJson: JSON.stringify(ignoredResult)
              });
              if (!reg.inserted) {
                return json(res, 200, { ok: true, deduplicated: true, alreadyProcessed: true, eventId });
              }
            }
            return json(
              res,
              200,
              paymentId
                ? { ok: true, ignored: true, actionType, eventId }
                : { ok: true, ignored: true, reason: 'Nenhum payment ID na notificação', eventId }
            );
          }

          if (hasSqliteDir) {
            const reg = registerWebhookEventSqlite(dataDir, {
              eventId,
              provider: 'mercadopago',
              actionType: actionType || 'payment',
              resourceId: paymentId,
              payloadHash,
              rawPayload: rawText || '{}',
              initialStatus: 'queued'
            });
            if (!reg.inserted) {
              return json(res, 200, { ok: true, deduplicated: true, alreadyProcessed: true, eventId });
            }
          }

          const paidInfo = hasSqliteDir ? isMpPaymentAlreadyPaid(dataDir, paymentId) : null;
          if (hasSqliteDir) {
            scheduleWebhookFlush(dataDir, { audit });
          }

          return json(res, 200, {
            ok: true,
            queued: true,
            eventId,
            ...(paidInfo ? { alreadyProcessed: true, tenantId: paidInfo.tenantId, invoiceId: paidInfo.invoiceId } : {})
          });
        },

        /**
         * Endpoint para simulação de pagamento de fatura PIX em ambiente local ou de demonstração.
         */
        'POST /api/saas/billing/simulate-pix': (req, res) => withIdempotency(
          req,
          res,
          { routeKey: 'POST /api/saas/billing/simulate-pix', authFn: requireBillingAuth },
          async ({ actor: user, body, replyJson }) => {
            const superUser = isSuperAdmin(user);
            if (process.env.NODE_ENV === 'production' && !isPixSimulationAllowed()) {
              return replyJson(res, 403, { error: 'Simulação de pagamento desativada em produção.' });
            }
            // Simulação permitida exclusivamente no modo de demonstração (SAAS_DEMO=1)
            if (!isPixSimulationAllowed()) {
              return replyJson(res, 403, { error: 'Simulação de pagamento permitida apenas em modo demonstração (SAAS_DEMO=1).' });
            }

            const targetTenantId = superUser && body?.tenantId ? sanitizeTenantId(body.tenantId) : (user.tenantId || null);
            const invoiceId = body?.invoiceId;

            if (!targetTenantId || !invoiceId) {
              return replyJson(res, 400, { error: 'tenantId e invoiceId são obrigatórios' });
            }

            const tenant = getTenant(dataDir, targetTenantId);
            if (!tenant) return replyJson(res, 404, { error: 'Academia não encontrada' });

            const invoice = (tenant.invoices || []).find(i => i.id === invoiceId);
            if (!invoice) return replyJson(res, 404, { error: 'Fatura não encontrada' });

            // Em produção com Mercado Pago ativo, bloqueia simulações arbitrárias
            if (isMercadoPagoConfigured() && !superUser && !invoice.mpPaymentId?.startsWith('mp_sim_')) {
              return replyJson(res, 403, { error: 'Simulação de pagamento desativada em produção com Mercado Pago oficial ativo.' });
            }

            const confirmed = confirmTenantPayment(dataDir, targetTenantId, {
              invoiceId: invoice.id,
              amount: invoice.amount,
              paidAt: new Date().toISOString(),
              method: 'PIX (Simulação)',
              cycle: invoice.cycle,
              planId: invoice.planId,
              planName: invoice.planName
            });

            if (!confirmed.alreadyPaid) {
              audit(req, 'saas.billing.pix_simulated', { user, msg: `${targetTenantId} fatura ${invoiceId}` });
            }
            replyJson(res, 200, {
              ok: true,
              alreadyProcessed: confirmed.alreadyPaid,
              invoice: confirmed.invoice,
              tenant: confirmed.tenant
            });
          }
        )
      };
    })(),

    /* =====================================================================
     * 4. PAINEL DAS ACADEMIAS (GESTÃO DA UNIDADE, ALUNOS, EQUIPE & TREINOS)
     * ===================================================================== */
    'GET /api/gym/overview': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;

      const churnThreshold = ctx.tenant?.settings?.churnDaysThreshold || 5;
      const sp = new URL(req.url || '', 'http://x').searchParams;
      const qCycle = Number(sp.get('routineCycleDays'));
      const routineCycleDays = Number.isFinite(qCycle) && qCycle >= 7 && qCycle <= 365
        ? Math.round(qCycle)
        : Number(ctx.tenant?.settings?.routineCycleDays || 30);
      const nowMs = Date.now();
      const todayIso = new Date(nowMs).toISOString().slice(0, 10);
      const sevenDaysAgo = new Date(nowMs - 7 * 86400000).toISOString().slice(0, 10);
      const thirtyDaysAgo = new Date(nowMs - 30 * 86400000).toISOString().slice(0, 10);

      const allTenantStudents = listStudents(db, ctx.stateStorageDir, {
        tenantId: ctx.tenantId,
        includeDisabled: true,
        churnDaysThreshold: churnThreshold,
        routineCycleDays,
        includeWorkoutDates: true,
        stateOps,
        livePresence,
        nowMs
      });
      const rawStudents = filterStudentsByPortfolio(ctx, allTenantStudents);

      const dailyCounts = new Map();
      for (let i = 13; i >= 0; i--) {
        const dIso = new Date(nowMs - i * 86400000).toISOString().slice(0, 10);
        dailyCounts.set(dIso, 0);
      }
      const weekdayCounts = [0, 0, 0, 0, 0, 0, 0];
      let workoutsToday = 0;
      let workoutsWeek = 0;
      let workoutsMonth = 0;

      for (const s of rawStudents) {
        if (s.disabled) continue;
        for (const wDate of (s._workoutDates || [])) {
          if (!wDate) continue;
          if (wDate === todayIso) workoutsToday++;
          if (wDate >= sevenDaysAgo) workoutsWeek++;
          if (wDate >= thirtyDaysAgo) {
            workoutsMonth++;
            const wd = new Date(wDate + 'T12:00:00Z').getUTCDay();
            if (wd >= 0 && wd <= 6) weekdayCounts[wd]++;
          }
          if (dailyCounts.has(wDate)) {
            dailyCounts.set(wDate, dailyCounts.get(wDate) + 1);
          }
        }
      }

      const students = rawStudents.map(({ _workoutDates, ...rest }) => rest);
      const activeStudents = students.filter(s => !s.disabled);
      const active7d = activeStudents.filter(s => s.workoutsLast7d > 0);
      const withoutRoutine = activeStudents.filter(s => s.routineStatus === 'missing');
      const expiringRoutines = activeStudents
        .filter(s => s.routineStatus === 'expired' || s.routineStatus === 'expiring_soon')
        .sort((a, b) => (a.daysUntilRoutineExpiry ?? 999) - (b.daysUntilRoutineExpiry ?? 999));
      const pendingOnboarding = activeStudents.filter(s => s.onboardingPending);
      const liveNow = activeStudents.filter(s => s.trainingNow).map(s => ({
        id: s.id,
        name: s.name,
        assignedTrainerId: s.assignedTrainerId || null,
        ...s.trainingNow
      }));

      const churnAlerts = activeStudents
        .filter(s => s.churnStatus === 'critical' || s.churnStatus === 'warning')
        .sort((a, b) => (b.daysInactive ?? 999) - (a.daysInactive ?? 999));

      const inactiveStudents = activeStudents
        .filter(s => (s.daysInactive !== null && s.daysInactive > 7) || s.churnStatus === 'critical' || s.churnStatus === 'warning')
        .sort((a, b) => (b.daysInactive ?? 999) - (a.daysInactive ?? 999));

      const consistentStudents = activeStudents
        .filter(s => s.weeklyGoalHit || s.workoutsLast7d >= 3)
        .sort((a, b) => b.workoutsLast7d - a.workoutsLast7d);

      const recentFeedbacks = [];
      for (const s of activeStudents) {
        for (const fb of (s.recentFeedbacks || [])) {
          recentFeedbacks.push({
            studentId: s.id,
            studentName: s.name,
            studentPhone: s.phone || '',
            assignedTrainerId: s.assignedTrainerId || null,
            ...fb
          });
        }
      }
      recentFeedbacks.sort((a, b) => String(b.date).localeCompare(String(a.date)));

      const plannedWeeklySessions = activeStudents.reduce((acc, s) => acc + Number(s.plannedWeeklyDays || 0), 0);
      const weeklyCompletionPct = plannedWeeklySessions > 0
        ? Math.min(100, Math.round((workoutsWeek / plannedWeeklySessions) * 100))
        : 0;
      const routinesUpToDateCount = activeStudents.filter(s => s.routineStatus === 'up_to_date').length;
      const routinesPendingCount = activeStudents.length - routinesUpToDateCount;

      const staff = db.users.filter(
        u => u.tenantId === ctx.tenantId && (u.saasRole === 'gym_owner' || u.saasRole === 'gym_manager' || u.saasRole === 'trainer' || u.role === 'trainer')
      );
      const team = staff.map(u => ({
        id: u.id,
        name: u.name,
        email: u.email || '',
        phone: u.phone || '',
        cref: u.cref || '',
        specialty: u.specialty || '',
        saasRole: u.saasRole || 'trainer',
        disabled: Boolean(u.disabled),
        created: u.created || null,
        assignedStudents: students.filter(st => st.assignedTrainerId === u.id).length
      }));

      const templates = loadTemplates(ctx.tenantDir, { seedIfMissing: true });
      const invites = (db.invites || [])
        .filter(i => i.tenantId === ctx.tenantId)
        .map(i => ({
          ...i,
          usedByName: i.usedBy ? (db.users.find(u => u.id === i.usedBy)?.name || null) : null
        }));

      const rawTenant = ctx.tenant || {
        id: ctx.tenantId,
        name: loadTenantBranding(ctx.tenantDir).gymName,
        status: 'active',
        planName: 'Academia Completa',
        branding: loadTenantBranding(ctx.tenantDir),
        settings: { churnDaysThreshold: churnThreshold, routineCycleDays, inviteOnly: false, allowGuest: false },
        limits: { maxStudents: 100000, maxTrainers: 100000 }
      };
      const overviewTenant = sanitizeTenantForRole(rawTenant, ctx.superUser || isGymManagerOrOwner(ctx.user));

      const pendingVideoStudents = activeStudents
        .filter(s => (Number(s.pendingVideoReviewsCount) || 0) > 0)
        .map(s => ({
          id: s.id,
          name: s.name,
          assignedTrainerId: s.assignedTrainerId || null,
          pendingVideoReviewsCount: Number(s.pendingVideoReviewsCount) || 0,
          lastWorkoutDate: s.lastWorkoutDate || null
        }));
      const pendingVideoReviewsCount = pendingVideoStudents.reduce((acc, s) => acc + s.pendingVideoReviewsCount, 0);

      json(res, 200, {
        ok: true,
        tenant: overviewTenant,
        restrictedToPortfolio: isTrainerPortfolioRestricted(ctx),
        kpis: {
          totalStudents: activeStudents.length,
          disabledStudents: students.length - activeStudents.length,
          activeStudents7d: active7d.length,
          atRiskCount: churnAlerts.length,
          withoutRoutineCount: withoutRoutine.length,
          expiringRoutineCount: expiringRoutines.length,
          onboardingPendingCount: pendingOnboarding.length,
          pendingVideoReviewsCount,
          liveNowCount: liveNow.length,
          workoutsToday,
          workoutsWeek,
          workoutsMonth,
          trainerCount: team.length,
          templateCount: templates.length,
          churnDaysThreshold: churnThreshold,
          routineCycleDays
        },
        copilot: {
          priorityQueue: {
            withoutRoutine: withoutRoutine.slice(0, 30),
            expiringRoutines: expiringRoutines.slice(0, 30),
            pendingOnboarding: pendingOnboarding.slice(0, 30),
            pendingVideoReviews: pendingVideoStudents.slice(0, 30)
          },
          retentionRadar: {
            inactiveStudents: inactiveStudents.slice(0, 30),
            consistentStudents: consistentStudents.slice(0, 20)
          },
          recentFeedbacks: recentFeedbacks.slice(0, 15),
          pedagogicalKpis: {
            activeStudentsCount: activeStudents.length,
            trainedLast7dCount: active7d.length,
            liveNowCount: liveNow.length,
            plannedWeeklySessions,
            completedWeeklySessions: workoutsWeek,
            weeklyCompletionPct,
            routinesUpToDateCount,
            routinesPendingCount,
            withoutRoutineCount: withoutRoutine.length,
            expiringRoutineCount: expiringRoutines.length,
            onboardingPendingCount: pendingOnboarding.length
          }
        },
        students,
        templates,
        team,
        maxTrainers: overviewTenant?.limits?.maxTrainers || 10,
        invites,
        liveNow,
        churnAlerts: churnAlerts.slice(0, 30),
        dailyWorkouts: [...dailyCounts.entries()].map(([date, count]) => ({ date, count })),
        weekdayDistribution: [
          { day: 'Seg', count: weekdayCounts[1] },
          { day: 'Ter', count: weekdayCounts[2] },
          { day: 'Qua', count: weekdayCounts[3] },
          { day: 'Qui', count: weekdayCounts[4] },
          { day: 'Sex', count: weekdayCounts[5] },
          { day: 'Sáb', count: weekdayCounts[6] },
          { day: 'Dom', count: weekdayCounts[0] }
        ]
      });
    },

    'GET /api/gym/students': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const sp = new URL(req.url || '', 'http://x').searchParams;
      const qCycle = Number(sp.get('routineCycleDays'));
      const routineCycleDays = Number.isFinite(qCycle) && qCycle >= 7 && qCycle <= 365
        ? Math.round(qCycle)
        : Number(ctx.tenant?.settings?.routineCycleDays || 30);
      const rawList = listStudents(db, ctx.stateStorageDir, {
        tenantId: ctx.tenantId,
        includeDisabled: true,
        churnDaysThreshold: ctx.tenant?.settings?.churnDaysThreshold || 5,
        routineCycleDays,
        stateOps,
        livePresence
      });
      const students = filterStudentsByPortfolio(ctx, rawList);
      json(res, 200, {
        ok: true,
        students,
        restrictedToPortfolio: isTrainerPortfolioRestricted(ctx)
      });
    },

    'GET /api/gym/student': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const sp = new URL(req.url || '', 'http://x').searchParams;
      const studentId = sp.get('id');
      if (!studentId) return json(res, 400, { error: 'Parâmetro id do aluno é obrigatório' });

      const target = requireTenantStudent(req, res, ctx, studentId, 'student-read');
      if (!target) return;

      const state = readStudentState(ctx.stateStorageDir, studentId, stateOps) || { routines: [], week: {}, workouts: [], bw: [] };
      const { byId } = getCatalogueIndex();

      // Enriquece nomes dos exercícios nas fichas do aluno usando o catálogo PT-BR
      const enrichedRoutines = (state.routines || []).map(r => ({
        ...r,
        ex: (r.ex || []).map(slot => {
          const cat = byId.get(slot.id);
          return {
            ...slot,
            name: slot.name || cat?.name || slot.id,
            bpLabel: cat?.bpLabel || '',
            eqLabel: cat?.eqLabel || '',
            thumb: cat ? `/exercise-media/still/${cat.id}.webp` : null
          };
        })
      }));

      // Enriquece treinos realizados (entries / ex) e recordes de carga (exWeights)
      const enrichedWorkouts = (state.workouts || []).slice(-30).reverse().map(w => {
        const rawEntries = Array.isArray(w.ex) ? w.ex : (Array.isArray(w.entries) ? w.entries : []);
        const enrichedEx = rawEntries.map(entry => {
          const cat = byId.get(entry?.id);
          return {
            ...entry,
            name: entry?.name || entry?.n || cat?.name || entry?.id || 'Exercício'
          };
        });
        const durSec = w.dur || (w.start && w.end ? Math.max(60, Math.round((Number(w.end) - Number(w.start)) / 1000)) : 0);
        return {
          ...w,
          dur: durSec,
          ex: enrichedEx
        };
      });

      const records = Object.entries(state.exWeights || {})
        .map(([exId, rec]) => {
          const wVal = typeof rec === 'object' ? Number(rec?.w || 0) : Number(rec || 0);
          const cat = byId.get(exId);
          return {
            id: exId,
            name: cat?.name || exId,
            bpLabel: cat?.bpLabel || '',
            weight: wVal,
            date: typeof rec === 'object' ? (rec?.d || null) : null
          };
        })
        .filter(r => r.weight > 0)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 20);

      const unifiedBw = normalizeBodyweightSeries(state);
      const bodyComparison = computeBodyComparison(state);
      const exerciseSeries = buildExerciseLoadHistory(state, id => byId.get(id)?.name || null).exercises;
      const formVideos = collectStudentFormVideos(state, id => byId.get(id)?.name || null, 40);
      const routineArchive = (Array.isArray(state.routineArchive) ? state.routineArchive : []).slice(-30).reverse();
      const weeklyStats = computeStudentWeeklyStats(state);

      json(res, 200, {
        ok: true,
        student: {
          id: target.id,
          name: target.name,
          email: target.email || '',
          phone: target.phone || '',
          goal: target.goal || '',
          notes: target.notes || '',
          assignedTrainerId: target.assignedTrainerId || null,
          disabled: Boolean(target.disabled),
          created: target.created || null,
          hasPassword: Boolean(target.pw?.h),
          inviteCode: target.inviteCode || null,
          welcomeWhatsapp: target.welcomeWhatsapp || null,
          onboardedAt: target.onboardedAt || null
        },
        state: {
          routines: enrichedRoutines,
          week: state.week || {},
          workouts: enrichedWorkouts,
          bw: unifiedBw.slice(-60),
          records,
          measurements: Array.isArray(state.measurements) ? state.measurements.slice(-30) : [],
          assessments: Array.isArray(state.assessments) ? state.assessments.slice(-30) : [],
          bodyComparison,
          routineArchive,
          exerciseSeries,
          formVideos,
          weeklyStats
        }
      });
    },

    'POST /api/gym/students': (req, res) => withIdempotency(
      req,
      res,
      {
        routeKey: 'POST /api/gym/students',
        authFn: (rq, rs) => {
          const c = requireGymContext(rq, rs);
          if (!c) return null;
          return { ...c, id: c.user?.id || c.tenantId || 'staff' };
        }
      },
      async ({ actor: ctx, body, replyJson }) => {
        const name = String(body?.name || '').trim().slice(0, 60);
        if (!name) return replyJson(res, 400, { error: 'O nome do aluno é obrigatório' });

        const email = body?.email ? normalizeEmail(body.email) : null;
        if (body?.email && !email) return replyJson(res, 400, { error: 'E-mail do aluno inválido' });

        const suppliedStuPw = body?.password !== undefined && String(body.password).trim() !== ''
          ? String(body.password)
          : null;
        if (suppliedStuPw !== null) {
          const pwErr = b2bPasswordError(suppliedStuPw, name);
          if (pwErr) return replyJson(res, 400, pwErr);
        }
        const rawPassword = suppliedStuPw || generateTempPassword();

        // Pre-check rápido antes de gastar CPU com hash
        const maxStudents = ctx.tenant?.limits?.maxStudents || 99999;
        if (email && db.users.some(u => u.email === email)) {
          return replyJson(res, 409, { error: 'Já existe um usuário cadastrado com este e-mail' });
        }
        const rawAssigned = body?.assignedTrainerId;
        let resolvedAssignedTrainerId = isActiveTenantStaff(ctx.user, ctx.tenantId) ? ctx.user.id : null;
        if (isTrainerPortfolioRestricted(ctx)) {
          resolvedAssignedTrainerId = ctx.user.id;
        } else if (rawAssigned !== undefined && rawAssigned !== null && !(typeof rawAssigned === 'string' && rawAssigned.trim() === '')) {
          const trainerCheck = validateAssignedTrainer(rawAssigned, ctx.tenantId);
          if (!trainerCheck.ok) {
            if (trainerCheck.crossTenant) {
              audit(req, 'gym.denied', { ok: false, user: ctx.user, target: trainerCheck.staff, msg: 'cross-tenant-assigned-trainer' });
            }
            return replyJson(res, 400, { error: trainerCheck.error, code: trainerCheck.code });
          }
          resolvedAssignedTrainerId = trainerCheck.assignedTrainerId;
        }
        const foldedName = nameKey(name);

        const h = await hashPassword(rawPassword);
        const nowIso = new Date().toISOString();
        const phoneRaw = String(body?.phone || '').trim().slice(0, 30);
        const student = {
          id: 'u_st_' + crypto.randomBytes(8).toString('base64url'),
          name,
          ...(email ? { email } : {}),
          phone: phoneRaw,
          goal: String(body?.goal || '').trim().slice(0, 80),
          notes: String(body?.notes || '').trim().slice(0, 300),
          assignedTrainerId: resolvedAssignedTrainerId,
          tenantId: ctx.tenantId,
          saasRole: 'student',
          role: 'student',
          created: nowIso,
          pw: { h, set: nowIso }
        };

        const publicAppUrl = resolvePublicAppUrl();
        let createdInvite;
        let signupUrl;

        try {
          const mut = runDbMutation(() => {
            const freshTenant = getTenant(dataDir, ctx.tenantId) || ctx.tenant;
            const limit = freshTenant?.limits?.maxStudents || maxStudents;
            const activeCount = db.users.filter(
              u => u.tenantId === ctx.tenantId && isStudentAccount(u) && !u.disabled
            ).length;
            if (activeCount >= limit) {
              const err = new Error(`Limite do plano atingido (${limit} alunos ativos). Faça upgrade do plano da academia.`);
              err.httpStatus = 403;
              err.code = 'plan-limit';
              throw err;
            }
            if (resolvedAssignedTrainerId) {
              const freshTrainerCheck = validateAssignedTrainer(resolvedAssignedTrainerId, ctx.tenantId, db.users);
              if (!freshTrainerCheck.ok) {
                const err = new Error(freshTrainerCheck.error);
                err.httpStatus = 400;
                err.code = freshTrainerCheck.code;
                throw err;
              }
            }
            if (email && db.users.some(u => u.email === email)) {
              const err = new Error('Já existe um usuário cadastrado com este e-mail');
              err.httpStatus = 409;
              throw err;
            }
            if (!email && db.users.some(u => (u.tenantId || 'default') === ctx.tenantId && u.pw?.h && nameKey(u.name) === foldedName)) {
              const err = new Error('Já existe um aluno homônimo nesta unidade. Informe o e-mail de login (ou sobrenome) para evitar conflito de acesso.');
              err.httpStatus = 409;
              throw err;
            }
            const inv = issueStudentInvite({
              tenantId: ctx.tenantId,
              student,
              createdBy: ctx.user.id,
              reusePending: true
            });
            const url = buildStudentInviteSignupUrl({
              appUrl: publicAppUrl,
              tenantId: ctx.tenantId,
              inviteCode: inv.code
            });
            const cleanPh = cleanWhatsAppPhone(student.phone);
            student.welcomeWhatsapp = {
              status: !cleanPh || body?.sendWelcome === false ? 'skipped' : 'pending',
              sent: false,
              queued: false,
              outboxId: null,
              error: !cleanPh && student.phone ? 'Telefone inválido para WhatsApp' : null,
              inviteCode: inv.code,
              signupUrl: url,
              updatedAt: nowIso
            };
            if (hasSqliteDir) upsertUserSqlite(dataDir, student, null);
            db.users.push(student);
            saveDb();
            return { inv, url };
          });
          createdInvite = mut.inv;
          signupUrl = mut.url;
        } catch (err) {
          if (err?.httpStatus) return replyJson(res, err.httpStatus, { error: err.message, ...(err.code ? { code: err.code } : {}) });
          if (isSqliteUniqueConstraintError(err)) {
            return replyJson(res, 409, {
              error: email
                ? 'Já existe um usuário cadastrado com este e-mail ou nome de acesso'
                : 'Já existe um aluno homônimo nesta unidade. Informe o e-mail de login (ou sobrenome) para evitar conflito de acesso.'
            });
          }
          throw err;
        }

        // Se foi selecionado um modelo de ficha inicial na matrícula, já prescreve automaticamente!
        if (body?.initialTemplateId) {
          const templates = loadTemplates(ctx.tenantDir, { seedIfMissing: true });
          const tpl = templates.find(t => t.id === body.initialTemplateId);
          if (tpl) {
            prescribeRoutineToStudent(ctx.stateStorageDir, student.id, {
              routine: tpl,
              days: Array.isArray(tpl.suggestedDays) && tpl.suggestedDays.length ? tpl.suggestedDays : [1, 3, 5],
              trainerUser: ctx.user
            }, stateOps);
          }
        }

        // Disparo isolado da saudação com link de cadastro e código de convite no WhatsApp
        // Nunca faz rollback da matrícula em caso de queda ou indisponibilidade da Evolution API.
        const cleanStuPhone = cleanWhatsAppPhone(student.phone);
        if (cleanStuPhone && body?.sendWelcome !== false) {
          try {
            const waPromise = notifyStudentWelcomeInvite({
              dataDir,
              tenantId: ctx.tenantId,
              student,
              inviteCode: createdInvite.code,
              signupUrl,
              trainerUser: ctx.user,
              tenant: ctx.tenant,
              appUrl: publicAppUrl
            });
            if (body?.awaitWelcome === false) {
              waPromise
                .then(waRes => {
                  try {
                    runDbMutation(() => {
                      student.welcomeWhatsapp = {
                        status: waRes?.status || 'failed',
                        sent: Boolean(waRes?.ok && !waRes?.skipped),
                        queued: Boolean(waRes?.queued),
                        outboxId: waRes?.id || null,
                        error: waRes?.error || waRes?.reason || null,
                        inviteCode: createdInvite.code,
                        signupUrl,
                        updatedAt: new Date().toISOString()
                      };
                      if (hasSqliteDir) upsertUserSqlite(dataDir, student, null);
                      saveDb();
                    });
                  } catch { /* ignore */ }
                })
                .catch(() => { });
            } else {
              const waRes = await waPromise;
              runDbMutation(() => {
                student.welcomeWhatsapp = {
                  status: waRes?.status || 'failed',
                  sent: Boolean(waRes?.ok && !waRes?.skipped),
                  queued: Boolean(waRes?.queued),
                  outboxId: waRes?.id || null,
                  error: waRes?.error || waRes?.reason || null,
                  inviteCode: createdInvite.code,
                  signupUrl,
                  updatedAt: new Date().toISOString()
                };
                if (hasSqliteDir) upsertUserSqlite(dataDir, student, null);
                saveDb();
              });
            }
          } catch (waErr) {
            try {
              runDbMutation(() => {
                student.welcomeWhatsapp = {
                  status: 'failed',
                  sent: false,
                  queued: false,
                  outboxId: null,
                  error: waErr?.message || 'Falha ao enviar mensagem de boas-vindas',
                  inviteCode: createdInvite.code,
                  signupUrl,
                  updatedAt: new Date().toISOString()
                };
                if (hasSqliteDir) upsertUserSqlite(dataDir, student, null);
                saveDb();
              });
            } catch { /* ignore */ }
          }
        }

        audit(req, 'gym.student.create', { user: ctx.user, target: student, msg: ctx.tenantId });
        replyJson(res, 201, {
          ok: true,
          student: toStudentDto(student),
          initialPassword: rawPassword,
          invite: {
            code: createdInvite.code,
            url: signupUrl,
            expiresAt: createdInvite.expiresAt
          },
          whatsapp: student.welcomeWhatsapp
        });
      }
    ),

    'POST /api/gym/students/welcome-resend': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      const studentId = String(body?.studentId || '').trim();
      if (!studentId) return json(res, 400, { error: 'studentId é obrigatório' });

      const target = requireTenantStudent(req, res, ctx, studentId, 'student-welcome-resend');
      if (!target) return;

      const cleanStuPhone = cleanWhatsAppPhone(target.phone);
      if (!cleanStuPhone) {
        return json(res, 400, { error: 'Aluno sem número de WhatsApp válido cadastrado' });
      }

      const publicAppUrl = resolvePublicAppUrl();
      const { inv, url } = runDbMutation(() => {
        const nextInv = issueStudentInvite({
          tenantId: ctx.tenantId,
          student: target,
          createdBy: ctx.user.id,
          reusePending: !body?.regenerateInvite
        });
        const builtUrl = buildStudentInviteSignupUrl({
          appUrl: publicAppUrl,
          tenantId: ctx.tenantId,
          inviteCode: nextInv.code
        });
        if (hasSqliteDir) upsertUserSqlite(dataDir, target, null);
        saveDb();
        return { inv: nextInv, url: builtUrl };
      });

      let waRes;
      try {
        waRes = await notifyStudentWelcomeInvite({
          dataDir,
          tenantId: ctx.tenantId,
          student: target,
          inviteCode: inv.code,
          signupUrl: url,
          trainerUser: ctx.user,
          tenant: ctx.tenant,
          appUrl: publicAppUrl,
          force: true
        });
      } catch (err) {
        waRes = {
          ok: false,
          queued: false,
          status: 'failed',
          error: err?.message || 'Falha no reenvio pelo WhatsApp'
        };
      }

      runDbMutation(() => {
        target.welcomeWhatsapp = {
          status: waRes?.status || 'failed',
          sent: Boolean(waRes?.ok && !waRes?.skipped),
          queued: Boolean(waRes?.queued),
          outboxId: waRes?.id || null,
          error: waRes?.error || waRes?.reason || null,
          inviteCode: inv.code,
          signupUrl: url,
          updatedAt: new Date().toISOString()
        };
        if (hasSqliteDir) upsertUserSqlite(dataDir, target, null);
        saveDb();
      });

      audit(req, 'gym.student.welcome_resend', { user: ctx.user, target, msg: inv.code });
      json(res, 200, {
        ok: true,
        invite: { code: inv.code, url, expiresAt: inv.expiresAt },
        whatsapp: target.welcomeWhatsapp
      });
    },

    'PUT /api/gym/students': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      let target;
      try {
        target = runDbMutation(() => {
          const found = db.users.find(u => u.id === body?.id && (ctx.superUser && ctx.tenantId === 'default' ? true : u.tenantId === ctx.tenantId));
          if (!found) return { errorStatus: 404, error: 'Aluno não encontrado nesta academia' };
          if (!isStudentAccount(found)) {
            return {
              errorStatus: 403,
              denied: true,
              found,
              denyMsg: 'student-update-on-staff',
              code: 'non-student-target',
              error: 'Contas de professores ou gestores devem ser gerenciadas pela aba Equipe.'
            };
          }
          if (isTrainerPortfolioRestricted(ctx) && found.assignedTrainerId !== ctx.user?.id) {
            return {
              errorStatus: 403,
              denied: true,
              found,
              denyMsg: 'student-update:trainer-scope-restricted',
              code: 'trainer-scope-restricted',
              error: 'Acesso restrito aos alunos da sua carteira neste modo de equipe.'
            };
          }
          if (body.email !== undefined && body.email) {
            const norm = normalizeEmail(body.email);
            if (!norm) return { errorStatus: 400, error: 'E-mail inválido' };
            if (db.users.some(u => u.id !== found.id && u.email === norm)) {
              return { errorStatus: 409, error: 'Este e-mail já está em uso' };
            }
          }

          let nextAssignedTrainerId;
          if (body.assignedTrainerId !== undefined && !isTrainerPortfolioRestricted(ctx)) {
            const trainerCheck = validateAssignedTrainer(body.assignedTrainerId, ctx.tenantId, db.users);
            if (!trainerCheck.ok) {
              return {
                errorStatus: 400,
                denied: trainerCheck.crossTenant,
                found: trainerCheck.staff,
                denyMsg: 'cross-tenant-assigned-trainer',
                code: trainerCheck.code,
                error: trainerCheck.error
              };
            }
            nextAssignedTrainerId = trainerCheck.assignedTrainerId;
          }

          if (body.disabled === false && Boolean(found.disabled)) {
            const freshTenant = getTenant(dataDir, ctx.tenantId) || ctx.tenant;
            const limit = freshTenant?.limits?.maxStudents;
            if (limit) {
              const activeCount = db.users.filter(
                u => u.id !== found.id && u.tenantId === ctx.tenantId && isStudentAccount(u) && !u.disabled
              ).length;
              if (activeCount >= limit) {
                return {
                  errorStatus: 403,
                  code: 'plan-limit',
                  error: `Limite do plano atingido (${limit} alunos ativos). Faça upgrade do plano da academia antes de reativar este aluno.`
                };
              }
            }
          }

          const prev = { ...found };
          if (body.name !== undefined) found.name = String(body.name).trim().slice(0, 60) || found.name;
          if (body.phone !== undefined) found.phone = String(body.phone).trim().slice(0, 30);
          if (body.goal !== undefined) found.goal = String(body.goal).trim().slice(0, 80);
          if (body.notes !== undefined) found.notes = String(body.notes).trim().slice(0, 300);
          if (body.assignedTrainerId !== undefined && nextAssignedTrainerId !== undefined) {
            found.assignedTrainerId = nextAssignedTrainerId;
          }
          if (body.email !== undefined) {
            if (!body.email) delete found.email;
            else found.email = normalizeEmail(body.email);
          }
          if (typeof body.disabled === 'boolean') {
            if (body.disabled) {
              if (!found.disabled) found.sv = (Number(found.sv) || 0) + 1;
              found.disabled = true;
              delete found.pwReset;
              const nowRevIso = new Date().toISOString();
              for (const inv of (db.invites || [])) {
                if (inv && inv.tenantId === ctx.tenantId && inv.studentId === found.id && !inv.usedBy && !inv.revoked) {
                  inv.revoked = true;
                  inv.revokedAt = nowRevIso;
                  if (hasSqliteDir) upsertInviteSqlite(dataDir, inv, null);
                }
              }
            } else {
              delete found.disabled;
            }
          }

          try {
            if (hasSqliteDir) upsertUserSqlite(dataDir, found, null);
          } catch (sqliteErr) {
            Object.assign(found, prev);
            if (!('email' in prev)) delete found.email;
            if (!('disabled' in prev)) delete found.disabled;
            if (!('sv' in prev)) delete found.sv;
            if (!('pwReset' in prev)) delete found.pwReset;
            throw sqliteErr;
          }
          saveDb();
          return { found, justDisabled: body.disabled === true };
        });
      } catch (err) {
        if (isSqliteUniqueConstraintError(err)) {
          return json(res, 409, { error: 'Este e-mail ou nome de acesso já está em uso' });
        }
        throw err;
      }

      if (target.denied) {
        audit(req, 'gym.denied', { ok: false, user: ctx.user, target: target.found, msg: target.denyMsg || 'student-update-denied' });
      }
      if (target.errorStatus) {
        return json(res, target.errorStatus, {
          error: target.error,
          ...(target.code ? { code: target.code } : {})
        });
      }
      if (target.justDisabled && onUserDisabled) {
        try { onUserDisabled(target.found); } catch { /* ignore */ }
      }

      audit(req, 'gym.student.update', { user: ctx.user, target: target.found });
      json(res, 200, { ok: true, id: target.found.id });
    },

    'POST /api/gym/students/password': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      const target = requireTenantStudent(req, res, ctx, body?.id, 'student-password');
      if (!target) return;

      if (body?.mode === 'reset-code') {
        const code = makeResetCode();
        const exp = Date.now() + RESET_TTL_MS;
        const resetOutcome = runDbMutation(() => {
          const fresh = db.users.find(u => u.id === target.id && u.tenantId === target.tenantId);
          if (!fresh || !isStudentAccount(fresh)) return { errorStatus: 403, error: 'Operação permitida apenas para contas de aluno.', code: 'non-student-target' };
          fresh.pwReset = { h: hashResetCode(code), exp, by: ctx.user.id };
          if (hasSqliteDir) upsertUserSqlite(dataDir, fresh, null);
          saveDb();
          return { ok: true };
        });
        if (resetOutcome.errorStatus) {
          return json(res, resetOutcome.errorStatus, { error: resetOutcome.error, ...(resetOutcome.code ? { code: resetOutcome.code } : {}) });
        }
        audit(req, 'gym.student.reset-code', { user: ctx.user, target });
        return json(res, 200, { ok: true, code, expires: exp });
      }

      const newPw = String(body?.password || '');
      const pwErr = b2bPasswordError(newPw, target.name);
      if (pwErr) return json(res, 400, pwErr);
      const h = await hashPassword(newPw);
      const pwOutcome = runDbMutation(() => {
        const fresh = db.users.find(u => u.id === target.id && u.tenantId === target.tenantId);
        if (!fresh || !isStudentAccount(fresh)) return { errorStatus: 403, error: 'Operação permitida apenas para contas de aluno.', code: 'non-student-target' };
        fresh.pw = { h, set: new Date().toISOString() };
        delete fresh.pwReset;
        fresh.sv = (fresh.sv || 0) + 1;
        if (hasSqliteDir) upsertUserSqlite(dataDir, fresh, null);
        saveDb();
        return { ok: true };
      });
      if (pwOutcome.errorStatus) {
        return json(res, pwOutcome.errorStatus, { error: pwOutcome.error, ...(pwOutcome.code ? { code: pwOutcome.code } : {}) });
      }
      audit(req, 'gym.student.password', { user: ctx.user, target });
      json(res, 200, { ok: true });
    },

    'DELETE /api/gym/students': async (req, res) => {
      const ctx = requireGymContext(req, res, { managerOnly: true });
      if (!ctx) return;
      const body = await readBody(req).catch(() => ({}));
      const sp = new URL(req.url || '', 'http://x').searchParams;
      const studentId = body?.id || sp.get('id');
      const result = runDbMutation(() => {
        const target = db.users.find(u => u.id === studentId && u.tenantId === ctx.tenantId);
        if (!target) return { errorStatus: 404, error: 'Aluno não encontrado nesta academia' };
        if (!isStudentAccount(target)) {
          return { errorStatus: 403, denied: true, target, code: 'non-student-target', error: 'Use a tela de Equipe para remover membros da equipe' };
        }
        if (removeAccount) removeAccount(target);
        else {
          db.users = db.users.filter(u => u.id !== target.id);
          if (hasSqliteDir) deleteUserSqlite(dataDir, target.id, null);
          saveDb();
        }
        return { target };
      });
      if (result.denied) {
        audit(req, 'gym.denied', { ok: false, user: ctx.user, target: result.target, msg: 'student-delete-on-non-student' });
      }
      if (result.errorStatus) {
        return json(res, result.errorStatus, {
          error: result.error,
          ...(result.code ? { code: result.code } : {})
        });
      }
      audit(req, 'gym.student.delete', { user: ctx.user, msg: result.target.name });
      json(res, 200, { ok: true });
    },

    /* ---------- Equipe & Professores da Academia ---------- */
    'GET /api/gym/team': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;

      const staff = db.users.filter(
        u => u.tenantId === ctx.tenantId && (u.saasRole === 'gym_owner' || u.saasRole === 'gym_manager' || u.saasRole === 'trainer' || u.role === 'trainer')
      );
      const students = db.users.filter(u => u.tenantId === ctx.tenantId && (!u.saasRole || u.saasRole === 'student') && u.role !== 'trainer');

      const members = staff.map(u => {
        const assignedCount = students.filter(s => s.assignedTrainerId === u.id).length;
        return {
          id: u.id,
          name: u.name,
          email: u.email || '',
          phone: u.phone || '',
          cref: u.cref || '',
          specialty: u.specialty || '',
          saasRole: u.saasRole || 'trainer',
          disabled: Boolean(u.disabled),
          created: u.created || null,
          assignedStudents: assignedCount
        };
      });

      json(res, 200, { ok: true, team: members, maxTrainers: ctx.tenant?.limits?.maxTrainers || 10 });
    },

    'POST /api/gym/team': async (req, res) => {
      const ctx = requireGymContext(req, res, { managerOnly: true });
      if (!ctx) return;
      const body = await readBody(req);
      const name = String(body?.name || '').trim().slice(0, 60);
      const email = normalizeEmail(body?.email || '');
      const suppliedPw = body?.password !== undefined && String(body.password).trim() !== ''
        ? String(body.password)
        : null;
      const saasRole = body?.saasRole === 'gym_manager' ? 'gym_manager' : 'trainer';

      if (!name || !email) return json(res, 400, { error: 'Nome e e-mail válido do profissional são obrigatórios' });
      if (suppliedPw !== null) {
        const pwErr = b2bPasswordError(suppliedPw, name);
        if (pwErr) return json(res, 400, pwErr);
      }
      const rawPw = suppliedPw || generateTempPassword();
      if (db.users.some(u => u.email === email)) {
        return json(res, 409, { error: 'Já existe um usuário com este e-mail' });
      }

      const maxTrainers = ctx.tenant?.limits?.maxTrainers || 999;
      const h = await hashPassword(rawPw);
      const nowIso = new Date().toISOString();
      const member = {
        id: 'u_tr_' + crypto.randomBytes(6).toString('base64url'),
        name,
        email,
        phone: String(body?.phone || '').trim().slice(0, 30),
        cref: String(body?.cref || '').trim().slice(0, 30),
        specialty: String(body?.specialty || '').trim().slice(0, 80),
        tenantId: ctx.tenantId,
        saasRole,
        role: 'trainer',
        created: nowIso,
        pw: { h, set: nowIso }
      };

      try {
        runDbMutation(() => {
          const freshTenant = getTenant(dataDir, ctx.tenantId) || ctx.tenant;
          const limit = freshTenant?.limits?.maxTrainers || maxTrainers;
          const activeTrainers = db.users.filter(
            u => u.tenantId === ctx.tenantId && !isSuperAdmin(u) && (u.saasRole === 'trainer' || u.saasRole === 'gym_manager' || u.saasRole === 'gym_owner' || u.role === 'trainer') && !u.disabled
          ).length;
          if (activeTrainers >= limit) {
            const err = new Error(`Limite de profissionais do plano atingido (${limit}). Faça upgrade do plano.`);
            err.httpStatus = 403;
            err.code = 'plan-limit';
            throw err;
          }
          if (db.users.some(u => u.email === email)) {
            const err = new Error('Já existe um usuário com este e-mail');
            err.httpStatus = 409;
            throw err;
          }
          if (hasSqliteDir) upsertUserSqlite(dataDir, member, null);
          db.users.push(member);
          saveDb();
        });
      } catch (err) {
        if (err?.httpStatus) return json(res, err.httpStatus, { error: err.message, ...(err.code ? { code: err.code } : {}) });
        if (isSqliteUniqueConstraintError(err)) {
          return json(res, 409, { error: 'Já existe um usuário com este e-mail ou nome de acesso' });
        }
        throw err;
      }

      audit(req, 'gym.team.create', { user: ctx.user, target: member });
      json(res, 201, {
        ok: true,
        member: { id: member.id, name: member.name, email: member.email, saasRole: member.saasRole },
        ...(!suppliedPw ? { initialPassword: rawPw } : {})
      });
    },

    'PUT /api/gym/team': async (req, res) => {
      const ctx = requireGymContext(req, res, { managerOnly: true });
      if (!ctx) return;
      const body = await readBody(req);
      let hashedPw = null;
      if (body?.password !== undefined && String(body.password) !== '') {
        const pwErr = b2bPasswordError(String(body.password), String(body.name || ''));
        if (pwErr) return json(res, 400, pwErr);
        hashedPw = await hashPassword(String(body.password));
      }

      let outcome;
      try {
        outcome = runDbMutation(() => {
          const target = db.users.find(u => u.id === body?.id && u.tenantId === ctx.tenantId && isTrainerOrAdmin(u) && !isSuperAdmin(u));
          if (!target) return { errorStatus: 404, error: 'Profissional não encontrado nesta academia' };
          if (target.saasRole === 'gym_owner' && !ctx.superUser && ctx.user.id !== target.id && ctx.user.saasRole !== 'gym_owner' && !ctx.user.owner) {
            return { errorStatus: 403, denied: true, target, error: 'Somente o proprietário principal ou o administrador da plataforma pode alterar os dados do proprietário.' };
          }
          if (hashedPw) {
            const targetPwErr = b2bPasswordError(String(body.password), String(body.name || target.name || ''));
            if (targetPwErr) return { errorStatus: 400, error: targetPwErr.error, code: targetPwErr.code };
          }
          if (body.disabled === false && Boolean(target.disabled) && target.saasRole !== 'gym_owner') {
            const freshTenant = getTenant(dataDir, ctx.tenantId) || ctx.tenant;
            const limit = freshTenant?.limits?.maxTrainers || 999;
            const activeTrainers = db.users.filter(
              u => u.id !== target.id &&
                u.tenantId === ctx.tenantId &&
                !isSuperAdmin(u) &&
                (u.saasRole === 'trainer' || u.saasRole === 'gym_manager' || u.saasRole === 'gym_owner' || u.role === 'trainer') &&
                !u.disabled
            ).length;
            if (activeTrainers >= limit) {
              return {
                errorStatus: 403,
                code: 'plan-limit',
                error: `Limite de profissionais do plano atingido (${limit}). Faça upgrade do plano antes de reativar este acesso.`
              };
            }
          }

          const prev = { ...target };
          if (body.name !== undefined) target.name = String(body.name).trim() || target.name;
          if (body.phone !== undefined) target.phone = String(body.phone).trim();
          if (body.cref !== undefined) target.cref = String(body.cref).trim();
          if (body.specialty !== undefined) target.specialty = String(body.specialty).trim();
          if (body.saasRole && ['trainer', 'gym_manager'].includes(body.saasRole) && target.saasRole !== 'gym_owner') {
            target.saasRole = body.saasRole;
          }
          if (typeof body.disabled === 'boolean' && target.saasRole !== 'gym_owner') {
            if (body.disabled) {
              if (!target.disabled) target.sv = (Number(target.sv) || 0) + 1;
              target.disabled = true;
              delete target.pwReset;
            } else {
              delete target.disabled;
            }
          }
          if (hashedPw) {
            target.pw = { h: hashedPw, set: new Date().toISOString() };
            target.sv = (target.sv || 0) + 1;
          }

          try {
            if (hasSqliteDir) upsertUserSqlite(dataDir, target, null);
          } catch (sqliteErr) {
            Object.assign(target, prev);
            if (!('disabled' in prev)) delete target.disabled;
            if (!('sv' in prev)) delete target.sv;
            if (!('pwReset' in prev)) delete target.pwReset;
            throw sqliteErr;
          }
          saveDb();
          return { target, justDisabled: body.disabled === true && target.saasRole !== 'gym_owner' };
        });
      } catch (err) {
        if (isSqliteUniqueConstraintError(err)) {
          return json(res, 409, { error: 'Nome de acesso ou e-mail já em uso nesta academia' });
        }
        throw err;
      }

      if (outcome.denied) {
        audit(req, 'gym.denied', { ok: false, user: ctx.user, target: outcome.target, msg: 'manager-edit-owner' });
      }
      if (outcome.errorStatus) {
        return json(res, outcome.errorStatus, {
          error: outcome.error,
          ...(outcome.code ? { code: outcome.code } : {})
        });
      }
      if (outcome.justDisabled && onUserDisabled) {
        try { onUserDisabled(outcome.target); } catch { /* ignore */ }
      }

      audit(req, 'gym.team.update', { user: ctx.user, target: outcome.target });
      json(res, 200, { ok: true });
    },

    'DELETE /api/gym/team': async (req, res) => {
      const ctx = requireGymContext(req, res, { managerOnly: true });
      if (!ctx) return;
      const body = await readBody(req).catch(() => ({}));
      const sp = new URL(req.url || '', 'http://x').searchParams;
      const memberId = body?.id || sp.get('id');
      const outcome = runDbMutation(() => {
        const target = db.users.find(u => u.id === memberId && u.tenantId === ctx.tenantId && isTrainerOrAdmin(u) && !isSuperAdmin(u));
        if (!target) return { errorStatus: 404, error: 'Profissional não encontrado' };
        if (target.saasRole === 'gym_owner') return { errorStatus: 400, error: 'O proprietário principal da academia não pode ser removido por aqui' };

        if (removeAccount) removeAccount(target);
        else {
          db.users = db.users.filter(u => u.id !== target.id);
          if (hasSqliteDir) deleteUserSqlite(dataDir, target.id, null);
        }
        saveDb();
        return { target };
      });
      if (outcome.errorStatus) {
        return json(res, outcome.errorStatus, {
          error: outcome.error,
          ...(outcome.code ? { code: outcome.code } : {})
        });
      }
      audit(req, 'gym.team.delete', { user: ctx.user, msg: outcome.target.name });
      json(res, 200, { ok: true });
    },

    /* ---------- Prescrição de Treinos & Agenda Semanal ---------- */
    'POST /api/gym/prescribe': (req, res) => withIdempotency(
      req,
      res,
      {
        routeKey: 'POST /api/gym/prescribe',
        authFn: (rq, rs) => {
          const c = requireGymContext(rq, rs);
          if (!c) return null;
          return { ...c, id: c.user?.id || c.tenantId || 'staff' };
        }
      },
      async ({ actor: ctx, body, replyJson }) => {
        const { studentId, routine, routines, day, days, replaceSchedule, archivePrevious, replaceAll } = body || {};
        const hasBatch = Array.isArray(routines) && routines.length > 0;

        if (!studentId || (!hasBatch && (!routine || !routine.name || !Array.isArray(routine.ex)))) {
          return replyJson(res, 400, { error: 'Informe o aluno, o nome da ficha e ao menos um exercício' });
        }

        if (hasBatch) {
          for (const item of routines) {
            const rItem = item?.routine || item;
            if (!rItem || !String(rItem.name || '').trim() || !Array.isArray(rItem.ex)) {
              return replyJson(res, 400, { error: 'Todas as fichas do lote precisam ter nome e lista de exercícios válidos' });
            }
          }
        }

        const target = requireTenantStudent(req, res, ctx, studentId, 'prescribe');
        if (!target) return;

        let prescribedList = [];
        let prescriptionNotice = null;
        if (hasBatch) {
          const batchRes = prescribeRoutinesBatchToStudent(ctx.stateStorageDir, studentId, {
            routines,
            archivePrevious: Boolean(archivePrevious),
            replaceAll: Boolean(replaceAll),
            trainerUser: ctx.user
          }, stateOps);
          prescribedList = batchRes.routines || [];
          prescriptionNotice = batchRes.prescriptionNotice || null;
        } else {
          const single = prescribeRoutineToStudent(ctx.stateStorageDir, studentId, {
            routine,
            day,
            days,
            replaceSchedule: Boolean(replaceSchedule),
            archivePrevious: Boolean(archivePrevious),
            trainerUser: ctx.user
          }, stateOps);
          prescribedList = [single];
          prescriptionNotice = readStudentState(ctx.stateStorageDir, studentId, stateOps)?.prescriptionNotice || null;
        }

        const lastPrescribed = prescribedList[prescribedList.length - 1] || null;
        let waResult = { skipped: true };
        let pushSent = false;

        if (body?.notifyWhatsApp !== false && prescribedList.length > 0) {
          const fullState = readStudentState(ctx.stateStorageDir, studentId, stateOps) || { routines: prescribedList, week: {} };
          const allPrescribed = Array.isArray(fullState.routines)
            ? fullState.routines.filter(r => r?.prescribedBy)
            : [];
          const routinesToNotify = allPrescribed.length > 0 ? allPrescribed : prescribedList;

          const pushDigest = crypto
            .createHash('sha256')
            .update(JSON.stringify(routinesToNotify.map(r => ({
              id: r.id,
              name: r.name,
              ex: (r.ex || []).map(e => [e.id, e.sets, e.reps, e.weight, e.restSec, e.note || '']),
              days: Object.entries(fullState.week || {}).filter(([, ids]) => [].concat(ids || []).includes(r.id)).map(([d]) => d)
            }))))
            .digest('hex');

          if (typeof sendPush === 'function') {
            const pushKey = `${ctx.tenantId}:${studentId}`;
            const nowPush = Date.now();
            const prevPush = recentPrescriptionPushByStudent.get(pushKey);
            const isRecentDupPush = prevPush && prevPush.hash === pushDigest && (nowPush - prevPush.at) < 10 * 60 * 1000;
            if (!isRecentDupPush) {
              if (recentPrescriptionPushByStudent.size > 5000) recentPrescriptionPushByStudent.clear();
              recentPrescriptionPushByStudent.set(pushKey, { hash: pushDigest, at: nowPush });
              const pushPayload = prescriptionPush(fullState.lang || 'pt-BR', {
                trainerName: ctx.user?.name || '',
                tenantName: ctx.tenant?.name || '',
                routines: routinesToNotify
              });
              pushSent = true;
              try {
                Promise.resolve(sendPush(studentId, pushPayload)).catch(() => { });
              } catch { /* ignore */ }
            }
          }

          if (target?.phone) {
            const waPromise = notifyRoutinePrescribed({
              dataDir,
              tenantId: ctx.tenantId,
              student: target,
              routines: routinesToNotify,
              week: fullState.week || {},
              trainerUser: ctx.user,
              tenant: ctx.tenant
            });
            if (body?.awaitNotify) {
              waResult = await waPromise.catch(err => ({ ok: false, error: err?.message }));
            } else {
              waPromise.catch(() => { });
            }
          }
        }

        const auditMsg = prescribedList.map(r => r.name).join(', ').slice(0, 120);
        audit(req, 'gym.prescribe', { user: ctx.user, target, msg: auditMsg });
        replyJson(res, 200, {
          ok: true,
          routine: lastPrescribed,
          routines: prescribedList,
          prescriptionNotice,
          pushSent,
          ...(body?.awaitNotify ? {
            whatsapp: {
              sent: Boolean(waResult?.ok && !waResult?.skipped),
              queued: Boolean(waResult?.queued),
              deduplicated: Boolean(waResult?.deduplicated),
              partCount: waResult?.partCount || 0,
              pdfFileName: waResult?.pdfFileName || null,
              messages: waResult?.messages || []
            }
          } : {})
        });
      }
    ),

    'POST /api/gym/student/routine/delete': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      const { studentId, routineId } = body || {};
      if (!studentId || !routineId) return json(res, 400, { error: 'studentId e routineId são obrigatórios' });

      const target = requireTenantStudent(req, res, ctx, studentId, 'routine-delete');
      if (!target) return;

      removeStudentRoutine(ctx.stateStorageDir, studentId, routineId, stateOps);
      audit(req, 'gym.routine.delete', { user: ctx.user, target, msg: routineId });
      json(res, 200, { ok: true });
    },

    'POST /api/gym/student/week': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      const { studentId, week } = body || {};
      if (!studentId || !week || typeof week !== 'object') return json(res, 400, { error: 'studentId e week são obrigatórios' });

      const target = requireTenantStudent(req, res, ctx, studentId, 'student-week');
      if (!target) return;

      const updatedWeek = updateStudentWeekSchedule(ctx.stateStorageDir, studentId, week, stateOps);
      json(res, 200, { ok: true, week: updatedWeek });
    },

    /* ---------- Mídia & Exercícios Customizados da Academia / Personal ---------- */
    'POST /api/gym/media/missing': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      if (!mediaStore) return json(res, 404, { error: 'uploads de mídia desabilitados no servidor' });
      const body = await readBody(req);
      const hashes = body?.hashes;
      if (!Array.isArray(hashes) || hashes.length > 1000 || !hashes.every(h => typeof h === 'string' && HASH_RE.test(h))) {
        throw new MediaError(400, 'bad-request', { error: 'hashes deve ser uma lista com até 1000 sha256 hexadecimais minúsculos' });
      }
      json(res, 200, mediaStore.missing(tenantMediaBucket(ctx.tenantId), hashes));
    },

    'PUT /api/gym/media/{hash}': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) { mediaStore?.discard?.(req); return; }
      if (!mediaStore) { mediaStore?.discard?.(req); return json(res, 404, { error: 'uploads de mídia desabilitados no servidor' }); }
      if (mediaThrottleFn && mediaBurst) {
        try { mediaThrottleFn(req, ctx.user, mediaBurst); }
        catch (e) { mediaStore.discard(req); throw e; }
      }
      req.allowSlowBody?.();
      const r = await mediaStore.receive(tenantMediaBucket(ctx.tenantId), req.mediaHash, req);
      json(res, r.status, r.body);
    },

    'GET /api/gym/media/{hash}': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      if (!mediaStore || !sendMediaFileFn) return json(res, 404, { error: 'uploads de mídia desabilitados no servidor' });
      const f = mediaStore.file(tenantMediaBucket(ctx.tenantId), req.mediaHash);
      if (!f) throw new MediaError(404, 'media-missing');
      await sendMediaFileFn(res, f, req.mediaHash);
    },

    'GET /api/gym/exercise-media': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const payload = hasSqliteDir
        ? getTenantExercisesPayload(dataDir, ctx.tenantId)
        : { tenantId: ctx.tenantId, overrides: {}, customExercises: [] };
      json(res, 200, {
        ok: true,
        tenantId: ctx.tenantId,
        overrides: payload.overrides || {},
        customExercises: payload.customExercises || [],
        media: mediaConfigObj,
        usage: mediaStore ? mediaStore.usage(tenantMediaBucket(ctx.tenantId)) : null
      });
    },

    'PUT /api/gym/exercise-media': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      if (!hasSqliteDir) return json(res, 503, { error: 'banco sqlite indisponível' });
      const body = await readBody(req);
      const exerciseId = String(body?.exerciseId || '').trim();
      if (!exerciseId) return json(res, 400, { error: 'exerciseId é obrigatório' });
      if (exerciseId.startsWith(TENANT_CUSTOM_EX_PREFIX)) {
        return json(res, 400, { error: 'Exercício próprio da academia deve ser editado em /api/gym/custom-exercises' });
      }
      try {
        const result = upsertTenantExerciseOverride(dataDir, ctx.tenantId, {
          exerciseId,
          media: body?.media ?? null,
          url: body?.url ?? '',
          note: body?.note ?? '',
          updatedBy: ctx.user.id
        });
        audit(req, 'gym.exercise_media.upsert', { user: ctx.user, msg: exerciseId });
        json(res, 200, { ok: true, ...result });
      } catch (e) {
        json(res, 400, { error: e.message || 'Dados inválidos para vídeo do exercício' });
      }
    },

    'DELETE /api/gym/exercise-media': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      if (!hasSqliteDir) return json(res, 503, { error: 'banco sqlite indisponível' });
      const sp = new URL(req.url || '', 'http://x').searchParams;
      let exerciseId = sp.get('exerciseId') || '';
      if (!exerciseId) {
        const body = await readBody(req).catch(() => ({}));
        exerciseId = body?.exerciseId || '';
      }
      exerciseId = String(exerciseId).trim();
      if (!exerciseId) return json(res, 400, { error: 'exerciseId é obrigatório' });
      const deleted = deleteTenantExerciseOverride(dataDir, ctx.tenantId, exerciseId);
      audit(req, 'gym.exercise_media.delete', { user: ctx.user, msg: exerciseId });
      json(res, 200, { ok: true, deleted });
    },

    'POST /api/gym/custom-exercises': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      if (!hasSqliteDir) return json(res, 503, { error: 'banco sqlite indisponível' });
      const body = await readBody(req);
      try {
        const exercise = upsertTenantCustomExercise(dataDir, ctx.tenantId, body || {}, ctx.user.id);
        audit(req, 'gym.custom_exercise.upsert', { user: ctx.user, msg: exercise.id });
        json(res, 200, { ok: true, exercise });
      } catch (e) {
        json(res, 400, { error: e.message || 'Não foi possível salvar o exercício customizado' });
      }
    },

    'DELETE /api/gym/custom-exercises': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      if (!hasSqliteDir) return json(res, 503, { error: 'banco sqlite indisponível' });
      const sp = new URL(req.url || '', 'http://x').searchParams;
      let id = sp.get('id') || '';
      if (!id) {
        const body = await readBody(req).catch(() => ({}));
        id = body?.id || '';
      }
      id = String(id).trim();
      if (!id) return json(res, 400, { error: 'id do exercício é obrigatório' });
      const deleted = deleteTenantCustomExercise(dataDir, ctx.tenantId, id);
      audit(req, 'gym.custom_exercise.delete', { user: ctx.user, msg: id });
      json(res, 200, { ok: true, deleted });
    },

    /* ---------- Modelos de Ficha (Templates da Academia) ---------- */
    'GET /api/gym/templates': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const templates = loadTemplates(ctx.tenantDir, { seedIfMissing: true });
      json(res, 200, { ok: true, templates });
    },

    'POST /api/gym/templates/import-defaults': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const result = importDefaultTemplates(ctx.tenantDir);
      audit(req, 'gym.template.import_defaults', { user: ctx.user, msg: `+${result.added}` });
      json(res, 200, { ok: true, ...result });
    },

    'POST /api/gym/templates': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      if (!body?.name || !Array.isArray(body?.ex)) {
        return json(res, 400, { error: 'Informe o nome do modelo e a lista de exercícios' });
      }
      const saved = upsertTemplate(ctx.tenantDir, body);
      audit(req, 'gym.template.upsert', { user: ctx.user, msg: saved.name });
      json(res, 200, { ok: true, template: saved });
    },

    'DELETE /api/gym/templates': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      if (!body?.id) return json(res, 400, { error: 'id do modelo é obrigatório' });
      removeTemplate(ctx.tenantDir, body.id);
      audit(req, 'gym.template.delete', { user: ctx.user, msg: body.id });
      json(res, 200, { ok: true });
    },

    /* ---------- Convites & Onboarding por QR Code da Academia ---------- */
    'GET /api/gym/invites': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const invites = (db.invites || [])
        .filter(i => i.tenantId === ctx.tenantId)
        .map(i => ({
          ...i,
          usedByName: i.usedBy ? (db.users.find(u => u.id === i.usedBy)?.name || null) : null
        }));
      json(res, 200, {
        ok: true,
        invites,
        inviteOnly: Boolean(ctx.tenant?.settings?.inviteOnly)
      });
    },

    'GET /api/invite/preview': async (req, res) => {
      const sp = new URL(req.url || '', 'http://x').searchParams;
      const code = String(sp.get('code') || '').trim().toUpperCase();
      if (!code || code.length > 64) {
        return json(res, 400, { ok: false, code: 'invite', error: 'Código de convite inválido.' });
      }
      const nowMs = Date.now();
      const inv = (db.invites || []).find(
        i => i && i.code === code && !i.usedBy && !i.revoked && (!i.expiresAt || Date.parse(i.expiresAt) > nowMs)
      );
      if (!inv) {
        return json(res, 404, { ok: false, code: 'invite', error: 'Convite inválido, expirado ou já utilizado.' });
      }
      const invTenantId = inv.tenantId && inv.tenantId !== 'default' ? inv.tenantId : 'default';
      const tenant = invTenantId !== 'default' ? getTenant(dataDir, invTenantId) : null;
      const linkedStudent = inv.studentId
        ? db.users.find(u => u.id === inv.studentId && (u.tenantId || 'default') === invTenantId && !u.disabled)
        : null;
      json(res, 200, {
        ok: true,
        code: inv.code,
        tenantId: invTenantId,
        tenantName: tenant?.name || null,
        studentName: linkedStudent?.name || inv.studentName || null,
        hasPreEnrolledStudent: Boolean(linkedStudent)
      });
    },

    'POST /api/gym/invites': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      const outcome = runDbMutation(() => {
        const freshTenant = getTenant(dataDir, ctx.tenantId) || ctx.tenant;
        const limit = freshTenant?.limits?.maxStudents;
        if (limit) {
          const activeStudents = db.users.filter(
            u => u.tenantId === ctx.tenantId && isStudentAccount(u) && !u.disabled
          ).length;
          // Convites já vinculados a um aluno pré-cadastrado (i.studentId) não consomem vaga extra.
          const pendingInvites = (db.invites || []).filter(
            i => i.tenantId === ctx.tenantId && !i.usedBy && !i.revoked && !i.studentId
          ).length;
          if (activeStudents >= limit || activeStudents + pendingInvites >= limit) {
            return {
              errorStatus: 403,
              code: 'plan-limit',
              error: activeStudents >= limit
                ? `Limite do plano atingido (${limit} alunos ativos). Faça upgrade do plano antes de gerar novos convites.`
                : `Limite de vagas e convites pendentes atingido (${limit}). Revogue um convite disponível ou faça upgrade do plano.`
            };
          }
        }
        db.invites = db.invites || [];
        let gen;
        do { gen = crypto.randomBytes(6).toString('hex').toUpperCase(); } while (db.invites.some(i => i.code === gen));
        const created = {
          code: gen,
          note: String(body?.note || '').trim().slice(0, 60),
          tenantId: ctx.tenantId,
          createdBy: ctx.user.id,
          created: new Date().toISOString()
        };
        if (hasSqliteDir) upsertInviteSqlite(dataDir, created, null);
        db.invites.push(created);
        saveDb();
        return { code: gen, invite: created };
      });
      if (outcome.errorStatus) {
        return json(res, outcome.errorStatus, {
          error: outcome.error,
          ...(outcome.code ? { code: outcome.code } : {})
        });
      }
      audit(req, 'gym.invite.create', { user: ctx.user, msg: outcome.code });
      json(res, 201, { ok: true, invite: outcome.invite });
    },

    'POST /api/gym/invites/revoke': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      const code = String(body?.code || '').trim().toUpperCase();
      const outcome = runDbMutation(() => {
        const inv = (db.invites || []).find(i => i.code === code && i.tenantId === ctx.tenantId);
        if (!inv) return { errorStatus: 404, error: 'Convite não encontrado' };
        if (inv.usedBy) return { errorStatus: 400, error: 'Este convite já foi utilizado' };
        db.invites = db.invites.filter(i => i.code !== code);
        if (hasSqliteDir) deleteInviteSqlite(dataDir, code, null);
        saveDb();
        return { ok: true };
      });
      if (outcome.errorStatus) {
        return json(res, outcome.errorStatus, {
          error: outcome.error,
          ...(outcome.code ? { code: outcome.code } : {})
        });
      }
      audit(req, 'gym.invite.revoke', { user: ctx.user, msg: code });
      json(res, 200, { ok: true });
    },

    /* ---------- Identidade Visual White-Label & Configurações da Unidade ---------- */
    'PUT /api/gym/branding': async (req, res) => {
      const ctx = requireGymContext(req, res, { managerOnly: true });
      if (!ctx) return;
      const body = await readBody(req);
      if (ctx.tenantId !== 'default' && getTenant(dataDir, ctx.tenantId)) {
        let safeBrandingSettings;
        if (body?.settings && typeof body.settings === 'object') {
          const {
            evolutionUrl: _dropUrl,
            evolutionApiKey: _dropKey,
            evolutionApiKeyEnc: _dropEnc,
            evolutionInstance: _dropInst,
            clearEvolutionApiKey: _dropClear,
            ...allowedBrandingSettings
          } = body.settings;
          safeBrandingSettings = allowedBrandingSettings;
        }
        try {
          const updated = updateTenant(dataDir, ctx.tenantId, { branding: body, settings: safeBrandingSettings });
          audit(req, 'gym.branding.update', { user: ctx.user, msg: ctx.tenantId });
          return json(res, 200, { ok: true, tenant: updated, branding: updated.branding });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      const branding = saveTenantBranding(ctx.tenantDir, body);
      json(res, 200, { ok: true, branding });
    },

    'PUT /api/gym/settings': async (req, res) => {
      const ctx = requireGymContext(req, res, { managerOnly: true });
      if (!ctx) return;
      const body = await readBody(req);
      if (ctx.tenantId === 'default' || !getTenant(dataDir, ctx.tenantId)) {
        return json(res, 400, { error: 'Selecione uma academia válida' });
      }
      if (body?.evolutionUrl) {
        const val = validateEvolutionUrl(body.evolutionUrl, { allowInternalPlatform: false });
        if (!val.ok) {
          return json(res, 400, { error: `URL do WhatsApp inválida: ${val.error}` });
        }
      }
      try {
        const updated = updateTenant(dataDir, ctx.tenantId, { settings: body });
        audit(req, 'gym.settings.update', { user: ctx.user, msg: ctx.tenantId });
        json(res, 200, { ok: true, settings: updated.settings, tenant: updated });
      } catch (err) {
        json(res, 400, { error: err.message });
      }
    },

    /* ---------- Automação & Notificações WhatsApp (Evolution API) ---------- */
    'POST /api/gym/whatsapp/send': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      const targetPhone = body?.phone;
      const rawMsg = String(body?.message || '').trim();

      if (!targetPhone) {
        return json(res, 400, { error: 'Telefone de destino é obrigatório' });
      }
      if (!rawMsg) {
        return json(res, 400, { error: 'Mensagem não pode estar vazia' });
      }

      const clean = cleanWhatsAppPhone(targetPhone);
      if (!clean) {
        return json(res, 400, { error: 'Número de WhatsApp inválido (ex: 11999998888)' });
      }

      const evoSettings = resolveTenantEvolutionSettings(dataDir, ctx.tenantId);
      const result = await dispatchWhatsAppWithRetry({
        dataDir,
        tenantId: ctx.tenantId,
        kind: body?.kind || 'manual',
        recipientName: body?.studentName || 'Aluno',
        phone: clean,
        message: rawMsg,
        tenantSettings: { ...(ctx.tenant?.settings || {}), ...evoSettings }
      });

      audit(req, 'gym.whatsapp.send', { user: ctx.user, msg: `${clean} ok=${result.ok} queued=${Boolean(result.queued)}` });

      if (!result.ok && !result.queued) {
        return json(res, 400, {
          error: `Falha ao enviar mensagem pelo WhatsApp: ${result.error}`,
          details: result
        });
      }

      json(res, 200, {
        ok: true,
        queued: Boolean(result.queued),
        sentTo: clean,
        message: result.queued
          ? 'Gateway reconectando: mensagem salva na fila resiliente e será entregue automaticamente!'
          : 'Mensagem enviada com sucesso no WhatsApp do aluno!'
      });
    },

    'POST /api/gym/whatsapp/churn-batch': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      const requestedIds = Array.isArray(body?.studentIds) ? new Set(body.studentIds) : null;

      const allStudents = filterStudentsByPortfolio(ctx, listStudents(db, ctx.stateStorageDir, {
        tenantId: ctx.tenantId,
        churnDaysThreshold: ctx.tenant?.settings?.churnDaysThreshold || 5,
        stateOps,
        livePresence
      }));

      const targets = allStudents.filter(s => {
        if (s.disabled || !s.phone) return false;
        if (requestedIds) return requestedIds.has(s.id);
        return s.churnStatus === 'critical' || s.churnStatus === 'warning';
      });

      if (targets.length === 0) {
        return json(res, 400, { error: 'Nenhum aluno ausente com WhatsApp cadastrado foi encontrado para este disparo.' });
      }

      const tenantName = ctx.tenant?.name || 'Sua Academia';
      const todayKey = new Date().toISOString().slice(0, 10);
      const evoSettings = resolveTenantEvolutionSettings(dataDir, ctx.tenantId);
      const effectiveTenantSettings = { ...(ctx.tenant?.settings || {}), ...evoSettings };
      let sentCount = 0;
      let queuedCount = 0;
      let skippedCount = 0;

      for (const st of targets) {
        const msg = formatChurnRecoveryWhatsAppMessage({
          studentName: st.name,
          daysInactive: st.daysInactive,
          tenantName,
          trainerName: st.assignedTrainerName || ctx.user?.name || ''
        });
        const resSend = await dispatchWhatsAppWithRetry({
          dataDir,
          tenantId: ctx.tenantId,
          kind: 'churn_recovery',
          recipientName: st.name,
          phone: st.phone,
          message: msg,
          tenantSettings: effectiveTenantSettings,
          dedupKey: `churn:${ctx.tenantId}:${st.id}:${todayKey}`
        });
        if (resSend.deduplicated || resSend.skipped) skippedCount++;
        else if (resSend.ok) sentCount++;
        else if (resSend.queued) queuedCount++;
      }

      audit(req, 'gym.whatsapp.churn_batch', { user: ctx.user, msg: `sent=${sentCount} queued=${queuedCount} skipped=${skippedCount}` });

      json(res, 200, {
        ok: true,
        totalTargeted: targets.length,
        sentCount,
        queuedCount,
        skippedCount,
        message: queuedCount > 0
          ? `${sentCount} enviada(s) agora e ${queuedCount} adicionada(s) à fila automática!`
          : sentCount === 0 && skippedCount > 0
            ? `Nenhuma nova mensagem enviada: ${skippedCount} aluno(s) já haviam recebido lembrete hoje.`
            : `Mensagens de recuperação enviadas para ${sentCount} aluno(s) no WhatsApp!`
      });
    },

    /* ---------- Fase 2.1: Avaliação Física & Antropometria ---------- */
    'POST /api/gym/student/assessment': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req).catch(() => ({}));
      const studentId = String(body?.studentId || '').trim();
      if (!studentId) return json(res, 400, { error: 'studentId é obrigatório' });

      const target = requireTenantStudent(req, res, ctx, studentId, 'student-assessment');
      if (!target) return;

      let out;
      try {
        out = recordStudentAssessment(ctx.stateStorageDir, studentId, body, ctx.user, stateOps);
      } catch (err) {
        return json(res, err.status || 400, { error: err.message, ...(err.code ? { code: err.code } : {}) });
      }

      if (typeof sendPushFn === 'function') {
        try {
          await sendPushFn(studentId, assessmentPush('pt', {
            trainerName: ctx.user?.name || '',
            weightKg: out.assessment?.weightKg ?? null,
            bodyFat: out.assessment?.bodyFat ?? null
          }));
        } catch { /* ignore push error */ }
      }

      let whatsapp = { skipped: true };
      const cleanPhone = cleanWhatsAppPhone(target.phone);
      const assessMsg = formatAssessmentSummaryWhatsAppMessage({
        studentName: target.name,
        dateStr: out.assessment?.d || '',
        weightKg: out.assessment?.weightKg ?? null,
        bodyFat: out.assessment?.bodyFat ?? null,
        weightDelta: out.bodyComparison?.deltas?.weightKg || null,
        bfDelta: out.bodyComparison?.deltas?.bodyFat || null,
        trainerName: ctx.user?.name || '',
        tenantName: ctx.tenant?.name || 'Sua Academia'
      });
      if (body?.notifyWhatsApp === true && cleanPhone) {
        whatsapp = await sendStudentWhatsApp(ctx, target, {
          kind: 'assessment_summary',
          phone: cleanPhone,
          dedupKey: `assessment:${ctx.tenantId}:${target.id}:${out.assessment?.d || Date.now()}`,
          message: assessMsg
        });
      }

      audit(req, 'gym.assessment.save', {
        user: ctx.user,
        target,
        tenantId: ctx.tenantId,
        msg: `${out.assessment?.d || ''} (${out.assessment?.weightKg || '-'}kg)`
      });
      json(res, 200, { ok: true, ...out, whatsapp, whatsappText: assessMsg });
    },

    /* ---------- Fase 2.3: Arquivamento de Ciclos & Periodização ---------- */
    'POST /api/gym/student/archive-cycle': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req).catch(() => ({}));
      const studentId = String(body?.studentId || '').trim();
      if (!studentId) return json(res, 400, { error: 'studentId é obrigatório' });

      const target = requireTenantStudent(req, res, ctx, studentId, 'archive-cycle');
      if (!target) return;

      const { byId } = getCatalogueIndex();
      const out = archiveStudentRoutines(ctx.stateStorageDir, studentId, {
        routineIds: Array.isArray(body?.routineIds) ? body.routineIds : null,
        removeCurrent: Boolean(body?.removeCurrent),
        reason: String(body?.reason || 'cycle_completed'),
        trainerUser: ctx.user,
        resolveNameFn: id => byId.get(id)?.name || null
      }, stateOps);

      audit(req, 'gym.routine.archive', {
        user: ctx.user,
        target,
        tenantId: ctx.tenantId,
        msg: `${out.archived.length} ficha(s) arquivada(s)`
      });
      json(res, 200, { ok: true, archivedCount: out.archived.length, ...out });
    },

    /* ---------- Pilar B: Aplicar Modelo em Lote ---------- */
    'POST /api/gym/templates/apply-batch': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req).catch(() => ({}));
      const templateId = String(body?.templateId || '').trim();
      const studentIds = Array.isArray(body?.studentIds) ? Array.from(new Set(body.studentIds.map(String))) : [];
      if (!templateId || !studentIds.length) {
        return json(res, 400, { error: 'Informe templateId e ao menos um aluno.' });
      }
      if (studentIds.length > 200) {
        return json(res, 400, { error: 'Selecione no máximo 200 alunos por lote.' });
      }

      const templates = loadTemplates(ctx.tenantDir);
      const tpl = templates.find(t => t.id === templateId);
      if (!tpl) return json(res, 404, { error: 'Modelo de treino não encontrado.' });

      const days = Array.isArray(body?.days) ? body.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : [];
      const archivePrevious = Boolean(body?.archivePrevious);
      const replaceSchedule = Boolean(body?.replaceSchedule);

      const applied = [];
      const failed = [];
      for (const sid of studentIds) {
        const stu = db.users.find(u => u.id === sid && u.tenantId === ctx.tenantId);
        if (!stu || !isStudentAccount(stu)) {
          failed.push({ studentId: sid, reason: 'Aluno não encontrado nesta unidade' });
          continue;
        }
        if (isTrainerPortfolioRestricted(ctx) && stu.assignedTrainerId !== ctx.user?.id) {
          failed.push({ studentId: sid, name: stu.name, reason: 'Fora da carteira do professor' });
          continue;
        }
        const saved = prescribeRoutineToStudent(ctx.stateStorageDir, sid, {
          routine: { name: tpl.name, emoji: tpl.emoji || 'figureStrength', ex: tpl.ex || [] },
          days,
          replaceSchedule,
          archivePrevious,
          trainerUser: ctx.user
        }, stateOps);
        applied.push({ studentId: sid, name: stu.name, routineId: saved?.id });
        if (typeof sendPushFn === 'function') {
          try {
            await sendPushFn(sid, prescriptionPush('pt', {
              trainerName: ctx.user?.name || '',
              tenantName: ctx.tenant?.name || '',
              routines: [tpl.name]
            }));
          } catch { /* ignore push error */ }
        }
      }

      audit(req, 'gym.template.apply_batch', {
        user: ctx.user,
        tenantId: ctx.tenantId,
        msg: `${tpl.name} -> ${applied.length} aluno(s)`
      });
      json(res, 200, { ok: true, templateName: tpl.name, appliedCount: applied.length, applied, failed });
    },

    /* ---------- Fase 2.2: Importação em Lote (CSV/Texto) + Fila Anti-Ban ---------- */
    'POST /api/gym/students/import': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req).catch(() => ({}));
      const inputRows = Array.isArray(body?.rows) && body.rows.length
        ? body.rows
        : parseStudentImportRows(typeof body?.rawText === 'string' ? body.rawText : '');

      if (!inputRows.length) {
        return json(res, 400, { error: 'Nenhum aluno válido encontrado na lista ou CSV enviado.' });
      }
      if (inputRows.length > MAX_STUDENT_IMPORT_ROWS) {
        return json(res, 400, { error: `Importe até ${MAX_STUDENT_IMPORT_ROWS} alunos por lote.` });
      }

      let resolvedAssignedTrainerId = isActiveTenantStaff(ctx.user, ctx.tenantId) ? ctx.user.id : null;
      if (isTrainerPortfolioRestricted(ctx)) {
        resolvedAssignedTrainerId = ctx.user.id;
      } else if (body?.assignedTrainerId) {
        const trainerCheck = validateAssignedTrainer(body.assignedTrainerId, ctx.tenantId);
        if (!trainerCheck.ok) {
          return json(res, 400, { error: trainerCheck.error, code: trainerCheck.code });
        }
        resolvedAssignedTrainerId = trainerCheck.assignedTrainerId;
      }

      let starterTemplate = null;
      if (body?.initialTemplateId) {
        const templates = loadTemplates(ctx.tenantDir);
        starterTemplate = templates.find(t => t.id === String(body.initialTemplateId).trim()) || null;
      }

      const defaultTempHash = await hashPassword(generateTempPassword());
      const nowIso = new Date().toISOString();
      const publicAppUrl = resolvePublicAppUrl();
      const sendWelcome = body?.sendWelcome !== false;

      const created = [];
      const skipped = [];
      const waBatchItems = [];

      runDbMutation(() => {
        const freshTenant = getTenant(dataDir, ctx.tenantId) || ctx.tenant;
        const limit = freshTenant?.limits?.maxStudents || 99999;
        let activeCount = db.users.filter(
          u => u.tenantId === ctx.tenantId && isStudentAccount(u) && !u.disabled
        ).length;

        const usedEmails = new Set(db.users.map(u => u.email).filter(Boolean));
        const usedTenantNames = new Set(
          db.users
            .filter(u => (u.tenantId || 'default') === ctx.tenantId && u.pw?.h)
            .map(u => nameKey(u.name))
        );

        for (let idx = 0; idx < inputRows.length; idx++) {
          const raw = inputRows[idx] || {};
          const name = String(raw.name || raw.nome || '').trim().slice(0, 60);
          if (!name || name.length < 2) {
            skipped.push({ row: idx + 1, name: name || '(vazio)', reason: 'Nome inválido ou ausente' });
            continue;
          }
          if (activeCount >= limit) {
            skipped.push({ row: idx + 1, name, reason: `Limite do plano atingido (${limit} alunos ativos)`, code: 'plan-limit' });
            continue;
          }

          const emailRaw = String(raw.email || '').trim();
          const email = emailRaw ? normalizeEmail(emailRaw) : null;
          if (emailRaw && !email) {
            skipped.push({ row: idx + 1, name, reason: 'E-mail inválido' });
            continue;
          }
          if (email && usedEmails.has(email)) {
            skipped.push({ row: idx + 1, name, reason: 'E-mail já cadastrado na plataforma' });
            continue;
          }
          const folded = nameKey(name);
          if (!email && usedTenantNames.has(folded)) {
            skipped.push({ row: idx + 1, name, reason: 'Nome duplicado na unidade (informe e-mail para diferenciar)' });
            continue;
          }

          const phoneRaw = String(raw.phone || raw.whatsapp || raw.telefone || '').trim().slice(0, 30);
          const student = {
            id: 'u_st_' + crypto.randomBytes(8).toString('base64url'),
            name,
            ...(email ? { email } : {}),
            phone: phoneRaw,
            goal: String(raw.goal || raw.objetivo || '').trim().slice(0, 80),
            notes: String(raw.notes || raw.observacoes || '').trim().slice(0, 300),
            assignedTrainerId: resolvedAssignedTrainerId,
            tenantId: ctx.tenantId,
            saasRole: 'student',
            role: 'student',
            created: nowIso,
            pw: { h: defaultTempHash, set: nowIso }
          };

          const inv = issueStudentInvite({
            tenantId: ctx.tenantId,
            student,
            createdBy: ctx.user.id,
            reusePending: false
          });
          const signupUrl = buildStudentInviteSignupUrl({
            appUrl: publicAppUrl,
            tenantId: ctx.tenantId,
            inviteCode: inv.code
          });
          const cleanPh = cleanWhatsAppPhone(phoneRaw);
          student.welcomeWhatsapp = {
            sent: false,
            queued: Boolean(sendWelcome && cleanPh),
            at: nowIso,
            channel: cleanPh ? 'whatsapp_batch' : 'none'
          };

          db.users.push(student);
          if (hasSqliteDir) upsertUserSqlite(dataDir, student, null);
          if (email) usedEmails.add(email);
          usedTenantNames.add(folded);
          activeCount += 1;

          created.push({
            id: student.id,
            name: student.name,
            phone: student.phone,
            email: student.email || '',
            inviteCode: inv.code,
            signupUrl
          });

          if (sendWelcome && cleanPh) {
            waBatchItems.push({
              phone: cleanPh,
              userId: student.id,
              targetName: student.name,
              dedupKey: `welcome_import:${ctx.tenantId}:${student.id}`,
              message: formatStudentWelcomeWhatsAppMessage({
                studentName: student.name,
                tenantName: ctx.tenant?.name || 'Sua Academia',
                trainerName: ctx.user?.name || '',
                inviteUrl: signupUrl,
                welcomeCustom: ctx.tenant?.settings?.welcomeMessage
              })
            });
          }
        }

        if (created.length > 0) saveDb();
      });

      if (starterTemplate && created.length > 0) {
        for (const st of created) {
          prescribeRoutineToStudent(ctx.stateStorageDir, st.id, {
            routine: {
              name: starterTemplate.name,
              emoji: starterTemplate.emoji || 'figureStrength',
              ex: starterTemplate.ex || []
            },
            days: [],
            trainerUser: ctx.user,
            recordNotice: false
          }, stateOps);
        }
      }

      let whatsappQueue = { ok: true, count: 0, skippedDuplicates: 0, estimatedDurationSec: 0 };
      if (waBatchItems.length > 0) {
        const evoSettings = resolveTenantEvolutionSettings(dataDir, ctx.tenantId);
        whatsappQueue = enqueueWhatsAppBatch({
          dataDir,
          tenantId: ctx.tenantId,
          kind: 'welcome_invite',
          items: waBatchItems,
          tenantSettings: { ...(ctx.tenant?.settings || {}), ...evoSettings },
          baseDelayMs: 0,
          minIntervalMs: 3500,
          maxIntervalMs: 7000
        });
      }

      audit(req, 'gym.students.import', {
        user: ctx.user,
        tenantId: ctx.tenantId,
        msg: `${created.length} criados, ${skipped.length} ignorados, ${whatsappQueue.count || 0} WA na fila`
      });

      json(res, 200, {
        ok: true,
        createdCount: created.length,
        skippedCount: skipped.length,
        queuedWhatsappCount: whatsappQueue.count || 0,
        estimatedDurationSec: whatsappQueue.estimatedDurationSec || 0,
        created,
        skipped
      });
    },

    /* ---------- Fase 3.1: Copiloto IA de Prescrição para o Professor ---------- */
    'POST /api/gym/coach/suggest': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req).catch(() => ({}));
      const studentId = String(body?.studentId || '').trim();

      let targetStudent = null;
      let studentState = null;
      if (studentId) {
        targetStudent = requireTenantStudent(req, res, ctx, studentId, 'coach-suggest');
        if (!targetStudent) return;
        studentState = readStudentState(ctx.stateStorageDir, studentId, stateOps);
      }

      const customPayload = hasSqliteDir ? getTenantExercisesPayload(dataDir, ctx.tenantId) : { customExercises: [] };
      const { suggestTrainerWorkouts } = await import('./coach/b2b-prescribe.js');
      const suggestion = await suggestTrainerWorkouts({
        student: targetStudent,
        studentState,
        params: body || {},
        tenantCustomExercises: Array.isArray(customPayload.customExercises) ? customPayload.customExercises : [],
        catalogueIndex: getCatalogueIndex(),
        mode: body?.mode === 'rules' ? 'rules' : 'auto'
      });

      audit(req, 'gym.coach.suggest', {
        user: ctx.user,
        target: targetStudent || undefined,
        tenantId: ctx.tenantId,
        msg: `${suggestion.engine} (${suggestion.workouts.length} treinos)`
      });
      json(res, 200, suggestion);
    },

    /* ---------- Fase 3.2: Vídeos de Execução (Streaming & Feedback Técnico) ---------- */
    'GET /api/gym/student/video': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      if (!mediaStore || !sendMediaFileFn) {
        return json(res, 404, { error: 'Uploads de mídia desabilitados neste servidor.' });
      }
      const sp = new URL(req.url || '', 'http://x').searchParams;
      const studentId = String(sp.get('studentId') || '').trim();
      const hash = String(sp.get('hash') || '').trim().toLowerCase();
      if (!studentId || !/^[0-9a-f]{64}$/.test(hash)) {
        return json(res, 400, { error: 'Parâmetros studentId e hash SHA-256 são obrigatórios.' });
      }

      const target = requireTenantStudent(req, res, ctx, studentId, 'student-video-read');
      if (!target) return;

      const state = readStudentState(ctx.stateStorageDir, studentId, stateOps);
      if (!isMediaHashInStudentState(state, hash)) {
        return json(res, 404, { error: 'Vídeo não encontrado ou restrito ao dispositivo do aluno.' });
      }

      const f = mediaStore.file(target.id, hash);
      if (!f) {
        return json(res, 404, { error: 'Arquivo de vídeo não sincronizado para o servidor.' });
      }
      await sendMediaFileFn(res, f, hash);
    },

    'POST /api/gym/student/video-review': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req).catch(() => ({}));
      const studentId = String(body?.studentId || '').trim();
      if (!studentId) return json(res, 400, { error: 'studentId é obrigatório' });

      const target = requireTenantStudent(req, res, ctx, studentId, 'student-video-review');
      if (!target) return;

      let out;
      try {
        out = saveStudentVideoReview(ctx.stateStorageDir, studentId, {
          key: body?.key,
          hash: body?.hash,
          status: body?.status,
          comment: body?.comment,
          trainerUser: ctx.user
        }, stateOps);
      } catch (err) {
        return json(res, err.status || 400, { error: err.message, ...(err.code ? { code: err.code } : {}) });
      }

      const matched = out.videos.find(v => v.hash === out.review.hash || v.key === out.review.key);
      const exerciseName = String(body?.exerciseName || matched?.exerciseName || 'Exercício');

      if (typeof sendPushFn === 'function') {
        try {
          await sendPushFn(studentId, videoReviewPush('pt', {
            exerciseName,
            trainerName: ctx.user?.name || '',
            status: out.review.status
          }));
        } catch { /* ignore push error */ }
      }

      const whatsappText = formatVideoReviewWhatsAppMessage({
        studentName: target.name,
        exerciseName,
        status: out.review.status,
        comment: out.review.comment,
        trainerName: ctx.user?.name || '',
        tenantName: ctx.tenant?.name || 'Sua Academia'
      });
      let whatsapp = { skipped: true };
      const cleanPhone = cleanWhatsAppPhone(target.phone);
      if (body?.notifyWhatsApp === true && cleanPhone) {
        whatsapp = await sendStudentWhatsApp(ctx, target, {
          kind: 'video_review',
          phone: cleanPhone,
          dedupKey: `video_review:${ctx.tenantId}:${target.id}:${out.review.key}`,
          message: whatsappText
        });
      }

      audit(req, 'gym.video.review', {
        user: ctx.user,
        target,
        tenantId: ctx.tenantId,
        msg: `${exerciseName} (${out.review.status})`
      });
      json(res, 200, { ok: true, ...out, whatsapp, whatsappText });
    },

    /* ---------- Fase 3.3 & Pilar A: Check-in Semanal + Régua Autônoma ---------- */
    'POST /api/gym/student/weekly-checkin': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req).catch(() => ({}));
      const studentId = String(body?.studentId || '').trim();
      if (!studentId) return json(res, 400, { error: 'studentId é obrigatório' });

      const target = requireTenantStudent(req, res, ctx, studentId, 'weekly-checkin');
      if (!target) return;

      const state = readStudentState(ctx.stateStorageDir, studentId, stateOps);
      const stats = computeStudentWeeklyStats(state);
      const whatsappText = formatWeeklyCheckinWhatsAppMessage({
        studentName: target.name,
        workoutsCount: stats.workoutsCount,
        plannedDays: stats.plannedDays,
        totalVolKg: stats.totalVolKg,
        prsCount: stats.prsCount,
        tenantName: ctx.tenant?.name || 'Sua Academia',
        trainerName: ctx.user?.name || ''
      });

      if (typeof sendPushFn === 'function') {
        try {
          await sendPushFn(studentId, weeklySummaryPush('pt', stats));
        } catch { /* ignore push */ }
      }

      let whatsapp = { skipped: true };
      const cleanPhone = cleanWhatsAppPhone(target.phone);
      if (body?.sendWhatsApp !== false && cleanPhone) {
        whatsapp = await sendStudentWhatsApp(ctx, target, {
          kind: 'weekly_checkin',
          phone: cleanPhone,
          dedupKey: `weekly_manual:${ctx.tenantId}:${target.id}:${stats.windowEnd}`,
          message: whatsappText
        });
      }

      audit(req, 'gym.weekly_checkin', { user: ctx.user, target, tenantId: ctx.tenantId, msg: `${stats.workoutsCount} treinos` });
      json(res, 200, { ok: true, stats, whatsapp, whatsappText });
    },

    'POST /api/gym/engagement/run': async (req, res) => {
      const ctx = requireGymContext(req, res, { managerOnly: true });
      if (!ctx) return;
      const body = await readBody(req).catch(() => ({}));
      const tenant = getTenant(dataDir, ctx.tenantId) || ctx.tenant;
      const summary = await evaluateTenantEngagement({
        dataDir,
        tenant,
        db,
        stateOps,
        sendPushFn,
        forceWeekly: Boolean(body?.forceWeekly),
        dryRun: Boolean(body?.dryRun)
      });
      if (!body?.dryRun) {
        audit(req, 'gym.engagement.run', {
          user: ctx.user,
          tenantId: ctx.tenantId,
          msg: `weekly=${summary.weeklyQueued} expiry=${summary.expiryAlertsQueued} churn=${summary.churnNudgesQueued}`
        });
      }
      json(res, 200, { ok: true, dryRun: Boolean(body?.dryRun), ...summary });
    },

    /* ---------- Fase 2.4: Trilha de Auditoria Escopada & Exportação LGPD ---------- */
    'GET /api/gym/audit': async (req, res) => {
      const ctx = requireGymContext(req, res, { managerOnly: true });
      if (!ctx) return;
      const sp = new URL(req.url || '', 'http://x').searchParams;
      const limit = Math.max(1, Math.min(300, Number(sp.get('limit')) || 120));
      const events = typeof auditReader === 'function' ? auditReader(limit, ctx.tenantId) : [];
      json(res, 200, { ok: true, events });
    },

    'GET /api/gym/export': async (req, res) => {
      const ctx = requireGymContext(req, res, { managerOnly: true });
      if (!ctx) return;
      const tenant = getTenant(dataDir, ctx.tenantId) || ctx.tenant;
      const tenantTeam = db.users
        .filter(u => u.tenantId === ctx.tenantId && !isStudentAccount(u) && !isSuperAdmin(u))
        .map(u => ({
          id: u.id,
          name: u.name,
          email: u.email || '',
          phone: u.phone || '',
          cref: u.cref || '',
          specialty: u.specialty || '',
          saasRole: u.saasRole || 'trainer',
          disabled: Boolean(u.disabled),
          created: u.created || null
        }));
      const tenantStudents = db.users
        .filter(u => u.tenantId === ctx.tenantId && isStudentAccount(u))
        .map(u => {
          const stState = readStudentState(ctx.stateStorageDir, u.id, stateOps) || {};
          const { _prior, _unstamped, ...cleanState } = stState;
          return {
            profile: {
              id: u.id,
              name: u.name,
              email: u.email || '',
              phone: u.phone || '',
              goal: u.goal || '',
              notes: u.notes || '',
              assignedTrainerId: u.assignedTrainerId || null,
              disabled: Boolean(u.disabled),
              created: u.created || null,
              onboardedAt: u.onboardedAt || null
            },
            state: cleanState
          };
        });
      const templates = loadTemplates(ctx.tenantDir);
      const exportPayload = {
        ok: true,
        exportedAt: new Date().toISOString(),
        schemaVersion: 'rit-lgpd-export-v1',
        tenant: sanitizeTenantForRole(tenant, true),
        templates,
        team: tenantTeam,
        students: tenantStudents
      };

      audit(req, 'gym.export.lgpd', {
        user: ctx.user,
        tenantId: ctx.tenantId,
        msg: `${tenantStudents.length} alunos exportados`
      });

      const sp = new URL(req.url || '', 'http://x').searchParams;
      if (sp.get('download') === '1') {
        const safeSlug = String(ctx.tenantId || 'academia').replace(/[^a-zA-Z0-9_-]/g, '');
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="rit-lgpd-${safeSlug}-${new Date().toISOString().slice(0, 10)}.json"`,
          'cache-control': 'no-store'
        });
        return res.end(JSON.stringify(exportPayload, null, 2));
      }
      json(res, 200, exportPayload);
    },

    'GET /api/gym/whatsapp/outbox': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const outbox = getTenantWhatsAppOutbox(dataDir, ctx.tenantId);
      json(res, 200, { ok: true, ...outbox });
    },

    'POST /api/gym/whatsapp/outbox/retry': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const stats = await flushWhatsAppOutbox(dataDir, { force: true, tenantId: ctx.tenantId });
      const outbox = getTenantWhatsAppOutbox(dataDir, ctx.tenantId);
      json(res, 200, {
        ok: true,
        ...stats,
        outbox,
        message: stats.sent > 0
          ? `${stats.sent} mensagem(ns) da fila reenviada(s) com sucesso!`
          : stats.stillQueued > 0
            ? `Ainda há ${stats.stillQueued} mensagem(ns) aguardando conexão com o WhatsApp.`
            : 'Nenhuma mensagem pendente na fila.'
      });
    },

    'POST /api/gym/whatsapp/test': async (req, res) => {
      const ctx = requireGymContext(req, res, { managerOnly: true });
      if (!ctx) return;
      const body = await readBody(req);
      const targetPhone = body?.phone || ctx.tenant?.phone || ctx.tenant?.branding?.contactPhone || ctx.user?.phone;
      if (!targetPhone) {
        return json(res, 400, { error: 'Informe um número de WhatsApp com DDD para o teste' });
      }
      const clean = cleanWhatsAppPhone(targetPhone);
      if (!clean) {
        return json(res, 400, { error: 'Número de WhatsApp inválido (ex: 11999998888)' });
      }

      const tenantName = ctx.tenant?.name || 'Sua Academia';
      const testMessage = `🏋️‍♂️ *Notificação de Teste • Rit*\n\n`
        + `Olá! As notificações de treino via WhatsApp para *${tenantName}* estão ativas e funcionando perfeitamente! ✅\n\n`
        + `Sempre que um aluno concluir o treino no aplicativo Rit, o resumo de cargas, tempo e recordes chegará automaticamente para o professor responsável.\n\n`
        + `_Rit • Aplicativo de Treinos & Gestão Fitness_`;

      const evoSettings = resolveTenantEvolutionSettings(dataDir, ctx.tenantId);
      const result = await sendEvolutionTextMessage({
        phone: clean,
        message: testMessage,
        tenantSettings: { ...(ctx.tenant?.settings || {}), ...evoSettings },
        allowPlatformFallback: !String(evoSettings.evolutionUrl || '').trim()
      });

      audit(req, 'gym.whatsapp.test', { user: ctx.user, msg: `${clean} ok=${result.ok}` });

      if (!result.ok) {
        return json(res, 400, {
          error: `Não foi possível enviar mensagem via Evolution API: ${result.error}`,
          details: result
        });
      }

      json(res, 200, {
        ok: true,
        sentTo: clean,
        message: 'Mensagem de teste enviada com sucesso no WhatsApp!'
      });
    },

    'GET /api/gym/whatsapp/status': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const settings = ctx.tenant?.settings || {};
      const evoSettings = resolveTenantEvolutionSettings(dataDir, ctx.tenantId);
      const hasOwnUrl = Boolean(String(evoSettings.evolutionUrl || '').trim());
      const status = await testEvolutionConnection({
        url: evoSettings.evolutionUrl,
        apiKey: evoSettings.evolutionApiKey,
        instance: evoSettings.evolutionInstance,
        allowPlatformFallback: !hasOwnUrl
      });
      const outbox = getTenantWhatsAppOutbox(dataDir, ctx.tenantId);
      const isManager = ctx.superUser || isGymManagerOrOwner(ctx.user);
      const hasOwnGateway = Boolean(hasOwnUrl && String(evoSettings.evolutionInstance || '').trim());
      json(res, 200, {
        ok: true,
        connected: status.ok && status.state === 'open',
        state: status.state || 'close',
        outbox,
        settings: {
          notifyTrainerOnWorkout: settings.notifyTrainerOnWorkout !== false,
          notifyStudentOnPrescribe: settings.notifyStudentOnPrescribe !== false,
          usingPlatformGateway: !hasOwnGateway,
          hasEvolutionApiKey: isManager ? Boolean(settings.hasEvolutionApiKey || evoSettings.evolutionApiKey) : false,
          evolutionUrl: isManager ? (evoSettings.evolutionUrl || '') : '',
          evolutionInstance: isManager ? (evoSettings.evolutionInstance || '') : ''
        }
      });
    },

    'GET /api/gym/whatsapp/qr': async (req, res) => {
      const ctx = requireGymContext(req, res, { managerOnly: true });
      if (!ctx) return;
      const evoSettings = resolveTenantEvolutionSettings(dataDir, ctx.tenantId);
      if (!ctx.superUser && !String(evoSettings.evolutionInstance || '').trim()) {
        return json(res, 403, {
          ok: false,
          error: 'Esta unidade usa o gateway central da plataforma. Configure uma instância própria para parear por QR Code.'
        });
      }
      const hasOwnUrl = Boolean(String(evoSettings.evolutionUrl || '').trim());
      const qrRes = await fetchEvolutionQrCode({
        url: evoSettings.evolutionUrl,
        apiKey: evoSettings.evolutionApiKey,
        instance: evoSettings.evolutionInstance,
        allowPlatformFallback: !hasOwnUrl
      });
      if (!qrRes.ok) {
        return json(res, qrRes.status === 400 || qrRes.status === 503 ? qrRes.status : 502, { ok: false, error: qrRes.error });
      }
      json(res, 200, {
        ok: true,
        connected: qrRes.connected,
        base64: qrRes.base64,
        code: qrRes.code,
        count: qrRes.count
      });
    },

    'POST /api/gym/whatsapp/disconnect': async (req, res) => {
      const ctx = requireGymContext(req, res, { managerOnly: true });
      if (!ctx) return;
      const evoSettings = resolveTenantEvolutionSettings(dataDir, ctx.tenantId);
      if (!ctx.superUser && !String(evoSettings.evolutionInstance || '').trim()) {
        return json(res, 403, {
          ok: false,
          error: 'Esta unidade usa o gateway central da plataforma e não pode desconectar a instância compartilhada.'
        });
      }
      const hasOwnUrl = Boolean(String(evoSettings.evolutionUrl || '').trim());
      const discRes = await disconnectEvolutionInstance({
        url: evoSettings.evolutionUrl,
        apiKey: evoSettings.evolutionApiKey,
        instance: evoSettings.evolutionInstance,
        allowPlatformFallback: !hasOwnUrl
      });
      if (!discRes.ok) {
        return json(
          res,
          discRes.status === 400 || discRes.status === 503 ? discRes.status : 502,
          { ok: false, error: discRes.error }
        );
      }
      audit(req, 'gym.whatsapp.disconnect', { user: ctx.user });
      json(res, 200, { ok: true, message: 'WhatsApp desconectado com sucesso' });
    },

    /* =====================================================================
     * 5. ROTAS LEGADAS / COMPATIBILIDADE (`/api/trainer/*` & `/api/admin/tenants`)
     *    Nota: nunca sobrescreve `POST /api/admin/user/role` do server.js!
     * ===================================================================== */
    'GET /api/admin/tenants': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      json(res, 200, { ok: true, tenants: listTenants(dataDir, db) });
    },

    'POST /api/admin/tenants': async (req, res) => {
      const admin = requireSuperAdmin(req, res);
      if (!admin) return;
      const body = await readBody(req);
      try {
        const created = createTenant(dataDir, body);
        audit(req, 'tenant.create', { user: admin, msg: created.id });
        json(res, 201, { ok: true, tenant: created });
      } catch (e) {
        json(res, 400, { error: e.message });
      }
    },

    'GET /api/trainer/students': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const students = listStudents(db, ctx.stateStorageDir, {
        tenantId: ctx.tenantId,
        churnDaysThreshold: ctx.tenant?.settings?.churnDaysThreshold || 5,
        stateOps,
        livePresence
      });
      json(res, 200, { ok: true, students });
    },

    'GET /api/trainer/student': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const sp = new URL(req.url || '', 'http://x').searchParams;
      const studentId = sp.get('id');
      if (!studentId) return json(res, 400, { error: 'parâmetro id do aluno obrigatório' });
      const target = requireTenantStudent(req, res, ctx, studentId, 'trainer-student-read');
      if (!target) return;
      const state = readStudentState(ctx.stateStorageDir, studentId, stateOps);
      json(res, 200, {
        ok: true,
        student: { id: target.id, name: target.name, created: target.created },
        state
      });
    },

    'POST /api/trainer/prescribe': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      const { studentId, routine, day, days } = body || {};
      if (!studentId || !routine || !routine.name || !Array.isArray(routine.ex)) {
        return json(res, 400, { error: 'studentId e routine (com nome e lista ex) são obrigatórios' });
      }
      const target = requireTenantStudent(req, res, ctx, studentId, 'trainer-prescribe');
      if (!target) return;

      const prescribed = prescribeRoutineToStudent(ctx.stateStorageDir, studentId, {
        routine,
        day,
        days,
        trainerUser: ctx.user
      }, stateOps);

      audit(req, 'trainer.prescribe', { user: ctx.user, target, msg: routine.name });
      json(res, 200, { ok: true, routine: prescribed });
    },

    'GET /api/trainer/templates': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const templates = loadTemplates(ctx.tenantDir, { seedIfMissing: true });
      json(res, 200, { ok: true, templates });
    },

    'POST /api/trainer/template': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      if (!body || !body.name || !Array.isArray(body.ex)) {
        return json(res, 400, { error: 'template com name e array de exercícios (ex) é obrigatório' });
      }
      const saved = upsertTemplate(ctx.tenantDir, body);
      audit(req, 'trainer.template.upsert', { user: ctx.user, msg: saved.id });
      json(res, 200, { ok: true, template: saved });
    },

    'POST /api/trainer/template/delete': async (req, res) => {
      const ctx = requireGymContext(req, res);
      if (!ctx) return;
      const body = await readBody(req);
      const id = body?.id;
      if (!id) return json(res, 400, { error: 'id do template é obrigatório' });
      removeTemplate(ctx.tenantDir, id);
      audit(req, 'trainer.template.delete', { user: ctx.user, msg: id });
      json(res, 200, { ok: true });
    }
  };
}
