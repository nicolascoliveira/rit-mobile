/**
 * api/test/business-logic-audit.test.js
 *
 * Bateria de testes de comportamento da auditoria de regras de negócio:
 *  1. Transições de estado de faturas (refunded / charged_back reversão de vigência + past_due, bloqueio de reabertura/approved tardio e triggers SQLite);
 *  2. Bloqueio de auto-reativação de academia administrativamente suspensa (`suspended`);
 *  3. Expiração automática de `nextBillingAt` em tenant `active` bloqueando alunos e mantendo `billingOnly` para gestor;
 *  4. Bloqueio de downgrade de plano via `checkout-pix` acima da capacidade ativa (`422 plan-capacity-exceeded`);
 *  5. Bloqueio de incompatibilidade entre `accountType` e `planId` em `POST /api/saas/auth/register` (`422 plan-account-type-mismatch`);
 *  6. Rejeição de `transaction_amount` inválido (`NaN`/`0`/negativo) e proteção contra `external_reference` adulterado em `applyGatewayPaymentUpdate`;
 *  7. Invalidação automática de PIX pendente antigo após alteração de preço do plano (`upsertSaasPlan`);
 *  8. Isolamento multi-tenant no cadastro de aluno (`404 tenant-not-found` e bloqueio de convite global `'default'`);
 *  9. Validações estritas de planos/MRR/limites (`DomainError`), revogação de sessão ao desativar usuário (`sv` + `pwReset`) e limpeza de `whatsapp_outbox` no `deleteTenant`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { boundPort } from './helpers.mjs';
import { runSecurityMigrations } from '../migrate-security.js';
import {
  DomainError,
  listSaasPlans,
  upsertSaasPlan,
  createTenant,
  updateTenant,
  getTenant,
  deleteTenant,
  getTenantAccessState,
  recordTenantInvoice,
  reservePixCheckoutInvoice,
  finalizePixCheckoutInvoice,
  confirmTenantPayment,
  applyGatewayPaymentUpdate
} from '../tenants.js';
import {
  getSqliteInstance,
  closeSqliteInstance,
  upsertUserSqlite,
  upsertInviteSqlite
} from '../sqlite.js';
import { hashPassword, makeResetCode, hashResetCode } from '../password.js';

const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_SECRET = 'd'.repeat(64);

function makeTempDir(prefix = 'rit-bla-') {
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

function spawnTestServer(dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      ORIGIN: 'https://example.test',
      PORTAL_URL: 'https://painel.example.test',
      RP_ID: 'example.test',
      PASSWORD_LOGIN: '1',
      TRUST_PROXY: '1',
      INVITE_ONLY: '0',
      SAAS_DEMO: '1',
      SAAS_AUTO_SEED: '0',
      ...extraEnv
    }
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  return { child, getLog: () => log };
}

async function makeReq(base, method, p, { body, headers = {}, ip } = {}) {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip || '198.51.100.77',
      'X-Forwarded-Proto': 'https',
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, body: data, headers: r.headers };
}

test('1. Refunded e charged_back revertem nextBillingAt, movem tenant para past_due e tornam fatura imutável (domínio e SQLite)', () => {
  const dir = makeTempDir('rit-bla-refund-');
  try {
    runSecurityMigrations({ dataDir: dir });
    createTenant(dir, { id: 'gymref', name: 'Gym Refund', planId: 'starter', ownerEmail: 'dono@refund.test' });
    const resInv = reservePixCheckoutInvoice(dir, 'gymref', {
      planId: 'starter',
      cycle: 'monthly',
      amount: 149,
      gatewayIdempotencyKey: crypto.randomUUID()
    });
    assert.equal(resInv.status, 'created');
    finalizePixCheckoutInvoice(dir, 'gymref', resInv.invoice.id, { mpPaymentId: 'mp_ref_001' });

    const approved = applyGatewayPaymentUpdate(dir, 'gymref', {
      id: 'mp_ref_001',
      status: 'approved',
      transaction_amount: 149,
      date_approved: new Date().toISOString()
    }, { invoiceId: resInv.invoice.id });

    assert.equal(approved.outcome, 'approved');
    assert.equal(approved.tenant.status, 'active');
    const activeNextMs = Date.parse(approved.tenant.nextBillingAt);
    assert.ok(activeNextMs > Date.now() + 25 * 86400000);
    assert.equal(getTenantAccessState(dir, 'gymref').blocked, false);

    // Gateway envia reembolso
    const refunded = applyGatewayPaymentUpdate(dir, 'gymref', {
      id: 'mp_ref_001',
      status: 'refunded',
      date_last_updated: new Date().toISOString()
    }, { invoiceId: resInv.invoice.id });

    assert.equal(refunded.outcome, 'refunded');
    assert.equal(refunded.updated, true);
    assert.equal(refunded.invoice.status, 'refunded');

    const afterRefundTenant = getTenant(dir, 'gymref');
    assert.equal(afterRefundTenant.status, 'past_due');
    assert.ok(Date.parse(afterRefundTenant.nextBillingAt) <= Date.now() + 1000);
    const access = getTenantAccessState(dir, 'gymref');
    assert.equal(access.blocked, true);
    assert.equal(access.billingOnly, true);

    // Tentativa de confirmar novamente via domínio ou webhook tardio 'approved' é rejeitada/ignorada
    assert.throws(
      () => confirmTenantPayment(dir, 'gymref', { invoiceId: resInv.invoice.id, amount: 149 }),
      err => err instanceof DomainError && err.httpStatus === 409 && err.code === 'invoice-refunded-immutable'
    );

    const lateApproved = applyGatewayPaymentUpdate(dir, 'gymref', {
      id: 'mp_ref_001',
      status: 'approved',
      transaction_amount: 149
    }, { invoiceId: resInv.invoice.id });
    assert.equal(lateApproved.outcome, 'ignored_refunded');
    assert.equal(getTenant(dir, 'gymref').status, 'past_due');

    assert.throws(
      () => recordTenantInvoice(dir, 'gymref', { id: resInv.invoice.id, amount: 149, status: 'paid' }),
      err => err instanceof DomainError && err.httpStatus === 409 && err.code === 'invoice-refunded-immutable'
    );

    // Trigger SQLite impede reabrir fatura refunded diretamente no banco
    const inst = getSqliteInstance(dir);
    assert.throws(
      () => inst.db.prepare("UPDATE saas_invoices SET status = 'paid' WHERE id = ?").run(resInv.invoice.id),
      /cannot reopen a refunded or charged_back invoice/i
    );

    // Também verifica fluxo charged_back
    createTenant(dir, { id: 'gymcb', name: 'Gym CB', planId: 'starter', ownerEmail: 'dono@cb.test' });
    const cbInv = reservePixCheckoutInvoice(dir, 'gymcb', {
      planId: 'starter',
      cycle: 'annual',
      amount: 1428,
      gatewayIdempotencyKey: crypto.randomUUID()
    });
    finalizePixCheckoutInvoice(dir, 'gymcb', cbInv.invoice.id, { mpPaymentId: 'mp_cb_001' });
    applyGatewayPaymentUpdate(dir, 'gymcb', {
      id: 'mp_cb_001',
      status: 'approved',
      transaction_amount: 1428
    }, { invoiceId: cbInv.invoice.id });
    const cbRes = applyGatewayPaymentUpdate(dir, 'gymcb', {
      id: 'mp_cb_001',
      status: 'charged_back'
    }, { invoiceId: cbInv.invoice.id });
    assert.equal(cbRes.invoice.status, 'charged_back');
    assert.equal(getTenant(dir, 'gymcb').status, 'past_due');
    assert.throws(
      () => inst.db.prepare("UPDATE saas_invoices SET status = 'pending' WHERE id = ?").run(cbInv.invoice.id),
      /cannot reopen a refunded or charged_back invoice/i
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('2 & 3. Academia suspended não auto-reativa via PIX e tenant active com nextBillingAt vencido é bloqueado', () => {
  const dir = makeTempDir('rit-bla-susp-');
  try {
    createTenant(dir, { id: 'gymsusp', name: 'Gym Suspended', planId: 'starter', ownerEmail: 's@test.com' });
    const resInv = reservePixCheckoutInvoice(dir, 'gymsusp', {
      planId: 'pro',
      cycle: 'monthly',
      amount: 299,
      gatewayIdempotencyKey: crypto.randomUUID()
    });
    finalizePixCheckoutInvoice(dir, 'gymsusp', resInv.invoice.id, { mpPaymentId: 'mp_susp_001' });

    // Superadmin suspende a conta administrativamente
    updateTenant(dir, 'gymsusp', { status: 'suspended' });

    const paidWhileSusp = applyGatewayPaymentUpdate(dir, 'gymsusp', {
      id: 'mp_susp_001',
      status: 'approved',
      transaction_amount: 299
    }, { invoiceId: resInv.invoice.id });

    assert.equal(paidWhileSusp.outcome, 'approved');
    assert.equal(paidWhileSusp.tenant.status, 'suspended');
    const suspAccess = getTenantAccessState(dir, 'gymsusp');
    assert.equal(suspAccess.blocked, true);
    assert.equal(suspAccess.billingOnly, false);
    assert.equal(suspAccess.reason, 'suspended');

    // Tenant active com nextBillingAt vencido deve entrar em past_due/billingOnly
    createTenant(dir, {
      id: 'gymexp',
      name: 'Gym Expired Active',
      planId: 'starter',
      status: 'active',
      nextBillingAt: new Date(Date.now() - 120_000).toISOString(),
      ownerEmail: 'exp@test.com'
    });
    const expState = getTenantAccessState(dir, 'gymexp');
    assert.equal(expState.blocked, true);
    assert.equal(expState.billingOnly, true);
    assert.equal(expState.reason, 'past_due');
  } finally {
    cleanupTempDir(dir);
  }
});

test('6 & 7. Proteção contra NaN/0/negativo, external_reference adulterado, invalidação de PIX após mudança de preço e limpeza de outbox', () => {
  const dir = makeTempDir('rit-bla-gw-');
  try {
    createTenant(dir, { id: 'gymgwsec', name: 'Gym GW Sec', planId: 'starter', ownerEmail: 'gw@test.com' });
    const resInv = reservePixCheckoutInvoice(dir, 'gymgwsec', {
      planId: 'starter',
      cycle: 'monthly',
      amount: 149,
      gatewayIdempotencyKey: crypto.randomUUID()
    });
    finalizePixCheckoutInvoice(dir, 'gymgwsec', resInv.invoice.id, { mpPaymentId: 'mp_sec_001' });

    // 6a. transaction_amount inválido (NaN, 0, negativo) não pode passar
    for (const badAmt of [NaN, undefined, 0, -10]) {
      const badRes = applyGatewayPaymentUpdate(dir, 'gymgwsec', {
        id: 'mp_sec_001',
        status: 'approved',
        transaction_amount: badAmt
      }, { invoiceId: resInv.invoice.id });
      assert.equal(badRes.outcome, 'amount_mismatch');
      assert.equal(badRes.amountMismatch, true);
    }

    // 6b. Spoof de opts.planId/opts.cycle vindo de external_reference não pode sobrepor a fatura persistida
    const okRes = applyGatewayPaymentUpdate(dir, 'gymgwsec', {
      id: 'mp_sec_001',
      status: 'approved',
      transaction_amount: 149
    }, { invoiceId: resInv.invoice.id, planId: 'pro', cycle: 'annual' });
    assert.equal(okRes.outcome, 'approved');
    assert.equal(okRes.tenant.planId, 'starter');
    assert.equal(okRes.invoice.cycle, 'monthly');
    assert.equal(okRes.tenant.accountType, 'gym');

    // 7. Mudança de preço no plano invalida PIX pendente antigo
    const p2 = reservePixCheckoutInvoice(dir, 'gymgwsec', {
      planId: 'starter',
      cycle: 'monthly',
      amount: 149,
      gatewayIdempotencyKey: crypto.randomUUID()
    });
    assert.equal(p2.status, 'created');
    finalizePixCheckoutInvoice(dir, 'gymgwsec', p2.invoice.id, { mpPaymentId: 'mp_sec_002' });

    const starterPlan = listSaasPlans(dir).find(p => p.id === 'starter');
    upsertSaasPlan(dir, { ...starterPlan, priceMonthly: 199 });

    const p3 = reservePixCheckoutInvoice(dir, 'gymgwsec', {
      planId: 'starter',
      cycle: 'monthly',
      amount: 199,
      gatewayIdempotencyKey: crypto.randomUUID()
    });
    assert.equal(p3.status, 'created');
    assert.notEqual(p3.invoice.id, p2.invoice.id);
    assert.equal(p3.amount, 199);

    const inst = getSqliteInstance(dir);
    const staleRow = inst.stmts.getInvoiceById.get(p2.invoice.id);
    assert.equal(staleRow.status, 'cancelled');

    // Validações estritas de planos, MRR e limites
    assert.throws(() => upsertSaasPlan(dir, { id: 'starter', priceMonthly: 0 }), DomainError);
    assert.throws(() => upsertSaasPlan(dir, { id: 'starter', priceMonthly: -50 }), DomainError);
    assert.throws(() => upsertSaasPlan(dir, { id: 'starter', priceMonthly: 'abc' }), DomainError);
    assert.throws(() => upsertSaasPlan(dir, { id: 'starter', maxStudents: 0 }), DomainError);
    assert.throws(() => createTenant(dir, { id: 'badmrr', name: 'Bad', mrr: -10 }), DomainError);
    assert.throws(() => updateTenant(dir, 'gymgwsec', { maxStudentsOverride: -1 }), DomainError);
    assert.throws(() => updateTenant(dir, 'gymgwsec', { maxStudentsOverride: 'abc' }), DomainError);
    assert.throws(() => updateTenant(dir, 'gymgwsec', { maxTrainersOverride: -2 }), DomainError);

    // deleteTenant limpa whatsapp_outbox do tenant excluído sem tocar no outro tenant
    inst.db.prepare(
      'INSERT INTO whatsapp_outbox (id, tenant_id, kind, status, dedup_key, attempts, next_attempt_at, locked_at, created_at, completed_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('wa_1', 'gymgwsec', 'welcome', 'pending', 'd1', 0, 0, null, Date.now(), null, '{}');
    createTenant(dir, { id: 'gymkeep', name: 'Keep', planId: 'starter', ownerEmail: 'keep@test.com' });
    inst.db.prepare(
      'INSERT INTO whatsapp_outbox (id, tenant_id, kind, status, dedup_key, attempts, next_attempt_at, locked_at, created_at, completed_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('wa_2', 'gymkeep', 'welcome', 'pending', 'd2', 0, 0, null, Date.now(), null, '{}');

    deleteTenant(dir, 'gymgwsec');
    assert.equal(inst.db.prepare("SELECT COUNT(*) AS cnt FROM whatsapp_outbox WHERE tenant_id = 'gymgwsec'").get().cnt, 0);
    assert.equal(inst.db.prepare("SELECT COUNT(*) AS cnt FROM whatsapp_outbox WHERE tenant_id = 'gymkeep'").get().cnt, 1);
  } finally {
    cleanupTempDir(dir);
  }
});

test('4, 5, 8 & HTTP. Checkout capacity (422), register accountType vs planId (422), cross-tenant invite & 404 tenant-not-found, disabled revoga sessão e planos inválidos retornam 400', async t => {
  const dir = makeTempDir('rit-bla-http-');
  const superAdmin = { id: 'u_super_bla', name: 'Super Admin', email: 'super@bla.test', saasRole: 'superadmin', admin: true, role: 'trainer' };
  const owner = { id: 'u_owner_bla', name: 'Dono Studio', email: 'owner@bla.test', saasRole: 'gym_owner', role: 'trainer', tenantId: 'gymcap' };
  const expiredOwner = { id: 'u_exp_owner', name: 'Dono Expirado', email: 'expowner@bla.test', saasRole: 'gym_owner', role: 'trainer', tenantId: 'gymhttpexp' };
  const expiredStudent = { id: 'u_exp_stu', name: 'Aluno Expirado', saasRole: 'student', role: 'student', tenantId: 'gymhttpexp', pw: { h: await hashPassword('SenhaAluno123!'), set: new Date().toISOString() } };
  const victimStudent = {
    id: 'u_stu_disable',
    name: 'Aluno Desativar',
    saasRole: 'student',
    role: 'student',
    tenantId: 'gymcap',
    sv: 0,
    pwReset: { h: hashResetCode(makeResetCode()), exp: Date.now() + 3600_000, by: owner.id },
    pw: { h: await hashPassword('SenhaAluno123!'), set: new Date().toISOString() }
  };

  // Seed 11 alunos ativos em gymcap (excede maxStudents=10 do plano personal)
  const capStudents = Array.from({ length: 10 }, (_, idx) => ({
    id: `u_cap_${idx}`,
    name: `Aluno Cap ${idx}`,
    saasRole: 'student',
    role: 'student',
    tenantId: 'gymcap'
  }));

  const allUsers = [superAdmin, owner, expiredOwner, expiredStudent, victimStudent, ...capStudents];
  const globalInviteCode = 'GLOBAL-DEFAULT-INVITE';
  const globalInvite = { id: 'inv_global', code: globalInviteCode, tenantId: 'default', createdAt: new Date().toISOString(), by: superAdmin.id };
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    users: allUsers,
    creds: [],
    subs: [],
    invites: [globalInvite],
    deviceLinks: [],
    watches: []
  }));

  createTenant(dir, {
    id: 'gymcap',
    name: 'Gym Capacity',
    planId: 'starter',
    status: 'active',
    nextBillingAt: new Date(Date.now() + 15 * 86400000).toISOString(),
    ownerName: owner.name,
    ownerEmail: owner.email
  });
  createTenant(dir, {
    id: 'gymhttpexp',
    name: 'Gym Http Exp',
    planId: 'starter',
    status: 'active',
    nextBillingAt: new Date(Date.now() - 60_000).toISOString(),
    ownerName: expiredOwner.name,
    ownerEmail: expiredOwner.email
  });
  updateTenant(dir, 'gymcap', { settings: { inviteOnly: true } });

  for (const u of allUsers) upsertUserSqlite(dir, u, null);
  upsertInviteSqlite(dir, globalInvite, null);
  closeSqliteInstance(dir);

  const { child, getLog } = spawnTestServer(dir);
  t.after(() => {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    cleanupTempDir(dir);
  });

  const port = await boundPort(child, getLog);
  const base = `http://127.0.0.1:${port}`;
  const portalOrigin = 'https://painel.example.test';
  const appOrigin = 'https://example.test';

  const superHeaders = { Authorization: `Bearer ${mintSession(superAdmin.id, 0)}`, Origin: portalOrigin };
  const ownerHeaders = { Authorization: `Bearer ${mintSession(owner.id, 0)}`, Origin: portalOrigin };

  // 4. Checkout-pix bloqueia downgrade para 'personal' (maxStudents=10) pois há 11 alunos ativos
  const downgradeDenied = await makeReq(base, 'POST', '/api/saas/billing/checkout-pix', {
    headers: ownerHeaders,
    body: { planId: 'personal', cycle: 'monthly' }
  });
  assert.equal(downgradeDenied.status, 422);
  assert.equal(downgradeDenied.body.code, 'plan-capacity-exceeded');

  // Upgrade para 'pro' dentro da capacidade funciona
  const upgradeOk = await makeReq(base, 'POST', '/api/saas/billing/checkout-pix', {
    headers: ownerHeaders,
    body: { planId: 'pro', cycle: 'monthly' }
  });
  assert.equal(upgradeOk.status, 200);
  assert.equal(upgradeOk.body.ok, true);

  // 5. Register accountType vs planId incompatíveis -> 422
  const mismatchGym = await makeReq(base, 'POST', '/api/saas/auth/register', {
    headers: { Origin: portalOrigin },
    body: {
      accountType: 'gym',
      planId: 'personal',
      gymName: 'Mismatch Gym',
      ownerName: 'Gestor',
      email: 'mismatch1@test.com',
      password: 'StrongPassword123!'
    }
  });
  assert.equal(mismatchGym.status, 422);
  assert.equal(mismatchGym.body.code, 'plan-account-type-mismatch');

  const mismatchPersonal = await makeReq(base, 'POST', '/api/saas/auth/register', {
    headers: { Origin: portalOrigin },
    body: {
      accountType: 'personal',
      planId: 'starter',
      gymName: 'Personal Studio',
      ownerName: 'Personal',
      email: 'mismatch2@test.com',
      password: 'StrongPassword123!'
    }
  });
  assert.equal(mismatchPersonal.status, 422);
  assert.equal(mismatchPersonal.body.code, 'plan-account-type-mismatch');

  const validPersonalReg = await makeReq(base, 'POST', '/api/saas/auth/register', {
    headers: { Origin: portalOrigin },
    body: {
      accountType: 'personal',
      planId: 'personal',
      gymName: 'Lucas Personal',
      ownerName: 'Lucas Personal',
      email: 'lucas.personal@test.com',
      password: 'StrongPassword123!'
    }
  });
  assert.ok(validPersonalReg.status === 200 || validPersonalReg.status === 201);
  assert.equal(validPersonalReg.body.ok, true);

  // 8. Cadastro em tenant inexistente -> 404; convite global 'default' em tenant específico -> 403
  const ghostSignup = await makeReq(base, 'POST', '/api/register/password?tenant=academia-inexistente', {
    headers: { Origin: appOrigin },
    body: { name: 'Aluno Fantasma', password: 'StudentPassword123!' }
  });
  assert.equal(ghostSignup.status, 404);
  assert.equal(ghostSignup.body.code, 'tenant-not-found');

  const crossTenantInvite = await makeReq(base, 'POST', '/api/register/password?tenant=gymcap', {
    headers: { Origin: appOrigin },
    body: { name: 'Aluno Cross', password: 'StudentPassword123!', code: globalInviteCode }
  });
  assert.equal(crossTenantInvite.status, 403);
  assert.equal(crossTenantInvite.body.code, 'invite');

  // 9. Desativar aluno via portal revoga sessão existente imediatamente
  const victimCookie = `gymsid=${mintSession(victimStudent.id, 0)}`;
  const meBefore = await makeReq(base, 'GET', '/api/me', { headers: { Cookie: victimCookie } });
  assert.equal(meBefore.status, 200);

  const disableRes = await makeReq(base, 'PUT', '/api/gym/students', {
    headers: ownerHeaders,
    body: { id: victimStudent.id, disabled: true }
  });
  assert.equal(disableRes.status, 200);

  const meAfter = await makeReq(base, 'GET', '/api/me', { headers: { Cookie: victimCookie } });
  assert.equal(meAfter.status, 401);

  // HTTP expired nextBillingAt: aluno perde sessão, mas gestor acessa /api/saas/billing/status (billingOnly)
  const expStuCookie = `gymsid=${mintSession(expiredStudent.id, 0)}`;
  const expStuMe = await makeReq(base, 'GET', '/api/me', { headers: { Cookie: expStuCookie } });
  assert.equal(expStuMe.status, 401);

  const expOwnerBilling = await makeReq(base, 'GET', '/api/saas/billing/status', {
    headers: { Authorization: `Bearer ${mintSession(expiredOwner.id, 0)}`, Origin: portalOrigin }
  });
  assert.equal(expOwnerBilling.status, 200);
  assert.equal(expOwnerBilling.body.billingOnly, true);
  assert.equal(expOwnerBilling.body.accessBlocked, true);
  assert.equal(expOwnerBilling.body.blockReason, 'past_due');

  // Rotas admin rejeitam valores inválidos com 400 (sem erro interno exposto)
  const badPlanRes = await makeReq(base, 'PUT', '/api/saas/admin/plans', {
    headers: superHeaders,
    body: { id: 'starter', priceMonthly: -10 }
  });
  assert.equal(badPlanRes.status, 400);

  const badMrrRes = await makeReq(base, 'PUT', '/api/saas/admin/tenants', {
    headers: superHeaders,
    body: { id: 'gymcap', mrr: -5 }
  });
  assert.equal(badMrrRes.status, 400);
});
