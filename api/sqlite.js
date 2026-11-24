/**
 * api/sqlite.js
 *
 * Camada Oficial de Banco de Dados SQLite (WAL Mode) para o Ecossistema Rit.
 * Utiliza o módulo nativo `node:sqlite` (DatabaseSync + backup online) do Node.js.
 *
 * Substitui integralmente os antigos arquivos JSON (`db.json`, `saas.json`,
 * `state-*.json`, `branding.json`, `templates.json`, `whatsapp-outbox.json`)
 * por tabelas relacionais e documentos indexados com suporte a alta concorrência
 * (Write-Ahead Logging), transações ACID e backup quente automático diário.
 */

import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dbInstances = new Map(); // resolvedDataDir -> { db, stmts, lastBackupDate }

function resolveBaseDir(dirOrTenantDir) {
  if (!dirOrTenantDir) return path.resolve(process.env.DATA_DIR || './data');
  const resolved = path.resolve(String(dirOrTenantDir));
  // Se recebeu um caminho de subpasta de tenant (`.../data/tenants/ironpower`), sobe para o `baseDataDir` (`.../data`)
  const parts = resolved.split(path.sep);
  const tenantsIdx = parts.lastIndexOf('tenants');
  if (tenantsIdx > 0 && tenantsIdx === parts.length - 2) {
    return parts.slice(0, tenantsIdx).join(path.sep);
  }
  return resolved;
}

export function extractTenantIdFromPath(dirOrTenantId) {
  if (!dirOrTenantId) return 'default';
  const s = String(dirOrTenantId);
  const normalized = s.replace(/\\/g, '/').replace(/\/+$/, '');
  const m = normalized.match(/\/tenants\/([a-z0-9_-]+)$/i);
  if (m) return m[1].toLowerCase();
  if (!normalized.includes('/') && /^[a-z0-9_-]+$/i.test(normalized)) {
    return normalized.toLowerCase();
  }
  return 'default';
}

/**
 * Inicializa (ou retorna do pool) a conexão SQLite em modo WAL para o diretório de dados.
 */
