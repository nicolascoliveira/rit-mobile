/**
 * api/test/payment-idempotency.test.js
 *
 * Suíte de testes de idempotência para webhooks e endpoints de pagamento/assinatura:
 *  1. Verificação HMAC estritamente sobre o corpo bruto (rawBody) antes de JSON.parse/roteamento/DB;
 *  2. Deduplicação em `webhook_events` + processamento assíncrono rápido 2xx (2x sequencial e 2x simultâneo);
 *  3. Independência de ordem de chegada (consulta autoritativa à API do Mercado Pago; sem downgrade de fatura paga);
 *  4. Chave UUID v4 (sem PII) nas chamadas de saída ao Mercado Pago reutilizada em retries;
 *  5. Header `Idempotency-Key` nos endpoints de pagamento, assinatura, fatura e criação de academia
 *     (2x sequencial, 2x simultâneo, replay exato com `Idempotency-Replayed: true` e 422 em divergência de payload);
 *  6. Recuperação após crash (`recoverWebhookQueueOnBoot`).
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

import { boundPort } from './helpers.mjs';
import { createTenant, getTenant } from '../tenants.js';
import { createPixPayment, isUuidV4 } from '../mercadopago.js';
import {
  getSqliteInstance,
  closeSqliteInstance,
  upsertUserSqlite,
  registerWebhookEventSqlite
} from '../sqlite.js';
import { recoverWebhookQueueOnBoot, flushWebhookQueue } from '../webhook-worker.js';

const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_SECRET = 'e'.repeat(64);
const WEBHOOK_SECRET = 'mp-wh-secret-test-123456';
const ORIGIN = 'http://localhost:8080';

function makeTempDir(prefix = 'rit-idem-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'secret'), TEST_SECRET, { mode: 0o600 });
  return dir;
}

function cleanupTempDir(dir) {
  try { closeSqliteInstance(dir); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function mintSession(uid, sv = 0, secret = TEST_SECRET) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function signMpWebhook({ dataId, requestId = 'req-1', ts = '1700000000', rawBody = '', secret = WEBHOOK_SECRET, withBodySig = false }) {
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const headers = {
    'x-signature': `ts=${ts},v1=${v1}`,
    'x-request-id': requestId
  };
  if (withBodySig) {
    const bodyHex = crypto.createHmac('sha256', secret).update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody))).digest('hex');
    headers['x-body-signature'] = `sha256=${bodyHex}`;
  }
  return headers;
}

async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('Timeout aguardando condição assíncrona no teste');
}

async function startMockMpAndEvolution(t) {
  const state = {
    createPixCalls: [],
    getPaymentCalls: [],
    waCalls: [],
    failNextCreatePixCount: 0,
    createPixStatusOnFail: 503,
    paymentLookupDelayMs: 0,
    paymentsById: new Map(),
    nextPixId: 9001
  };

  const mpServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const url = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'POST' && url.pathname === '/v1/payments') {
        state.createPixCalls.push({
          idempotencyKey: req.headers['x-idempotency-key'] || '',
          authorization: req.headers.authorization || '',
          body
        });
        if (state.failNextCreatePixCount > 0) {
          state.failNextCreatePixCount--;
          res.writeHead(state.createPixStatusOnFail, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'temporary gateway error' }));
        }
        const id = String(state.nextPixId++);
        const created = {
          id,
          status: 'pending',
          transaction_amount: Number(body?.transaction_amount || 0),
          external_reference: body?.external_reference || '',
          point_of_interaction: {
            transaction_data: {
              qr_code: `pix_qr_${id}`,
              qr_code_base64: Buffer.from(`qr_${id}`).toString('base64'),
              ticket_url: `https://mp.mock/tickets/${id}`
            }
          },
          date_created: new Date().toISOString(),
          date_of_expiration: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
        };
        state.paymentsById.set(id, created);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(created));
      }

      const getMatch = /^\/v1\/payments\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && getMatch) {
        const pid = decodeURIComponent(getMatch[1]);
        state.getPaymentCalls.push(pid);
        if (state.paymentLookupDelayMs > 0) {
          await new Promise(r => setTimeout(r, state.paymentLookupDelayMs));
        }
        const rec = state.paymentsById.get(pid);
        if (!rec) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'payment not found' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(rec));
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'not found' }));
    });
  });

  const evoServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      state.waCalls.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ key: { id: 'wa_' + crypto.randomBytes(4).toString('hex') }, status: 'PENDING' }));
    });
  });

  await new Promise(resolve => mpServer.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => evoServer.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    mpServer.close();
    evoServer.close();
  });

  const mpPort = mpServer.address().port;
  const evoPort = evoServer.address().port;
  return {
    mpBaseUrl: `http://127.0.0.1:${mpPort}`,
    evoBaseUrl: `http://127.0.0.1:${evoPort}`,
    state
  };
}

async function startRealServer(t, { dataDir, env = {} }) {
  if (!fs.existsSync(path.join(dataDir, 'db.json'))) {
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
      users: [], creds: [], subs: [], invites: [], deviceLinks: [], watches: []
    }));
  }
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
  h.req = async (method, urlPath, { body, rawBody, cookie, headers = {} } = {}) => {
    const r = await fetch(`${h.api}${urlPath}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'same-origin',
        Origin: ORIGIN,
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers
      },
      body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body))
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed, headers: r.headers };
  };
  return h;
}

/* =========================================================================
 * 1. Webhook HMAC sobre corpo bruto antes de qualquer parse / filtro / banco
 * ========================================================================= */
