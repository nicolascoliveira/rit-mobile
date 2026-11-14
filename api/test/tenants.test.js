import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveTenantId,
  sanitizeTenantId,
  getTenantDir,
  getTenant,
  resolveTenantEvolutionSettings,
  loadTenantBranding,
  saveTenantBranding,
  createTenant,
  updateTenant,
  deleteTenant,
  recordTenantInvoice,
  listTenants,
  listSaasPlans,
  upsertSaasPlan,
  isTenantSuspended,
  getTenantAccessState
} from '../tenants.js';

test('sanitizeTenantId sanitizes properly', () => {
  assert.equal(sanitizeTenantId('Iron-Gym_2026'), 'iron-gym_2026');
  assert.equal(sanitizeTenantId('  Alpha!@#  '), 'alpha');
  assert.equal(sanitizeTenantId('www'), 'default');
  assert.equal(sanitizeTenantId('api'), 'default');
  assert.equal(sanitizeTenantId(''), 'default');
  assert.equal(sanitizeTenantId(null), 'default');
});

test('resolveTenantId extracts from headers, query, subdomain', () => {
  assert.equal(resolveTenantId({ headers: { 'x-tenant-id': 'iron' }, url: '/' }), 'iron');
  assert.equal(resolveTenantId({ headers: {}, url: '/api/config?tenant=alpha' }), 'alpha');
  assert.equal(resolveTenantId({ headers: { host: 'iron.seusistema.com.br' }, url: '/api/config' }), 'iron');
  assert.equal(resolveTenantId({ headers: { host: 'alpha.localhost:8080' }, url: '/api/config' }), 'alpha');
  assert.equal(resolveTenantId({ headers: { host: 'localhost:8080' }, url: '/api/config' }), 'default');
  assert.equal(resolveTenantId({ headers: { host: '127.0.0.1:3000' }, url: '/api/config' }), 'default');
  assert.equal(resolveTenantId({ headers: { host: 'www.seusistema.com.br' }, url: '/api/config' }), 'default');
});

