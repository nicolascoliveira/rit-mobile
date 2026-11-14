#!/usr/bin/env node
/**
 * api/migrate-security.js
 *
 * Migration de segurança isolada e idempotente para o SQLite (rit.db):
 *  1. Normaliza `tenant_id` em `users` e `invites` (zero escopo nulo/vazio);
 *  2. Instala triggers de política no banco (equivalente a guardrails de RLS multi-tenant e integridade de faturas pagas);
 *  3. Criptografa em repouso `settings.evolutionApiKey` -> `settings.evolutionApiKeyEnc` (AES-256-GCM + HKDF com AAD por tenant)
 *     em `tenants` e no espelho `kv_store['saas_store']`, removendo o texto puro;
 *  4. Expira faturas `pending` / `checkout_creating` simuladas (`mp_sim_*`) em produção quando `SAAS_DEMO !== '1'`
 *     e o Mercado Pago oficial não está configurado.
 *
 * Uso CLI:
 *   node api/migrate-security.js [--dry-run] [--data-dir <caminho>]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deriveKey, seal, open } from './integrations/crypto.js';
import {
  getSqliteInstance,
  runInTransaction,
  backfillRelationalTables,
  closeSqliteInstance
} from './sqlite.js';
import { isMercadoPagoConfigured } from './mercadopago.js';

export const SECURITY_MIGRATION_IDS = {
  NORMALIZE_TENANTS: '20261113_01_normalize_tenant_scope',
  POLICY_TRIGGERS: '20261113_02_sqlite_policy_triggers',
  SEAL_EVOLUTION_KEYS: '20261113_03_seal_tenant_evolution_keys',
  EXPIRE_SIM_INVOICES: '20261113_04_expire_sim_invoices_in_prod'
};

const POLICY_TRIGGERS = [
  {
    name: 'trg_users_require_tenant_ins',
    sql: `CREATE TRIGGER IF NOT EXISTS trg_users_require_tenant_ins
      BEFORE INSERT ON users
      FOR EACH ROW
      WHEN NEW.tenant_id IS NULL OR TRIM(NEW.tenant_id) = ''
      BEGIN
        SELECT RAISE(ABORT, 'policy: users.tenant_id cannot be blank');
      END;`
  },
  {
    name: 'trg_users_require_tenant_upd',
    sql: `CREATE TRIGGER IF NOT EXISTS trg_users_require_tenant_upd
      BEFORE UPDATE ON users
      FOR EACH ROW
      WHEN NEW.tenant_id IS NULL OR TRIM(NEW.tenant_id) = ''
      BEGIN
        SELECT RAISE(ABORT, 'policy: users.tenant_id cannot be blank');
      END;`
  },
  {
    name: 'trg_invites_require_tenant_ins',
    sql: `CREATE TRIGGER IF NOT EXISTS trg_invites_require_tenant_ins
      BEFORE INSERT ON invites
      FOR EACH ROW
      WHEN NEW.tenant_id IS NULL OR TRIM(NEW.tenant_id) = ''
      BEGIN
        SELECT RAISE(ABORT, 'policy: invites.tenant_id cannot be blank');
      END;`
  },
  {
    name: 'trg_invites_require_tenant_upd',
    sql: `CREATE TRIGGER IF NOT EXISTS trg_invites_require_tenant_upd
      BEFORE UPDATE ON invites
      FOR EACH ROW
      WHEN NEW.tenant_id IS NULL OR TRIM(NEW.tenant_id) = ''
      BEGIN
        SELECT RAISE(ABORT, 'policy: invites.tenant_id cannot be blank');
      END;`
  },
  {
    name: 'trg_saas_invoices_policy_ins',
    sql: `CREATE TRIGGER IF NOT EXISTS trg_saas_invoices_policy_ins
      BEFORE INSERT ON saas_invoices
      FOR EACH ROW
      WHEN NEW.tenant_id IS NULL OR TRIM(NEW.tenant_id) = '' OR NEW.amount_cents < 0
      BEGIN
        SELECT RAISE(ABORT, 'policy: saas_invoices requires valid tenant_id and non-negative amount');
      END;`
  },
  {
    name: 'trg_saas_invoices_require_tenant_upd',
    sql: `CREATE TRIGGER IF NOT EXISTS trg_saas_invoices_require_tenant_upd
      BEFORE UPDATE ON saas_invoices
      FOR EACH ROW
      WHEN NEW.tenant_id IS NULL OR TRIM(NEW.tenant_id) = '' OR NEW.amount_cents < 0
      BEGIN
        SELECT RAISE(ABORT, 'policy: saas_invoices requires valid tenant_id and non-negative amount');
      END;`
  },
  {
    name: 'trg_saas_invoices_immutable_tenant_upd',
    sql: `CREATE TRIGGER IF NOT EXISTS trg_saas_invoices_immutable_tenant_upd
      BEFORE UPDATE ON saas_invoices
      FOR EACH ROW
      WHEN NEW.tenant_id != OLD.tenant_id
      BEGIN
        SELECT RAISE(ABORT, 'policy: cannot transfer saas_invoices across tenants');
      END;`
  },
  {
    name: 'trg_saas_invoices_protect_paid_status_upd',
    sql: `CREATE TRIGGER IF NOT EXISTS trg_saas_invoices_protect_paid_status_upd
      BEFORE UPDATE ON saas_invoices
      FOR EACH ROW
      WHEN OLD.status = 'paid' AND NEW.status != 'paid'
      BEGIN
        SELECT RAISE(ABORT, 'policy: cannot downgrade a paid invoice');
      END;`
  },
  {
    name: 'trg_saas_invoices_protect_paid_amount_upd',
    sql: `CREATE TRIGGER IF NOT EXISTS trg_saas_invoices_protect_paid_amount_upd
      BEFORE UPDATE ON saas_invoices
      FOR EACH ROW
      WHEN OLD.status = 'paid' AND NEW.amount_cents != OLD.amount_cents
      BEGIN
        SELECT RAISE(ABORT, 'policy: cannot mutate amount of a paid invoice');
      END;`
  },
  {
    name: 'trg_gym_templates_immutable_tenant_upd',
    sql: `CREATE TRIGGER IF NOT EXISTS trg_gym_templates_immutable_tenant_upd
      BEFORE UPDATE ON gym_templates
      FOR EACH ROW
      WHEN NEW.tenant_id != OLD.tenant_id
      BEGIN
        SELECT RAISE(ABORT, 'policy: cannot move gym_templates across tenants');
      END;`
  },
  {
    name: 'trg_tenant_custom_exercises_immutable_tenant_upd',
    sql: `CREATE TRIGGER IF NOT EXISTS trg_tenant_custom_exercises_immutable_tenant_upd
      BEFORE UPDATE ON tenant_custom_exercises
      FOR EACH ROW
      WHEN NEW.tenant_id != OLD.tenant_id
      BEGIN
        SELECT RAISE(ABORT, 'policy: cannot move tenant_custom_exercises across tenants');
      END;`
  },
  {
    name: 'trg_tenant_exercise_overrides_immutable_tenant_upd',
    sql: `CREATE TRIGGER IF NOT EXISTS trg_tenant_exercise_overrides_immutable_tenant_upd
      BEFORE UPDATE ON tenant_exercise_overrides
      FOR EACH ROW
      WHEN NEW.tenant_id != OLD.tenant_id
      BEGIN
        SELECT RAISE(ABORT, 'policy: cannot move tenant_exercise_overrides across tenants');
      END;`
  },
  {
    name: 'trg_whatsapp_outbox_immutable_tenant_upd',
    sql: `CREATE TRIGGER IF NOT EXISTS trg_whatsapp_outbox_immutable_tenant_upd
      BEFORE UPDATE ON whatsapp_outbox
      FOR EACH ROW
      WHEN NEW.tenant_id != OLD.tenant_id
      BEGIN
        SELECT RAISE(ABORT, 'policy: cannot move whatsapp_outbox across tenants');
      END;`
  },
  {
    name: 'trg_api_idempotency_immutable_actor_upd',
    sql: `CREATE TRIGGER IF NOT EXISTS trg_api_idempotency_immutable_actor_upd
      BEFORE UPDATE ON api_idempotency_keys
      FOR EACH ROW
      WHEN OLD.status = 'completed' AND NEW.status = 'completed'
        AND (NEW.actor_id != OLD.actor_id OR NEW.request_hash != OLD.request_hash OR NEW.route != OLD.route)
      BEGIN
        SELECT RAISE(ABORT, 'policy: cannot mutate completed api_idempotency_keys identity');
      END;`
  }
];

function normalizeTenantSlug(tenantId) {
  return String(tenantId || 'default').trim().toLowerCase() || 'default';
}

export function evolutionKeyAad(tenantId) {
  return `tenant:${normalizeTenantSlug(tenantId)}:evolutionApiKey`;
}

export function ensureServerSecret(dataDir) {
  if (!dataDir) throw new Error('migrate-security: dataDir obrigatório');
  fs.mkdirSync(dataDir, { recursive: true });
  const secretFile = path.join(dataDir, 'secret');
  if (fs.existsSync(secretFile)) {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 16) return existing;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

export function sealTenantSecret(plainValue, { tenantId = 'default', dataDir = null, secret = null } = {}) {
  const raw = String(plainValue || '').trim();
  if (!raw) return '';
  const key = deriveKey(secret || ensureServerSecret(dataDir));
  const aad = evolutionKeyAad(tenantId);
  if (raw.startsWith('v1.') && open(key, raw, aad) !== null) {
    return raw;
  }
  return seal(key, raw, aad);
}

export function openTenantSecret(sealedValue, { tenantId = 'default', dataDir = null, secret = null } = {}) {
  if (typeof sealedValue !== 'string') return '';
  const raw = sealedValue.trim();
  if (!raw || !raw.startsWith('v1.')) return '';
  const effectiveSecret = secret || (dataDir && fs.existsSync(path.join(dataDir, 'secret'))
    ? fs.readFileSync(path.join(dataDir, 'secret'), 'utf8').trim()
    : '');
  if (!effectiveSecret || effectiveSecret.length < 16) return '';
  const key = deriveKey(effectiveSecret);
  return open(key, raw, evolutionKeyAad(tenantId)) || '';
}

function isSimulatedPendingRow(row, parsedData) {
  const status = String(parsedData?.status || row?.status || '');
  if (status !== 'pending' && status !== 'checkout_creating') return false;
  const mpId = String(parsedData?.mpPaymentId || row?.mp_payment_id || '');
  return mpId.startsWith('mp_sim_') || parsedData?.simulated === true;
}

function ensureSecurityMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      summary TEXT
    );
  `);
}

function recordMigration(db, id, summaryObj) {
  db.prepare(`
    INSERT INTO security_migrations (id, applied_at, summary)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      applied_at = excluded.applied_at,
      summary = excluded.summary
  `).run(id, Date.now(), JSON.stringify(summaryObj || {}));
}

function normalizeTenantScopeInTx(inst) {
  const { db, cache } = inst;
  let normalizedUsers = 0;
  let normalizedInvites = 0;

  const userRows = db.prepare(`
    SELECT id, tenant_id, data
    FROM users
    WHERE tenant_id IS NULL
       OR TRIM(tenant_id) = ''
       OR tenant_id != TRIM(tenant_id)
       OR json_extract(data, '$.tenantId') = ''
  `).all();

  const updUserStmt = db.prepare('UPDATE users SET tenant_id = ?, data = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();
  for (const row of userRows) {
    let parsed;
    try { parsed = JSON.parse(row.data); } catch { continue; }
    const nextTenantCol = String(row.tenant_id || parsed?.tenantId || '').trim() || 'default';
    if (typeof parsed.tenantId === 'string' && parsed.tenantId.trim() === '') {
      parsed.tenantId = nextTenantCol;
    } else if (typeof parsed.tenantId === 'string') {
      parsed.tenantId = parsed.tenantId.trim();
    }
    const nextJson = JSON.stringify(parsed);
    updUserStmt.run(nextTenantCol, nextJson, now, row.id);
    cache?.users?.set(row.id, nextJson);
    normalizedUsers++;
  }

  const inviteRows = db.prepare(`
    SELECT code, tenant_id, data
    FROM invites
    WHERE tenant_id IS NULL
       OR TRIM(tenant_id) = ''
       OR tenant_id != TRIM(tenant_id)
       OR json_extract(data, '$.tenantId') IS NULL
       OR json_extract(data, '$.tenantId') = ''
  `).all();

  const updInviteStmt = db.prepare('UPDATE invites SET tenant_id = ?, data = ? WHERE code = ?');
  for (const row of inviteRows) {
    let parsed;
    try { parsed = JSON.parse(row.data); } catch { continue; }
    const nextTenantCol = String(row.tenant_id || parsed?.tenantId || '').trim() || 'default';
    parsed.tenantId = nextTenantCol;
    const nextJson = JSON.stringify(parsed);
    updInviteStmt.run(nextTenantCol, nextJson, row.code);
    cache?.invites?.set(row.code, nextJson);
    normalizedInvites++;
  }

  recordMigration(db, SECURITY_MIGRATION_IDS.NORMALIZE_TENANTS, {
    normalizedUsers,
    normalizedInvites
  });
  return { normalizedUsers, normalizedInvites };
}

function installPolicyTriggersInTx(db) {
  db.exec('DROP TRIGGER IF EXISTS trg_api_idempotency_immutable_tenant_upd;');
  for (const trg of POLICY_TRIGGERS) {
    db.exec(trg.sql);
  }
  const existing = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND name LIKE 'trg_%'
  `).all().map(r => r.name);
  recordMigration(db, SECURITY_MIGRATION_IDS.POLICY_TRIGGERS, {
    triggerCount: POLICY_TRIGGERS.length,
    installed: existing.length
  });
  return POLICY_TRIGGERS.length;
}

function sealEvolutionKeysInTx(inst, secret) {
  const { db, stmts } = inst;
  let sealedTenants = 0;
  let scrubbedPlaintext = 0;
  const now = Date.now();

  const tenantRows = db.prepare('SELECT id, data FROM tenants').all();
  const updTenant = db.prepare('UPDATE tenants SET data = ?, updated_at = ? WHERE id = ?');
  const sealedByTenant = new Map();

  for (const row of tenantRows) {
    let tMeta;
    try { tMeta = JSON.parse(row.data); } catch { continue; }
    const settings = tMeta?.settings;
    if (!settings || typeof settings !== 'object') continue;

    const rawPlain = typeof settings.evolutionApiKey === 'string' ? settings.evolutionApiKey.trim() : '';
    const hasPlainField = Object.prototype.hasOwnProperty.call(settings, 'evolutionApiKey');

    if (rawPlain) {
      settings.evolutionApiKeyEnc = sealTenantSecret(rawPlain, { tenantId: row.id, secret });
      sealedByTenant.set(normalizeTenantSlug(row.id), settings.evolutionApiKeyEnc);
      delete settings.evolutionApiKey;
      updTenant.run(JSON.stringify(tMeta), now, row.id);
      sealedTenants++;
      scrubbedPlaintext++;
    } else if (hasPlainField) {
      if (settings.evolutionApiKeyEnc) {
        sealedByTenant.set(normalizeTenantSlug(row.id), settings.evolutionApiKeyEnc);
      }
      delete settings.evolutionApiKey;
      updTenant.run(JSON.stringify(tMeta), now, row.id);
      scrubbedPlaintext++;
    } else if (settings.evolutionApiKeyEnc) {
      sealedByTenant.set(normalizeTenantSlug(row.id), settings.evolutionApiKeyEnc);
    }
  }

  // Mantém o espelho saas_store no kv_store sincronizado sem chave em texto puro
  const kvRow = stmts.getKv.get('saas_store');
  let syncedKv = false;
  if (kvRow) {
    try {
      const store = JSON.parse(kvRow.value);
      if (store?.tenants && typeof store.tenants === 'object') {
        for (const [slug, tRaw] of Object.entries(store.tenants)) {
          if (!tRaw?.settings || typeof tRaw.settings !== 'object') continue;
          const tid = normalizeTenantSlug(tRaw.id || slug);
          const rawPlain = typeof tRaw.settings.evolutionApiKey === 'string' ? tRaw.settings.evolutionApiKey.trim() : '';
          if (rawPlain) {
            tRaw.settings.evolutionApiKeyEnc = sealedByTenant.get(tid) || sealTenantSecret(rawPlain, { tenantId: tid, secret });
            delete tRaw.settings.evolutionApiKey;
            syncedKv = true;
          } else if (Object.prototype.hasOwnProperty.call(tRaw.settings, 'evolutionApiKey')) {
            delete tRaw.settings.evolutionApiKey;
            syncedKv = true;
          }
        }
        if (syncedKv) {
          stmts.setKv.run('saas_store', JSON.stringify(store), now);
          stmts.setKv.run('saas_relational_sync_ts', JSON.stringify(now), now);
        }
      }
    } catch { /* ignore malformed kv */ }
  }

  recordMigration(db, SECURITY_MIGRATION_IDS.SEAL_EVOLUTION_KEYS, {
    sealedTenants,
    scrubbedPlaintext
  });
  return { sealedTenants, scrubbedPlaintext };
}

