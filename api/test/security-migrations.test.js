import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getSqliteInstance,
  closeSqliteInstance
} from '../sqlite.js';
import { createTenant } from '../tenants.js';
import {
  SECURITY_MIGRATION_IDS,
  ensureServerSecret,
  sealTenantSecret,
  openTenantSecret,
  runSecurityMigrations
} from '../migrate-security.js';

const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeTempDir(prefix = 'rit-sec-mig-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir) {
  try { closeSqliteInstance(dir); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function insertLegacyPlaintextTenant(dir, { id, name, evolutionUrl, evolutionApiKey }) {
  const inst = getSqliteInstance(dir);
  const now = Date.now();
  const rowData = {
    id,
    name,
    planId: 'pro',
    status: 'active',
    createdAt: new Date(now).toISOString(),
    settings: { evolutionUrl, evolutionApiKey }
  };
  inst.stmts.upsertTenantRow.run(id, 'pro', 'active', JSON.stringify(rowData), '{}', '[]', now);
  inst.stmts.setKv.run(
    'saas_store',
    JSON.stringify({ plansVersion: 2, plans: [], tenants: { [id]: rowData }, platform: {} }),
    now
  );
  return inst;
}

test('Etapa 2: dryRun inspeciona pendencias sem modificar o banco ou criar secret', () => {
  const dir = makeTempDir();
  try {
    const inst = insertLegacyPlaintextTenant(dir, {
      id: 'alpha',
      name: 'Alpha Gym',
      evolutionUrl: 'https://evo.alpha.example',
      evolutionApiKey: 'plain-key-123'
    });
    inst.db.prepare(`
      INSERT INTO users (id, tenant_id, email, name, role, data, updated_at)
      VALUES ('u_blank', '   ', 'a@a.test', 'Blank User', 'student', '{"id":"u_blank","tenantId":""}', ?)
    `).run(Date.now());

    const preview = runSecurityMigrations({
      dataDir: dir,
      env: { SAAS_DEMO: '0' },
      dryRun: true
    });

    assert.equal(preview.dryRun, true);
    assert.equal(preview.pending.blankUsers, 1);
    assert.equal(preview.pending.plaintextTenants, 1);
    assert.ok(preview.pending.missingTriggers.length >= 10);
    assert.equal(fs.existsSync(path.join(dir, 'secret')), false);

    // Chave ainda deve estar em texto puro antes de rodar a migration real
    const row = inst.db.prepare('SELECT data FROM tenants WHERE id = ?').get('alpha');
    assert.equal(JSON.parse(row.data).settings.evolutionApiKey, 'plain-key-123');
  } finally {
    cleanupTempDir(dir);
  }
});

test('Etapa 2: criptografa evolutionApiKey em repouso com AAD por tenant e garante idempotencia', () => {
  const dir = makeTempDir();
  try {
    insertLegacyPlaintextTenant(dir, {
      id: 'iron',
      name: 'Iron Club',
      evolutionUrl: 'https://evo.iron.example',
      evolutionApiKey: 'evo-secret-iron-999'
    });
    const secret = ensureServerSecret(dir);

    const res1 = runSecurityMigrations({ dataDir: dir, secret, env: { SAAS_DEMO: '0' } });
    assert.equal(res1.sealedTenants, 1);

    const inst = getSqliteInstance(dir);
    const tenantRow = inst.db.prepare('SELECT data FROM tenants WHERE id = ?').get('iron');
    const tenantMeta = JSON.parse(tenantRow.data);
    assert.equal(tenantMeta.settings.evolutionApiKey, undefined);
    assert.ok(String(tenantMeta.settings.evolutionApiKeyEnc || '').startsWith('v1.'));
    assert.equal(
      openTenantSecret(tenantMeta.settings.evolutionApiKeyEnc, { tenantId: 'iron', secret }),
      'evo-secret-iron-999'
    );
    // Transplantar ciphertext para outro tenant ou outro secret deve falhar
    assert.equal(
      openTenantSecret(tenantMeta.settings.evolutionApiKeyEnc, { tenantId: 'other-gym', secret }),
      ''
    );
    assert.equal(
      openTenantSecret(tenantMeta.settings.evolutionApiKeyEnc, { tenantId: 'iron', secret: 'x'.repeat(64) }),
      ''
    );

    // Espelho saas_store no kv_store tambem nao pode reter texto puro
    const kvRow = inst.db.prepare("SELECT value FROM kv_store WHERE key = 'saas_store'").get();
    const kvParsed = JSON.parse(kvRow.value);
    assert.equal(kvParsed.tenants.iron.settings.evolutionApiKey, undefined);
    assert.equal(kvParsed.tenants.iron.settings.evolutionApiKeyEnc, tenantMeta.settings.evolutionApiKeyEnc);

    // Idempotencia: segunda execucao nao reseala nem corrompe
    const res2 = runSecurityMigrations({ dataDir: dir, secret, env: { SAAS_DEMO: '0' } });
    assert.equal(res2.sealedTenants, 0);
    assert.equal(res2.scrubbedPlaintext, 0);
    const tenantRowAfter = inst.db.prepare('SELECT data FROM tenants WHERE id = ?').get('iron');
    assert.equal(
      JSON.parse(tenantRowAfter.data).settings.evolutionApiKeyEnc,
      tenantMeta.settings.evolutionApiKeyEnc
    );

    // sealTenantSecret diretamente tambem e idempotente
    assert.equal(
      sealTenantSecret(tenantMeta.settings.evolutionApiKeyEnc, { tenantId: 'iron', secret }),
      tenantMeta.settings.evolutionApiKeyEnc
    );
  } finally {
    cleanupTempDir(dir);
  }
});

test('Etapa 2: normaliza tenant_id e impoe triggers de politica multi-tenant e faturamento no SQLite', () => {
  const dir = makeTempDir();
  try {
    const inst = getSqliteInstance(dir);
    const now = Date.now();
    inst.db.prepare(`
      INSERT INTO users (id, tenant_id, email, name, role, data, updated_at)
      VALUES ('u_legacy', '  ', 'legacy@test.com', 'Legacy', 'student', '{"id":"u_legacy","tenantId":""}', ?)
    `).run(now);
    inst.db.prepare(`
      INSERT INTO invites (code, tenant_id, data)
      VALUES ('INV001', '', '{"code":"INV001"}')
    `).run();

    const res = runSecurityMigrations({ dataDir: dir, env: { SAAS_DEMO: '0' } });
    assert.equal(res.normalizedUsers, 1);
    assert.equal(res.normalizedInvites, 1);
    assert.ok(res.triggersInstalled >= 14);

    const uRow = inst.db.prepare("SELECT tenant_id, data FROM users WHERE id = 'u_legacy'").get();
    assert.equal(uRow.tenant_id, 'default');
    assert.equal(JSON.parse(uRow.data).tenantId, 'default');

    const iRow = inst.db.prepare("SELECT tenant_id, data FROM invites WHERE code = 'INV001'").get();
    assert.equal(iRow.tenant_id, 'default');
    assert.equal(JSON.parse(iRow.data).tenantId, 'default');

    // Triggers bloqueiam tenant_id vazio em users e invites
    assert.throws(() => {
      inst.db.prepare(`
        INSERT INTO users (id, tenant_id, email, name, role, data, updated_at)
        VALUES ('u_bad', '  ', 'bad@test.com', 'Bad', 'student', '{}', ?)
      `).run(now);
    }, /users\.tenant_id cannot be blank/);

    assert.throws(() => {
      inst.db.prepare("UPDATE invites SET tenant_id = '' WHERE code = 'INV001'").run();
    }, /invites\.tenant_id cannot be blank/);

    // Trigger protege saas_invoices: proibe valor negativo, troca de tenant e downgrade de fatura paga
    inst.db.prepare(`
      INSERT INTO saas_invoices (
        id, tenant_id, plan_id, kind, amount_cents, status, method,
        mp_payment_id, idempotency_key, created_at, paid_at, expires_at, data
      ) VALUES ('inv_paid', 'alpha', 'pro', 'invoice', 26900, 'paid', 'pix', '999', NULL, ?, ?, NULL, '{"id":"inv_paid","status":"paid"}')
    `).run(now, now);

    assert.throws(() => {
      inst.db.prepare("UPDATE saas_invoices SET tenant_id = 'beta' WHERE id = 'inv_paid'").run();
    }, /cannot transfer saas_invoices across tenants/);

    assert.throws(() => {
      inst.db.prepare("UPDATE saas_invoices SET status = 'pending' WHERE id = 'inv_paid'").run();
    }, /cannot downgrade a paid invoice/);

    assert.throws(() => {
      inst.db.prepare("UPDATE saas_invoices SET amount_cents = 100 WHERE id = 'inv_paid'").run();
    }, /cannot mutate amount of a paid invoice/);

    // Trigger protege api_idempotency_keys concluidos contra mutacao de identidade/payload
    inst.db.prepare(`
      INSERT INTO api_idempotency_keys (
        scope_key, client_key, route, actor_id, request_hash,
        status, response_status, response_body, gateway_idempotency_key,
        created_at, updated_at, expires_at
      ) VALUES ('POST:/x|u1|k1', 'k1', 'POST /x', 'u1', 'h1', 'completed', 200, '{}', NULL, ?, ?, ?)
    `).run(now, now, now + 60000);
    assert.throws(() => {
      inst.db.prepare("UPDATE api_idempotency_keys SET actor_id = 'u2' WHERE scope_key = 'POST:/x|u1|k1'").run();
    }, /cannot mutate completed api_idempotency_keys identity/);

    // DELETE (cleanup de dados de teste/demo) continua permitido
    inst.db.prepare("DELETE FROM saas_invoices WHERE id = 'inv_paid'").run();

    // Reabertura do SQLite (compilando todos os prepared statements) deve ocorrer sem erro
    closeSqliteInstance(dir);
    const reopened = getSqliteInstance(dir);

    // Auditoria das migrations registradas
    const appliedIds = reopened.db.prepare('SELECT id FROM security_migrations ORDER BY id').all().map(r => r.id);
    assert.deepEqual(appliedIds, [
      SECURITY_MIGRATION_IDS.NORMALIZE_TENANTS,
      SECURITY_MIGRATION_IDS.POLICY_TRIGGERS,
      SECURITY_MIGRATION_IDS.SEAL_EVOLUTION_KEYS,
      SECURITY_MIGRATION_IDS.EXPIRE_SIM_INVOICES
    ]);
  } finally {
    cleanupTempDir(dir);
  }
});

test('Etapa 2: expira faturas pendentes simuladas mp_sim_* apenas fora de SAAS_DEMO e sem token MP', () => {
  const dir = makeTempDir();
  try {
    createTenant(dir, { id: 'gym1', name: 'Gym 1', planId: 'starter' });
    const inst = getSqliteInstance(dir);
    const now = Date.now();

    // Pending simulada + Pending real MP + Paid historica simulada
    inst.db.prepare(`
      INSERT INTO saas_invoices (
        id, tenant_id, plan_id, kind, amount_cents, status, method,
        mp_payment_id, idempotency_key, created_at, paid_at, expires_at, data
      ) VALUES
        ('inv_sim_open', 'gym1', 'pro', 'pix_checkout', 26900, 'pending', 'pix', 'mp_sim_111', NULL, ?, NULL, ?, '{"id":"inv_sim_open","status":"pending","mpPaymentId":"mp_sim_111"}'),
        ('inv_real_open', 'gym1', 'starter', 'pix_checkout', 16900, 'pending', 'pix', '9876543210', NULL, ?, NULL, ?, '{"id":"inv_real_open","status":"pending","mpPaymentId":"9876543210"}'),
        ('inv_sim_paid', 'gym1', 'starter', 'pix_checkout', 16900, 'paid', 'pix', 'mp_sim_000', NULL, ?, ?, NULL, '{"id":"inv_sim_paid","status":"paid","mpPaymentId":"mp_sim_000"}')
    `).run(now, now + 600000, now, now + 600000, now, now);

    // Em SAAS_DEMO=1 nao deve expirar
    const demoRun = runSecurityMigrations({ dataDir: dir, env: { SAAS_DEMO: '1' } });
    assert.equal(demoRun.simExpirationSkipped, true);
    assert.equal(demoRun.expiredSimInvoices, 0);
    assert.equal(inst.db.prepare("SELECT status FROM saas_invoices WHERE id = 'inv_sim_open'").get().status, 'pending');

    // Em producao sem token MP, deve expirar apenas a pending mp_sim_*
    const prodRun = runSecurityMigrations({ dataDir: dir, env: { SAAS_DEMO: '0' } });
    assert.equal(prodRun.simExpirationSkipped, false);
    assert.equal(prodRun.expiredSimInvoices, 1);

    const simOpen = inst.db.prepare("SELECT status, data FROM saas_invoices WHERE id = 'inv_sim_open'").get();
    assert.equal(simOpen.status, 'expired');
    assert.equal(JSON.parse(simOpen.data).expiredReason, 'sim_disabled_in_prod');

    assert.equal(inst.db.prepare("SELECT status FROM saas_invoices WHERE id = 'inv_real_open'").get().status, 'pending');
    assert.equal(inst.db.prepare("SELECT status FROM saas_invoices WHERE id = 'inv_sim_paid'").get().status, 'paid');
  } finally {
    cleanupTempDir(dir);
  }
});

test('Etapa 2: CLI standalone node migrate-security.js executa com sucesso', () => {
  const dir = makeTempDir();
  try {
    insertLegacyPlaintextTenant(dir, {
      id: 'cligym',
      name: 'CLI Gym',
      evolutionUrl: 'https://evo.cli.example',
      evolutionApiKey: 'cli-secret-abc'
    });
    closeSqliteInstance(dir);

    const stdout = execFileSync(process.execPath, ['migrate-security.js', '--data-dir', dir], {
      cwd: API_DIR,
      env: { ...process.env, SAAS_DEMO: '0', MERCADO_PAGO_ACCESS_TOKEN: '' },
      encoding: 'utf8'
    });
    const output = JSON.parse(stdout);
    assert.equal(output.ok, true);
    assert.equal(output.sealedTenants, 1);
  } finally {
    cleanupTempDir(dir);
  }
});