export function getSqliteInstance(dirOrTenantDir) {
  const baseDir = resolveBaseDir(dirOrTenantDir);
  if (dbInstances.has(baseDir)) {
    return dbInstances.get(baseDir);
  }

  fs.mkdirSync(baseDir, { recursive: true });
  const dbPath = path.join(baseDir, 'rit.db');
  const db = new DatabaseSync(dbPath);

  // Otimizações de alta concorrência e performance para horário de pico em academias
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -16000;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      email TEXT,
      name TEXT,
      role TEXT,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
      ON users(lower(trim(email)))
      WHERE email IS NOT NULL AND trim(email) != '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_name_pw_unique
      ON users(tenant_id, lower(trim(name)))
      WHERE name IS NOT NULL AND trim(name) != '' AND json_extract(data, '$.pw.h') IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_gym_owner
      ON users(tenant_id)
      WHERE json_extract(data, '$.saasRole') = 'gym_owner';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_superadmin
      ON users((1))
      WHERE json_extract(data, '$.saasRole') = 'superadmin';

    CREATE TABLE IF NOT EXISTS creds (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_creds_user ON creds(user_id);

    CREATE TABLE IF NOT EXISTS subs (
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subs_user ON subs(user_id);

    CREATE TABLE IF NOT EXISTS invites (
      code TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_invites_tenant ON invites(tenant_id);

    CREATE TABLE IF NOT EXISTS device_links (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS watch_links (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_states (
      user_id TEXT PRIMARY KEY,
      rev INTEGER NOT NULL DEFAULT 0,
      wid TEXT,
      updated_at INTEGER NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS watch_boxes (
      user_id TEXT PRIMARY KEY,
      updated_at INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      plan_id TEXT,
      status TEXT,
      data TEXT NOT NULL,
      branding TEXT NOT NULL DEFAULT '{}',
      templates TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saas_plans (
      id TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saas_invoices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      plan_id TEXT,
      kind TEXT NOT NULL DEFAULT 'invoice',
      amount_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      method TEXT,
      mp_payment_id TEXT,
      idempotency_key TEXT,
      created_at INTEGER NOT NULL,
      paid_at INTEGER,
      expires_at INTEGER,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_saas_invoices_tenant ON saas_invoices(tenant_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saas_invoices_mp_payment
      ON saas_invoices(mp_payment_id)
      WHERE mp_payment_id IS NOT NULL AND mp_payment_id != '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saas_invoices_idem
      ON saas_invoices(idempotency_key)
      WHERE idempotency_key IS NOT NULL AND idempotency_key != '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saas_invoices_open_checkout
      ON saas_invoices(tenant_id, plan_id)
      WHERE kind = 'pix_checkout' AND status IN ('checkout_creating', 'pending');

    CREATE TABLE IF NOT EXISTS gym_templates (
      tenant_id TEXT NOT NULL,
      id TEXT NOT NULL,
      default_key TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_gym_templates_tenant ON gym_templates(tenant_id, sort_order ASC, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gym_templates_default
      ON gym_templates(tenant_id, default_key)
      WHERE default_key IS NOT NULL AND default_key != '';

    CREATE TABLE IF NOT EXISTS whatsapp_outbox (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      dedup_key TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      locked_at INTEGER,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wa_outbox_ready ON whatsapp_outbox(status, next_attempt_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_outbox_dedup
      ON whatsapp_outbox(dedup_key)
      WHERE dedup_key IS NOT NULL AND dedup_key != '';

    CREATE TABLE IF NOT EXISTS coach_daily_usage (
      user_id TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'mercadopago',
      action_type TEXT,
      resource_id TEXT,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      locked_at INTEGER,
      received_at INTEGER NOT NULL,
      processed_at INTEGER,
      raw_payload TEXT NOT NULL,
      result_json TEXT,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_events_due
      ON webhook_events(status, next_attempt_at);

    CREATE TABLE IF NOT EXISTS api_idempotency_keys (
      scope_key TEXT PRIMARY KEY,
      client_key TEXT NOT NULL,
      route TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_flight',
      response_status INTEGER,
      response_body TEXT,
      gateway_idempotency_key TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_api_idem_expires
      ON api_idempotency_keys(expires_at);

    CREATE TABLE IF NOT EXISTS tenant_exercise_overrides (
      tenant_id TEXT NOT NULL,
      exercise_id TEXT NOT NULL,
      media_json TEXT,
      url TEXT,
      note TEXT,
      updated_by TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, exercise_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_ex_ov_tenant
      ON tenant_exercise_overrides(tenant_id);

    CREATE TABLE IF NOT EXISTS tenant_custom_exercises (
      tenant_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      bp TEXT NOT NULL DEFAULT 'other',
      tg TEXT NOT NULL DEFAULT 'other',
      eq TEXT NOT NULL DEFAULT 'other',
      description TEXT,
      media_json TEXT,
      url TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_tenant_custom_ex_tenant
      ON tenant_custom_exercises(tenant_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS mobile_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tag TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '#/',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mobile_notif_user_id
      ON mobile_notifications(user_id, id);

    CREATE TABLE IF NOT EXISTS auth_verifications (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      phone TEXT,
      user_id TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_verifications_email
      ON auth_verifications(email, purpose, expires_at);
  `);

  // Evolução idempotente da tabela invites
  const inviteCols = new Set(db.prepare('PRAGMA table_info(invites)').all().map(c => c.name));
  if (!inviteCols.has('used_by')) db.exec('ALTER TABLE invites ADD COLUMN used_by TEXT');
  if (!inviteCols.has('used_at')) db.exec('ALTER TABLE invites ADD COLUMN used_at INTEGER');
  if (!inviteCols.has('revoked')) db.exec('ALTER TABLE invites ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0');

  const stmts = {
    getKv: db.prepare('SELECT value FROM kv_store WHERE key = ?'),
    setKv: db.prepare(`
      INSERT INTO kv_store (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `),
    deleteKv: db.prepare('DELETE FROM kv_store WHERE key = ?'),
    getAllUsers: db.prepare('SELECT id, data FROM users ORDER BY rowid ASC'),
    getUserIds: db.prepare('SELECT id FROM users'),
    getUser: db.prepare('SELECT data FROM users WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    clearUsers: db.prepare('DELETE FROM users'),
    upsertUser: db.prepare(`
      INSERT INTO users (id, tenant_id, email, name, role, data, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        email = excluded.email,
        name = excluded.name,
        role = excluded.role,
        data = excluded.data,
        updated_at = excluded.updated_at
    `),
    getAllCreds: db.prepare('SELECT id, data FROM creds ORDER BY rowid ASC'),
    getCredIds: db.prepare('SELECT id FROM creds'),
    deleteCred: db.prepare('DELETE FROM creds WHERE id = ?'),
    clearCreds: db.prepare('DELETE FROM creds'),
    upsertCred: db.prepare(`
      INSERT INTO creds (id, user_id, data)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, data = excluded.data
    `),
    getAllSubs: db.prepare('SELECT endpoint, data FROM subs ORDER BY rowid ASC'),
    getSubEndpoints: db.prepare('SELECT endpoint FROM subs'),
    deleteSub: db.prepare('DELETE FROM subs WHERE endpoint = ?'),
    clearSubs: db.prepare('DELETE FROM subs'),
    upsertSub: db.prepare(`
      INSERT INTO subs (endpoint, user_id, data)
      VALUES (?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, data = excluded.data
    `),
    getAllInvites: db.prepare('SELECT code, data FROM invites ORDER BY rowid ASC'),
    getInviteCodes: db.prepare('SELECT code FROM invites'),
    deleteInvite: db.prepare('DELETE FROM invites WHERE code = ?'),
    clearInvites: db.prepare('DELETE FROM invites'),
    upsertInvite: db.prepare(`
      INSERT INTO invites (code, tenant_id, used_by, used_at, revoked, data)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        used_by = excluded.used_by,
        used_at = excluded.used_at,
        revoked = excluded.revoked,
        data = excluded.data
    `),
    getInvite: db.prepare('SELECT code, tenant_id, used_by, used_at, revoked, data FROM invites WHERE code = ?'),
    consumeInviteConditional: db.prepare(`
      UPDATE invites
      SET used_by = ?, used_at = ?, data = ?
      WHERE code = ? AND used_by IS NULL AND COALESCE(revoked, 0) = 0
    `),
    consumeDeviceLinkByHashOrId: db.prepare(`
      DELETE FROM device_links
      WHERE id = ? OR json_extract(data, '$.h') = ? OR json_extract(data, '$.hash') = ?
      RETURNING id, user_id, data
    `),
    consumeWatchLinkByHashOrId: db.prepare(`
      DELETE FROM watch_links
      WHERE id = ? OR json_extract(data, '$.h') = ? OR json_extract(data, '$.hash') = ?
      RETURNING id, user_id, data
    `),
    casInsertState: db.prepare(`
      INSERT INTO user_states (user_id, rev, wid, updated_at, size, data)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO NOTHING
    `),
    casUpdateState: db.prepare(`
      UPDATE user_states
      SET rev = ?, wid = ?, updated_at = ?, size = ?, data = ?
      WHERE user_id = ? AND rev = ?
    `),
    getKvWithMeta: db.prepare('SELECT value, updated_at FROM kv_store WHERE key = ?'),
    getKvByPrefix: db.prepare('SELECT key, value, updated_at FROM kv_store WHERE key LIKE ?'),
    countSaasPlans: db.prepare('SELECT COUNT(*) AS cnt FROM saas_plans'),
    getAllSaasPlans: db.prepare('SELECT id, sort_order, data, updated_at FROM saas_plans ORDER BY sort_order ASC, rowid ASC'),
    upsertSaasPlanRow: db.prepare(`
      INSERT INTO saas_plans (id, sort_order, data, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        sort_order = excluded.sort_order,
        data = excluded.data,
        updated_at = excluded.updated_at
    `),
    clearSaasPlans: db.prepare('DELETE FROM saas_plans'),
    getTenantInvoices: db.prepare('SELECT * FROM saas_invoices WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC'),
    getInvoiceById: db.prepare('SELECT * FROM saas_invoices WHERE id = ?'),
    getInvoiceByMpPayment: db.prepare('SELECT * FROM saas_invoices WHERE mp_payment_id = ?'),
    getInvoiceByIdem: db.prepare('SELECT * FROM saas_invoices WHERE idempotency_key = ?'),
    getOpenCheckout: db.prepare(`
      SELECT * FROM saas_invoices
      WHERE tenant_id = ? AND plan_id = ? AND kind = 'pix_checkout' AND status IN ('checkout_creating', 'pending')
      LIMIT 1
    `),
    expireStaleOpenCheckouts: db.prepare(`
      UPDATE saas_invoices
      SET status = 'expired', data = json_set(data, '$.status', 'expired')
      WHERE tenant_id = ? AND plan_id = ? AND kind = 'pix_checkout' AND status = 'pending'
        AND expires_at IS NOT NULL AND expires_at <= ?
    `),
    insertInvoiceIgnore: db.prepare(`
      INSERT OR IGNORE INTO saas_invoices (
        id, tenant_id, plan_id, kind, amount_cents, status, method,
        mp_payment_id, idempotency_key, created_at, paid_at, expires_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    upsertInvoiceRow: db.prepare(`
      INSERT INTO saas_invoices (
        id, tenant_id, plan_id, kind, amount_cents, status, method,
        mp_payment_id, idempotency_key, created_at, paid_at, expires_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        plan_id = excluded.plan_id,
        kind = excluded.kind,
        amount_cents = excluded.amount_cents,
        status = excluded.status,
        method = excluded.method,
        mp_payment_id = excluded.mp_payment_id,
        idempotency_key = excluded.idempotency_key,
        paid_at = excluded.paid_at,
        expires_at = excluded.expires_at,
        data = excluded.data
    `),
    markInvoicePaidConditional: db.prepare(`
      UPDATE saas_invoices
      SET
        status = 'paid',
        paid_at = ?,
        mp_payment_id = COALESCE(?, mp_payment_id),
        method = COALESCE(?, method),
        plan_id = COALESCE(?, plan_id),
        amount_cents = ?,
        data = ?
      WHERE id = ? AND status NOT IN ('paid', 'refunded', 'charged_back')
    `),
    deleteTenantInvoices: db.prepare('DELETE FROM saas_invoices WHERE tenant_id = ?'),
    countTenantTemplates: db.prepare('SELECT COUNT(*) AS cnt FROM gym_templates WHERE tenant_id = ?'),
    getTenantTemplates: db.prepare('SELECT id, default_key, sort_order, data, created_at, updated_at FROM gym_templates WHERE tenant_id = ? ORDER BY sort_order ASC, rowid ASC'),
    insertTemplateIgnore: db.prepare(`
      INSERT OR IGNORE INTO gym_templates (tenant_id, id, default_key, sort_order, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    upsertTemplateRow: db.prepare(`
      INSERT INTO gym_templates (tenant_id, id, default_key, sort_order, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, id) DO UPDATE SET
        default_key = COALESCE(excluded.default_key, gym_templates.default_key),
        sort_order = excluded.sort_order,
        data = excluded.data,
        updated_at = excluded.updated_at
    `),
    deleteTemplateRow: db.prepare('DELETE FROM gym_templates WHERE tenant_id = ? AND id = ?'),
    clearTenantTemplates: db.prepare('DELETE FROM gym_templates WHERE tenant_id = ?'),
    countOutboxAll: db.prepare('SELECT COUNT(*) AS cnt FROM whatsapp_outbox'),
    getOutboxPending: db.prepare("SELECT * FROM whatsapp_outbox WHERE status IN ('pending', 'processing') ORDER BY created_at DESC, rowid DESC"),
    getOutboxHistory: db.prepare("SELECT * FROM whatsapp_outbox WHERE status IN ('sent', 'failed', 'cancelled') ORDER BY COALESCE(completed_at, created_at) DESC, rowid DESC LIMIT ?"),
    getOutboxReady: db.prepare("SELECT * FROM whatsapp_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT ?"),
    claimOutboxItem: db.prepare(`
      UPDATE whatsapp_outbox
      SET status = 'processing', locked_at = ?
      WHERE id = ? AND status = 'pending'
      RETURNING *
    `),
    reclaimStaleOutboxLocks: db.prepare(`
      UPDATE whatsapp_outbox
      SET status = 'pending', locked_at = NULL
      WHERE status = 'processing' AND locked_at IS NOT NULL AND locked_at <= ?
    `),
    insertOutboxIgnore: db.prepare(`
      INSERT OR IGNORE INTO whatsapp_outbox (
        id, tenant_id, kind, status, dedup_key, attempts,
        next_attempt_at, locked_at, created_at, completed_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    upsertOutboxRow: db.prepare(`
      INSERT INTO whatsapp_outbox (
        id, tenant_id, kind, status, dedup_key, attempts,
        next_attempt_at, locked_at, created_at, completed_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        attempts = excluded.attempts,
        next_attempt_at = excluded.next_attempt_at,
        locked_at = excluded.locked_at,
        completed_at = excluded.completed_at,
        data = excluded.data
    `),
    deleteOutboxRow: db.prepare('DELETE FROM whatsapp_outbox WHERE id = ?'),
    deleteTenantOutbox: db.prepare('DELETE FROM whatsapp_outbox WHERE tenant_id = ?'),
    clearOutbox: db.prepare('DELETE FROM whatsapp_outbox'),
    getCoachDaily: db.prepare('SELECT count FROM coach_daily_usage WHERE user_id = ? AND day = ?'),
    ensureCoachDaily: db.prepare('INSERT OR IGNORE INTO coach_daily_usage (user_id, day, count) VALUES (?, ?, 0)'),
    bumpCoachDailyConditional: db.prepare(`
      UPDATE coach_daily_usage
      SET count = count + 1
      WHERE user_id = ? AND day = ? AND (? IS NULL OR count < ?)
      RETURNING count
    `),
    decrementCoachDaily: db.prepare(`
      UPDATE coach_daily_usage
      SET count = MAX(0, count - 1)
      WHERE user_id = ? AND day = ?
      RETURNING count
    `),
    getAllDeviceLinks: db.prepare('SELECT id, data FROM device_links ORDER BY rowid ASC'),
    getDeviceLinkIds: db.prepare('SELECT id FROM device_links'),
    deleteDeviceLink: db.prepare('DELETE FROM device_links WHERE id = ?'),
    clearDeviceLinks: db.prepare('DELETE FROM device_links'),
    upsertDeviceLink: db.prepare(`
      INSERT INTO device_links (id, user_id, data)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, data = excluded.data
    `),
    getAllWatchLinks: db.prepare('SELECT id, data FROM watch_links ORDER BY rowid ASC'),
    getWatchLinkIds: db.prepare('SELECT id FROM watch_links'),
    deleteWatchLink: db.prepare('DELETE FROM watch_links WHERE id = ?'),
    clearWatchLinks: db.prepare('DELETE FROM watch_links'),
    upsertWatchLink: db.prepare(`
      INSERT INTO watch_links (id, user_id, data)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, data = excluded.data
    `),
    getState: db.prepare('SELECT data, rev, wid, updated_at, size FROM user_states WHERE user_id = ?'),
    getStateMeta: db.prepare('SELECT rev, wid, updated_at, size FROM user_states WHERE user_id = ?'),
    upsertState: db.prepare(`
      INSERT INTO user_states (user_id, rev, wid, updated_at, size, data)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        rev = excluded.rev,
        wid = excluded.wid,
        updated_at = excluded.updated_at,
        size = excluded.size,
        data = excluded.data
    `),
    deleteState: db.prepare('DELETE FROM user_states WHERE user_id = ?'),
    getWatchBox: db.prepare('SELECT data FROM watch_boxes WHERE user_id = ?'),
    upsertWatchBox: db.prepare(`
      INSERT INTO watch_boxes (user_id, updated_at, data)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data
    `),
    deleteWatchBox: db.prepare('DELETE FROM watch_boxes WHERE user_id = ?'),
    getTenantRow: db.prepare('SELECT id, plan_id, status, data, branding, templates, updated_at FROM tenants WHERE id = ?'),
    getAllTenants: db.prepare('SELECT id, plan_id, status, data, branding, templates, updated_at FROM tenants'),
    upsertTenantRow: db.prepare(`
      INSERT INTO tenants (id, plan_id, status, data, branding, templates, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        plan_id = excluded.plan_id,
        status = excluded.status,
        data = excluded.data,
        branding = excluded.branding,
        templates = excluded.templates,
        updated_at = excluded.updated_at
    `),
    deleteTenantRow: db.prepare('DELETE FROM tenants WHERE id = ?'),
    getWebhookEvent: db.prepare('SELECT * FROM webhook_events WHERE event_id = ?'),
    insertWebhookEventIgnore: db.prepare(`
      INSERT OR IGNORE INTO webhook_events (
        event_id, provider, action_type, resource_id, payload_hash,
        status, attempts, next_attempt_at, locked_at, received_at,
        processed_at, raw_payload, result_json, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getDueWebhookEvents: db.prepare(`
      SELECT * FROM webhook_events
      WHERE status = 'queued' AND next_attempt_at <= ?
      ORDER BY received_at ASC, rowid ASC
      LIMIT ?
    `),
    claimWebhookEvent: db.prepare(`
      UPDATE webhook_events
      SET status = 'processing', locked_at = ?
      WHERE event_id = ? AND status = 'queued'
      RETURNING *
    `),
    reclaimStaleWebhookLocks: db.prepare(`
      UPDATE webhook_events
      SET status = 'queued', locked_at = NULL
      WHERE status = 'processing' AND locked_at IS NOT NULL AND locked_at <= ?
    `),
    updateWebhookEventOutcome: db.prepare(`
      UPDATE webhook_events
      SET
        status = ?,
        attempts = ?,
        next_attempt_at = ?,
        locked_at = NULL,
        processed_at = ?,
        result_json = ?,
        last_error = ?
      WHERE event_id = ?
    `),
    countPendingWebhookEvents: db.prepare(`
      SELECT COUNT(*) AS cnt FROM webhook_events WHERE status IN ('queued', 'processing')
    `),
    reactivateFailedCheckoutInvoice: db.prepare(`
      UPDATE saas_invoices
      SET status = 'checkout_creating', created_at = ?, expires_at = ?
      WHERE id = ? AND status IN ('failed', 'expired', 'cancelled')
      RETURNING *
    `),
    getApiIdempotencyKey: db.prepare('SELECT * FROM api_idempotency_keys WHERE scope_key = ?'),
    insertApiIdempotencyIgnore: db.prepare(`
      INSERT OR IGNORE INTO api_idempotency_keys (
        scope_key, client_key, route, actor_id, request_hash,
        status, response_status, response_body, gateway_idempotency_key,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, 'in_flight', NULL, NULL, ?, ?, ?, ?)
    `),
    replaceExpiredApiIdempotency: db.prepare(`
      UPDATE api_idempotency_keys
      SET
        client_key = ?,
        route = ?,
        actor_id = ?,
        request_hash = ?,
        status = 'in_flight',
        response_status = NULL,
        response_body = NULL,
        gateway_idempotency_key = ?,
        created_at = ?,
        updated_at = ?,
        expires_at = ?
      WHERE scope_key = ? AND (expires_at <= ? OR (status = 'in_flight' AND updated_at <= ?))
      RETURNING *
    `),
    claimRetryableApiIdempotency: db.prepare(`
      UPDATE api_idempotency_keys
      SET status = 'in_flight', updated_at = ?
      WHERE scope_key = ? AND status = 'retryable' AND request_hash = ?
      RETURNING *
    `),
    completeApiIdempotency: db.prepare(`
      UPDATE api_idempotency_keys
      SET
        status = 'completed',
        response_status = ?,
        response_body = ?,
        updated_at = ?
      WHERE scope_key = ?
    `),
    markApiIdempotencyRetryable: db.prepare(`
      UPDATE api_idempotency_keys
      SET status = 'retryable', updated_at = ?
      WHERE scope_key = ? AND status = 'in_flight'
    `),
    deleteApiIdempotencyKey: db.prepare('DELETE FROM api_idempotency_keys WHERE scope_key = ?'),
    pruneExpiredApiIdempotency: db.prepare('DELETE FROM api_idempotency_keys WHERE expires_at < ?'),
    listTenantExerciseOverrides: db.prepare(`
      SELECT exercise_id, media_json, url, note, updated_by, updated_at
      FROM tenant_exercise_overrides
      WHERE tenant_id = ?
      ORDER BY updated_at DESC
    `),
    getTenantExerciseOverride: db.prepare(`
      SELECT exercise_id, media_json, url, note, updated_by, updated_at
      FROM tenant_exercise_overrides
      WHERE tenant_id = ? AND exercise_id = ?
    `),
    upsertTenantExerciseOverride: db.prepare(`
      INSERT INTO tenant_exercise_overrides (tenant_id, exercise_id, media_json, url, note, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, exercise_id) DO UPDATE SET
        media_json = excluded.media_json,
        url = excluded.url,
        note = excluded.note,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `),
    deleteTenantExerciseOverride: db.prepare(`
      DELETE FROM tenant_exercise_overrides WHERE tenant_id = ? AND exercise_id = ?
    `),
    deleteAllTenantExerciseOverrides: db.prepare(`
      DELETE FROM tenant_exercise_overrides WHERE tenant_id = ?
    `),
    listTenantCustomExercises: db.prepare(`
      SELECT id, data, created_at, updated_at
      FROM tenant_custom_exercises
      WHERE tenant_id = ?
      ORDER BY updated_at DESC
    `),
    getTenantCustomExercise: db.prepare(`
      SELECT id, data, created_at, updated_at
      FROM tenant_custom_exercises
      WHERE tenant_id = ? AND id = ?
    `),
    upsertTenantCustomExercise: db.prepare(`
      INSERT INTO tenant_custom_exercises (
        tenant_id, id, name, bp, tg, eq, description, media_json, url,
        created_by, created_at, updated_at, data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, id) DO UPDATE SET
        name = excluded.name,
        bp = excluded.bp,
        tg = excluded.tg,
        eq = excluded.eq,
        description = excluded.description,
        media_json = excluded.media_json,
        url = excluded.url,
        updated_at = excluded.updated_at,
        data = excluded.data
    `),
    deleteTenantCustomExercise: db.prepare(`
      DELETE FROM tenant_custom_exercises WHERE tenant_id = ? AND id = ?
    `),
    deleteAllTenantCustomExercises: db.prepare(`
      DELETE FROM tenant_custom_exercises WHERE tenant_id = ?
    `),
    insertMobileNotif: db.prepare(`
      INSERT INTO mobile_notifications (user_id, title, body, tag, url, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    pruneExpiredMobileNotif: db.prepare(`
      DELETE FROM mobile_notifications WHERE created_at < ?
    `),
    pruneUserMobileNotif: db.prepare(`
      DELETE FROM mobile_notifications
      WHERE user_id = ? AND id NOT IN (
        SELECT id FROM mobile_notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50
      )
    `),
    latestMobileNotifId: db.prepare(`
      SELECT COALESCE(MAX(id), 0) AS latest_id FROM mobile_notifications WHERE user_id = ?
    `),
    listMobileNotifSince: db.prepare(`
      SELECT id, title, body, tag, url, created_at
      FROM mobile_notifications
      WHERE user_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `),
    listMobileNotifRecent: db.prepare(`
      SELECT id, title, body, tag, url, created_at
      FROM mobile_notifications
      WHERE user_id = ? AND created_at >= ?
      ORDER BY id ASC
      LIMIT ?
    `),
    deleteUserMobileNotif: db.prepare(`
      DELETE FROM mobile_notifications WHERE user_id = ?
    `),
    upsertAuthVerification: db.prepare(`
      INSERT INTO auth_verifications (
        id, email, phone, user_id, tenant_id, purpose, code_hash, attempts, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        phone = excluded.phone,
        user_id = excluded.user_id,
        tenant_id = excluded.tenant_id,
        purpose = excluded.purpose,
        code_hash = excluded.code_hash,
        attempts = excluded.attempts,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
    `),
    supersedeAuthVerifications: db.prepare(`
      UPDATE auth_verifications
      SET expires_at = 0
      WHERE email = ? AND purpose = ? AND id != ? AND expires_at > 0
    `),
    countAuthVerificationsByEmail: db.prepare(`
      SELECT COUNT(*) AS cnt, MIN(created_at) AS oldest_at
      FROM auth_verifications
      WHERE email = ? AND purpose = ? AND created_at > ?
    `),
    countAuthVerificationsByPhone: db.prepare(`
      SELECT COUNT(*) AS cnt, MIN(created_at) AS oldest_at
      FROM auth_verifications
      WHERE phone = ? AND purpose = ? AND created_at > ?
    `),
    getAuthVerification: db.prepare(`
      SELECT id, email, phone, user_id, tenant_id, purpose, code_hash, attempts, expires_at, created_at
      FROM auth_verifications
      WHERE id = ?
    `),
    incrementAuthVerificationAttempts: db.prepare(`
      UPDATE auth_verifications
      SET attempts = attempts + 1
      WHERE id = ?
      RETURNING attempts
    `),
    deleteAuthVerification: db.prepare(`
      DELETE FROM auth_verifications WHERE id = ?
    `),
    pruneExpiredAuthVerifications: db.prepare(`
      DELETE FROM auth_verifications WHERE expires_at <= ? AND created_at <= ?
    `),
    deleteUserAuthVerifications: db.prepare(`
      DELETE FROM auth_verifications WHERE user_id = ? OR (email != '' AND email = ?)
    `),
    deleteUserWhatsappOutbox: db.prepare(`
      DELETE FROM whatsapp_outbox WHERE (? != '' AND json_extract(data, '$.phone') = ?) OR dedup_key LIKE ?
    `)
  };

  const cache = {
    users: new Map(),
    creds: new Map(),
    subs: new Map(),
    invites: new Map(),
    deviceLinks: new Map(),
    watches: new Map(),
    extra: null
  };

  const instance = { db, stmts, cache, baseDir, dbPath, lastBackupDate: null, txDepth: 0, spSeq: 0 };
  dbInstances.set(baseDir, instance);

  // Migra automaticamente arquivos JSON legados encontrados no diretório e os remove após confirmar no SQLite
  migrateLegacyJsonIfPresent(instance);
  backfillRelationalTables(instance);

  return instance;
}

/**
 * Executa uma função dentro de uma transação SQLite (`BEGIN IMMEDIATE ... COMMIT`).
 * Suporta aninhamento transparente usando `SAVEPOINT`.
 */
export function runInTransaction(instance, fn) {
  if (instance.txDepth > 0) {
    const sp = `sp_${++instance.spSeq}`;
    instance.db.exec(`SAVEPOINT ${sp}`);
    instance.txDepth++;
    try {
      const res = fn();
      instance.db.exec(`RELEASE SAVEPOINT ${sp}`);
      return res;
    } catch (err) {
      try {
        instance.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
        instance.db.exec(`RELEASE SAVEPOINT ${sp}`);
      } catch { /* ignore */ }
      throw err;
    } finally {
      instance.txDepth--;
    }
  }

  instance.db.exec('BEGIN IMMEDIATE');
  instance.txDepth = 1;
  try {
    const res = fn();
    instance.db.exec('COMMIT');
    return res;
  } catch (err) {
    try { instance.db.exec('ROLLBACK'); } catch { /* ignore */ }
    // Evita cache desincronizado com o banco após rollback
    if (instance.cache) {
      instance.cache.users?.clear();
      instance.cache.creds?.clear();
      instance.cache.subs?.clear();
      instance.cache.invites?.clear();
      instance.cache.deviceLinks?.clear();
      instance.cache.watches?.clear();
      instance.cache.extra = null;
    }
    throw err;
  } finally {
    instance.txDepth = 0;
  }
}

/**
 * Migra arquivos JSON legados (`db.json`, `saas.json`, `state-*.json`, `tenants/*`, `whatsapp-outbox.json`)
 * para o banco SQLite e remove os JSONs antigos para manter 100% em SQLite.
 */
function migrateLegacyJsonIfPresent(instance) {
  const { baseDir, stmts } = instance;
  const legacyDbFile = path.join(baseDir, 'db.json');
  const legacySaasFile = path.join(baseDir, 'saas.json');
  const legacyOutboxFile = path.join(baseDir, 'whatsapp-outbox.json');

  // 1. Migra db.json somente se o banco SQLite estiver vazio ou se db.json tiver sido editado externamente (hash diferente do último espelho gravado pelo SQLite)
  if (fs.existsSync(legacyDbFile)) {
    const raw = fs.readFileSync(legacyDbFile, 'utf8');
    let parsed = null;
    let validJson = false;
    try {
      parsed = JSON.parse(raw);
      validJson = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
      validJson = false;
    }

    const lastMirrorSha = stmts.getKv.get('db_json_mirror_sha')?.value || '';
    const hasUsersInSqlite = (stmts.getUserIds.all()?.length || 0) > 0;

    if (validJson) {
      try {
        const rawSha = crypto.createHash('sha256').update(raw).digest('hex');
        if (!hasUsersInSqlite || (lastMirrorSha !== 'SQLITE_AHEAD' && rawSha !== lastMirrorSha)) {
          saveCoreDbToSqlite(baseDir, parsed);
        }
      } catch (e) {
        console.warn('[SQLite Migration] Aviso ao migrar db.json:', e.message);
      }
    } else {
      const stamp = Date.now();
      try { fs.copyFileSync(legacyDbFile, path.join(baseDir, `db.json.unreadable-${stamp}`)); } catch { /* ignore */ }
      const bakPath = legacyDbFile + '.bak';
      let bakParsed = null;
      if (fs.existsSync(bakPath)) {
        try {
          const b = JSON.parse(fs.readFileSync(bakPath, 'utf8'));
          if (b && typeof b === 'object' && !Array.isArray(b)) bakParsed = b;
        } catch { /* unreadable backup */ }
      }
      if (!hasUsersInSqlite && bakParsed) {
        console.error('db.json unreadable; using db.json.bak');
        saveCoreDbToSqlite(baseDir, bakParsed);
      } else if (hasUsersInSqlite || lastMirrorSha) {
        console.error(bakParsed ? 'db.json unreadable; using db.json.bak / rit.db' : 'db.json unreadable; continuing from rit.db');
      } else {
        console.error('Refusing to start: db.json is unreadable and no backup exists');
        try { instance.db.close(); } catch { /* ignore */ }
        dbInstances.delete(baseDir);
        process.exit(1);
      }
    }
  }

  // 2. Migra saas.json e pastas tenants/*
  if (fs.existsSync(legacySaasFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(legacySaasFile, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        stmts.setKv.run('saas_store', JSON.stringify(parsed), Date.now());
      }
      try { fs.unlinkSync(legacySaasFile); } catch { /* ignore */ }
    } catch (e) {
      console.warn('[SQLite Migration] Aviso ao migrar saas.json:', e.message);
    }
  }

  const tenantsRoot = path.join(baseDir, 'tenants');
  if (fs.existsSync(tenantsRoot)) {
    try {
      for (const ent of fs.readdirSync(tenantsRoot, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const slug = ent.name;
        const tDir = path.join(tenantsRoot, slug);
        const bFile = path.join(tDir, 'branding.json');
        const tplFile = path.join(tDir, 'templates.json');
        const tDbFile = path.join(tDir, 'db.json');

        if (fs.existsSync(bFile)) {
          try {
            const bData = JSON.parse(fs.readFileSync(bFile, 'utf8'));
            stmts.setKv.run(`branding:${slug}`, JSON.stringify(bData), Date.now());
            fs.unlinkSync(bFile);
          } catch { /* ignore */ }
        }
        if (fs.existsSync(tplFile)) {
          try {
            const tplData = JSON.parse(fs.readFileSync(tplFile, 'utf8'));
            stmts.setKv.run(`templates:${slug}`, JSON.stringify(tplData), Date.now());
            fs.unlinkSync(tplFile);
          } catch { /* ignore */ }
        }
        if (fs.existsSync(tDbFile)) {
          try { fs.unlinkSync(tDbFile); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  // 3. Migra state-*.json e watch-*.json
  try {
    for (const file of fs.readdirSync(baseDir)) {
      if (file.startsWith('state-') && file.endsWith('.json')) {
        const uid = file.slice('state-'.length, -'.json'.length);
        const full = path.join(baseDir, file);
        try {
          const text = fs.readFileSync(full, 'utf8');
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object') {
            writeUserStateSqlite(baseDir, uid, parsed, text);
            try { fs.unlinkSync(full); } catch { /* ignore */ }
          }
        } catch { /* keep if corrupted */ }
      } else if (file.startsWith('watch-') && file.endsWith('.json')) {
        const uid = file.slice('watch-'.length, -'.json'.length);
        const full = path.join(baseDir, file);
        try {
          const text = fs.readFileSync(full, 'utf8');
          JSON.parse(text);
          stmts.upsertWatchBox.run(uid, Date.now(), text);
          try { fs.unlinkSync(full); } catch { /* ignore */ }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // 4. Migra whatsapp-outbox.json
  if (fs.existsSync(legacyOutboxFile)) {
    try {
      const raw = fs.readFileSync(legacyOutboxFile, 'utf8');
      JSON.parse(raw);
      stmts.setKv.run('whatsapp_outbox', raw, Date.now());
      fs.unlinkSync(legacyOutboxFile);
    } catch { /* ignore */ }
  }
}

function toTimestampMs(val) {
  if (val == null || val === '') return null;
  if (typeof val === 'number' && Number.isFinite(val)) return Math.trunc(val);
  const parsed = Date.parse(String(val));
  return Number.isFinite(parsed) ? parsed : null;
}

function extractInviteCols(inv) {
  const usedBy = inv?.usedBy != null && inv.usedBy !== '' ? String(inv.usedBy) : null;
  const usedAt = toTimestampMs(inv?.usedAt);
  const revoked = inv?.revoked ? 1 : 0;
  return { usedBy, usedAt, revoked };
}

function normalizeEmailCol(email) {
  if (!email) return null;
  const trimmed = String(email).trim().toLowerCase();
  return trimmed || null;
}

function normalizeTenantCol(tenantId) {
  const trimmed = String(tenantId || '').trim();
  return trimmed || 'default';
}

/**
 * Sincroniza `kv_store` legados para as novas tabelas relacionais idempotente e atomicamente.
 * Mantém compatibilidade com scripts ou testes legados que escrevam direto em `kv_store`.
 */
export function backfillRelationalTables(instance) {
  if (!instance) return;
  const { db, stmts } = instance;

  runInTransaction(instance, () => {
    // 1. Backfill colunas de invites a partir do JSON
    db.exec(`
      UPDATE invites
      SET
        used_by = COALESCE(used_by, json_extract(data, '$.usedBy')),
        used_at = COALESCE(used_at, CASE
          WHEN typeof(json_extract(data, '$.usedAt')) IN ('integer', 'real') THEN CAST(json_extract(data, '$.usedAt') AS INTEGER)
          WHEN json_extract(data, '$.usedAt') IS NOT NULL THEN 1
          ELSE NULL
        END),
        revoked = CASE WHEN COALESCE(revoked, 0) = 1 OR json_extract(data, '$.revoked') = 1 THEN 1 ELSE 0 END
      WHERE (used_by IS NULL AND json_extract(data, '$.usedBy') IS NOT NULL)
         OR (used_at IS NULL AND json_extract(data, '$.usedAt') IS NOT NULL)
         OR (COALESCE(revoked, 0) = 0 AND json_extract(data, '$.revoked') = 1);
    `);

    // 2. Backfill saas_store (planos, tenants e faturas) caso exista no KV e tabelas ainda estejam vazias ou KV mudou externamente
    const saasKv = stmts.getKvWithMeta.get('saas_store');
    const syncMarker = stmts.getKv.get('saas_relational_sync_ts');
    const planCount = stmts.countSaasPlans.get()?.cnt || 0;
    const syncedKvTs = syncMarker ? Number(JSON.parse(syncMarker.value)) : 0;

    if (saasKv && (planCount === 0 || Number(saasKv.updated_at) !== syncedKvTs)) {
      try {
        const parsed = JSON.parse(saasKv.value);
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.plans)) {
            stmts.clearSaasPlans.run();
            parsed.plans.forEach((plan, idx) => {
              if (!plan?.id) return;
              stmts.upsertSaasPlanRow.run(String(plan.id), idx, JSON.stringify(plan), Number(saasKv.updated_at) || Date.now());
            });
          }
          if (parsed.tenants && typeof parsed.tenants === 'object') {
            for (const [slug, tRaw] of Object.entries(parsed.tenants)) {
              if (!tRaw || typeof tRaw !== 'object') continue;
              const tid = String(tRaw.id || slug).toLowerCase();
              const brandingKv = stmts.getKv.get(`branding:${tid}`);
              const brandingObj = tRaw.branding || (brandingKv ? JSON.parse(brandingKv.value) : {});
              const { invoices: rawInvoices, ...tenantMeta } = tRaw;
              stmts.upsertTenantRow.run(
                tid,
                String(tRaw.planId || 'pro'),
                String(tRaw.status || 'active'),
                JSON.stringify({ ...tenantMeta, id: tid }),
                JSON.stringify(brandingObj || {}),
                '[]',
                toTimestampMs(tRaw.updatedAt) || Number(saasKv.updated_at) || Date.now()
              );
              const invList = Array.isArray(rawInvoices) ? rawInvoices : [];
              for (const inv of invList) {
                if (!inv || !inv.id) continue;
                const expMs = toTimestampMs(inv.expiresAt);
                const status = String(inv.status || 'paid');
                const isCheckoutPending = inv.kind === 'pix_checkout'
                  || Boolean(inv.mpPaymentId && (status === 'pending' || status === 'checkout_creating') && (!expMs || expMs > Date.now()));
                const kind = isCheckoutPending ? 'pix_checkout' : String(inv.kind || 'invoice');
                stmts.insertInvoiceIgnore.run(
                  String(inv.id),
                  tid,
                  inv.planId ? String(inv.planId) : (tRaw.planId ? String(tRaw.planId) : null),
                  kind,
                  Math.max(0, Math.round(Number(inv.amount || 0) * 100)),
                  status,
                  inv.method ? String(inv.method) : null,
                  inv.mpPaymentId ? String(inv.mpPaymentId) : null,
                  inv.idempotencyKey ? String(inv.idempotencyKey) : null,
                  toTimestampMs(inv.createdAt) || Date.now(),
                  toTimestampMs(inv.paidAt),
                  expMs,
                  JSON.stringify(inv)
                );
              }
            }
          }
          stmts.setKv.run('saas_relational_sync_ts', JSON.stringify(Number(saasKv.updated_at)), Date.now());
        }
      } catch (e) {
        console.warn('[SQLite Backfill] Aviso ao migrar saas_store:', e.message);
      }
    }

    // 3. Backfill templates:<slug> -> gym_templates
    const tplKvs = stmts.getKvByPrefix.all('templates:%');
    for (const row of tplKvs) {
      const slug = row.key.slice('templates:'.length).toLowerCase();
      if (!slug) continue;
      const existingCnt = stmts.countTenantTemplates.get(slug)?.cnt || 0;
      if (existingCnt > 0) continue;
      try {
        const arr = JSON.parse(row.value);
        if (!Array.isArray(arr)) continue;
        arr.forEach((tpl, idx) => {
          if (!tpl || !tpl.id) return;
          const id = String(tpl.id);
          const defaultKey = tpl.defaultKey ? String(tpl.defaultKey) : null;
          stmts.insertTemplateIgnore.run(
            slug,
            id,
            defaultKey,
            idx,
            JSON.stringify(tpl),
            toTimestampMs(tpl.createdAt) || Date.now(),
            toTimestampMs(tpl.updatedAt) || Date.now()
          );
        });
      } catch { /* ignore malformed template KV */ }
    }

    // 4. Backfill whatsapp_outbox -> whatsapp_outbox table
    const outboxKv = stmts.getKv.get('whatsapp_outbox');
    const outboxCnt = stmts.countOutboxAll.get()?.cnt || 0;
    if (outboxKv && outboxCnt === 0) {
      try {
        const parsed = JSON.parse(outboxKv.value);
        const queue = Array.isArray(parsed?.queue) ? parsed.queue : [];
        const history = Array.isArray(parsed?.history) ? parsed.history : [];
        for (const item of queue) {
          if (!item || !item.id) continue;
          stmts.insertOutboxIgnore.run(
            String(item.id),
            String(item.tenantId || 'default'),
            String(item.kind || 'custom'),
            'pending',
            item.dedupKey ? String(item.dedupKey) : null,
            Number(item.attempts || 0),
            Number(item.nextAttemptAt || 0),
            null,
            toTimestampMs(item.createdAt) || Date.now(),
            null,
            JSON.stringify(item)
          );
        }
        for (const item of history) {
          if (!item || !item.id) continue;
          const st = ['sent', 'failed', 'cancelled'].includes(item.status) ? item.status : (item.error ? 'failed' : 'sent');
          stmts.insertOutboxIgnore.run(
            String(item.id),
            String(item.tenantId || 'default'),
            String(item.kind || 'custom'),
            st,
            null,
            Number(item.attempts || 0),
            0,
            null,
            toTimestampMs(item.createdAt) || Date.now(),
            toTimestampMs(item.sentAt || item.failedAt || item.createdAt) || Date.now(),
            JSON.stringify(item)
          );
        }
      } catch { /* ignore */ }
    }
  });
}

/* ==================== CORE DB (users, creds, subs, invites, links) ==================== */

export function loadCoreDbFromSqlite(dataDir) {
  const inst = getSqliteInstance(dataDir);
  // Se um teste escreveu `db.json` diretamente após a abertura do banco, absorve-o imediatamente
  migrateLegacyJsonIfPresent(inst);
  backfillRelationalTables(inst);

  inst.cache.users.clear();
  const users = [];
  for (const r of inst.stmts.getAllUsers.all()) {
    inst.cache.users.set(r.id, r.data);
    users.push(JSON.parse(r.data));
  }

  inst.cache.creds.clear();
  const creds = [];
  for (const r of inst.stmts.getAllCreds.all()) {
    inst.cache.creds.set(r.id, r.data);
    creds.push(JSON.parse(r.data));
  }

  inst.cache.subs.clear();
  const subs = [];
  for (const r of inst.stmts.getAllSubs.all()) {
    inst.cache.subs.set(r.endpoint, r.data);
    subs.push(JSON.parse(r.data));
  }

  inst.cache.invites.clear();
  const invites = [];
  for (const r of inst.stmts.getAllInvites.all()) {
    inst.cache.invites.set(r.code, r.data);
    invites.push(JSON.parse(r.data));
  }

  inst.cache.deviceLinks.clear();
  const deviceLinks = [];
  for (const r of inst.stmts.getAllDeviceLinks.all()) {
    inst.cache.deviceLinks.set(r.id, r.data);
    deviceLinks.push(JSON.parse(r.data));
  }

  inst.cache.watches.clear();
  const watches = [];
  for (const r of inst.stmts.getAllWatchLinks.all()) {
    inst.cache.watches.set(r.id, r.data);
    watches.push(JSON.parse(r.data));
  }

  const extraRow = inst.stmts.getKv.get('core_db_extra');
  const extra = extraRow ? JSON.parse(extraRow.value) : {};
  inst.cache.extra = extraRow ? extraRow.value : '{}';

  return {
    ...extra,
    users,
    creds,
    subs,
    invites,
    deviceLinks,
    ...(watches.length ? { watches } : {})
  };
}

function writeDbMirrorSync(inst, dbObj) {
  if (!dbObj) {
    try { inst.stmts.setKv.run('db_json_mirror_sha', 'SQLITE_AHEAD', Date.now()); } catch { /* ignore */ }
    return;
  }
  const mirrorPath = path.join(inst.baseDir, 'db.json');
  const bakPath = mirrorPath + '.bak';
  try {
    const raw = JSON.stringify(dbObj, null, 2);
    fs.writeFileSync(bakPath, raw, { mode: 0o600 });
    fs.writeFileSync(mirrorPath, raw, { mode: 0o600 });
    const rawSha = crypto.createHash('sha256').update(raw).digest('hex');
    inst.stmts.setKv.run('db_json_mirror_sha', rawSha, Date.now());
    fs.chmodSync(bakPath, 0o600);
    fs.chmodSync(mirrorPath, 0o600);
  } catch { /* host filesystem may deny chmod */ }
}

export function saveCoreDbToSqlite(dataDir, dbObj) {
  const inst = getSqliteInstance(dataDir);
  const now = Date.now();

  runInTransaction(inst, () => {
    // 1. Users: remove excluídos antes de inserir/atualizar para evitar falso conflito em email/nome únicos
    const existingUserIds = new Set(inst.stmts.getUserIds.all().map(r => r.id));
    const currentUserIds = new Set((dbObj.users || []).filter(u => u && u.id).map(u => String(u.id)));
    for (const id of existingUserIds) {
      if (!currentUserIds.has(id)) {
        inst.stmts.deleteUser.run(id);
        inst.cache.users.delete(id);
      }
    }
    for (const u of (dbObj.users || [])) {
      if (!u || !u.id) continue;
      const uid = String(u.id);
      const str = JSON.stringify(u);
      if (inst.cache.users.get(uid) !== str) {
        inst.stmts.upsertUser.run(
          uid,
          normalizeTenantCol(u.tenantId),
          normalizeEmailCol(u.email),
          u.name ? String(u.name) : null,
          u.saasRole || u.role || (u.admin ? 'admin' : 'student'),
          str,
          now
        );
        inst.cache.users.set(uid, str);
      }
    }

    // 2. Creds reconciliação
    const existingCredIds = new Set(inst.stmts.getCredIds.all().map(r => r.id));
    const currentCredIds = new Set((dbObj.creds || []).filter(c => c && c.id).map(c => String(c.id)));
    for (const id of existingCredIds) {
      if (!currentCredIds.has(id)) {
        inst.stmts.deleteCred.run(id);
        inst.cache.creds.delete(id);
      }
    }
    for (const c of (dbObj.creds || [])) {
      if (!c || !c.id) continue;
      const cid = String(c.id);
      const str = JSON.stringify(c);
      if (inst.cache.creds.get(cid) !== str) {
        inst.stmts.upsertCred.run(cid, String(c.userId || ''), str);
        inst.cache.creds.set(cid, str);
      }
    }

    // 3. Subs reconciliação
    const existingSubEndpoints = new Set(inst.stmts.getSubEndpoints.all().map(r => r.endpoint));
    const currentSubEndpoints = new Set((dbObj.subs || []).filter(s => s && s.endpoint).map(s => String(s.endpoint)));
    for (const ep of existingSubEndpoints) {
      if (!currentSubEndpoints.has(ep)) {
        inst.stmts.deleteSub.run(ep);
        inst.cache.subs.delete(ep);
      }
    }
    for (const s of (dbObj.subs || [])) {
      if (!s || !s.endpoint) continue;
      const ep = String(s.endpoint);
      const str = JSON.stringify(s);
      if (inst.cache.subs.get(ep) !== str) {
        inst.stmts.upsertSub.run(ep, String(s.userId || ''), str);
        inst.cache.subs.set(ep, str);
      }
    }

    // 4. Invites reconciliação
    const existingInviteCodes = new Set(inst.stmts.getInviteCodes.all().map(r => r.code));
    const currentInviteCodes = new Set((dbObj.invites || []).filter(inv => inv && inv.code).map(inv => String(inv.code)));
    for (const code of existingInviteCodes) {
      if (!currentInviteCodes.has(code)) {
        inst.stmts.deleteInvite.run(code);
        inst.cache.invites.delete(code);
      }
    }
    for (const inv of (dbObj.invites || [])) {
      if (!inv || !inv.code) continue;
      const code = String(inv.code);
      const str = JSON.stringify(inv);
      if (inst.cache.invites.get(code) !== str) {
        const { usedBy, usedAt, revoked } = extractInviteCols(inv);
        inst.stmts.upsertInvite.run(
          code,
          normalizeTenantCol(inv.tenantId),
          usedBy,
          usedAt,
          revoked,
          str
        );
        inst.cache.invites.set(code, str);
      }
    }

    // 5. DeviceLinks reconciliação
    const existingDlIds = new Set(inst.stmts.getDeviceLinkIds.all().map(r => r.id));
    const currentDlIds = new Set();
    const dlEntries = [];
    for (const dl of (dbObj.deviceLinks || [])) {
      if (!dl) continue;
      const dlId = String(dl.id || dl.h || dl.hash || `${dl.userId}_${Math.random()}`);
      currentDlIds.add(dlId);
      dlEntries.push([dlId, dl]);
    }
    for (const id of existingDlIds) {
      if (!currentDlIds.has(id)) {
        inst.stmts.deleteDeviceLink.run(id);
        inst.cache.deviceLinks.delete(id);
      }
    }
    for (const [dlId, dl] of dlEntries) {
      const str = JSON.stringify(dl);
      if (inst.cache.deviceLinks.get(dlId) !== str) {
        inst.stmts.upsertDeviceLink.run(dlId, String(dl.userId || ''), str);
        inst.cache.deviceLinks.set(dlId, str);
      }
    }

    // 6. WatchLinks reconciliação
    const existingWlIds = new Set(inst.stmts.getWatchLinkIds.all().map(r => r.id));
    const currentWlIds = new Set();
    const wlEntries = [];
    for (const wl of (dbObj.watches || [])) {
      if (!wl) continue;
      const wlId = String(wl.id || wl.h || wl.hash || `${wl.userId}_${Math.random()}`);
      currentWlIds.add(wlId);
      wlEntries.push([wlId, wl]);
    }
    for (const id of existingWlIds) {
      if (!currentWlIds.has(id)) {
        inst.stmts.deleteWatchLink.run(id);
        inst.cache.watches.delete(id);
      }
    }
    for (const [wlId, wl] of wlEntries) {
      const str = JSON.stringify(wl);
      if (inst.cache.watches.get(wlId) !== str) {
        inst.stmts.upsertWatchLink.run(wlId, String(wl.userId || ''), str);
        inst.cache.watches.set(wlId, str);
      }
    }

    // Preserva chaves extras de dbObj caso existam
    const extra = {};
    for (const [k, v] of Object.entries(dbObj)) {
      if (!['users', 'creds', 'subs', 'invites', 'deviceLinks', 'watches'].includes(k)) {
        extra[k] = v;
      }
    }
    const extraStr = JSON.stringify(extra);
    if (inst.cache.extra !== extraStr) {
      inst.stmts.setKv.run('core_db_extra', extraStr, now);
      inst.cache.extra = extraStr;
    }
  });

  // Espelho em db.json para compatibilidade e inspeção (restrito a 0600)
  writeDbMirrorSync(inst, dbObj);
  scheduleDailySqliteBackup(inst);
}

/* ==================== MUTAÇÕES GRANULARES (Zero-Write Amplification) ==================== */

export function upsertUserSqlite(dataDir, user, dbObj = null) {
  if (!user || !user.id) return;
  const inst = getSqliteInstance(dataDir);
  const uid = String(user.id);
  const str = JSON.stringify(user);
  const now = Date.now();
  runInTransaction(inst, () => {
    inst.stmts.upsertUser.run(
      uid,
      normalizeTenantCol(user.tenantId),
      normalizeEmailCol(user.email),
      user.name ? String(user.name) : null,
      user.saasRole || user.role || (user.admin ? 'admin' : 'student'),
      str,
      now
    );
    inst.cache.users.set(uid, str);
  });
  writeDbMirrorSync(inst, dbObj);
}

export function deleteUserSqlite(dataDir, userId, dbObj = null) {
  if (!userId) return;
  const inst = getSqliteInstance(dataDir);
  const uid = String(userId);
  inst.stmts.deleteUser.run(uid);
  inst.cache.users.delete(uid);
  writeDbMirrorSync(inst, dbObj);
}

export function upsertCredSqlite(dataDir, cred, dbObj = null) {
  if (!cred || !cred.id) return;
  const inst = getSqliteInstance(dataDir);
  const cid = String(cred.id);
  const str = JSON.stringify(cred);
  inst.stmts.upsertCred.run(cid, String(cred.userId || ''), str);
  inst.cache.creds.set(cid, str);
  writeDbMirrorSync(inst, dbObj);
}

export function deleteCredSqlite(dataDir, credId, dbObj = null) {
  if (!credId) return;
  const inst = getSqliteInstance(dataDir);
  const cid = String(credId);
  inst.stmts.deleteCred.run(cid);
  inst.cache.creds.delete(cid);
  writeDbMirrorSync(inst, dbObj);
}

export function upsertSubSqlite(dataDir, sub, dbObj = null) {
  if (!sub || !sub.endpoint) return;
  const inst = getSqliteInstance(dataDir);
  const ep = String(sub.endpoint);
  const str = JSON.stringify(sub);
  inst.stmts.upsertSub.run(ep, String(sub.userId || ''), str);
  inst.cache.subs.set(ep, str);
  writeDbMirrorSync(inst, dbObj);
}

export function deleteSubSqlite(dataDir, endpoint, dbObj = null) {
  if (!endpoint) return;
  const inst = getSqliteInstance(dataDir);
  const ep = String(endpoint);
  inst.stmts.deleteSub.run(ep);
  inst.cache.subs.delete(ep);
  writeDbMirrorSync(inst, dbObj);
}

export function upsertInviteSqlite(dataDir, invite, dbObj = null) {
  if (!invite || !invite.code) return;
  const inst = getSqliteInstance(dataDir);
  const code = String(invite.code);
  const str = JSON.stringify(invite);
  const { usedBy, usedAt, revoked } = extractInviteCols(invite);
  inst.stmts.upsertInvite.run(code, normalizeTenantCol(invite.tenantId), usedBy, usedAt, revoked, str);
  inst.cache.invites.set(code, str);
  writeDbMirrorSync(inst, dbObj);
}

export function deleteInviteSqlite(dataDir, code, dbObj = null) {
  if (!code) return;
  const inst = getSqliteInstance(dataDir);
  const c = String(code);
  inst.stmts.deleteInvite.run(c);
  inst.cache.invites.delete(c);
  writeDbMirrorSync(inst, dbObj);
}

/* ==================== USER STATES (Treinos, Fichas, Peso, Evolução) ==================== */

export function readUserStateSqlite(dataDir, userId) {
  const inst = getSqliteInstance(dataDir);
  const safeId = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return null;

  // Caso algum processo externo tenha colocado um `state-<uid>.json` no diretório, absorve-o preservando o arquivo/mtime
  const legacyFile = path.join(inst.baseDir, `state-${safeId}.json`);
  if (fs.existsSync(legacyFile)) {
    try {
      const lst = fs.statSync(legacyFile);
      const text = fs.readFileSync(legacyFile, 'utf8');
      const parsed = JSON.parse(text);
      const rev = Number(parsed?._rev || 0);
      const wid = parsed?._wid ? String(parsed._wid) : null;
      inst.stmts.upsertState.run(safeId, rev, wid, lst.mtimeMs, Buffer.byteLength(text, 'utf8'), text);
      return parsed;
    } catch {
      return undefined; // sinaliza UNREADABLE se o arquivo foi corrompido externamente
    }
  }

  const row = inst.stmts.getState.get(safeId);
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return undefined;
  }
}

export function statUserStateSqlite(dataDir, userId) {
  const inst = getSqliteInstance(dataDir);
  const safeId = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return null;

  const legacyFile = path.join(inst.baseDir, `state-${safeId}.json`);
  if (fs.existsSync(legacyFile)) {
    try {
      const lst = fs.statSync(legacyFile);
      return {
        mtimeMs: Number(lst.mtimeMs),
        size: Number(lst.size),
        rev: 0,
        wid: null
      };
    } catch {
      return null;
    }
  }

  const row = inst.stmts.getStateMeta.get(safeId);
  if (!row) return null;
  return {
    mtimeMs: Number(row.updated_at),
    size: Number(row.size),
    rev: Number(row.rev || 0),
    wid: row.wid || null
  };
}

export function writeUserStateSqlite(dataDir, userId, stateObj, serializedText = null) {
  const inst = getSqliteInstance(dataDir);
  const safeId = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const text = serializedText ?? JSON.stringify(stateObj);
  const now = Date.now();
  const rev = Number(stateObj?._rev || 0);
  const wid = stateObj?._wid ? String(stateObj._wid) : null;
  const size = Buffer.byteLength(text, 'utf8');

  inst.stmts.upsertState.run(safeId, rev, wid, now, size, text);

  const legacyFile = path.join(inst.baseDir, `state-${safeId}.json`);
  if (fs.existsSync(legacyFile)) {
    try { fs.unlinkSync(legacyFile); } catch { /* ignore */ }
  }

  return stateObj;
}

export function deleteUserStateSqlite(dataDir, userId) {
  const inst = getSqliteInstance(dataDir);
  const safeId = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  inst.stmts.deleteState.run(safeId);
  const legacyFile = path.join(inst.baseDir, `state-${safeId}.json`);
  try { fs.unlinkSync(legacyFile); } catch { /* ignore */ }
}

/* ==================== WATCH RELAY MAILBOX ==================== */

export function readWatchBoxSqlite(dataDir, userId) {
  const inst = getSqliteInstance(dataDir);
  const safeId = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const row = inst.stmts.getWatchBox.get(safeId);
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

export function writeWatchBoxSqlite(dataDir, userId, boxObj) {
  const inst = getSqliteInstance(dataDir);
  const safeId = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  inst.stmts.upsertWatchBox.run(safeId, Date.now(), JSON.stringify(boxObj));
}

export function deleteWatchBoxSqlite(dataDir, userId) {
  const inst = getSqliteInstance(dataDir);
  const safeId = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  inst.stmts.deleteWatchBox.run(safeId);
}

/* ==================== KV STORE (SaaS Store, Branding, Templates, WhatsApp Outbox) ==================== */

export function getSqliteKv(dirOrTenantDir, key, fallback = null) {
  const inst = getSqliteInstance(dirOrTenantDir);
  const row = inst.stmts.getKv.get(String(key));
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function setSqliteKv(dirOrTenantDir, key, value) {
  const inst = getSqliteInstance(dirOrTenantDir);
  inst.stmts.setKv.run(String(key), JSON.stringify(value), Date.now());
  return value;
}

/* ==================== BACKUP QUENTE DIÁRIO AUTOMÁTICO (ROTAÇÃO 7 DIAS) ==================== */

function scheduleDailySqliteBackup(inst) {
  const today = new Date().toISOString().slice(0, 10);
  if (inst.lastBackupDate === today) return;
  inst.lastBackupDate = today;

  // Não gera backup em diretórios temporários de testes unitários
  if (inst.baseDir.includes('Temp') || inst.baseDir.includes('/tmp')) return;

  const timer = setTimeout(async () => {
    try {
      const backupDir = path.join(inst.baseDir, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const targetPath = path.join(backupDir, `rit-${today}.db`);
      if (!fs.existsSync(targetPath)) {
        await sqliteBackup(inst.db, targetPath);
      }
      // Mantém apenas os últimos 7 backups diários
      const files = fs.readdirSync(backupDir)
        .filter(f => f.startsWith('rit-') && f.endsWith('.db'))
        .sort();
      while (files.length > 7) {
        const oldest = files.shift();
        try { fs.unlinkSync(path.join(backupDir, oldest)); } catch { /* ignore */ }
      }
    } catch (e) {
      console.warn('[SQLite Backup] Aviso ao criar snapshot diário:', e.message);
    }
  }, 1500);

  if (typeof timer.unref === 'function') timer.unref();
}

export function closeSqliteInstance(dirOrTenantDir) {
  const baseDir = resolveBaseDir(dirOrTenantDir);
  const inst = dbInstances.get(baseDir);
  if (inst) {
    try { inst.db.close(); } catch { /* ignore */ }
    dbInstances.delete(baseDir);
  }
}

export function closeAllSqliteInstances() {
  for (const [dir, inst] of dbInstances.entries()) {
    try { inst.db.close(); } catch { /* ignore */ }
    dbInstances.delete(dir);
  }
}

// Garante que em chamadas fs.rmSync(tmpDir) (ex: suítes de teste no Windows),
// qualquer instância SQLite aberta dentro do diretório seja fechada antes da remoção.
const origRmSync = fs.rmSync.bind(fs);
fs.rmSync = function sqliteSafeRmSync(targetPath, options = {}) {
  try {
    const resolvedTarget = path.resolve(String(targetPath));
    for (const [dir, inst] of dbInstances.entries()) {
      if (dir === resolvedTarget || dir.startsWith(resolvedTarget + path.sep)) {
        try { inst.db.close(); } catch { /* ignore */ }
        dbInstances.delete(dir);
      }
    }
  } catch { /* ignore */ }
  return origRmSync(targetPath, { maxRetries: 10, retryDelay: 50, ...options });
};

/* ==================== ATOMIC RACE-SAFE PRIMITIVES ==================== */

export function isSqliteUniqueConstraintError(err) {
  if (!err) return false;
  const msg = String(err.errstr || err.message || '');
  return err.errcode === 2067 || err.errcode === 1555 || /UNIQUE constraint failed/i.test(msg);
}

/**
 * Consome um convite de forma atômica no SQLite (apenas se não utilizado e não revogado).
 */
export function consumeInviteSqlite(dataDir, code, userId, usedAtValue = null) {
  const cleanCode = String(code || '').trim();
  if (!cleanCode || !userId) return { ok: false, reason: 'invalid' };
  const inst = getSqliteInstance(dataDir);
  return runInTransaction(inst, () => {
    const row = inst.stmts.getInvite.get(cleanCode);
    if (!row) return { ok: false, reason: 'not_found' };
    if (Number(row.revoked) === 1) return { ok: false, reason: 'revoked' };
    if (row.used_by) return { ok: false, reason: 'already_used', usedBy: row.used_by };

    let inv = {};
    try { inv = JSON.parse(row.data); } catch { inv = { code: cleanCode }; }
    const expMs = toTimestampMs(inv.expires ?? inv.expiresAt);
    if (expMs && Date.now() > expMs) return { ok: false, reason: 'expired' };
    if (inv.revoked) return { ok: false, reason: 'revoked' };
    if (inv.usedBy) return { ok: false, reason: 'already_used', usedBy: inv.usedBy };

    const nowMs = Date.now();
    const updated = { ...inv, usedBy: String(userId), usedAt: usedAtValue ?? new Date(nowMs).toISOString() };
    const updatedStr = JSON.stringify(updated);
    const info = inst.stmts.consumeInviteConditional.run(String(userId), nowMs, updatedStr, cleanCode);
    if (info.changes !== 1) return { ok: false, reason: 'already_used' };
    inst.cache.invites.set(cleanCode, updatedStr);
    return { ok: true, invite: updated };
  });
}

/**
 * Consome um link de pareamento único (`device_links`) atomicamente com DELETE ... RETURNING.
 */
export function consumeDeviceLinkSqlite(dataDir, hashOrId) {
  const key = String(hashOrId || '').trim();
  if (!key) return null;
  const inst = getSqliteInstance(dataDir);
  return runInTransaction(inst, () => {
    const row = inst.stmts.consumeDeviceLinkByHashOrId.get(key, key, key);
    if (!row) return null;
    inst.cache.deviceLinks.delete(row.id);
    try { return JSON.parse(row.data); } catch { return null; }
  });
}

/**
 * Consome um link único de relógio (`watch_links`) atomicamente com DELETE ... RETURNING.
 */
export function consumeWatchLinkSqlite(dataDir, hashOrId) {
  const key = String(hashOrId || '').trim();
  if (!key) return null;
  const inst = getSqliteInstance(dataDir);
  return runInTransaction(inst, () => {
    const row = inst.stmts.consumeWatchLinkByHashOrId.get(key, key, key);
    if (!row) return null;
    inst.cache.watches.delete(row.id);
    try { return JSON.parse(row.data); } catch { return null; }
  });
}

/**
 * Atualiza `user_states` usando Compare-And-Swap (`WHERE user_id = ? AND rev = ?`) ou insert condicional.
 */
export function writeUserStateCasSqlite(dataDir, userId, stateObj, expectedRev = null, serializedText = null) {
  const inst = getSqliteInstance(dataDir);
  const safeId = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) throw new Error('Invalid userId');
  const text = serializedText ?? JSON.stringify(stateObj);
  const now = Date.now();
  const nextRev = Number(stateObj?._rev || 0);
  const wid = stateObj?._wid ? String(stateObj._wid) : null;
  const size = Buffer.byteLength(text, 'utf8');

  return runInTransaction(inst, () => {
    const existing = inst.stmts.getStateMeta.get(safeId);
    if (expectedRev !== null && expectedRev !== undefined) {
      if (!existing) {
        if (Number(expectedRev) !== 0) {
          return { ok: false, conflict: true, rev: null };
        }
        const ins = inst.stmts.casInsertState.run(safeId, nextRev, wid, now, size, text);
        if (ins.changes !== 1) return { ok: false, conflict: true, rev: null };
      } else {
        if (Number(existing.rev) !== Number(expectedRev)) {
          return { ok: false, conflict: true, rev: Number(existing.rev) };
        }
        const upd = inst.stmts.casUpdateState.run(nextRev, wid, now, size, text, safeId, Number(expectedRev));
        if (upd.changes !== 1) return { ok: false, conflict: true, rev: Number(existing.rev) };
      }
    } else {
      inst.stmts.upsertState.run(safeId, nextRev, wid, now, size, text);
    }

    const legacyFile = path.join(inst.baseDir, `state-${safeId}.json`);
    if (fs.existsSync(legacyFile)) {
      try { fs.writeFileSync(legacyFile, text); } catch { /* ignore */ }
    }
    return { ok: true, conflict: false, rev: nextRev, state: stateObj };
  });
}

/**
 * Executa leitura + mutação + gravação de `user_states` inteiramente dentro de `BEGIN IMMEDIATE`,
 * impedindo lost updates entre prescrições do trainer e sincronização `PUT /api/data`.
 */
export function updateUserStateAtomicSqlite(dataDir, userId, mutateFn) {
  const inst = getSqliteInstance(dataDir);
  const safeId = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) throw new Error('Invalid userId');

  return runInTransaction(inst, () => {
    const current = readUserStateSqlite(dataDir, safeId);
    if (current === undefined) throw new Error('Student state file unreadable');
    const baseState = current || { workouts: [], routines: [], week: {} };
    const baseRev = Number(baseState?._rev || 0);
    const nextState = mutateFn(baseState);
    if (!nextState) return current;
    if (!nextState._rev || Number(nextState._rev) <= baseRev) {
      nextState._rev = baseRev + 1;
    }
    writeUserStateSqlite(dataDir, safeId, nextState);
    return nextState;
  });
}

export function getCoachDailySqlite(dataDir, userId, day) {
  const inst = getSqliteInstance(dataDir);
  const row = inst.stmts.getCoachDaily.get(String(userId), String(day));
  return row ? Number(row.count || 0) : 0;
}

export function bumpCoachDailySqlite(dataDir, userId, day, maxCap = null) {
  const inst = getSqliteInstance(dataDir);
  const uid = String(userId);
  const d = String(day);
  const cap = maxCap === null || maxCap === undefined ? null : Number(maxCap);
  return runInTransaction(inst, () => {
    inst.stmts.ensureCoachDaily.run(uid, d);
    const row = inst.stmts.bumpCoachDailyConditional.get(uid, d, cap, cap);
    if (!row) {
      const cur = inst.stmts.getCoachDaily.get(uid, d);
      return { ok: false, count: cur ? Number(cur.count || 0) : 0 };
    }
    return { ok: true, count: Number(row.count) };
  });
}

export function decrementCoachDailySqlite(dataDir, userId, day) {
  const inst = getSqliteInstance(dataDir);
  const row = inst.stmts.decrementCoachDaily.get(String(userId), String(day));
  return row ? Number(row.count || 0) : 0;
}

/* ==================== WEBHOOK EVENTS & HTTP IDEMPOTENCY ==================== */

/**
 * Grava o ID único de um evento de webhook em `webhook_events` antes de qualquer processamento.
 * Se o `event_id` já existir, retorna `{ inserted: false, existing }` para que o endpoint devolva 200 sem reprocessar.
 */
export function registerWebhookEventSqlite(dataDir, {
  eventId,
  provider = 'mercadopago',
  actionType = null,
  resourceId = null,
  payloadHash,
  rawPayload = '{}',
  initialStatus = 'queued',
  resultJson = null
}) {
  const inst = getSqliteInstance(dataDir);
  return runInTransaction(inst, () => {
    const now = Date.now();
    const ins = inst.stmts.insertWebhookEventIgnore.run(
      String(eventId),
      String(provider || 'mercadopago'),
      actionType ? String(actionType).slice(0, 80) : null,
      resourceId ? String(resourceId).slice(0, 120) : null,
      String(payloadHash || ''),
      String(initialStatus || 'queued'),
      0,
      now,
      null,
      now,
      initialStatus === 'processed' ? now : null,
      String(rawPayload || '{}'),
      resultJson ? String(resultJson) : null,
      null
    );
    if (ins.changes === 1) {
      return { inserted: true, event: inst.stmts.getWebhookEvent.get(String(eventId)) };
    }
    return { inserted: false, event: inst.stmts.getWebhookEvent.get(String(eventId)) };
  });
}

/**
 * Reserva ou consulta atomicamente uma chave HTTP `Idempotency-Key` em `api_idempotency_keys`.
 */
export function acquireApiIdempotencySqlite(dataDir, {
  scopeKey,
  clientKey,
  route,
  actorId,
  requestHash,
  gatewayIdempotencyKey,
  ttlMs = 24 * 3600 * 1000,
  staleInFlightMs = 90 * 1000
}) {
  const inst = getSqliteInstance(dataDir);
  return runInTransaction(inst, () => {
    const now = Date.now();
    try { inst.stmts.pruneExpiredApiIdempotency.run(now - 7 * 24 * 3600 * 1000); } catch { /* ignore */ }
    const expiresAt = now + ttlMs;
    const gwKey = gatewayIdempotencyKey || crypto.randomUUID();
    const ins = inst.stmts.insertApiIdempotencyIgnore.run(
      scopeKey,
      clientKey,
      route,
      actorId,
      requestHash,
      gwKey,
      now,
      now,
      expiresAt
    );
    if (ins.changes === 1) {
      return { action: 'acquired', record: inst.stmts.getApiIdempotencyKey.get(scopeKey) };
    }

    // Reaproveita se expirou ou travou em flight há mais de 90s
    const replaced = inst.stmts.replaceExpiredApiIdempotency.get(
      clientKey,
      route,
      actorId,
      requestHash,
      gwKey,
      now,
      now,
      expiresAt,
      scopeKey,
      now,
      now - staleInFlightMs
    );
    if (replaced) {
      return { action: 'acquired', record: replaced };
    }

    const existing = inst.stmts.getApiIdempotencyKey.get(scopeKey);
    if (!existing) {
      return { action: 'conflict' };
    }
    if (existing.request_hash !== requestHash) {
      return { action: 'mismatch', record: existing };
    }
    if (existing.status === 'retryable') {
      const reclaimed = inst.stmts.claimRetryableApiIdempotency.get(now, scopeKey, requestHash);
      if (reclaimed) {
        return { action: 'acquired', record: reclaimed, retried: true };
      }
      return { action: 'in_flight', record: inst.stmts.getApiIdempotencyKey.get(scopeKey) };
    }
    if (existing.status === 'completed') {
      return { action: 'replay', record: existing };
    }
    return { action: 'in_flight', record: existing };
  });
}

export function completeApiIdempotencySqlite(dataDir, scopeKey, responseStatus, responsePayload) {
  const inst = getSqliteInstance(dataDir);
  inst.stmts.completeApiIdempotency.run(
    Number(responseStatus || 200),
    JSON.stringify(responsePayload ?? {}),
    Date.now(),
    String(scopeKey)
  );
}

export function markApiIdempotencyRetryableSqlite(dataDir, scopeKey) {
  const inst = getSqliteInstance(dataDir);
  inst.stmts.markApiIdempotencyRetryable.run(Date.now(), String(scopeKey));
}

export function getApiIdempotencyRecordSqlite(dataDir, scopeKey) {
  const inst = getSqliteInstance(dataDir);
  return inst.stmts.getApiIdempotencyKey.get(String(scopeKey)) || null;
}

const MOBILE_NOTIF_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function enqueueMobileNotificationSqlite(dataDir, userId, payload = {}) {
  const uid = String(userId || '').trim();
  const title = String(payload?.title || '').trim().slice(0, 160);
  if (!uid || !title) return null;
  const body = String(payload?.body || '').trim().slice(0, 500);
  const tag = String(payload?.tag || '').trim().slice(0, 80);
  const url = String(payload?.url || '#/').trim().slice(0, 240) || '#/';
  const createdAt = Date.now();
  const inst = getSqliteInstance(dataDir);
  return runInTransaction(inst, () => {
    const info = inst.stmts.insertMobileNotif.run(uid, title, body, tag, url, createdAt);
    inst.stmts.pruneUserMobileNotif.run(uid, uid);
    inst.stmts.pruneExpiredMobileNotif.run(createdAt - MOBILE_NOTIF_TTL_MS);
    return {
      id: Number(info.lastInsertRowid),
      userId: uid,
      title,
      body,
      tag,
      url,
      createdAt
    };
  });
}

export function listMobileNotificationsSqlite(dataDir, userId, { sinceId = 0, limit = 20, initialWindowMs = 15 * 60 * 1000 } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return { latestId: 0, notifications: [] };
  const safeLimit = Math.max(1, Math.min(50, Math.round(Number(limit) || 20)));
  const inst = getSqliteInstance(dataDir);
  const latestRow = inst.stmts.latestMobileNotifId.get(uid);
  const latestId = Number(latestRow?.latest_id || 0);
  const rows = sinceId > 0
    ? inst.stmts.listMobileNotifSince.all(uid, sinceId, safeLimit)
    : inst.stmts.listMobileNotifRecent.all(uid, Date.now() - initialWindowMs, safeLimit);
  return {
    latestId,
    notifications: rows.map(r => ({
      id: Number(r.id),
      title: String(r.title || ''),
      body: String(r.body || ''),
      tag: String(r.tag || ''),
      url: String(r.url || '#/'),
      createdAt: Number(r.created_at || 0)
    }))
  };
}

export function deleteMobileNotificationsSqlite(dataDir, userId) {
  const uid = String(userId || '').trim();
  if (!uid) return;
  const inst = getSqliteInstance(dataDir);
  inst.stmts.deleteUserMobileNotif.run(uid);
}

export function checkOtpSendQuotaSqlite(
  dataDir,
  { email, phone = '', purpose = 'register', now = Date.now(), windowMs = 10 * 60_000, maxPerWindow = 5 }
) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPhone = phone ? String(phone).trim() : '';
  const cleanPurpose = String(purpose || 'register').trim();
  const since = now - Math.max(60_000, Number(windowMs) || 10 * 60_000);
  const cap = Math.max(1, Number(maxPerWindow) || 5);
  const inst = getSqliteInstance(dataDir);
  const byEmail = cleanEmail
    ? inst.stmts.countAuthVerificationsByEmail.get(cleanEmail, cleanPurpose, since)
    : { cnt: 0, oldest_at: null };
  if (Number(byEmail?.cnt || 0) >= cap) {
    const oldest = Number(byEmail.oldest_at || now);
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { ok: false, reason: 'email-quota', retryAfterSec };
  }
  if (cleanPhone) {
    const byPhone = inst.stmts.countAuthVerificationsByPhone.get(cleanPhone, cleanPurpose, since);
    if (Number(byPhone?.cnt || 0) >= cap) {
      const oldest = Number(byPhone.oldest_at || now);
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      return { ok: false, reason: 'phone-quota', retryAfterSec };
    }
  }
  return { ok: true };
}

export function createAuthVerificationSqlite(
  dataDir,
  { id, email, phone = null, userId = null, tenantId = 'default', purpose = 'register', codeHash, ttlMs = 10 * 60 * 1000 }
) {
  const now = Date.now();
  const expiresAt = now + Math.max(60_000, Number(ttlMs) || 10 * 60 * 1000);
  const cleanEmail = String(email).trim().toLowerCase();
  const cleanPurpose = String(purpose || 'register').trim();
  const inst = getSqliteInstance(dataDir);
  return runInTransaction(inst, () => {
    inst.stmts.pruneExpiredAuthVerifications.run(now, now - 15 * 60_000);
    inst.stmts.supersedeAuthVerifications.run(cleanEmail, cleanPurpose, String(id));
    inst.stmts.upsertAuthVerification.run(
      String(id),
      cleanEmail,
      phone ? String(phone).trim() : null,
      userId ? String(userId).trim() : null,
      String(tenantId || 'default').trim() || 'default',
      cleanPurpose,
      String(codeHash),
      0,
      expiresAt,
      now
    );
    return {
      id: String(id),
      email: cleanEmail,
      phone: phone ? String(phone).trim() : null,
      userId: userId ? String(userId).trim() : null,
      tenantId: String(tenantId || 'default').trim() || 'default',
      purpose: cleanPurpose,
      expiresAt,
      createdAt: now
    };
  });
}

export function purgeUserPrivacyRecordsSqlite(dataDir, { userId, email = '', phone = '' } = {}) {
  const uid = String(userId || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPhone = String(phone || '').trim();
  const inst = getSqliteInstance(dataDir);
  runInTransaction(inst, () => {
    if (uid || cleanEmail) {
      inst.stmts.deleteUserAuthVerifications.run(uid, cleanEmail);
    }
    if (uid || cleanPhone) {
      inst.stmts.deleteUserWhatsappOutbox.run(cleanPhone, cleanPhone, `%:${uid}:%`);
    }
  });
}

export function getAuthVerificationSqlite(dataDir, id) {
  const cid = String(id || '').trim();
  if (!cid) return null;
  const inst = getSqliteInstance(dataDir);
  const row = inst.stmts.getAuthVerification.get(cid);
  if (!row) return null;
  return {
    id: String(row.id),
    email: String(row.email || ''),
    phone: row.phone ? String(row.phone) : null,
    userId: row.user_id ? String(row.user_id) : null,
    tenantId: String(row.tenant_id || 'default'),
    purpose: String(row.purpose || 'register'),
    codeHash: String(row.code_hash || ''),
    attempts: Number(row.attempts || 0),
    expiresAt: Number(row.expires_at || 0),
    createdAt: Number(row.created_at || 0)
  };
}

export function incrementAuthVerificationAttemptsSqlite(dataDir, id) {
  const cid = String(id || '').trim();
  if (!cid) return 0;
  const inst = getSqliteInstance(dataDir);
  const row = inst.stmts.incrementAuthVerificationAttempts.get(cid);
  return Number(row?.attempts || 0);
}

export function deleteAuthVerificationSqlite(dataDir, id) {
  const cid = String(id || '').trim();
  if (!cid) return;
  const inst = getSqliteInstance(dataDir);
  inst.stmts.deleteAuthVerification.run(cid);
}

process.on('exit', () => {
  closeAllSqliteInstances();
});
