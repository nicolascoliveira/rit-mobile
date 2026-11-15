import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  getSqliteKv,
  setSqliteKv,
  extractTenantIdFromPath,
  getSqliteInstance,
  runInTransaction,
  backfillRelationalTables
} from './sqlite.js';
import { validateEvolutionUrl } from './net-guard.js';
import { sealTenantSecret, openTenantSecret } from './migrate-security.js';

const SLUG_RE = /^[a-z0-9_-]{2,50}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DEFAULT_BRANDING = {
  gymName: 'Rit',
  slogan: 'Seu treino, sua evolução',
  primaryColor: '#D0FF00',
  accentColor: '#a8cc00',
  logoUrl: '',
  contactPhone: '',
  address: '',
  instagram: '',
  seasonalTheme: 'auto'
};

export const DEFAULT_TENANT_SETTINGS = {
  inviteOnly: false,
  allowGuest: false,
  churnDaysThreshold: 5,
  welcomeMessage: 'Bem-vindo ao nosso app oficial de treinos! Confira sua ficha do dia.',
  notifyTrainerOnWorkout: true,
  notifyStudentOnPrescribe: true,
  evolutionUrl: '',
  evolutionInstance: '',
  hasEvolutionApiKey: false
};

/** Valor usado para "sem limite" (alunos ou professores). A tela mostra "ilimitado". */
export const UNLIMITED = 100000;

/**
 * Sobe quando a tabela de planos padrão muda. Quem tem o banco com uma versão
 * mais antiga recebe os planos novos uma única vez (veja migrateLegacyPlans).
 */
export const PLANS_VERSION = 2;

/**
 * Planos da Rit. Os identificadores (id) são internos e ficam como estão para não quebrar
 * academias já cadastradas; o que o cliente vê é o `name`.
 *   personal      -> Personal Inicial   (tipo de conta: personal)
 *   personal-pro  -> Personal Completo  (tipo de conta: personal)
 *   starter       -> Estúdio
 *   pro           -> Academia Completa
 * `priceAnnualMonthly` é o valor por mês de quem paga o ano inteiro à vista no PIX.
 */
export const DEFAULT_SAAS_PLANS = [
  {
    id: 'personal',
    name: 'Personal Inicial',
    tagline: 'Personal trainer começando, com até 10 alunos',
    accountType: 'personal',
    priceMonthly: 29,
    priceAnnualMonthly: 24,
    maxStudents: 10,
    maxTrainers: 1,
    features: {
      whiteLabel: true,
      aiCoach: false,
      customExercises: true,
      whatsappAlerts: true,
      multiUnit: false
    }
  },
  {
    id: 'personal-pro',
    name: 'Personal Completo',
    tagline: 'Personal trainer com alunos ilimitados e consultoria online',
    accountType: 'personal',
    priceMonthly: 49,
    priceAnnualMonthly: 39,
    maxStudents: UNLIMITED,
    maxTrainers: 1,
    features: {
      whiteLabel: true,
      aiCoach: false,
      customExercises: true,
      whatsappAlerts: true,
      multiUnit: false
    }
  },
  {
    id: 'starter',
    name: 'Estúdio',
    tagline: 'Estúdios e academias pequenas, até 150 alunos e 3 professores',
    accountType: 'gym',
    priceMonthly: 169,
    priceAnnualMonthly: 139,
    maxStudents: 150,
    maxTrainers: 3,
    features: {
      whiteLabel: true,
      aiCoach: false,
      customExercises: true,
      whatsappAlerts: true,
      multiUnit: false
    }
  },
  {
    id: 'pro',
    name: 'Academia Completa',
    tagline: 'Academias com alunos e professores ilimitados',
    accountType: 'gym',
    priceMonthly: 269,
    priceAnnualMonthly: 219,
    maxStudents: UNLIMITED,
    maxTrainers: UNLIMITED,
    recommended: true,
    features: {
      whiteLabel: true,
      aiCoach: false,
      customExercises: true,
      whatsappAlerts: true,
      multiUnit: false
    }
  }
];

/** Planos que existiam antes da tabela da Rit (substituídos pela migração). */
const LEGACY_PLAN_IDS = new Set(['personal', 'starter', 'pro', 'enterprise']);

/** O plano é de personal trainer? (vale também para planos antigos sem o campo `accountType`) */
export function isPersonalPlan(plan) {
  return plan?.accountType === 'personal' || plan?.id === 'personal';
}

/**
 * Leva um banco com os planos antigos (R$ 89, 197, 347 e 697) para a tabela da Rit.
 * - troca os 4 planos antigos pelos novos e mantém os planos criados à mão;
 * - quem estava no plano "enterprise" (que deixou de existir) vai para "pro" (Academia Completa);
 * - a mensalidade (mrr) só é atualizada se ainda era o preço de tabela do plano antigo,
 *   então um valor combinado à parte com o cliente é preservado.
 */
function migrateLegacyPlans(plans, tenants) {
  const oldPrice = {};
  for (const p of plans) if (LEGACY_PLAN_IDS.has(p.id)) oldPrice[p.id] = Number(p.priceMonthly);

  const custom = plans.filter(p => !LEGACY_PLAN_IDS.has(p.id));
  const migratedPlans = [...structuredClone(DEFAULT_SAAS_PLANS), ...custom];

  const migratedTenants = {};
  for (const [id, entry] of Object.entries(tenants || {})) {
    const fromPlan = entry?.planId;
    const toPlan = fromPlan === 'enterprise' ? 'pro' : fromPlan;
    const next = { ...entry };
    if (toPlan !== fromPlan) next.planId = toPlan;
    if (fromPlan in oldPrice && Number(entry.mrr) === oldPrice[fromPlan]) {
      const target = migratedPlans.find(p => p.id === (toPlan || 'pro'));
      if (target) next.mrr = target.priceMonthly;
    }
    migratedTenants[id] = next;
  }
  return { plans: migratedPlans, tenants: migratedTenants };
}

const RESERVED_TENANT_SLUGS = new Set([
  'default',
  'www',
  'api',
  'app',
  'painel',
  'portal',
  'gestao',
  'admin',
  'localhost'
]);

/**
 * Sanitiza o identificador do tenant (slug).
 */
export function sanitizeTenantId(raw) {
  if (!raw || typeof raw !== 'string') return 'default';
  const clean = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!clean || RESERVED_TENANT_SLUGS.has(clean)) return 'default';
  return clean.slice(0, 50);
}

/**
 * Resolve o identificador da academia (tenant) a partir da requisição HTTP:
 * 1. Header `x-tenant-id`
 * 2. Query parameter `?tenant=slug`
 * 3. Subdomínio (ex: `iron.seusistema.com.br` ou `iron.localhost`)
 * 4. Padrão: 'default'
 */
export function resolveTenantId(req) {
  const header = req?.headers?.['x-tenant-id'];
  if (header && typeof header === 'string') {
    const s = sanitizeTenantId(header);
    if (s && s !== 'default') return s;
  }

  try {
    const rawUrl = req?.url || '';
    const qIdx = rawUrl.indexOf('?');
    if (qIdx !== -1) {
      const sp = new URLSearchParams(rawUrl.slice(qIdx));
      const q = sp.get('tenant');
      if (q) {
        const s = sanitizeTenantId(q);
        if (s && s !== 'default') return s;
      }
    }
  } catch { /* ignore */ }

  const host = (req?.headers?.host || '').split(':')[0].toLowerCase();
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    const parts = host.split('.');
    if (parts.length >= 2) {
      const sub = parts[0];
      if (sub && !RESERVED_TENANT_SLUGS.has(sub) && !/^\d+$/.test(sub)) {
        const s = sanitizeTenantId(sub);
        if (s && s !== 'default') return s;
      }
    }
  }

  return 'default';
}

/**
 * Resolve o tenant efetivo considerando o usuário autenticado.
 * Usuários autenticados que não sejam superadmin ficam estritamente presos ao seu próprio
 * `user.tenantId || 'default'`, impedindo spoofing/troca via `?tenant=`, header ou subdomínio.
 */
export function resolveEffectiveTenantId(req, user) {
  if (user && user.saasRole !== 'superadmin') {
    return sanitizeTenantId(user.tenantId) || 'default';
  }
  const reqTenant = resolveTenantId(req);
  if (reqTenant === 'default' && user?.tenantId) {
    return sanitizeTenantId(user.tenantId) || 'default';
  }
  return reqTenant;
}

/**
 * Retorna o diretório isolado do tenant, garantindo que ele exista no disco.
 */
export function getTenantDir(baseDataDir, tenantId) {
  const safeId = sanitizeTenantId(tenantId);
  const tenantDir = path.join(baseDataDir, 'tenants', safeId);
  fs.mkdirSync(tenantDir, { recursive: true });
  return tenantDir;
}

const DEFAULT_PLATFORM = {
  name: 'Rit Cloud',
  supportEmail: 'contato@treinerit.com.br',
  supportPhone: '(91) 98556-1302',
  trialDays: 14
};