test('Webhook 1: valida assinatura HMAC sobre corpo bruto antes de JSON.parse, roteamento e banco', async t => {
  const mocks = await startMockMpAndEvolution(t);
  const dataDir = makeTempDir('rit-wh-sig-');
  createTenant(dataDir, { id: 'gymhmac', name: 'Gym HMAC', planId: 'pro' });

  const srv = await startRealServer(t, {
    dataDir,
    env: {
      MERCADO_PAGO_ACCESS_TOKEN: 'APP_USR-test-token-12345',
      MERCADO_PAGO_WEBHOOK_SECRET: WEBHOOK_SECRET,
      MERCADO_PAGO_API_BASE: mocks.mpBaseUrl,
      EVOLUTION_API_URL: mocks.evoBaseUrl,
      EVOLUTION_API_KEY: 'evo-key',
      EVOLUTION_INSTANCE: 'rit-inst'
    }
  });

  // 1a) JSON malformado + assinatura inválida -> deve responder 401 ANTES do JSON.parse (não 400)
  const rBadJsonBadSig = await srv.req('POST', '/api/saas/billing/webhook?data.id=mp_x&type=payment', {
    rawBody: '{"broken-json',
    headers: { 'x-signature': 'ts=1700000000,v1=' + '0'.repeat(64), 'x-request-id': 'req-bad' }
  });
  assert.equal(rBadJsonBadSig.status, 401);

  // 1b) Tipo ignorado + assinatura inválida -> deve responder 401 ANTES de ignorar
  const rIgnoredBadSig = await srv.req('POST', '/api/saas/billing/webhook?data.id=mp_x&type=merchant_order', {
    body: { type: 'merchant_order', data: { id: 'mp_x' } },
    headers: { 'x-signature': 'ts=1700000000,v1=' + 'f'.repeat(64), 'x-request-id': 'req-bad-2' }
  });
  assert.equal(rIgnoredBadSig.status, 401);

  // 1c) Manifest válido, mas x-body-signature adulterada (corpo modificado em trânsito) -> 401
  const origRaw = JSON.stringify({ id: 'evt_tamper', type: 'payment', data: { id: '5551' } });
  const tamperedRaw = JSON.stringify({ id: 'evt_tamper', type: 'payment', data: { id: '9999' } });
  const signedHeaders = signMpWebhook({ dataId: '5551', requestId: 'req-tamper', rawBody: origRaw, withBodySig: true });
  const rTamperedBody = await srv.req('POST', '/api/saas/billing/webhook?data.id=5551&type=payment', {
    rawBody: tamperedRaw,
    headers: signedHeaders
  });
  assert.equal(rTamperedBody.status, 401);

  // Confirma que nenhum evento foi gravado nem gateway consultado
  assert.equal(mocks.state.getPaymentCalls.length, 0);
  const inst = getSqliteInstance(dataDir);
  const evtCount = inst.db.prepare('SELECT COUNT(*) AS c FROM webhook_events').get().c;
  assert.equal(evtCount, 0);
});

/* =========================================================================
 * 2. Webhook duplicado 2x sequencial e 2x simultâneo + resposta 2xx rápida
 * ========================================================================= */
