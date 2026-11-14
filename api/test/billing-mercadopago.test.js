import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  createPixPayment,
  getPayment,
  verifyWebhookSignature,
  isMercadoPagoConfigured
} from '../mercadopago.js';
import { createSaasRoutes } from '../saas-routes.js';
import { createTenant, getTenant, recordTenantInvoice } from '../tenants.js';

function createMockReqRes({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const req = {
    method,
    url,
    headers: { host: 'localhost:8080', ...headers },
    body
  };
  let statusCode = 200;
  let responseData = null;
  const res = {
    writeHead: (code) => { statusCode = code; },
    end: (payload) => {
      if (payload) {
        try { responseData = JSON.parse(payload); }
        catch { responseData = payload; }
      }
    }
  };
  return { req, res, getStatus: () => statusCode, getBody: () => responseData };
}

test('Mercado Pago module generates mock PIX and validates HMAC signatures', async () => {
  assert.equal(isMercadoPagoConfigured(), false);

  const pix = await createPixPayment({
    amount: 169,
    description: 'Assinatura Estúdio',
    payerEmail: 'gestor@estudio.com',
    payerName: 'Carlos Silva',
    externalReference: 'rit:estudio:inv_1:monthly:starter'
  });

  assert.equal(pix.status, 'pending');
  assert.equal(pix.amount, 169);
  assert.equal(pix.mock, true);
  assert.ok(pix.qrCode.startsWith('00020126'));
  assert.ok(pix.qrCodeBase64.startsWith('data:image/svg+xml;base64,'));
  assert.ok(pix.id.startsWith('mp_sim_'));

  const pInfo = await getPayment(pix.id);
  assert.equal(pInfo.id, pix.id);
  assert.equal(pInfo.status, 'pending');

  // Validação de assinatura HMAC
  const secret = 'chave-secreta-webhook-123';
  process.env.MERCADO_PAGO_WEBHOOK_SECRET = secret;
  try {
    const ts = '1700000000';
    const requestId = 'req-abc-999';
    const dataId = '12345678';
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const validHmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

    const okSig = verifyWebhookSignature({
      headers: {
        'x-signature': `ts=${ts},v1=${validHmac}`,
        'x-request-id': requestId
      },
      query: { 'data.id': dataId }
    });
    assert.equal(okSig, true);

    const badSig = verifyWebhookSignature({
      headers: {
        'x-signature': `ts=${ts},v1=invalido`,
        'x-request-id': requestId
      },
      query: { 'data.id': dataId }
    });
    assert.equal(badSig, false);
  } finally {
    delete process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  }
});

test('SaaS Billing: Checkout PIX monthly & annual, status, webhook and simulation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-billing-test-'));
  try {
    const db = { users: [], creds: [], subs: [], invites: [] };
    const saveDb = () => {};

    // Cria tenant para teste
    const tenant = createTenant(tmpDir, {
      id: 'studiofit',
      name: 'Studio Fit',
      planId: 'starter',
      ownerName: 'Mariana Lima',
      ownerEmail: 'mariana@studiofit.com',
      phone: '11988887777'
    });

    // Mock das sessões
    let currentSessionUser = {
      id: 'u_mariana',
      name: 'Mariana Lima',
      email: 'mariana@studiofit.com',
      tenantId: 'studiofit',
      saasRole: 'manager',
      role: 'trainer'
    };

    const routes = createSaasRoutes({
      json: (res, code, payload, headers = undefined) => {
        res.writeHead(code, headers);
        res.end(JSON.stringify(payload));
      },
      readBody: async (req) => req.body || {},
      readSession: () => currentSessionUser,
      isAdmin: () => false,
      db,
      saveDb,
      dataDir: tmpDir,
      audit: () => {}
    });

    // 1. Checkout PIX Mensal para Plano Estúdio (R$ 169)
    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/billing/checkout-pix',
        body: { planId: 'starter', cycle: 'monthly' }
      });
      await routes['POST /api/saas/billing/checkout-pix'](req, res);
      assert.equal(getStatus(), 200);
      const data = getBody();
      assert.equal(data.ok, true);
      assert.equal(data.pix.amount, 169);
      assert.equal(data.pix.cycle, 'monthly');
      assert.equal(data.invoice.status, 'pending');
      assert.ok(data.pix.qrCode);
      assert.ok(data.pix.qrCodeBase64);
    }

    // 2. Checkout PIX Anual com Desconto para Personal Completo (R$ 39 * 12 = R$ 468)
    let annualInvId = null;
    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/billing/checkout-pix',
        body: { planId: 'personal-pro', cycle: 'annual' }
      });
      await routes['POST /api/saas/billing/checkout-pix'](req, res);
      assert.equal(getStatus(), 200);
      const data = getBody();
      assert.equal(data.ok, true);
      assert.equal(data.pix.amount, 468);
      assert.equal(data.pix.cycle, 'annual');
      assert.equal(data.invoice.amount, 468);
      assert.equal(data.invoice.status, 'pending');
      annualInvId = data.invoice.id;
    }

    // 3. Consulta de Status de Faturamento
    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'GET',
        url: '/api/saas/billing/status'
      });
      await routes['GET /api/saas/billing/status'](req, res);
      assert.equal(getStatus(), 200);
      const data = getBody();
      assert.equal(data.ok, true);
      assert.equal(data.tenantId, 'studiofit');
      // Tenant inicia com 1 fatura de criação + 2 faturas de checkout PIX
      assert.equal(data.invoices.length, 3);
    }

    // 4. Simulação de Pagamento do PIX Anual (permitido com SAAS_DEMO=1)
    process.env.SAAS_DEMO = '1';
    try {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/billing/simulate-pix',
        body: { tenantId: 'studiofit', invoiceId: annualInvId }
      });
      await routes['POST /api/saas/billing/simulate-pix'](req, res);
      assert.equal(getStatus(), 200);
      const data = getBody();
      assert.equal(data.ok, true);
      assert.equal(data.invoice.status, 'paid');
      assert.equal(data.tenant.status, 'active');
      assert.equal(data.tenant.planId, 'personal-pro');

      // Como o tenant já possuía 30 dias iniciais ativos, a anuidade soma 365 dias a partir do vencimento vigente (~395 dias)
      const expiry = new Date(data.tenant.nextBillingAt).getTime();
      const diffDays = Math.round((expiry - Date.now()) / (86400000));
      assert.ok(diffDays >= 394 && diffDays <= 396);
    } finally {
      delete process.env.SAAS_DEMO;
    }

    // 5. Teste do Webhook Oficial
    // Simula uma notificação de webhook do Mercado Pago com pagamento aprovado
    {
      // Criamos uma fatura pendente para ser aprovada pelo webhook
      const pendingInv = recordTenantInvoice(tmpDir, 'studiofit', {
        amount: 269,
        status: 'pending',
        cycle: 'monthly',
        planId: 'pro',
        mpPaymentId: 'mp_sim_webhook_test_123'
      });

      // No modo mock, getPayment('mp_sim_webhook_test_123') retorna status 'pending'.
      // Vamos simular o webhook fornecendo um mock direto ou testando a rota do webhook
      // com a chamada do handler
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'POST',
        url: `/api/saas/billing/webhook?data.id=mp_sim_webhook_test_123&type=payment`
      });

      await routes['POST /api/saas/billing/webhook'](req, res);
      assert.equal(getStatus(), 200);
      const data = getBody();
      assert.equal(data.ok, true);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('POST /api/saas/auth/setup-admin creates initial superadmin and blocks subsequent calls', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-setup-admin-test-'));
  try {
    const db = { users: [] };
    const saveDb = () => {};

    const routes = createSaasRoutes({
      json: (res, code, payload, headers = undefined) => {
        res.writeHead(code, headers);
        res.end(JSON.stringify(payload));
      },
      readBody: async (req) => req.body || {},
      readSession: () => null,
      isAdmin: () => false,
      db,
      saveDb,
      dataDir: tmpDir,
      audit: () => {},
      makeSession: (u) => 'token_' + u.id
    });

    // 1. Tentar criar com senha fraca (< 10 caracteres ou comum)
    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/auth/setup-admin',
        body: { email: 'admin@rit.com.br', password: '123' }
      });
      await routes['POST /api/saas/auth/setup-admin'](req, res);
      assert.equal(getStatus(), 400);
      assert.ok(getBody().error.includes('10 caracteres'));
    }
    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/auth/setup-admin',
        body: { email: 'admin@rit.com.br', password: 'Password123!' }
      });
      await routes['POST /api/saas/auth/setup-admin'](req, res);
      assert.equal(getStatus(), 400);
      assert.equal(getBody().code, 'too-common');
    }

    // 2. Criar com sucesso o primeiro Super Admin
    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/auth/setup-admin',
        body: { email: 'diretoria@rit.com.br', password: 'SenhaSeguraRit2026!', name: 'Diretoria Geral' }
      });
      await routes['POST /api/saas/auth/setup-admin'](req, res);
      assert.equal(getStatus(), 200);
      const data = getBody();
      assert.equal(data.ok, true);
      assert.equal(data.user.email, 'diretoria@rit.com.br');
      assert.equal(data.user.saasRole, 'superadmin');
      assert.ok(data.token);
      assert.equal(db.users.length, 1);
      assert.equal(db.users[0].saasRole, 'superadmin');
    }

    // 3. Segunda tentativa deve ser barrada com 403
    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/auth/setup-admin',
        body: { email: 'invasor@hacker.com', password: 'SenhaInvasor123!' }
      });
      await routes['POST /api/saas/auth/setup-admin'](req, res);
      assert.equal(getStatus(), 403);
      assert.ok(getBody().error.includes('já foi configurado'));
      assert.equal(db.users.length, 1);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('isMercadoPagoConfigured rejects placeholder tokens and accepts valid access tokens', () => {
  const prev = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  try {
    for (const fake of ['', 'APP_USR-SEU-ACCESS-TOKEN-AQUI', 'test', 'mock', 'changeme', 'YOUR_ACCESS_TOKEN', '<token>']) {
      process.env.MERCADO_PAGO_ACCESS_TOKEN = fake;
      assert.equal(isMercadoPagoConfigured(), false, `expected false for placeholder: ${fake}`);
    }
    process.env.MERCADO_PAGO_ACCESS_TOKEN = 'APP_USR-847291047281-111116-abcdef1234567890-12345678';
    assert.equal(isMercadoPagoConfigured(), true);
  } finally {
    if (prev === undefined) delete process.env.MERCADO_PAGO_ACCESS_TOKEN;
    else process.env.MERCADO_PAGO_ACCESS_TOKEN = prev;
  }
});