function toMs(val, fallback = null) {
  if (val == null || val === '') return fallback;
  if (typeof val === 'number' && Number.isFinite(val)) return Math.trunc(val);
  const parsed = Date.parse(String(val));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getSaasMetaFromInst(inst) {
  const metaRow = inst.stmts.getKvWithMeta.get('saas_meta');
  const kvRow = inst.stmts.getKvWithMeta.get('saas_store');
  let metaObj = null;
  let kvObj = null;
  if (metaRow) {
    try { metaObj = JSON.parse(metaRow.value); } catch { metaObj = null; }
  }
  if (kvRow) {
    try { kvObj = JSON.parse(kvRow.value); } catch { kvObj = null; }
  }
  const src = (kvObj && (!metaRow || Number(kvRow.updated_at) >= Number(metaRow.updated_at)))
    ? kvObj
    : (metaObj || kvObj || {});
  return {
    plansVersion: src?.plansVersion || (kvObj || metaObj ? 1 : PLANS_VERSION),
    platform: { ...DEFAULT_PLATFORM, ...(src?.platform || {}) },
    seededAt: src?.seededAt || null
  };
}

function readPlansFromInst(inst) {
  const rows = inst.stmts.getAllSaasPlans.all();
  if (!rows.length) return structuredClone(DEFAULT_SAAS_PLANS);
  return rows.map(r => JSON.parse(r.data));
}

function readInvoicesFromInst(inst, tenantId) {
  return inst.stmts.getTenantInvoices.all(tenantId).map(r => JSON.parse(r.data));
}

function syncSaasMirrorInTx(inst, metaOverride = null) {
  const now = Date.now();
  const prevMeta = getSaasMetaFromInst(inst);
  const meta = {
    plansVersion: metaOverride?.plansVersion ?? prevMeta.plansVersion ?? PLANS_VERSION,
    platform: { ...DEFAULT_PLATFORM, ...(prevMeta.platform || {}), ...(metaOverride?.platform || {}) },
    seededAt: metaOverride?.seededAt !== undefined ? metaOverride.seededAt : prevMeta.seededAt
  };
  const plans = readPlansFromInst(inst);
  const tenants = {};
  for (const row of inst.stmts.getAllTenants.all()) {
    const tMeta = JSON.parse(row.data);
    const branding = JSON.parse(row.branding || '{}');
    const invoices = readInvoicesFromInst(inst, row.id);
    tenants[row.id] = {
      ...tMeta,
      id: row.id,
      planId: row.plan_id || tMeta.planId,
      status: row.status || tMeta.status,
      branding,
      invoices
    };
  }
  const fullStore = {
    plansVersion: meta.plansVersion,
    plans,
    tenants,
    platform: meta.platform,
    seededAt: meta.seededAt
  };
  inst.stmts.setKv.run('saas_meta', JSON.stringify(meta), now);
  inst.stmts.setKv.run('saas_store', JSON.stringify(fullStore), now);
  inst.stmts.setKv.run('saas_relational_sync_ts', JSON.stringify(now), now);
  return fullStore;
}

function ensurePlansPopulatedInTx(inst, now = Date.now()) {
  const existing = inst.stmts.getAllSaasPlans.all();
  if (existing.length > 0) return existing.map(r => JSON.parse(r.data));
  const defaults = structuredClone(DEFAULT_SAAS_PLANS);
  defaults.forEach((p, idx) => {
    inst.stmts.upsertSaasPlanRow.run(String(p.id), idx, JSON.stringify(p), now);
  });
  return defaults;
}

function normalizeAndSealTenantSettings(baseDataDir, cleanId, incoming = {}, prev = {}, { validateExistingUrl = false } = {}) {
  const prevSettings = prev && typeof prev === 'object' ? prev : {};
  const nextPatch = incoming && typeof incoming === 'object' ? incoming : {};

  const hasUrlPatch = nextPatch.evolutionUrl !== undefined;
  const rawEvoUrl = hasUrlPatch
    ? String(nextPatch.evolutionUrl ?? '').trim().replace(/\/+$/, '').slice(0, 300)
    : String(prevSettings.evolutionUrl || '').trim();

  if (rawEvoUrl && (hasUrlPatch || validateExistingUrl)) {
    const val = validateEvolutionUrl(rawEvoUrl, { allowInternalPlatform: false });
    if (!val.ok) {
      throw new Error(val.error);
    }
  }

  let prevEnc = typeof prevSettings.evolutionApiKeyEnc === 'string'
    ? prevSettings.evolutionApiKeyEnc.trim()
    : '';
  if (!prevEnc && typeof prevSettings.evolutionApiKey === 'string') {
    const legacyPlain = prevSettings.evolutionApiKey.trim();
    if (legacyPlain && legacyPlain !== '***') {
      prevEnc = sealTenantSecret(legacyPlain, { tenantId: cleanId, dataDir: baseDataDir });
    }
  }

  let nextEnc = prevEnc;
  const clearKey = nextPatch.clearEvolutionApiKey === true || nextPatch.evolutionApiKey === null;
  if (clearKey) {
    nextEnc = '';
  } else if (typeof nextPatch.evolutionApiKey === 'string') {
    const trimmedKey = nextPatch.evolutionApiKey.trim().slice(0, 200);
    if (trimmedKey && trimmedKey !== '***') {
      nextEnc = sealTenantSecret(trimmedKey, { tenantId: cleanId, dataDir: baseDataDir });
    }
  }

  const rawEvoInstance = nextPatch.evolutionInstance !== undefined
    ? String(nextPatch.evolutionInstance ?? '').trim().replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64)
    : String(prevSettings.evolutionInstance || '').trim();
  const churnRaw = Number(nextPatch.churnDaysThreshold ?? prevSettings.churnDaysThreshold ?? 5);
  const welcomeRaw = nextPatch.welcomeMessage !== undefined
    ? String(nextPatch.welcomeMessage ?? '')
    : String(prevSettings.welcomeMessage ?? DEFAULT_TENANT_SETTINGS.welcomeMessage);

  return {
    inviteOnly: Boolean(nextPatch.inviteOnly ?? prevSettings.inviteOnly ?? false),
    allowGuest: Boolean(nextPatch.allowGuest ?? prevSettings.allowGuest ?? false),
    churnDaysThreshold: Number.isFinite(churnRaw) ? Math.max(1, Math.min(90, churnRaw)) : 5,
    welcomeMessage: welcomeRaw.slice(0, 300),
    notifyTrainerOnWorkout: Boolean(nextPatch.notifyTrainerOnWorkout ?? prevSettings.notifyTrainerOnWorkout ?? true),
    notifyStudentOnPrescribe: Boolean(nextPatch.notifyStudentOnPrescribe ?? prevSettings.notifyStudentOnPrescribe ?? true),
    evolutionUrl: rawEvoUrl,
    evolutionApiKeyEnc: nextEnc,
    evolutionInstance: rawEvoInstance
  };
}

function buildTenantRecordDto(cleanId, entry, brandingRaw, plans) {
  const branding = {
    ...DEFAULT_BRANDING,
    ...(brandingRaw || {}),
    ...(entry?.branding || {})
  };
  const plan = plans.find(p => p.id === (entry?.planId || 'pro')) || plans[0];
  const accountType = entry?.accountType === 'personal' || isPersonalPlan(plan) ? 'personal' : 'gym';
  const rawSettings = entry?.settings && typeof entry.settings === 'object' ? entry.settings : {};
  const {
    evolutionApiKey: legacyPlainEvoKey,
    evolutionApiKeyEnc: sealedEvoKey,
    clearEvolutionApiKey: _clearFlag,
    ...publicSettings
  } = rawSettings;
  const hasEvolutionApiKey = Boolean(
    String(sealedEvoKey || '').trim() ||
    (String(legacyPlainEvoKey || '').trim() && String(legacyPlainEvoKey || '').trim() !== '***')
  );
  return {
    id: cleanId,
    accountType,
    name: entry?.name || branding.gymName || cleanId,
    document: entry?.document || '',
    ownerName: entry?.ownerName || '',
    ownerEmail: entry?.ownerEmail || '',
    ownerUserId: entry?.ownerUserId || null,
    phone: entry?.phone || branding.contactPhone || '',
    city: entry?.city || '',
    address: entry?.address || branding.address || '',
    planId: plan.id,
    planName: plan.name,
    mrr: entry?.mrr !== undefined ? Number(entry.mrr) : plan.priceMonthly,
    status: entry?.status || 'active',
    trialEndsAt: entry?.trialEndsAt || null,
    nextBillingAt: entry?.nextBillingAt || null,
    createdAt: entry?.createdAt || new Date().toISOString(),
    updatedAt: entry?.updatedAt || null,
    notes: entry?.notes || '',
    branding,
    settings: {
      ...DEFAULT_TENANT_SETTINGS,
      ...publicSettings,
      hasEvolutionApiKey
    },
    limits: {
      maxStudents: entry?.maxStudentsOverride || plan.maxStudents,
      maxTrainers: entry?.maxTrainersOverride || plan.maxTrainers,
      features: plan.features
    },
    invoices: Array.isArray(entry?.invoices) ? entry.invoices : []
  };
}

/**
 * Lê o registro central do SaaS a partir das tabelas relacionais do SQLite (migrando planos v1 se preciso).
 */
