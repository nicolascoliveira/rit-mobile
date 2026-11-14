import crypto from 'node:crypto';
import { HASH_RE, MEDIA_TYPES } from './media.js';
import { getSqliteInstance, runInTransaction } from './sqlite.js';
import { sanitizeTenantId } from './tenants.js';

export const TENANT_MEDIA_PREFIX = '__tenant__';
export const TENANT_CUSTOM_EX_PREFIX = 'tx_';

const POSTER_MIMES = new Set(['image/webp', 'image/jpeg']);
const CODECS = ['avc1', 'hvc1', 'av01', 'vp09', 'vp8', 'vp9', 'other'];
const MB = 1024 * 1024;
const MAX_MEDIA_SIZE = 200 * MB;
const MAX_EDGE = 16384;
const MAX_DUR = 3600;
const MAX_URL = 2048;
const EX_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const VALID_BODY_PARTS = new Set([
  'chest',
  'back',
  'upper legs',
  'lower legs',
  'shoulders',
  'upper arms',
  'lower arms',
  'waist',
  'cardio',
  'full body',
  'neck',
  'other'
]);

// Cache em memória dos hashes ativos por tenant para validação rápida em GET /api/media/{hash}
const tenantHashCache = new Map();

export function invalidateTenantMediaHashCache(tenantId) {
  const tid = sanitizeTenantId(tenantId) || 'default';
  tenantHashCache.delete(tid);
}

export function tenantMediaBucket(tenantId) {
  const tid = sanitizeTenantId(tenantId) || 'default';
  return `${TENANT_MEDIA_PREFIX}${tid}`;
}

export function isTenantMediaBucket(uid) {
  return typeof uid === 'string' && uid.startsWith(TENANT_MEDIA_PREFIX);
}

export function tenantIdFromMediaBucket(uid) {
  if (!isTenantMediaBucket(uid)) return null;
  return sanitizeTenantId(uid.slice(TENANT_MEDIA_PREFIX.length)) || 'default';
}

export function sanitizeExerciseId(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  return EX_ID_RE.test(s) ? s : '';
}

const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function cleanPosterRef(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.hash !== 'string' || !HASH_RE.test(p.hash)) return null;
  if (!POSTER_MIMES.has(p.mime)) return null;
  if (!intIn(p.size, 1, MAX_MEDIA_SIZE) || !intIn(p.width, 1, MAX_EDGE) || !intIn(p.height, 1, MAX_EDGE)) return null;
  return { hash: p.hash, mime: p.mime, size: p.size, width: p.width, height: p.height };
}

/**
 * Normaliza e valida um MediaRef vindo da API antes de salvar em banco.
 * Segue exatamente o mesmo schema de `frontend/src/lib/media-refs.js`.
 */
export function normalizeServerMediaRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  const type = typeof ref.mime === 'string' ? MEDIA_TYPES[ref.mime] : null;
  if (!type || ref.kind !== type.kind) return null;
  if (typeof ref.hash !== 'string' || !HASH_RE.test(ref.hash)) return null;
  if (!intIn(ref.size, 1, MAX_MEDIA_SIZE) || !intIn(ref.width, 1, MAX_EDGE) || !intIn(ref.height, 1, MAX_EDGE)) return null;
  const out = {
    kind: ref.kind,
    hash: ref.hash,
    mime: ref.mime,
    size: ref.size,
    width: ref.width,
    height: ref.height
  };
  if (ref.dur != null) {
    if (typeof ref.dur !== 'number' || !Number.isFinite(ref.dur) || ref.dur < 0 || ref.dur > MAX_DUR) return null;
    out.dur = Math.round(ref.dur * 10) / 10;
  }
  if (ref.codec != null) {
    if (ref.kind !== 'video' || !CODECS.includes(ref.codec)) return null;
    out.codec = ref.codec;
  }
  const poster = cleanPosterRef(ref.poster);
  if (poster) out.poster = poster;
  out.at = typeof ref.at === 'number' && Number.isFinite(ref.at) && ref.at > 0 ? Math.round(ref.at) : Date.now();
  return out;
}

/**
 * Sanitiza URL externa de vídeo/guia aceitando apenas `http://` e `https://`.
 */
export function cleanExerciseUrl(raw, { strict = false } = {}) {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string') {
    if (strict) throw new Error('URL inválida. Informe um link http:// ou https://.');
    return '';
  }
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.length > MAX_URL || /[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    if (strict) throw new Error('URL inválida ou longa demais (máximo 2048 caracteres).');
    return '';
  }
  try {
    const u = new URL(trimmed);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch { /* fallthrough */ }
  if (strict) throw new Error('URL inválida. Utilize um link completo começando com https:// ou http://.');
  return '';
}