function expireSimInvoicesInTx(inst, env) {
  const { db, stmts } = inst;
  const isDemo = String(env?.SAAS_DEMO || '') === '1';
  const mpConfigured = isMercadoPagoConfigured(env);
  if (isDemo || mpConfigured) {
    return { skipped: true, expiredSimInvoices: 0 };
  }

  const openRows = db.prepare(`
    SELECT id, tenant_id, status, mp_payment_id, data
    FROM saas_invoices
    WHERE status IN ('pending', 'checkout_creating')
  `).all();

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const updInvoice = db.prepare('UPDATE saas_invoices SET status = ?, data = ? WHERE id = ?');
  const expiredIds = new Set();

  for (const row of openRows) {
    let parsed;
    try { parsed = JSON.parse(row.data); } catch { continue; }
    if (!isSimulatedPendingRow(row, parsed)) continue;
    parsed.status = 'expired';
    parsed.expiredReason = 'sim_disabled_in_prod';
    parsed.expiredAt = nowIso;
    updInvoice.run('expired', JSON.stringify(parsed), row.id);
    expiredIds.add(row.id);
  }

  if (expiredIds.size > 0) {
    const kvRow = stmts.getKv.get('saas_store');
    if (kvRow) {
      try {
        const store = JSON.parse(kvRow.value);
        let touched = false;
        for (const tRaw of Object.values(store?.tenants || {})) {
          if (!Array.isArray(tRaw?.invoices)) continue;
          for (const inv of tRaw.invoices) {
            if (inv && expiredIds.has(inv.id)) {
              inv.status = 'expired';
              inv.expiredReason = 'sim_disabled_in_prod';
              inv.expiredAt = nowIso;
              touched = true;
            }
          }
        }
        if (touched) {
          stmts.setKv.run('saas_store', JSON.stringify(store), now);
          stmts.setKv.run('saas_relational_sync_ts', JSON.stringify(now), now);
        }
      } catch { /* ignore */ }
    }
  }

  recordMigration(db, SECURITY_MIGRATION_IDS.EXPIRE_SIM_INVOICES, {
    expiredSimInvoices: expiredIds.size
  });
  return { skipped: false, expiredSimInvoices: expiredIds.size };
}