export function loadSaasStore(baseDataDir) {
  const inst = getSqliteInstance(baseDataDir);
  backfillRelationalTables(inst);

  const planRows = inst.stmts.getAllSaasPlans.all();
  const tenantRows = inst.stmts.getAllTenants.all();
  const kvFallback = inst.stmts.getKv.get('saas_store');

  if (planRows.length === 0 && tenantRows.length === 0 && !kvFallback) {
    return {
      plansVersion: PLANS_VERSION,
      plans: structuredClone(DEFAULT_SAAS_PLANS),
      tenants: {},
      platform: { ...DEFAULT_PLATFORM },
      seededAt: null
    };
  }

  const meta = getSaasMetaFromInst(inst);
  let plans = planRows.length ? planRows.map(r => JSON.parse(r.data)) : structuredClone(DEFAULT_SAAS_PLANS);
  let tenants = {};
  for (const row of tenantRows) {
    const tMeta = JSON.parse(row.data);
    const branding = JSON.parse(row.branding || '{}');
    const invoices = readInvoicesFromInst(inst, row.id);
    tenants[row.id] = {
      ...tMeta,
      id: row.id,
      planId: row.plan_id || tMeta.planId,
      status: row.status || tMeta.status,
      branding,
      invoices
    };
  }

  if ((meta.plansVersion || 1) < PLANS_VERSION) {
    const migrated = migrateLegacyPlans(plans, tenants);
    const upgraded = {
      plansVersion: PLANS_VERSION,
      plans: migrated.plans,
      tenants: migrated.tenants,
      platform: meta.platform,
      seededAt: meta.seededAt
    };
    saveSaasStore(baseDataDir, upgraded);
    return upgraded;
  }

  return {
    plansVersion: PLANS_VERSION,
    plans,
    tenants,
    platform: meta.platform,
    seededAt: meta.seededAt
  };
}

/**
 * Persiste o registro SaaS atomicamente nas tabelas relacionais e no espelho `kv_store`.
 */
export function saveSaasStore(baseDataDir, store) {
  const inst = getSqliteInstance(baseDataDir);
  const now = Date.now();
  const nextMeta = {
    plansVersion: store?.plansVersion || PLANS_VERSION,
    platform: { ...DEFAULT_PLATFORM, ...(store?.platform || {}) },
    seededAt: store?.seededAt || null
  };

  return runInTransaction(inst, () => {
    const plans = Array.isArray(store?.plans) && store.plans.length
      ? store.plans
      : structuredClone(DEFAULT_SAAS_PLANS);
    inst.stmts.clearSaasPlans.run();
    plans.forEach((p, idx) => {
      if (!p?.id) return;
      inst.stmts.upsertSaasPlanRow.run(String(p.id), idx, JSON.stringify(p), now);
    });

    const inputTenants = store?.tenants && typeof store.tenants === 'object' ? store.tenants : {};
    const keepIds = new Set(Object.keys(inputTenants).map(k => sanitizeTenantId(k)).filter(k => k && k !== 'default'));
    for (const existingRow of inst.stmts.getAllTenants.all()) {
      if (!keepIds.has(existingRow.id)) {
        inst.stmts.deleteTenantInvoices.run(existingRow.id);
        inst.stmts.deleteTenantRow.run(existingRow.id);
      }
    }

    for (const [rawSlug, tRaw] of Object.entries(inputTenants)) {
      if (!tRaw || typeof tRaw !== 'object') continue;
      const slug = sanitizeTenantId(tRaw.id || rawSlug);
      if (!slug || slug === 'default') continue;
      const { invoices: rawInvoices, branding: rawBranding, ...tMeta } = tRaw;
      const branding = { ...DEFAULT_BRANDING, ...(rawBranding || {}) };
      if (tMeta.settings && typeof tMeta.settings === 'object' && Object.prototype.hasOwnProperty.call(tMeta.settings, 'evolutionApiKey')) {
        const plainKey = typeof tMeta.settings.evolutionApiKey === 'string' ? tMeta.settings.evolutionApiKey.trim() : '';
        const { evolutionApiKey: _dropPlain, clearEvolutionApiKey: _dropClear, ...restSettings } = tMeta.settings;
        if (plainKey && plainKey !== '***' && !restSettings.evolutionApiKeyEnc) {
          restSettings.evolutionApiKeyEnc = sealTenantSecret(plainKey, { tenantId: slug, dataDir: baseDataDir });
        }
        tMeta.settings = restSettings;
      }
      inst.stmts.upsertTenantRow.run(
        slug,
        String(tRaw.planId || 'pro'),
        String(tRaw.status || 'active'),
        JSON.stringify({ ...tMeta, id: slug }),
        JSON.stringify(branding),
        '[]',
        toMs(tRaw.updatedAt, now)
      );
      inst.stmts.setKv.run(`branding:${slug}`, JSON.stringify(branding), now);

      inst.stmts.deleteTenantInvoices.run(slug);
      const invList = Array.isArray(rawInvoices) ? rawInvoices : [];
      for (const inv of invList) {
        if (!inv || !inv.id) continue;
        const expMs = toMs(inv.expiresAt);
        const st = String(inv.status || 'paid');
        const isCheckoutPending = inv.kind === 'pix_checkout'
          || Boolean(inv.mpPaymentId && (st === 'pending' || st === 'checkout_creating') && (!expMs || expMs > now));
        inst.stmts.upsertInvoiceRow.run(
          String(inv.id),
          slug,
          inv.planId ? String(inv.planId) : (tRaw.planId ? String(tRaw.planId) : null),
          isCheckoutPending ? 'pix_checkout' : String(inv.kind || 'invoice'),
          Math.max(0, Math.round(Number(inv.amount || 0) * 100)),
          st,
          inv.method ? String(inv.method) : null,
          inv.mpPaymentId ? String(inv.mpPaymentId) : null,
          inv.idempotencyKey ? String(inv.idempotencyKey) : null,
          toMs(inv.createdAt, now),
          toMs(inv.paidAt),
          expMs,
          JSON.stringify(inv)
        );
      }
    }

    return syncSaasMirrorInTx(inst, nextMeta);
  });
}

export function listSaasPlans(baseDataDir) {
  return loadSaasStore(baseDataDir).plans;
}

export function getSaasPlan(baseDataDir, planId) {
  const plans = listSaasPlans(baseDataDir);
  return plans.find(p => p.id === planId) || plans[0];
}

export function upsertSaasPlan(baseDataDir, planInput) {
  const id = sanitizeTenantId(planInput.id || planInput.name || '');
  if (!id || id === 'default') throw new Error('Identificador de plano inválido');
  const inst = getSqliteInstance(baseDataDir);
  backfillRelationalTables(inst);

  return runInTransaction(inst, () => {
    const now = Date.now();
    const plans = ensurePlansPopulatedInTx(inst, now);
    const existingIdx = plans.findIndex(p => p.id === id);
    const prev = existingIdx >= 0 ? plans[existingIdx] : {};
    const priceMonthly = Math.max(0, Number(planInput.priceMonthly ?? prev.priceMonthly ?? 169));
    const record = {
      ...prev,
      id,
      name: String(planInput.name || prev.name || id).trim(),
      tagline: String(planInput.tagline ?? prev.tagline ?? '').trim(),
      accountType: planInput.accountType || prev.accountType || (id.startsWith('personal') ? 'personal' : 'gym'),
      priceMonthly,
      priceAnnualMonthly: Math.max(0, Number(planInput.priceAnnualMonthly ?? prev.priceAnnualMonthly ?? priceMonthly)),
      maxStudents: Math.max(1, Math.floor(Number(planInput.maxStudents ?? prev.maxStudents ?? 150))),
      maxTrainers: Math.max(1, Math.floor(Number(planInput.maxTrainers ?? prev.maxTrainers ?? 3))),
      recommended: Boolean(planInput.recommended ?? prev.recommended ?? false),
      features: {
        whiteLabel: true,
        aiCoach: false,
        customExercises: true,
        whatsappAlerts: true,
        multiUnit: false,
        ...(prev.features || {}),
        ...(planInput.features || {})
      }
    };
    const sortOrder = existingIdx >= 0 ? existingIdx : plans.length;
    inst.stmts.upsertSaasPlanRow.run(id, sortOrder, JSON.stringify(record), now);
    syncSaasMirrorInTx(inst);
    return record;
  });
}

/**
 * Carrega a personalização visual (branding) a partir do SQLite.
 */
export function loadTenantBranding(tenantDir) {
  const slug = extractTenantIdFromPath(tenantDir);
  const data = getSqliteKv(tenantDir, `branding:${slug}`, null);
  if (data && typeof data === 'object') {
    return { ...DEFAULT_BRANDING, ...data };
  }
  const inst = getSqliteInstance(tenantDir);
  const tRow = inst.stmts.getTenantRow.get(slug);
  if (tRow?.branding) {
    try { return { ...DEFAULT_BRANDING, ...JSON.parse(tRow.branding) }; } catch { /* ignore */ }
  }
  return { ...DEFAULT_BRANDING };
}

/**
 * Salva a personalização visual da academia no SQLite (atomically com a linha do tenant).
 */
export function saveTenantBranding(tenantDir, branding) {
  const slug = extractTenantIdFromPath(tenantDir);
  const allowed = {};
  for (const k of ['gymName', 'slogan', 'primaryColor', 'accentColor', 'logoUrl', 'contactPhone', 'address', 'instagram', 'seasonalTheme']) {
    if (branding && branding[k] !== undefined) {
      const rawVal = String(branding[k] ?? '').trim();
      if (k === 'logoUrl') {
        allowed[k] = rawVal.startsWith('blob:') ? '' : rawVal.slice(0, 160000);
      } else {
        allowed[k] = rawVal.slice(0, 300);
      }
    }
  }
  const inst = getSqliteInstance(tenantDir);
  return runInTransaction(inst, () => {
    const merged = { ...loadTenantBranding(tenantDir), ...allowed };
    if (allowed.primaryColor && !allowed.accentColor) merged.accentColor = allowed.primaryColor;
    const now = Date.now();
    inst.stmts.setKv.run(`branding:${slug}`, JSON.stringify(merged), now);
    const tRow = inst.stmts.getTenantRow.get(slug);
    if (tRow) {
      inst.stmts.upsertTenantRow.run(
        slug,
        tRow.plan_id,
        tRow.status,
        tRow.data,
        JSON.stringify(merged),
        tRow.templates || '[]',
        now
      );
      syncSaasMirrorInTx(inst);
    }
    return merged;
  });
}