test('Webhook 2: mesmo evento enviado 2x simultaneamente e 2x seguidas executa efeito apenas 1 vez', async t => {
  const mocks = await startMockMpAndEvolution(t);
  mocks.state.paymentLookupDelayMs = 80;

  const dataDir = makeTempDir('rit-wh-dup-');
  const tenantCreated = createTenant(dataDir, {
    id: 'gymdup',
    name: 'Gym Dup',
    planId: 'pro',
    status: 'past_due',
    nextBillingAt: '2026-10-01T00:00:00.000Z',
    ownerName: 'Ana Dona',
    ownerEmail: 'ana@gymdup.com',
    phone: '11988887777'
  });
  const baseBillingMs = new Date(tenantCreated.nextBillingAt).getTime();

  // Seed fatura PIX pendente com mp_payment_id conhecido
  const mpPid = '77001';
  const invId = 'inv_whdup1';
  const inst = getSqliteInstance(dataDir);
  inst.stmts.insertInvoiceIgnore.run(
    invId, 'gymdup', 'pro', 'pix_checkout', 26900, 'pending', 'PIX (Mercado Pago)',
    mpPid, crypto.randomUUID(), Date.now(), null, Date.now() + 86400000,
    JSON.stringify({
      id: invId,
      refMonth: '2026-11',
      amount: 269,
      status: 'pending',
      paidAt: null,
      method: 'PIX (Mercado Pago)',
      cycle: 'monthly',
      planId: 'pro',
      planName: 'Academia Completa',
      mpPaymentId: mpPid,
      createdAt: new Date().toISOString()
    })
  );

  mocks.state.paymentsById.set(mpPid, {
    id: mpPid,
    status: 'approved',
    transaction_amount: 269,
    external_reference: `rit:gymdup:${invId}:monthly:pro`,
    date_approved: new Date().toISOString()
  });

  const srv = await startRealServer(t, {
    dataDir,
    env: {
      MERCADO_PAGO_ACCESS_TOKEN: 'APP_USR-test-token-12345',
      MERCADO_PAGO_WEBHOOK_SECRET: WEBHOOK_SECRET,
      MERCADO_PAGO_API_BASE: mocks.mpBaseUrl,
      EVOLUTION_API_URL: mocks.evoBaseUrl,
      EVOLUTION_API_KEY: 'evo-key',
      EVOLUTION_INSTANCE: 'rit-inst'
    }
  });

  const payload = { id: 'evt_unique_77001', type: 'payment', action: 'payment.updated', data: { id: mpPid } };
  const rawBody = JSON.stringify(payload);
  const sigHeaders = signMpWebhook({ dataId: mpPid, requestId: 'req-dup-77001', rawBody, withBodySig: true });

  // Dispara 2 webhooks idênticos ao mesmo tempo e mede tempo de resposta HTTP (deve retornar rápido < delay)
  const t0 = Date.now();
  const [r1, r2] = await Promise.all([
    srv.req('POST', `/api/saas/billing/webhook?data.id=${mpPid}&type=payment`, { rawBody, headers: sigHeaders }),
    srv.req('POST', `/api/saas/billing/webhook?data.id=${mpPid}&type=payment`, { rawBody, headers: sigHeaders })
  ]);
  const elapsedHttp = Date.now() - t0;

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const statuses = [r1.body, r2.body];
  assert.equal(statuses.filter(b => b.queued === true && !b.deduplicated).length, 1, 'exatamente 1 entrega deve enfileirar');
  assert.equal(statuses.filter(b => b.deduplicated === true).length, 1, 'a 2a simultânea deve deduplicar imediatamente');
  assert.ok(elapsedHttp < 500, `webhook deve responder rápido em background (levou ${elapsedHttp}ms)`);

  // Aguarda worker assíncrono drenar webhook_events -> processed
  const doneEvent = await waitFor(() => {
    const row = inst.db.prepare('SELECT * FROM webhook_events WHERE event_id = ?').get('mp:evt:evt_unique_77001');
    return row && row.status === 'processed' ? row : null;
  });
  assert.equal(doneEvent.status, 'processed');

  // Envia o MESMO evento mais 1 vez sequencialmente
  const r3 = await srv.req('POST', `/api/saas/billing/webhook?data.id=${mpPid}&type=payment`, { rawBody, headers: sigHeaders });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.deduplicated, true);
  assert.equal(r3.body.alreadyProcessed, true);

  // Prova de efeito único:
  // 1) Consulta ao gateway feita estritamente 1 vez
  assert.equal(mocks.state.getPaymentCalls.length, 1);
  // 2) Apenas 1 registro na tabela webhook_events
  assert.equal(inst.db.prepare('SELECT COUNT(*) AS c FROM webhook_events').get().c, 1);
  // 3) Apenas 1 notificação WhatsApp disparada e registrada no outbox
  assert.equal(mocks.state.waCalls.length, 1);
  assert.equal(inst.db.prepare('SELECT COUNT(*) AS c FROM whatsapp_outbox').get().c, 1);
  const outboxRow = inst.db.prepare('SELECT dedup_key FROM whatsapp_outbox LIMIT 1').get();
  assert.equal(outboxRow.dedup_key, `billing_paid:gymdup:${invId}`);

  // 4) Assinatura estendida em exatamente 1 ciclo (30 dias a partir de agora, pois base estaba no passado)
  const freshTenant = getTenant(dataDir, 'gymdup');
  assert.equal(freshTenant.status, 'active');
  const paidInvoices = freshTenant.invoices.filter(i => i.id === invId && i.status === 'paid');
  assert.equal(paidInvoices.length, 1);
  // Como nextBillingAt anterior estava em 2026-10-01 (< agora), ganhou ~30 dias a partir de agora (não +60d)
  const daysFromNow = (new Date(freshTenant.nextBillingAt).getTime() - Date.now()) / 86400000;
  assert.ok(daysFromNow > 29 && daysFromNow < 31 && new Date(freshTenant.nextBillingAt).getTime() > baseBillingMs);
});

