/**
 * api/test/race-conditions.test.js
 *
 * Suíte automatizada de concorrência real (`Promise.all` com requisições simultâneas)
 * provando que apenas 1 mutação prevalece em cada ponto crítico de corrida:
 *
 *  1. Checkout PIX duplo (`POST /api/saas/billing/checkout-pix` + `reservePixCheckoutInvoice`)
 *  2. Confirmação dupla de pagamento (`POST /api/saas/billing/simulate-pix` / `confirmTenantPayment`)
 *  3. Matrícula concorrente no limite de vagas + e-mail duplicado (`POST /api/gym/students`)
 *  4. Cadastro HTTP simultâneo com convite único e e-mail duplicado (`POST /api/register/password`)
 *  5. Setup inicial simultâneo de Super Admin (`POST /api/saas/auth/setup-admin`)
 *  6. Importação simultânea de modelos padrão (`POST /api/gym/templates/import-defaults`)
 *  7. Prescrição simultânea de rotinas para o mesmo aluno (`prescribeRoutineToStudent` atômico)
 *  8. Sincronização concorrente com CAS (`PUT /api/data` em `server.js`)
 *  9. Pareamento único Watch e Device Link (`POST /api/watch/redeem` & `consumeDeviceLinkSqlite`)
 * 10. Lote WhatsApp anti-churn e Worker Outbox (`POST /api/gym/whatsapp/churn-batch` & `flushWhatsAppOutbox`)
 * 11. Cota diária do Coach IA (`bumpCoachDailySqlite` & `coachJobs.enqueue` com teto = 1)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { boundPort, sampleState, writeState } from './helpers.mjs';
import { createSaasRoutes } from '../saas-routes.js';
import { createTenant, confirmTenantPayment, getTenant } from '../tenants.js';
import { prescribeRoutineToStudent } from '../trainer.js';
import { flushWhatsAppOutbox } from '../whatsapp.js';
import {
  getSqliteInstance,
  closeSqliteInstance,
  saveCoreDbToSqlite,
  updateUserStateAtomicSqlite,
  consumeDeviceLinkSqlite,
  bumpCoachDailySqlite,
  upsertUserSqlite,
  runInTransaction
} from '../sqlite.js';

const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_SECRET = 'd'.repeat(64);
const ORIGIN = 'http://localhost:8080';

function makeTempDir(prefix = 'rit-race-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'secret'), TEST_SECRET, { mode: 0o600 });
  return dir;
}

function cleanupTempDir(dir) {
  try { closeSqliteInstance(dir); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

function createSaasHarness({ initialUsers = [], user = null } = {}) {
  const dataDir = makeTempDir('rit-saas-race-');
  const db = {
    users: initialUsers,
    creds: [],
    subs: [],
    invites: [],
    deviceLinks: [],
    watches: []
  };
  let activeUser = user;
  const routes = createSaasRoutes({
    json: (res, status, data) => { res.status = status; res.data = data; },
    readBody: async req => req.body || {},
    readSession: () => activeUser,
    isAdmin: u => Boolean(u && u.admin === true),
    db,
    saveDb: () => {},
    dataDir,
    audit: () => {},
    makeSession: u => 'tok_' + u.id
  });

  const callRoute = async (routeKey, { headers = {}, body = {}, url = routeKey.split(' ')[1], caller = activeUser } = {}) => {
    const prevUser = activeUser;
    if (caller !== undefined) activeUser = caller;
    const res = {};
    try {
      await routes[routeKey]({ headers, body, url }, res);
    } finally {
      activeUser = prevUser;
    }
    return res;
  };

  return { dataDir, db, routes, callRoute, setUser: u => { activeUser = u; } };
}

function mintSession(uid, sv = 0, secret = TEST_SECRET) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

async function startRealServer(t, { dbInit = {}, env = {} } = {}) {
  const dataDir = makeTempDir('rit-srv-race-');
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [], creds: [], subs: [], invites: [], deviceLinks: [], watches: [], ...dbInit
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      ORIGIN,
      PORTAL_URL: ORIGIN,
      RP_ID: 'localhost',
      PASSWORD_LOGIN: '1',
      TRUST_PROXY: '1',
      SAAS_DEMO: '1',
      ...env
    }
  });
  const h = { api: '', log: '', dataDir };
  child.stdout.on('data', d => { h.log += d; });
  child.stderr.on('data', d => { h.log += d; });
  t.after(() => {
    child.kill('SIGKILL');
    cleanupTempDir(dataDir);
  });
  h.api = `http://127.0.0.1:${await boundPort(child, () => h.log)}`;
  h.req = async (method, urlPath, { body, cookie, ip = '198.51.100.10', headers = {} } = {}) => {
    const r = await fetch(`${h.api}${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'same-origin',
        Origin: ORIGIN,
        'X-Forwarded-For': ip,
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    const setCookie = r.headers.getSetCookie().find(c => c.startsWith('gymsid=') && !c.startsWith('gymsid=;'));
    return { status: r.status, body: parsed, cookie: setCookie ? setCookie.split(';')[0] : null };
  };
  return h;
}

/* =========================================================================
 * 1. Duplicidade de Checkout PIX (POST /api/saas/billing/checkout-pix)
 * ========================================================================= */