/**
 * Obtém o registro completo de uma academia pelo `tenantId` (no SQLite).
 */
export function getTenant(baseDataDir, tenantId) {
  const cleanId = sanitizeTenantId(tenantId);
  if (cleanId === 'default') return null;
  const store = loadSaasStore(baseDataDir);
  const entry = store.tenants[cleanId];
  const storedBranding = getSqliteKv(baseDataDir, `branding:${cleanId}`, null);
  if (!entry && !storedBranding) return null;
  return buildTenantRecordDto(cleanId, entry, storedBranding, store.plans);
}

/**
 * Resolve as credenciais da Evolution API do tenant exclusivamente no servidor,
 * decifrando `evolutionApiKeyEnc` em memória sem nunca expor o segredo em DTOs públicos.
 */
export function resolveTenantEvolutionSettings(baseDataDir, tenantId) {
  const cleanId = sanitizeTenantId(tenantId);
  if (!cleanId || cleanId === 'default' || !baseDataDir || baseDataDir === '/tmp') {
    return {
      evolutionUrl: '',
      evolutionApiKey: '',
      evolutionInstance: '',
      notifyTrainerOnWorkout: true,
      notifyStudentOnPrescribe: true
    };
  }
  let entry = null;
  try {
    const inst = getSqliteInstance(baseDataDir);
    backfillRelationalTables(inst);
    const row = inst.stmts.getTenantRow.get(cleanId);
    if (row?.data) entry = JSON.parse(row.data);
  } catch {
    entry = null;
  }
  if (!entry) {
    try {
      const store = loadSaasStore(baseDataDir);
      entry = store.tenants?.[cleanId] || null;
    } catch {
      entry = null;
    }
  }
  const s = entry?.settings && typeof entry.settings === 'object' ? entry.settings : {};
  const sealed = typeof s.evolutionApiKeyEnc === 'string' ? s.evolutionApiKeyEnc.trim() : '';
  let evolutionApiKey = '';
  if (sealed) {
    evolutionApiKey = openTenantSecret(sealed, { tenantId: cleanId, dataDir: baseDataDir });
  } else if (typeof s.evolutionApiKey === 'string') {
    const legacy = s.evolutionApiKey.trim();
    if (legacy && legacy !== '***') evolutionApiKey = legacy;
  }
  return {
    evolutionUrl: String(s.evolutionUrl || '').trim(),
    evolutionApiKey,
    evolutionInstance: String(s.evolutionInstance || '').trim(),
    notifyTrainerOnWorkout: s.notifyTrainerOnWorkout !== false,
    notifyStudentOnPrescribe: s.notifyStudentOnPrescribe !== false
  };
}

export function getTenantAccessState(baseDataDir, tenantId, nowMs = Date.now()) {
  const cleanId = sanitizeTenantId(tenantId);
  if (!cleanId || cleanId === 'default') {
    return { blocked: false, billingOnly: false, reason: null, status: 'active' };
  }
  const t = getTenant(baseDataDir, cleanId);
  if (!t) {
    return { blocked: false, billingOnly: false, reason: null, status: 'active' };
  }
  if (t.status === 'suspended') {
    return { blocked: true, billingOnly: false, reason: 'suspended', status: 'suspended', tenant: t };
  }
  if (t.status === 'past_due') {
    return { blocked: true, billingOnly: true, reason: 'past_due', status: 'past_due', tenant: t };
  }
  if (t.status === 'trial') {
    const trialMs = t.trialEndsAt ? Date.parse(t.trialEndsAt) : NaN;
    if (Number.isFinite(trialMs) && trialMs <= nowMs) {
      return { blocked: true, billingOnly: true, reason: 'trial_expired', status: 'trial', tenant: t };
    }
  }
  return { blocked: false, billingOnly: false, reason: null, status: t.status || 'active', tenant: t };
}

export function isTenantSuspended(baseDataDir, tenantId, nowMs = Date.now()) {
  return getTenantAccessState(baseDataDir, tenantId, nowMs).blocked;
}

/**
 * Provisiona uma nova academia atomicamente no SQLite (`BEGIN IMMEDIATE`) e garante unicidade por slug.
 */
export function createTenant(baseDataDir, payload = {}) {
  const cleanId = sanitizeTenantId(payload.id || payload.slug || '');
  if (!cleanId || cleanId === 'default' || !SLUG_RE.test(cleanId)) {
    throw new Error('Identificador de academia inválido (use apenas letras minúsculas, números e hífens, mín. 2 caracteres)');
  }

  const inst = getSqliteInstance(baseDataDir);
  backfillRelationalTables(inst);

  runInTransaction(inst, () => {
    const now = Date.now();
    if (inst.stmts.getTenantRow.get(cleanId)) {
      throw new Error(`Já existe uma academia cadastrada com o identificador "${cleanId}"`);
    }

    const plans = ensurePlansPopulatedInTx(inst, now);
    const meta = getSaasMetaFromInst(inst);
    const tDir = getTenantDir(baseDataDir, cleanId);

    const plan = plans.find(p => p.id === payload.planId) || plans.find(p => p.id === 'pro') || plans[0];
    const nowIso = new Date(now).toISOString();
    const gymName = String(payload.name || payload.gymName || cleanId).trim();
    const primaryColor = payload.primaryColor || DEFAULT_BRANDING.primaryColor;
    const sealedSettings = normalizeAndSealTenantSettings(
      baseDataDir,
      cleanId,
      payload.settings || {},
      {},
      { validateExistingUrl: true }
    );

    const branding = saveTenantBranding(tDir, {
      gymName,
      slogan: payload.slogan || DEFAULT_BRANDING.slogan,
      primaryColor,
      accentColor: payload.accentColor || primaryColor,
      logoUrl: payload.logoUrl || '',
      contactPhone: payload.phone || payload.contactPhone || '',
      address: payload.address || '',
      instagram: payload.instagram || ''
    });

    const status = ['active', 'trial', 'past_due', 'suspended'].includes(payload.status) ? payload.status : 'active';
    const mrr = payload.mrr !== undefined && payload.mrr !== '' ? Math.max(0, Number(payload.mrr)) : plan.priceMonthly;
    const trialDays = Number(payload.trialDays || meta.platform.trialDays || 14);
    const trialEndsAt = status === 'trial'
      ? (payload.trialEndsAt || new Date(now + trialDays * 86400000).toISOString())
      : null;
    const nextBillingAt = payload.nextBillingAt || new Date(now + 30 * 86400000).toISOString();

    const initialInvoices = Array.isArray(payload.invoices) ? payload.invoices : (
      status === 'active' && mrr > 0 ? [{
        id: 'inv_' + crypto.randomBytes(5).toString('hex'),
        refMonth: nowIso.slice(0, 7),
        amount: mrr,
        status: 'paid',
        paidAt: nowIso,
        method: 'PIX / Cartão',
        note: 'Assinatura inicial'
      }] : []
    );

    const accountType = payload.accountType === 'personal' || isPersonalPlan(plan) ? 'personal' : 'gym';
    const tenantRecord = {
      id: cleanId,
      accountType,
      name: gymName,
      document: String(payload.document || '').trim(),
      ownerName: String(payload.ownerName || '').trim(),
      ownerEmail: String(payload.ownerEmail || '').trim().toLowerCase(),
      ownerUserId: payload.ownerUserId || null,
      phone: String(payload.phone || branding.contactPhone || '').trim(),
      city: String(payload.city || '').trim(),
      address: String(payload.address || branding.address || '').trim(),
      planId: plan.id,
      ...(payload.maxStudentsOverride ? { maxStudentsOverride: Number(payload.maxStudentsOverride) } : {}),
      ...(payload.maxTrainersOverride ? { maxTrainersOverride: Number(payload.maxTrainersOverride) } : {}),
      mrr,
      status,
      trialEndsAt,
      nextBillingAt,
      createdAt: payload.createdAt || nowIso,
      updatedAt: nowIso,
      notes: String(payload.notes || '').trim(),
      settings: sealedSettings
    };

    inst.stmts.upsertTenantRow.run(
      cleanId,
      plan.id,
      status,
      JSON.stringify(tenantRecord),
      JSON.stringify(branding),
      '[]',
      now
    );

    for (const inv of initialInvoices) {
      if (!inv || !inv.id) continue;
      inst.stmts.upsertInvoiceRow.run(
        String(inv.id),
        cleanId,
        inv.planId ? String(inv.planId) : plan.id,
        String(inv.kind || 'invoice'),
        Math.max(0, Math.round(Number(inv.amount || 0) * 100)),
        String(inv.status || 'paid'),
        inv.method ? String(inv.method) : null,
        inv.mpPaymentId ? String(inv.mpPaymentId) : null,
        inv.idempotencyKey ? String(inv.idempotencyKey) : null,
        toMs(inv.createdAt, now),
        toMs(inv.paidAt),
        toMs(inv.expiresAt),
        JSON.stringify(inv)
      );
    }

    syncSaasMirrorInTx(inst);
  });

  return getTenant(baseDataDir, cleanId);
}

/**
 * Atualiza dados cadastrais, plano, status, configurações ou branding dentro de `BEGIN IMMEDIATE`.
 */
