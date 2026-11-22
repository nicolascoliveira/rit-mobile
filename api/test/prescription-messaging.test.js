/**
 * api/test/prescription-messaging.test.js
 *
 * Testes automatizados para o fluxo completo de prescrição em lote e mensageria:
 *  1. Montagem de 3 fichas seguidas (Treino A com 8 exercícios, Treino B, Treino C) via lote:
 *     - Salva as 3 fichas no estado do aluno e cria 1 único `prescriptionNotice`;
 *     - Gera e envia 1 documento PDF consolidado no WhatsApp (/message/sendMedia) contendo todas as 3 fichas
 *       e todos os exercícios (sem truncar >6), acompanhado de legenda curta e escaneável;
 *     - Dispara exatamente 1 notificação Web Push (`tag: 'prescription-update'`) no app.
 *  2. Compatibilidade com chamadas sequenciais (A -> B -> C com `notifyWhatsApp: false, false, true`):
 *     - Na última chamada, consolida todas as 3 fichas prescritas no PDF + legenda em vez de enviar só a última.
 *  3. Idempotência e proteção anti-spam:
 *     - Clique duplo com mesmo `Idempotency-Key` ou novo request idêntico dentro da janela de cooldown
 *       não dispara WhatsApp nem Web Push duplicados.
 *  4. Particionamento automático do formatador de texto longo (`> maxChars`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSaasRoutes } from '../saas-routes.js';
import { createTenant } from '../tenants.js';
import { readStudentState } from '../trainer.js';
import { formatPrescribedRoutinesWhatsAppMessages } from '../whatsapp.js';
import { closeSqliteInstance, upsertUserSqlite } from '../sqlite.js';

function decodePdfOctals(rawLatin1) {
  return String(rawLatin1 || '').replace(/\\([0-7]{3})/g, (_, oct) =>
    Buffer.from([parseInt(oct, 8)]).toString('latin1')
  );
}

function makeTmpEnv(prefix = 'rit-presc-msg-') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const secret = 'f'.repeat(64);
  fs.writeFileSync(path.join(tmpDir, 'secret'), secret, { mode: 0o600 });

  createTenant(tmpDir, {
    id: 'ironpower',
    name: 'Iron Power Matriz',
    planId: 'pro',
    status: 'active',
    ownerName: 'Prof. Marcos Silva',
    ownerEmail: 'marcos@ironpower.test'
  });

  const trainer = {
    id: 'u_tr_marcos',
    name: 'Prof. Marcos Silva',
    email: 'marcos@ironpower.test',
    saasRole: 'gym_owner',
    role: 'trainer',
    tenantId: 'ironpower'
  };
  const student = {
    id: 'u_stu_lucas',
    name: 'Lucas Oliveira',
    email: 'lucas@ironpower.test',
    phone: '(11) 99888-7766',
    saasRole: 'student',
    role: 'student',
    tenantId: 'ironpower'
  };
  const db = { users: [trainer, student], invites: [] };
  upsertUserSqlite(tmpDir, trainer, null);
  upsertUserSqlite(tmpDir, student, null);

  const pushCalls = [];
  const routes = createSaasRoutes({
    json: (res, status, data, headers) => {
      res.status = status;
      res.data = data;
      res.headers = headers || {};
    },
    readBody: async req => req.body || {},
    readSession: () => trainer,
    isAdmin: () => false,
    db,
    saveDb: () => { },
    dataDir: tmpDir,
    audit: () => { },
    makeSession: u => 'tok_' + u.id,
    sendPush: (uid, payload) => {
      pushCalls.push({ uid, payload });
    }
  });

  const cleanup = () => {
    try { closeSqliteInstance(tmpDir); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return { tmpDir, trainer, student, db, routes, pushCalls, cleanup };
}

function sampleThreeWorkouts() {
  return [
    {
      name: 'Treino A — Peito & Tríceps',
      emoji: 'barbell',
      days: [1, 4],
      replaceSchedule: true,
      ex: [
        { id: '0025', name: 'Supino Reto com Barra', sets: 4, reps: 8, weight: 50, restSec: 120, note: 'Descer controlado' },
        { id: '0314', name: 'Supino Inclinado com Halteres', sets: 4, reps: 10, weight: 22, restSec: 90 },
        { id: '1030', name: 'Crucifixo Peck Deck', sets: 3, reps: 12, weight: 40, restSec: 75 },
        { id: '0188', name: 'Crossover Polia Média', sets: 3, reps: 14, weight: 15, restSec: 60 },
        { id: '0200', name: 'Tríceps Corda na Polia', sets: 4, reps: 12, weight: 25, restSec: 60 },
        { id: '0060', name: 'Tríceps Testa com Barra W', sets: 3, reps: 10, weight: 20, restSec: 75 },
        { id: '0201', name: 'Tríceps Francês Unilateral', sets: 3, reps: 12, weight: 10, restSec: 60 },
        { id: '0001', name: 'Abdominal Supra no Solo', sets: 4, reps: 20, weight: 0, restSec: 45 }
      ]
    },
    {
      name: 'Treino B — Costas & Bíceps',
      emoji: 'pullup',
      days: [2, 5],
      replaceSchedule: true,
      ex: [
        { id: '0198', name: 'Puxada Frontal Aberta', sets: 4, reps: 10, weight: 45, restSec: 90 },
        { id: '0027', name: 'Remada Curvada com Barra', sets: 4, reps: 8, weight: 40, restSec: 90 },
        { id: '0861', name: 'Remada Baixa Triângulo', sets: 3, reps: 12, weight: 45, restSec: 75 },
        { id: '0447', name: 'Rosca Direta Barra W', sets: 3, reps: 10, weight: 20, restSec: 75 },
        { id: '0313', name: 'Rosca Martelo com Halteres', sets: 3, reps: 12, weight: 12, restSec: 60 }
      ]
    },
    {
      name: 'Treino C — Pernas & Ombros',
      emoji: 'legs',
      days: [3, 6],
      replaceSchedule: true,
      ex: [
        { id: '0043', name: 'Agachamento Livre com Barra', sets: 4, reps: 8, weight: 70, restSec: 120 },
        { id: '0739', name: 'Leg Press 45°', sets: 4, reps: 12, weight: 140, restSec: 90 },
        { id: '0585', name: 'Cadeira Extensora', sets: 3, reps: 12, weight: 45, restSec: 75 },
        { id: '0405', name: 'Desenvolvimento com Halteres', sets: 4, reps: 10, weight: 16, restSec: 90 },
        { id: '0334', name: 'Elevação Lateral com Halteres', sets: 4, reps: 15, weight: 8, restSec: 60 }
      ]
    }
  ];
}

test('1 & 3. Lote com 3 fichas (Treinos A, B e C) gera 1 PDF completo no WhatsApp + 1 Push no app e bloqueia clique duplo', async () => {
  const env = makeTmpEnv('rit-presc-batch-');
  const originalFetch = globalThis.fetch;
  const waPayloads = [];

  globalThis.fetch = async (url, opts) => {
    waPayloads.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ key: { id: `wa_msg_${waPayloads.length}` } }) };
  };

  try {
    const workouts = sampleThreeWorkouts();
    const idemKey = crypto.randomUUID();

    // 1. Primeiro disparo em lote com Treinos A, B e C
    const res1 = {};
    await env.routes['POST /api/gym/prescribe']({
      headers: { 'x-tenant-id': 'ironpower', 'idempotency-key': idemKey },
      body: {
        studentId: env.student.id,
        replaceSchedule: true,
        notifyWhatsApp: true,
        awaitNotify: true,
        routines: workouts
      }
    }, res1);

    assert.equal(res1.status, 200);
    assert.equal(res1.data.ok, true);
    assert.equal(res1.data.routines.length, 3);
    assert.equal(res1.data.pushSent, true);
    assert.equal(res1.data.whatsapp.sent, true);
    assert.equal(res1.data.whatsapp.pdfFileName, 'ficha-treino-lucas-oliveira.pdf');

    // Estado do aluno salvo com as 3 fichas e prescriptionNotice consolidado
    const state = readStudentState(env.tmpDir, env.student.id);
    assert.equal(state.routines.length, 3);
    assert.ok(state.prescriptionNotice);
    assert.deepEqual(state.prescriptionNotice.routineNames, [
      'Treino A — Peito & Tríceps',
      'Treino B — Costas & Bíceps',
      'Treino C — Pernas & Ombros'
    ]);
    assert.equal(state.routines[0].prescribedBy.name, 'Prof. Marcos Silva');

    // Exatamente 1 Web Push disparado no app com todas as 3 fichas
    assert.equal(env.pushCalls.length, 1);
    assert.equal(env.pushCalls[0].uid, env.student.id);
    assert.equal(env.pushCalls[0].payload.tag, 'prescription-update');
    assert.ok(env.pushCalls[0].payload.title.includes('3 novas fichas'));
    assert.ok(env.pushCalls[0].payload.body.includes('Treino A'));
    assert.ok(env.pushCalls[0].payload.body.includes('Treino B'));
    assert.ok(env.pushCalls[0].payload.body.includes('Treino C'));

    // Exatamente 1 envio no WhatsApp via sendMedia (PDF + legenda concisa)
    assert.equal(waPayloads.length, 1);
    assert.ok(waPayloads[0].url.includes('/message/sendMedia/'));
    const body = waPayloads[0].body;
    assert.equal(body.number, '5511998887766');
    assert.equal(body.mediatype, 'document');
    assert.equal(body.mimetype, 'application/pdf');
    assert.equal(body.fileName, 'ficha-treino-lucas-oliveira.pdf');

    // Legenda curta citando as 3 fichas e o link do app
    assert.ok(body.caption.length < 900, `Esperava legenda curta, veio ${body.caption.length} chars`);
    assert.ok(body.caption.includes('Treino A — Peito & Tríceps'));
    assert.ok(body.caption.includes('Treino B — Costas & Bíceps'));
    assert.ok(body.caption.includes('Treino C — Pernas & Ombros'));
    assert.ok(body.caption.includes('?tenant=ironpower'));

    // PDF contém %PDF-1.4, todas as 3 fichas e TODOS os exercícios sem truncamento (>6)
    const pdfText = decodePdfOctals(Buffer.from(body.media, 'base64').toString('latin1'));
    assert.ok(pdfText.startsWith('%PDF-1.4'));
    assert.ok(pdfText.includes('Treino A'));
    assert.ok(pdfText.includes('Treino B'));
    assert.ok(pdfText.includes('Treino C'));
    assert.ok(pdfText.includes('Tríceps Francês Unilateral'));
    assert.ok(pdfText.includes('Abdominal Supra no Solo'));
    assert.ok(pdfText.includes('Agachamento Livre com Barra'));
    assert.ok(pdfText.includes('Elevação Lateral com Halteres'));
    assert.ok(pdfText.includes('50 kg'));
    assert.ok(pdfText.includes('120s'));
    assert.ok(pdfText.includes('Descer controlado'));

    // 3a. Clique duplo (mesmo Idempotency-Key) é reproduzido sem novo envio WhatsApp nem Push
    const resReplay = {};
    await env.routes['POST /api/gym/prescribe']({
      headers: { 'x-tenant-id': 'ironpower', 'idempotency-key': idemKey },
      body: {
        studentId: env.student.id,
        replaceSchedule: true,
        notifyWhatsApp: true,
        awaitNotify: true,
        routines: workouts
      }
    }, resReplay);
    assert.equal(resReplay.status, 200);
    assert.equal(resReplay.headers['Idempotency-Replayed'], 'true');
    assert.equal(waPayloads.length, 1);
    assert.equal(env.pushCalls.length, 1);

    // 3b. Novo clique idêntico com outro Idempotency-Key dentro do cooldown é deduplicado sem spam
    const resDup = {};
    await env.routes['POST /api/gym/prescribe']({
      headers: { 'x-tenant-id': 'ironpower', 'idempotency-key': crypto.randomUUID() },
      body: {
        studentId: env.student.id,
        replaceSchedule: true,
        notifyWhatsApp: true,
        awaitNotify: true,
        routines: workouts
      }
    }, resDup);
    assert.equal(resDup.status, 200);
    assert.equal(resDup.data.pushSent, false);
    assert.equal(resDup.data.whatsapp.deduplicated, true);
    assert.equal(waPayloads.length, 1);
    assert.equal(env.pushCalls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

test('2. Chamadas sequenciais A -> B -> C (notifyWhatsApp: false, false, true) também consolidam as 3 fichas no PDF final', async () => {
  const env = makeTmpEnv('rit-presc-seq-');
  const originalFetch = globalThis.fetch;
  const waPayloads = [];

  globalThis.fetch = async (url, opts) => {
    waPayloads.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ key: { id: `seq_${waPayloads.length}` } }) };
  };

  try {
    const workouts = sampleThreeWorkouts();
    for (let i = 0; i < workouts.length; i++) {
      const w = workouts[i];
      const r = {};
      await env.routes['POST /api/gym/prescribe']({
        headers: { 'x-tenant-id': 'ironpower' },
        body: {
          studentId: env.student.id,
          days: w.days,
          replaceSchedule: true,
          notifyWhatsApp: i === workouts.length - 1,
          awaitNotify: i === workouts.length - 1,
          routine: { name: w.name, emoji: w.emoji, ex: w.ex }
        }
      }, r);
      assert.equal(r.status, 200);
    }

    assert.equal(env.pushCalls.length, 1);
    assert.equal(waPayloads.length, 1);
    assert.equal(waPayloads[0].mediatype, 'document');
    const pdfText = decodePdfOctals(Buffer.from(waPayloads[0].media, 'base64').toString('latin1'));
    assert.ok(pdfText.includes('Treino A'));
    assert.ok(pdfText.includes('Treino B'));
    assert.ok(pdfText.includes('Treino C'));
    assert.ok(pdfText.includes('Abdominal Supra no Solo'));
  } finally {
    globalThis.fetch = originalFetch;
    env.cleanup();
  }
});

test('4. Plano extenso acima do limite de caracteres divide automaticamente no formatador textual sem perder exercícios', () => {
  const bigRoutines = ['A', 'B', 'C', 'D', 'E'].map((letter, idx) => ({
    id: `r_${letter}`,
    name: `Treino ${letter} — Divisão Especial ${idx + 1}`,
    ex: Array.from({ length: 8 }, (_, j) => ({
      name: `Exercício ${letter}${j + 1} Movimento Guiado Completo`,
      sets: 4,
      reps: '10-12',
      weight: 30 + j * 5,
      restSec: 90,
      note: 'Controle excêntrico de 3 segundos em todas as séries'
    }))
  }));

  const parts = formatPrescribedRoutinesWhatsAppMessages({
    studentName: 'Fernanda Lima',
    routines: bigRoutines,
    week: { 1: ['r_A'], 2: ['r_B'], 3: ['r_C'], 4: ['r_D'], 5: ['r_E'] },
    tenantId: 'ironpower',
    tenantName: 'Iron Power Matriz',
    trainerName: 'Prof. Marcos Silva',
    maxChars: 2200
  });

  assert.ok(parts.length >= 2, `Esperado dividir em >=2 partes, obtido ${parts.length}`);
  for (let i = 0; i < parts.length; i++) {
    assert.ok(parts[i].includes(`Parte ${i + 1}/${parts.length}`));
  }
  const joined = parts.join('\n');
  for (const letter of ['A', 'B', 'C', 'D', 'E']) {
    assert.ok(joined.includes(`TREINO ${letter}`));
    assert.ok(joined.includes(`Exercício ${letter}8 Movimento Guiado Completo`));
  }
});
