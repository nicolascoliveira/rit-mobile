/**
 * api/test/critical-flows-rspec.test.js
 *
 * Suíte de integração no estilo Request Spec (RSpec: describe / it "quando..., então...")
 * cobrindo os 8 fluxos críticos (F1..F8) contra o servidor HTTP real (`server.js`) e banco SQLite
 * isolado em diretório temporário com todos os 14 triggers de política instalados.
 *
 * Apenas APIs de terceiros (Mercado Pago e Evolution API WhatsApp) são simuladas via HTTP local.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { boundPort } from './helpers.mjs';
import * as M from './media-samples.mjs';
import { runSecurityMigrations } from '../migrate-security.js';
import { getTenant } from '../tenants.js';
import { getSqliteInstance, closeSqliteInstance } from '../sqlite.js';

const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://app.rit.test';
const PORTAL_URL = 'https://painel.rit.test';
const EVIL_ORIGIN = 'https://evil.example';
const SETUP_ADMIN_TOKEN = 'setup-token-rspec-2026';
const WEBHOOK_SECRET = 'mp-webhook-secret-rspec-2026';
const MP_ACCESS_TOKEN = 'APP_USR-847291047281-111116-abcdef1234567890-12345678';

function signMpWebhook({
  dataId,
  requestId = `req-${crypto.randomBytes(4).toString('hex')}`,
  ts = String(Math.floor(Date.now() / 1000)),
  rawBody = '',
  secret = WEBHOOK_SECRET,
  withBodySig = false
}) {
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const headers = {
    'x-signature': `ts=${ts},v1=${v1}`,
    'x-request-id': requestId
  };
  if (withBodySig) {
    const bodyHex = crypto
      .createHmac('sha256', secret)
      .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody)))
      .digest('hex');
    headers['x-body-signature'] = `sha256=${bodyHex}`;
  }
  return headers;
}

function extractSessionCookie(headers) {
  const list = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
  for (const raw of list) {
    const pair = String(raw || '').split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if ((name === '__Host-gymsid' || name === 'gymsid') && val) {
      return pair;
    }
  }
  return null;
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error('Timeout aguardando condição assíncrona na suíte RSpec');
}

async function startRealRspecEnv({ env = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rit-rspec-'));
  const secretHex = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'secret'), secretHex, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [],
    creds: [],
    subs: [],
    invites: [],
    deviceLinks: [],
    watches: []
  }));

  runSecurityMigrations({ dataDir, secret: secretHex });
  try { closeSqliteInstance(dataDir); } catch { /* ignore */ }

  const mockState = {
    createPixCalls: [],
    getPaymentCalls: [],
    waCalls: [],
    paymentsById: new Map(),
    failNextCreatePixCount: 0,
    createPixStatusOnFail: 502,
    createPixDelayMs: 0,
    nextPixId: 9100
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
        mockState.createPixCalls.push({
          idempotencyKey: req.headers['x-idempotency-key'] || '',
          authorization: req.headers.authorization || '',
          body
        });
        if (mockState.createPixDelayMs > 0) {
          await new Promise(r => setTimeout(r, mockState.createPixDelayMs));
        }
        if (mockState.failNextCreatePixCount > 0) {
          mockState.failNextCreatePixCount--;
          res.writeHead(mockState.createPixStatusOnFail, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ message: 'gateway error', status: mockState.createPixStatusOnFail }));
        }
        const id = String(mockState.nextPixId++);
        const created = {
          id,
          status: 'pending',
          transaction_amount: Number(body?.transaction_amount || 0),
          external_reference: body?.external_reference || '',
          point_of_interaction: {
            transaction_data: {
              qr_code: `000201010212MOCKPIX${id}`,
              qr_code_base64: Buffer.from(`qr_${id}`).toString('base64'),
              ticket_url: `https://mp.mock/tickets/${id}`
            }
          },
          date_created: new Date().toISOString(),
          date_of_expiration: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
        };
        mockState.paymentsById.set(id, created);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(created));
      }

      const getMatch = /^\/v1\/payments\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && getMatch) {
        const pid = decodeURIComponent(getMatch[1]);
        mockState.getPaymentCalls.push(pid);
        const rec = mockState.paymentsById.get(pid);
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
      mockState.waCalls.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ key: { id: 'wa_' + crypto.randomBytes(4).toString('hex') }, status: 'PENDING' }));
    });
  });

  await new Promise(resolve => mpServer.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => evoServer.listen(0, '127.0.0.1', resolve));

  const mpBaseUrl = `http://127.0.0.1:${mpServer.address().port}`;
  const evoBaseUrl = `http://127.0.0.1:${evoServer.address().port}`;

  const child = spawn(process.execPath, ['server.js'], {
    cwd: API_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      ORIGIN,
      PORTAL_URL,
      RP_ID: 'rit.test',
      PASSWORD_LOGIN: '1',
      MEDIA_UPLOADS: '1',
      MEDIA_MIN_FREE_MB: '1',
      TRUST_PROXY: '1',
      NODE_ENV: 'production',
      SAAS_DEMO: '0',
      SAAS_AUTO_SEED: '0',
      SETUP_ADMIN_TOKEN,
      MERCADO_PAGO_ACCESS_TOKEN: MP_ACCESS_TOKEN,
      MERCADO_PAGO_WEBHOOK_SECRET: WEBHOOK_SECRET,
      MERCADO_PAGO_API_BASE: mpBaseUrl,
      EVOLUTION_API_URL: evoBaseUrl,
      EVOLUTION_API_KEY: 'evo-test-key',
      ...env
    }
  });

  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  const port = await boundPort(child, () => log);
  const api = `http://127.0.0.1:${port}`;
  let ipSeq = 10;

  const req = async (method, urlPath, {
    body,
    rawBody,
    token,
    cookie,
    origin = ORIGIN,
    secFetchSite = 'same-origin',
    ip,
    headers = {}
  } = {}) => {
    const reqHeaders = {
      'X-Forwarded-For': ip || `198.51.100.${++ipSeq}`,
      'X-Forwarded-Proto': 'https',
      ...(origin !== null ? { Origin: origin } : {}),
      ...(secFetchSite !== null ? { 'Sec-Fetch-Site': secFetchSite } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    };
    const r = await fetch(`${api}${urlPath}`, {
      method,
      headers: reqHeaders,
      body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body))
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return {
      status: r.status,
      body: parsed,
      headers: r.headers,
      cookie: extractSessionCookie(r.headers)
    };
  };

  const reqBinary = async (method, urlPath, {
    bytes,
    contentType = 'application/octet-stream',
    token,
    cookie,
    origin = ORIGIN,
    secFetchSite = 'same-origin',
    ip,
    headers = {}
  } = {}) => {
    const r = await fetch(`${api}${urlPath}`, {
      method,
      headers: {
        'X-Forwarded-For': ip || `198.51.100.${++ipSeq}`,
        'X-Forwarded-Proto': 'https',
        ...(origin !== null ? { Origin: origin } : {}),
        ...(secFetchSite !== null ? { 'Sec-Fetch-Site': secFetchSite } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        'Content-Type': contentType,
        ...headers
      },
      body: bytes
    });
    const buf = Buffer.from(await r.arrayBuffer());
    let parsed = null;
    try { parsed = JSON.parse(buf.toString('utf8')); } catch { parsed = null; }
    return { status: r.status, body: parsed, bytes: buf, headers: r.headers };
  };

  const setupSuperAdmin = async ({
    email = 'root@rit.test',
    password = 'SuperPassword!2026',
    name = 'Super Admin Rit'
  } = {}) => {
    const r = await req('POST', '/api/saas/auth/setup-admin', {
      origin: PORTAL_URL,
      headers: { 'X-Setup-Token': SETUP_ADMIN_TOKEN },
      body: { email, password, name }
    });
    assert.equal(r.status, 200, `setupSuperAdmin falhou: ${JSON.stringify(r.body)}`);
    return r.body.token;
  };

  const close = () => {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    try { mpServer.close(); } catch { /* ignore */ }
    try { evoServer.close(); } catch { /* ignore */ }
    try { closeSqliteInstance(dataDir); } catch { /* ignore */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  return {
    api,
    dataDir,
    mpBaseUrl,
    evoBaseUrl,
    mockState,
    req,
    reqBinary,
    setupSuperAdmin,
    close,
    getLog: () => log
  };
}

/* =========================================================================
 * F1 — Setup Inicial da Plataforma e Autenticação B2B (/api/saas/auth/*)
 * ========================================================================= */
describe('F1 — Setup Inicial da Plataforma e Autenticação B2B (/api/saas/auth/*)', () => {
  it('quando não existe Super Admin e POST /api/saas/auth/setup-admin recebe X-Setup-Token válido, então cria o Super Admin (200) e permite login em POST /api/saas/auth/login com token Bearer e cookie gymsid', async () => {
    const env = await startRealRspecEnv();
    try {
      const setupRes = await env.req('POST', '/api/saas/auth/setup-admin', {
        origin: PORTAL_URL,
        headers: { 'X-Setup-Token': SETUP_ADMIN_TOKEN },
        body: { email: 'admin@rit.test', password: 'SuperStrongPassword!2026', name: 'Dono Plataforma' }
      });
      assert.equal(setupRes.status, 200);
      assert.equal(setupRes.body.ok, true);
      assert.ok(setupRes.body.token);
      assert.equal(setupRes.body.user.saasRole, 'superadmin');

      const loginRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'admin@rit.test', password: 'SuperStrongPassword!2026' }
      });
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.body.ok, true);
      assert.ok(loginRes.body.token);
      assert.ok(loginRes.cookie, 'deve emitir cookie __Host-gymsid ou gymsid');

      const meRes = await env.req('GET', '/api/saas/auth/me', {
        origin: PORTAL_URL,
        token: loginRes.body.token
      });
      assert.equal(meRes.status, 200);
      assert.equal(meRes.body.user.email, 'admin@rit.test');
    } finally {
      env.close();
    }
  });

  it('quando POST /api/saas/auth/setup-admin é chamado sem X-Setup-Token ou com token incorreto em produção, então retorna 403 invalid-setup-token', async () => {
    const env = await startRealRspecEnv();
    try {
      const noTok = await env.req('POST', '/api/saas/auth/setup-admin', {
        origin: PORTAL_URL,
        body: { email: 'admin@rit.test', password: 'SuperStrongPassword!2026', name: 'Invasor' }
      });
      assert.equal(noTok.status, 403);
      assert.equal(noTok.body.code, 'invalid-setup-token');

      const wrongTok = await env.req('POST', '/api/saas/auth/setup-admin', {
        origin: PORTAL_URL,
        headers: { 'X-Setup-Token': 'token-errado-12345' },
        body: { email: 'admin@rit.test', password: 'SuperStrongPassword!2026', name: 'Invasor' }
      });
      assert.equal(wrongTok.status, 403);
      assert.equal(wrongTok.body.code, 'invalid-setup-token');
    } finally {
      env.close();
    }
  });

  it('quando POST /api/saas/auth/login recebe senha incorreta ou setup recebe senha fraca, então retorna 401/400 sem emitir sessão', async () => {
    const env = await startRealRspecEnv();
    try {
      const weakSetup = await env.req('POST', '/api/saas/auth/setup-admin', {
        origin: PORTAL_URL,
        headers: { 'X-Setup-Token': SETUP_ADMIN_TOKEN },
        body: { email: 'admin@rit.test', password: '123', name: 'Admin' }
      });
      assert.equal(weakSetup.status, 400);
      assert.equal(weakSetup.body.token, undefined);

      await env.setupSuperAdmin({ email: 'admin@rit.test', password: 'SuperStrongPassword!2026' });

      const wrongLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'admin@rit.test', password: 'SenhaCompletamenteErrada!1' }
      });
      assert.equal(wrongLogin.status, 401);
      assert.equal(wrongLogin.body.token, undefined);
      assert.equal(wrongLogin.cookie, null);
    } finally {
      env.close();
    }
  });

  it('quando dois profissionais de academias diferentes possuem o mesmo nome e POST /api/saas/auth/login recebe apenas o nome sem tenantId, então retorna 409 ambiguous-identifier', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-alfa',
          name: 'Academia Alfa',
          planId: 'pro',
          ownerName: 'Carlos Silva',
          ownerEmail: 'carlos.alfa@rit.test',
          ownerPassword: 'OwnerAlfaPassword!2026'
        }
      });
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-beta',
          name: 'Academia Beta',
          planId: 'pro',
          ownerName: 'Carlos Silva',
          ownerEmail: 'carlos.beta@rit.test',
          ownerPassword: 'OwnerBetaPassword!2026'
        }
      });

      const ambRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { identifier: 'Carlos Silva', password: 'OwnerAlfaPassword!2026' }
      });
      assert.equal(ambRes.status, 409);
      assert.equal(ambRes.body.code, 'ambiguous-identifier');

      // Com tenantId informado, desambigua e autentica corretamente
      const scopedRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { identifier: 'Carlos Silva', password: 'OwnerBetaPassword!2026', tenantId: 'acad-beta' }
      });
      assert.equal(scopedRes.status, 200);
      assert.equal(scopedRes.body.tenant.id, 'acad-beta');
    } finally {
      env.close();
    }
  });

  it('quando duas requisições simultâneas (Promise.all) tentam executar POST /api/saas/auth/setup-admin no banco vazio, então apenas uma retorna 200 e a outra retorna 403', async () => {
    const env = await startRealRspecEnv();
    try {
      const [r1, r2] = await Promise.all([
        env.req('POST', '/api/saas/auth/setup-admin', {
          origin: PORTAL_URL,
          headers: { 'X-Setup-Token': SETUP_ADMIN_TOKEN },
          body: { email: 'admin1@rit.test', password: 'SuperStrongPassword!1', name: 'Admin 1' }
        }),
        env.req('POST', '/api/saas/auth/setup-admin', {
          origin: PORTAL_URL,
          headers: { 'X-Setup-Token': SETUP_ADMIN_TOKEN },
          body: { email: 'admin2@rit.test', password: 'SuperStrongPassword!2', name: 'Admin 2' }
        })
      ]);
      assert.deepEqual([r1.status, r2.status].sort((a, b) => a - b), [200, 403]);
    } finally {
      env.close();
    }
  });

  it('quando um IP dispara mais de 10 tentativas inválidas seguidas em POST /api/saas/auth/login, então passa a receber 429 rate-limited sem bloquear o login de outro identificador legítimo', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin({ email: 'root@rit.test', password: 'SuperPassword!2026' });
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-ok',
          name: 'Academia OK',
          planId: 'pro',
          ownerName: 'Gestor Legitimo',
          ownerEmail: 'legitimo@rit.test',
          ownerPassword: 'LegitimoPassword!2026'
        }
      });

      const sharedIp = '203.0.113.77';
      const statuses = [];
      for (let i = 0; i < 11; i++) {
        const res = await env.req('POST', '/api/saas/auth/login', {
          origin: PORTAL_URL,
          ip: sharedIp,
          body: { email: 'root@rit.test', password: `SenhaErradaAttempt#${i}` }
        });
        statuses.push(res.status);
      }
      assert.equal(statuses.at(-1), 429, `esperava 429 após >5/10 tentativas; obtido: ${JSON.stringify(statuses)}`);

      const otherAcctOk = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        ip: sharedIp,
        body: { email: 'legitimo@rit.test', password: 'LegitimoPassword!2026' }
      });
      assert.equal(otherAcctOk.status, 200);
      assert.ok(otherAcctOk.body.token);
    } finally {
      env.close();
    }
  });

  it('quando o usuário faz POST /api/logout/all, então o session_version (sv) é incrementado e o token Bearer anterior passa a retornar 401 em GET /api/saas/auth/me', async () => {
    const env = await startRealRspecEnv();
    try {
      const tokenBefore = await env.setupSuperAdmin();
      const meOk = await env.req('GET', '/api/saas/auth/me', { origin: PORTAL_URL, token: tokenBefore });
      assert.equal(meOk.status, 200);

      const logoutAll = await env.req('POST', '/api/logout/all', { origin: PORTAL_URL, token: tokenBefore });
      assert.equal(logoutAll.status, 200);

      const meAfter = await env.req('GET', '/api/saas/auth/me', { origin: PORTAL_URL, token: tokenBefore });
      assert.equal(meAfter.status, 401);
    } finally {
      env.close();
    }
  });

  it('quando um aluno autenticado tenta acessar GET /api/saas/auth/me ou rotas do portal B2B, então retorna 403', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-stu', name: 'Acad Stu', planId: 'pro', ownerName: 'Gestor', ownerEmail: 'g@stu.test', ownerPassword: 'GestorPassword!2026' }
      });
      const regRes = await env.req('POST', '/api/register/password?tenant=acad-stu', {
        body: { name: 'Aluno Comum', email: 'aluno@stu.test', password: 'AlunoPassword!2026' }
      });
      assert.equal(regRes.status, 200);

      const meB2b = await env.req('GET', '/api/saas/auth/me', { cookie: regRes.cookie });
      assert.equal(meB2b.status, 403);

      const overviewB2b = await env.req('GET', '/api/gym/overview', { cookie: regRes.cookie });
      assert.equal(overviewB2b.status, 403);
    } finally {
      env.close();
    }
  });

  it('quando uma requisição autenticada via cookie gymsid envia Origin externo malicioso (https://evil.example), então é bloqueada com 403 cross-origin denied', async () => {
    const env = await startRealRspecEnv();
    try {
      await env.setupSuperAdmin({ email: 'root@rit.test', password: 'SuperPassword!2026' });
      const loginRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'root@rit.test', password: 'SuperPassword!2026' }
      });
      assert.ok(loginRes.cookie);

      // Com cookie e Origin externo (sem Sec-Fetch-Site same-origin), CSRF deve negar 403
      const csrfAttempt = await env.req('POST', '/api/saas/admin/tenants', {
        origin: EVIL_ORIGIN,
        secFetchSite: null,
        cookie: loginRes.cookie,
        body: { id: 'csrf-gym', name: 'CSRF Gym', planId: 'pro' }
      });
      assert.equal(csrfAttempt.status, 403);

      const csrfSecFetch = await env.req('POST', '/api/saas/admin/tenants', {
        origin: EVIL_ORIGIN,
        secFetchSite: 'cross-site',
        cookie: loginRes.cookie,
        body: { id: 'csrf-gym', name: 'CSRF Gym', planId: 'pro' }
      });
      assert.equal(csrfSecFetch.status, 403);
    } finally {
      env.close();
    }
  });

  it('quando academia ou personal trainer cria conta via /api/saas/auth/register (caminho feliz), então provisiona tenant em trial de 14 dias, templates padrão, usuário gym_owner isolado e ignora tentativa de escalonamento', async () => {
    const env = await startRealRspecEnv();
    try {
      const gymSignup = await env.req('POST', '/api/saas/auth/register', {
        origin: PORTAL_URL,
        body: {
          accountType: 'gym',
          gymName: 'Academia Atlas',
          ownerName: 'Lucas Andrade',
          email: 'lucas@atlas.fit',
          phone: '11988887777',
          password: 'AtlasStrong#2026',
          planId: 'pro',
          saasRole: 'superadmin',
          status: 'active',
          maxStudentsOverride: 999999
        }
      });
      assert.equal(gymSignup.status, 201);
      assert.equal(gymSignup.body.ok, true);
      assert.equal(gymSignup.body.isNewSignup, true);
      assert.ok(gymSignup.body.token);
      assert.ok(gymSignup.cookie);
      assert.equal(gymSignup.body.user.saasRole, 'gym_owner');
      assert.equal(gymSignup.body.tenant.accountType, 'gym');
      assert.equal(gymSignup.body.tenant.planId, 'pro');
      assert.equal(gymSignup.body.tenant.status, 'trial');
      assert.ok(gymSignup.body.tenant.trialEndsAt);

      const meRes = await env.req('GET', '/api/saas/auth/me', { cookie: gymSignup.cookie });
      assert.equal(meRes.status, 200);
      assert.equal(meRes.body.user.saasRole, 'gym_owner');
      assert.equal(meRes.body.tenant.id, gymSignup.body.tenant.id);

      const templatesRes = await env.req('GET', '/api/gym/templates', { cookie: gymSignup.cookie });
      assert.equal(templatesRes.status, 200);
      assert.ok(Array.isArray(templatesRes.body.templates) && templatesRes.body.templates.length >= 1);

      const adminDenied = await env.req('GET', '/api/saas/admin/overview', { cookie: gymSignup.cookie });
      assert.equal(adminDenied.status, 403);

      const personalSignup = await env.req('POST', '/api/saas/auth/register', {
        origin: PORTAL_URL,
        body: {
          accountType: 'personal',
          gymName: 'Consultoria Bia',
          ownerName: 'Beatriz Costa',
          email: 'bia@personal.fit',
          password: 'BiaStrong#2026'
        }
      });
      assert.equal(personalSignup.status, 201);
      assert.equal(personalSignup.body.tenant.accountType, 'personal');
      assert.equal(personalSignup.body.tenant.planId, 'personal');
      assert.equal(personalSignup.body.tenant.status, 'trial');
    } finally {
      env.close();
    }
  });

  it('quando o cadastro recebe senha fraca, plano inexistente, slug reservado, e-mail duplicado ou duas requisições simultâneas (Promise.all), então rejeita inválidos (400), bloqueia duplicata (409) e só cria uma conta na concorrência', async () => {
    const env = await startRealRspecEnv();
    try {
      const weakPw = await env.req('POST', '/api/saas/auth/register', {
        origin: PORTAL_URL,
        body: {
          accountType: 'gym',
          gymName: 'Gym Fraca',
          ownerName: 'Joao Pedro',
          email: 'fraca@gym.fit',
          password: '12345'
        }
      });
      assert.equal(weakPw.status, 400);

      const badPlan = await env.req('POST', '/api/saas/auth/register', {
        origin: PORTAL_URL,
        body: {
          accountType: 'gym',
          gymName: 'Gym Plano',
          ownerName: 'Joao Pedro',
          email: 'plano@gym.fit',
          password: 'StrongPassword#2026',
          planId: 'plano-inexistente'
        }
      });
      assert.equal(badPlan.status, 400);

      const reservedSlug = await env.req('POST', '/api/saas/auth/register', {
        origin: PORTAL_URL,
        body: {
          accountType: 'gym',
          slug: 'admin',
          gymName: 'Admin Fake',
          ownerName: 'Joao Pedro',
          email: 'slug@gym.fit',
          password: 'StrongPassword#2026'
        }
      });
      assert.equal(reservedSlug.status, 400);

      const first = await env.req('POST', '/api/saas/auth/register', {
        origin: PORTAL_URL,
        headers: { 'Idempotency-Key': 'reg-idem-key-1' },
        body: {
          accountType: 'gym',
          gymName: 'Academia Duplo',
          ownerName: 'Marcos Silva',
          email: 'duplo@gym.fit',
          password: 'StrongPassword#2026'
        }
      });
      assert.equal(first.status, 201);

      // Replay idempotente devolve 201 com o mesmo payload sem duplicar conta
      const replay = await env.req('POST', '/api/saas/auth/register', {
        origin: PORTAL_URL,
        headers: { 'Idempotency-Key': 'reg-idem-key-1' },
        body: {
          accountType: 'gym',
          gymName: 'Academia Duplo',
          ownerName: 'Marcos Silva',
          email: 'duplo@gym.fit',
          password: 'StrongPassword#2026'
        }
      });
      assert.equal(replay.status, 201);
      assert.equal(replay.body.tenant.id, first.body.tenant.id);

      // Outro request sem a chave de idempotência com o mesmo e-mail deve retornar 409
      const dupEmail = await env.req('POST', '/api/saas/auth/register', {
        origin: PORTAL_URL,
        body: {
          accountType: 'gym',
          gymName: 'Academia Outro Nome',
          ownerName: 'Marcos Silva',
          email: 'DUPLO@gym.fit',
          password: 'StrongPassword#2026'
        }
      });
      assert.equal(dupEmail.status, 409);

      // Disparo concorrente simultâneo com mesmo e-mail: apenas 1 passa (201), o outro falha (409)
      const [r1, r2] = await Promise.all([
        env.req('POST', '/api/saas/auth/register', {
          origin: PORTAL_URL,
          headers: { 'Idempotency-Key': 'race-reg-a' },
          body: {
            accountType: 'gym',
            gymName: 'Race Gym',
            ownerName: 'Ana Paula',
            email: 'race@gym.fit',
            password: 'RacePassword#2026'
          }
        }),
        env.req('POST', '/api/saas/auth/register', {
          origin: PORTAL_URL,
          headers: { 'Idempotency-Key': 'race-reg-b' },
          body: {
            accountType: 'gym',
            gymName: 'Race Gym',
            ownerName: 'Ana Paula',
            email: 'race@gym.fit',
            password: 'RacePassword#2026'
          }
        })
      ]);
      assert.deepEqual([r1.status, r2.status].sort((a, b) => a - b), [201, 409]);
    } finally {
      env.close();
    }
  });
});