/* =========================================================================
 * 3. Independência da ordem de chegada dos eventos (busca objeto oficial)
 * ========================================================================= */
test('Webhook 3: evento fora de ordem consulta objeto autoritativo no gateway e nunca faz downgrade de fatura paga', async t => {
  const mocks = await startMockMpAndEvolution(t);
  const dataDir = makeTempDir('rit-wh-ood-');
  createTenant(dataDir, {
    id: 'gymood',
    name: 'Gym Order',
    planId: 'pro',
    status: 'past_due',
    phone: '11977776666'
  });

  const mpPid = '77002';
  const invId = 'inv_whood1';
  const inst = getSqliteInstance(dataDir);
  inst.stmts.insertInvoiceIgnore.run(
    invId, 'gymood', 'pro', 'pix_checkout', 26900, 'pending', 'PIX (Mercado Pago)',
    mpPid, crypto.randomUUID(), Date.now(), null, Date.now() + 86400000,
    JSON.stringify({
      id: invId,
      refMonth: '2026-11',
      amount: 269,
      status: 'pending',
      paidAt: null,
      method: 'PIX (Mercado Pago)',
      cycle: 'monthly',
      planId: 'pro',
      planName: 'Academia Completa',
      mpPaymentId: mpPid,
      createdAt: new Date().toISOString()
    })
  );

  // Estado autoritativo no Mercado Pago já é 'approved' embora o payload traga action atrasada/divergente
  mocks.state.paymentsById.set(mpPid, {
    id: mpPid,
    status: 'approved',
    transaction_amount: 269,
    external_reference: `rit:gymood:${invId}:monthly:pro`,
    date_approved: new Date().toISOString()
  });

  const srv = await startRealServer(t, {
    dataDir,
    env: {
      MERCADO_PAGO_ACCESS_TOKEN: 'APP_USR-test-token-12345',
      MERCADO_PAGO_WEBHOOK_SECRET: WEBHOOK_SECRET,
      MERCADO_PAGO_API_BASE: mocks.mpBaseUrl,
      EVOLUTION_API_URL: mocks.evoBaseUrl,
      EVOLUTION_API_KEY: 'evo-key',
      EVOLUTION_INSTANCE: 'rit-inst'
    }
  });

  // Chega evento antigo com status/action "cancelled" no payload, mas objeto real no MP é "approved"
  const raw1 = JSON.stringify({ id: 'evt_ood_1', type: 'payment', action: 'payment.cancelled', status: 'cancelled', data: { id: mpPid } });
  const r1 = await srv.req('POST', `/api/saas/billing/webhook?data.id=${mpPid}&type=payment`, {
    rawBody: raw1,
    headers: signMpWebhook({ dataId: mpPid, requestId: 'req-ood-1', rawBody: raw1 })
  });
  assert.equal(r1.status, 200);

  await waitFor(() => inst.db.prepare('SELECT status FROM webhook_events WHERE event_id = ?').get('mp:evt:evt_ood_1')?.status === 'processed');
  const paidTenant = getTenant(dataDir, 'gymood');
  assert.equal(paidTenant.status, 'active');
  assert.equal(paidTenant.invoices.find(i => i.id === invId)?.status, 'paid');
  const firstPaidBillingAt = paidTenant.nextBillingAt;

  // Agora chega tardiamente outro evento onde gateway simulado responde estado obsoleto 'cancelled'
  mocks.state.paymentsById.set(mpPid, {
    id: mpPid,
    status: 'cancelled',
    transaction_amount: 269,
    external_reference: `rit:gymood:${invId}:monthly:pro`
  });
  const raw2 = JSON.stringify({ id: 'evt_ood_2', type: 'payment', action: 'payment.updated', data: { id: mpPid } });
  const r2 = await srv.req('POST', `/api/saas/billing/webhook?data.id=${mpPid}&type=payment`, {
    rawBody: raw2,
    headers: signMpWebhook({ dataId: mpPid, requestId: 'req-ood-2', rawBody: raw2 })
  });
  assert.equal(r2.status, 200);

  const row2 = await waitFor(() => {
    const r = inst.db.prepare('SELECT * FROM webhook_events WHERE event_id = ?').get('mp:evt:evt_ood_2');
    return r && r.status === 'processed' ? r : null;
  });
  const parsedResult2 = JSON.parse(row2.result_json);
  assert.equal(parsedResult2.outcome, 'ignored_already_paid');

  // Fatura paga NÃO sofre downgrade e data de vencimento não muda
  const afterLate = getTenant(dataDir, 'gymood');
  assert.equal(afterLate.status, 'active');
  assert.equal(afterLate.invoices.find(i => i.id === invId)?.status, 'paid');
  assert.equal(afterLate.nextBillingAt, firstPaidBillingAt);
  assert.equal(mocks.state.waCalls.length, 1);
});