function parseJsonSafe(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function rowToOverride(row) {
  if (!row) return null;
  const media = normalizeServerMediaRef(parseJsonSafe(row.media_json));
  const url = cleanExerciseUrl(row.url || '');
  const note = String(row.note || '');
  if (!media && !url && !note) return null;
  return {
    exerciseId: row.exercise_id,
    media,
    url,
    note,
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at || 0
  };
}

function rowToCustomExercise(row) {
  if (!row) return null;
  const parsed = parseJsonSafe(row.data);
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    ...parsed,
    id: row.id,
    media: normalizeServerMediaRef(parsed.media),
    url: cleanExerciseUrl(parsed.url || ''),
    tenantCustom: true,
    createdAt: row.created_at || parsed.createdAt || 0,
    updatedAt: row.updated_at || parsed.updatedAt || 0
  };
}

export function listTenantExerciseOverrides(dataDir, tenantId) {
  const tid = sanitizeTenantId(tenantId) || 'default';
  const inst = getSqliteInstance(dataDir);
  const rows = inst.stmts.listTenantExerciseOverrides.all(tid);
  const out = {};
  for (const row of rows) {
    const item = rowToOverride(row);
    if (item) out[item.exerciseId] = item;
  }
  return out;
}

export function upsertTenantExerciseOverride(dataDir, tenantId, { exerciseId, media, url, note, updatedBy = null }) {
  const tid = sanitizeTenantId(tenantId) || 'default';
  const cleanId = sanitizeExerciseId(exerciseId);
  if (!cleanId) throw new Error('ID do exercício inválido.');

  let normMedia = null;
  if (media !== undefined && media !== null) {
    normMedia = normalizeServerMediaRef(media);
    if (!normMedia) throw new Error('Referência de mídia inválida ou corrompida.');
  }
  const cleanUrl = cleanExerciseUrl(url, { strict: true });
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 400) : '';

  const inst = getSqliteInstance(dataDir);
  const result = runInTransaction(inst, () => {
    if (!normMedia && !cleanUrl && !cleanNote) {
      inst.stmts.deleteTenantExerciseOverride.run(tid, cleanId);
      return { deleted: true, exerciseId: cleanId, override: null };
    }
    const now = Date.now();
    inst.stmts.upsertTenantExerciseOverride.run(
      tid,
      cleanId,
      normMedia ? JSON.stringify(normMedia) : null,
      cleanUrl || null,
      cleanNote || null,
      updatedBy ? String(updatedBy) : null,
      now
    );
    const saved = rowToOverride(inst.stmts.getTenantExerciseOverride.get(tid, cleanId));
    return { deleted: false, exerciseId: cleanId, override: saved };
  });

  invalidateTenantMediaHashCache(tid);
  return result;
}

export function deleteTenantExerciseOverride(dataDir, tenantId, exerciseId) {
  const tid = sanitizeTenantId(tenantId) || 'default';
  const cleanId = sanitizeExerciseId(exerciseId);
  if (!cleanId) return false;
  const inst = getSqliteInstance(dataDir);
  const info = inst.stmts.deleteTenantExerciseOverride.run(tid, cleanId);
  invalidateTenantMediaHashCache(tid);
  return info.changes > 0;
}

export function listTenantCustomExercises(dataDir, tenantId) {
  const tid = sanitizeTenantId(tenantId) || 'default';
  const inst = getSqliteInstance(dataDir);
  const rows = inst.stmts.listTenantCustomExercises.all(tid);
  return rows.map(rowToCustomExercise).filter(Boolean);
}