export function updateTenant(baseDataDir, tenantId, patch = {}) {
  const cleanId = sanitizeTenantId(tenantId);
  if (!cleanId || cleanId === 'default') throw new Error('Identificador de academia inválido');

  const inst = getSqliteInstance(baseDataDir);
  backfillRelationalTables(inst);

  runInTransaction(inst, () => {
    const now = Date.now();
    const plans = ensurePlansPopulatedInTx(inst, now);
    const tRow = inst.stmts.getTenantRow.get(cleanId);
    const tDir = getTenantDir(baseDataDir, cleanId);
    const currentBranding = loadTenantBranding(tDir);
    const prevRecord = tRow ? JSON.parse(tRow.data) : {
      id: cleanId,
      name: currentBranding.gymName || cleanId,
      planId: 'pro',
      status: 'active',
      createdAt: new Date(now).toISOString(),
      settings: { ...DEFAULT_TENANT_SETTINGS }
    };

    const baseRecord = { ...prevRecord };
    if (patch.accountType === 'personal' || patch.accountType === 'gym') baseRecord.accountType = patch.accountType;
    if (patch.name !== undefined) baseRecord.name = String(patch.name).trim() || baseRecord.name;
    if (patch.document !== undefined) baseRecord.document = String(patch.document).trim();
    if (patch.ownerName !== undefined) baseRecord.ownerName = String(patch.ownerName).trim();
    if (patch.ownerEmail !== undefined) baseRecord.ownerEmail = String(patch.ownerEmail).trim().toLowerCase();
    if (patch.ownerUserId !== undefined) baseRecord.ownerUserId = patch.ownerUserId;
    if (patch.phone !== undefined) baseRecord.phone = String(patch.phone).trim();
    if (patch.city !== undefined) baseRecord.city = String(patch.city).trim();
    if (patch.address !== undefined) baseRecord.address = String(patch.address).trim();
    if (patch.notes !== undefined) baseRecord.notes = String(patch.notes).trim();

    if (patch.planId && plans.some(p => p.id === patch.planId)) {
      baseRecord.planId = patch.planId;
      if (patch.mrr === undefined) {
        const newPlan = plans.find(p => p.id === patch.planId);
        if (newPlan) baseRecord.mrr = newPlan.priceMonthly;
      }
    }
    if (patch.mrr !== undefined) baseRecord.mrr = Math.max(0, Number(patch.mrr));
    if (patch.status && ['active', 'trial', 'past_due', 'suspended'].includes(patch.status)) {
      baseRecord.status = patch.status;
      if (patch.status === 'trial' && !baseRecord.trialEndsAt) {
        baseRecord.trialEndsAt = new Date(now + 14 * 86400000).toISOString();
      }
    }
    if (patch.trialEndsAt !== undefined) baseRecord.trialEndsAt = patch.trialEndsAt;
    if (patch.nextBillingAt !== undefined) baseRecord.nextBillingAt = patch.nextBillingAt;
    if (patch.maxStudentsOverride !== undefined) baseRecord.maxStudentsOverride = patch.maxStudentsOverride ? Number(patch.maxStudentsOverride) : undefined;
    if (patch.maxTrainersOverride !== undefined) baseRecord.maxTrainersOverride = patch.maxTrainersOverride ? Number(patch.maxTrainersOverride) : undefined;

    let nextBranding = tRow?.branding ? JSON.parse(tRow.branding) : currentBranding;
    if (patch.branding || patch.primaryColor || patch.slogan || patch.name) {
      const brandingPatch = {
        ...(patch.branding || {}),
        ...(patch.name && !patch.branding?.gymName ? { gymName: String(patch.name).trim() } : {}),
        ...(patch.primaryColor ? { primaryColor: patch.primaryColor } : {}),
        ...(patch.slogan ? { slogan: patch.slogan } : {}),
        ...(patch.phone && !patch.branding?.contactPhone ? { contactPhone: patch.phone } : {}),
        ...(patch.address && !patch.branding?.address ? { address: patch.address } : {})
      };
      nextBranding = saveTenantBranding(tDir, brandingPatch);
      if (patch.branding?.gymName && !patch.name) baseRecord.name = nextBranding.gymName;
    }

    if (patch.settings && typeof patch.settings === 'object') {
      baseRecord.settings = normalizeAndSealTenantSettings(
        baseDataDir,
        cleanId,
        patch.settings,
        baseRecord.settings || {},
        { validateExistingUrl: false }
      );
    }

    baseRecord.updatedAt = new Date(now).toISOString();
    inst.stmts.upsertTenantRow.run(
      cleanId,
      String(baseRecord.planId || 'pro'),
      String(baseRecord.status || 'active'),
      JSON.stringify(baseRecord),
      JSON.stringify(nextBranding || {}),
      tRow?.templates || '[]',
      now
    );
    syncSaasMirrorInTx(inst);
  });

  return getTenant(baseDataDir, cleanId);
}

/**
 * Registra ou atualiza uma fatura/pagamento B2B atomicamente no SQLite.
 * A extensão de `nextBillingAt` é protegida por UPDATE condicional (`status != 'paid'`).
 */
export function recordTenantInvoice(baseDataDir, tenantId, invoiceInput = {}) {
  const cleanId = sanitizeTenantId(tenantId);
  const inst = getSqliteInstance(baseDataDir);
  backfillRelationalTables(inst);

  return runInTransaction(inst, () => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const tRow = inst.stmts.getTenantRow.get(cleanId);
    if (!tRow) throw new Error('Academia não encontrada');
    const t = JSON.parse(tRow.data);

    if (invoiceInput.amount !== undefined && invoiceInput.amount !== null && invoiceInput.amount !== '') {
      const explicitAmount = Number(invoiceInput.amount);
      if (!Number.isFinite(explicitAmount) || explicitAmount <= 0) {
        throw new Error('O valor da fatura deve ser maior que zero');
      }
    }

    if (invoiceInput.id) {
      const existingRow = inst.stmts.getInvoiceById.get(String(invoiceInput.id));
      if (existingRow && existingRow.tenant_id === cleanId) {
        const existingInv = JSON.parse(existingRow.data);
        const nextStatus = invoiceInput.status || existingInv.status;
        const paidAtIso = nextStatus === 'paid' ? (existingInv.paidAt || invoiceInput.paidAt || nowIso) : existingInv.paidAt;
        const merged = {
          ...existingInv,
          ...invoiceInput,
          status: nextStatus,
          paidAt: paidAtIso
        };

        if (nextStatus === 'paid') {
          const upd = inst.stmts.markInvoicePaidConditional.run(
            toMs(paidAtIso, now),
            merged.mpPaymentId ? String(merged.mpPaymentId) : null,
            merged.method ? String(merged.method) : null,
            merged.planId ? String(merged.planId) : (t.planId ? String(t.planId) : null),
            Math.max(0, Math.round(Number(merged.amount || 0) * 100)),
            JSON.stringify(merged),
            existingRow.id
          );
          if (upd.changes === 1) {
            if (t.status === 'past_due' || t.status === 'trial' || t.status === 'suspended') {
              t.status = 'active';
            }
            const daysToAdd = (invoiceInput.cycle || merged.cycle) === 'annual' ? 365 : 30;
            const baseDate = t.nextBillingAt && new Date(t.nextBillingAt).getTime() > now
              ? new Date(t.nextBillingAt).getTime()
              : now;
            t.nextBillingAt = new Date(baseDate + daysToAdd * 86400000).toISOString();
          } else {
            return existingInv;
          }
        } else {
          inst.stmts.upsertInvoiceRow.run(
            existingRow.id,
            cleanId,
            merged.planId ? String(merged.planId) : null,
            String(merged.kind || existingRow.kind || 'invoice'),
            Math.max(0, Math.round(Number(merged.amount || 0) * 100)),
            String(nextStatus),
            merged.method ? String(merged.method) : null,
            merged.mpPaymentId ? String(merged.mpPaymentId) : null,
            merged.idempotencyKey ? String(merged.idempotencyKey) : null,
            existingRow.created_at,
            toMs(merged.paidAt),
            toMs(merged.expiresAt),
            JSON.stringify(merged)
          );
        }

        t.updatedAt = nowIso;
        inst.stmts.upsertTenantRow.run(cleanId, t.planId, t.status, JSON.stringify(t), tRow.branding, tRow.templates || '[]', now);
        syncSaasMirrorInTx(inst);
        return merged;
      }
    }

    const resolvedAmount = Number(invoiceInput.amount ?? t.mrr ?? 0);
    if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
      throw new Error('O valor da fatura deve ser maior que zero');
    }

    const inv = {
      id: invoiceInput.id || ('inv_' + crypto.randomBytes(5).toString('hex')),
      refMonth: String(invoiceInput.refMonth || nowIso.slice(0, 7)),
      amount: resolvedAmount,
      status: ['paid', 'pending', 'overdue', 'checkout_creating', 'failed', 'expired', 'cancelled'].includes(invoiceInput.status) ? invoiceInput.status : 'paid',
      paidAt: invoiceInput.status === 'paid' || (!invoiceInput.status && invoiceInput.status !== 'pending') ? (invoiceInput.paidAt || nowIso) : null,
      method: String(invoiceInput.method || 'PIX').slice(0, 60),
      note: String(invoiceInput.note || '').slice(0, 160),
      cycle: invoiceInput.cycle === 'annual' ? 'annual' : 'monthly',
      planId: invoiceInput.planId || t.planId || null,
      planName: invoiceInput.planName || null,
      mpPaymentId: invoiceInput.mpPaymentId || null,
      qrCode: invoiceInput.qrCode || null,
      qrCodeBase64: invoiceInput.qrCodeBase64 || null,
      ticketUrl: invoiceInput.ticketUrl || null,
      expiresAt: invoiceInput.expiresAt || null,
      createdAt: invoiceInput.createdAt || nowIso
    };

    inst.stmts.upsertInvoiceRow.run(
      inv.id,
      cleanId,
      inv.planId ? String(inv.planId) : null,
      String(invoiceInput.kind || 'invoice'),
      Math.max(0, Math.round(inv.amount * 100)),
      inv.status,
      inv.method,
      inv.mpPaymentId ? String(inv.mpPaymentId) : null,
      invoiceInput.idempotencyKey ? String(invoiceInput.idempotencyKey) : null,
      toMs(inv.createdAt, now),
      toMs(inv.paidAt),
      toMs(inv.expiresAt),
      JSON.stringify(inv)
    );

    if (inv.status === 'paid') {
      if (t.status === 'past_due' || t.status === 'trial' || t.status === 'suspended') t.status = 'active';
      const daysToAdd = inv.cycle === 'annual' ? 365 : 30;
      const baseDate = t.nextBillingAt && new Date(t.nextBillingAt).getTime() > now
        ? new Date(t.nextBillingAt).getTime()
        : now;
      t.nextBillingAt = new Date(baseDate + daysToAdd * 86400000).toISOString();
    } else if (inv.status === 'overdue' && t.status === 'active') {
      t.status = 'past_due';
    }
    t.updatedAt = nowIso;
    inst.stmts.upsertTenantRow.run(cleanId, t.planId, t.status, JSON.stringify(t), tRow.branding, tRow.templates || '[]', now);
    syncSaasMirrorInTx(inst);
    return inv;
  });
}

