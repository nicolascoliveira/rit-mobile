import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanWhatsAppPhone,
  formatWorkoutWhatsAppMessage,
  formatPrescribedRoutineWhatsAppMessage,
  formatChurnRecoveryWhatsAppMessage,
  notifyWorkoutCompletedIfAny,
  notifyRoutinePrescribed,
  dispatchWhatsAppWithRetry,
  enqueueWhatsAppBatch,
  flushWhatsAppOutbox,
  getTenantWhatsAppOutbox,
  validateEvolutionUrl,
  fetchEvolutionQrCode,
  disconnectEvolutionInstance,
  sendEvolutionTextMessage
} from '../whatsapp.js';
import { getSqliteInstance } from '../sqlite.js';

test('cleanWhatsAppPhone normalizes Brazilian and international phone numbers', () => {
  assert.equal(cleanWhatsAppPhone('(11) 98765-4321'), '5511987654321');
  assert.equal(cleanWhatsAppPhone('11987654321'), '5511987654321');
  assert.equal(cleanWhatsAppPhone('+55 (11) 98765-4321'), '5511987654321');
  assert.equal(cleanWhatsAppPhone('5511987654321'), '5511987654321');
  assert.equal(cleanWhatsAppPhone('(21) 8888-7777'), '552188887777');
  assert.equal(cleanWhatsAppPhone(''), null);
  assert.equal(cleanWhatsAppPhone(null), null);
  assert.equal(cleanWhatsAppPhone('12345'), null);
});

test('formatWorkoutWhatsAppMessage creates rich WhatsApp report for personal trainer', () => {
  const workout = {
    id: 'w_test_1',
    d: '2026-11-07',
    name: 'Treino A — Peito & Tríceps',
    start: 1731000000000,
    end: 1731003120000, // 52 min
    vol: 4680,
    prs: ['0025'],
    entries: [
      {
        id: '0025',
        name: 'Supino Reto com Barra',
        sets: [
          { w: 40, r: 10, done: true, warmup: true },
          { w: 60, r: 10, done: true, rir: 1 },
          { w: 60, r: 10, done: true, rir: 1 }
        ]
      },
      {
        id: '0314',
        name: 'Supino Inclinado com Halteres',
        sets: [
          { w: 18.5, r: 10, done: true, rir: 2 },
          { w: 18.5, r: 10, done: true, rir: 2 }
        ]
      },
      {
        id: '0274',
        name: 'Abdominal no Chão',
        sets: [
          { w: 0, r: 20, done: true, rir: 2 }
        ]
      }
    ],
    note: 'Senti o ombro bem firme hoje!'
  };

  const msg = formatWorkoutWhatsAppMessage({
    studentName: 'Lucas Silveira',
    workout,
    tenantName: 'Arena Cross'
  });

  assert.ok(msg.includes('🏋️‍♂️ *Treino Concluído com Sucesso!*'));
  assert.ok(msg.includes('👤 *Aluno:* Lucas Silveira'));
  assert.ok(msg.includes('📋 *Ficha:* Treino A — Peito & Tríceps'));
  assert.ok(msg.includes('52 min'));
  assert.ok(msg.includes('4.680 kg'));
  assert.ok(msg.includes('1. *Supino Reto com Barra*\n   2 séries • *60 kg* × 10 reps 🏆 *Novo Recorde!*'));
  assert.ok(msg.includes('2. *Supino Inclinado com Halteres*\n   2 séries • *18,5 kg* × 10 reps'));
  assert.ok(msg.includes('3. *Abdominal no Chão*\n   1 série • Peso corporal × 20 reps'));
  assert.ok(!msg.includes('18.5 kg'));
  assert.ok(msg.includes('💬 *Intensidade Relatada:* Intensidade muito alta'));
  assert.ok(msg.includes('📝 *Mensagem do Aluno:* "Senti o ombro bem firme hoje!"'));
  assert.ok(msg.includes('Arena Cross'));
});