/* =========================================================================
 * F2 — Gestão de Academias, Planos e Faturas pelo Super Admin
 * ========================================================================= */
describe('F2 — Gestão de Academias, Planos e Faturas pelo Super Admin (/api/saas/admin/*)', () => {
  it('quando o Super Admin chama POST /api/saas/admin/tenants com dados válidos, então cria a academia (201), o usuário gym_owner e os templates iniciais', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      const createRes = await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'forca-pura',
          name: 'Força Pura Academia',
          planId: 'pro',
          ownerName: 'Marina Dona',
          ownerEmail: 'marina@forcapura.test',
          ownerPassword: 'MarinaOwnerPassword!2026'
        }
      });
      assert.equal(createRes.status, 201);
      assert.equal(createRes.body.ok, true);
      assert.equal(createRes.body.tenant.id, 'forca-pura');
      assert.equal(createRes.body.ownerCreated, true);

      const ownerLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'marina@forcapura.test', password: 'MarinaOwnerPassword!2026' }
      });
      assert.equal(ownerLogin.status, 200);
      assert.equal(ownerLogin.body.user.saasRole, 'gym_owner');

      const tpls = await env.req('GET', '/api/gym/templates', {
        origin: PORTAL_URL,
        token: ownerLogin.body.token
      });
      assert.equal(tpls.status, 200);
      assert.ok(Array.isArray(tpls.body.templates) && tpls.body.templates.length > 0);
    } finally {
      env.close();
    }
  });

  it('quando POST /api/saas/admin/tenants recebe e-mail de gestor já existente ou senha fraca (<10 chars), então retorna 409 ou 400 sem criar academia órfã', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin({ email: 'root@rit.test' });
      const dupEmail = await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'orfa-dup',
          name: 'Órfã Dup',
          planId: 'starter',
          ownerName: 'Dup',
          ownerEmail: 'root@rit.test',
          ownerPassword: 'OwnerDupPassword!2026'
        }
      });
      assert.equal(dupEmail.status, 409);

      const weakPw = await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'orfa-pw',
          name: 'Órfã PW',
          planId: 'starter',
          ownerName: 'Weak',
          ownerEmail: 'weak@rit.test',
          ownerPassword: '123456'
        }
      });
      assert.equal(weakPw.status, 400);

      const listRes = await env.req('GET', '/api/saas/admin/tenants', { origin: PORTAL_URL, token: superTok });
      assert.equal(listRes.status, 200);
      assert.equal(listRes.body.tenants.some(t => t.id === 'orfa-dup' || t.id === 'orfa-pw'), false);
    } finally {
      env.close();
    }
  });

  it('quando duas requisições simultâneas (Promise.all) enviam POST /api/saas/admin/tenants com a mesma Idempotency-Key, então apenas uma academia é criada e o replay retorna o mesmo resultado', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      const idemKey = `idem-tenant-${crypto.randomUUID()}`;
      const payload = {
        id: 'acad-idem',
        name: 'Academia Idempotente',
        planId: 'starter',
        ownerName: 'Gestor Idem',
        ownerEmail: 'idem@acad.test',
        ownerPassword: 'GestorIdemPassword!2026'
      };

      const [c1, c2] = await Promise.all([
        env.req('POST', '/api/saas/admin/tenants', {
          origin: PORTAL_URL,
          token: superTok,
          headers: { 'Idempotency-Key': idemKey },
          body: payload
        }),
        env.req('POST', '/api/saas/admin/tenants', {
          origin: PORTAL_URL,
          token: superTok,
          headers: { 'Idempotency-Key': idemKey },
          body: payload
        })
      ]);

      assert.equal(c1.status, 201);
      assert.equal(c2.status, 201);
      assert.equal(c1.body.tenant.id, 'acad-idem');
      assert.equal(c2.body.tenant.id, 'acad-idem');
      const replayedFlags = [
        c1.headers.get('idempotency-replayed') === 'true',
        c2.headers.get('idempotency-replayed') === 'true'
      ].sort();
      assert.deepEqual(replayedFlags, [false, true]);
    } finally {
      env.close();
    }
  });

  it('quando POST /api/saas/admin/tenants/invoice recebe amount <= 0 (zero ou negativo), então rejeita com 400', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-inv', name: 'Acad Inv', planId: 'pro' }
      });

      const zeroRes = await env.req('POST', '/api/saas/admin/tenants/invoice', {
        origin: PORTAL_URL,
        token: superTok,
        body: { tenantId: 'acad-inv', amount: 0, status: 'paid' }
      });
      assert.equal(zeroRes.status, 400, `fatura com amount=0 deveria retornar 400, retornou ${zeroRes.status}`);

      const negRes = await env.req('POST', '/api/saas/admin/tenants/invoice', {
        origin: PORTAL_URL,
        token: superTok,
        body: { tenantId: 'acad-inv', amount: -50, status: 'paid' }
      });
      assert.equal(negRes.status, 400, `fatura com amount=-50 deveria retornar 400, retornou ${negRes.status}`);
    } finally {
      env.close();
    }
  });

  it('quando um gym_owner tenta chamar POST /api/saas/admin/tenants, PUT /api/saas/admin/tenants ou POST /api/saas/admin/tenants/status, então recebe 403', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-a',
          name: 'Acad A',
          planId: 'pro',
          ownerName: 'Dono A',
          ownerEmail: 'dono.a@rit.test',
          ownerPassword: 'DonoAPassword!2026'
        }
      });
      const ownerLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'dono.a@rit.test', password: 'DonoAPassword!2026' }
      });
      const ownerTok = ownerLogin.body.token;

      const rPost = await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: ownerTok,
        body: { id: 'hack', name: 'Hack', planId: 'pro' }
      });
      assert.equal(rPost.status, 403);

      const rPut = await env.req('PUT', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: ownerTok,
        body: { id: 'acad-a', maxStudentsOverride: 99999 }
      });
      assert.equal(rPut.status, 403);

      const rStatus = await env.req('POST', '/api/saas/admin/tenants/status', {
        origin: PORTAL_URL,
        token: ownerTok,
        body: { id: 'acad-a', status: 'suspended' }
      });
      assert.equal(rStatus.status, 403);
    } finally {
      env.close();
    }
  });

  it('quando há tentativa direta no SQLite de gravar usuário sem tenant_id ou rebaixar fatura paga, então os triggers de segurança do banco abortam a operação', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-trg', name: 'Acad Trg', planId: 'pro' }
      });
      await env.req('POST', '/api/saas/admin/tenants/invoice', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'inv_paid_lock', tenantId: 'acad-trg', amount: 269, status: 'paid' }
      });

      const inst = getSqliteInstance(env.dataDir);
      assert.throws(() => {
        inst.db.prepare(
          `INSERT INTO users (id, tenant_id, email, name, role, data, updated_at)
           VALUES (?, '', ?, ?, 'student', '{}', ?)`
        ).run('u_blank_tenant', 'semtenant_f2@test.local', 'Sem Tenant', Date.now());
      }, /policy: users\.tenant_id cannot be blank/i);

      assert.throws(() => {
        inst.db.prepare(
          `UPDATE saas_invoices SET status = 'pending' WHERE id = ?`
        ).run('inv_paid_lock');
      }, /policy: cannot downgrade a paid invoice/i);
    } finally {
      env.close();
    }
  });
});