test('Race 1: duas requisições simultâneas de checkout PIX geram apenas 1 fatura e 1 chamada ao Mercado Pago', async t => {
  const owner = { id: 'u_owner_pix', name: 'Gestor Pix', saasRole: 'gym_owner', role: 'trainer', tenantId: 'ironpix' };
  const h = createSaasHarness({ initialUsers: [owner], user: owner });
  t.after(() => cleanupTempDir(h.dataDir));

  createTenant(h.dataDir, { id: 'ironpix', name: 'Iron Pix', planId: 'pro', ownerName: 'Gestor Pix', ownerEmail: 'pix@iron.com' });

  const prevToken = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  const origFetch = globalThis.fetch;
  let mpCalls = 0;
  let releaseMp;
  const mpBarrier = new Promise(r => { releaseMp = r; });

  process.env.MERCADO_PAGO_ACCESS_TOKEN = 'APP_USR-race-test-valid-token-123456';
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://api.mercadopago.com/v1/payments')) {
      mpCalls++;
      await mpBarrier;
      return new Response(JSON.stringify({
        id: 987654321,
        status: 'pending',
        date_of_expiration: new Date(Date.now() + 1800_000).toISOString(),
        point_of_interaction: {
          transaction_data: {
            qr_code: '00020101021226850014br.gov.bcb.pix-race',
            qr_code_base64: 'ZmFrZXFy',
            ticket_url: 'https://mpago.la/race'
          }
        }
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    return origFetch(url, opts);
  };

  try {
    const p1 = h.callRoute('POST /api/saas/billing/checkout-pix', {
      headers: { host: 'localhost:8080' },
      body: { planId: 'pro', cycle: 'monthly' }
    });
    const p2 = h.callRoute('POST /api/saas/billing/checkout-pix', {
      headers: { host: 'localhost:8080' },
      body: { planId: 'pro', cycle: 'monthly' }
    });

    // Libera o retorno simulado do Mercado Pago após ambas entrarem em voo
    await new Promise(r => setTimeout(r, 25));
    releaseMp();

    const [r1, r2] = await Promise.all([p1, p2]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(mpCalls, 1, 'Mercado Pago deve receber exatamente 1 chamada');

    const winner = r1.status === 200 ? r1 : r2;
    const loser = r1.status === 409 ? r1 : r2;
    assert.equal(loser.data.inFlight, true);
    assert.ok(winner.data.pix?.qrCode);

    // Nova corrida após finalização reutiliza o mesmo PIX aberto
    const [r3, r4] = await Promise.all([
      h.callRoute('POST /api/saas/billing/checkout-pix', { headers: { host: 'localhost:8080' }, body: { planId: 'pro', cycle: 'monthly' } }),
      h.callRoute('POST /api/saas/billing/checkout-pix', { headers: { host: 'localhost:8080' }, body: { planId: 'pro', cycle: 'monthly' } })
    ]);
    assert.equal(r3.status, 200);
    assert.equal(r4.status, 200);
    assert.equal(r3.data.reused, true);
    assert.equal(r4.data.reused, true);
    assert.equal(r3.data.invoice.id, winner.data.invoice.id);
    assert.equal(r4.data.invoice.id, winner.data.invoice.id);
    assert.equal(mpCalls, 1, 'nenhuma nova chamada MP após PIX aberto existir');

    const inst = getSqliteInstance(h.dataDir);
    const invCount = inst.db.prepare("SELECT COUNT(*) AS cnt FROM saas_invoices WHERE tenant_id = ? AND kind = 'pix_checkout'").get('ironpix').cnt;
    assert.equal(invCount, 1);
  } finally {
    globalThis.fetch = origFetch;
    if (prevToken === undefined) delete process.env.MERCADO_PAGO_ACCESS_TOKEN;
    else process.env.MERCADO_PAGO_ACCESS_TOKEN = prevToken;
  }
});

/* =========================================================================
 * 2. Confirmação dupla de pagamento (simulate-pix + confirmTenantPayment)
 * ========================================================================= */
test('Race 2: dupla confirmação simultânea de fatura avança nextBillingAt apenas 1 ciclo (~30 dias)', async t => {
  const owner = { id: 'u_owner_pay', name: 'Gestor Pay', saasRole: 'gym_owner', role: 'trainer', tenantId: 'ironpay' };
  const h = createSaasHarness({ initialUsers: [owner], user: owner });
  t.after(() => cleanupTempDir(h.dataDir));

  const prevDemo = process.env.SAAS_DEMO;
  process.env.SAAS_DEMO = '1';

  try {
    createTenant(h.dataDir, { id: 'ironpay', name: 'Iron Pay', planId: 'pro', ownerName: 'Gestor Pay', ownerEmail: 'pay@iron.com' });
    const beforeBillingMs = Date.parse(getTenant(h.dataDir, 'ironpay').nextBillingAt);
    const checkout = await h.callRoute('POST /api/saas/billing/checkout-pix', {
      headers: { host: 'localhost:8080' },
      body: { planId: 'pro', cycle: 'monthly' }
    });
    assert.equal(checkout.status, 200);
    const invId = checkout.data.invoice.id;

    // Simula duas confirmações concorrentes (ex.: webhook + clique duplo / simulate-pix)
    const [c1, c2] = await Promise.all([
      h.callRoute('POST /api/saas/billing/simulate-pix', { body: { invoiceId: invId } }),
      Promise.resolve().then(() => confirmTenantPayment(h.dataDir, 'ironpay', {
        invoiceId: invId,
        mpPaymentId: checkout.data.pix.paymentId,
        method: 'PIX (Webhook)',
        cycle: 'monthly',
        planId: 'pro'
      }))
    ]);

    const firstFlags = [c1.data.alreadyProcessed, c2.alreadyPaid].sort();
    assert.deepEqual(firstFlags, [false, true], 'exatamente uma confirmação processa e a outra é idempotente');

    const tenantAfter = getTenant(h.dataDir, 'ironpay');
    const daysAdvanced = (Date.parse(tenantAfter.nextBillingAt) - beforeBillingMs) / 86400000;
    assert.ok(daysAdvanced >= 29 && daysAdvanced <= 31, `vencimento deve avançar exatamente 1 ciclo (~30 dias) (obtido: ${daysAdvanced.toFixed(2)}d)`);
  } finally {
    if (prevDemo === undefined) delete process.env.SAAS_DEMO;
    else process.env.SAAS_DEMO = prevDemo;
  }
});

/* =========================================================================
 * 3. Cota de alunos + E-mail duplicado (POST /api/gym/students)
 * ========================================================================= */
test('Race 3: matrícula simultânea respeita limite maxStudents = 1 e impede e-mail duplicado', async t => {
  const owner = { id: 'u_owner_cap', name: 'Gestor Cap', saasRole: 'gym_owner', role: 'trainer', tenantId: 'capgym' };
  const h = createSaasHarness({ initialUsers: [owner], user: owner });
  t.after(() => cleanupTempDir(h.dataDir));

  createTenant(h.dataDir, { id: 'capgym', name: 'Cap Gym', planId: 'starter', ownerName: 'Gestor Cap', ownerEmail: 'cap@gym.com' });
  const inst = getSqliteInstance(h.dataDir);
  const starterRow = inst.db.prepare('SELECT data FROM saas_plans WHERE id = ?').get('starter');
  const starterData = JSON.parse(starterRow.data);
  starterData.maxStudents = 1;
  inst.db.prepare('UPDATE saas_plans SET data = ? WHERE id = ?').run(JSON.stringify(starterData), 'starter');

  // 3A. Dois alunos diferentes disputam a única vaga (maxStudents = 1)
  const [s1, s2] = await Promise.all([
    h.callRoute('POST /api/gym/students', { body: { name: 'Aluno Um', email: 'um@capgym.com', password: 'RitStrongPass#11' } }),
    h.callRoute('POST /api/gym/students', { body: { name: 'Aluno Dois', email: 'dois@capgym.com', password: 'RitStrongPass#22' } })
  ]);
  assert.deepEqual([s1.status, s2.status].sort((a, b) => a - b), [201, 403]);
  const enrolled = h.db.users.filter(u => u.tenantId === 'capgym' && u.saasRole === 'student');
  assert.equal(enrolled.length, 1);

  // 3B. Libera cota para testar unicidade de e-mail sob corrida (case-insensitive)
  starterData.maxStudents = 10;
  inst.db.prepare('UPDATE saas_plans SET data = ? WHERE id = ?').run(JSON.stringify(starterData), 'starter');

  const [e1, e2] = await Promise.all([
    h.callRoute('POST /api/gym/students', { body: { name: 'Ana A', email: 'Duplicado@Gym.COM', password: 'RitStrongPass#33' } }),
    h.callRoute('POST /api/gym/students', { body: { name: 'Ana B', email: 'duplicado@gym.com', password: 'RitStrongPass#44' } })
  ]);
  assert.deepEqual([e1.status, e2.status].sort((a, b) => a - b), [201, 409]);
  assert.equal(h.db.users.filter(u => u.email === 'duplicado@gym.com').length, 1);
});

/* =========================================================================
 * 4. Cadastro simultâneo HTTP no server.js (convite único + rollback por e-mail)
 * ========================================================================= */
test('Race 4: POST /api/register/password concorrente consome convite 1x e faz rollback ao colidir e-mail', async t => {
  const nowIso = new Date().toISOString();
  const h = await startRealServer(t, {
    env: { INVITE_ONLY: '1' },
    dbInit: {
      users: [{ id: 'u_adm', name: 'Owner', admin: true, owner: true, created: nowIso }],
      invites: [
        { code: 'RACE-INV-1', created: nowIso, createdBy: 'u_adm' },
        { code: 'RACE-INV-2', created: nowIso, createdBy: 'u_adm' },
        { code: 'RACE-INV-3', created: nowIso, createdBy: 'u_adm' }
      ]
    }
  });

  // 4A. 2 cadastros simultâneos com o MESMO convite RACE-INV-1
  const [reg1, reg2] = await Promise.all([
    h.req('POST', '/api/register/password', {
      ip: '198.51.100.21',
      body: { name: 'Candidato A', password: 'strong-pass-user-a', code: 'RACE-INV-1' }
    }),
    h.req('POST', '/api/register/password', {
      ip: '198.51.100.22',
      body: { name: 'Candidato B', password: 'strong-pass-user-b', code: 'RACE-INV-1' }
    })
  ]);
  assert.deepEqual([reg1.status, reg2.status].sort((a, b) => a - b), [200, 403]);

  // 4B. 2 convites diferentes com o MESMO e-mail -> 1 cria (200), 1 falha (409) e convite perdedor permanece utilizável (rollback!)
  const [em1, em2] = await Promise.all([
    h.req('POST', '/api/register/password', {
      ip: '198.51.100.23',
      body: { name: 'Email One', email: 'same@email.com', password: 'strong-pass-email-1', code: 'RACE-INV-2' }
    }),
    h.req('POST', '/api/register/password', {
      ip: '198.51.100.24',
      body: { name: 'Email Two', email: 'SAME@email.com', password: 'strong-pass-email-2', code: 'RACE-INV-3' }
    })
  ]);
  assert.deepEqual([em1.status, em2.status].sort((a, b) => a - b), [200, 409]);

  const loserCode = em1.status === 409 ? 'RACE-INV-2' : 'RACE-INV-3';
  const retryAfterRollback = await h.req('POST', '/api/register/password', {
    ip: '198.51.100.25',
    body: { name: 'Terceiro Livre', email: 'livre@email.com', password: 'strong-pass-free-3', code: loserCode }
  });
  assert.equal(retryAfterRollback.status, 200, 'convite do cadastro abortado por e-mail duplicado deve permanecer intacto após rollback');
});

/* =========================================================================
 * 5. Setup inicial concorrente de Super Admin (POST /api/saas/auth/setup-admin)
 * ========================================================================= */
test('Race 5: setup-admin simultâneo permite criar estritamente 1 Super Admin', async t => {
  const h = createSaasHarness({ initialUsers: [] });
  t.after(() => cleanupTempDir(h.dataDir));

  const [a1, a2] = await Promise.all([
    h.callRoute('POST /api/saas/auth/setup-admin', {
      body: { name: 'Admin 1', email: 'admin1@rit.com', password: 'super-secret-password-1' }
    }),
    h.callRoute('POST /api/saas/auth/setup-admin', {
      body: { name: 'Admin 2', email: 'admin2@rit.com', password: 'super-secret-password-2' }
    })
  ]);

  assert.deepEqual([a1.status, a2.status].sort((a, b) => a - b), [200, 403]);
  const admins = h.db.users.filter(u => u.saasRole === 'superadmin' || u.admin === true);
  assert.equal(admins.length, 1);
});

/* =========================================================================
 * 6. Importação simultânea de modelos padrão (POST /api/gym/templates/import-defaults)
 * ========================================================================= */
test('Race 6: import-defaults simultâneo não duplica modelos na biblioteca', async t => {
  const owner = { id: 'u_owner_tpl', name: 'Gestor Tpl', saasRole: 'gym_owner', role: 'trainer', tenantId: 'tplgym' };
  const h = createSaasHarness({ initialUsers: [owner], user: owner });
  t.after(() => cleanupTempDir(h.dataDir));

  createTenant(h.dataDir, { id: 'tplgym', name: 'Tpl Gym', planId: 'pro', ownerName: 'Gestor Tpl', ownerEmail: 'tpl@gym.com' });

  const [t1, t2] = await Promise.all([
    h.callRoute('POST /api/gym/templates/import-defaults', { body: {} }),
    h.callRoute('POST /api/gym/templates/import-defaults', { body: {} })
  ]);

  assert.equal(t1.status, 200);
  assert.equal(t2.status, 200);

  const inst = getSqliteInstance(h.dataDir);
  const rows = inst.db.prepare('SELECT id, data FROM gym_templates WHERE tenant_id = ?').all('tplgym');
  assert.equal(t1.data.added + t2.data.added, rows.length, 'soma dos added deve igualar total sem duplicatas');
  const names = rows.map(r => JSON.parse(r.data).name);
  assert.equal(new Set(names).size, rows.length, 'nenhum modelo com nome duplicado');
});

/* =========================================================================
 * 7. Prescrição simultânea de rotinas para o mesmo aluno (updateUserStateAtomic)
 * ========================================================================= */
test('Race 7: duas prescrições simultâneas no mesmo aluno preservam ambas as rotinas', async t => {
  const dataDir = makeTempDir('rit-state-race-');
  t.after(() => cleanupTempDir(dataDir));

  const studentId = 'u_st_concurrent';

  const [p1, p2] = await Promise.all([
    Promise.resolve().then(() => prescribeRoutineToStudent(dataDir, studentId, {
      day: 1,
      routine: { name: 'Treino A Peito', ex: [{ id: 'ex_1', name: 'Supino Reto', sets: [{ kg: 60, reps: 10 }] }] },
      trainerUser: { id: 'tr1', name: 'Prof A' }
    })),
    Promise.resolve().then(() => prescribeRoutineToStudent(dataDir, studentId, {
      day: 3,
      routine: { name: 'Treino B Costas', ex: [{ id: 'ex_2', name: 'Puxada Alta', sets: [{ kg: 50, reps: 12 }] }] },
      trainerUser: { id: 'tr2', name: 'Prof B' }
    }))
  ]);

  assert.ok(p1?.id && p2?.id);
  const finalState = JSON.parse(getSqliteInstance(dataDir).stmts.getState.get(studentId).data);
  const names = finalState.routines.map(r => r.name).sort();
  assert.deepEqual(names, ['Treino A Peito', 'Treino B Costas']);
  assert.equal(finalState._rev, 2);

  // Também valida updateUserStateAtomicSqlite direto (dois mutadores concorrentes no mesmo perfil)
  await Promise.all([
    Promise.resolve().then(() => updateUserStateAtomicSqlite(dataDir, studentId, cur => ({ ...cur, noteA: 'okA' }))),
    Promise.resolve().then(() => updateUserStateAtomicSqlite(dataDir, studentId, cur => ({ ...cur, noteB: 'okB' })))
  ]);
  const finalWithNotes = JSON.parse(getSqliteInstance(dataDir).stmts.getState.get(studentId).data);
  assert.equal(finalWithNotes.noteA, 'okA');
  assert.equal(finalWithNotes.noteB, 'okB');
  assert.equal(finalWithNotes._rev, 4);
});

/* =========================================================================
 * 8. Compare-And-Swap em PUT /api/data no server.js real
 * ========================================================================= */
test('Race 8: duas sincronizações concorrentes com mesmo baseRev resultam em 200 e 409 conflict', async t => {
  const h = await startRealServer(t, {
    dbInit: {
      users: [{ id: 'u_cas', name: 'Aluno CAS', created: new Date().toISOString() }]
    }
  });
  const cookie = `gymsid=${mintSession('u_cas')}`;

  const init = await h.req('PUT', '/api/data', {
    cookie,
    body: { state: { unit: 'kg', routines: [{ id: 'r0', name: 'Inicial', ex: [] }], workouts: [] } }
  });
  assert.equal(init.status, 200);
  const rev1 = init.body.rev;

  const [syncA, syncB] = await Promise.all([
    h.req('PUT', '/api/data', {
      cookie,
      body: { baseRev: rev1, state: { unit: 'kg', routines: [{ id: 'rA', name: 'Sync A', ex: [] }], workouts: [] } }
    }),
    h.req('PUT', '/api/data', {
      cookie,
      body: { baseRev: rev1, state: { unit: 'kg', routines: [{ id: 'rB', name: 'Sync B', ex: [] }], workouts: [] } }
    })
  ]);

  const sorted = [syncA.status, syncB.status].sort((a, b) => a - b);
  assert.deepEqual(sorted, [200, 409]);
  const conflictRes = syncA.status === 409 ? syncA : syncB;
  assert.equal(conflictRes.body.error, 'conflict');
  assert.equal(conflictRes.body.rev, rev1 + 1);
});

/* =========================================================================
 * 9. Pareamento único Watch + Device Link
 * ========================================================================= */
test('Race 9: código Watch e Device Link aceitam apenas 1 resgate sob concorrência', async t => {
  // 9A. Watch pair redeem via server.js HTTP
  const h = await startRealServer(t, {
    dbInit: {
      users: [{ id: 'u_watch', name: 'Watch User', created: new Date().toISOString() }]
    }
  });
  const cookie = `gymsid=${mintSession('u_watch')}`;
  const pairRes = await h.req('POST', '/api/watch/pair', { cookie });
  assert.equal(pairRes.status, 200);

  const [w1, w2] = await Promise.all([
    h.req('POST', '/api/watch/redeem', { ip: '198.51.100.31', body: { code: pairRes.body.code, name: 'Watch 1' } }),
    h.req('POST', '/api/watch/redeem', { ip: '198.51.100.32', body: { code: pairRes.body.code, name: 'Watch 2' } })
  ]);
  assert.deepEqual([w1.status, w2.status].sort((a, b) => a - b), [200, 400]);

  // 9B. consumeDeviceLinkSqlite direto (DELETE ... RETURNING)
  const dlDir = makeTempDir('rit-dl-race-');
  t.after(() => cleanupTempDir(dlDir));
  const linkHash = crypto.createHash('sha256').update('rit-link:RACECODE1234').digest('hex');
  saveCoreDbToSqlite(dlDir, {
    users: [{ id: 'u_dl', name: 'DL User', created: new Date().toISOString() }],
    creds: [],
    subs: [],
    invites: [],
    deviceLinks: [{ h: linkHash, userId: 'u_dl', exp: Date.now() + 600000, created: Date.now() }],
    watches: []
  });

  const [dl1, dl2] = await Promise.all([
    Promise.resolve().then(() => consumeDeviceLinkSqlite(dlDir, linkHash)),
    Promise.resolve().then(() => consumeDeviceLinkSqlite(dlDir, linkHash))
  ]);
  const consumedCount = [dl1, dl2].filter(Boolean).length;
  assert.equal(consumedCount, 1);
});

/* =========================================================================
 * 10. Lote WhatsApp anti-churn e Worker Outbox (flushWhatsAppOutbox)
 * ========================================================================= */
test('Race 10: churn-batch simultâneo e flushWhatsAppOutbox enviam no máximo 1 mensagem por destinatário', async t => {
  let receivedMessages = [];
  const evoServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      receivedMessages.push({ url: req.url, body: JSON.parse(raw || '{}') });
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ key: { id: 'evo_ok_' + receivedMessages.length } }));
      }, 30);
    });
  });
  await new Promise(resolve => evoServer.listen(0, '127.0.0.1', resolve));
  const evoUrl = `http://127.0.0.1:${evoServer.address().port}`;
  const prevEvoUrl = process.env.EVOLUTION_API_URL;
  const prevEvoKey = process.env.EVOLUTION_API_KEY;
  process.env.EVOLUTION_API_URL = evoUrl;
  process.env.EVOLUTION_API_KEY = 'test-key';
  t.after(async () => {
    if (prevEvoUrl === undefined) delete process.env.EVOLUTION_API_URL;
    else process.env.EVOLUTION_API_URL = prevEvoUrl;
    if (prevEvoKey === undefined) delete process.env.EVOLUTION_API_KEY;
    else process.env.EVOLUTION_API_KEY = prevEvoKey;
    await new Promise(resolve => evoServer.close(resolve));
  });

  const owner = { id: 'u_owner_wa', name: 'Gestor WA', saasRole: 'gym_owner', role: 'trainer', tenantId: 'wagym' };
  const absentStudent = {
    id: 'u_st_wa_1',
    name: 'Aluno Ausente',
    phone: '11999998888',
    tenantId: 'wagym',
    saasRole: 'student',
    role: 'student',
    created: new Date(Date.now() - 20 * 86400000).toISOString()
  };
  const h = createSaasHarness({ initialUsers: [owner, absentStudent], user: owner });
  t.after(() => cleanupTempDir(h.dataDir));

  createTenant(h.dataDir, {
    id: 'wagym',
    name: 'WA Gym',
    planId: 'pro',
    ownerName: 'Gestor WA',
    ownerEmail: 'wa@gym.com',
    settings: { evolutionInstance: 'wagym', churnDaysThreshold: 5 }
  });
  const oldIso = new Date(Date.now() - 10 * 86400000).toISOString();
  writeState(h.dataDir, absentStudent.id, { workouts: [{ id: 'w_old', at: oldIso }], routines: [] });

  // 10A. Dois POSTs simultâneos para o mesmo churn-batch no mesmo dia
  const [b1, b2] = await Promise.all([
    h.callRoute('POST /api/gym/whatsapp/churn-batch', { body: {} }),
    h.callRoute('POST /api/gym/whatsapp/churn-batch', { body: {} })
  ]);
  assert.equal(b1.status, 200);
  assert.equal(b2.status, 200);
  assert.equal(receivedMessages.length, 1, 'Evolution API deve receber exatamente 1 HTTP POST no lote anti-churn');
  assert.equal((b1.data.sentCount || 0) + (b2.data.sentCount || 0), 1);
  assert.equal((b1.data.skippedCount || 0) + (b2.data.skippedCount || 0), 1);

  // 10B. Dois workers flushWhatsAppOutbox simultâneos reivindicando 1 item pendente
  receivedMessages = [];
  const inst = getSqliteInstance(h.dataDir);
  const now = Date.now();
  const payload = {
    id: 'wa_pending_race',
    tenantId: 'wagym',
    kind: 'manual',
    recipientName: 'Aluno Outbox',
    phone: '5511988887777',
    preview: 'Teste fila',
    message: 'Mensagem pendente unica',
    tenantSettings: { evolutionInstance: 'wagym' },
    attempts: 1,
    maxAttempts: 3,
    createdAt: new Date(now - 5000).toISOString(),
    nextRetryAt: now - 1000
  };
  inst.stmts.upsertOutboxRow.run(
    payload.id, 'wagym', 'manual', 'pending', 'outbox:race:1', 1, now - 1000, null, now - 5000, null, JSON.stringify(payload)
  );

  await Promise.all([
    flushWhatsAppOutbox(h.dataDir, { force: true, tenantId: 'wagym' }),
    flushWhatsAppOutbox(h.dataDir, { force: true, tenantId: 'wagym' })
  ]);
  assert.equal(receivedMessages.length, 1, 'worker outbox deve entregar o item pendente exatamente 1 vez');
});