function inspectPendingDryRun(dataDir, env) {
  const inst = getSqliteInstance(dataDir);
  const { db } = inst;
  const blankUsers = db.prepare(`
    SELECT COUNT(*) AS cnt FROM users
    WHERE tenant_id IS NULL OR TRIM(tenant_id) = '' OR tenant_id != TRIM(tenant_id) OR json_extract(data, '$.tenantId') = ''
  `).get()?.cnt || 0;
  const blankInvites = db.prepare(`
    SELECT COUNT(*) AS cnt FROM invites
    WHERE tenant_id IS NULL OR TRIM(tenant_id) = '' OR tenant_id != TRIM(tenant_id) OR json_extract(data, '$.tenantId') IS NULL OR json_extract(data, '$.tenantId') = ''
  `).get()?.cnt || 0;

  let plaintextTenants = 0;
  for (const row of db.prepare('SELECT id, data FROM tenants').all()) {
    try {
      const parsed = JSON.parse(row.data);
      if (typeof parsed?.settings?.evolutionApiKey === 'string' && parsed.settings.evolutionApiKey.trim() !== '') {
        plaintextTenants++;
      }
    } catch { /* ignore */ }
  }

  const installedTriggers = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_%'").all().map(r => r.name)
  );
  const missingTriggers = POLICY_TRIGGERS.filter(t => !installedTriggers.has(t.name)).map(t => t.name);

  let pendingSimInvoices = 0;
  if (String(env?.SAAS_DEMO || '') !== '1' && !isMercadoPagoConfigured(env)) {
    for (const row of db.prepare("SELECT id, status, mp_payment_id, data FROM saas_invoices WHERE status IN ('pending', 'checkout_creating')").all()) {
      try {
        const parsed = JSON.parse(row.data);
        if (isSimulatedPendingRow(row, parsed)) pendingSimInvoices++;
      } catch { /* ignore */ }
    }
  }

  return {
    dryRun: true,
    pending: {
      blankUsers,
      blankInvites,
      plaintextTenants,
      missingTriggers,
      pendingSimInvoices
    }
  };
}