/* =========================================================================
 * F3 — Equipe da Academia, Convites e Cadastro de Alunos
 * ========================================================================= */
describe('F3 — Equipe da Academia, Convites e Cadastro de Alunos (/api/gym/team, /api/gym/invites, /api/register/password)', () => {
  it('quando o gym_owner cria um professor em POST /api/gym/team (201), gera um convite em POST /api/gym/invites (201) e o aluno se cadastra em POST /api/register/password com o código, então o aluno é criado na academia correta e o convite é marcado como usado', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-f3',
          name: 'Acad F3',
          planId: 'starter',
          ownerName: 'Gestor F3',
          ownerEmail: 'gestor@f3.test',
          ownerPassword: 'GestorF3Password!2026'
        }
      });
      const ownerLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'gestor@f3.test', password: 'GestorF3Password!2026' }
      });
      const ownerTok = ownerLogin.body.token;

      const teamRes = await env.req('POST', '/api/gym/team', {
        origin: PORTAL_URL,
        token: ownerTok,
        body: { name: 'Prof Joao', email: 'prof.joao@f3.test', saasRole: 'trainer', password: 'ProfJoaoPassword!2026' }
      });
      assert.equal(teamRes.status, 201);
      assert.equal(teamRes.body.member.saasRole, 'trainer');

      const invRes = await env.req('POST', '/api/gym/invites', {
        origin: PORTAL_URL,
        token: ownerTok,
        body: { note: 'Convite Boas Vindas' }
      });
      assert.equal(invRes.status, 201);
      const code = invRes.body.invite.code;
      assert.ok(code);

      const regRes = await env.req('POST', '/api/register/password?tenant=acad-f3', {
        body: { name: 'Aluno Convite', email: 'aluno.conv@f3.test', password: 'AlunoPassword!2026', code }
      });
      assert.equal(regRes.status, 200);
      assert.ok(regRes.cookie);

      const listInv = await env.req('GET', '/api/gym/invites', { origin: PORTAL_URL, token: ownerTok });
      const usedInv = listInv.body.invites.find(i => i.code === code);
      assert.ok(usedInv.usedBy, 'convite deve registrar usedBy');

      const stuList = await env.req('GET', '/api/gym/students', { origin: PORTAL_URL, token: ownerTok });
      assert.ok(stuList.body.students.some(s => s.email === 'aluno.conv@f3.test'));
    } finally {
      env.close();
    }
  });

  it('quando POST /api/register/password recebe um código de convite inexistente ou já utilizado, então retorna 403', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-invonly',
          name: 'Acad InviteOnly',
          planId: 'starter',
          ownerName: 'Gestor IO',
          ownerEmail: 'io@f3.test',
          ownerPassword: 'GestorIoPassword!2026',
          settings: { inviteOnly: true }
        }
      });
      const ownerLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'io@f3.test', password: 'GestorIoPassword!2026' }
      });
      const inv = await env.req('POST', '/api/gym/invites', { origin: PORTAL_URL, token: ownerLogin.body.token, body: {} });
      const code = inv.body.invite.code;

      const badCode = await env.req('POST', '/api/register/password?tenant=acad-invonly', {
        body: { name: 'Sem Convite', email: 'sem@f3.test', password: 'AlunoPassword!2026', code: 'INEXISTENTE99' }
      });
      assert.equal(badCode.status, 403);

      const okFirst = await env.req('POST', '/api/register/password?tenant=acad-invonly', {
        body: { name: 'Primeiro', email: 'um@f3.test', password: 'AlunoPassword!2026', code }
      });
      assert.equal(okFirst.status, 200);

      const reuseSecond = await env.req('POST', '/api/register/password?tenant=acad-invonly', {
        body: { name: 'Segundo', email: 'dois@f3.test', password: 'AlunoPassword!2026', code }
      });
      assert.equal(reuseSecond.status, 403);
    } finally {
      env.close();
    }
  });

  it('quando dois alunos disparam POST /api/register/password simultaneamente (Promise.all) usando o mesmo código de convite de uso único, então apenas um retorna 200 e o outro retorna 403', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-race-inv',
          name: 'Acad Race Inv',
          planId: 'starter',
          ownerName: 'Gestor R',
          ownerEmail: 'r@f3.test',
          ownerPassword: 'GestorRacePassword!2026',
          settings: { inviteOnly: true }
        }
      });
      const ownerLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'r@f3.test', password: 'GestorRacePassword!2026' }
      });
      const inv = await env.req('POST', '/api/gym/invites', { origin: PORTAL_URL, token: ownerLogin.body.token, body: {} });
      const code = inv.body.invite.code;

      const [r1, r2] = await Promise.all([
        env.req('POST', '/api/register/password?tenant=acad-race-inv', {
          ip: '198.51.100.101',
          body: { name: 'Cand 1', email: 'cand1@f3.test', password: 'StrongCandPassword!1', code }
        }),
        env.req('POST', '/api/register/password?tenant=acad-race-inv', {
          ip: '198.51.100.102',
          body: { name: 'Cand 2', email: 'cand2@f3.test', password: 'StrongCandPassword!2', code }
        })
      ]);
      assert.deepEqual([r1.status, r2.status].sort((a, b) => a - b), [200, 403]);
    } finally {
      env.close();
    }
  });

  it('quando duas matrículas simultâneas (Promise.all) em POST /api/gym/students tentam cadastrar o mesmo e-mail (com caixa diferente), então apenas uma retorna 201 e a outra retorna 409', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-dup',
          name: 'Acad Dup',
          planId: 'pro',
          ownerName: 'Gestor Dup',
          ownerEmail: 'dup@f3.test',
          ownerPassword: 'GestorDupPassword!2026'
        }
      });
      const ownerLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'dup@f3.test', password: 'GestorDupPassword!2026' }
      });
      const tok = ownerLogin.body.token;

      const [s1, s2] = await Promise.all([
        env.req('POST', '/api/gym/students', {
          origin: PORTAL_URL,
          token: tok,
          body: { name: 'Maria A', email: 'Maria@F3.TEST', password: 'StudentPass!2026' }
        }),
        env.req('POST', '/api/gym/students', {
          origin: PORTAL_URL,
          token: tok,
          body: { name: 'Maria B', email: 'maria@f3.test', password: 'StudentPass!2026' }
        })
      ]);
      assert.deepEqual([s1.status, s2.status].sort((a, b) => a - b), [201, 409]);
    } finally {
      env.close();
    }
  });

  it('quando a academia atinge maxStudents do plano e duas requisições simultâneas (Promise.all) tentam matricular alunos na última vaga em POST /api/gym/students, então apenas uma retorna 201 e a outra retorna 403 plan-limit', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      const capCreate = await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-cap',
          name: 'Acad Cap',
          planId: 'starter',
          ownerName: 'Gestor Cap',
          ownerEmail: 'cap@f3.test',
          ownerPassword: 'GestorCapPassword!2026',
          maxStudentsOverride: 1
        }
      });
      assert.equal(capCreate.status, 201);
      const capPut = await env.req('PUT', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-cap',
          maxStudentsOverride: 1
        }
      });
      assert.equal(capPut.status, 200);
      const ownerLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'cap@f3.test', password: 'GestorCapPassword!2026' }
      });
      const tok = ownerLogin.body.token;

      const [s1, s2] = await Promise.all([
        env.req('POST', '/api/gym/students', {
          origin: PORTAL_URL,
          token: tok,
          body: { name: 'Vaga 1', email: 'v1@f3.test', password: 'StudentPass!2026' }
        }),
        env.req('POST', '/api/gym/students', {
          origin: PORTAL_URL,
          token: tok,
          body: { name: 'Vaga 2', email: 'v2@f3.test', password: 'StudentPass!2026' }
        })
      ]);
      assert.deepEqual([s1.status, s2.status].sort((a, b) => a - b), [201, 403]);
      const denied = s1.status === 403 ? s1 : s2;
      assert.equal(denied.body.code, 'plan-limit');
    } finally {
      env.close();
    }
  });

  it('quando a academia atinge maxTrainers do plano, então POST /api/gym/team rejeita novo professor com 403 plan-limit', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      // Plano personal tem maxTrainers: 1 (o próprio dono/personal já conta como 1 staff)
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-maxtr',
          name: 'Acad MaxTr',
          planId: 'personal',
          ownerName: 'Personal Dono',
          ownerEmail: 'pers@f3.test',
          ownerPassword: 'PersonalPassword!2026'
        }
      });
      const ownerLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'pers@f3.test', password: 'PersonalPassword!2026' }
      });
      const r = await env.req('POST', '/api/gym/team', {
        origin: PORTAL_URL,
        token: ownerLogin.body.token,
        body: { name: 'Extra Prof', email: 'extra@f3.test', saasRole: 'trainer', password: 'ExtraPassword!2026' }
      });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'plan-limit');
    } finally {
      env.close();
    }
  });

  it('quando um professor comum (trainer) tenta criar ou remover membros em POST /api/gym/team ou DELETE /api/gym/team, então retorna 403', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-rbac',
          name: 'Acad RBAC',
          planId: 'pro',
          ownerName: 'Dono RBAC',
          ownerEmail: 'dono.rbac@f3.test',
          ownerPassword: 'DonoRbacPassword!2026'
        }
      });
      const ownerLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'dono.rbac@f3.test', password: 'DonoRbacPassword!2026' }
      });
      const ownerTok = ownerLogin.body.token;
      const trCreate = await env.req('POST', '/api/gym/team', {
        origin: PORTAL_URL,
        token: ownerTok,
        body: { name: 'Trainer Comum', email: 'tr@rbac.test', saasRole: 'trainer', password: 'TrainerPassword!2026' }
      });
      const trainerId = trCreate.body.member.id;

      const trLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'tr@rbac.test', password: 'TrainerPassword!2026' }
      });
      const trTok = trLogin.body.token;

      const postTeam = await env.req('POST', '/api/gym/team', {
        origin: PORTAL_URL,
        token: trTok,
        body: { name: 'Outro', email: 'outro@rbac.test', password: 'OutroPassword!2026' }
      });
      assert.equal(postTeam.status, 403);

      const delTeam = await env.req('DELETE', '/api/gym/team', {
        origin: PORTAL_URL,
        token: trTok,
        body: { id: trainerId }
      });
      assert.equal(delTeam.status, 403);
    } finally {
      env.close();
    }
  });

  it('quando um gerente (gym_manager) tenta alterar a senha do proprietário (gym_owner) em PUT /api/gym/team, então retorna 403', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-mgr',
          name: 'Acad Mgr',
          planId: 'pro',
          ownerName: 'Proprietario Real',
          ownerEmail: 'owner@mgr.test',
          ownerPassword: 'OwnerMgrPassword!2026'
        }
      });
      const ownerLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'owner@mgr.test', password: 'OwnerMgrPassword!2026' }
      });
      const ownerId = ownerLogin.body.user.id;
      const ownerTok = ownerLogin.body.token;

      await env.req('POST', '/api/gym/team', {
        origin: PORTAL_URL,
        token: ownerTok,
        body: { name: 'Gerente', email: 'ger@mgr.test', saasRole: 'gym_manager', password: 'ManagerPassword!2026' }
      });
      const mgrLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'ger@mgr.test', password: 'ManagerPassword!2026' }
      });

      const editOwner = await env.req('PUT', '/api/gym/team', {
        origin: PORTAL_URL,
        token: mgrLogin.body.token,
        body: { id: ownerId, password: 'HackedOwnerPassword!2026' }
      });
      assert.equal(editOwner.status, 403);
    } finally {
      env.close();
    }
  });
});