test('Etapa 5 setup-admin security: requires valid SETUP_ADMIN_TOKEN and fails closed in production', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-setup-token-'));
  const prevNodeEnv = process.env.NODE_ENV;
  const prevSetupToken = process.env.SETUP_ADMIN_TOKEN;
  try {
    const db = { users: [] };
    const routes = createSaasRoutes({
      json: (res, code, payload, headers = undefined) => {
        res.writeHead(code, headers);
        res.end(JSON.stringify(payload));
      },
      readBody: async (req) => req.body || {},
      readSession: () => null,
      isAdmin: () => false,
      db,
      saveDb: () => {},
      dataDir: tmpDir,
      audit: () => {},
      makeSession: (u) => 'token_' + u.id
    });

    // 1. Em producao sem SETUP_ADMIN_TOKEN configurado -> bloqueado
    process.env.NODE_ENV = 'production';
    delete process.env.SETUP_ADMIN_TOKEN;
    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'GET',
        url: '/api/saas/bootstrap'
      });
      await routes['GET /api/saas/bootstrap'](req, res);
      assert.equal(getStatus(), 200);
      assert.equal(getBody().setupTokenRequired, true);
      assert.equal(getBody().setupDisabled, true);
    }
    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/auth/setup-admin',
        body: { email: 'root@rit.com.br', password: 'SenhaMuitoForte2026!' }
      });
      await routes['POST /api/saas/auth/setup-admin'](req, res);
      assert.equal(getStatus(), 403);
      assert.equal(getBody().code, 'setup-token-not-configured');
    }

    // 2. Com SETUP_ADMIN_TOKEN definido -> token ausente ou errado retorna 403
    process.env.SETUP_ADMIN_TOKEN = 'setup-token-ultra-secreto-2026';
    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'GET',
        url: '/api/saas/bootstrap'
      });
      await routes['GET /api/saas/bootstrap'](req, res);
      assert.equal(getStatus(), 200);
      assert.equal(getBody().setupTokenRequired, true);
      assert.equal(getBody().setupDisabled, false);
    }
    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/auth/setup-admin',
        body: { email: 'root@rit.com.br', password: 'SenhaMuitoForte2026!', setupToken: 'errado' }
      });
      await routes['POST /api/saas/auth/setup-admin'](req, res);
      assert.equal(getStatus(), 403);
      assert.equal(getBody().code, 'invalid-setup-token');
    }

    // 3. Token correto via body libera configuracao unica
    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/auth/setup-admin',
        body: {
          email: 'root@rit.com.br',
          password: 'SenhaMuitoForte2026!',
          name: 'Diretoria',
          setupToken: 'setup-token-ultra-secreto-2026'
        }
      });
      await routes['POST /api/saas/auth/setup-admin'](req, res);
      assert.equal(getStatus(), 200);
      assert.equal(getBody().user.saasRole, 'superadmin');
    }
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevSetupToken === undefined) delete process.env.SETUP_ADMIN_TOKEN;
    else process.env.SETUP_ADMIN_TOKEN = prevSetupToken;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SaaS Billing security: role check, idempotent simulate/status/webhook replay, and setup-admin flags', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-billing-sec-'));
  const prevMp = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  const prevSecret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  const prevDemo = process.env.SAAS_DEMO;
  const originalFetch = globalThis.fetch;

  try {
    createTenant(tmpDir, { id: 'secgym', name: 'Sec Gym', planId: 'starter' });
    const db = { users: [], creds: [], subs: [], invites: [] };
    let activeUser = null;
    const setCookies = [];

    const routes = createSaasRoutes({
      json: (res, code, payload, headers = undefined) => {
        res.writeHead(code, headers);
        res.end(JSON.stringify(payload));
      },
      readBody: async (req) => req.body || {},
      readSession: () => activeUser,
      isAdmin: (u) => !!u?.admin,
      db,
      saveDb: () => {},
      dataDir: tmpDir,
      audit: () => {},
      makeSession: (u, mode) => `tok_${u.id}_${mode || 'p'}`,
      sessionCookie: (_req, token) => {
        const c = `gymsid=${token}; Path=/; HttpOnly`;
        setCookies.push(c);
        return c;
      }
    });

    // 1. setup-admin sets admin:true, owner:true, token ending in _b, and Set-Cookie
    {
      const req = { method: 'POST', url: '/api/saas/auth/setup-admin', headers: { host: 'localhost:8080' }, body: { email: 'root@rit.com.br', password: 'SenhaForte2026!' } };
      let code = 200;
      let headersOut = {};
      let payload = null;
      const res = {
        writeHead: (c, h = {}) => { code = c; headersOut = h; },
        end: (p) => { payload = p ? JSON.parse(p) : null; }
      };
      await routes['POST /api/saas/auth/setup-admin'](req, res);
      assert.equal(code, 200);
      assert.equal(db.users[0].admin, true);
      assert.equal(db.users[0].owner, true);
      assert.ok(payload.token.endsWith('_b'));
      assert.ok(String(headersOut['Set-Cookie'] || '').includes('gymsid='));
    }

    // 2. Regular trainer gets 403 on billing checkout & simulate-pix
    activeUser = { id: 'u_tr', name: 'Personal', role: 'trainer', saasRole: 'trainer', tenantId: 'secgym' };
    {
      const { req, res, getStatus } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/billing/checkout-pix',
        headers: { 'x-tenant-id': 'secgym' },
        body: { planId: 'pro', cycle: 'monthly' }
      });
      await routes['POST /api/saas/billing/checkout-pix'](req, res);
      assert.equal(getStatus(), 403);
    }

    // 3. gym_owner checkout + simulate-pix replay is idempotent on nextBillingAt (requires SAAS_DEMO=1)
    process.env.SAAS_DEMO = '1';
    activeUser = { id: 'u_own', name: 'Dono SecGym', email: 'dono@secgym.com', role: 'trainer', saasRole: 'gym_owner', tenantId: 'secgym' };
    let inv1;
    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/billing/checkout-pix',
        headers: { 'x-tenant-id': 'secgym' },
        body: { planId: 'pro', cycle: 'monthly' }
      });
      await routes['POST /api/saas/billing/checkout-pix'](req, res);
      assert.equal(getStatus(), 200);
      inv1 = getBody().invoice.id;
    }

    {
      const { req, res, getStatus } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/billing/simulate-pix',
        headers: { 'x-tenant-id': 'secgym' },
        body: { invoiceId: inv1 }
      });
      await routes['POST /api/saas/billing/simulate-pix'](req, res);
      assert.equal(getStatus(), 200);
    }
    const afterFirstSim = getTenant(tmpDir, 'secgym');
    assert.equal(afterFirstSim.planId, 'pro');
    assert.equal(afterFirstSim.mrr, 269);
    const nextAfterFirst = afterFirstSim.nextBillingAt;

    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/billing/simulate-pix',
        headers: { 'x-tenant-id': 'secgym' },
        body: { invoiceId: inv1 }
      });
      await routes['POST /api/saas/billing/simulate-pix'](req, res);
      assert.equal(getStatus(), 200);
      assert.equal(getBody().alreadyProcessed, true);
      assert.equal(getTenant(tmpDir, 'secgym').nextBillingAt, nextAfterFirst);
    }

    // 4. Configured MP polling + signed webhook replay does not double-extend
    process.env.MERCADO_PAGO_ACCESS_TOKEN = 'APP_USR-999999999999-111116-abcdefabcdef123456-9999';
    process.env.MERCADO_PAGO_WEBHOOK_SECRET = 'wh_sec_test_123';
    const inv2 = recordTenantInvoice(tmpDir, 'secgym', {
      amount: 169,
      planId: 'starter',
      cycle: 'monthly',
      status: 'pending',
      mpPaymentId: '987654321'
    });
    globalThis.fetch = async (url) => {
      if (String(url).includes('/v1/payments/987654321')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 987654321,
            status: 'approved',
            transaction_amount: 169,
            external_reference: `rit:secgym:${inv2.id}:monthly:starter`
          })
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'GET',
        url: `/api/saas/billing/status?invoiceId=${inv2.id}`,
        headers: { 'x-tenant-id': 'secgym' }
      });
      await routes['GET /api/saas/billing/status'](req, res);
      assert.equal(getStatus(), 200);
      assert.equal(getBody().ok, true);
      assert.equal(getBody().status, 'active');
    }
    const afterStatusTenant = getTenant(tmpDir, 'secgym');
    const paidInv2 = afterStatusTenant.invoices.find(i => i.id === inv2.id);
    assert.equal(paidInv2?.status, 'paid');
    const nextAfterStatus = afterStatusTenant.nextBillingAt;
    assert.equal(afterStatusTenant.planId, 'starter');

    // Signed webhook for same payment must not extend again
    const ts = '1700000100';
    const requestId = 'req-replay-1';
    const dataId = '987654321';
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
    const v1 = crypto.createHmac('sha256', process.env.MERCADO_PAGO_WEBHOOK_SECRET).update(manifest).digest('hex');
    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'POST',
        url: `/api/saas/billing/webhook?data.id=${dataId}&type=payment`,
        headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId },
        body: { type: 'payment', data: { id: dataId } }
      });
      await routes['POST /api/saas/billing/webhook'](req, res);
      assert.equal(getStatus(), 200);
      assert.equal(getBody().alreadyProcessed, true);
      assert.equal(getTenant(tmpDir, 'secgym').nextBillingAt, nextAfterStatus);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (prevMp === undefined) delete process.env.MERCADO_PAGO_ACCESS_TOKEN;
    else process.env.MERCADO_PAGO_ACCESS_TOKEN = prevMp;
    if (prevSecret === undefined) delete process.env.MERCADO_PAGO_WEBHOOK_SECRET;
    else process.env.MERCADO_PAGO_WEBHOOK_SECRET = prevSecret;
    if (prevDemo === undefined) delete process.env.SAAS_DEMO;
    else process.env.SAAS_DEMO = prevDemo;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Etapa 4 fail-closed billing: blocks mock PIX, unsigned webhook without secret, and simulate-pix in production', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-billing-prod-'));
  const prevNodeEnv = process.env.NODE_ENV;
  const prevMp = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  const prevSecret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  const prevDemo = process.env.SAAS_DEMO;

  try {
    createTenant(tmpDir, { id: 'prodgym', name: 'Prod Gym', planId: 'starter' });
    const pendingSimInv = recordTenantInvoice(tmpDir, 'prodgym', {
      amount: 169,
      planId: 'starter',
      cycle: 'monthly',
      status: 'pending',
      mpPaymentId: 'mp_sim_legacy_open'
    });

    const db = { users: [], creds: [], subs: [], invites: [] };
    let activeUser = {
      id: 'u_super_prod',
      name: 'Super Admin',
      email: 'root@rit.com.br',
      saasRole: 'superadmin',
      admin: true,
      role: 'admin'
    };

    const routes = createSaasRoutes({
      json: (res, code, payload, headers = undefined) => {
        res.writeHead(code, headers);
        res.end(JSON.stringify(payload));
      },
      readBody: async (req) => req.body || {},
      readSession: () => activeUser,
      isAdmin: (u) => Boolean(u?.admin),
      db,
      saveDb: () => {},
      dataDir: tmpDir,
      audit: () => {}
    });

    // 1. Sem MERCADO_PAGO_WEBHOOK_SECRET em NODE_ENV=production -> verifyWebhookSignature falha fechado
    process.env.NODE_ENV = 'production';
    delete process.env.MERCADO_PAGO_ACCESS_TOKEN;
    delete process.env.MERCADO_PAGO_WEBHOOK_SECRET;
    delete process.env.SAAS_DEMO;

    assert.equal(
      verifyWebhookSignature({
        headers: {},
        query: { 'data.id': '123456' },
        rawBody: '{"type":"payment","data":{"id":"123456"}}'
      }),
      false
    );

    // 2. Com token real configurado (mesmo fora de production) e sem webhook secret -> tambem falha fechado
    process.env.NODE_ENV = 'development';
    process.env.MERCADO_PAGO_ACCESS_TOKEN = 'APP_USR-847291047281-111116-abcdef1234567890-12345678';
    assert.equal(
      verifyWebhookSignature({
        headers: {},
        query: { 'data.id': '123456' }
      }),
      false
    );

    // 3. Em NODE_ENV=production sem token e sem SAAS_DEMO=1 -> webhook devolve 401, createPixPayment falha, checkout-pix devolve 503 e simulate-pix devolve 403 ate para superadmin
    process.env.NODE_ENV = 'production';
    delete process.env.MERCADO_PAGO_ACCESS_TOKEN;
    delete process.env.MERCADO_PAGO_WEBHOOK_SECRET;
    delete process.env.SAAS_DEMO;

    await assert.rejects(
      () => createPixPayment({
        amount: 169,
        description: 'Teste Prod',
        payerEmail: 'dono@prodgym.com',
        externalReference: 'rit:prodgym:inv_x:monthly:starter'
      }),
      /produção/i
    );

    {
      const { req, res, getStatus, getBody } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/billing/webhook?data.id=123456&type=payment',
        body: { type: 'payment', data: { id: '123456' } }
      });
      await routes['POST /api/saas/billing/webhook'](req, res);
      assert.equal(getStatus(), 401);
      assert.match(String(getBody()?.error || ''), /assinatura/i);
    }

    {
      const { req, res, getStatus } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/billing/checkout-pix',
        body: { tenantId: 'prodgym', planId: 'starter', cycle: 'monthly' }
      });
      await routes['POST /api/saas/billing/checkout-pix'](req, res);
      assert.equal(getStatus(), 503);
    }

    {
      const { req, res, getStatus } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/billing/simulate-pix',
        body: { tenantId: 'prodgym', invoiceId: pendingSimInv.id }
      });
      await routes['POST /api/saas/billing/simulate-pix'](req, res);
      assert.equal(getStatus(), 403);
    }

    // 4. Mesmo em NODE_ENV=development, superadmin nao pode simular fora de SAAS_DEMO=1
    process.env.NODE_ENV = 'development';
    {
      const { req, res, getStatus } = createMockReqRes({
        method: 'POST',
        url: '/api/saas/billing/simulate-pix',
        body: { tenantId: 'prodgym', invoiceId: pendingSimInv.id }
      });
      await routes['POST /api/saas/billing/simulate-pix'](req, res);
      assert.equal(getStatus(), 403);
    }
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevMp === undefined) delete process.env.MERCADO_PAGO_ACCESS_TOKEN;
    else process.env.MERCADO_PAGO_ACCESS_TOKEN = prevMp;
    if (prevSecret === undefined) delete process.env.MERCADO_PAGO_WEBHOOK_SECRET;
    else process.env.MERCADO_PAGO_WEBHOOK_SECRET = prevSecret;
    if (prevDemo === undefined) delete process.env.SAAS_DEMO;
    else process.env.SAAS_DEMO = prevDemo;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