/**
 * Executa todas as migrations de segurança de forma atômica e idempotente.
 */
export function runSecurityMigrations({
  dataDir,
  secret = null,
  env = process.env,
  dryRun = false,
  audit = null
} = {}) {
  if (!dataDir) throw new Error('migrate-security: dataDir obrigatório');
  if (dryRun) {
    return inspectPendingDryRun(dataDir, env);
  }

  const effectiveSecret = secret || ensureServerSecret(dataDir);
  const inst = getSqliteInstance(dataDir);
  backfillRelationalTables(inst);

  const summary = runInTransaction(inst, () => {
    ensureSecurityMigrationsTable(inst.db);
    const scope = normalizeTenantScopeInTx(inst);
    const triggersInstalled = installPolicyTriggersInTx(inst.db);
    const sealed = sealEvolutionKeysInTx(inst, effectiveSecret);
    const sim = expireSimInvoicesInTx(inst, env);

    return {
      dryRun: false,
      normalizedUsers: scope.normalizedUsers,
      normalizedInvites: scope.normalizedInvites,
      triggersInstalled,
      sealedTenants: sealed.sealedTenants,
      scrubbedPlaintext: sealed.scrubbedPlaintext,
      expiredSimInvoices: sim.expiredSimInvoices,
      simExpirationSkipped: sim.skipped
    };
  });

  if (audit && (summary.sealedTenants > 0 || summary.expiredSimInvoices > 0 || summary.normalizedUsers > 0 || summary.normalizedInvites > 0)) {
    try { audit('security_migrations_applied', summary); } catch { /* ignore */ }
  }
  return summary;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dirFlagIdx = args.indexOf('--data-dir');
  const rawDir = (dirFlagIdx !== -1 && args[dirFlagIdx + 1])
    ? args[dirFlagIdx + 1]
    : (process.env.DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data'));
  const resolvedDir = path.resolve(rawDir);

  try {
    const result = runSecurityMigrations({ dataDir: resolvedDir, env: process.env, dryRun });
    console.log(JSON.stringify({ ok: true, dataDir: resolvedDir, ...result }, null, 2));
  } finally {
    closeSqliteInstance(resolvedDir);
  }
}