/* =========================================================================
 * F4 — Checkout PIX de Assinatura SaaS
 * ========================================================================= */
describe('F4 — Checkout PIX de Assinatura SaaS (/api/saas/billing/checkout-pix, /api/saas/billing/invoice)', () => {
  it('quando o gym_owner chama POST /api/saas/billing/checkout-pix com planId e cycle válidos, então reserva a fatura pending, chama o Mercado Pago e retorna 200 com qrCode, qrCodeBase64 e paymentId', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-pix1',
          name: 'Acad Pix 1',
          planId: 'starter',
          ownerName: 'Dono Pix',
          ownerEmail: 'pix@acad.test',
          ownerPassword: 'OwnerPixPassword!2026'
        }
      });
      const loginRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'pix@acad.test', password: 'OwnerPixPassword!2026' }
      });

      const res = await env.req('POST', '/api/saas/billing/checkout-pix', {
        origin: PORTAL_URL,
        token: loginRes.body.token,
        body: { planId: 'pro', cycle: 'monthly' }
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.invoice.status, 'pending');
      assert.ok(res.body.pix.paymentId);
      assert.ok(res.body.pix.qrCode);
      assert.ok(res.body.pix.qrCodeBase64);
      assert.equal(env.mockState.createPixCalls.length, 1);
    } finally {
      env.close();
    }
  });

  it('quando o Mercado Pago falha (400/502) durante POST /api/saas/billing/checkout-pix, então a fatura local é marcada como failed e a rota retorna erro sem deixar fatura travada em checkout_creating', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-mpfail',
          name: 'Acad MPFail',
          planId: 'starter',
          ownerName: 'Dono Fail',
          ownerEmail: 'fail@acad.test',
          ownerPassword: 'OwnerFailPassword!2026'
        }
      });
      const loginRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'fail@acad.test', password: 'OwnerFailPassword!2026' }
      });

      env.mockState.failNextCreatePixCount = 2; // mpIdempotentRequest faz 1 retry automático (maxAttempts = 2) em 502
      env.mockState.createPixStatusOnFail = 502;
      const res = await env.req('POST', '/api/saas/billing/checkout-pix', {
        origin: PORTAL_URL,
        token: loginRes.body.token,
        body: { planId: 'pro', cycle: 'monthly' }
      });
      assert.equal(res.status, 502);

      const tenant = getTenant(env.dataDir, 'acad-mpfail');
      assert.ok(tenant.invoices.every(inv => inv.status !== 'checkout_creating'), 'nenhuma fatura deve ficar presa em checkout_creating');
      assert.ok(tenant.invoices.some(inv => inv.status === 'failed'));
    } finally {
      env.close();
    }
  });

  it('quando o gym_owner clica duas vezes simultaneamente (Promise.all) em POST /api/saas/billing/checkout-pix para o mesmo plano e ciclo, então apenas uma cobrança é enviada ao Mercado Pago e ambas retornam o mesmo paymentId e invoice.id', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-dblpix',
          name: 'Acad DblPix',
          planId: 'starter',
          ownerName: 'Dono Dbl',
          ownerEmail: 'dbl@acad.test',
          ownerPassword: 'OwnerDblPassword!2026'
        }
      });
      const loginRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'dbl@acad.test', password: 'OwnerDblPassword!2026' }
      });
      const tok = loginRes.body.token;
      const idemKey = `pix-dbl-${crypto.randomUUID()}`;

      env.mockState.createPixDelayMs = 80;
      const [r1, r2] = await Promise.all([
        env.req('POST', '/api/saas/billing/checkout-pix', {
          origin: PORTAL_URL,
          token: tok,
          headers: { 'Idempotency-Key': idemKey },
          body: { planId: 'pro', cycle: 'monthly' }
        }),
        env.req('POST', '/api/saas/billing/checkout-pix', {
          origin: PORTAL_URL,
          token: tok,
          headers: { 'Idempotency-Key': idemKey },
          body: { planId: 'pro', cycle: 'monthly' }
        })
      ]);

      assert.equal(r1.status, 200);
      assert.equal(r2.status, 200);
      assert.equal(r1.body.pix.paymentId, r2.body.pix.paymentId);
      assert.equal(r1.body.invoice.id, r2.body.invoice.id);
      assert.equal(env.mockState.createPixCalls.length, 1);
    } finally {
      env.close();
    }
  });

  it('quando a mesma Idempotency-Key é reutilizada em POST /api/saas/billing/checkout-pix com outro planId, então retorna 422 idempotency_payload_mismatch', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-mismatch',
          name: 'Acad Mismatch',
          planId: 'starter',
          ownerName: 'Dono Mis',
          ownerEmail: 'mis@acad.test',
          ownerPassword: 'OwnerMisPassword!2026'
        }
      });
      const loginRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'mis@acad.test', password: 'OwnerMisPassword!2026' }
      });
      const tok = loginRes.body.token;
      const idemKey = `pix-mis-${crypto.randomUUID()}`;

      const first = await env.req('POST', '/api/saas/billing/checkout-pix', {
        origin: PORTAL_URL,
        token: tok,
        headers: { 'Idempotency-Key': idemKey },
        body: { planId: 'starter', cycle: 'monthly' }
      });
      assert.equal(first.status, 200);

      const second = await env.req('POST', '/api/saas/billing/checkout-pix', {
        origin: PORTAL_URL,
        token: tok,
        headers: { 'Idempotency-Key': idemKey },
        body: { planId: 'pro', cycle: 'monthly' }
      });
      assert.equal(second.status, 422);
      assert.equal(second.body.code, 'idempotency_payload_mismatch');
    } finally {
      env.close();
    }
  });

  it('quando POST /api/saas/billing/checkout-pix recebe planId inexistente, então retorna 400 sem gerar cobrança no Mercado Pago', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-badplan',
          name: 'Acad BadPlan',
          planId: 'starter',
          ownerName: 'Dono Bad',
          ownerEmail: 'badplan@acad.test',
          ownerPassword: 'OwnerBadPassword!2026'
        }
      });
      const loginRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'badplan@acad.test', password: 'OwnerBadPassword!2026' }
      });

      const res = await env.req('POST', '/api/saas/billing/checkout-pix', {
        origin: PORTAL_URL,
        token: loginRes.body.token,
        body: { planId: 'plano-inexistente-xyz', cycle: 'monthly' }
      });
      assert.equal(res.status, 400, `planId inexistente deveria retornar 400, retornou ${res.status}`);
      assert.equal(env.mockState.createPixCalls.length, 0);
    } finally {
      env.close();
    }
  });

  it('quando a academia está past_due (inadimplente), então o gym_owner ainda consegue chamar POST /api/saas/billing/checkout-pix (modo billingOnly), mas fica bloqueado (403) de cadastrar alunos em POST /api/gym/students', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-pastdue',
          name: 'Acad PastDue',
          planId: 'starter',
          status: 'past_due',
          ownerName: 'Dono PD',
          ownerEmail: 'pd@acad.test',
          ownerPassword: 'OwnerPdPassword!2026'
        }
      });
      const loginRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'pd@acad.test', password: 'OwnerPdPassword!2026' }
      });
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.body.billingOnly, true);

      const stuBlocked = await env.req('POST', '/api/gym/students', {
        origin: PORTAL_URL,
        token: loginRes.body.token,
        body: { name: 'Bloqueado', email: 'b@pd.test', password: 'StudentPass!2026' }
      });
      assert.equal(stuBlocked.status, 403);
      assert.equal(stuBlocked.body.code, 'past-due');

      const pixAllowed = await env.req('POST', '/api/saas/billing/checkout-pix', {
        origin: PORTAL_URL,
        token: loginRes.body.token,
        body: { planId: 'pro', cycle: 'monthly' }
      });
      assert.equal(pixAllowed.status, 200);
      assert.ok(pixAllowed.body.pix.paymentId);
    } finally {
      env.close();
    }
  });

  it('quando um trainer ou student tenta chamar POST /api/saas/billing/checkout-pix, então retorna 403', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-pixrbac',
          name: 'Acad PixRBAC',
          planId: 'pro',
          ownerName: 'Dono R',
          ownerEmail: 'dr@pix.test',
          ownerPassword: 'OwnerRPassword!2026'
        }
      });
      const ownerLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'dr@pix.test', password: 'OwnerRPassword!2026' }
      });
      await env.req('POST', '/api/gym/team', {
        origin: PORTAL_URL,
        token: ownerLogin.body.token,
        body: { name: 'Prof R', email: 'pr@pix.test', saasRole: 'trainer', password: 'TrainerRPassword!2026' }
      });
      const trLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'pr@pix.test', password: 'TrainerRPassword!2026' }
      });
      const stuReg = await env.req('POST', '/api/register/password?tenant=acad-pixrbac', {
        body: { name: 'Stu Pix', email: 'st@pix.test', password: 'StudentRPassword!2026' }
      });

      const trTry = await env.req('POST', '/api/saas/billing/checkout-pix', {
        origin: PORTAL_URL,
        token: trLogin.body.token,
        body: { planId: 'pro', cycle: 'monthly' }
      });
      assert.equal(trTry.status, 403);

      const stuTry = await env.req('POST', '/api/saas/billing/checkout-pix', {
        cookie: stuReg.cookie,
        body: { planId: 'pro', cycle: 'monthly' }
      });
      assert.equal(stuTry.status, 403);
    } finally {
      env.close();
    }
  });

  it('quando o gym_owner da academia-a consulta GET /api/saas/billing/invoice?id=<fatura_da_academia_b>, então retorna 404', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-a', name: 'Acad A', planId: 'pro', ownerName: 'Dono A', ownerEmail: 'da@inv.test', ownerPassword: 'DonoAPassword!2026' }
      });
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-b', name: 'Acad B', planId: 'pro', ownerName: 'Dono B', ownerEmail: 'db@inv.test', ownerPassword: 'DonoBPassword!2026' }
      });
      const logA = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'da@inv.test', password: 'DonoAPassword!2026' }
      });
      const logB = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'db@inv.test', password: 'DonoBPassword!2026' }
      });
      const pixB = await env.req('POST', '/api/saas/billing/checkout-pix', {
        origin: PORTAL_URL,
        token: logB.body.token,
        body: { planId: 'pro', cycle: 'monthly' }
      });
      const invB = pixB.body.invoice.id;

      const idor = await env.req('GET', `/api/saas/billing/invoice?id=${encodeURIComponent(invB)}`, {
        origin: PORTAL_URL,
        token: logA.body.token
      });
      assert.equal(idor.status, 404);
    } finally {
      env.close();
    }
  });
});