test('SaaS plans, tenant lifecycle, suspension, billing and branding', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-tenant-test-'));
  try {
    const plans = listSaasPlans(tmpDir);
    assert.equal(plans.length, 4);
    const pPersonal = plans.find(p => p.id === 'personal');
    const pPersonalPro = plans.find(p => p.id === 'personal-pro');
    const pStarter = plans.find(p => p.id === 'starter');
    const pPro = plans.find(p => p.id === 'pro');

    assert.equal(pPersonal.priceMonthly, 29);
    assert.equal(pPersonal.priceAnnualMonthly, 24);
    assert.equal(pPersonal.maxStudents, 10);
    assert.equal(pPersonal.maxTrainers, 1);

    assert.equal(pPersonalPro.priceMonthly, 49);
    assert.equal(pPersonalPro.priceAnnualMonthly, 39);
    assert.equal(pPersonalPro.maxStudents, 100000);
    assert.equal(pPersonalPro.maxTrainers, 1);

    assert.equal(pStarter.priceMonthly, 169);
    assert.equal(pStarter.priceAnnualMonthly, 139);
    assert.equal(pStarter.maxStudents, 150);
    assert.equal(pStarter.maxTrainers, 3);

    assert.equal(pPro.priceMonthly, 269);
    assert.equal(pPro.priceAnnualMonthly, 219);
    assert.equal(pPro.maxStudents, 100000);
    assert.equal(pPro.maxTrainers, 100000);

    upsertSaasPlan(tmpDir, { id: 'pro', name: 'Pro Plus', priceMonthly: 397, maxStudents: 500 });
    assert.equal(listSaasPlans(tmpDir).find(p => p.id === 'pro').priceMonthly, 397);

    const t = createTenant(tmpDir, {
      id: 'iron',
      name: 'Iron Gym',
      planId: 'pro',
      ownerName: 'Carlos',
      ownerEmail: 'carlos@iron.com',
      primaryColor: '#ef4444',
      slogan: 'Força Total'
    });
    assert.equal(t.id, 'iron');
    assert.equal(t.branding.gymName, 'Iron Gym');
    assert.equal(t.branding.primaryColor, '#ef4444');
    assert.equal(t.mrr, 397);
    assert.equal(isTenantSuspended(tmpDir, 'iron'), false);

    const tDir = getTenantDir(tmpDir, 'iron');
    assert.ok(fs.existsSync(path.join(tmpDir, 'rit.db')));
    assert.equal(loadTenantBranding(tDir).gymName, 'Iron Gym');

    saveTenantBranding(tDir, { slogan: 'Nova Filosofia' });
    assert.equal(loadTenantBranding(tDir).slogan, 'Nova Filosofia');

    // Suspender e reativar
    updateTenant(tmpDir, 'iron', { status: 'suspended' });
    assert.equal(isTenantSuspended(tmpDir, 'iron'), true);

    // Registrar pagamento reativa fatura
    updateTenant(tmpDir, 'iron', { status: 'past_due' });
    const inv = recordTenantInvoice(tmpDir, 'iron', { amount: 397, status: 'paid', method: 'PIX' });
    assert.equal(inv.status, 'paid');
    assert.equal(getTenant(tmpDir, 'iron').status, 'active');

    const list = listTenants(tmpDir);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'iron');

    deleteTenant(tmpDir, 'iron');
    assert.equal(listTenants(tmpDir).length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SQLite WAL engine automatically migrates legacy JSON files into rit.db and removes old JSONs', async () => {
  const {
    getSqliteInstance,
    loadCoreDbFromSqlite,
    readUserStateSqlite,
    getSqliteKv
  } = await import('../sqlite.js');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-sqlite-mig-'));
  try {
    // Seed legacy JSON files prior to opening SQLite
    fs.writeFileSync(path.join(tmpDir, 'db.json'), JSON.stringify({
      users: [{ id: 'u_leg_1', name: 'Aluno Legado', tenantId: 'ironpower', role: 'student' }],
      creds: [],
      subs: [],
      invites: [{ code: 'INV123', tenantId: 'ironpower' }]
    }));
    fs.writeFileSync(path.join(tmpDir, 'state-u_leg_1.json'), JSON.stringify({
      _rev: 3,
      _wid: 'w_abc',
      routines: [{ id: 'r1', name: 'Ficha Legada' }],
      workouts: [{ id: 'wk1', d: '2026-11-01', vol: 2500 }]
    }));
    fs.writeFileSync(path.join(tmpDir, 'whatsapp-outbox.json'), JSON.stringify({
      items: [{ id: 'wa_1', tenantId: 'ironpower', status: 'queued' }]
    }));
    const tDir = path.join(tmpDir, 'tenants', 'ironpower');
    fs.mkdirSync(tDir, { recursive: true });
    fs.writeFileSync(path.join(tDir, 'branding.json'), JSON.stringify({
      gymName: 'Iron Power Legado',
      primaryColor: '#ff5500'
    }));

    const inst = getSqliteInstance(tmpDir);
    const modeRow = inst.db.prepare('PRAGMA journal_mode').get();
    assert.equal(String(modeRow.journal_mode).toLowerCase(), 'wal');

    // Legacy JSON files must have been migrated and removed from disk
    assert.equal(fs.existsSync(path.join(tmpDir, 'rit.db')), true);
    // db.json eh preservado/espelhado para compatibilidade com ferramentas externas (MCP)
    assert.equal(fs.existsSync(path.join(tmpDir, 'db.json')), true);
    assert.equal(fs.existsSync(path.join(tmpDir, 'state-u_leg_1.json')), false);
    assert.equal(fs.existsSync(path.join(tmpDir, 'whatsapp-outbox.json')), false);
    assert.equal(fs.existsSync(path.join(tDir, 'branding.json')), false);

    // Data is intact inside SQLite
    const core = loadCoreDbFromSqlite(tmpDir);
    assert.equal(core.users.length, 1);
    assert.equal(core.users[0].name, 'Aluno Legado');
    assert.equal(core.invites.length, 1);

    const st = readUserStateSqlite(tmpDir, 'u_leg_1');
    assert.equal(st._rev, 3);
    assert.equal(st.routines[0].name, 'Ficha Legada');

    const brand = getSqliteKv(tmpDir, 'branding:ironpower');
    assert.equal(brand.gymName, 'Iron Power Legado');

    const outbox = getSqliteKv(tmpDir, 'whatsapp_outbox');
    assert.equal(outbox.items.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('migrateLegacyPlans automatically upgrades legacy plan tiers and pricing', async () => {
  const { setSqliteKv } = await import('../sqlite.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-plan-mig-'));
  try {
    // Seed v1 plans and legacy tenants inside saas_store
    setSqliteKv(tmpDir, 'saas_store', {
      plansVersion: 1,
      plans: [
        { id: 'starter', name: 'Starter Antigo', priceMonthly: 89 },
        { id: 'pro', name: 'Pro Antigo', priceMonthly: 197 },
        { id: 'enterprise', name: 'Enterprise Antigo', priceMonthly: 697 }
      ],
      tenants: {
        tenant_starter: { id: 'tenant_starter', name: 'Academia Starter', planId: 'starter', mrr: 89 },
        tenant_enterprise: { id: 'tenant_enterprise', name: 'Academia Enterprise', planId: 'enterprise', mrr: 697 }
      }
    });

    // Calling listSaasPlans triggers migrateLegacyPlans and persists new version
    const plans = listSaasPlans(tmpDir);
    assert.equal(plans.length, 4);
    assert.ok(plans.some(p => p.id === 'personal'));
    assert.ok(plans.some(p => p.id === 'personal-pro'));
    assert.ok(plans.some(p => p.id === 'starter'));
    assert.ok(plans.some(p => p.id === 'pro'));

    const tenants = listTenants(tmpDir);
    const ts = tenants.find(t => t.id === 'tenant_starter');
    const te = tenants.find(t => t.id === 'tenant_enterprise');

    // Starter was 89 -> upgraded to 169 (Estúdio)
    assert.equal(ts.planId, 'starter');
    assert.equal(ts.mrr, 169);
    // Enterprise was 697 -> migrated to pro (Academia Completa) at 269
    assert.equal(te.planId, 'pro');
    assert.equal(te.mrr, 269);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('updateTenant seals evolutionApiKey at rest, omits it from DTOs, and rejects SSRF evolutionUrl', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-tenant-wa-'));
  try {
    createTenant(tmpDir, { id: 'wagym', name: 'WA Gym' });
    const updated = updateTenant(tmpDir, 'wagym', {
      settings: {
        notifyTrainerOnWorkout: true,
        notifyStudentOnPrescribe: false,
        evolutionUrl: 'https://evo.wagym.com.br/',
        evolutionApiKey: 'evo_secret_123',
        evolutionInstance: 'wagym_oficial'
      }
    });
    assert.equal(updated.settings.notifyTrainerOnWorkout, true);
    assert.equal(updated.settings.notifyStudentOnPrescribe, false);
    assert.equal(updated.settings.evolutionUrl, 'https://evo.wagym.com.br');
    assert.equal(updated.settings.evolutionApiKey, undefined);
    assert.equal(updated.settings.evolutionApiKeyEnc, undefined);
    assert.equal(updated.settings.hasEvolutionApiKey, true);
    assert.equal(updated.settings.evolutionInstance, 'wagym_oficial');

    const persisted = getTenant(tmpDir, 'wagym');
    assert.equal(persisted.settings.evolutionInstance, 'wagym_oficial');
    assert.equal(persisted.settings.evolutionApiKey, undefined);
    assert.equal(persisted.settings.evolutionApiKeyEnc, undefined);
    assert.equal(persisted.settings.hasEvolutionApiKey, true);

    const serverResolved = resolveTenantEvolutionSettings(tmpDir, 'wagym');
    assert.equal(serverResolved.evolutionUrl, 'https://evo.wagym.com.br');
    assert.equal(serverResolved.evolutionApiKey, 'evo_secret_123');
    assert.equal(serverResolved.evolutionInstance, 'wagym_oficial');

    // Empty evolutionApiKey / '***' must preserve existing sealed secret rather than wiping it
    const preserved = updateTenant(tmpDir, 'wagym', {
      settings: { evolutionApiKey: '' }
    });
    assert.equal(preserved.settings.hasEvolutionApiKey, true);
    assert.equal(resolveTenantEvolutionSettings(tmpDir, 'wagym').evolutionApiKey, 'evo_secret_123');

    // Explicit clearEvolutionApiKey clears the sealed secret
    const cleared = updateTenant(tmpDir, 'wagym', {
      settings: { clearEvolutionApiKey: true }
    });
    assert.equal(cleared.settings.hasEvolutionApiKey, false);
    assert.equal(resolveTenantEvolutionSettings(tmpDir, 'wagym').evolutionApiKey, '');

    for (const badUrl of [
      'ftp://invalid-scheme.example.com',
      'http://localhost:8082',
      'http://127.0.0.1:8082',
      'http://169.254.169.254/latest/meta-data',
      'https://evo.internal',
      'http://external-evo.example.com'
    ]) {
      assert.throws(() => {
        updateTenant(tmpDir, 'wagym', {
          settings: { evolutionUrl: badUrl }
        });
      });
      assert.throws(() => {
        createTenant(tmpDir, {
          id: 'badgym',
          name: 'Bad Gym',
          settings: { evolutionUrl: badUrl }
        });
      });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('confirmTenantPayment updates plan/MRR and is idempotent on replay', async () => {
  const { confirmTenantPayment } = await import('../tenants.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-confirm-pay-'));
  try {
    createTenant(tmpDir, { id: 'paygym', name: 'Pay Gym', planId: 'starter' });
    const inv = recordTenantInvoice(tmpDir, 'paygym', {
      amount: 269,
      planId: 'pro',
      cycle: 'monthly',
      status: 'pending'
    });

    const first = confirmTenantPayment(tmpDir, 'paygym', {
      invoiceId: inv.id,
      mpPaymentId: 'mp_pay_001',
      amount: 269,
      method: 'pix',
      cycle: 'monthly',
      planId: 'pro',
      planName: 'Academia Completa'
    });
    assert.equal(first.alreadyPaid, false);
    assert.equal(first.invoice.status, 'paid');
    assert.equal(first.tenant.planId, 'pro');
    assert.equal(first.tenant.mrr, 269);
    assert.equal(first.tenant.status, 'active');
    const firstNextBilling = first.tenant.nextBillingAt;
    assert.ok(firstNextBilling);

    // Replaying the same payment/invoice must NOT extend nextBillingAt again
    const second = confirmTenantPayment(tmpDir, 'paygym', {
      invoiceId: inv.id,
      mpPaymentId: 'mp_pay_001',
      amount: 269,
      method: 'pix',
      cycle: 'monthly',
      planId: 'pro'
    });
    assert.equal(second.alreadyPaid, true);
    assert.equal(second.tenant.nextBillingAt, firstNextBilling);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getTenantAccessState & isTenantSuspended enforce expired trialEndsAt, past_due, and suspended locks', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-access-state-'));
  try {
    createTenant(tmpDir, {
      id: 'trialok',
      name: 'Trial Ativo',
      status: 'trial',
      trialEndsAt: new Date(Date.now() + 7 * 86400000).toISOString()
    });
    assert.equal(isTenantSuspended(tmpDir, 'trialok'), false);
    assert.deepEqual(
      { blocked: getTenantAccessState(tmpDir, 'trialok').blocked, billingOnly: getTenantAccessState(tmpDir, 'trialok').billingOnly },
      { blocked: false, billingOnly: false }
    );

    createTenant(tmpDir, {
      id: 'trialexp',
      name: 'Trial Expirado',
      status: 'trial',
      trialEndsAt: new Date(Date.now() - 60_000).toISOString()
    });
    const expState = getTenantAccessState(tmpDir, 'trialexp');
    assert.equal(expState.blocked, true);
    assert.equal(expState.billingOnly, true);
    assert.equal(expState.reason, 'trial_expired');
    assert.equal(isTenantSuspended(tmpDir, 'trialexp'), true);

    createTenant(tmpDir, {
      id: 'overdue',
      name: 'Academia Atrasada',
      status: 'past_due'
    });
    const pdState = getTenantAccessState(tmpDir, 'overdue');
    assert.equal(pdState.blocked, true);
    assert.equal(pdState.billingOnly, true);
    assert.equal(pdState.reason, 'past_due');
    assert.equal(isTenantSuspended(tmpDir, 'overdue'), true);

    updateTenant(tmpDir, 'overdue', { status: 'suspended' });
    const suspState = getTenantAccessState(tmpDir, 'overdue');
    assert.equal(suspState.blocked, true);
    assert.equal(suspState.billingOnly, false);
    assert.equal(suspState.reason, 'suspended');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