export function upsertTenantCustomExercise(dataDir, tenantId, raw = {}, actorId = null) {
  const tid = sanitizeTenantId(tenantId) || 'default';
  const name = String(raw.name || raw.n || '').trim().slice(0, 80);
  if (!name) throw new Error('Informe o nome do exercício.');

  const bpRaw = String(raw.bp || 'other').trim().toLowerCase();
  const bp = VALID_BODY_PARTS.has(bpRaw) ? bpRaw : 'other';
  const tg = String(raw.tg || bp || 'other').trim().toLowerCase().slice(0, 60) || 'other';
  const eq = String(raw.eq || 'other').trim().toLowerCase().slice(0, 60) || 'other';
  const desc = String(raw.desc || raw.description || '').trim().slice(0, 2000);

  let normMedia = null;
  if (raw.media !== undefined && raw.media !== null) {
    normMedia = normalizeServerMediaRef(raw.media);
    if (!normMedia) throw new Error('Referência de mídia inválida ou corrompida.');
  }
  const cleanUrl = cleanExerciseUrl(raw.url, { strict: true });

  const primaries = Array.isArray(raw.primaries)
    ? raw.primaries.map(s => String(s || '').trim()).filter(Boolean).slice(0, 6)
    : [];
  const secondaries = Array.isArray(raw.secondaries)
    ? raw.secondaries.map(s => String(s || '').trim()).filter(Boolean).slice(0, 8)
    : [];

  let id = sanitizeExerciseId(raw.id);
  if (id) {
    if (!id.startsWith(TENANT_CUSTOM_EX_PREFIX)) {
      throw new Error('Para alterar um exercício oficial do catálogo, use a personalização de vídeo/mídia.');
    }
  } else {
    id = TENANT_CUSTOM_EX_PREFIX + crypto.randomBytes(6).toString('base64url');
  }

  const inst = getSqliteInstance(dataDir);
  const saved = runInTransaction(inst, () => {
    const existing = inst.stmts.getTenantCustomExercise.get(tid, id);
    const now = Date.now();
    const createdAt = existing?.created_at || now;
    const payload = {
      id,
      n: name,
      name,
      bp,
      tg,
      eq,
      ...(desc ? { desc } : {}),
      ...(primaries.length ? { primaries } : {}),
      ...(secondaries.length ? { secondaries } : {}),
      ...(normMedia ? { media: normMedia } : {}),
      ...(cleanUrl ? { url: cleanUrl } : {}),
      tenantCustom: true,
      createdAt,
      updatedAt: now
    };
    inst.stmts.upsertTenantCustomExercise.run(
      tid,
      id,
      name,
      bp,
      tg,
      eq,
      desc || null,
      normMedia ? JSON.stringify(normMedia) : null,
      cleanUrl || null,
      actorId ? String(actorId) : null,
      createdAt,
      now,
      JSON.stringify(payload)
    );
    return rowToCustomExercise(inst.stmts.getTenantCustomExercise.get(tid, id));
  });

  invalidateTenantMediaHashCache(tid);
  return saved;
}

export function deleteTenantCustomExercise(dataDir, tenantId, id) {
  const tid = sanitizeTenantId(tenantId) || 'default';
  const cleanId = sanitizeExerciseId(id);
  if (!cleanId) return false;
  const inst = getSqliteInstance(dataDir);
  const info = inst.stmts.deleteTenantCustomExercise.run(tid, cleanId);
  invalidateTenantMediaHashCache(tid);
  return info.changes > 0;
}

export function getTenantExercisesPayload(dataDir, tenantId) {
  const tid = sanitizeTenantId(tenantId) || 'default';
  return {
    tenantId: tid,
    overrides: listTenantExerciseOverrides(dataDir, tid),
    customExercises: listTenantCustomExercises(dataDir, tid)
  };
}

/**
 * Conjunto de hashes atualmente referenciados por overrides e exercícios customizados do tenant.
 */
export function getTenantReferencedMediaHashes(dataDir, tenantId) {
  const tid = sanitizeTenantId(tenantId) || 'default';
  const cached = tenantHashCache.get(tid);
  if (cached) return cached;

  const set = new Set();
  const addRef = m => {
    if (!m || typeof m !== 'object') return;
    if (typeof m.hash === 'string' && HASH_RE.test(m.hash)) set.add(m.hash);
    if (m.poster && typeof m.poster.hash === 'string' && HASH_RE.test(m.poster.hash)) set.add(m.poster.hash);
  };

  const overrides = listTenantExerciseOverrides(dataDir, tid);
  for (const ov of Object.values(overrides)) addRef(ov.media);
  const custom = listTenantCustomExercises(dataDir, tid);
  for (const c of custom) addRef(c.media);

  tenantHashCache.set(tid, set);
  return set;
}

export function tenantHasMediaHash(dataDir, tenantId, hash) {
  if (!hash || !HASH_RE.test(hash)) return false;
  return getTenantReferencedMediaHashes(dataDir, tenantId).has(hash);
}

/**
 * Estado sintético compatível com `referencedHashes(state)` em `api/media.js`
 * para que o sweep/GC de arquivos de mídia preserve todos os vídeos/imagens ativos do tenant
 * e limpe mídias substituídas após o período de carência (`MEDIA_GC_GRACE_DAYS`).
 */
export function readTenantMediaState(dataDir, tenantId) {
  const tid = sanitizeTenantId(tenantId) || 'default';
  const overrides = listTenantExerciseOverrides(dataDir, tid);
  const custom = listTenantCustomExercises(dataDir, tid);
  return {
    customEx: [
      ...Object.values(overrides).map(ov => ({ media: ov.media })),
      ...custom.map(c => ({ media: c.media }))
    ]
  };
}

export function clearTenantExercisesData(dataDir, tenantId) {
  const tid = sanitizeTenantId(tenantId) || 'default';
  const inst = getSqliteInstance(dataDir);
  runInTransaction(inst, () => {
    inst.stmts.deleteAllTenantExerciseOverrides.run(tid);
    inst.stmts.deleteAllTenantCustomExercises.run(tid);
  });
  invalidateTenantMediaHashCache(tid);
}