/* =========================================================================
 * F5 — Webhooks do Mercado Pago e Reconciliação Financeira
 * ========================================================================= */
describe('F5 — Webhooks do Mercado Pago e Reconciliação Financeira (/api/saas/billing/webhook)', () => {
  it('quando POST /api/saas/billing/webhook recebe notificação com x-signature HMAC válida e o pagamento consta approved no Mercado Pago, então enfileira o evento (200), o worker marca a fatura como paid, ativa a academia e enfileira aviso no WhatsApp', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-whok',
          name: 'Acad Webhook OK',
          planId: 'starter',
          status: 'past_due',
          phone: '5511999998888',
          ownerName: 'Dono WH',
          ownerEmail: 'wh@acad.test',
          ownerPassword: 'OwnerWhPassword!2026'
        }
      });
      const loginRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'wh@acad.test', password: 'OwnerWhPassword!2026' }
      });
      const pixRes = await env.req('POST', '/api/saas/billing/checkout-pix', {
        origin: PORTAL_URL,
        token: loginRes.body.token,
        body: { planId: 'pro', cycle: 'monthly' }
      });
      const pid = pixRes.body.pix.paymentId;

      const mpRec = env.mockState.paymentsById.get(pid);
      mpRec.status = 'approved';
      mpRec.date_approved = new Date().toISOString();

      const rawBody = JSON.stringify({ id: 'evt_wh_ok_1', action: 'payment.updated', data: { id: pid } });
      const sigHeaders = signMpWebhook({ dataId: pid, rawBody });
      const whRes = await env.req('POST', '/api/saas/billing/webhook', {
        rawBody,
        origin: null,
        secFetchSite: null,
        headers: sigHeaders
      });
      assert.equal(whRes.status, 200);
      assert.equal(whRes.body.queued, true);

      await waitFor(() => {
        const t = getTenant(env.dataDir, 'acad-whok');
        const inv = t?.invoices?.find(i => i.id === pixRes.body.invoice.id);
        return inv?.status === 'paid' && t.status === 'active';
      });

      await waitFor(() => env.mockState.waCalls.length === 1);
      const tFinal = getTenant(env.dataDir, 'acad-whok');
      assert.equal(tFinal.status, 'active');
      assert.equal(tFinal.planId, 'pro');
    } finally {
      env.close();
    }
  });

  it('quando POST /api/saas/billing/webhook recebe x-signature inválida ou ausente, então rejeita com 401 sem processar o pagamento', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-sig', name: 'Acad Sig', planId: 'starter', ownerName: 'Dono S', ownerEmail: 's@sig.test', ownerPassword: 'DonoSigPassword!2026' }
      });
      const logRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 's@sig.test', password: 'DonoSigPassword!2026' }
      });
      const pixRes = await env.req('POST', '/api/saas/billing/checkout-pix', {
        origin: PORTAL_URL,
        token: logRes.body.token,
        body: { planId: 'pro', cycle: 'monthly' }
      });
      const pid = pixRes.body.pix.paymentId;
      env.mockState.paymentsById.get(pid).status = 'approved';

      const rawBody = JSON.stringify({ id: 'evt_bad_sig', action: 'payment.updated', data: { id: pid } });

      const missingSig = await env.req('POST', '/api/saas/billing/webhook', {
        rawBody,
        origin: null,
        secFetchSite: null
      });
      assert.equal(missingSig.status, 401);

      const wrongSig = await env.req('POST', '/api/saas/billing/webhook', {
        rawBody,
        origin: null,
        secFetchSite: null,
        headers: signMpWebhook({ dataId: pid, rawBody, secret: 'segredo-errado' })
      });
      assert.equal(wrongSig.status, 401);
      assert.equal(env.mockState.getPaymentCalls.length, 0);
      assert.equal(getTenant(env.dataDir, 'acad-sig').invoices[0].status, 'pending');
    } finally {
      env.close();
    }
  });

  it('quando o pagamento consultado no Mercado Pago está rejected ou cancelled, então a fatura muda para failed/cancelled e o plano da academia não é renovado', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      const fixedBilling = '2026-12-01T00:00:00.000Z';
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-rej',
          name: 'Acad Rej',
          planId: 'starter',
          nextBillingAt: fixedBilling,
          ownerName: 'Dono Rej',
          ownerEmail: 'rej@acad.test',
          ownerPassword: 'OwnerRejPassword!2026'
        }
      });
      const logRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'rej@acad.test', password: 'OwnerRejPassword!2026' }
      });
      const pixRes = await env.req('POST', '/api/saas/billing/checkout-pix', {
        origin: PORTAL_URL,
        token: logRes.body.token,
        body: { planId: 'pro', cycle: 'monthly' }
      });
      const pid = pixRes.body.pix.paymentId;
      env.mockState.paymentsById.get(pid).status = 'rejected';

      const rawBody = JSON.stringify({ id: 'evt_rej_1', action: 'payment.updated', data: { id: pid } });
      const whRes = await env.req('POST', '/api/saas/billing/webhook', {
        rawBody,
        origin: null,
        secFetchSite: null,
        headers: signMpWebhook({ dataId: pid, rawBody })
      });
      assert.equal(whRes.status, 200);

      await waitFor(() => {
        const t = getTenant(env.dataDir, 'acad-rej');
        return t?.invoices?.find(i => i.id === pixRes.body.invoice.id)?.status === 'failed';
      });
      const tAfter = getTenant(env.dataDir, 'acad-rej');
      assert.equal(tAfter.planId, 'starter');
      assert.equal(tAfter.nextBillingAt, fixedBilling);
    } finally {
      env.close();
    }
  });

  it('quando o Mercado Pago dispara 5 webhooks idênticos simultaneamente (Promise.all) para o mesmo paymentId aprovado, então nextBillingAt avança exatamente 1 ciclo (~30 dias), apenas 1 fatura fica paid e apenas 1 mensagem WhatsApp é enviada', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      const baseBillingMs = Date.now() + 10 * 86400000;
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-wh5',
          name: 'Acad WH5',
          planId: 'starter',
          phone: '5511988887777',
          nextBillingAt: new Date(baseBillingMs).toISOString(),
          ownerName: 'Dono WH5',
          ownerEmail: 'wh5@acad.test',
          ownerPassword: 'OwnerWh5Password!2026'
        }
      });
      const logRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'wh5@acad.test', password: 'OwnerWh5Password!2026' }
      });
      const pixRes = await env.req('POST', '/api/saas/billing/checkout-pix', {
        origin: PORTAL_URL,
        token: logRes.body.token,
        body: { planId: 'pro', cycle: 'monthly' }
      });
      const pid = pixRes.body.pix.paymentId;
      env.mockState.paymentsById.get(pid).status = 'approved';
      env.mockState.paymentsById.get(pid).date_approved = new Date().toISOString();

      const rawBody = JSON.stringify({ id: 'evt_dup_5x', action: 'payment.updated', data: { id: pid } });
      const sigHeaders = signMpWebhook({ dataId: pid, rawBody });

      const responses = await Promise.all(
        Array.from({ length: 5 }, () =>
          env.req('POST', '/api/saas/billing/webhook', {
            rawBody,
            origin: null,
            secFetchSite: null,
            headers: sigHeaders
          })
        )
      );
      assert.ok(responses.every(r => r.status === 200));

      await waitFor(() => {
        const t = getTenant(env.dataDir, 'acad-wh5');
        return t?.invoices?.some(i => i.mpPaymentId === pid && i.status === 'paid');
      });
      await waitFor(() => env.mockState.waCalls.length === 1);
      await new Promise(r => setTimeout(r, 150));

      const tFinal = getTenant(env.dataDir, 'acad-wh5');
      // createTenant com status=active gera 1 fatura "Assinatura inicial"; somada à do checkout PIX = 2 faturas pagas sem duplicação
      assert.equal(tFinal.invoices.length, 2);
      assert.equal(tFinal.invoices.filter(i => i.mpPaymentId === pid && i.status === 'paid').length, 1);
      const diffDays = (Date.parse(tFinal.nextBillingAt) - baseBillingMs) / 86400000;
      assert.ok(diffDays >= 29.5 && diffDays <= 30.5, `esperava +30 dias; avançou ${diffDays.toFixed(2)}d`);
      assert.equal(env.mockState.waCalls.length, 1);
    } finally {
      env.close();
    }
  });

  it('quando o Mercado Pago retorna transaction_amount = 0 ou inferior ao valor da fatura para um pagamento approved, então rejeita por amount_mismatch e não aprova a fatura', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-underpay',
          name: 'Acad Underpay',
          planId: 'starter',
          status: 'past_due',
          ownerName: 'Dono Up',
          ownerEmail: 'up@acad.test',
          ownerPassword: 'OwnerUpPassword!2026'
        }
      });
      const logRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'up@acad.test', password: 'OwnerUpPassword!2026' }
      });
      const pixRes = await env.req('POST', '/api/saas/billing/checkout-pix', {
        origin: PORTAL_URL,
        token: logRes.body.token,
        body: { planId: 'pro', cycle: 'monthly' }
      });
      const pid = pixRes.body.pix.paymentId;

      const mpRec = env.mockState.paymentsById.get(pid);
      mpRec.status = 'approved';
      mpRec.transaction_amount = 0;

      const rawBody = JSON.stringify({ id: 'evt_underpay_0', action: 'payment.updated', data: { id: pid } });
      const whRes = await env.req('POST', '/api/saas/billing/webhook', {
        rawBody,
        origin: null,
        secFetchSite: null,
        headers: signMpWebhook({ dataId: pid, rawBody })
      });
      assert.equal(whRes.status, 200);
      assert.ok(whRes.body.eventId);

      await waitFor(() => {
        const inst = getSqliteInstance(env.dataDir);
        const row = inst.stmts.getWebhookEvent.get(whRes.body.eventId);
        return row && row.status === 'ignored';
      });

      const tAfter = getTenant(env.dataDir, 'acad-underpay');
      assert.equal(tAfter.status, 'past_due');
      assert.equal(tAfter.invoices.find(i => i.id === pixRes.body.invoice.id).status, 'pending');
    } finally {
      env.close();
    }
  });

  it('quando um webhook tardio chega com status cancelled para uma fatura que já está paid, então ignora o downgrade e mantém a fatura como paid', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-late',
          name: 'Acad Late',
          planId: 'starter',
          ownerName: 'Dono Late',
          ownerEmail: 'late@acad.test',
          ownerPassword: 'OwnerLatePassword!2026'
        }
      });
      const logRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'late@acad.test', password: 'OwnerLatePassword!2026' }
      });
      const pixRes = await env.req('POST', '/api/saas/billing/checkout-pix', {
        origin: PORTAL_URL,
        token: logRes.body.token,
        body: { planId: 'pro', cycle: 'monthly' }
      });
      const pid = pixRes.body.pix.paymentId;

      env.mockState.paymentsById.get(pid).status = 'approved';
      const raw1 = JSON.stringify({ id: 'evt_paid_first', action: 'payment.updated', data: { id: pid } });
      await env.req('POST', '/api/saas/billing/webhook', {
        rawBody: raw1,
        origin: null,
        secFetchSite: null,
        headers: signMpWebhook({ dataId: pid, rawBody: raw1 })
      });
      await waitFor(() => getTenant(env.dataDir, 'acad-late').invoices[0].status === 'paid');

      env.mockState.paymentsById.get(pid).status = 'cancelled';
      const raw2 = JSON.stringify({ id: 'evt_cancel_late', action: 'payment.updated', data: { id: pid } });
      const wh2Res = await env.req('POST', '/api/saas/billing/webhook', {
        rawBody: raw2,
        origin: null,
        secFetchSite: null,
        headers: signMpWebhook({ dataId: pid, rawBody: raw2 })
      });
      assert.equal(wh2Res.status, 200);
      assert.ok(wh2Res.body.eventId);
      await waitFor(() => {
        const row = getSqliteInstance(env.dataDir).stmts.getWebhookEvent.get(wh2Res.body.eventId);
        return row && (row.status === 'processed' || row.status === 'ignored');
      });

      const tFinal = getTenant(env.dataDir, 'acad-late');
      assert.equal(tFinal.invoices.find(i => i.id === pixRes.body.invoice.id).status, 'paid');
      assert.equal(tFinal.status, 'active');
    } finally {
      env.close();
    }
  });

  it('quando o Mercado Pago retorna um pagamento approved cujo external_reference aponta para academia-b mas o mpPaymentId pertence a uma fatura da academia-a, então não ativa indevidamente o plano da academia-b', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-a',
          name: 'Acad A',
          planId: 'starter',
          ownerName: 'Dono A',
          ownerEmail: 'a@xwh.test',
          ownerPassword: 'OwnerAXPassword!2026'
        }
      });
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-b',
          name: 'Acad B',
          planId: 'starter',
          status: 'past_due',
          ownerName: 'Dono B',
          ownerEmail: 'b@xwh.test',
          ownerPassword: 'OwnerBXPassword!2026'
        }
      });
      const logA = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'a@xwh.test', password: 'OwnerAXPassword!2026' }
      });
      const pixA = await env.req('POST', '/api/saas/billing/checkout-pix', {
        origin: PORTAL_URL,
        token: logA.body.token,
        body: { planId: 'pro', cycle: 'monthly' }
      });
      const pidA = pixA.body.pix.paymentId;

      // Simula divergência no gateway: pagamento de A com external_reference apontando para B
      const mpRec = env.mockState.paymentsById.get(pidA);
      mpRec.status = 'approved';
      mpRec.external_reference = `rit:acad-b:inv_forjada_b:monthly:pro`;

      const rawBody = JSON.stringify({ id: 'evt_cross_tenant_ref', action: 'payment.updated', data: { id: pidA } });
      const whRes = await env.req('POST', '/api/saas/billing/webhook', {
        rawBody,
        origin: null,
        secFetchSite: null,
        headers: signMpWebhook({ dataId: pidA, rawBody })
      });
      assert.equal(whRes.status, 200);

      await waitFor(() => env.mockState.getPaymentCalls.includes(pidA));
      await new Promise(r => setTimeout(r, 150));

      const tenantB = getTenant(env.dataDir, 'acad-b');
      assert.equal(tenantB.status, 'past_due');
      assert.equal(tenantB.planId, 'starter');
      assert.equal(tenantB.invoices.length, 0);
    } finally {
      env.close();
    }
  });
});