test('notifyWorkoutCompletedIfAny detects new workout completion and respects tenant preferences', async () => {
  const curState = {
    workouts: [{ id: 'w_old_1', d: '2026-11-05' }]
  };
  const newState = {
    workouts: [
      { id: 'w_old_1', d: '2026-11-05' },
      { id: 'w_new_2', d: '2026-11-07', name: 'Treino B', vol: 3200 }
    ]
  };

  const user = {
    id: 'u_student_1',
    name: 'Mariana Souza',
    tenantId: 'gym_demo',
    assignedTrainerId: 'u_trainer_1'
  };

  const db = {
    users: [
      { id: 'u_trainer_1', name: 'Personal Marcos', phone: '11999998888', tenantId: 'gym_demo' }
    ]
  };

  // 1. When no new workouts exist
  const noChange = await notifyWorkoutCompletedIfAny({
    dataDir: '/tmp',
    user,
    curState: newState,
    newState,
    db
  });
  assert.equal(noChange.notified, 0);

  // 2. When new workout is detected
  let intercepted = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    intercepted = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, json: async () => ({ status: 'success' }) };
  };

  try {
    const res = await notifyWorkoutCompletedIfAny({
      dataDir: '/tmp',
      user,
      curState,
      newState,
      db
    });
    assert.equal(res.notified, 1);
    assert.equal(res.targetPhone, '11999998888');
    assert.equal(res.targetName, 'Personal Marcos');
    assert.ok(intercepted);
    assert.equal(intercepted.body.number, '5511999998888');
    assert.ok(intercepted.body.text.includes('Mariana Souza'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('formatPrescribedRoutineWhatsAppMessage and notifyRoutinePrescribed notify student when routine is prescribed', async () => {
  const routine = {
    name: 'Treino Hipertrofia — Costas & Bíceps',
    desc: 'Foco em cadência controlada 2-0-2',
    ex: [
      { id: 'ex1', name: 'Puxada Alta Aberta', sets: 4, reps: '10-12' },
      { id: 'ex2', name: 'Remada Curvada', sets: 4, reps: '8-10' }
    ]
  };

  const msg = formatPrescribedRoutineWhatsAppMessage({
    studentName: 'Rafael Costa',
    routine,
    days: [1, 4],
    tenantName: 'Rit Performance',
    trainerName: 'Prof. Amanda'
  });

  assert.ok(msg.includes('📋 *Nova Ficha de Treino Disponível!*'));
  assert.ok(msg.includes('Olá, *Rafael*!'));
  assert.ok(msg.includes('Treino Hipertrofia — Costas & Bíceps'));
  assert.ok(msg.includes('Prof. Amanda'));
  assert.ok(msg.includes('Seg, Qui'));
  assert.ok(msg.includes('Puxada Alta Aberta'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rit-wa-prescribe-'));
  const originalFetch = globalThis.fetch;
  let sentPayload = null;
  globalThis.fetch = async (_url, opts) => {
    sentPayload = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ key: { id: 'msg_1' } }) };
  };

  try {
    const res = await notifyRoutinePrescribed({
      dataDir: tmpDir,
      tenantId: 'gym_test',
      student: { id: 'stu_1', name: 'Rafael Costa', phone: '(11) 97777-6666' },
      routine,
      days: [1, 4],
      trainerUser: { name: 'Prof. Amanda' }
    });
    assert.equal(res.ok, true);
    assert.ok(sentPayload);
    assert.equal(sentPayload.number, '5511977776666');
    assert.ok(sentPayload.text.includes('Treino Hipertrofia'));
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('dispatchWhatsAppWithRetry queues failed messages and flushWhatsAppOutbox delivers them on retry', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rit-wa-outbox-'));
  const originalFetch = globalThis.fetch;
  let shouldFail = true;

  globalThis.fetch = async () => {
    if (shouldFail) {
      throw new Error('ECONNREFUSED Evolution offline');
    }
    return { ok: true, status: 200, json: async () => ({ status: 'PENDING' }) };
  };

  try {
    const msg = formatChurnRecoveryWhatsAppMessage({
      studentName: 'Camila Lima',
      daysInactive: 12,
      tenantName: 'Rit Studio'
    });
    assert.ok(msg.includes('12 dias'));

    const firstAttempt = await dispatchWhatsAppWithRetry({
      dataDir: tmpDir,
      tenantId: 'gym_outbox',
      kind: 'churn_recovery',
      recipientName: 'Camila Lima',
      phone: '11988887777',
      message: msg
    });

    assert.equal(firstAttempt.ok, false);
    assert.equal(firstAttempt.queued, true);

    const statusBefore = getTenantWhatsAppOutbox(tmpDir, 'gym_outbox');
    assert.equal(statusBefore.queuedCount, 1);

    // Gateway comes back online
    shouldFail = false;
    const flushRes = await flushWhatsAppOutbox(tmpDir, { force: true, tenantId: 'gym_outbox' });
    assert.equal(flushRes.sent, 1);
    assert.equal(flushRes.stillQueued, 0);

    const statusAfter = getTenantWhatsAppOutbox(tmpDir, 'gym_outbox');
    assert.equal(statusAfter.queuedCount, 0);
    assert.equal(statusAfter.sentCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validateEvolutionUrl prevents SSRF attacks, restricts platform ports, and supports allowInternalPlatform=false', () => {
  // Endpoints internos exatos do gateway da plataforma
  assert.equal(validateEvolutionUrl('http://localhost:8082').ok, true);
  assert.equal(validateEvolutionUrl('http://127.0.0.1:8082').ok, true);
  assert.equal(validateEvolutionUrl('http://evolution-api:8080').ok, true);
  assert.equal(validateEvolutionUrl('https://evolution.minhaacademia.com.br').ok, true);

  // Portas arbitrárias em localhost/loopback e URLs internas para tenants customizados são bloqueadas
  assert.equal(validateEvolutionUrl('http://localhost:3000').ok, false);
  assert.equal(validateEvolutionUrl('http://127.0.0.1:5432').ok, false);
  assert.equal(validateEvolutionUrl('http://localhost:8082', { allowInternalPlatform: false }).ok, false);
  assert.equal(validateEvolutionUrl('http://127.0.0.1:8082', { allowInternalPlatform: false }).ok, false);
  assert.equal(validateEvolutionUrl('http://evolution-api:8080', { allowInternalPlatform: false }).ok, false);

  // Tentativas de SSRF bloqueadas
  assert.equal(validateEvolutionUrl('http://169.254.169.254/latest/meta-data').ok, false);
  assert.equal(validateEvolutionUrl('http://192.168.1.1:8080').ok, false);
  assert.equal(validateEvolutionUrl('http://10.0.0.5:8080').ok, false);
  assert.equal(validateEvolutionUrl('http://172.20.0.2:8080').ok, false);
  assert.equal(validateEvolutionUrl('https://[::ffff:127.0.0.1]').ok, false);
  assert.equal(validateEvolutionUrl('https://evo.internal').ok, false);
  assert.equal(validateEvolutionUrl('https://redis').ok, false);
  assert.equal(validateEvolutionUrl('https://user:pass@evolution.example.com').ok, false);
  assert.equal(validateEvolutionUrl('ftp://evolution.example.com').ok, false);
  assert.equal(validateEvolutionUrl('http://external-evo.example.com').ok, false); // externo requer https
});

test('fetchEvolutionQrCode auto-creates missing instance on 404 and returns QR base64', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let connectAttempt = 0;

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body || null });
    if (String(url).includes('/instance/connect/rit')) {
      connectAttempt += 1;
      if (connectAttempt === 1) {
        return {
          ok: false,
          status: 404,
          json: async () => ({
            status: 404,
            error: 'Not Found',
            response: { message: ['The "rit" instance does not exist'] }
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          pairingCode: null,
          code: '2@MOCKQR',
          base64: 'data:image/png;base64,MOCKBASE64',
          count: 1
        })
      };
    }
    if (String(url).includes('/instance/create')) {
      return {
        ok: true,
        status: 201,
        json: async () => ({
          instance: { instanceName: 'rit', status: 'connecting' }
        })
      };
    }
    return { ok: false, status: 500, json: async () => ({ error: 'unexpected' }) };
  };

  try {
    const res = await fetchEvolutionQrCode({
      url: 'http://evolution-api:8080',
      apiKey: 'secret-test',
      instance: 'rit',
      retryDelayMs: 0
    });
    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    assert.equal(res.connected, false);
    assert.equal(res.base64, 'data:image/png;base64,MOCKBASE64');
    assert.equal(calls.length, 3);
    assert.equal(calls[1].method, 'POST');
    assert.equal(JSON.parse(calls[1].body).integration, 'WHATSAPP-BAILEYS');
    assert.equal(JSON.parse(calls[1].body).qrcode, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchEvolutionQrCode surfaces non-404 Evolution errors instead of returning empty QR', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'Unauthorized', response: { message: 'Invalid apikey' } })
  });

  try {
    const res = await fetchEvolutionQrCode({
      url: 'http://evolution-api:8080',
      apiKey: 'wrong-key',
      instance: 'rit',
      retryDelayMs: 0
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
    assert.match(res.error, /Invalid apikey/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('notifyWorkoutCompletedIfAny matches catalogueById via w.rid and falls back to gym_owner/gym_manager phone', async () => {
  const { notifyWorkoutCompletedIfAny } = await import('../whatsapp.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rit-wa-fallback-'));
  const originalFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ status: 'success' }) };
  };

  try {
    const db = {
      users: [
        { id: 'stu_fb', name: 'Ana Paula', role: 'student', saasRole: 'student', tenantId: 'gym_fb' },
        { id: 'mgr_fb', name: 'Gestor Lucas', role: 'trainer', saasRole: 'gym_manager', tenantId: 'gym_fb', phone: '21987654321' }
      ]
    };
    const res = await notifyWorkoutCompletedIfAny({
      dataDir: tmpDir,
      user: db.users[0],
      curState: { workouts: [] },
      newState: {
        routines: [
          { id: 'rot_hyper_a', name: 'Hipertrofia Full', prescribedBy: { name: 'Coach Bia' } }
        ],
        workouts: [
          {
            id: 'wk_fb_1',
            ts: Date.now(),
            rid: 'rot_hyper_a',
            name: 'Hipertrofia Full',
            start: Date.now() - 42 * 60000,
            end: Date.now(),
            entries: [
              { id: 'ex_supino', sets: [{ done: true, w: 60, r: 10 }] }
            ]
          }
        ]
      },
      db,
      catalogueById: new Map([
        ['ex_supino', { id: 'ex_supino', name: 'Supino Reto Barra' }]
      ])
    });

    assert.equal(res.notified, 1);
    assert.equal(res.targetPhone, '21987654321');
    assert.ok(sentBody);
    assert.equal(sentBody.number, '5521987654321');
    assert.ok(sentBody.text.includes('Coach Bia'));
    assert.ok(sentBody.text.includes('Supino Reto Barra'));
    assert.ok(sentBody.text.includes('Ana Paula'));
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sendEvolutionTextMessage and fetchEvolutionQrCode fail closed in production without Evolution API key', async () => {
  const originalFetch = globalThis.fetch;
  const origNodeEnv = process.env.NODE_ENV;
  const hadApiKey = Object.prototype.hasOwnProperty.call(process.env, 'EVOLUTION_API_KEY');
  const origApiKey = process.env.EVOLUTION_API_KEY;
  let fetchCalls = 0;
  let lastHeaders = null;

  globalThis.fetch = async (_url, opts) => {
    fetchCalls += 1;
    lastHeaders = opts?.headers || null;
    return { ok: true, status: 200, json: async () => ({ status: 'success' }) };
  };

  try {
    process.env.NODE_ENV = 'production';
    delete process.env.EVOLUTION_API_KEY;

    const sendRes = await sendEvolutionTextMessage({
      phone: '11999998888',
      message: 'Oi',
      config: { url: 'http://localhost:8082', instance: 'rit' },
      tenantSettings: {}
    });
    assert.equal(sendRes.ok, false);
    assert.equal(sendRes.status, 503);
    assert.equal(fetchCalls, 0);

    const qrRes = await fetchEvolutionQrCode({
      url: 'http://localhost:8082',
      instance: 'rit'
    });
    assert.equal(qrRes.ok, false);
    assert.equal(qrRes.status, 503);
    assert.equal(fetchCalls, 0);

    const customKeyRes = await sendEvolutionTextMessage({
      phone: '11999998888',
      message: 'Oi com chave própria',
      config: { url: 'http://localhost:8082', apiKey: 'explicit-prod-key', instance: 'rit' },
      tenantSettings: {}
    });
    assert.equal(customKeyRes.ok, true);
    assert.equal(fetchCalls, 1);
    assert.equal(lastHeaders?.apikey, 'explicit-prod-key');
  } finally {
    globalThis.fetch = originalFetch;
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
    if (hadApiKey) process.env.EVOLUTION_API_KEY = origApiKey;
    else delete process.env.EVOLUTION_API_KEY;
  }
});

test('Etapa 3: DNS rebinding bloqueado, sem fallback de chave da plataforma em URL customizada e outbox sem segredo em repouso', async () => {
  const originalFetch = globalThis.fetch;
  const hadApiKey = Object.prototype.hasOwnProperty.call(process.env, 'EVOLUTION_API_KEY');
  const origApiKey = process.env.EVOLUTION_API_KEY;
  let fetchCalls = 0;
  let lastFetchOpts = null;

  globalThis.fetch = async (_url, opts) => {
    fetchCalls += 1;
    lastFetchOpts = opts || null;
    return { ok: true, status: 200, json: async () => ({ status: 'success' }) };
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rit-wa-etapa3-'));
  try {
    process.env.EVOLUTION_API_KEY = 'PLATFORM_SECRET_MASTER_KEY';

    // 1. Custom tenant URL without key NEVER falls back to process.env.EVOLUTION_API_KEY (even outside production)
    const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const noFallbackSend = await sendEvolutionTextMessage({
      phone: '11999998888',
      message: 'Teste sem chave',
      tenantSettings: { evolutionUrl: 'https://custom-evo.example.com', evolutionInstance: 'inst1' },
      lookup: publicLookup
    });
    assert.equal(noFallbackSend.ok, false);
    assert.equal(noFallbackSend.status, 503);
    assert.equal(fetchCalls, 0);

    const noFallbackDisc = await disconnectEvolutionInstance({
      url: 'https://custom-evo.example.com',
      instance: 'inst1',
      lookup: publicLookup
    });
    assert.equal(noFallbackDisc.ok, false);
    assert.equal(noFallbackDisc.status, 503);
    assert.equal(fetchCalls, 0);

    // 2. DNS rebinding to loopback / cloud metadata / RFC1918 fails before fetch
    for (const badIp of ['127.0.0.1', '169.254.169.254', '10.0.0.5', '::1']) {
      const rebindSend = await sendEvolutionTextMessage({
        phone: '11999998888',
        message: 'Rebind',
        tenantSettings: {
          evolutionUrl: 'https://rebind.example.com',
          evolutionApiKey: 'tenant-key',
          evolutionInstance: 'inst1'
        },
        lookup: async () => [{ address: badIp, family: badIp.includes(':') ? 6 : 4 }]
      });
      assert.equal(rebindSend.ok, false);
      assert.equal(rebindSend.status, 400);
      assert.equal(fetchCalls, 0);
    }

    // 3. Valid external FQDN with explicit tenant key passes DNS verification and sets redirect: 'error'
    const validCustom = await sendEvolutionTextMessage({
      phone: '11999998888',
      message: 'Com chave própria',
      tenantSettings: {
        evolutionUrl: 'https://custom-evo.example.com',
        evolutionApiKey: 'tenant-own-key',
        evolutionInstance: 'inst1'
      },
      lookup: publicLookup
    });
    assert.equal(validCustom.ok, true);
    assert.equal(fetchCalls, 1);
    assert.equal(lastFetchOpts?.headers?.apikey, 'tenant-own-key');
    assert.equal(lastFetchOpts?.redirect, 'error');

    // 4. whatsapp_outbox and kv_store never persist evolutionApiKey in plaintext
    globalThis.fetch = async () => { throw new Error('offline'); };
    await dispatchWhatsAppWithRetry({
      dataDir: tmpDir,
      tenantId: 'gym_sec',
      kind: 'manual',
      recipientName: 'Aluno',
      phone: '11988887777',
      message: 'Mensagem outbox',
      tenantSettings: {
        evolutionUrl: 'https://custom-evo.example.com',
        evolutionApiKey: 'SECRET_MUST_NOT_PERSIST',
        evolutionInstance: 'inst_sec'
      }
    });
    enqueueWhatsAppBatch({
      dataDir: tmpDir,
      tenantId: 'gym_sec',
      kind: 'churn_recovery',
      items: [{ phone: '11977776666', recipientName: 'Aluno 2', message: 'Lembrete' }],
      tenantSettings: {
        evolutionUrl: 'https://custom-evo.example.com',
        evolutionApiKey: 'SECRET_MUST_NOT_PERSIST',
        evolutionInstance: 'inst_sec'
      }
    });

    const inst = getSqliteInstance(tmpDir);
    const rows = inst.db.prepare('SELECT data FROM whatsapp_outbox').all();
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.data.includes('SECRET_MUST_NOT_PERSIST'), false);
      const parsed = JSON.parse(r.data);
      assert.equal(parsed.tenantSettings?.evolutionApiKey, undefined);
      assert.equal(parsed.tenantSettings?.evolutionApiKeyEnc, undefined);
    }
    const kv = inst.stmts.getKv.get('whatsapp_outbox');
    assert.ok(kv?.value);
    assert.equal(kv.value.includes('SECRET_MUST_NOT_PERSIST'), false);
    const outbox = getTenantWhatsAppOutbox(tmpDir, 'gym_sec');
    assert.equal(outbox.queue[0]?.tenantSettings?.evolutionApiKey, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (hadApiKey) process.env.EVOLUTION_API_KEY = origApiKey;
    else delete process.env.EVOLUTION_API_KEY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