/* =========================================================================
 * 4. Gateway X-Idempotency-Key UUID v4 reutilizada em retry automático e retry cliente
 * ========================================================================= */
test('Gateway 4: envia X-Idempotency-Key UUID v4 sem PII e reaproveita a mesma chave em retries', async t => {
  const mocks = await startMockMpAndEvolution(t);
  const prevBase = process.env.MERCADO_PAGO_API_BASE;
  const prevTok = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  process.env.MERCADO_PAGO_API_BASE = mocks.mpBaseUrl;
  process.env.MERCADO_PAGO_ACCESS_TOKEN = 'APP_USR-test-token-12345';
  t.after(() => {
    if (prevBase === undefined) delete process.env.MERCADO_PAGO_API_BASE;
    else process.env.MERCADO_PAGO_API_BASE = prevBase;
    if (prevTok === undefined) delete process.env.MERCADO_PAGO_ACCESS_TOKEN;
    else process.env.MERCADO_PAGO_ACCESS_TOKEN = prevTok;
  });

  // 4a) Retry automático interno em createPixPayment quando gateway devolve 503
  mocks.state.failNextCreatePixCount = 1;
  const pixRes = await createPixPayment({
    amount: 149,
    description: 'Rit - Estúdio (Mensal)',
    payerEmail: 'cpf_secreto@example.com',
    payerDoc: '12345678909',
    externalReference: 'rit:academia-a:inv1:monthly:starter',
    maxAttempts: 2,
    retryDelayMs: 10
  });
  assert.equal(mocks.state.createPixCalls.length, 2);
  const [c1, c2] = mocks.state.createPixCalls;
  assert.equal(isUuidV4(c1.idempotencyKey), true);
  assert.equal(c1.idempotencyKey, c2.idempotencyKey, 'retry automático deve reaproveitar exatamente a mesma UUID v4');
  assert.equal(pixRes.idempotencyKey, c1.idempotencyKey);
  assert.ok(!c1.idempotencyKey.includes('12345678909') && !c1.idempotencyKey.includes('cpf_secreto'));

  // 4b) Retry HTTP do cliente após 502 no checkout-pix preserva a mesma UUID v4 para o Mercado Pago
  mocks.state.createPixCalls.length = 0;
  mocks.state.failNextCreatePixCount = 2; // Esgota as 2 tentativas da 1a chamada HTTP -> 502

  const dataDir = makeTempDir('rit-gw-retry-');
  const owner = { id: 'u_owner_gw', name: 'Gestor', email: 'gestor@gw.com', saasRole: 'gym_owner', role: 'trainer', tenantId: 'gymgw' };
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [owner], creds: [], subs: [], invites: [], deviceLinks: [], watches: []
  }));
  createTenant(dataDir, { id: 'gymgw', name: 'Gym GW', planId: 'starter', ownerName: 'Gestor', ownerEmail: 'gestor@gw.com' });
  upsertUserSqlite(dataDir, owner, null);

  const srv = await startRealServer(t, {
    dataDir,
    env: {
      MERCADO_PAGO_ACCESS_TOKEN: 'APP_USR-test-token-12345',
      MERCADO_PAGO_WEBHOOK_SECRET: WEBHOOK_SECRET,
      MERCADO_PAGO_API_BASE: mocks.mpBaseUrl
    }
  });
  const cookie = `gymsid=${mintSession(owner.id, 0)}`;
  const clientIdemKey = crypto.randomUUID();

  const failResp = await srv.req('POST', '/api/saas/billing/checkout-pix', {
    cookie,
    headers: { 'Idempotency-Key': clientIdemKey },
    body: { planId: 'starter', cycle: 'monthly' }
  });
  assert.equal(failResp.status, 502);

  // Gateway recuperado: cliente reenvia a MESMA Idempotency-Key HTTP
  const okResp = await srv.req('POST', '/api/saas/billing/checkout-pix', {
    cookie,
    headers: { 'Idempotency-Key': clientIdemKey },
    body: { planId: 'starter', cycle: 'monthly' }
  });
  assert.equal(okResp.status, 200);
  assert.equal(okResp.body.ok, true);

  assert.equal(mocks.state.createPixCalls.length, 3);
  const sentKeys = mocks.state.createPixCalls.map(x => x.idempotencyKey);
  assert.ok(sentKeys.every(k => isUuidV4(k) && k === sentKeys[0]), 'todas as tentativas devem reutilizar a mesma UUID v4');
});