/* =========================================================================
 * F6 — Gestão de Alunos, Prescrição de Treinos e Agenda
 * ========================================================================= */
describe('F6 — Gestão de Alunos, Prescrição de Treinos e Agenda (/api/gym/students, /api/gym/prescribe, /api/gym/student/week)', () => {
  it('quando um professor prescreve uma ficha em POST /api/gym/prescribe e atualiza a agenda em POST /api/gym/student/week, então o aluno vê a rotina e a agenda ao consultar GET /api/data', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-presc',
          name: 'Acad Presc',
          planId: 'pro',
          ownerName: 'Prof Owner',
          ownerEmail: 'prof@presc.test',
          ownerPassword: 'ProfOwnerPassword!2026'
        }
      });
      const profLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'prof@presc.test', password: 'ProfOwnerPassword!2026' }
      });
      const stuCreate = await env.req('POST', '/api/gym/students', {
        origin: PORTAL_URL,
        token: profLogin.body.token,
        body: { name: 'Aluno Treino', email: 'alu@presc.test', password: 'AlunoPrescPassword!2026' }
      });
      assert.equal(stuCreate.status, 201);
      const stuId = stuCreate.body.student.id;

      const prescRes = await env.req('POST', '/api/gym/prescribe', {
        origin: PORTAL_URL,
        token: profLogin.body.token,
        body: {
          studentId: stuId,
          day: 1,
          routine: { name: 'Peito e Tríceps', ex: [{ id: '0025', sets: 4, reps: 10, weight: 40 }] }
        }
      });
      assert.equal(prescRes.status, 200);
      const rid = prescRes.body.routine.id;

      const weekRes = await env.req('POST', '/api/gym/student/week', {
        origin: PORTAL_URL,
        token: profLogin.body.token,
        body: { studentId: stuId, week: { 1: rid, 4: rid } }
      });
      assert.equal(weekRes.status, 200);

      const stuLogin = await env.req('POST', '/api/login/password?tenant=acad-presc', {
        body: { identifier: 'alu@presc.test', password: 'AlunoPrescPassword!2026' }
      });
      assert.equal(stuLogin.status, 200);

      const dataRes = await env.req('GET', '/api/data', { cookie: stuLogin.cookie });
      assert.equal(dataRes.status, 200);
      assert.ok(dataRes.body.state.routines.some(r => r.id === rid && r.name === 'Peito e Tríceps'));
      assert.deepEqual(dataRes.body.state.week['4'], [rid]);
    } finally {
      env.close();
    }
  });

  it('quando POST /api/gym/prescribe recebe payload sem aluno, sem nome da ficha ou sem lista de exercícios, então retorna 400', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-perr', name: 'Acad PErr', planId: 'pro', ownerName: 'Prof', ownerEmail: 'p@perr.test', ownerPassword: 'ProfErrPassword!2026' }
      });
      const profLogin = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'p@perr.test', password: 'ProfErrPassword!2026' }
      });
      const stu = await env.req('POST', '/api/gym/students', {
        origin: PORTAL_URL,
        token: profLogin.body.token,
        body: { name: 'Stu', email: 's@perr.test', password: 'StudentPassword!2026' }
      });

      const noStu = await env.req('POST', '/api/gym/prescribe', {
        origin: PORTAL_URL,
        token: profLogin.body.token,
        body: { routine: { name: 'Treino A', ex: [{ id: '0025' }] } }
      });
      assert.equal(noStu.status, 400);

      const noName = await env.req('POST', '/api/gym/prescribe', {
        origin: PORTAL_URL,
        token: profLogin.body.token,
        body: { studentId: stu.body.student.id, routine: { name: '', ex: [{ id: '0025' }] } }
      });
      assert.equal(noName.status, 400);

      const noEx = await env.req('POST', '/api/gym/prescribe', {
        origin: PORTAL_URL,
        token: profLogin.body.token,
        body: { studentId: stu.body.student.id, routine: { name: 'Treino Sem Ex' } }
      });
      assert.equal(noEx.status, 400);
    } finally {
      env.close();
    }
  });

  it('quando dois professores prescrevem fichas diferentes simultaneamente (Promise.all) para o mesmo aluno em POST /api/gym/prescribe, então ambas as fichas são preservadas no estado do aluno sem sobrescrita (lost update)', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-cpresc', name: 'Acad CPresc', planId: 'pro', ownerName: 'Prof 1', ownerEmail: 'p1@cp.test', ownerPassword: 'Prof1Password!2026' }
      });
      const p1Login = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'p1@cp.test', password: 'Prof1Password!2026' }
      });
      await env.req('POST', '/api/gym/team', {
        origin: PORTAL_URL,
        token: p1Login.body.token,
        body: { name: 'Prof 2', email: 'p2@cp.test', saasRole: 'trainer', password: 'Prof2Password!2026' }
      });
      const p2Login = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'p2@cp.test', password: 'Prof2Password!2026' }
      });
      const stu = await env.req('POST', '/api/gym/students', {
        origin: PORTAL_URL,
        token: p1Login.body.token,
        body: { name: 'Stu Conc', email: 'stu@cp.test', password: 'StudentCpPassword!2026' }
      });
      const stuId = stu.body.student.id;

      const [rA, rB] = await Promise.all([
        env.req('POST', '/api/gym/prescribe', {
          origin: PORTAL_URL,
          token: p1Login.body.token,
          body: { studentId: stuId, day: 1, routine: { name: 'Ficha A Peito', ex: [{ id: '0025', sets: 3, reps: 10 }] } }
        }),
        env.req('POST', '/api/gym/prescribe', {
          origin: PORTAL_URL,
          token: p2Login.body.token,
          body: { studentId: stuId, day: 3, routine: { name: 'Ficha B Costas', ex: [{ id: '0575', sets: 3, reps: 12 }] } }
        })
      ]);
      assert.equal(rA.status, 200);
      assert.equal(rB.status, 200);

      const readRes = await env.req('GET', `/api/gym/student?id=${encodeURIComponent(stuId)}`, {
        origin: PORTAL_URL,
        token: p1Login.body.token
      });
      const names = readRes.body.state.routines.map(r => r.name).sort();
      assert.deepEqual(names, ['Ficha A Peito', 'Ficha B Costas']);
    } finally {
      env.close();
    }
  });

  it('quando um aluno é suspenso (disabled: true) em PUT /api/gym/students e a vaga livre é ocupada por outro aluno até atingir maxStudents, então tentar reativar o aluno suspenso retorna 403 plan-limit', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      const reactCreate = await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-react',
          name: 'Acad React',
          planId: 'starter',
          maxStudentsOverride: 1,
          ownerName: 'Gestor React',
          ownerEmail: 'gr@react.test',
          ownerPassword: 'GestorReactPassword!2026'
        }
      });
      assert.equal(reactCreate.status, 201);
      const reactPut = await env.req('PUT', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: {
          id: 'acad-react',
          maxStudentsOverride: 1
        }
      });
      assert.equal(reactPut.status, 200);
      const logRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'gr@react.test', password: 'GestorReactPassword!2026' }
      });
      const tok = logRes.body.token;

      const s1 = await env.req('POST', '/api/gym/students', {
        origin: PORTAL_URL,
        token: tok,
        body: { name: 'Aluno 1', email: 'a1@react.test', password: 'StudentPass!2026' }
      });
      assert.equal(s1.status, 201);

      const susp = await env.req('PUT', '/api/gym/students', {
        origin: PORTAL_URL,
        token: tok,
        body: { id: s1.body.student.id, disabled: true }
      });
      assert.equal(susp.status, 200);

      const s2 = await env.req('POST', '/api/gym/students', {
        origin: PORTAL_URL,
        token: tok,
        body: { name: 'Aluno 2', email: 'a2@react.test', password: 'StudentPass!2026' }
      });
      assert.equal(s2.status, 201);

      const react = await env.req('PUT', '/api/gym/students', {
        origin: PORTAL_URL,
        token: tok,
        body: { id: s1.body.student.id, disabled: false }
      });
      assert.equal(react.status, 403);
      assert.equal(react.body.code, 'plan-limit');
    } finally {
      env.close();
    }
  });

  it('quando um professor da academia-a tenta ler (GET /api/gym/student), editar (PUT /api/gym/students), prescrever (POST /api/gym/prescribe) ou excluir (DELETE /api/gym/students) um aluno da academia-b, então retorna 404', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-xa', name: 'Acad XA', planId: 'pro', ownerName: 'Dono A', ownerEmail: 'xa@iso.test', ownerPassword: 'DonoXaPassword!2026' }
      });
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-xb', name: 'Acad XB', planId: 'pro', ownerName: 'Dono B', ownerEmail: 'xb@iso.test', ownerPassword: 'DonoXbPassword!2026' }
      });
      const logA = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'xa@iso.test', password: 'DonoXaPassword!2026' }
      });
      const logB = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'xb@iso.test', password: 'DonoXbPassword!2026' }
      });
      const stuB = await env.req('POST', '/api/gym/students', {
        origin: PORTAL_URL,
        token: logB.body.token,
        body: { name: 'Vitima B', email: 'vit@xb.test', password: 'VitimaPassword!2026' }
      });
      const stuBId = stuB.body.student.id;

      const getCross = await env.req('GET', `/api/gym/student?id=${encodeURIComponent(stuBId)}`, {
        origin: PORTAL_URL,
        token: logA.body.token
      });
      assert.equal(getCross.status, 404);

      const putCross = await env.req('PUT', '/api/gym/students', {
        origin: PORTAL_URL,
        token: logA.body.token,
        body: { id: stuBId, name: 'Alterado Indevidamente' }
      });
      assert.equal(putCross.status, 404);

      const prescCross = await env.req('POST', '/api/gym/prescribe', {
        origin: PORTAL_URL,
        token: logA.body.token,
        body: { studentId: stuBId, day: 1, routine: { name: 'Hack', ex: [{ id: '0025' }] } }
      });
      assert.equal(prescCross.status, 404);

      const delCross = await env.req('DELETE', '/api/gym/students', {
        origin: PORTAL_URL,
        token: logA.body.token,
        body: { id: stuBId }
      });
      assert.equal(delCross.status, 404);
    } finally {
      env.close();
    }
  });

  it('quando alguém tenta excluir ou editar um membro da equipe através de DELETE /api/gym/students ou PUT /api/gym/students, então retorna 403 non-student-target', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-nst', name: 'Acad NST', planId: 'pro', ownerName: 'Dono', ownerEmail: 'd@nst.test', ownerPassword: 'DonoNstPassword!2026' }
      });
      const logRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'd@nst.test', password: 'DonoNstPassword!2026' }
      });
      const tr = await env.req('POST', '/api/gym/team', {
        origin: PORTAL_URL,
        token: logRes.body.token,
        body: { name: 'Prof Staff', email: 'ps@nst.test', saasRole: 'trainer', password: 'TrainerNstPassword!2026' }
      });
      const staffId = tr.body.member.id;

      const putStaff = await env.req('PUT', '/api/gym/students', {
        origin: PORTAL_URL,
        token: logRes.body.token,
        body: { id: staffId, disabled: true }
      });
      assert.equal(putStaff.status, 403);
      assert.equal(putStaff.body.code, 'non-student-target');

      const delStaff = await env.req('DELETE', '/api/gym/students', {
        origin: PORTAL_URL,
        token: logRes.body.token,
        body: { id: staffId }
      });
      assert.equal(delStaff.status, 403);
      assert.equal(delStaff.body.code, 'non-student-target');
    } finally {
      env.close();
    }
  });
});