/**
 * Reserva ou reutiliza atomicamente um draft de checkout PIX (`kind = 'pix_checkout'`),
 * impedindo cobranças duplicadas no Mercado Pago quando 2 cliques/requisições chegam juntas.
 */
export function reservePixCheckoutInvoice(baseDataDir, tenantId, opts = {}) {
  const cleanId = sanitizeTenantId(tenantId);
  if (!cleanId || cleanId === 'default') throw new Error('Academia não encontrada');
  const inst = getSqliteInstance(baseDataDir);
  backfillRelationalTables(inst);

  return runInTransaction(inst, () => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const tRow = inst.stmts.getTenantRow.get(cleanId);
    if (!tRow) throw new Error('Academia não encontrada');
    const t = JSON.parse(tRow.data);
    const plans = ensurePlansPopulatedInTx(inst, now);
    const plan = plans.find(p => p.id === opts.planId) || plans.find(p => p.id === t.planId) || plans[0];
    const planId = plan.id;
    const cycle = opts.cycle === 'annual' ? 'annual' : 'monthly';
    const amount = opts.amount !== undefined
      ? Math.max(0.01, Number(opts.amount))
      : Math.max(0.01, Number(cycle === 'annual' ? (plan.priceAnnualMonthly || plan.priceMonthly) * 12 : plan.priceMonthly));

    // Expira PIX pendentes vencidos deste plano
    inst.stmts.expireStaleOpenCheckouts.run(cleanId, planId, now);

    const openRow = inst.stmts.getOpenCheckout.get(cleanId, planId);
    if (openRow) {
      const openInv = JSON.parse(openRow.data);
      if (openRow.status === 'checkout_creating') {
        if (Number(openRow.created_at) > now - 45000) {
          return {
            status: 'in_flight',
            invoice: openInv,
            tenant: buildTenantRecordDto(cleanId, { ...t, invoices: readInvoicesFromInst(inst, cleanId) }, JSON.parse(tRow.branding || '{}'), plans)
          };
        }
        // Draft órfão antigo (>45s): marca como failed e segue criando um novo
        const staleInv = { ...openInv, status: 'failed' };
        inst.stmts.upsertInvoiceRow.run(
          openRow.id, cleanId, planId, 'pix_checkout', openRow.amount_cents,
          'failed', openInv.method, openRow.mp_payment_id, openRow.idempotency_key,
          openRow.created_at, null, openRow.expires_at, JSON.stringify(staleInv)
        );
      } else if (openRow.status === 'pending') {
        if ((openInv.cycle || 'monthly') === cycle && openInv.qrCode) {
          return {
            status: 'reused',
            invoice: openInv,
            idempotencyKey: openRow.idempotency_key,
            tenant: buildTenantRecordDto(cleanId, { ...t, invoices: readInvoicesFromInst(inst, cleanId) }, JSON.parse(tRow.branding || '{}'), plans)
          };
        }
        // Usuário mudou de ciclo (mensal -> anual no mesmo plano) antes de pagar: cancela o PIX antigo pendente
        const cancelledInv = { ...openInv, status: 'cancelled' };
        inst.stmts.upsertInvoiceRow.run(
          openRow.id, cleanId, planId, 'pix_checkout', openRow.amount_cents,
          'cancelled', openInv.method, openRow.mp_payment_id, openRow.idempotency_key,
          openRow.created_at, null, openRow.expires_at, JSON.stringify(cancelledInv)
        );
      }
    }

    const requestedGwKey = (opts.gatewayIdempotencyKey && UUID_V4_RE.test(String(opts.gatewayIdempotencyKey).trim()))
      ? String(opts.gatewayIdempotencyKey).trim()
      : null;

    if (requestedGwKey) {
      const prevRow = inst.stmts.getInvoiceByIdem.get(requestedGwKey);
      if (prevRow && prevRow.tenant_id === cleanId && prevRow.plan_id === planId) {
        const prevInv = JSON.parse(prevRow.data);
        if ((prevInv.cycle || 'monthly') === cycle) {
          if (prevRow.status === 'pending' && prevInv.qrCode) {
            return {
              status: 'reused',
              invoice: prevInv,
              idempotencyKey: requestedGwKey,
              tenant: buildTenantRecordDto(cleanId, { ...t, invoices: readInvoicesFromInst(inst, cleanId) }, JSON.parse(tRow.branding || '{}'), plans)
            };
          }
          if (prevRow.status === 'failed' || prevRow.status === 'expired' || prevRow.status === 'cancelled') {
            const reactivated = inst.stmts.reactivateFailedCheckoutInvoice.get(now, now + 24 * 3600 * 1000, prevRow.id);
            if (reactivated) {
              const reactivatedInv = {
                ...prevInv,
                status: 'checkout_creating',
                amount,
                method: String(opts.method || prevInv.method || (cycle === 'annual' ? 'PIX Anual (Mercado Pago)' : 'PIX Mensal (Mercado Pago)')).slice(0, 60),
                note: String(opts.note || prevInv.note || `${plan.name} · ${cycle === 'annual' ? 'Plano Anual' : 'Mensalidade'}`).slice(0, 160),
                createdAt: nowIso
              };
              inst.stmts.upsertInvoiceRow.run(
                prevRow.id, cleanId, planId, 'pix_checkout', Math.max(0, Math.round(amount * 100)),
                'checkout_creating', reactivatedInv.method, prevRow.mp_payment_id, requestedGwKey,
                now, null, now + 24 * 3600 * 1000, JSON.stringify(reactivatedInv)
              );
              return {
                status: 'created',
                invoice: reactivatedInv,
                plan,
                cycle,
                amount,
                idempotencyKey: requestedGwKey,
                tenant: buildTenantRecordDto(cleanId, { ...t, invoices: readInvoicesFromInst(inst, cleanId) }, JSON.parse(tRow.branding || '{}'), plans)
              };
            }
          }
        }
      }
    }

    const invoiceId = 'inv_' + crypto.randomBytes(6).toString('hex');
    const idempotencyKey = requestedGwKey || crypto.randomUUID();
    const draftInv = {
      id: invoiceId,
      refMonth: String(opts.refMonth || nowIso.slice(0, 7)),
      amount,
      status: 'checkout_creating',
      paidAt: null,
      method: String(opts.method || (cycle === 'annual' ? 'PIX Anual (Mercado Pago)' : 'PIX Mensal (Mercado Pago)')).slice(0, 60),
      note: String(opts.note || `${plan.name} · ${cycle === 'annual' ? 'Plano Anual' : 'Mensalidade'}`).slice(0, 160),
      cycle,
      planId,
      planName: plan.name,
      mpPaymentId: null,
      qrCode: null,
      qrCodeBase64: null,
      ticketUrl: null,
      expiresAt: null,
      idempotencyKey,
      createdAt: nowIso
    };

    const ins = inst.stmts.insertInvoiceIgnore.run(
      invoiceId,
      cleanId,
      planId,
      'pix_checkout',
      Math.max(0, Math.round(amount * 100)),
      'checkout_creating',
      draftInv.method,
      null,
      idempotencyKey,
      now,
      null,
      now + 24 * 3600 * 1000,
      JSON.stringify(draftInv)
    );

    if (ins.changes !== 1) {
      const winner = inst.stmts.getOpenCheckout.get(cleanId, planId);
      const winnerInv = winner ? JSON.parse(winner.data) : draftInv;
      return {
        status: winner?.status === 'pending' && winnerInv?.qrCode ? 'reused' : 'in_flight',
        invoice: winnerInv,
        tenant: buildTenantRecordDto(cleanId, { ...t, invoices: readInvoicesFromInst(inst, cleanId) }, JSON.parse(tRow.branding || '{}'), plans)
      };
    }

    return {
      status: 'created',
      invoice: draftInv,
      plan,
      cycle,
      amount,
      idempotencyKey,
      tenant: buildTenantRecordDto(cleanId, { ...t, invoices: readInvoicesFromInst(inst, cleanId) }, JSON.parse(tRow.branding || '{}'), plans)
    };
  });
}

