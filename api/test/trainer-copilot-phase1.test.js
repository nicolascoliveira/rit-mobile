/**
 * api/test/trainer-copilot-phase1.test.js
 *
 * Testes de integração para a Fase 1 do Copiloto do Professor:
 *  - Consolidado single-request em `GET /api/gym/overview` (`students`, `templates`, `team`, `invites`, `copilot`)
 *  - Classificação de ciclo da ficha (`missing`, `expired`, `expiring_soon`, `up_to_date`) e ciclo customizável (`routineCycleDays`)
 *  - Fila de prioridades (`withoutRoutine`, `expiringRoutines`, `pendingOnboarding`)
 *  - Radar de retenção & constância (`inactive` >7d, `consistent` meta semanal batida)
 *  - Caixa de entrada de feedbacks e PRs pós-treino (`w.note` e `w.prs`)
 *  - KPIs pedagógicos sem vazamento de métricas internas (`_workoutDates`)
 *  - Atribuição por professor (`assignedTrainerId`) e fluxo de salvar/clonar ficha como modelo
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSaasRoutes } from '../saas-routes.js';
import { createTenant } from '../tenants.js';
import { evictStudentSummary } from '../trainer.js';
import { closeSqliteInstance, upsertUserSqlite, writeUserStateSqlite } from '../sqlite.js';

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

function makeCopilotEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rit-copilot-p1-'));
  const secret = 'c'.repeat(64);
  fs.writeFileSync(path.join(tmpDir, 'secret'), secret, { mode: 0o600 });

  const tenantId = 'copilotgym';
  createTenant(tmpDir, {
    id: tenantId,
    name: 'Studio Movimento',
    planId: 'pro',
    status: 'active',
    ownerName: 'Prof. Ana Costa',
    ownerEmail: 'ana@studiomov.test'
  });

  const owner = {
    id: 'u_tr_ana',
    name: 'Prof. Ana Costa',
    email: 'ana@studiomov.test',
    saasRole: 'gym_owner',
    role: 'trainer',
    tenantId
  };
  const trainer2 = {
    id: 'u_tr_bruno',
    name: 'Prof. Bruno Lima',
    email: 'bruno@studiomov.test',
    saasRole: 'trainer',
    role: 'trainer',
    tenantId
  };

  const students = [
    {
      id: 'stu_missing',
      name: 'Carla Sem Ficha',
      email: 'carla@studiomov.test',
      phone: '(11) 99999-0001',
      goal: 'Hipertrofia',
      assignedTrainerId: owner.id,
      mustChangePassword: true,
      saasRole: 'student',
      role: 'student',
      tenantId
    },
    {
      id: 'stu_expired',
      name: 'Diego Ficha Vencida',
      email: 'diego@studiomov.test',
      phone: '(11) 99999-0002',
      goal: 'Força',
      assignedTrainerId: owner.id,
      mustChangePassword: false,
      saasRole: 'student',
      role: 'student',
      tenantId
    },
    {
      id: 'stu_soon_consistent',
      name: 'Eduarda Constante',
      email: 'eduarda@studiomov.test',
      phone: '(11) 99999-0003',
      goal: 'Condicionamento',
      assignedTrainerId: owner.id,
      mustChangePassword: false,
      saasRole: 'student',
      role: 'student',
      tenantId
    },
    {
      id: 'stu_trainer2',
      name: 'Felipe Aluno Bruno',
      email: 'felipe@studiomov.test',
      phone: '(11) 99999-0004',
      goal: 'Emagrecimento',
      assignedTrainerId: trainer2.id,
      mustChangePassword: false,
      saasRole: 'student',
      role: 'student',
      tenantId
    },
    {
      id: 'stu_onboarding_only',
      name: 'Gabriela Convite',
      email: 'gabriela@studiomov.test',
      phone: '(11) 99999-0005',
      goal: 'Saúde',
      assignedTrainerId: owner.id,
      mustChangePassword: false,
      saasRole: 'student',
      role: 'student',
      tenantId
    }
  ];

  const pendingInvite = {
    code: 'MOV12345',
    tenantId,
    studentId: 'stu_onboarding_only',
    email: 'gabriela@studiomov.test',
    role: 'student',
    uses: 0,
    maxUses: 1,
    expiresAt: Date.now() + 7 * 86400000
  };

  const db = { users: [owner, trainer2, ...students], invites: [pendingInvite] };
  for (const u of db.users) {
    upsertUserSqlite(tmpDir, u, null);
    evictStudentSummary(u.id);
  }

  // Estados individuais no SQLite
  writeUserStateSqlite(tmpDir, 'stu_missing', {
    routines: [],
    week: {},
    dayPlan: {},
    workouts: []
  });

  writeUserStateSqlite(tmpDir, 'stu_expired', {
    routines: [
      {
        id: 'r_exp',
        name: 'Treino A Força',
        ex: [{ id: '0043', name: 'Agachamento Livre', sets: 4, reps: 8, weight: 80 }],
        prescribedBy: { at: Date.now() - 35 * 86400000, trainerId: owner.id, trainerName: owner.name }
      }
    ],
    week: { 1: ['r_exp'], 3: ['r_exp'] },
    dayPlan: {},
    workouts: [
      { id: 'w_old', d: isoDaysAgo(10), name: 'Treino A Força', sets: [{ kg: 80, reps: 8, done: true }] }
    ]
  });

  writeUserStateSqlite(tmpDir, 'stu_soon_consistent', {
    routines: [
      {
        id: 'r_soon',
        name: 'Full Body Express',
        ex: [{ id: '0043', name: 'Agachamento Livre', sets: 3, reps: 10, weight: 60 }],
        prescribedBy: { at: Date.now() - 27 * 86400000, trainerId: owner.id, trainerName: owner.name }
      }
    ],
    week: { 1: ['r_soon'], 3: ['r_soon'], 5: ['r_soon'] },
    dayPlan: {},
    workouts: [
      {
        id: 'w_pr',
        d: isoDaysAgo(1),
        name: 'Full Body Express',
        note: 'Joelho ótimo hoje, subi carga no agachamento!',
        prs: [{ exId: '0043', type: '1rm', val: 120 }],
        sets: [{ kg: 70, reps: 10, done: true }]
      },
      { id: 'w_2', d: isoDaysAgo(3), name: 'Full Body Express', sets: [{ kg: 60, reps: 10, done: true }] },
      { id: 'w_3', d: isoDaysAgo(5), name: 'Full Body Express', sets: [{ kg: 60, reps: 10, done: true }] }
    ]
  });

  writeUserStateSqlite(tmpDir, 'stu_trainer2', {
    routines: [
      {
        id: 'r_bruno',
        name: 'Hipertrofia Superior',
        ex: [{ id: '0025', name: 'Supino Reto', sets: 4, reps: 10, weight: 50 }],
        prescribedBy: { at: Date.now() - 5 * 86400000, trainerId: trainer2.id, trainerName: trainer2.name }
      }
    ],
    week: { 2: ['r_bruno'], 4: ['r_bruno'] },
    dayPlan: {},
    workouts: [
      { id: 'w_b1', d: isoDaysAgo(2), name: 'Hipertrofia Superior', sets: [{ kg: 50, reps: 10, done: true }] }
    ]
  });

  writeUserStateSqlite(tmpDir, 'stu_onboarding_only', {
    routines: [
      {
        id: 'r_gab',
        name: 'Adaptação Inicial',
        ex: [{ id: '0025', name: 'Supino Reto', sets: 3, reps: 12, weight: 20 }],
        prescribedBy: { at: Date.now() - 2 * 86400000, trainerId: owner.id, trainerName: owner.name }
      }
    ],
    week: { 1: ['r_gab'], 4: ['r_gab'] },
    dayPlan: {},
    workouts: []
  });

  const routes = createSaasRoutes({
    json: (res, status, data, headers) => {
      res.status = status;
      res.data = data;
      res.headers = headers || {};
    },
    readBody: async req => req.body || {},
    readSession: () => owner,
    isAdmin: () => false,
    db,
    saveDb: () => {},
    dataDir: tmpDir,
    audit: () => {},
    makeSession: u => 'tok_' + u.id
  });

  return { tmpDir, tenantId, owner, trainer2, routes, db };
}

test('Fase 1 Copiloto: GET /api/gym/overview consolidado retorna fila, radar, feedbacks, KPIs e listas da equipe sem N+1', async () => {
  const env = makeCopilotEnv();
  try {
    const res = {};
    await env.routes['GET /api/gym/overview']({
      headers: { 'x-tenant-id': env.tenantId },
      url: '/api/gym/overview'
    }, res);

    assert.equal(res.status, 200);
    const data = res.data;

    // Estrutura consolidada para carregar Copiloto em 1 única requisição
    assert.ok(data.tenant);
    assert.ok(Array.isArray(data.students));
    assert.equal(data.students.length, 5);
    assert.ok(Array.isArray(data.templates));
    assert.ok(Array.isArray(data.team));
    assert.equal(data.team.length, 2);
    assert.ok(Array.isArray(data.invites));
    assert.ok(data.copilot);

    // Garante que helper interno _workoutDates não vaza no payload HTTP
    for (const st of data.students) {
      assert.equal(st._workoutDates, undefined);
    }

    const byId = Object.fromEntries(data.students.map(s => [s.id, s]));

    // Classificações do ciclo da ficha (30 dias padrão)
    assert.equal(byId.stu_missing.routineStatus, 'missing');
    assert.equal(byId.stu_missing.onboardingPending, true);

    assert.equal(byId.stu_expired.routineStatus, 'expired');
    assert.ok(byId.stu_expired.daysUntilRoutineExpiry < 0);
    assert.ok(byId.stu_expired.daysInactive >= 9 && byId.stu_expired.daysInactive <= 10);

    assert.equal(byId.stu_soon_consistent.routineStatus, 'expiring_soon');
    assert.equal(byId.stu_soon_consistent.daysUntilRoutineExpiry, 3);
    assert.equal(byId.stu_soon_consistent.weeklyGoalHit, true);

    assert.equal(byId.stu_trainer2.routineStatus, 'up_to_date');
    assert.equal(byId.stu_trainer2.assignedTrainerId, 'u_tr_bruno');

    assert.equal(byId.stu_onboarding_only.routineStatus, 'up_to_date');
    assert.equal(byId.stu_onboarding_only.onboardingPending, true);

    // Fila de Prioridades
    assert.deepEqual(data.copilot.priorityQueue.withoutRoutine.map(s => s.id), ['stu_missing']);
    assert.deepEqual(
      data.copilot.priorityQueue.expiringRoutines.map(s => s.id),
      ['stu_expired', 'stu_soon_consistent']
    );
    const onboardingIds = data.copilot.priorityQueue.pendingOnboarding.map(s => s.id).sort();
    assert.deepEqual(onboardingIds, ['stu_missing', 'stu_onboarding_only']);

    // Radar de Retenção & Constância
    assert.ok(data.copilot.retentionRadar.inactiveStudents.some(s => s.id === 'stu_expired'));
    assert.ok(data.copilot.retentionRadar.consistentStudents.some(s => s.id === 'stu_soon_consistent'));

    // Caixa de Entrada de Feedbacks Pós-Treino (w.note & w.prs)
    assert.equal(data.copilot.recentFeedbacks.length, 1);
    assert.equal(data.copilot.recentFeedbacks[0].studentId, 'stu_soon_consistent');
    assert.equal(data.copilot.recentFeedbacks[0].prCount, 1);
    assert.match(data.copilot.recentFeedbacks[0].note, /agachamento/i);

    // KPIs Pedagógicos
    const pk = data.copilot.pedagogicalKpis;
    assert.equal(pk.activeStudentsCount, 5);
    assert.equal(pk.withoutRoutineCount, 1);
    assert.equal(pk.expiringRoutineCount, 2);
    assert.equal(pk.routinesUpToDateCount, 2); // stu_trainer2 + stu_onboarding_only
    assert.equal(pk.routinesPendingCount, 3);
    assert.equal(pk.completedWeeklySessions, 4); // 3 de Eduarda + 1 de Felipe
  } finally {
    closeSqliteInstance(env.tmpDir);
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test('Fase 1.2 + Scope: GET /api/gym/students respeita routineCycleDays e POST /api/gym/templates salva modelo da ficha', async () => {
  const env = makeCopilotEnv();
  try {
    // Com routineCycleDays=45, ficha de 35 dias fica em dia (expira em 10d)
    const resStudents = {};
    await env.routes['GET /api/gym/students']({
      headers: { 'x-tenant-id': env.tenantId },
      url: '/api/gym/students?routineCycleDays=45'
    }, resStudents);

    assert.equal(resStudents.status, 200);
    const diego = resStudents.data.students.find(s => s.id === 'stu_expired');
    assert.equal(diego.routineStatus, 'up_to_date');
    assert.equal(diego.daysUntilRoutineExpiry, 10);

    // Salva ficha como Modelo na biblioteca e verifica persistência no overview
    const resTpl = {};
    await env.routes['POST /api/gym/templates']({
      headers: { 'x-tenant-id': env.tenantId },
      body: {
        name: 'Modelo Clonado Força',
        category: 'Força',
        suggestedDays: [1, 3],
        ex: [{ id: '0043', name: 'Agachamento Livre', sets: 4, reps: 8, weight: 80 }]
      }
    }, resTpl);
    assert.equal(resTpl.status, 200);
    assert.equal(resTpl.data.ok, true);

    const resOver = {};
    await env.routes['GET /api/gym/overview']({
      headers: { 'x-tenant-id': env.tenantId },
      url: '/api/gym/overview'
    }, resOver);
    assert.equal(resOver.status, 200);
    assert.ok(resOver.data.templates.some(t => t.name === 'Modelo Clonado Força'));
  } finally {
    closeSqliteInstance(env.tmpDir);
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});