/* =========================================================================
 * 5. Endpoints do app aceitam Idempotency-Key (2x simultâneo + 2x sequencial + 422)
 * ========================================================================= */
test('Endpoints 5: checkout-pix, simulate-pix, admin/tenants/invoice e admin/tenants respeitam Idempotency-Key', async t => {
  const mocks = await startMockMpAndEvolution(t);
  const dataDir = makeTempDir('rit-api-idem-');
  const superAdmin = { id: 'u_super_idem', name: 'Super', email: 'super@rit.app', saasRole: 'superadmin', admin: true, role: 'trainer' };
  const owner = { id: 'u_owner_idem', name: 'Owner', email: 'owner@idem.com', saasRole: 'gym_owner', role: 'trainer', tenantId: 'gymapi' };

  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [superAdmin, owner], creds: [], subs: [], invites: [], deviceLinks: [], watches: []
  }));
  createTenant(dataDir, { id: 'gymapi', name: 'Gym API', planId: 'pro', status: 'past_due', ownerName: 'Owner', ownerEmail: 'owner@idem.com' });
  upsertUserSqlite(dataDir, superAdmin, null);
  upsertUserSqlite(dataDir, owner, null);

  const srv = await startRealServer(t, {
    dataDir,
    env: {
      MERCADO_PAGO_ACCESS_TOKEN: 'APP_USR-test-token-12345',
      MERCADO_PAGO_WEBHOOK_SECRET: WEBHOOK_SECRET,
      MERCADO_PAGO_API_BASE: mocks.mpBaseUrl
    }
  });

  const superCookie = `gymsid=${mintSession(superAdmin.id, 0)}`;
  const ownerCookie = `gymsid=${mintSession(owner.id, 0)}`;

  // 5a) POST /api/saas/billing/checkout-pix (2x simultâneo + 1x sequencial + 422 divergência)
  const kCheckout = crypto.randomUUID();
  const [cA, cB] = await Promise.all([
    srv.req('POST', '/api/saas/billing/checkout-pix', {
      cookie: ownerCookie,
      headers: { 'Idempotency-Key': kCheckout },
      body: { planId: 'pro', cycle: 'monthly' }
    }),
    srv.req('POST', '/api/saas/billing/checkout-pix', {
      cookie: ownerCookie,
      headers: { 'Idempotency-Key': kCheckout },
      body: { planId: 'pro', cycle: 'monthly' }
    })
  ]);
  assert.equal(cA.status, 200);
  assert.equal(cB.status, 200);
  assert.equal(cA.body.invoice.id, cB.body.invoice.id);
  assert.equal(cA.body.pix.paymentId, cB.body.pix.paymentId);
  assert.equal(mocks.state.createPixCalls.length, 1, 'gateway deve ser chamado apenas 1 vez');

  const cSeq = await srv.req('POST', '/api/saas/billing/checkout-pix', {
    cookie: ownerCookie,
    headers: { 'Idempotency-Key': kCheckout },
    body: { planId: 'pro', cycle: 'monthly' }
  });
  assert.equal(cSeq.status, 200);
  assert.equal(cSeq.headers.get('idempotency-replayed'), 'true');
  assert.deepEqual(cSeq.body.pix, cA.body.pix);

  const cMismatch = await srv.req('POST', '/api/saas/billing/checkout-pix', {
    cookie: ownerCookie,
    headers: { 'Idempotency-Key': kCheckout },
    body: { planId: 'pro', cycle: 'annual' }
  });
  assert.equal(cMismatch.status, 422);

  // 5b) POST /api/saas/billing/simulate-pix (com Super Admin + SAAS_DEMO=1)
  const kSim = crypto.randomUUID();
  const invId = cA.body.invoice.id;
  const [s1, s2] = await Promise.all([
    srv.req('POST', '/api/saas/billing/simulate-pix', {
      cookie: superCookie,
      headers: { 'Idempotency-Key': kSim },
      body: { tenantId: 'gymapi', invoiceId: invId }
    }),
    srv.req('POST', '/api/saas/billing/simulate-pix', {
      cookie: superCookie,
      headers: { 'Idempotency-Key': kSim },
      body: { tenantId: 'gymapi', invoiceId: invId }
    })
  ]);
  assert.equal(s1.status, 200);
  assert.equal(s2.status, 200);
  assert.equal(s1.body.tenant.nextBillingAt, s2.body.tenant.nextBillingAt);

  const s3 = await srv.req('POST', '/api/saas/billing/simulate-pix', {
    cookie: superCookie,
    headers: { 'Idempotency-Key': kSim },
    body: { tenantId: 'gymapi', invoiceId: invId }
  });
  assert.equal(s3.status, 200);
  assert.equal(s3.headers.get('idempotency-replayed'), 'true');
  assert.equal(s3.body.alreadyProcessed, false, 'replay devolve exatamente a resposta da 1a execução');

  // 5c) POST /api/saas/admin/tenants/invoice (2x simultâneo + 1x sequencial)
  const kInv = crypto.randomUUID();
  const [i1, i2] = await Promise.all([
    srv.req('POST', '/api/saas/admin/tenants/invoice', {
      cookie: superCookie,
      headers: { 'Idempotency-Key': kInv },
      body: { tenantId: 'gymapi', refMonth: '2026-12', amount: 269, method: 'PIX', status: 'paid', note: 'Avulsa' }
    }),
    srv.req('POST', '/api/saas/admin/tenants/invoice', {
      cookie: superCookie,
      headers: { 'Idempotency-Key': kInv },
      body: { tenantId: 'gymapi', refMonth: '2026-12', amount: 269, method: 'PIX', status: 'paid', note: 'Avulsa' }
    })
  ]);
  assert.equal(i1.status, 200);
  assert.equal(i2.status, 200);
  assert.equal(i1.body.invoice.id, i2.body.invoice.id);
  const inst = getSqliteInstance(dataDir);
  assert.equal(
    inst.db.prepare("SELECT COUNT(*) AS c FROM saas_invoices WHERE tenant_id = 'gymapi'").get().c,
    2,
    'apenas 1 fatura checkout + 1 fatura avulsa criadas'
  );

  const iMismatch = await srv.req('POST', '/api/saas/admin/tenants/invoice', {
    cookie: superCookie,
    headers: { 'Idempotency-Key': kInv },
    body: { tenantId: 'gymapi', refMonth: '2026-12', amount: 999, method: 'PIX', status: 'paid' }
  });
  assert.equal(iMismatch.status, 422);

  // 5d) POST /api/saas/admin/tenants (2x simultâneo + retry sequencial devolve 201 com mesma senha inicial)
  const kTenant = crypto.randomUUID();
  const [t1, t2] = await Promise.all([
    srv.req('POST', '/api/saas/admin/tenants', {
      cookie: superCookie,
      headers: { 'Idempotency-Key': kTenant },
      body: { id: 'novaacad', name: 'Nova Acad', planId: 'starter', ownerName: 'Pedro', ownerEmail: 'pedro@novaacad.com' }
    }),
    srv.req('POST', '/api/saas/admin/tenants', {
      cookie: superCookie,
      headers: { 'Idempotency-Key': kTenant },
      body: { id: 'novaacad', name: 'Nova Acad', planId: 'starter', ownerName: 'Pedro', ownerEmail: 'pedro@novaacad.com' }
    })
  ]);
  assert.equal(t1.status, 201);
  assert.equal(t2.status, 201);
  assert.equal(t1.body.tenant.id, 'novaacad');
  assert.equal(t2.body.initialOwnerPassword, t1.body.initialOwnerPassword);
});