export function finalizePixCheckoutInvoice(baseDataDir, tenantId, invoiceId, pixData = {}) {
  const cleanId = sanitizeTenantId(tenantId);
  const inst = getSqliteInstance(baseDataDir);
  return runInTransaction(inst, () => {
    const now = Date.now();
    const row = inst.stmts.getInvoiceById.get(String(invoiceId));
    if (!row || row.tenant_id !== cleanId) throw new Error('Fatura de checkout não encontrada');
    const prev = JSON.parse(row.data);
    if (row.status === 'paid') return prev;
    const nextInv = {
      ...prev,
      status: 'pending',
      mpPaymentId: pixData.mpPaymentId ? String(pixData.mpPaymentId) : prev.mpPaymentId,
      qrCode: pixData.qrCode ?? prev.qrCode,
      qrCodeBase64: pixData.qrCodeBase64 ?? prev.qrCodeBase64,
      ticketUrl: pixData.ticketUrl ?? prev.ticketUrl,
      expiresAt: pixData.expiresAt ?? prev.expiresAt,
      ...(pixData.note ? { note: String(pixData.note).slice(0, 160) } : {})
    };
    const expMs = toMs(nextInv.expiresAt, now + 24 * 3600 * 1000);
    inst.stmts.upsertInvoiceRow.run(
      row.id, cleanId, row.plan_id, 'pix_checkout', row.amount_cents,
      'pending', nextInv.method, nextInv.mpPaymentId ? String(nextInv.mpPaymentId) : null,
      row.idempotency_key, row.created_at, null, expMs, JSON.stringify(nextInv)
    );
    syncSaasMirrorInTx(inst);
    return nextInv;
  });
}

export function failPixCheckoutInvoice(baseDataDir, tenantId, invoiceId) {
  const cleanId = sanitizeTenantId(tenantId);
  const inst = getSqliteInstance(baseDataDir);
  return runInTransaction(inst, () => {
    const row = inst.stmts.getInvoiceById.get(String(invoiceId));
    if (!row || row.tenant_id !== cleanId || row.status !== 'checkout_creating') return false;
    const prev = JSON.parse(row.data);
    const failed = { ...prev, status: 'failed' };
    inst.stmts.upsertInvoiceRow.run(
      row.id, cleanId, row.plan_id, 'pix_checkout', row.amount_cents,
      'failed', prev.method, row.mp_payment_id, row.idempotency_key,
      row.created_at, null, row.expires_at, JSON.stringify(failed)
    );
    syncSaasMirrorInTx(inst);
    return true;
  });
}

/**
 * Confirma o pagamento de uma fatura de forma estritamente atômica e idempotente (`BEGIN IMMEDIATE` + UPDATE condicional).
 */
export function confirmTenantPayment(baseDataDir, tenantId, opts = {}) {
  const cleanId = sanitizeTenantId(tenantId);
  if (!cleanId || cleanId === 'default') throw new Error('Academia não encontrada');
  const inst = getSqliteInstance(baseDataDir);
  backfillRelationalTables(inst);

  return runInTransaction(inst, () => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const tRow = inst.stmts.getTenantRow.get(cleanId);
    if (!tRow) throw new Error('Academia não encontrada');
    const t = JSON.parse(tRow.data);
    const brandingObj = JSON.parse(tRow.branding || '{}');
    const plans = readPlansFromInst(inst);

    const mpPid = opts.mpPaymentId ? String(opts.mpPaymentId) : null;
    let existingRow = opts.invoiceId ? inst.stmts.getInvoiceById.get(String(opts.invoiceId)) : null;
    if (existingRow && existingRow.tenant_id !== cleanId) existingRow = null;
    if (!existingRow && mpPid) {
      const byMp = inst.stmts.getInvoiceByMpPayment.get(mpPid);
      if (byMp) {
        if (byMp.tenant_id !== cleanId) {
          throw new Error('Pagamento Mercado Pago já associado a outra academia');
        }
        existingRow = byMp;
      }
    }

    if (existingRow && existingRow.status === 'paid') {
      const existingInv = JSON.parse(existingRow.data);
      const invoices = readInvoicesFromInst(inst, cleanId);
      return {
        alreadyPaid: true,
        invoice: existingInv,
        tenant: buildTenantRecordDto(cleanId, { ...t, invoices }, brandingObj, plans)
      };
    }

    const existing = existingRow ? JSON.parse(existingRow.data) : null;
    const requestedPlanId = opts.planId || existing?.planId || t.planId;
    const targetPlan = (requestedPlanId && plans.find(p => p.id === requestedPlanId))
      || plans.find(p => p.id === t.planId)
      || plans[0]
      || null;
    const cycle = (opts.cycle || existing?.cycle) === 'annual' ? 'annual' : 'monthly';
    const paidAt = opts.paidAt || nowIso;
    const paidAtMs = toMs(paidAt, now);
    const amount = opts.amount !== undefined
      ? Math.max(0, Number(opts.amount))
      : Math.max(0, Number(existing?.amount ?? (targetPlan
        ? (cycle === 'annual' ? (targetPlan.priceAnnualMonthly || targetPlan.priceMonthly) * 12 : targetPlan.priceMonthly)
        : t.mrr) ?? 0));

    let savedInvoice;
    if (existingRow) {
      savedInvoice = {
        ...existing,
        ...(opts.method ? { method: String(opts.method).slice(0, 60) } : {}),
        ...(opts.note ? { note: String(opts.note).slice(0, 160) } : {}),
        ...(mpPid ? { mpPaymentId: mpPid } : {}),
        ...(targetPlan ? { planId: targetPlan.id, planName: opts.planName || existing?.planName || targetPlan.name } : {}),
        cycle,
        amount,
        status: 'paid',
        paidAt
      };
      const upd = inst.stmts.markInvoicePaidConditional.run(
        paidAtMs,
        mpPid,
        savedInvoice.method ? String(savedInvoice.method) : null,
        targetPlan?.id ? String(targetPlan.id) : null,
        Math.max(0, Math.round(amount * 100)),
        JSON.stringify(savedInvoice),
        existingRow.id
      );
      if (upd.changes !== 1) {
        const invoices = readInvoicesFromInst(inst, cleanId);
        return {
          alreadyPaid: true,
          invoice: JSON.parse(inst.stmts.getInvoiceById.get(existingRow.id).data),
          tenant: buildTenantRecordDto(cleanId, { ...t, invoices }, brandingObj, plans)
        };
      }
    } else {
      savedInvoice = {
        id: opts.invoiceId || ('inv_' + crypto.randomBytes(5).toString('hex')),
        refMonth: String(opts.refMonth || nowIso.slice(0, 7)),
        amount,
        status: 'paid',
        paidAt,
        method: String(opts.method || 'PIX (Mercado Pago)').slice(0, 60),
        note: String(opts.note || '').slice(0, 160),
        cycle,
        planId: targetPlan?.id || t.planId || null,
        planName: opts.planName || targetPlan?.name || null,
        mpPaymentId: mpPid,
        qrCode: null,
        qrCodeBase64: null,
        ticketUrl: null,
        expiresAt: null,
        createdAt: nowIso
      };
      const ins = inst.stmts.insertInvoiceIgnore.run(
        savedInvoice.id,
        cleanId,
        savedInvoice.planId,
        'invoice',
        Math.max(0, Math.round(amount * 100)),
        'paid',
        savedInvoice.method,
        mpPid,
        null,
        now,
        paidAtMs,
        null,
        JSON.stringify(savedInvoice)
      );
      if (ins.changes !== 1) {
        const winner = mpPid
          ? inst.stmts.getInvoiceByMpPayment.get(mpPid)
          : inst.stmts.getInvoiceById.get(savedInvoice.id);
        const invoices = readInvoicesFromInst(inst, cleanId);
        return {
          alreadyPaid: true,
          invoice: winner ? JSON.parse(winner.data) : savedInvoice,
          tenant: buildTenantRecordDto(cleanId, { ...t, invoices }, brandingObj, plans)
        };
      }
    }

    const daysToAdd = cycle === 'annual' ? 365 : 30;
    const baseDate = t.nextBillingAt && new Date(t.nextBillingAt).getTime() > now
      ? new Date(t.nextBillingAt).getTime()
      : now;
    t.nextBillingAt = new Date(baseDate + daysToAdd * 86400000).toISOString();
    t.status = 'active';
    if (targetPlan) {
      t.planId = targetPlan.id;
      t.mrr = Number(cycle === 'annual' ? (targetPlan.priceAnnualMonthly || targetPlan.priceMonthly) : targetPlan.priceMonthly);
    }
    t.updatedAt = nowIso;

    inst.stmts.upsertTenantRow.run(cleanId, t.planId, t.status, JSON.stringify(t), tRow.branding, tRow.templates || '[]', now);
    syncSaasMirrorInTx(inst);
    const invoices = readInvoicesFromInst(inst, cleanId);
    return {
      alreadyPaid: false,
      invoice: savedInvoice,
      tenant: buildTenantRecordDto(cleanId, { ...t, invoices }, brandingObj, plans)
    };
  });
}

/**
 * Extrai metadados de `external_reference` (`rit:<tenantId>:<invoiceId>:<cycle>:<planId>` ou JSON).
 */
export function parseMpExternalReference(externalReference) {
  const extRef = String(externalReference || '').trim();
  if (!extRef) return { tenantId: null, invoiceId: null, cycle: 'monthly', planId: null };
  if (extRef.startsWith('rit:')) {
    const parts = extRef.split(':');
    return {
      tenantId: parts[1] || null,
      invoiceId: parts[2] || null,
      cycle: parts[3] === 'annual' ? 'annual' : 'monthly',
      planId: parts[4] || null
    };
  }
  try {
    const parsed = JSON.parse(extRef);
    return {
      tenantId: parsed?.tenantId || null,
      invoiceId: parsed?.invoiceId || null,
      cycle: parsed?.cycle === 'annual' ? 'annual' : 'monthly',
      planId: parsed?.planId || null
    };
  } catch {
    return { tenantId: null, invoiceId: null, cycle: 'monthly', planId: null };
  }
}