/* =========================================================================
 * F7 — Sincronização de Estado do Aluno (/api/data)
 * ========================================================================= */
describe('F7 — Sincronização de Estado do Aluno (/api/data)', () => {
  it('quando o aluno autenticado envia PUT /api/data com seus treinos e baseRev atual, então persiste no SQLite, incrementa rev e retorna 200', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-sync', name: 'Acad Sync', planId: 'pro' }
      });
      const reg = await env.req('POST', '/api/register/password?tenant=acad-sync', {
        body: { name: 'Aluno Sync', email: 'sync@acad.test', password: 'StudentSyncPassword!2026' }
      });
      assert.equal(reg.status, 200);

      const get1 = await env.req('GET', '/api/data', { cookie: reg.cookie });
      assert.equal(get1.status, 200);
      assert.equal(get1.body.rev, 0);

      const put1 = await env.req('PUT', '/api/data', {
        cookie: reg.cookie,
        body: {
          baseRev: 0,
          state: { unit: 'kg', routines: [{ id: 'r1', name: 'Treino 1', ex: [] }], workouts: [] }
        }
      });
      assert.equal(put1.status, 200);
      assert.equal(put1.body.rev, 1);

      const get2 = await env.req('GET', '/api/data', { cookie: reg.cookie });
      assert.equal(get2.status, 200);
      assert.equal(get2.body.rev, 1);
      assert.equal(get2.body.state.routines[0].name, 'Treino 1');
    } finally {
      env.close();
    }
  });

  it('quando PUT /api/data recebe JSON malformado ou estado inválido (não-objeto), então retorna 400', async () => {
    const env = await startRealRspecEnv();
    try {
      const reg = await env.req('POST', '/api/register/password', {
        body: { name: 'Aluno BadData', email: 'baddata@rit.test', password: 'StudentBadPassword!2026' }
      });

      const malformed = await env.req('PUT', '/api/data', {
        cookie: reg.cookie,
        rawBody: '{"state": { bad json'
      });
      assert.equal(malformed.status, 400);

      const arrState = await env.req('PUT', '/api/data', {
        cookie: reg.cookie,
        body: { state: ['nao', 'eh', 'objeto'] }
      });
      assert.equal(arrState.status, 400);

      const emptyObj = await env.req('PUT', '/api/data', {
        cookie: reg.cookie,
        body: { state: {} }
      });
      assert.equal(emptyObj.status, 400);
    } finally {
      env.close();
    }
  });

  it('quando dois dispositivos do mesmo aluno enviam PUT /api/data simultaneamente (Promise.all) com o mesmo baseRev, então um recebe 200 e o outro recebe 409 conflict', async () => {
    const env = await startRealRspecEnv();
    try {
      const reg = await env.req('POST', '/api/register/password', {
        body: { name: 'Aluno CAS', email: 'cas@rit.test', password: 'StudentCasPassword!2026' }
      });
      const init = await env.req('PUT', '/api/data', {
        cookie: reg.cookie,
        body: { baseRev: 0, state: { unit: 'kg', routines: [{ id: 'r0', name: 'Base', ex: [] }], workouts: [] } }
      });
      assert.equal(init.status, 200);
      const rev1 = init.body.rev;

      const [d1, d2] = await Promise.all([
        env.req('PUT', '/api/data', {
          cookie: reg.cookie,
          body: { baseRev: rev1, state: { unit: 'kg', routines: [{ id: 'rA', name: 'Device A', ex: [] }], workouts: [] } }
        }),
        env.req('PUT', '/api/data', {
          cookie: reg.cookie,
          body: { baseRev: rev1, state: { unit: 'kg', routines: [{ id: 'rB', name: 'Device B', ex: [] }], workouts: [] } }
        })
      ]);

      assert.deepEqual([d1.status, d2.status].sort((a, b) => a - b), [200, 409]);
      const conflict = d1.status === 409 ? d1 : d2;
      assert.equal(conflict.body.error, 'conflict');
    } finally {
      env.close();
    }
  });

  it('quando o aluno pertence a uma academia suspensa ou com assinatura expirada após a carência, então o login e acesso ao estado respeitam o bloqueio do tenant', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-susp', name: 'Acad Susp', planId: 'starter', status: 'active' }
      });
      const reg = await env.req('POST', '/api/register/password?tenant=acad-susp', {
        body: { name: 'Aluno Susp', email: 'susp@acad.test', password: 'StudentSuspPassword!2026' }
      });
      assert.equal(reg.status, 200);

      // Suspende a academia administrativamente
      const suspRes = await env.req('POST', '/api/saas/admin/tenants/status', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-susp', status: 'suspended' }
      });
      assert.equal(suspRes.status, 200);

      const dataBlocked = await env.req('GET', '/api/data', { cookie: reg.cookie });
      assert.equal(dataBlocked.status, 401);

      const loginBlocked = await env.req('POST', '/api/login/password?tenant=acad-susp', {
        body: { identifier: 'susp@acad.test', password: 'StudentSuspPassword!2026' }
      });
      assert.equal(loginBlocked.status, 403);
    } finally {
      env.close();
    }
  });

  it('quando o aluno A tenta forçar ?tenant=academia-b ou X-Tenant-Id: academia-b ao chamar GET /api/tenant/branding ou GET /api/config, então o servidor trava a resposta no tenant do próprio aluno A (locked: true)', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-lock-a', name: 'Academia A Lock', planId: 'pro' }
      });
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-lock-b', name: 'Academia B Lock', planId: 'pro' }
      });
      const regA = await env.req('POST', '/api/register/password?tenant=acad-lock-a', {
        body: { name: 'Aluno Lock A', email: 'locka@rit.test', password: 'StudentLockPassword!2026' }
      });

      const brandRes = await env.req('GET', '/api/tenant/branding?tenant=acad-lock-b', {
        cookie: regA.cookie,
        headers: { 'X-Tenant-Id': 'acad-lock-b' }
      });
      assert.equal(brandRes.status, 200);
      assert.equal(brandRes.body.tenant_id, 'acad-lock-a');
      assert.equal(brandRes.body.locked, true);

      const cfgRes = await env.req('GET', '/api/config?tenant=acad-lock-b', {
        cookie: regA.cookie,
        headers: { 'X-Tenant-Id': 'acad-lock-b' }
      });
      assert.equal(cfgRes.status, 200);
      assert.equal(cfgRes.body.tenant_id, 'acad-lock-a');
    } finally {
      env.close();
    }
  });
});

