import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { createSaasRoutes } from '../saas-routes.js';
import { createTenant, updateTenant } from '../tenants.js';
import { evictStudentSummary, readStudentState, listStudents } from '../trainer.js';
import { computeStudentWeeklyStats, evaluateTenantEngagement } from '../engagement.js';
import { MAX_STUDENT_IMPORT_ROWS, parseStudentImportRows } from '../student-import.js';
import { suggestTrainerWorkouts } from '../coach/b2b-prescribe.js';
import { LIB_BY_ID } from '../coach/core/library.js';
import { closeSqliteInstance, getSqliteInstance, upsertUserSqlite, writeUserStateSqlite } from '../sqlite.js';

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function makeTestEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rit-phase23-'));
  const tRes = createTenant(tmpDir, {
    id: 'academia_teste',
    name: 'Studio Teste Rit',
    accountType: 'gym',
    planId: 'starter',
    status: 'active',
    ownerName: 'Gestor Principal',
    ownerEmail: 'gestor@rit.test'
  });
  const tenantId = tRes.id;
  const otherTenantRes = createTenant(tmpDir, {
    id: 'academia_b',
    name: 'Academia Vizinha',
    accountType: 'gym',
    planId: 'pro',
    status: 'active',
    ownerName: 'Gestor B',
    ownerEmail: 'gestorb@rit.test'
  });

  const owner = {
    id: 'u_owner_1',
    name: 'Gestor Principal',
    email: 'gestor@rit.test',
    phone: '11999990001',
    tenantId,
    saasRole: 'gym_owner',
    role: 'trainer',
    created: new Date().toISOString()
  };
  const trainerA = {
    id: 'u_tr_a',
    name: 'Prof. Carlos',
    email: 'carlos@rit.test',
    phone: '11999990002',
    tenantId,
    saasRole: 'trainer',
    role: 'trainer',
    created: new Date().toISOString()
  };
  const trainerB = {
    id: 'u_tr_b',
    name: 'Prof. Mariana',
    email: 'mariana@rit.test',
    phone: '11999990003',
    tenantId,
    saasRole: 'trainer',
    role: 'trainer',
    created: new Date().toISOString()
  };
  const otherOwner = {
    id: 'u_owner_b',
    name: 'Gestor B',
    email: 'gestorb@rit.test',
    tenantId: otherTenantRes.id,
    saasRole: 'gym_owner',
    role: 'trainer',
    created: new Date().toISOString()
  };

  const stAlice = {
    id: 'u_st_alice',
    name: 'Alice Oliveira',
    email: 'alice@rit.test',
    phone: '11988881111',
    goal: 'Hipertrofia',
    notes: 'Condromalácia no joelho esquerdo e desconforto leve no ombro',
    tenantId,
    saasRole: 'student',
    role: 'student',
    assignedTrainerId: trainerA.id,
    created: new Date(Date.now() - 40 * 86400000).toISOString(),
    onboardedAt: new Date(Date.now() - 38 * 86400000).toISOString(),
    pw: { h: 'x', set: new Date().toISOString() }
  };
  const stBruno = {
    id: 'u_st_bruno',
    name: 'Bruno Santos',
    email: 'bruno@rit.test',
    phone: '11988882222',
    goal: 'Força',
    tenantId,
    saasRole: 'student',
    role: 'student',
    assignedTrainerId: trainerB.id,
    created: new Date(Date.now() - 35 * 86400000).toISOString(),
    onboardedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
    pw: { h: 'x', set: new Date().toISOString() }
  };
  const stOther = {
    id: 'u_st_other',
    name: 'Aluno Vizinho',
    email: 'vizinho@rit.test',
    phone: '11988883333',
    tenantId: otherTenantRes.id,
    saasRole: 'student',
    role: 'student',
    assignedTrainerId: otherOwner.id,
    created: new Date().toISOString(),
    pw: { h: 'x', set: new Date().toISOString() }
  };

  const db = {
    users: [owner, trainerA, trainerB, otherOwner, stAlice, stBruno, stOther],
    subs: [],
    invites: []
  };
  for (const u of db.users) upsertUserSqlite(tmpDir, u, null);

  const cloudVideoHash = sha256Hex('alice-cloud-squat-video');
  const localVideoHash = sha256Hex('alice-local-only-video');
  const unrefVideoHash = sha256Hex('foreign-or-unreferenced-video');

  // Escreve arquivo real apenas para simular upload sincronizado no servidor
  const aliceUploadDir = path.join(tmpDir, 'uploads', stAlice.id);
  fs.mkdirSync(aliceUploadDir, { recursive: true });
  const cloudVideoPath = path.join(aliceUploadDir, `${cloudVideoHash}.mp4`);
  const localVideoPath = path.join(aliceUploadDir, `${localVideoHash}.mp4`);
  fs.writeFileSync(cloudVideoPath, Buffer.from('FAKE_MP4_CLOUD_STREAM'));
  fs.writeFileSync(localVideoPath, Buffer.from('FAKE_MP4_LOCAL_SECRET'));

  // Estado inicial rico para Alice (inclui medidas anteriores do app, treinos, cargas, vídeos e ficha vencendo)
  writeUserStateSqlite(tmpDir, stAlice.id, {
    routines: [
      {
        id: 'r_alice_a',
        name: 'Treino A - Inferiores',
        emoji: 'figureLegs',
        prescribedBy: {
          trainerId: trainerA.id,
          trainerName: trainerA.name,
          at: Date.now() - 26 * 86400000,
          initialWeights: { '0025': 40, '0043': 60 }
        },
        ex: [
          { id: '0025', name: 'Supino Reto', sets: 3, reps: 10, weight: 40 },
          { id: '0043', name: 'Agachamento', sets: 4, reps: 8, weight: 60 }
        ]
      }
    ],
    week: { 1: 'r_alice_a', 3: 'r_alice_a', 5: 'r_alice_a' },
    bodyweight: [
      { d: isoDaysAgo(28), w: 72.5, t: Date.now() - 28 * 86400000 }
    ],
    measurements: [
      { d: isoDaysAgo(28), t: Date.now() - 28 * 86400000, waist: 82.0, upperArmRight: 31.5, bodyFat: 24.5 }
    ],
    exWeights: {
      '0025': { w: 48, d: isoDaysAgo(2) },
      '0043': { w: 75, d: isoDaysAgo(1) }
    },
    workouts: [
      {
        id: 'w_alice_1',
        d: isoDaysAgo(10),
        routineId: 'r_alice_a',
        name: 'Treino A - Inferiores',
        start: Date.now() - 10 * 86400000,
        end: Date.now() - 10 * 86400000 + 3600000,
        vol: 2400,
        prs: ['0025'],
        entries: [
          { id: '0025', sets: [{ w: 42.5, r: 10, done: true }, { w: 45, r: 10, done: true }] },
          { id: '0043', sets: [{ w: 65, r: 8, done: true }] }
        ]
      },
      {
        id: 'w_alice_2',
        d: isoDaysAgo(1),
        routineId: 'r_alice_a',
        name: 'Treino A - Inferiores',
        start: Date.now() - 86400000,
        end: Date.now() - 86400000 + 3400000,
        vol: 3100,
        prs: ['0043'],
        entries: [
          {
            id: '0025',
            sets: [
              { w: 48, r: 10, done: true, media: { kind: 'video', hash: cloudVideoHash, mime: 'video/mp4', dur: 12, size: 20 } },
              { w: 48, r: 10, done: true, media: { kind: 'video', hash: localVideoHash, mime: 'video/mp4', local: true } }
            ]
          },
          { id: '0043', sets: [{ w: 75, r: 8, done: true }] }
        ]
      }
    ]
  });

  // Bruno inativo há 12 dias COM falta justificada hoje no dayNotes
  writeUserStateSqlite(tmpDir, stBruno.id, {
    routines: [
      {
        id: 'r_bruno_1',
        name: 'Treino Força',
        prescribedBy: { trainerId: trainerB.id, trainerName: trainerB.name, at: Date.now() - 27 * 86400000 },
        ex: [{ id: '0025', sets: 4, reps: 6 }]
      }
    ],
    week: { 1: 'r_bruno_1' },
    dayNotes: {
      [isoDaysAgo(0)]: { tag: 'travel', text: 'Viagem a trabalho' },
      '2026-11-20': { tag: 'travel', text: 'Viagem a trabalho' }
    },
    workouts: [
      { id: 'w_b_1', d: isoDaysAgo(12), start: Date.now() - 12 * 86400000, entries: [{ id: '0025', sets: [{ w: 80, r: 5, done: true }] }] }
    ]
  });

  const auditLogs = [];
  const pushLogs = [];
  const auditFn = (req, ev, f = {}) => {
    const tid = f.tenantId || f.user?.tenantId || f.target?.tenantId || '';
    auditLogs.push({ id: auditLogs.length + 1, ts: Date.now(), ev, ok: f.ok !== false, name: f.user?.name || '', tname: f.target?.name || '', msg: f.msg || '', tid });
  };

  const routes = createSaasRoutes({
    json: (res, status, data, headers) => {
      res.status = status;
      res.data = data;
      res.headers = headers || {};
    },
    readBody: async req => req.body || {},
    readSession: req => req._actor || owner,
    isAdmin: () => false,
    db,
    saveDb: () => {},
    dataDir: tmpDir,
    audit: auditFn,
    auditReader: (limit = 100, filterTid = null) => {
      const rev = auditLogs.slice().reverse();
      const filtered = filterTid ? rev.filter(r => r.tid === filterTid) : rev;
      return filtered.slice(0, limit);
    },
    sendPushFn: async (uid, payload) => {
      pushLogs.push({ uid, payload });
    },
    mediaStore: {
      file: (uid, hash) => {
        if (uid === stAlice.id && hash === cloudVideoHash) return { path: cloudVideoPath, ext: 'mp4' };
        if (uid === stAlice.id && hash === localVideoHash) return { path: localVideoPath, ext: 'mp4' };
        return null;
      }
    },
    sendMediaFileFn: async (res, f, hash) => {
      res.status = 200;
      res.streamedFile = f.path;
      res.streamedHash = hash;
      res.bytes = fs.readFileSync(f.path);
    },
    makeSession: u => 'tok_' + u.id
  });

  const callRoute = async (routeKey, { actor = owner, body = null, query = '', headers = {} } = {}) => {
    const res = {};
    const pathOnly = routeKey.split(' ')[1];
    await routes[routeKey]({
      _actor: actor,
      body,
      url: query ? `${pathOnly}?${query}` : pathOnly,
      headers: { 'x-tenant-id': actor.tenantId || tenantId, ...headers }
    }, res);
    return res;
  };

  const cleanup = () => {
    try { closeSqliteInstance(tmpDir); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return {
    tmpDir,
    tenantId,
    otherTenantId: otherTenantRes.id,
    owner,
    trainerA,
    trainerB,
    otherOwner,
    stAlice,
    stBruno,
    stOther,
    cloudVideoHash,
    localVideoHash,
    unrefVideoHash,
    db,
    auditLogs,
    pushLogs,
    callRoute,
    cleanup
  };
}

test('Quick-Win excusedOn: aluno inativo com falta justificada recebe status excused e não dispara falso alerta de evasão', () => {
  const env = makeTestEnv();
  try {
    const list = listStudents(env.db, env.tmpDir, { tenantId: env.tenantId, churnDaysThreshold: 5 });
    const bruno = list.find(s => s.id === env.stBruno.id);
    assert.equal(bruno.churnStatus, 'excused');
    assert.equal(bruno.excused, true);
    assert.equal(bruno.excusedReason, 'Viagem a trabalho');
  } finally {
    env.cleanup();
  }
});

test('Fase 2.1 Avaliação Física: grava bodyweight/measurements/assessments, calcula deltas Antes vs. Atual e dispara push', async () => {
  const env = makeTestEnv();
  try {
    const res = await env.callRoute('POST /api/gym/student/assessment', {
      actor: env.trainerA,
      body: {
        studentId: env.stAlice.id,
        d: isoDaysAgo(0),
        protocol: 'bioimpedancia',
        weightKg: 69.1,
        heightCm: 165,
        bodyFat: 20.5,
        waist: 77.5,
        upperArmRight: 33.0,
        clinicalNotes: 'Redução de 3,4 kg com ganho de massa magra e melhora na simetria.'
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.assessment.weightKg, 69.1);
    assert.equal(res.data.assessment.bodyFat, 20.5);
    assert.ok(res.data.assessment.bmi > 24 && res.data.assessment.bmi < 26);

    const deltas = res.data.bodyComparison.deltas;
    assert.equal(deltas.weightKg.before, 72.5);
    assert.equal(deltas.weightKg.current, 69.1);
    assert.equal(deltas.weightKg.diff, -3.4);
    assert.equal(deltas.waist.diff, -4.5);
    assert.equal(deltas.upperArmRight.diff, 1.5);
    assert.equal(deltas.bodyFat.diff, -4.0);

    // Garante compatibilidade nativa com `state.bodyweight` do PWA do aluno
    const stState = readStudentState(env.tmpDir, env.stAlice.id);
    assert.ok(stState.bodyweight.some(b => b.w === 69.1 && b.src === 'trainer'));
    assert.equal(env.pushLogs.some(p => p.uid === env.stAlice.id && p.payload.tag === 'assessment-update'), true);

    const getRes = await env.callRoute('GET /api/gym/student', {
      actor: env.trainerA,
      query: `id=${env.stAlice.id}`
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.state.bodyComparison.deltas.weightKg.diff, -3.4);
    assert.equal(getRes.data.state.assessments.length, 1);

    // Rejeita avaliação vazia
    const emptyRes = await env.callRoute('POST /api/gym/student/assessment', {
      actor: env.trainerA,
      body: { studentId: env.stAlice.id }
    });
    assert.equal(emptyRes.status, 400);
  } finally {
    env.cleanup();
  }
});

test('Fase 2.2 Importação CSV em lote: cria alunos com template inicial, respeita duplicatas e limite do plano e enfileira outbox anti-ban', async () => {
  const env = makeTestEnv();
  try {
    // Ajustamos limite do tenant via maxStudentsOverride para 4 vagas (já existem 2 alunos: Alice e Bruno)
    updateTenant(env.tmpDir, env.tenantId, { maxStudentsOverride: 4 });
    const inst = getSqliteInstance(env.tmpDir);
    const tplRes = await env.callRoute('GET /api/gym/templates', { actor: env.owner });
    const starterTplId = tplRes.data.templates[0]?.id;
    assert.ok(starterTplId);

    const rawText = [
      'Nome;WhatsApp;E-mail;Objetivo',
      'Carla Dias;11977770001;carla@rit.test;Hipertrofia',
      'Alice Duplicada;11977770002;alice@rit.test;Força',
      'Diego Ferreira;11977770003;diego@rit.test;Emagrecimento',
      'Excedente Plano;11977770004;excedente@rit.test;Condicionamento',
      ';11977770005;;'
    ].join('\n');

    const res = await env.callRoute('POST /api/gym/students/import', {
      actor: env.owner,
      body: { rawText, initialTemplateId: starterTplId, sendWelcome: true }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.createdCount, 2); // Carla e Diego completam 4 vagas
    assert.equal(res.data.skippedCount, 3); // Alice duplicada + Excedente limite + Linha vazia
    assert.equal(res.data.queuedWhatsappCount, 2);
    assert.ok(res.data.skipped.some(s => s.code === 'plan-limit'));

    const carlaState = readStudentState(env.tmpDir, res.data.created[0].id);
    assert.equal(carlaState.routines.length, 1);

    const outboxRows = inst.db.prepare('SELECT * FROM whatsapp_outbox WHERE tenant_id = ?').all(env.tenantId);
    assert.equal(outboxRows.length, 2);
    // Verifica escalonamento anti-ban (next_attempt_at do 2º >= 1º)
    assert.ok(outboxRows[1].next_attempt_at >= outboxRows[0].next_attempt_at);
  } finally {
    env.cleanup();
  }
});

test('Avaliação física mantém as pesagens do aluno e converte kg para a unidade do perfil', async () => {
  const env = makeTestEnv();
  try {
    const studentId = env.stAlice.id;
    const d = isoDaysAgo(1);
    const before = {
      d: isoDaysAgo(2), w: 160, t: 1
    };
    const readings = [
      { id: 'morning', at: '08:00', w: 154, t: 2 },
      { id: 'evening', at: '18:00', w: 156, t: 3 }
    ];
    writeUserStateSqlite(env.tmpDir, studentId, {
      ...readStudentState(env.tmpDir, studentId),
      unit: 'lb',
      bwDaily: 'avg',
      bodyweight: [before, { d, w: 155, t: 3, ins: readings, gone: { removed: 4 } }]
    });

    for (const weightKg of [70, 71]) {
      const res = await env.callRoute('POST /api/gym/student/assessment', {
        actor: env.trainerA,
        body: { studentId, d, weightKg }
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.bodyComparison.before.weightKg, 72.6);
      assert.equal(res.data.bodyComparison.current.weightKg, weightKg);
    }

    const state = readStudentState(env.tmpDir, studentId);
    const day = state.bodyweight.find(item => item.d === d);
    assert.deepEqual(day.ins.filter(item => item.src !== 'trainer'), readings);
    assert.deepEqual(day.ins.filter(item => item.src === 'trainer').map(item => item.w), [156.5]);
    assert.deepEqual(day.gone, { removed: 4 });
    assert.equal(day.w, 155.5);
    assert.equal(state.bw.find(item => item.d === d).w, 71);
  } finally {
    env.cleanup();
  }
});

test('CSV de alunos preserva campos entre aspas e conta o limite sem o cabeçalho', async () => {
  const env = makeTestEnv();
  try {
    const rawText = '\uFEFFNome,WhatsApp,E-mail,Objetivo,Observações\r\n'
      + '"Silva, Ana",11995678901,ana@rit.test,"Força, mobilidade","Linha 1\r\nLinha ""2"""';
    const [preview] = parseStudentImportRows(rawText);
    assert.deepEqual(preview, {
      name: 'Silva, Ana', phone: '11995678901', email: 'ana@rit.test',
      goal: 'Força, mobilidade', notes: 'Linha 1\r\nLinha "2"'
    });
    assert.equal(parseStudentImportRows('"Silva; Ana";11995678901')[0].name, 'Silva; Ana');
    assert.equal(parseStudentImportRows('Nome\tTelefone\n"Silva, Ana"\t11995678901')[0].phone, '11995678901');

    const res = await env.callRoute('POST /api/gym/students/import', { body: { rawText, sendWelcome: false } });
    assert.equal(res.status, 200);
    assert.equal(res.data.createdCount, 1);
    assert.equal(res.data.created[0].name, preview.name);
    assert.equal(res.data.created[0].email, preview.email);

    const maxRows = 'Nome\n' + Array.from({ length: MAX_STUDENT_IMPORT_ROWS }, (_, i) => `Aluno ${i}`).join('\n');
    assert.equal(parseStudentImportRows(maxRows).length, MAX_STUDENT_IMPORT_ROWS);
    const excess = await env.callRoute('POST /api/gym/students/import', {
      body: { rawText: maxRows + '\nAluno excedente', sendWelcome: false }
    });
    assert.equal(excess.status, 400);
  } finally {
    env.cleanup();
  }
});

test('Fase 2.3 Periodização (routineArchive), Curva de Carga e Aplicação de Modelo em Lote', async () => {
  const env = makeTestEnv();
  try {
    // 1. Curva de carga no GET /api/gym/student
    const getRes = await env.callRoute('GET /api/gym/student', {
      actor: env.trainerA,
      query: `id=${env.stAlice.id}`
    });
    assert.equal(getRes.status, 200);
    const squatCurve = getRes.data.state.exerciseSeries.find(e => e.id === '0043');
    assert.ok(squatCurve);
    assert.equal(squatCurve.firstWeightKg, 65);
    assert.equal(squatCurve.latestWeightKg, 75);
    assert.equal(squatCurve.deltaKg, 10);
    assert.equal(squatCurve.series.length, 2);

    // 2. Prescrição com archivePrevious: true arquiva ficha anterior com cargas inicial vs final
    const prescRes = await env.callRoute('POST /api/gym/prescribe', {
      actor: env.trainerA,
      body: {
        studentId: env.stAlice.id,
        archivePrevious: true,
        notifyWhatsApp: false,
        routine: {
          name: 'Treino A - Inferiores',
          ex: [{ id: '0043', name: 'Agachamento', sets: 4, reps: 6, weight: 80 }]
        }
      }
    });
    assert.equal(prescRes.status, 200);

    const afterState = readStudentState(env.tmpDir, env.stAlice.id);
    assert.equal(afterState.routineArchive.length, 1);
    assert.notEqual(prescRes.data.routine.id, 'r_alice_a');
    assert.deepEqual(afterState.week, { 1: prescRes.data.routine.id, 3: prescRes.data.routine.id, 5: prescRes.data.routine.id });
    const snap = afterState.routineArchive[0];
    assert.equal(snap.name, 'Treino A - Inferiores');
    const sqSnap = snap.exercises.find(e => e.id === '0043');
    assert.equal(sqSnap.initialWeightKg, 60);
    assert.equal(sqSnap.finalWeightKg, 75);
    assert.equal(sqSnap.deltaKg, 15);

    // 3. Arquivamento explícito via endpoint dedicado
    const arcRes = await env.callRoute('POST /api/gym/student/archive-cycle', {
      actor: env.trainerA,
      body: { studentId: env.stAlice.id, reason: 'mesociclo_concluido' }
    });
    assert.equal(arcRes.status, 200);
    assert.equal(arcRes.data.archivedCount, 1);
    assert.equal(arcRes.data.routineArchive.length, 2);

    // 4. Aplicação de modelo em lote
    const tplListRes = await env.callRoute('GET /api/gym/templates', { actor: env.owner });
    const firstTplId = tplListRes.data.templates[0]?.id;
    assert.ok(firstTplId);
    const batchRes = await env.callRoute('POST /api/gym/templates/apply-batch', {
      actor: env.owner,
      body: { templateId: firstTplId, studentIds: [env.stAlice.id, env.stBruno.id], days: [1, 4] }
    });
    assert.equal(batchRes.status, 200);
    assert.equal(batchRes.data.appliedCount, 2);
  } finally {
    env.cleanup();
  }
});

test('Renovar uma ficha em lote remapeia datas específicas e mantém as outras fichas do dia', async () => {
  const env = makeTestEnv();
  try {
    const studentId = env.stAlice.id;
    const day = isoDaysAgo(0);
    const state = readStudentState(env.tmpDir, studentId);
    state.routines.push({ id: 'other', name: 'Outra ficha', ex: [] });
    state.week = { 1: ['r_alice_a', 'other'], 3: 'r_alice_a' };
    state.dayPlan = { [day]: 'r_alice_a' };
    writeUserStateSqlite(env.tmpDir, studentId, state);

    const res = await env.callRoute('POST /api/gym/prescribe', {
      actor: env.trainerA,
      body: {
        studentId, archivePrevious: true, notifyWhatsApp: false,
        routines: [{ name: 'Treino A - Inferiores', ex: [{ id: '0043', sets: 4, reps: 6 }], days: [5], replaceSchedule: true }]
      }
    });
    assert.equal(res.status, 200);
    const newId = res.data.routines[0].id;
    const after = readStudentState(env.tmpDir, studentId);
    assert.notEqual(newId, 'r_alice_a');
    assert.deepEqual(after.week, { 1: ['other'], 5: [newId] });
    assert.deepEqual(after.dayPlan, { [day]: newId });
  } finally {
    env.cleanup();
  }
});

test('Fase 2.4 Isolamento de Carteira, Auditoria Escopada por Academia e Exportação LGPD', async () => {
  const env = makeTestEnv();
  try {
    // Antes de restringir: Trainer A vê Bruno (carteira de Trainer B)
    const beforeList = await env.callRoute('GET /api/gym/students', { actor: env.trainerA });
    assert.equal(beforeList.data.students.some(s => s.id === env.stBruno.id), true);

    // Gestor ativa restrictTrainerToAssigned: true
    const setRes = await env.callRoute('PUT /api/gym/settings', {
      actor: env.owner,
      body: { restrictTrainerToAssigned: true }
    });
    assert.equal(setRes.status, 200);
    assert.equal(setRes.data.settings.restrictTrainerToAssigned, true);

    // Agora Trainer A só enxerga Alice no overview e na lista de alunos
    const restrictedList = await env.callRoute('GET /api/gym/students', { actor: env.trainerA });
    assert.equal(restrictedList.data.restrictedToPortfolio, true);
    assert.deepEqual(restrictedList.data.students.map(s => s.id), [env.stAlice.id]);

    const restrictedOverview = await env.callRoute('GET /api/gym/overview', { actor: env.trainerA });
    assert.equal(restrictedOverview.data.kpis.totalStudents, 1);

    // Trainer A tentando abrir prontuário ou avaliar Bruno recebe 403 trainer-scope-restricted
    const deniedDossier = await env.callRoute('GET /api/gym/student', {
      actor: env.trainerA,
      query: `id=${env.stBruno.id}`
    });
    assert.equal(deniedDossier.status, 403);
    assert.equal(deniedDossier.data.code, 'trainer-scope-restricted');

    // Gestor/Owner continua vendo toda a academia normalmente
    const ownerList = await env.callRoute('GET /api/gym/students', { actor: env.owner });
    assert.equal(ownerList.data.students.length, 2);

    // Gera evento de auditoria na outra academia para garantir isolamento da trilha
    await env.callRoute('PUT /api/gym/settings', {
      actor: env.otherOwner,
      body: { churnDaysThreshold: 7 }
    });

    const auditDenied = await env.callRoute('GET /api/gym/audit', { actor: env.trainerA });
    assert.equal(auditDenied.status, 403);

    const auditOk = await env.callRoute('GET /api/gym/audit', { actor: env.owner });
    assert.equal(auditOk.status, 200);
    assert.ok(auditOk.data.events.length > 0);
    assert.equal(auditOk.data.events.some(e => e.tid === env.otherTenantId), false);

    // Exportação LGPD
    const exportDenied = await env.callRoute('GET /api/gym/export', { actor: env.trainerA });
    assert.equal(exportDenied.status, 403);

    const exportOk = await env.callRoute('GET /api/gym/export', { actor: env.owner });
    assert.equal(exportOk.status, 200);
    assert.equal(exportOk.data.schemaVersion, 'rit-lgpd-export-v1');
    assert.equal(exportOk.data.students.length, 2);
    assert.equal(exportOk.data.tenant.settings.evolutionApiKeyEnc, undefined);
  } finally {
    env.cleanup();
  }
});

test('Fase 3.1 Copiloto IA de Prescrição gera splits válidos no catálogo com alertas clínicos', async () => {
  const env = makeTestEnv();
  try {
    const res = await env.callRoute('POST /api/gym/coach/suggest', {
      actor: env.trainerA,
      body: {
        studentId: env.stAlice.id,
        goal: 'hipertrofia',
        level: 'intermediario',
        daysPerWeek: 3,
        equipmentPreset: 'full_gym',
        clinicalNotes: 'Condromalácia joelho esquerdo'
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.workouts.length, 3);
    assert.ok(res.data.cautions.length >= 1);
    for (const w of res.data.workouts) {
      assert.ok(w.ex.length >= 3);
      for (const ex of w.ex) {
        assert.equal(LIB_BY_ID.has(ex.id), true, `Exercicio ${ex.id} precisa existir no catalogo oficial`);
      }
    }

    // Valida também respeito a equipamento restrito (dumbbells_bodyweight) e inclusão de exercício customizado da academia
    const customSug = await suggestTrainerWorkouts({
      params: { goal: 'forca', level: 'iniciante', daysPerWeek: 2, equipmentPreset: 'dumbbells_bodyweight' },
      tenantCustomExercises: [{ id: 'cust_agach_goblet', name: 'Agachamento Taça da Academia', bodyPart: 'upper legs' }],
      mode: 'rules'
    });
    assert.equal(customSug.workouts.length, 2);
    assert.equal(customSug.engine, 'biomechanical_engine');
  } finally {
    env.cleanup();
  }
});

test('Fase 3.2 Vídeos de Execução: filtra local:true, transmite apenas vídeo autorizado da academia e salva parecer técnico', async () => {
  const env = makeTestEnv();
  try {
    // 1. Dossier lista somente o vídeo cloud (exclui localVideoHash com local: true)
    const getRes = await env.callRoute('GET /api/gym/student', {
      actor: env.trainerA,
      query: `id=${env.stAlice.id}`
    });
    assert.equal(getRes.data.state.formVideos.length, 1);
    assert.equal(getRes.data.state.formVideos[0].hash, env.cloudVideoHash);

    // 2. Streaming permitido para vídeo cloud do próprio aluno
    const streamOk = await env.callRoute('GET /api/gym/student/video', {
      actor: env.trainerA,
      query: `studentId=${env.stAlice.id}&hash=${env.cloudVideoHash}`
    });
    assert.equal(streamOk.status, 200);
    assert.equal(streamOk.bytes.toString(), 'FAKE_MP4_CLOUD_STREAM');

    // 3. Vídeo local:true ou não referenciado nunca pode ser vazado
    const streamLocalBlocked = await env.callRoute('GET /api/gym/student/video', {
      actor: env.trainerA,
      query: `studentId=${env.stAlice.id}&hash=${env.localVideoHash}`
    });
    assert.equal(streamLocalBlocked.status, 404);

    // 4. Professor de outra academia bloqueado (404 tenant isolation)
    const crossTenantBlocked = await env.callRoute('GET /api/gym/student/video', {
      actor: env.otherOwner,
      query: `studentId=${env.stAlice.id}&hash=${env.cloudVideoHash}`
    });
    assert.equal(crossTenantBlocked.status, 404);

    // 5. Salva revisão técnica e notifica aluno por Push
    const videoItem = getRes.data.state.formVideos[0];
    const revRes = await env.callRoute('POST /api/gym/student/video-review', {
      actor: env.trainerA,
      body: {
        studentId: env.stAlice.id,
        key: videoItem.key,
        hash: env.cloudVideoHash,
        status: 'adjust_needed',
        comment: 'Excelente controle, apenas segure 2s na fase excêntrica.',
        notifyWhatsApp: false
      }
    });
    assert.equal(revRes.status, 200);
    assert.equal(revRes.data.review.status, 'adjust_needed');
    assert.equal(env.pushLogs.some(p => p.uid === env.stAlice.id && p.payload.tag === 'video-review'), true);

    const listAfter = listStudents(env.db, env.tmpDir, { tenantId: env.tenantId });
    evictStudentSummary(env.stAlice.id);
    const aliceRow = listAfter.find(s => s.id === env.stAlice.id);
    assert.equal(aliceRow.pendingVideoReviewsCount, 0);
  } finally {
    env.cleanup();
  }
});

test('Avaliação, parecer de vídeo e check-in enviam pelo WhatsApp e confirmam a entrega à Evolution', async t => {
  const env = makeTestEnv();
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    requests.push({ url: String(url), body: JSON.parse(opts.body) });
    return new Response('{}', { status: 200 });
  });
  try {
    const studentId = env.stAlice.id;
    const actor = env.trainerA;
    const dossier = await env.callRoute('GET /api/gym/student', { actor, query: `id=${studentId}` });
    const [video] = dossier.data.state.formVideos;
    const cases = [
      ['assessment', { studentId, weightKg: 70, notifyWhatsApp: true }],
      ['video-review', {
        studentId, key: video.key, hash: video.hash, status: 'adjust_needed',
        comment: 'Controlar a descida.', notifyWhatsApp: true
      }],
      ['weekly-checkin', { studentId, sendWhatsApp: true }]
    ];
    for (const [route, body] of cases) {
      const res = await env.callRoute(`POST /api/gym/student/${route}`, { actor, body });
      assert.equal(res.status, 200, res.data.error || route);
      assert.equal(res.data.whatsapp.sent, true, res.data.whatsapp.error || route);
      const request = requests.at(-1);
      assert.match(request.url, /\/message\/sendText\//);
      assert.equal(request.body.number, '5511988881111');
      assert.equal(request.body.text, res.data.whatsappText);
    }

    const repeated = await env.callRoute('POST /api/gym/student/weekly-checkin', { actor, body: cases[2][1] });
    assert.equal(repeated.data.whatsapp.deduplicated, true);
    assert.equal(repeated.data.whatsapp.sent, false);
    assert.equal(requests.length, 3);
  } finally {
    env.cleanup();
  }
});

test('Resumo semanal soma o volume na unidade do perfil e converte libras para kg', () => {
  const d = '2026-11-19';
  const workouts = [{ d, vol: 500 }, { d, entries: [{ sets: [{ w: 50, r: 10, done: true }] }] }];
  const now = Date.parse(`${d}T15:00:00Z`);
  assert.equal(computeStudentWeeklyStats({ unit: 'lb', workouts }, now).totalVolKg, 454);
  assert.equal(computeStudentWeeklyStats({ unit: 'kg', workouts }, now).totalVolKg, 1000);
});

test('Fase 3.3 Check-in Semanal e Régua Autônoma de Engajamento com deduplicação e proteção excusedOn', async () => {
  const env = makeTestEnv();
  try {
    // 1. Check-in semanal sob demanda
    const weeklyRes = await env.callRoute('POST /api/gym/student/weekly-checkin', {
      actor: env.trainerA,
      body: { studentId: env.stAlice.id, sendWhatsApp: false }
    });
    assert.equal(weeklyRes.status, 200);
    assert.equal(weeklyRes.data.stats.workoutsCount >= 1, true);
    assert.ok(weeklyRes.data.whatsappText.includes('Resumo da Semana'));
    assert.equal(env.pushLogs.some(p => p.uid === env.stAlice.id && p.payload.tag === 'weekly-summary'), true);

    // 2. Habilita régua automática + Evolution mock para testar enfileiramento no outbox
    const setRes = await env.callRoute('PUT /api/gym/settings', {
      actor: env.owner,
      body: {
        autoWeeklyCheckin: true,
        autoRoutineExpiryAlert: true,
        autoChurnNudge: true,
        autoChurnDays: 5,
        routineCycleDays: 30,
        evolutionUrl: 'https://evo.rit-sandbox.example',
        evolutionInstance: 'rit-test'
      }
    });
    assert.equal(setRes.status, 200);

    // Simula sexta-feira ou domingo às 14:00 BRT relativo à data atual (evita deriva temporal de Date.now())
    const evalDayUtc = (() => {
      const d = new Date();
      d.setUTCHours(17, 0, 0, 0);
      return d.getTime();
    })();
    const tenantObj = setRes.data.tenant;
    const pushedInWorker = [];

    const firstRun = await evaluateTenantEngagement({
      dataDir: env.tmpDir,
      tenant: tenantObj,
      db: env.db,
      sendPushFn: async (uid, payload) => { pushedInWorker.push({ uid, tag: payload.tag }); },
      nowMs: evalDayUtc,
      forceWeekly: true
    });

    // Bruno está em excusedOn hoje -> ignorado no autoChurnNudge!
    assert.equal(firstRun.skippedExcused, 1);
    assert.equal(firstRun.churnNudgesQueued, 0);
    // Alice e Bruno têm fichas com 26 e 27 dias (>= 25d alerta!) -> expiry alerts enfileirados!
    assert.equal(firstRun.expiryAlertsQueued, 2);
    // Alice treinou na semana -> weekly check-in enfileirado!
    assert.equal(firstRun.weeklyQueued >= 1, true);

    // Segunda execução no mesmo instante NÃO pode duplicar nenhuma mensagem!
    const secondRun = await evaluateTenantEngagement({
      dataDir: env.tmpDir,
      tenant: tenantObj,
      db: env.db,
      sendPushFn: async (uid, payload) => { pushedInWorker.push({ uid, tag: payload.tag }); },
      nowMs: evalDayUtc + 60000,
      forceWeekly: true
    });
    assert.equal(secondRun.weeklyQueued, 0);
    assert.equal(secondRun.expiryAlertsQueued, 0);
    assert.equal(secondRun.churnNudgesQueued, 0);
  } finally {
    env.cleanup();
  }
});