/* =========================================================================
 * 6. Recuperação no boot de evento travado em 'processing'
 * ========================================================================= */
test('Worker 6: recoverWebhookQueueOnBoot destrava eventos presos em processing e drena uma única vez', async t => {
  const mocks = await startMockMpAndEvolution(t);
  const prevBase = process.env.MERCADO_PAGO_API_BASE;
  const prevTok = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  const prevEvoUrl = process.env.EVOLUTION_API_URL;
  const prevEvoKey = process.env.EVOLUTION_API_KEY;
  const prevEvoInst = process.env.EVOLUTION_INSTANCE;

  process.env.MERCADO_PAGO_API_BASE = mocks.mpBaseUrl;
  process.env.MERCADO_PAGO_ACCESS_TOKEN = 'APP_USR-test-token-12345';
  process.env.EVOLUTION_API_URL = mocks.evoBaseUrl;
  process.env.EVOLUTION_API_KEY = 'evo-key';
  process.env.EVOLUTION_INSTANCE = 'rit-inst';

  const dataDir = makeTempDir('rit-wh-boot-');
  t.after(() => {
    cleanupTempDir(dataDir);
    if (prevBase === undefined) delete process.env.MERCADO_PAGO_API_BASE; else process.env.MERCADO_PAGO_API_BASE = prevBase;
    if (prevTok === undefined) delete process.env.MERCADO_PAGO_ACCESS_TOKEN; else process.env.MERCADO_PAGO_ACCESS_TOKEN = prevTok;
    if (prevEvoUrl === undefined) delete process.env.EVOLUTION_API_URL; else process.env.EVOLUTION_API_URL = prevEvoUrl;
    if (prevEvoKey === undefined) delete process.env.EVOLUTION_API_KEY; else process.env.EVOLUTION_API_KEY = prevEvoKey;
    if (prevEvoInst === undefined) delete process.env.EVOLUTION_INSTANCE; else process.env.EVOLUTION_INSTANCE = prevEvoInst;
  });

  createTenant(dataDir, { id: 'gymboot', name: 'Gym Boot', planId: 'pro', status: 'past_due', phone: '11966665555' });
  const mpPid = '77003';
  const invId = 'inv_boot1';
  const inst = getSqliteInstance(dataDir);
  inst.stmts.insertInvoiceIgnore.run(
    invId, 'gymboot', 'pro', 'pix_checkout', 26900, 'pending', 'PIX (Mercado Pago)',
    mpPid, crypto.randomUUID(), Date.now(), null, Date.now() + 86400000,
    JSON.stringify({ id: invId, amount: 269, status: 'pending', cycle: 'monthly', planId: 'pro', mpPaymentId: mpPid })
  );
  mocks.state.paymentsById.set(mpPid, {
    id: mpPid,
    status: 'approved',
    transaction_amount: 269,
    external_reference: `rit:gymboot:${invId}:monthly:pro`,
    date_approved: new Date().toISOString()
  });

  // Simula processo que morreu logo após fazer claim em 'processing'
  registerWebhookEventSqlite(dataDir, {
    eventId: 'mp:evt:stuck_boot_1',
    provider: 'mercadopago',
    actionType: 'payment.updated',
    resourceId: mpPid,
    payloadHash: 'hash1',
    rawPayload: JSON.stringify({ id: 'stuck_boot_1', type: 'payment', data: { id: mpPid } }),
    initialStatus: 'queued'
  });
  inst.stmts.claimWebhookEvent.get(Date.now() - 5000, 'mp:evt:stuck_boot_1');
  assert.equal(inst.stmts.getWebhookEvent.get('mp:evt:stuck_boot_1').status, 'processing');

  const reclaimed = recoverWebhookQueueOnBoot(dataDir, {});
  assert.equal(reclaimed, 1);
  await flushWebhookQueue(dataDir, {});

  assert.equal(inst.stmts.getWebhookEvent.get('mp:evt:stuck_boot_1').status, 'processed');
  assert.equal(getTenant(dataDir, 'gymboot').status, 'active');
  assert.equal(mocks.state.getPaymentCalls.length, 1);
  assert.equal(mocks.state.waCalls.length, 1);
});