/* =========================================================================
 * F8 — Catálogo Customizado, Upload de Mídia e White-Label
 * ========================================================================= */
describe('F8 — Catálogo Customizado, Upload de Mídia e White-Label (/api/gym/custom-exercises, /api/gym/media/*, /api/gym/branding)', () => {
  it('quando o professor faz upload de imagem WebP em PUT /api/gym/media/:hash e cria exercício em POST /api/gym/custom-exercises, então os alunos da mesma academia listam o exercício e baixam a mídia em GET /api/media/:hash', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-m1', name: 'Acad M1', planId: 'pro', ownerName: 'Prof M1', ownerEmail: 'pm1@rit.test', ownerPassword: 'ProfM1Password!2026' }
      });
      const profLog = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'pm1@rit.test', password: 'ProfM1Password!2026' }
      });
      const stuReg = await env.req('POST', '/api/register/password?tenant=acad-m1', {
        body: { name: 'Aluno M1', email: 'sm1@rit.test', password: 'StudentM1Password!2026' }
      });

      const webpBytes = M.webp(600);
      const webpHash = M.sha(webpBytes);

      const upRes = await env.reqBinary('PUT', `/api/gym/media/${webpHash}`, {
        origin: PORTAL_URL,
        token: profLog.body.token,
        contentType: 'image/webp',
        bytes: webpBytes
      });
      assert.equal(upRes.status, 201);

      const createEx = await env.req('POST', '/api/gym/custom-exercises', {
        origin: PORTAL_URL,
        token: profLog.body.token,
        body: {
          n: 'Crucifixo Customizado M1',
          bp: 'chest',
          eq: 'cable',
          cat: 'strength',
          media: { kind: 'image', hash: webpHash, mime: 'image/webp', size: webpBytes.length, width: 480, height: 360 }
        }
      });
      assert.equal(createEx.status, 200);
      const customId = createEx.body.exercise.id;
      assert.ok(customId.startsWith('tx_'));

      const stuList = await env.req('GET', '/api/tenant/exercises', { cookie: stuReg.cookie });
      assert.equal(stuList.status, 200);
      assert.ok(stuList.body.customExercises.some(e => e.id === customId));

      const dlRes = await env.reqBinary('GET', `/api/media/${webpHash}`, { cookie: stuReg.cookie });
      assert.equal(dlRes.status, 200);
      assert.equal(M.sha(dlRes.bytes), webpHash);
    } finally {
      env.close();
    }
  });

  it('quando PUT /api/gym/branding ou PUT /api/gym/settings recebe evolutionUrl apontando para IP privado/loopback (127.0.0.1 ou 169.254.169.254), então bloqueia por SSRF (400) ou ignora os campos de Evolution no branding', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-ssrf', name: 'Acad SSRF', planId: 'pro', ownerName: 'Dono SSRF', ownerEmail: 'ssrf@rit.test', ownerPassword: 'DonoSsrfPassword!2026' }
      });
      const logRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'ssrf@rit.test', password: 'DonoSsrfPassword!2026' }
      });
      const tok = logRes.body.token;

      const loopback = await env.req('PUT', '/api/gym/settings', {
        origin: PORTAL_URL,
        token: tok,
        body: { evolutionUrl: 'http://127.0.0.1:8080/evo' }
      });
      assert.equal(loopback.status, 400);

      const metaIp = await env.req('PUT', '/api/gym/settings', {
        origin: PORTAL_URL,
        token: tok,
        body: { evolutionUrl: 'http://169.254.169.254/latest/meta-data' }
      });
      assert.equal(metaIp.status, 400);

      const brandAttempt = await env.req('PUT', '/api/gym/branding', {
        origin: PORTAL_URL,
        token: tok,
        body: {
          gymName: 'Acad Segura',
          settings: {
            evolutionUrl: 'http://127.0.0.1:9999',
            evolutionApiKey: 'segredo-injetado',
            churnDaysThreshold: 7
          }
        }
      });
      assert.equal(brandAttempt.status, 200);
      assert.equal(brandAttempt.body.tenant.settings.evolutionUrl, '');
      assert.equal(brandAttempt.body.tenant.settings.hasEvolutionApiKey, false);
      assert.equal(brandAttempt.body.tenant.settings.churnDaysThreshold, 7);
    } finally {
      env.close();
    }
  });

  it('quando duas requisições simultâneas (Promise.all) disparam POST /api/gym/templates/import-defaults na mesma academia, então nenhum modelo padrão fica duplicado no SQLite', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-tpl', name: 'Acad Tpl', planId: 'pro', ownerName: 'Dono Tpl', ownerEmail: 'tpl@rit.test', ownerPassword: 'DonoTplPassword!2026' }
      });
      const logRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'tpl@rit.test', password: 'DonoTplPassword!2026' }
      });
      const tok = logRes.body.token;

      // Remove os templates existentes para forçar corrida real na reimportação
      const existing = await env.req('GET', '/api/gym/templates', { origin: PORTAL_URL, token: tok });
      for (const tpl of existing.body.templates) {
        await env.req('DELETE', '/api/gym/templates', { origin: PORTAL_URL, token: tok, body: { id: tpl.id } });
      }

      const [t1, t2] = await Promise.all([
        env.req('POST', '/api/gym/templates/import-defaults', { origin: PORTAL_URL, token: tok, body: {} }),
        env.req('POST', '/api/gym/templates/import-defaults', { origin: PORTAL_URL, token: tok, body: {} })
      ]);
      assert.equal(t1.status, 200);
      assert.equal(t2.status, 200);

      const rows = getSqliteInstance(env.dataDir).db
        .prepare('SELECT id, data FROM gym_templates WHERE tenant_id = ?')
        .all('acad-tpl');
      const names = rows.map(r => JSON.parse(r.data).name);
      assert.equal(new Set(names).size, rows.length);
      assert.ok(rows.length > 0);
    } finally {
      env.close();
    }
  });

  it('quando PUT /api/gym/media/:hash recebe um arquivo cujos bytes não correspondem ao hash SHA-256 da URL ou com formato inválido, então rejeita com 400 ou 415', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-badmed', name: 'Acad BadMed', planId: 'pro', ownerName: 'Prof BM', ownerEmail: 'bm@rit.test', ownerPassword: 'ProfBmPassword!2026' }
      });
      const logRes = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'bm@rit.test', password: 'ProfBmPassword!2026' }
      });
      const tok = logRes.body.token;

      const bytes = M.webp(500);
      const wrongHash = '0'.repeat(64);
      const mismatchRes = await env.reqBinary('PUT', `/api/gym/media/${wrongHash}`, {
        origin: PORTAL_URL,
        token: tok,
        contentType: 'image/webp',
        bytes
      });
      assert.equal(mismatchRes.status, 400);

      const htmlBytes = M.html();
      const htmlHash = M.sha(htmlBytes);
      const badMagicRes = await env.reqBinary('PUT', `/api/gym/media/${htmlHash}`, {
        origin: PORTAL_URL,
        token: tok,
        contentType: 'image/webp',
        bytes: htmlBytes
      });
      assert.equal(badMagicRes.status, 415);
    } finally {
      env.close();
    }
  });

  it('quando um aluno ou professor da academia-b tenta baixar mídia privada da academia-a em GET /api/media/:hash (mesmo forçando ?tenant=academia-a), então recebe 404', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-ma', name: 'Acad MA', planId: 'pro', ownerName: 'Prof A', ownerEmail: 'pma@rit.test', ownerPassword: 'ProfMaPassword!2026' }
      });
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-mb', name: 'Acad MB', planId: 'pro', ownerName: 'Prof B', ownerEmail: 'pmb@rit.test', ownerPassword: 'ProfMbPassword!2026' }
      });
      const profALog = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'pma@rit.test', password: 'ProfMaPassword!2026' }
      });
      const profBLog = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'pmb@rit.test', password: 'ProfMbPassword!2026' }
      });
      const stuBReg = await env.req('POST', '/api/register/password?tenant=acad-mb', {
        body: { name: 'Stu MB', email: 'smb@rit.test', password: 'StudentMbPassword!2026' }
      });

      const bytes = M.png(512);
      const hash = M.sha(bytes);
      const up = await env.reqBinary('PUT', `/api/gym/media/${hash}`, {
        origin: PORTAL_URL,
        token: profALog.body.token,
        contentType: 'image/png',
        bytes
      });
      assert.equal(up.status, 201);

      const stuCross = await env.reqBinary('GET', `/api/media/${hash}?tenant=acad-ma`, {
        cookie: stuBReg.cookie,
        headers: { 'X-Tenant-Id': 'acad-ma' }
      });
      assert.equal(stuCross.status, 404);

      const profCross = await env.reqBinary('GET', `/api/gym/media/${hash}?tenant=acad-ma`, {
        origin: PORTAL_URL,
        token: profBLog.body.token,
        headers: { 'X-Tenant-Id': 'acad-ma' }
      });
      assert.equal(profCross.status, 404);
    } finally {
      env.close();
    }
  });

  it('quando um professor da academia-b tenta excluir um exercício customizado (tx_*) da academia-a em DELETE /api/gym/custom-exercises, então deleted é false e o exercício da academia-a permanece intacto', async () => {
    const env = await startRealRspecEnv();
    try {
      const superTok = await env.setupSuperAdmin();
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-ea', name: 'Acad EA', planId: 'pro', ownerName: 'Prof EA', ownerEmail: 'pea@rit.test', ownerPassword: 'ProfEaPassword!2026' }
      });
      await env.req('POST', '/api/saas/admin/tenants', {
        origin: PORTAL_URL,
        token: superTok,
        body: { id: 'acad-eb', name: 'Acad EB', planId: 'pro', ownerName: 'Prof EB', ownerEmail: 'peb@rit.test', ownerPassword: 'ProfEbPassword!2026' }
      });
      const logA = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'pea@rit.test', password: 'ProfEaPassword!2026' }
      });
      const logB = await env.req('POST', '/api/saas/auth/login', {
        origin: PORTAL_URL,
        body: { email: 'peb@rit.test', password: 'ProfEbPassword!2026' }
      });

      const created = await env.req('POST', '/api/gym/custom-exercises', {
        origin: PORTAL_URL,
        token: logA.body.token,
        body: { n: 'Exercício Privado EA', bp: 'back', eq: 'cable', cat: 'strength' }
      });
      const exId = created.body.exercise.id;

      const delCross = await env.req('DELETE', `/api/gym/custom-exercises?id=${encodeURIComponent(exId)}&tenant=acad-ea`, {
        origin: PORTAL_URL,
        token: logB.body.token,
        headers: { 'X-Tenant-Id': 'acad-ea' }
      });
      assert.equal(delCross.status, 200);
      assert.equal(delCross.body.deleted, false);

      const catA = await env.req('GET', '/api/saas/catalogue?customOnly=1', {
        origin: PORTAL_URL,
        token: logA.body.token
      });
      assert.ok(catA.body.exercises.some(e => e.id === exId));
    } finally {
      env.close();
    }
  });
});