/**
 * Consulta rápida no SQLite para saber se um `mp_payment_id` já pertence a uma fatura `paid`.
 */
export function isMpPaymentAlreadyPaid(baseDataDir, mpPaymentId) {
  const pid = String(mpPaymentId || '').trim();
  if (!pid) return null;
  const inst = getSqliteInstance(baseDataDir);
  const row = inst.stmts.getInvoiceByMpPayment.get(pid);
  if (row && row.status === 'paid') {
    return { tenantId: row.tenant_id, invoiceId: row.id };
  }
  return null;
}

/**
 * Reconcilia de forma idempotente e independente de ordem o objeto oficial retornado pelo Mercado Pago.
 * Nunca faz downgrade de fatura já marcada como `paid`.
 */
export function applyGatewayPaymentUpdate(baseDataDir, tenantId, mpData, opts = {}) {
  const cleanId = sanitizeTenantId(tenantId);
  if (!cleanId || cleanId === 'default' || !mpData) {
    return { outcome: 'ignored', reason: 'invalid_input' };
  }
  const tenant = getTenant(baseDataDir, cleanId);
  if (!tenant) {
    return { outcome: 'ignored', reason: 'tenant_not_found' };
  }

  const status = String(mpData.status || '').toLowerCase();
  const mpPid = mpData.id ? String(mpData.id) : (opts.mpPaymentId ? String(opts.mpPaymentId) : null);

  if (status === 'approved') {
    const paidAmt = Number(mpData.transaction_amount);
    const existingInv = (tenant.invoices || []).find(
      i => (opts.invoiceId && i.id === opts.invoiceId) || (mpPid && i.mpPaymentId === mpPid)
    );
    const plans = listSaasPlans(baseDataDir);
    const targetPlan = (opts.planId && plans.find(p => p.id === opts.planId))
      || (existingInv?.planId && plans.find(p => p.id === existingInv.planId))
      || plans.find(p => p.id === tenant.planId)
      || plans[0];
    const cycle = (opts.cycle || existingInv?.cycle) === 'annual' ? 'annual' : 'monthly';
    const expectedAmount = existingInv?.amount !== undefined
      ? Number(existingInv.amount)
      : Number(cycle === 'annual' ? (targetPlan?.priceAnnualMonthly || targetPlan?.priceMonthly || 0) * 12 : (targetPlan?.priceMonthly || 0));

    if (Number.isFinite(paidAmt) && Number.isFinite(expectedAmount) && expectedAmount > 0 && paidAmt + 0.05 < expectedAmount) {
      return { outcome: 'amount_mismatch', amountMismatch: true, paidAmt, expectedAmount };
    }

    const resConfirm = confirmTenantPayment(baseDataDir, cleanId, {
      invoiceId: opts.invoiceId || existingInv?.id || undefined,
      mpPaymentId: mpPid || undefined,
      amount: Number.isFinite(paidAmt) ? paidAmt : expectedAmount,
      paidAt: mpData.date_approved || new Date().toISOString(),
      method: 'PIX (Mercado Pago)',
      cycle,
      planId: targetPlan?.id,
      planName: targetPlan?.name,
      note: opts.note || (cycle === 'annual'
        ? `Assinatura Anual - ${targetPlan?.name || 'Plano'} (Pago via PIX)`
        : `Assinatura Mensal - ${targetPlan?.name || 'Plano'} (Pago via PIX)`)
    });
    return { outcome: 'approved', ...resConfirm };
  }

  if (status === 'cancelled' || status === 'rejected' || status === 'expired') {
    const inst = getSqliteInstance(baseDataDir);
    backfillRelationalTables(inst);
    return runInTransaction(inst, () => {
      let row = opts.invoiceId ? inst.stmts.getInvoiceById.get(String(opts.invoiceId)) : null;
      if (row && row.tenant_id !== cleanId) row = null;
      if (!row && mpPid) {
        const byMp = inst.stmts.getInvoiceByMpPayment.get(mpPid);
        if (byMp && byMp.tenant_id === cleanId) row = byMp;
      }
      if (!row) return { outcome: status, updated: false, reason: 'invoice_not_found' };
      const prev = JSON.parse(row.data);
      if (row.status === 'paid') {
        return { outcome: 'ignored_already_paid', alreadyPaid: true, updated: false, invoice: prev };
      }
      if (row.status !== 'pending' && row.status !== 'checkout_creating') {
        return { outcome: status, updated: false, invoice: prev };
      }
      const nextStatus = status === 'cancelled' ? 'cancelled' : (status === 'expired' ? 'expired' : 'failed');
      const nextInv = { ...prev, status: nextStatus, gatewayStatus: status };
      inst.stmts.upsertInvoiceRow.run(
        row.id, cleanId, row.plan_id, row.kind || 'pix_checkout', row.amount_cents,
        nextStatus, nextInv.method || prev.method || null, row.mp_payment_id || mpPid,
        row.idempotency_key, row.created_at, row.paid_at, row.expires_at, JSON.stringify(nextInv)
      );
      syncSaasMirrorInTx(inst);
      return { outcome: status, updated: true, invoice: nextInv };
    });
  }

  if (status === 'refunded' || status === 'charged_back') {
    const inst = getSqliteInstance(baseDataDir);
    backfillRelationalTables(inst);
    return runInTransaction(inst, () => {
      let row = opts.invoiceId ? inst.stmts.getInvoiceById.get(String(opts.invoiceId)) : null;
      if (row && row.tenant_id !== cleanId) row = null;
      if (!row && mpPid) {
        const byMp = inst.stmts.getInvoiceByMpPayment.get(mpPid);
        if (byMp && byMp.tenant_id === cleanId) row = byMp;
      }
      if (!row) return { outcome: status, updated: false, reason: 'invoice_not_found' };
      const prev = JSON.parse(row.data);
      if (prev.gatewayStatus === status && prev.refundedAt) {
        return { outcome: status, alreadyRecorded: true, updated: false, invoice: prev };
      }
      const nextInv = {
        ...prev,
        gatewayStatus: status,
        refundedAt: mpData.date_last_updated || new Date().toISOString()
      };
      inst.stmts.upsertInvoiceRow.run(
        row.id, cleanId, row.plan_id, row.kind || 'pix_checkout', row.amount_cents,
        row.status, nextInv.method || prev.method || null, row.mp_payment_id || mpPid,
        row.idempotency_key, row.created_at, row.paid_at, row.expires_at, JSON.stringify(nextInv)
      );
      syncSaasMirrorInTx(inst);
      return { outcome: status, alreadyRecorded: false, updated: true, invoice: nextInv };
    });
  }

  return { outcome: status || 'received', updated: false };
}

/**
 * Remove uma academia do registro SaaS e limpa seus registros relacionados.
 */
export function deleteTenant(baseDataDir, tenantId) {
  const cleanId = sanitizeTenantId(tenantId);
  if (!cleanId || cleanId === 'default') throw new Error('Não é permitido remover o tenant padrão');
  const inst = getSqliteInstance(baseDataDir);
  backfillRelationalTables(inst);

  runInTransaction(inst, () => {
    inst.stmts.deleteTenantInvoices.run(cleanId);
    inst.stmts.clearTenantTemplates.run(cleanId);
    inst.stmts.deleteTenantRow.run(cleanId);
    inst.stmts.deleteKv.run(`branding:${cleanId}`);
    inst.stmts.deleteKv.run(`templates:${cleanId}`);
    inst.stmts.deleteKv.run(`templates_seed_v:${cleanId}`);
    syncSaasMirrorInTx(inst);
  });

  const tDir = path.join(baseDataDir, 'tenants', cleanId);
  if (fs.existsSync(tDir)) {
    fs.rmSync(tDir, { recursive: true, force: true });
  }
  return true;
}

/**
 * Lista todas as academias cadastradas (mesclando `saas.json` e diretórios `tenants/*`).
 */
export function listTenants(baseDataDir, db = null) {
  const store = loadSaasStore(baseDataDir);
  const slugSet = new Set(Object.keys(store.tenants));
  const root = path.join(baseDataDir, 'tenants');
  if (fs.existsSync(root)) {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (ent.isDirectory() && ent.name !== 'default') slugSet.add(ent.name);
    }
  }

  const out = [];
  for (const slug of slugSet) {
    const t = getTenant(baseDataDir, slug);
    if (!t) continue;
    let userCount = 0;
    let studentCount = 0;
    let trainerCount = 0;
    if (db && Array.isArray(db.users)) {
      const tenantUsers = db.users.filter(u => u.tenantId === slug);
      userCount = tenantUsers.length;
      studentCount = tenantUsers.filter(u => !u.saasRole || u.saasRole === 'student').filter(u => u.role !== 'trainer').length;
      trainerCount = tenantUsers.filter(u => u.saasRole === 'trainer' || u.role === 'trainer' || u.saasRole === 'gym_owner' || u.saasRole === 'gym_manager').length;
    } else {
      try {
        const dbFile = path.join(baseDataDir, 'tenants', slug, 'db.json');
        if (fs.existsSync(dbFile)) {
          const dbData = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
          userCount = Array.isArray(dbData.users) ? dbData.users.length : 0;
          studentCount = userCount;
        }
      } catch { /* ignore */ }
    }
    out.push({
      ...t,
      userCount,
      studentCount,
      trainerCount
    });
  }

  return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