/* =========================================================================
 * 11. Cota diária do Coach IA (bumpCoachDailySqlite & coachJobs.enqueue)
 * ========================================================================= */
test('Race 11: teto diário = 1 no Coach IA bloqueia requisição simultânea excedente', async t => {
  // 11A. bumpCoachDailySqlite atômico direto
  const capDir = makeTempDir('rit-cap-race-');
  t.after(() => cleanupTempDir(capDir));
  const today = new Date().toISOString().slice(0, 10);

  const [d1, d2] = await Promise.all([
    Promise.resolve().then(() => bumpCoachDailySqlite(capDir, 'u_cap_1', today, 1)),
    Promise.resolve().then(() => bumpCoachDailySqlite(capDir, 'u_cap_1', today, 1))
  ]);
  assert.deepEqual([d1.ok, d2.ok].sort(), [false, true]);
  assert.equal(Math.max(d1.count, d2.count), 1);

  // 11B. coach/jobs.js enqueue concorrente para instanceDaily = 1 (dois perfis distintos)
  const coachDir = makeTempDir('rit-coach-race-');
  const prevDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = coachDir;
  t.after(() => {
    if (prevDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prevDataDir;
    cleanupTempDir(coachDir);
  });

  const cfgStore = await import('../coach/config.js');
  const jobs = await import('../coach/jobs.js');
  cfgStore.save({
    enabled: true,
    provider: 'compatible',
    providerOptions: { compatible: { baseUrl: 'http://127.0.0.1:9' } },
    caps: { perProfileDaily: 10, instanceDaily: 1 }
  });
  writeState(coachDir, 'u_c1', sampleState());
  writeState(coachDir, 'u_c2', sampleState());

  const [j1, j2] = await Promise.allSettled([
    Promise.resolve().then(() => jobs.enqueue('u_c1', { kind: 'review' })),
    Promise.resolve().then(() => jobs.enqueue('u_c2', { kind: 'review' }))
  ]);

  const fulfilled = [j1, j2].filter(x => x.status === 'fulfilled');
  const rejected = [j1, j2].filter(x => x.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exatamente 1 job deve furar o teto da instância');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, 'cap');

  // Aguarda settlement ou limpeza dos jobs em memória antes do teardown
  jobs.clearUser('u_c1');
  jobs.clearUser('u_c2');
  await new Promise(r => setTimeout(r, 50));
});
