/**
 * api/whatsapp.js
 *
 * Módulo de Integração WhatsApp via Evolution API para o Ecossistema Rit.
 *
 * Funcionalidades:
 * 1. Formatação rica de Relatório de Treino Concluído para o Personal Trainer.
 * 2. Formatação e disparo de Aviso de Nova Ficha Prescrita para o Aluno.
 * 3. Formatação e disparo de Recuperação Anti-Evasão (Churn) individual e em lote.
 * 4. Fila Resiliente de Envios (Outbox / Retry Queue com backoff exponencial) e Histórico.
 * 5. Normalização e sanitização de números de telefone (Padrão E.164 / DDI 55).
 * 6. Envio assíncrono via Evolution API (POST /message/sendText/{instance}).
 */

import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import crypto from 'node:crypto';
import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';

const NATIVE_GLOBAL_FETCH = globalThis.fetch;
import { getTenant, resolveTenantEvolutionSettings } from './tenants.js';
import {
  getSqliteInstance,
  runInTransaction,
  backfillRelationalTables
} from './sqlite.js';
import {
  validateEvolutionUrl,
  isPlatformEvolutionUrl,
  resolveAndVerifyPublicEvolutionHost,
  outboundLookup
} from './net-guard.js';
import { buildPrescriptionPlanPdfBytes } from './prescription-pdf.js';

export { validateEvolutionUrl };

const EVOLUTION_EXTERNAL_DISPATCHER = new UndiciAgent({
  connect: { lookup: outboundLookup({ allowLan: false }) }
});

const WEEKDAY_SHORT_PT = {
  0: 'Dom',
  1: 'Seg',
  2: 'Ter',
  3: 'Qua',
  4: 'Qui',
  5: 'Sex',
  6: 'Sáb'
};

// Fallback em memória para ambientes de teste onde dataDir não persiste em disco (/tmp)
const memoryOutboxByDir = new Map();
const activeRetryTimersByDir = new Map();

function isPersistentDir(dataDir) {
  if (!dataDir || dataDir === '/tmp') return false;
  try {
    return fs.existsSync(dataDir);
  } catch {
    return false;
  }
}

function toMs(val, fallback = null) {
  if (val == null || val === '') return fallback;
  if (typeof val === 'number' && Number.isFinite(val)) return Math.trunc(val);
  const parsed = Date.parse(String(val));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mapRowToHistoryItem(row) {
  let d = {};
  try { d = JSON.parse(row.data); } catch { d = {}; }
  const st = row.status === 'pending' || row.status === 'processing' ? 'queued' : row.status;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    recipientName: d.recipientName || 'Destinatário',
    phone: d.phone || '',
    preview: d.preview || String(d.message || '').split('\n').slice(0, 2).join(' · ').slice(0, 90),
    status: st,
    attempts: Number(row.attempts || 0),
    error: d.lastError ?? d.error ?? null,
    createdAt: d.createdAt || new Date(row.created_at).toISOString(),
    sentAt: d.sentAt || (row.status === 'sent' && row.completed_at ? new Date(row.completed_at).toISOString() : null)
  };
}

function sanitizeOutboxQueueItem(item) {
  if (!item || typeof item !== 'object') return item;
  if (!item.tenantSettings || typeof item.tenantSettings !== 'object') return item;
  const {
    evolutionApiKey: _dropKey,
    evolutionApiKeyEnc: _dropEnc,
    clearEvolutionApiKey: _dropClear,
    ...safeTenantSettings
  } = item.tenantSettings;
  return { ...item, tenantSettings: safeTenantSettings };
}

function mergeTenantEvolutionSettings(dataDir, tenantId, tenantSettings = {}) {
  const raw = tenantSettings && typeof tenantSettings === 'object' ? tenantSettings : {};
  const stored = isPersistentDir(dataDir) && tenantId && tenantId !== 'default'
    ? resolveTenantEvolutionSettings(dataDir, tenantId)
    : null;
  return {
    ...raw,
    evolutionUrl: String(raw.evolutionUrl || stored?.evolutionUrl || '').trim(),
    evolutionApiKey: String(raw.evolutionApiKey || stored?.evolutionApiKey || '').trim(),
    evolutionInstance: String(raw.evolutionInstance || stored?.evolutionInstance || '').trim()
  };
}

function syncOutboxKvMirrorInTx(inst) {
  const queueRows = inst.stmts.getOutboxPending.all();
  const histRows = inst.db.prepare(
    'SELECT * FROM whatsapp_outbox ORDER BY created_at DESC, rowid DESC LIMIT 150'
  ).all();
  const safe = {
    queue: queueRows.map(r => sanitizeOutboxQueueItem(JSON.parse(r.data))).slice(0, 200),
    history: histRows.map(mapRowToHistoryItem).slice(0, 150)
  };
  inst.stmts.setKv.run('whatsapp_outbox', JSON.stringify(safe), Date.now());
  return safe;
}

export function loadWhatsAppOutbox(dataDir) {
  if (isPersistentDir(dataDir)) {
    try {
      const inst = getSqliteInstance(dataDir);
      backfillRelationalTables(inst);
      const queueRows = inst.stmts.getOutboxPending.all();
      const allHistRows = inst.db.prepare(
        'SELECT * FROM whatsapp_outbox ORDER BY created_at DESC, rowid DESC LIMIT 150'
      ).all();
      return {
        queue: queueRows.map(r => sanitizeOutboxQueueItem(JSON.parse(r.data))),
        history: allHistRows.map(mapRowToHistoryItem)
      };
    } catch {
      // fallback
    }
  }
  const key = String(dataDir || 'default');
  if (!memoryOutboxByDir.has(key)) {
    memoryOutboxByDir.set(key, { queue: [], history: [] });
  }
  const mem = memoryOutboxByDir.get(key);
  return {
    queue: Array.isArray(mem.queue) ? mem.queue.map(sanitizeOutboxQueueItem) : [],
    history: Array.isArray(mem.history) ? mem.history : []
  };
}

export function saveWhatsAppOutbox(dataDir, store) {
  const safe = {
    queue: Array.isArray(store?.queue) ? store.queue.slice(0, 200).map(sanitizeOutboxQueueItem) : [],
    history: Array.isArray(store?.history) ? store.history.slice(0, 150) : []
  };
  const key = String(dataDir || 'default');
  memoryOutboxByDir.set(key, safe);

  if (isPersistentDir(dataDir)) {
    try {
      const inst = getSqliteInstance(dataDir);
      const now = Date.now();
      runInTransaction(inst, () => {
        inst.stmts.clearOutbox.run();
        const queuedIds = new Set();
        for (const item of safe.queue) {
          if (!item?.id) continue;
          queuedIds.add(String(item.id));
          inst.stmts.upsertOutboxRow.run(
            String(item.id),
            String(item.tenantId || 'default'),
            String(item.kind || 'custom'),
            'pending',
            item.dedupKey ? String(item.dedupKey) : null,
            Number(item.attempts || 0),
            Number(item.nextRetryAt || 0),
            null,
            toMs(item.createdAt, now),
            null,
            JSON.stringify(item)
          );
        }
        for (const h of safe.history) {
          if (!h?.id || queuedIds.has(String(h.id))) continue;
          const st = ['sent', 'failed', 'cancelled'].includes(h.status) ? h.status : (h.error ? 'failed' : 'sent');
          inst.stmts.upsertOutboxRow.run(
            String(h.id),
            String(h.tenantId || 'default'),
            String(h.kind || 'custom'),
            st,
            null,
            Number(h.attempts || 0),
            0,
            null,
            toMs(h.createdAt, now),
            toMs(h.sentAt || h.createdAt, now),
            JSON.stringify(h)
          );
        }
        inst.stmts.setKv.run('whatsapp_outbox', JSON.stringify(safe), now);
      });
    } catch {
      // ignora erro em diretórios somente-leitura
    }
  }
  return safe;
}

function scheduleBackgroundOutboxFlush(dataDir, delayMs = 20000) {
  const key = String(dataDir || 'default');
  if (activeRetryTimersByDir.has(key)) return;
  const tm = setTimeout(async () => {
    activeRetryTimersByDir.delete(key);
    try {
      await flushWhatsAppOutbox(dataDir);
    } catch {
      // silencia falha em background
    }
  }, delayMs);
  activeRetryTimersByDir.set(key, tm);
  if (typeof tm.unref === 'function') {
    tm.unref();
  }
}

/**
 * Normaliza qualquer número de telefone para o formato padrão aceito pelo WhatsApp (DDI + DDD + Número).
 * Padrão Brasil: 55 + DDD (2 dígitos) + 8 ou 9 dígitos (12 ou 13 dígitos numéricos).
 */
export function cleanWhatsAppPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits || digits.length < 8) return null;

  // Já começa com DDI 55 do Brasil
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return digits;
  }

  // DDD + Número no Brasil (10 ou 11 dígitos, ex: 11987654321 ou 1187654321)
  if (digits.length === 10 || digits.length === 11) {
    return '55' + digits;
  }

  // Outros números internacionais
  return digits;
}

function brazilPhoneVariants(clean) {
  const digits = String(clean || '').replace(/\D/g, '');
  if (!digits) return [];
  const out = [digits];
  if (digits.startsWith('55') && digits.length === 13 && digits[4] === '9') {
    out.push(digits.slice(0, 4) + digits.slice(5));
  } else if (digits.startsWith('55') && digits.length === 12) {
    out.push(digits.slice(0, 4) + '9' + digits.slice(4));
  }
  return out;
}

/**
 * Resolve o JID `@lid` salvo pelo Baileys em `<DATA_DIR>/evolution_instances/<id>/lid-mapping-<num>.json`.
 * Contorna o bug do Evolution API v2.3.x / Baileys 7.0.0-rc.9 onde envios para `@s.whatsapp.net`
 * retornam Erro 463 (`NackCallerReachoutTimelocked`) enquanto o envio direto para `<lid>@lid` entrega com `DELIVERY_ACK`.
 */
export function lookupLocalEvolutionLid(cleanPhone, dataDir = process.env.DATA_DIR || '') {
  if (!cleanPhone || !dataDir) return null;
  const instancesRoot = path.join(String(dataDir), 'evolution_instances');
  let dirs;
  try {
    if (!fs.existsSync(instancesRoot)) return null;
    dirs = fs.readdirSync(instancesRoot, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch {
    return null;
  }
  if (!dirs.length) return null;
  const variants = brazilPhoneVariants(cleanPhone);
  for (const dir of dirs) {
    for (const v of variants) {
      const mappingFile = path.join(instancesRoot, dir.name, `lid-mapping-${v}.json`);
      try {
        if (!fs.existsSync(mappingFile)) continue;
        const parsed = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
        const lidDigits = String(parsed || '').replace(/\D/g, '');
        if (lidDigits.length >= 8 && lidDigits.length <= 25) {
          return `${lidDigits}@lid`;
        }
      } catch {
        // ignora arquivo corrompido ou ilegível
      }
    }
  }
  return null;
}

async function resolveEvolutionDeliveryNumber(clean, cfg, { dataDir = process.env.DATA_DIR || '', lookup = dns.promises.lookup } = {}) {
  if (!cfg?.allowInternalPlatform || !dataDir) return clean;
  const cachedLid = lookupLocalEvolutionLid(clean, dataDir);
  if (cachedLid) return cachedLid;

  const instancesRoot = path.join(String(dataDir), 'evolution_instances');
  try {
    if (!fs.existsSync(instancesRoot)) return clean;
  } catch {
    return clean;
  }

  // Pré-aquece o mapeamento PN → LID no Baileys para números novos antes do primeiro envio
  await fetchEvolutionJson(
    cfg.url,
    `/chat/whatsappNumbers/${encodeURIComponent(cfg.instance)}`,
    {
      method: 'POST',
      apiKey: cfg.apiKey,
      body: { numbers: [clean] },
      timeoutMs: 4000,
      allowInternalPlatform: cfg.allowInternalPlatform,
      lookup
    }
  ).catch(() => null);

  return lookupLocalEvolutionLid(clean, dataDir) || clean;
}

function formatKgValuePtBr(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';
  return Number.isInteger(num)
    ? num.toLocaleString('pt-BR')
    : num.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/**
 * Formata um relatório de treino concluído em texto limpo com markdown do WhatsApp (*negrito*, emojis e listas).
 */
export function formatWorkoutWhatsAppMessage({
  studentName = 'Aluno',
  workout = {},
  tenantName = 'Academia',
  trainerName = '',
  studentGoal = '',
  catalogueById = null
}) {
  const wName = workout.name || 'Treino do Dia';
  const prSet = new Set(Array.isArray(workout.prs) ? workout.prs : []);

  // Duração em minutos
  let durationText = '';
  if (workout.start && workout.end) {
    const mins = Math.max(1, Math.round((Number(workout.end) - Number(workout.start)) / 60000));
    durationText = `${mins} min`;
  }

  // Volume total levantado
  let volText = '';
  if (workout.vol && Number(workout.vol) > 0) {
    const volNum = Number(workout.vol);
    const roundedVol = volNum >= 100 ? Math.round(volNum) : volNum;
    volText = `${roundedVol.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} kg`;
  }

  // Destaques dos exercícios
  const highlights = [];
  const entries = Array.isArray(workout.entries) ? workout.entries : [];

  for (const entry of entries) {
    if (!entry) continue;
    let exName = entry.name;
    if (!exName && catalogueById && entry.id) {
      exName = catalogueById.get(entry.id)?.name;
    }
    if (!exName) exName = 'Exercício';

    const allSets = Array.isArray(entry.sets) ? entry.sets : [];
    const workSets = allSets.filter(s => s && s.done && !s.warmup);
    const completedSets = workSets.length > 0 ? workSets : allSets.filter(s => s && s.done);

    if (completedSets.length === 0) continue;

    // Acha a série com maior carga ou maior repetição
    const topSet = completedSets.reduce((best, s) => {
      const bestW = Number(best?.w || 0);
      const currW = Number(s?.w || 0);
      if (currW > bestW) return s;
      if (currW === bestW && Number(s?.r || 0) > Number(best?.r || 0)) return s;
      return best;
    }, completedSets[0]);

    const isPr = prSet.has(entry.id);
    const kgFmt = formatKgValuePtBr(topSet.w);
    const setsLabel = `${completedSets.length} ${completedSets.length === 1 ? 'série' : 'séries'}`;
    const loadLabel = kgFmt ? `*${kgFmt} kg*` : (topSet.r != null || topSet.sec != null ? 'Peso corporal' : '');
    const repsStr = topSet.r != null ? `${topSet.r} reps` : (topSet.sec != null ? `${topSet.sec}s` : '');
    const perfPart = loadLabel && repsStr ? `${loadLabel} × ${repsStr}` : (loadLabel || repsStr);
    const detailLine = [setsLabel, perfPart].filter(Boolean).join(' • ') + (isPr ? ' 🏆 *Novo Recorde!*' : '');

    const idx = highlights.length + 1;
    highlights.push(`${idx}. *${exName}*\n   ${detailLine}`);
  }

  // Percepção de esforço relatada pelo aluno (sem termos técnicos)
  let effortText = '';
  const rirValues = [];
  for (const e of entries) {
    for (const s of (e?.sets || [])) {
      if (s?.done && typeof s.rir === 'number' && s.rir >= 0 && s.rir <= 5) {
        rirValues.push(s.rir);
      }
    }
  }
  if (rirValues.length > 0) {
    const minRir = Math.min(...rirValues);
    const desc = minRir === 0 ? 'Esforço máximo (até o limite)' : minRir === 1 ? 'Intensidade muito alta' : minRir <= 3 ? 'Intensidade moderada' : 'Intensidade leve';
    effortText = `\n💬 *Intensidade Relatada:* ${desc}`;
  }

  // Nota do aluno
  let noteText = '';
  if (workout.note && String(workout.note).trim()) {
    const cleanNote = String(workout.note).trim();
    const truncated = cleanNote.length > 280 ? cleanNote.slice(0, 277) + '...' : cleanNote;
    noteText = `\n📝 *Mensagem do Aluno:* "${truncated}"`;
  }

  const statItems = [
    durationText ? `⏱️ *Duração:* ${durationText}` : null,
    volText ? `⚖️ *Carga Total:* ${volText}` : null
  ].filter(Boolean).join('  •  ');

  const trainerLine = trainerName ? `👨‍🏫 *Professor:* ${trainerName}` : null;

  const lines = [
    `🏋️‍♂️ *Treino Concluído com Sucesso!*`,
    `🏢 *${tenantName}* · _Aplicativo Rit_`,
    ``,
    `👤 *Aluno:* ${studentName}`,
    trainerLine,
    `📋 *Ficha:* ${wName}`,
    statItems || null,
    highlights.length > 0 ? `\n🔥 *Exercícios Realizados (${highlights.length}):*\n\n${highlights.join('\n\n')}` : null,
    effortText || null,
    noteText || null,
    ``,
    `_Acompanhamento de treino realizado no app Rit para ${tenantName}_`
  ].filter(l => l !== null);

  return lines.join('\n');
}

function defaultDevEvolutionKey() {
  return process.env.NODE_ENV === 'production' ? '' : 'rit-secret-key';
}

function resolveEvolutionTarget({ url, apiKey, instance, tenantSettings = {}, allowPlatformFallback = true } = {}) {
  const tenantUrl = String(tenantSettings?.evolutionUrl || '').trim().replace(/\/+$/, '');
  const explicitUrl = String(url || '').trim().replace(/\/+$/, '');
  const hasTenantUrl = Boolean(tenantUrl);
  const candidateUrl = tenantUrl || explicitUrl;
  const isCustomNonPlatformUrl = Boolean(candidateUrl) && (
    hasTenantUrl || !isPlatformEvolutionUrl(candidateUrl, process.env)
  );

  const allowInternalPlatform = !isCustomNonPlatformUrl;
  const allowPlatformKey = allowPlatformFallback !== false && !isCustomNonPlatformUrl;

  const rawBase = candidateUrl || (String(process.env.EVOLUTION_API_URL || 'http://localhost:8082').trim() || 'http://localhost:8082').replace(/\/+$/, '');
  const validUrl = validateEvolutionUrl(rawBase, { allowInternalPlatform });
  if (!validUrl.ok) {
    return { ok: false, status: 400, error: validUrl.error };
  }

  const explicitKey = String(tenantSettings?.evolutionApiKey || apiKey || '').trim();
  const resolvedKey = allowPlatformKey
    ? (explicitKey || String(process.env.EVOLUTION_API_KEY || defaultDevEvolutionKey()).trim())
    : explicitKey;

  const resolvedInstance = String(
    tenantSettings?.evolutionInstance ||
    instance ||
    process.env.EVOLUTION_INSTANCE ||
    'rit'
  ).trim() || 'rit';

  if (!validUrl.url || !resolvedInstance) {
    return { ok: false, status: 400, error: 'URL ou nome da instância ausente' };
  }
  if (!resolvedKey) {
    return {
      ok: false,
      status: 503,
      error: isCustomNonPlatformUrl
        ? 'Chave da Evolution API da unidade não configurada'
        : 'Chave da Evolution API (EVOLUTION_API_KEY) não configurada'
    };
  }

  return {
    ok: true,
    url: validUrl.url,
    isPlatform: Boolean(validUrl.isPlatform),
    allowInternalPlatform,
    apiKey: resolvedKey,
    instance: resolvedInstance
  };
}

function extractEvolutionError(data, status) {
  const nested = data?.response?.message;
  if (Array.isArray(nested) && nested.length) return nested.join('; ');
  if (typeof nested === 'string' && nested.trim()) return nested.trim();
  if (Array.isArray(data?.message) && data.message.length) return data.message.join('; ');
  if (typeof data?.message === 'string' && data.message.trim()) return data.message.trim();
  if (typeof data?.error === 'string' && data.error.trim()) return data.error.trim();
  return `Erro HTTP ${status} na Evolution API`;
}

async function fetchEvolutionJson(
  baseUrl,
  endpointPath,
  {
    method = 'GET',
    apiKey = '',
    body = null,
    timeoutMs = 8000,
    allowInternalPlatform = false,
    lookup = dns.promises.lookup,
    timeoutMessage = 'Timeout ao consultar Evolution API'
  } = {}
) {
  const hostCheck = await resolveAndVerifyPublicEvolutionHost(baseUrl, { allowInternalPlatform, lookup });
  if (!hostCheck.ok) {
    return { ok: false, status: 400, data: {}, error: hostCheck.error };
  }

  const cleanPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  const fullUrl = `${hostCheck.url}${cleanPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      ...(apiKey ? { apikey: apiKey } : {}),
      ...(body !== null ? { 'Content-Type': 'application/json' } : {})
    };
    const fetchOpts = {
      method,
      headers,
      ...(body !== null ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: controller.signal
    };
    if (!hostCheck.isPlatform) {
      fetchOpts.dispatcher = EVOLUTION_EXTERNAL_DISPATCHER;
    }
    const useMockedGlobal = typeof globalThis.fetch === 'function' && globalThis.fetch !== NATIVE_GLOBAL_FETCH;
    const doFetch = useMockedGlobal ? globalThis.fetch : (fetchOpts.dispatcher ? undiciFetch : fetch);
    const res = await doFetch(fullUrl, fetchOpts);
    clearTimeout(timer);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: extractEvolutionError(data, res.status) };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      status: 502,
      data: {},
      error: err.name === 'AbortError' ? timeoutMessage : err.message
    };
  }
}

/**
 * Envia uma mensagem de texto utilizando a Evolution API.
 */
export async function sendEvolutionTextMessage({
  phone,
  message,
  config = {},
  tenantSettings = {},
  dataDir = process.env.DATA_DIR || '',
  allowPlatformFallback = true,
  lookup = dns.promises.lookup
}) {
  const clean = cleanWhatsAppPhone(phone);
  if (!clean) return { ok: false, error: 'Telefone do destinatário inválido ou ausente' };

  const cfg = resolveEvolutionTarget({
    url: config?.url,
    apiKey: config?.apiKey,
    instance: config?.instance,
    tenantSettings,
    allowPlatformFallback
  });
  if (!cfg.ok) {
    return { ok: false, ...(cfg.status ? { status: cfg.status } : {}), error: cfg.error };
  }

  const targetNumber = await resolveEvolutionDeliveryNumber(clean, cfg, { dataDir, lookup });
  const res = await fetchEvolutionJson(
    cfg.url,
    `/message/sendText/${encodeURIComponent(cfg.instance)}`,
    {
      method: 'POST',
      apiKey: cfg.apiKey,
      body: { number: targetNumber, text: message },
      timeoutMs: 8000,
      allowInternalPlatform: cfg.allowInternalPlatform,
      lookup,
      timeoutMessage: 'Timeout na conexão com a Evolution API (8s)'
    }
  );
  if (!res.ok) {
    return { ok: false, status: res.status, error: res.error };
  }
  return { ok: true, status: res.status, data: res.data };
}

/**
 * Envia um arquivo documento (ex.: PDF da ficha de treino) via Evolution API (`/message/sendMedia/{instance}`).
 */
export async function sendEvolutionDocumentMessage({
  phone,
  fileName = 'ficha-treino.pdf',
  mediaBase64,
  mimetype = 'application/pdf',
  caption = '',
  config = {},
  tenantSettings = {},
  dataDir = process.env.DATA_DIR || '',
  allowPlatformFallback = true,
  lookup = dns.promises.lookup
}) {
  const clean = cleanWhatsAppPhone(phone);
  if (!clean) return { ok: false, error: 'Telefone do destinatário inválido ou ausente' };
  const rawBase64 = String(mediaBase64 || '').replace(/^data:[^;]+;base64,/i, '').trim();
  if (!rawBase64) return { ok: false, error: 'Conteúdo do documento ausente' };

  const cfg = resolveEvolutionTarget({
    url: config?.url,
    apiKey: config?.apiKey,
    instance: config?.instance,
    tenantSettings,
    allowPlatformFallback
  });
  if (!cfg.ok) {
    return { ok: false, ...(cfg.status ? { status: cfg.status } : {}), error: cfg.error };
  }

  const targetNumber = await resolveEvolutionDeliveryNumber(clean, cfg, { dataDir, lookup });
  const res = await fetchEvolutionJson(
    cfg.url,
    `/message/sendMedia/${encodeURIComponent(cfg.instance)}`,
    {
      method: 'POST',
      apiKey: cfg.apiKey,
      body: {
        number: targetNumber,
        mediatype: 'document',
        mimetype,
        caption: String(caption || ''),
        media: rawBase64,
        fileName: String(fileName || 'ficha-treino.pdf')
      },
      timeoutMs: 12000,
      allowInternalPlatform: cfg.allowInternalPlatform,
      lookup,
      timeoutMessage: 'Timeout na conexão com a Evolution API ao enviar documento'
    }
  );
  if (!res.ok) {
    return { ok: false, status: res.status, error: res.error };
  }
  return { ok: true, status: res.status, data: res.data };
}

/**
 * Testa a conexão e estado da instância na Evolution API.
 */
export async function testEvolutionConnection({
  url,
  apiKey,
  instance,
  tenantSettings = {},
  allowPlatformFallback = true,
  lookup = dns.promises.lookup
} = {}) {
  const cfg = resolveEvolutionTarget({ url, apiKey, instance, tenantSettings, allowPlatformFallback });
  if (!cfg.ok) {
    return { ok: false, ...(cfg.status ? { status: cfg.status } : {}), error: cfg.error };
  }

  const res = await fetchEvolutionJson(
    cfg.url,
    `/instance/connectionState/${encodeURIComponent(cfg.instance)}`,
    {
      apiKey: cfg.apiKey,
      timeoutMs: 5000,
      allowInternalPlatform: cfg.allowInternalPlatform,
      lookup
    }
  );
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: res.data?.message || res.data?.error || res.error || 'Instância não conectada'
    };
  }
  const state = res.data?.instance?.state || res.data?.state || 'open';
  return { ok: true, state, data: res.data };
}

/**
 * Obtém o QR Code de pareamento da instância na Evolution API, criando-a automaticamente em caso de 404.
 */
export async function fetchEvolutionQrCode({
  url,
  apiKey,
  instance,
  tenantSettings = {},
  allowPlatformFallback = true,
  lookup = dns.promises.lookup,
  retryDelayMs = 300
} = {}) {
  const cfg = resolveEvolutionTarget({ url, apiKey, instance, tenantSettings, allowPlatformFallback });
  if (!cfg.ok) {
    return { ok: false, status: cfg.status || 400, error: cfg.error };
  }

  const connectPath = `/instance/connect/${encodeURIComponent(cfg.instance)}`;
  let created = false;
  let res = await fetchEvolutionJson(cfg.url, connectPath, {
    apiKey: cfg.apiKey,
    timeoutMs: 8000,
    allowInternalPlatform: cfg.allowInternalPlatform,
    lookup
  });

  const msgText = extractEvolutionError(res.data, res.status);
  if (!res.ok && (res.status === 404 || /instance does not exist/i.test(msgText))) {
    const createRes = await fetchEvolutionJson(cfg.url, '/instance/create', {
      method: 'POST',
      apiKey: cfg.apiKey,
      body: {
        instanceName: cfg.instance,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true
      },
      timeoutMs: 10000,
      allowInternalPlatform: cfg.allowInternalPlatform,
      lookup
    });
    if (!createRes.ok) {
      return { ok: false, status: createRes.status || 502, error: createRes.error };
    }
    created = true;
    const createdState = createRes.data?.instance?.state || createRes.data?.instance?.status || createRes.data?.state || null;
    const createdBase64 = createRes.data?.qrcode?.base64 || createRes.data?.base64 || null;
    const createdCode = createRes.data?.qrcode?.code || createRes.data?.code || null;
    if (createdBase64 || createdState === 'open') {
      return {
        ok: true,
        created: true,
        connected: createdState === 'open',
        base64: createdBase64,
        code: createdCode,
        count: typeof createRes.data?.qrcode?.count === 'number' ? createRes.data.qrcode.count : (createdBase64 ? 1 : 0)
      };
    }
    if (retryDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
    res = await fetchEvolutionJson(cfg.url, connectPath, {
      apiKey: cfg.apiKey,
      timeoutMs: 8000,
      allowInternalPlatform: cfg.allowInternalPlatform,
      lookup
    });
  }

  if (!res.ok) {
    return { ok: false, status: res.status || 502, error: res.error };
  }

  const data = res.data || {};
  const isConnected = data?.instance?.state === 'open' || data?.state === 'open';
  const base64 = data?.base64 || data?.qrcode?.base64 || null;
  const code = data?.code || data?.qrcode?.code || null;
  const count = typeof data?.count === 'number'
    ? data.count
    : (typeof data?.qrcode?.count === 'number' ? data.qrcode.count : 0);

  return {
    ok: true,
    created,
    connected: isConnected,
    base64,
    code,
    count
  };
}

/**
 * Desconecta (logout) uma instância na Evolution API com as mesmas travas de SSRF e sem fallback de chave central em URL customizada.
 */
export async function disconnectEvolutionInstance({
  url,
  apiKey,
  instance,
  tenantSettings = {},
  allowPlatformFallback = true,
  lookup = dns.promises.lookup
} = {}) {
  const cfg = resolveEvolutionTarget({ url, apiKey, instance, tenantSettings, allowPlatformFallback });
  if (!cfg.ok) {
    return { ok: false, status: cfg.status || 400, error: cfg.error };
  }

  const res = await fetchEvolutionJson(
    cfg.url,
    `/instance/logout/${encodeURIComponent(cfg.instance)}`,
    {
      method: 'DELETE',
      apiKey: cfg.apiKey,
      timeoutMs: 8000,
      allowInternalPlatform: cfg.allowInternalPlatform,
      lookup
    }
  );
  if (!res.ok) {
    return { ok: false, status: res.status || 502, error: res.error };
  }
  return { ok: true, status: res.status, data: res.data };
}

/**
 * Lista instâncias ativas do gateway central da Evolution API usando o mesmo cliente protegido.
 */
export async function fetchEvolutionInstances({
  url,
  apiKey,
  instance = 'rit',
  allowPlatformFallback = true,
  lookup = dns.promises.lookup
} = {}) {
  const cfg = resolveEvolutionTarget({ url, apiKey, instance, allowPlatformFallback });
  if (!cfg.ok) {
    return { ok: false, status: cfg.status || 400, instances: [], error: cfg.error };
  }
  const res = await fetchEvolutionJson(cfg.url, '/instance/fetchInstances', {
    apiKey: cfg.apiKey,
    timeoutMs: 5000,
    allowInternalPlatform: cfg.allowInternalPlatform,
    lookup
  });
  if (!res.ok) {
    return { ok: false, status: res.status || 502, instances: [], error: res.error };
  }
  return {
    ok: true,
    instances: Array.isArray(res.data) ? res.data : []
  };
}

async function sendOutboxItemViaEvolution({ phone, message, document = null, config = {}, tenantSettings = {}, dataDir = process.env.DATA_DIR || '' }) {
  if (document?.mediaBase64) {
    return sendEvolutionDocumentMessage({
      phone,
      fileName: document.fileName || 'ficha-treino.pdf',
      mediaBase64: document.mediaBase64,
      mimetype: document.mimetype || 'application/pdf',
      caption: message || '',
      config,
      tenantSettings,
      dataDir
    });
  }
  return sendEvolutionTextMessage({ phone, message, config, tenantSettings, dataDir });
}

function compactSentPayload(payload) {
  if (!payload?.document) return payload;
  return {
    ...payload,
    document: {
      fileName: payload.document.fileName || 'ficha-treino.pdf',
      mimetype: payload.document.mimetype || 'application/pdf'
    }
  };
}

/**
 * Envia mensagem via Evolution API com resiliência (Outbox Queue + Retry Automático + Histórico).
 */
export async function dispatchWhatsAppWithRetry({
  dataDir,
  tenantId = 'default',
  kind = 'manual',
  recipientName = 'Destinatário',
  phone,
  message,
  document = null,
  tenantSettings = {},
  config = {},
  dedupKey = null,
  meta = null
}) {
  const clean = cleanWhatsAppPhone(phone);
  if (!clean) {
    return { ok: false, queued: false, error: 'Telefone do destinatário inválido ou ausente' };
  }

  const msgId = `wa_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const cleanDedup = dedupKey ? String(dedupKey).trim().slice(0, 200) : null;
  const preview = String(message || '').split('\n').slice(0, 2).join(' · ').slice(0, 90);
  const effectiveSettings = mergeTenantEvolutionSettings(dataDir, tenantId, tenantSettings);
  const safeSettings = {
    evolutionUrl: effectiveSettings.evolutionUrl || '',
    evolutionInstance: effectiveSettings.evolutionInstance || ''
  };
  const safeDoc = document?.mediaBase64 ? {
    fileName: String(document.fileName || 'ficha-treino.pdf'),
    mimetype: String(document.mimetype || 'application/pdf'),
    mediaBase64: String(document.mediaBase64)
  } : null;
  const basePayload = {
    ...(meta && typeof meta === 'object' ? meta : {}),
    id: msgId,
    tenantId,
    kind,
    recipientName,
    phone: clean,
    preview,
    message,
    ...(safeDoc ? { document: safeDoc } : {}),
    tenantSettings: safeSettings,
    attempts: 1,
    maxAttempts: 3,
    lastError: null,
    createdAt: nowIso,
    nextRetryAt: now,
    sentAt: null
  };

  if (isPersistentDir(dataDir)) {
    const inst = getSqliteInstance(dataDir);
    backfillRelationalTables(inst);

    if (cleanDedup) {
      // Reserva dedup_key ANTES do fetch para impedir duplicata caso 2 requisições cheguem juntas
      const reserved = runInTransaction(inst, () => {
        const ins = inst.stmts.insertOutboxIgnore.run(
          msgId,
          String(tenantId || 'default'),
          String(kind || 'manual'),
          'processing',
          cleanDedup,
          1,
          0,
          now,
          now,
          null,
          JSON.stringify(basePayload)
        );
        return ins.changes === 1;
      });
      if (!reserved) {
        return { ok: true, skipped: true, deduplicated: true, queued: false };
      }
    }

    let result;
    try {
      result = await sendOutboxItemViaEvolution({
        phone: clean,
        message,
        document: safeDoc,
        config,
        tenantSettings: effectiveSettings,
        dataDir
      });
    } catch (err) {
      result = { ok: false, error: err?.message || 'Falha de envio Evolution API' };
    }

    if (result.ok) {
      const sentAtIso = new Date().toISOString();
      const doneData = compactSentPayload({ ...basePayload, sentAt: sentAtIso, lastError: null });
      runInTransaction(inst, () => {
        inst.stmts.upsertOutboxRow.run(
          msgId, String(tenantId || 'default'), String(kind || 'manual'),
          'sent', cleanDedup, 1, 0, null, now, Date.now(), JSON.stringify(doneData)
        );
        syncOutboxKvMirrorInTx(inst);
      });
      return { ...result, id: msgId, queued: false };
    }

    const nextRetryAt = Date.now() + 20000;
    const queuedData = {
      ...basePayload,
      lastError: result.error || 'Falha de conexão com Evolution API',
      nextRetryAt
    };
    runInTransaction(inst, () => {
      inst.stmts.upsertOutboxRow.run(
        msgId, String(tenantId || 'default'), String(kind || 'manual'),
        'pending', cleanDedup, 1, nextRetryAt, null, now, null, JSON.stringify(queuedData)
      );
      syncOutboxKvMirrorInTx(inst);
    });
    scheduleBackgroundOutboxFlush(dataDir, 20000);

    return {
      ok: false,
      queued: true,
      id: msgId,
      error: result.error || 'Adicionado à fila de reenvio automático'
    };
  }

  // Caminho em memória para /tmp
  const store = loadWhatsAppOutbox(dataDir);
  if (cleanDedup && (store.queue.some(q => q.dedupKey === cleanDedup) || store.history.some(h => h.dedupKey === cleanDedup))) {
    return { ok: true, skipped: true, deduplicated: true, queued: false };
  }
  const result = await sendOutboxItemViaEvolution({
    phone: clean,
    message,
    document: safeDoc,
    config,
    tenantSettings: effectiveSettings
  });

  if (result.ok) {
    store.history.unshift({
      id: msgId, tenantId, kind, recipientName, phone: clean, preview, dedupKey: cleanDedup,
      status: 'sent', attempts: 1, error: null, createdAt: nowIso, sentAt: nowIso
    });
    saveWhatsAppOutbox(dataDir, store);
    return { ...result, id: msgId, queued: false };
  }

  const queueItem = { ...basePayload, dedupKey: cleanDedup, lastError: result.error || 'Falha de conexão com Evolution API', nextRetryAt: Date.now() + 20000 };
  store.queue.push(queueItem);
  store.history.unshift({
    id: msgId, tenantId, kind, recipientName, phone: clean, preview, dedupKey: cleanDedup,
    status: 'queued', attempts: 1, error: queueItem.lastError, createdAt: nowIso, sentAt: null
  });
  saveWhatsAppOutbox(dataDir, store);
  scheduleBackgroundOutboxFlush(dataDir, 20000);

  return {
    ok: false,
    queued: true,
    id: msgId,
    error: result.error || 'Adicionado à fila de reenvio automático'
  };
}

/**
 * Enfileira um lote de mensagens no WhatsApp Outbox com espaçamento seguro (anti-ban / jitter)
 * e proteção atômica contra duplicação via `dedupKey`.
 */
export function enqueueWhatsAppBatch({
  dataDir,
  tenantId = 'default',
  kind = 'batch',
  items = [],
  tenantSettings = {},
  baseDelayMs = 0,
  minIntervalMs = 3500,
  maxIntervalMs = 7000
}) {
  const now = Date.now();
  let cumulativeDelay = baseDelayMs;
  const enqueued = [];
  let skippedDuplicates = 0;

  const prepareItem = (item) => {
    const clean = cleanWhatsAppPhone(item.phone);
    if (!clean || !item.message) return null;
    const jitter = Math.floor(Math.random() * (maxIntervalMs - minIntervalMs + 1)) + minIntervalMs;
    cumulativeDelay += jitter;
    const msgId = 'wa_q_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
    const nowIso = new Date().toISOString();
    return {
      id: msgId,
      tenantId,
      kind,
      recipientName: item.recipientName || 'Aluno',
      phone: clean,
      preview: String(item.message || '').split('\n').slice(0, 2).join(' · ').slice(0, 90),
      message: item.message,
      dedupKey: item.dedupKey ? String(item.dedupKey).trim().slice(0, 200) : null,
      tenantSettings: {
        evolutionUrl: tenantSettings?.evolutionUrl || '',
        evolutionInstance: tenantSettings?.evolutionInstance || ''
      },
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
      createdAt: nowIso,
      nextRetryAt: now + cumulativeDelay
    };
  };

  if (isPersistentDir(dataDir)) {
    const inst = getSqliteInstance(dataDir);
    backfillRelationalTables(inst);
    runInTransaction(inst, () => {
      for (const item of items) {
        const q = prepareItem(item);
        if (!q) continue;
        const ins = inst.stmts.insertOutboxIgnore.run(
          q.id,
          String(tenantId || 'default'),
          String(kind || 'batch'),
          'pending',
          q.dedupKey,
          0,
          q.nextRetryAt,
          null,
          now,
          null,
          JSON.stringify(q)
        );
        if (ins.changes === 1) {
          enqueued.push(q);
        } else {
          skippedDuplicates++;
        }
      }
      if (enqueued.length > 0) {
        syncOutboxKvMirrorInTx(inst);
      }
    });
  } else {
    const store = loadWhatsAppOutbox(dataDir);
    const existingKeys = new Set(store.queue.map(q => q.dedupKey).filter(Boolean));
    for (const item of items) {
      const q = prepareItem(item);
      if (!q) continue;
      if (q.dedupKey && existingKeys.has(q.dedupKey)) {
        skippedDuplicates++;
        continue;
      }
      if (q.dedupKey) existingKeys.add(q.dedupKey);
      store.queue.push(q);
      store.history.unshift({
        id: q.id,
        tenantId,
        kind,
        recipientName: q.recipientName,
        phone: q.phone,
        preview: q.preview,
        status: 'queued',
        attempts: 0,
        error: null,
        createdAt: q.createdAt,
        sentAt: null
      });
      enqueued.push(q);
    }
    saveWhatsAppOutbox(dataDir, store);
  }

  if (enqueued.length > 0) {
    scheduleBackgroundOutboxFlush(dataDir, Math.min(cumulativeDelay, 5000));
  }
  return {
    ok: true,
    count: enqueued.length,
    skippedDuplicates,
    estimatedDurationSec: enqueued.length > 0 ? Math.round(cumulativeDelay / 1000) : 0
  };
}

/**
 * Processa a fila de mensagens pendentes (Outbox) reivindicando cada item atomicamente (`status='processing'`)
 * antes da chamada HTTP para que 2 flushes simultâneos nunca enviem o mesmo WhatsApp 2x.
 */
export async function flushWhatsAppOutbox(dataDir, { force = false, tenantId = null } = {}) {
  if (!isPersistentDir(dataDir)) {
    const store = loadWhatsAppOutbox(dataDir);
    if (!store.queue.length) return { processed: 0, sent: 0, stillQueued: 0, failed: 0 };
    const now = Date.now();
    const nextQueue = [];
    let processed = 0;
    let sent = 0;
    let failed = 0;
    for (const item of store.queue) {
      const matchesTenant = !tenantId || item.tenantId === tenantId;
      const isDue = force || now >= Number(item.nextRetryAt || 0);
      if (!matchesTenant || !isDue) { nextQueue.push(item); continue; }
      processed++;
      const cleanItem = sanitizeOutboxQueueItem(item);
      const effectiveItemSettings = mergeTenantEvolutionSettings(dataDir, item.tenantId, cleanItem.tenantSettings || {});
      const res = await sendOutboxItemViaEvolution({
        phone: item.phone,
        message: item.message,
        document: item.document || null,
        tenantSettings: effectiveItemSettings
      });
      const histEntry = store.history.find(h => h.id === item.id);
      if (res.ok) {
        sent++;
        if (histEntry) { histEntry.status = 'sent'; histEntry.attempts = (item.attempts || 1) + 1; histEntry.error = null; histEntry.sentAt = new Date().toISOString(); }
      } else {
        const nextAttempts = (item.attempts || 1) + 1;
        if (nextAttempts >= (item.maxAttempts || 3)) {
          failed++;
          if (histEntry) { histEntry.status = 'failed'; histEntry.attempts = nextAttempts; histEntry.error = res.error || 'Máximo de tentativas excedido'; }
        } else {
          cleanItem.attempts = nextAttempts;
          cleanItem.lastError = res.error || 'Falha temporária';
          cleanItem.nextRetryAt = Date.now() + nextAttempts * 45000;
          nextQueue.push(cleanItem);
          if (histEntry) { histEntry.status = 'queued'; histEntry.attempts = nextAttempts; histEntry.error = cleanItem.lastError; }
        }
      }
    }
    store.queue = nextQueue;
    saveWhatsAppOutbox(dataDir, store);
    if (store.queue.length > 0) scheduleBackgroundOutboxFlush(dataDir, 45000);
    return { processed, sent, stillQueued: store.queue.filter(q => !tenantId || q.tenantId === tenantId).length, failed };
  }

  const inst = getSqliteInstance(dataDir);
  backfillRelationalTables(inst);
  const now = Date.now();

  // 1. Reivindicação atômica de itens elegíveis dentro de BEGIN IMMEDIATE
  const claimedRows = runInTransaction(inst, () => {
    // Libera locks órfãos de workers que tenham morrido (> 5 minutos)
    inst.stmts.reclaimStaleOutboxLocks.run(now - 5 * 60 * 1000);
    const dueLimit = force ? Number.MAX_SAFE_INTEGER : now;
    const candidates = inst.stmts.getOutboxReady.all(dueLimit, 50);
    const claimed = [];
    for (const c of candidates) {
      if (tenantId && c.tenant_id !== tenantId) continue;
      const locked = inst.stmts.claimOutboxItem.get(now, c.id);
      if (locked) claimed.push(locked);
    }
    return claimed;
  });

  if (claimedRows.length === 0) {
    const remaining = inst.stmts.getOutboxPending.all().filter(r => !tenantId || r.tenant_id === tenantId).length;
    return { processed: 0, sent: 0, stillQueued: remaining, failed: 0 };
  }

  // 2. Disparo HTTP fora de transação
  let sent = 0;
  let failed = 0;
  for (const row of claimedRows) {
    let rawItem;
    try { rawItem = JSON.parse(row.data); } catch { rawItem = {}; }
    const item = sanitizeOutboxQueueItem(rawItem);
    const effectiveSettings = mergeTenantEvolutionSettings(dataDir, row.tenant_id, item.tenantSettings || {});
    let res;
    try {
      res = await sendOutboxItemViaEvolution({
        phone: item.phone,
        message: item.message,
        document: item.document || null,
        tenantSettings: effectiveSettings
      });
    } catch (err) {
      res = { ok: false, error: err?.message || 'Erro ao enviar' };
    }

    const doneNow = Date.now();
    runInTransaction(inst, () => {
      if (res.ok) {
        sent++;
        const nextAttempts = Number(row.attempts || 0) + 1;
        const nextData = compactSentPayload({
          ...item,
          attempts: nextAttempts,
          lastError: null,
          sentAt: new Date(doneNow).toISOString()
        });
        inst.stmts.upsertOutboxRow.run(
          row.id, row.tenant_id, row.kind, 'sent', row.dedup_key,
          nextAttempts, 0, null, row.created_at, doneNow, JSON.stringify(nextData)
        );
      } else {
        const nextAttempts = Number(row.attempts || 0) + 1;
        const maxAttempts = Number(item.maxAttempts || 3);
        if (nextAttempts >= maxAttempts) {
          failed++;
          const nextData = compactSentPayload({
            ...item,
            attempts: nextAttempts,
            lastError: res.error || 'Máximo de tentativas excedido'
          });
          inst.stmts.upsertOutboxRow.run(
            row.id, row.tenant_id, row.kind, 'failed', row.dedup_key,
            nextAttempts, 0, null, row.created_at, doneNow, JSON.stringify(nextData)
          );
        } else {
          const nextRetryAt = doneNow + nextAttempts * 45000;
          const nextData = {
            ...item,
            attempts: nextAttempts,
            lastError: res.error || 'Falha temporária',
            nextRetryAt
          };
          inst.stmts.upsertOutboxRow.run(
            row.id, row.tenant_id, row.kind, 'pending', row.dedup_key,
            nextAttempts, nextRetryAt, null, row.created_at, null, JSON.stringify(nextData)
          );
        }
      }
      syncOutboxKvMirrorInTx(inst);
    });
  }

  const pendingAfter = inst.stmts.getOutboxPending.all();
  if (pendingAfter.length > 0) {
    scheduleBackgroundOutboxFlush(dataDir, 45000);
  }

  return {
    processed: claimedRows.length,
    sent,
    stillQueued: pendingAfter.filter(q => !tenantId || q.tenant_id === tenantId).length,
    failed
  };
}

/**
 * Retorna estatísticas da fila e histórico recente de envios de uma academia/personal.
 */
export function getTenantWhatsAppOutbox(dataDir, tenantId = 'default') {
  const store = loadWhatsAppOutbox(dataDir);
  const queue = store.queue.filter(q => tenantId === 'default' || q.tenantId === tenantId);
  const history = store.history
    .filter(h => tenantId === 'default' || h.tenantId === tenantId)
    .slice(0, 25);

  return {
    queuedCount: queue.length,
    sentCount: history.filter(h => h.status === 'sent').length,
    failedCount: history.filter(h => h.status === 'failed').length,
    queue,
    history
  };
}

export const MAX_WA_MESSAGE_CHARS = 3800;

function resolveStudentAppUrl(tenantId = 'default', customUrl = '') {
  if (customUrl && String(customUrl).trim()) return String(customUrl).trim();
  const rawBase = String(process.env.ORIGIN || 'https://app.treinerit.com.br').trim().replace(/\/+$/, '');
  if (!tenantId || tenantId === 'default') return rawBase;
  return `${rawBase}/?tenant=${encodeURIComponent(tenantId)}`;
}

function getScheduledDaysForRoutine(routine, explicitDays = null, weekMap = null) {
  if (Array.isArray(explicitDays) && explicitDays.length > 0) {
    return [...new Set(explicitDays.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))];
  }
  if (!weekMap || typeof weekMap !== 'object' || !routine?.id) return [];
  const out = [];
  for (let d = 0; d <= 6; d++) {
    const ids = [].concat(weekMap[String(d)] || []);
    if (ids.includes(routine.id)) out.push(d);
  }
  return out;
}

function sortDaysMonToSun(days = []) {
  return [...days].sort((a, b) => ((Number(a) + 6) % 7) - ((Number(b) + 6) % 7));
}

function formatPrescribedExerciseLine(ex, index) {
  const setsCount = Array.isArray(ex?.sets) ? ex.sets.length : Number(ex?.sets || 3);
  const setsLabel = `${setsCount} ${setsCount === 1 ? 'série' : 'séries'}`;

  let repsText = '';
  if (ex?.repsMin && ex?.repsMax && Number(ex.repsMin) !== Number(ex.repsMax)) {
    repsText = `${ex.repsMin}-${ex.repsMax} reps`;
  } else if (Array.isArray(ex?.sets) && ex.sets[0]?.r !== undefined && ex.sets[0]?.r !== '') {
    repsText = `${ex.sets[0].r} reps`;
  } else if (ex?.reps !== undefined && ex?.reps !== null && String(ex.reps).trim() !== '') {
    repsText = `${ex.reps} reps`;
  }

  const rawWeight = Array.isArray(ex?.sets) ? ex.sets[0]?.w : ex?.weight;
  const weightFmt = formatKgValuePtBr(rawWeight);
  const weightPart = weightFmt ? `⚖️ ${weightFmt} kg` : '';

  const restNum = Number(ex?.restSec);
  const restPart = Number.isFinite(restNum) && restNum > 0 ? `⏱️ ${Math.round(restNum)}s descanso` : '';

  const setRepPart = repsText ? `${setsLabel} × ${repsText}` : setsLabel;
  const detailLine = [setRepPart, weightPart, restPart].filter(Boolean).join(' · ');
  const noteStr = ex?.note && String(ex.note).trim() ? `\n   _💡 Obs: ${String(ex.note).trim()}_` : '';
  return `• *${index + 1}. ${ex?.name || 'Exercício'}*\n   ▸ ${detailLine}${noteStr}`;
}

function formatSingleRoutineSection(routine, idx, totalRoutines, days = []) {
  const rName = String(routine?.name || `Treino ${idx + 1}`).trim();
  const exList = Array.isArray(routine?.ex) ? routine.ex : [];
  const dayLabels = sortDaysMonToSun(days)
    .map(d => WEEKDAY_SHORT_PT[Number(d)])
    .filter(Boolean);

  const exerciseBlocks = exList.map((e, i) => formatPrescribedExerciseLine(e, i));

  if (totalRoutines > 1) {
    const countLabel = `_${exList.length} ${exList.length === 1 ? 'exercício' : 'exercícios'}_`;
    const metaLine = dayLabels.length > 0
      ? `📅 *Dias programados:* ${dayLabels.join(', ')} · ${countLabel}`
      : `🏋️‍♂️ ${countLabel}`;
    return [
      `━━━━━━━━━━━━━━━━━━━━`,
      `🔥 *${idx + 1}. ${rName.toUpperCase()}*`,
      metaLine,
      exerciseBlocks.length > 0 ? `\n${exerciseBlocks.join('\n\n')}` : ''
    ].filter(Boolean).join('\n');
  }

  return [
    `🏋️‍♂️ *Ficha:* ${rName}`,
    dayLabels.length > 0 ? `📅 *Dias programados:* ${dayLabels.join(', ')}` : null,
    exerciseBlocks.length > 0 ? `\n🔥 *Exercícios Prescritos (${exList.length}):*\n\n${exerciseBlocks.join('\n\n')}` : null
  ].filter(l => l !== null).join('\n');
}

/**
 * Formata uma ou múltiplas fichas prescritas em mensagem(ns) estruturada(s) para o WhatsApp
 * (sem truncar exercícios, quebrando em partes sequenciais apenas se ultrapassar `maxChars`).
 */
export function formatPrescribedRoutinesWhatsAppMessages({
  studentName = 'Aluno',
  routine = null,
  routines = null,
  days = [],
  week = null,
  tenantId = 'default',
  tenantName = 'Academia',
  trainerName = '',
  appUrl = '',
  maxChars = MAX_WA_MESSAGE_CHARS
}) {
  const firstName = String(studentName || 'Aluno').trim().split(' ')[0];
  const rawList = Array.isArray(routines) && routines.length > 0
    ? routines
    : (routine ? [{ routine, days }] : []);

  const items = rawList
    .map(item => {
      const rObj = item?.routine || item;
      if (!rObj || typeof rObj !== 'object') return null;
      const itemDays = getScheduledDaysForRoutine(rObj, item?.days ?? (rawList.length === 1 ? days : null), week);
      return { routine: rObj, days: itemDays };
    })
    .filter(Boolean);

  if (items.length === 0) return [];

  const totalRoutines = items.length;
  const senderText = trainerName ? `Seu professor *${trainerName}*` : `A equipe da *${tenantName}*`;
  const resolvedUrl = resolveStudentAppUrl(tenantId, appUrl);

  const buildHeader = (partIndex = null, partTotal = 1) => {
    const partBadge = partTotal > 1 && partIndex ? ` — _Parte ${partIndex}/${partTotal}_` : '';
    const titleLine = totalRoutines > 1
      ? `🏋️‍♂️ *SEU NOVO PLANO DE TREINO ESTÁ PRONTO!*${partBadge}`
      : `📋 *Nova Ficha de Treino Disponível!*${partBadge}`;
    const introLine = totalRoutines > 1
      ? `Olá, *${firstName}*! Tudo bem? 💪\n${senderText} liberou sua programação completa com *${totalRoutines} fichas de treino*:`
      : `Olá, *${firstName}*! ${senderText} acabou de publicar uma nova prescrição para você:`;
    return [
      titleLine,
      `🏢 *${tenantName}* · _Aplicativo Rit_`,
      ``,
      introLine
    ].join('\n');
  };

  const footer = [
    totalRoutines > 1 ? `━━━━━━━━━━━━━━━━━━━━` : null,
    ``,
    `📲 *Acesse seu treino no App Rit:*`,
    `Abra o aplicativo *Rit* para ver os vídeos de execução, registrar suas cargas e iniciar seu treino:`,
    `👉 ${resolvedUrl}`,
    ``,
    `_Bons treinos! Qualquer dúvida, fale com seu professor._ 🚀`
  ].filter(l => l !== null).join('\n');

  const sectionStrings = items.map((it, idx) =>
    formatSingleRoutineSection(it.routine, idx, totalRoutines, it.days)
  );

  const fullSingle = [buildHeader(null, 1), '', sectionStrings.join('\n\n'), footer].join('\n');
  const limit = Math.max(800, Number(maxChars) || MAX_WA_MESSAGE_CHARS);
  if (fullSingle.length <= limit) {
    return [fullSingle];
  }

  // Agrupa treinos inteiros em blocos sem exceder `limit` (nunca perde nenhum exercício)
  const chunkBuckets = [];
  let currentBucket = [];
  const headerReserve = buildHeader(1, 9).length + footer.length + 20;

  for (let i = 0; i < sectionStrings.length; i++) {
    const sec = sectionStrings[i];
    const candidate = [...currentBucket, sec].join('\n\n');
    if (currentBucket.length > 0 && headerReserve + candidate.length > limit) {
      chunkBuckets.push(currentBucket);
      currentBucket = [sec];
    } else if (currentBucket.length === 0 && headerReserve + sec.length > limit) {
      // Se uma ficha única sozinha passar do limite, quebra nos exercícios mantendo o título da ficha
      const item = items[i];
      const rObj = item.routine;
      const exList = Array.isArray(rObj?.ex) ? rObj.ex : [];
      const dayLabels = sortDaysMonToSun(item.days).map(d => WEEKDAY_SHORT_PT[Number(d)]).filter(Boolean);
      const secHead = [
        totalRoutines > 1 ? `━━━━━━━━━━━━━━━━━━━━` : null,
        `🔥 *${totalRoutines > 1 ? `${i + 1}. ` : ''}${String(rObj?.name || 'Treino').toUpperCase()}*`,
        dayLabels.length > 0 ? `📅 *Dias programados:* ${dayLabels.join(', ')}` : null
      ].filter(Boolean).join('\n');
      let exAcc = [];
      for (let exIdx = 0; exIdx < exList.length; exIdx++) {
        const exLine = formatPrescribedExerciseLine(exList[exIdx], exIdx);
        const testText = `${secHead}\n\n${[...exAcc, exLine].join('\n\n')}`;
        if (exAcc.length > 0 && headerReserve + testText.length > limit) {
          chunkBuckets.push([`${secHead}\n\n${exAcc.join('\n\n')}`]);
          exAcc = [exLine];
        } else {
          exAcc.push(exLine);
        }
      }
      if (exAcc.length > 0) {
        currentBucket = [`${secHead}\n\n${exAcc.join('\n\n')}`];
      }
    } else {
      currentBucket.push(sec);
    }
  }
  if (currentBucket.length > 0) {
    chunkBuckets.push(currentBucket);
  }

  const totalParts = chunkBuckets.length;
  return chunkBuckets.map((bucket, idx) =>
    [buildHeader(idx + 1, totalParts), '', bucket.join('\n\n'), footer].join('\n')
  );
}

/**
 * Formata mensagem automática para avisar o Aluno que uma ou mais fichas foram prescritas no app.
 */
export function formatPrescribedRoutineWhatsAppMessage(opts = {}) {
  return formatPrescribedRoutinesWhatsAppMessages(opts).join('\n\n');
}

function buildPrescriptionContentHash({ studentKey, items }) {
  const canonical = {
    studentKey: String(studentKey || ''),
    routines: items.map(it => {
      const r = it?.routine || it || {};
      const ex = Array.isArray(r.ex) ? r.ex : [];
      return {
        name: String(r.name || '').trim(),
        days: sortDaysMonToSun(it?.days || []),
        ex: ex.map(e => ({
          id: String(e?.id || ''),
          name: String(e?.name || ''),
          sets: Array.isArray(e?.sets) ? e.sets.length : Number(e?.sets || 3),
          reps: e?.reps ?? (Array.isArray(e?.sets) ? e.sets[0]?.r : ''),
          repsMin: e?.repsMin ?? null,
          repsMax: e?.repsMax ?? null,
          weight: Number(Array.isArray(e?.sets) ? e.sets[0]?.w : (e?.weight || 0)),
          restSec: Number(e?.restSec || 0),
          note: String(e?.note || '').trim()
        }))
      };
    })
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

const recentPrescriptionMemoryDedup = new Map();

/**
 * Formata legenda curta e escaneável para acompanhar o PDF da(s) ficha(s) de treino no WhatsApp.
 */
export function formatPrescribedRoutinesWhatsAppCaption({
  studentName = 'Aluno',
  routine = null,
  routines = null,
  days = [],
  week = null,
  tenantId = 'default',
  tenantName = 'Academia',
  trainerName = '',
  appUrl = ''
}) {
  const firstName = String(studentName || 'Aluno').trim().split(' ')[0];
  const rawList = Array.isArray(routines) && routines.length > 0
    ? routines
    : (routine ? [{ routine, days }] : []);

  const items = rawList
    .map(item => {
      const rObj = item?.routine || item;
      if (!rObj || typeof rObj !== 'object') return null;
      const itemDays = getScheduledDaysForRoutine(rObj, item?.days ?? (rawList.length === 1 ? days : null), week);
      return { routine: rObj, days: itemDays };
    })
    .filter(Boolean);

  if (items.length === 0) return '';

  const total = items.length;
  const senderText = trainerName ? `Seu professor *${trainerName}*` : `A equipe da *${tenantName}*`;
  const resolvedUrl = resolveStudentAppUrl(tenantId, appUrl);

  const summaryLines = items.map(it => {
    const rName = String(it.routine?.name || 'Ficha de Treino').trim();
    const exCount = Array.isArray(it.routine?.ex) ? it.routine.ex.length : 0;
    const dayLabels = sortDaysMonToSun(it.days).map(d => WEEKDAY_SHORT_PT[Number(d)]).filter(Boolean);
    const meta = [
      dayLabels.length ? dayLabels.join(', ') : null,
      exCount > 0 ? `${exCount} ${exCount === 1 ? 'exercício' : 'exercícios'}` : null
    ].filter(Boolean).join(' · ');
    return meta ? `• *${rName}* (_${meta}_)` : `• *${rName}*`;
  });

  const introLine = total > 1
    ? `${senderText} enviou em anexo o PDF completo com suas *${total} fichas de treino*:`
    : `${senderText} enviou em anexo o PDF completo da sua nova ficha de treino:`;

  return [
    total > 1 ? `📋 *Novo Plano de Treino Liberado!*` : `📋 *Nova Ficha de Treino Liberada!*`,
    `🏢 *${tenantName}* · _App Rit_`,
    ``,
    `Olá, *${firstName}*! 💪`,
    introLine,
    ``,
    ...summaryLines,
    ``,
    `📲 *Abra o app Rit* para ver os vídeos de execução e registrar suas cargas:`,
    `👉 ${resolvedUrl}`
  ].join('\n');
}

/**
 * Notifica o aluno via WhatsApp enviando o PDF consolidado de todas as fichas prescritas + legenda curta,
 * com deduplicação por hash de conteúdo e substituição de itens ainda pendentes na fila.
 */
export async function notifyRoutinePrescribed({
  dataDir,
  tenantId = 'default',
  student,
  routine = null,
  routines = null,
  days = [],
  week = null,
  trainerUser = null,
  tenant = null,
  cooldownMs = 10 * 60 * 1000
}) {
  if (!student?.phone) {
    return { ok: false, skipped: true, reason: 'Aluno sem WhatsApp cadastrado' };
  }
  const cleanPhone = cleanWhatsAppPhone(student.phone);
  if (!cleanPhone) {
    return { ok: false, skipped: true, reason: 'Telefone do destinatário inválido ou ausente' };
  }

  const resolvedTenant = tenant || (tenantId !== 'default' ? getTenant(dataDir, tenantId) : null);
  const settings = mergeTenantEvolutionSettings(dataDir, tenantId, resolvedTenant?.settings || {});

  if (settings.notifyStudentOnPrescribe === false) {
    return { ok: false, skipped: true, reason: 'Aviso de prescrição desativado nas configurações' };
  }

  const rawList = Array.isArray(routines) && routines.length > 0
    ? routines
    : (routine ? [{ routine, days }] : []);

  const normalizedItems = rawList
    .map(item => {
      const rObj = item?.routine || item;
      if (!rObj || typeof rObj !== 'object') return null;
      const itemDays = getScheduledDaysForRoutine(rObj, item?.days ?? (rawList.length === 1 ? days : null), week);
      return { routine: rObj, days: itemDays };
    })
    .filter(Boolean);

  if (normalizedItems.length === 0) {
    return { ok: false, skipped: true, reason: 'Nenhuma ficha informada' };
  }

  const tenantName = resolvedTenant?.name || 'Sua Academia';
  const trainerName = trainerUser?.name || '';
  const studentKey = student?.id || cleanPhone;
  const contentHash = buildPrescriptionContentHash({ studentKey, items: normalizedItems });
  const appUrl = resolveStudentAppUrl(tenantId);

  const caption = formatPrescribedRoutinesWhatsAppCaption({
    studentName: student.name || 'Aluno',
    routines: normalizedItems,
    week,
    tenantId,
    tenantName,
    trainerName,
    appUrl
  });

  const pdf = buildPrescriptionPlanPdfBytes({
    student,
    routines: normalizedItems,
    week: week || {},
    tenant: resolvedTenant || { name: tenantName },
    branding: resolvedTenant?.branding || {},
    trainerName,
    appUrl
  });

  if (!pdf?.base64 || !caption) {
    return { ok: false, skipped: true, reason: 'Falha ao gerar PDF da ficha' };
  }

  const now = Date.now();
  const windowBucket = Math.floor(now / Math.max(60000, Number(cooldownMs) || 600000));
  const baseDedupKey = `prescription:${tenantId}:${studentKey}:${contentHash}:${windowBucket}`;

  if (isPersistentDir(dataDir)) {
    const inst = getSqliteInstance(dataDir);
    backfillRelationalTables(inst);
    const dedupCheck = runInTransaction(inst, () => {
      const cutoff = now - (Number(cooldownMs) || 600000);
      const recentRows = inst.db.prepare(
        "SELECT * FROM whatsapp_outbox WHERE tenant_id = ? AND kind = 'prescription_notice' AND created_at >= ?"
      ).all(String(tenantId || 'default'), cutoff);

      let duplicateFound = false;
      let cancelledPending = 0;
      for (const row of recentRows) {
        let d = {};
        try { d = JSON.parse(row.data); } catch { continue; }
        const sameStudent = d.studentId ? d.studentId === studentKey : d.phone === cleanPhone;
        if (!sameStudent) continue;

        if (row.status !== 'cancelled' && row.status !== 'failed' && d.contentHash === contentHash) {
          duplicateFound = true;
          break;
        }
        if (row.status === 'pending' && d.contentHash !== contentHash) {
          const cancelledData = compactSentPayload({ ...d, lastError: 'Substituído por prescrição mais recente' });
          inst.stmts.upsertOutboxRow.run(
            row.id, row.tenant_id, row.kind, 'cancelled', row.dedup_key,
            row.attempts, 0, null, row.created_at, now, JSON.stringify(cancelledData)
          );
          cancelledPending++;
        }
      }
      if (cancelledPending > 0) syncOutboxKvMirrorInTx(inst);
      return { duplicateFound };
    });

    if (dedupCheck.duplicateFound) {
      return {
        ok: true,
        skipped: true,
        deduplicated: true,
        queued: false,
        contentHash,
        partCount: 1,
        pdfFileName: pdf.filename,
        pdfSize: pdf.bytes.length,
        caption,
        messages: [caption]
      };
    }
  } else {
    const memKey = `${dataDir}:${tenantId}:${studentKey}`;
    const prevMem = recentPrescriptionMemoryDedup.get(memKey);
    if (prevMem && prevMem.hash === contentHash && now - prevMem.at < (Number(cooldownMs) || 600000)) {
      return {
        ok: true,
        skipped: true,
        deduplicated: true,
        queued: false,
        contentHash,
        partCount: 1,
        pdfFileName: pdf.filename,
        pdfSize: pdf.bytes.length,
        caption,
        messages: [caption]
      };
    }
    recentPrescriptionMemoryDedup.set(memKey, { hash: contentHash, at: now });
  }

  const res = await dispatchWhatsAppWithRetry({
    dataDir,
    tenantId,
    kind: 'prescription_notice',
    recipientName: student.name || 'Aluno',
    phone: cleanPhone,
    message: caption,
    document: {
      fileName: pdf.filename,
      mediaBase64: pdf.base64,
      mimetype: 'application/pdf'
    },
    tenantSettings: settings,
    dedupKey: baseDedupKey,
    meta: { studentId: studentKey, contentHash, part: 1, partCount: 1, pdfFileName: pdf.filename }
  });

  return {
    ok: Boolean(res.ok),
    queued: Boolean(res.queued),
    deduplicated: Boolean(res.deduplicated),
    partCount: 1,
    contentHash,
    pdfFileName: pdf.filename,
    pdfSize: pdf.bytes.length,
    caption,
    messages: [caption],
    ...(res.error ? { error: res.error } : {})
  };
}

const DEFAULT_GENERIC_WELCOME = 'Bem-vindo ao nosso app oficial de treinos! Confira sua ficha do dia.';

/**
 * Constrói a URL dinâmica de ativação/cadastro do aluno já preenchida com tenant e código de convite.
 */
export function buildStudentInviteSignupUrl({ appUrl = '', tenantId = '', inviteCode = '' } = {}) {
  const base = String(appUrl || process.env.PUBLIC_APP_URL || process.env.ORIGIN || 'https://app.treinerit.com.br')
    .trim()
    .replace(/\/+$/, '');
  const code = String(inviteCode || '').trim().toUpperCase();
  const cleanTenant = String(tenantId || '').trim();
  const params = new URLSearchParams();
  if (cleanTenant && cleanTenant !== 'default') {
    params.set('tenant', cleanTenant);
  }
  if (code) {
    params.set('convite', code);
  }
  const qs = params.toString();
  return qs ? `${base}/cadastro?${qs}` : `${base}/cadastro`;
}

/**
 * Formata a mensagem de saudação e boas-vindas com link direto e código de convite isolado no WhatsApp.
 */
export function formatStudentWelcomeWhatsAppMessage({
  studentName = 'Aluno(a)',
  tenantName = '',
  trainerName = '',
  inviteCode = '',
  signupUrl = '',
  customWelcome = ''
} = {}) {
  const cleanFirst = String(studentName || '').trim().split(/\s+/)[0] || 'Aluno(a)';
  const gym = String(tenantName || trainerName || 'Rit').trim() || 'Rit';
  const code = String(inviteCode || '').trim().toUpperCase();
  const url = String(signupUrl || buildStudentInviteSignupUrl({ tenantId: '', inviteCode: code })).trim();
  const cleanCustom = String(customWelcome || '').trim();
  const hasCustom = Boolean(cleanCustom) && cleanCustom !== DEFAULT_GENERIC_WELCOME;

  const lines = [
    `👋 Olá, *${cleanFirst}*! Seja muito bem-vindo(a) à *${gym}*! 🏋️‍♂️`,
    ...(hasCustom ? [``, cleanCustom] : []),
    ``,
    `Seu cadastro já foi criado pelo seu professor e seu acesso ao nosso app de treinos está liberado.`,
    ``,
    `🚀 *Como ativar sua conta em 1 minuto:*`,
    `1️⃣ Toque no link de cadastro abaixo`,
    `2️⃣ Confira seu nome e crie sua senha de acesso`,
    `3️⃣ Pronto! Seus treinos aparecerão na tela inicial`,
    ``,
    `🔗 *Link direto de ativação:*`,
    url,
    ``,
    `🎟️ *Código de convite:*`,
    `*${code}*`,
    `_(Use este código caso prefira abrir o app e digitar manualmente)_`,
    ``,
    `Bons treinos! 💪`
  ];
  return lines.join('\n');
}

/**
 * Envia de forma isolada e resiliente a saudação com código de convite no WhatsApp do aluno recém-cadastrado.
 */
export async function notifyStudentWelcomeInvite({
  dataDir,
  tenantId = 'default',
  student,
  inviteCode = '',
  signupUrl = '',
  trainerUser = null,
  tenant = null,
  appUrl = '',
  force = false
}) {
  const code = String(inviteCode || '').trim().toUpperCase();
  const cleanPhone = cleanWhatsAppPhone(student?.phone);
  const resolvedTenant = tenant || (tenantId && tenantId !== 'default' ? getTenant(dataDir, tenantId) : null);
  const url = String(signupUrl || buildStudentInviteSignupUrl({
    appUrl,
    tenantId: resolvedTenant?.id || tenantId,
    inviteCode: code
  })).trim();

  if (!cleanPhone) {
    return {
      ok: false,
      skipped: true,
      queued: false,
      reason: 'Telefone do aluno inválido ou ausente',
      status: 'skipped',
      inviteCode: code,
      signupUrl: url,
      text: ''
    };
  }

  const settings = mergeTenantEvolutionSettings(dataDir, tenantId, resolvedTenant?.settings || {});
  const text = formatStudentWelcomeWhatsAppMessage({
    studentName: student?.name || 'Aluno(a)',
    tenantName: resolvedTenant?.name || '',
    trainerName: trainerUser?.name || '',
    inviteCode: code,
    signupUrl: url,
    customWelcome: resolvedTenant?.settings?.welcomeMessage || ''
  });

  const studentKey = student?.id || cleanPhone;
  const dedupKey = force ? '' : `welcome_invite:${tenantId || 'default'}:${studentKey}:${code}`;

  try {
    const res = await dispatchWhatsAppWithRetry({
      dataDir,
      tenantId: tenantId || 'default',
      kind: 'welcome_invite',
      recipientName: student?.name || 'Aluno',
      phone: cleanPhone,
      message: text,
      tenantSettings: settings,
      dedupKey: dedupKey || null,
      meta: {
        studentId: student?.id || null,
        studentName: student?.name || null,
        inviteCode: code,
        signupUrl: url
      }
    });
    const status = res.ok && !res.skipped
      ? 'sent'
      : res.queued
        ? 'queued'
        : res.skipped
          ? 'sent'
          : 'failed';
    return {
      ...res,
      status,
      inviteCode: code,
      signupUrl: url,
      text
    };
  } catch (err) {
    return {
      ok: false,
      queued: false,
      error: err?.message || 'Falha ao enviar saudação no WhatsApp',
      status: 'failed',
      inviteCode: code,
      signupUrl: url,
      text
    };
  }
}

/**
 * Formata mensagem proativa de Recuperação Anti-Evasão (Churn) para alunos ausentes.
 */
export function formatChurnRecoveryWhatsAppMessage({
  studentName = 'Aluno',
  daysInactive = null,
  tenantName = 'Sua Academia',
  trainerName = ''
}) {
  const firstName = String(studentName || 'Aluno').trim().split(' ')[0];
  const senderIdentity = trainerName ? `o Prof. *${trainerName}* da *${tenantName}*` : `a equipe da *${tenantName}*`;
  const absenceLine = daysInactive && Number(daysInactive) > 0
    ? `Notamos que já faz *${daysInactive} dias* desde o seu último treino registrado.`
    : `Sentimos sua falta nos treinos desta semana!`;

  return [
    `💪 *Olá, ${firstName}! Tudo bem?*`,
    `Aqui é ${senderIdentity}.`,
    ``,
    `${absenceLine} Tudo certo por aí?`,
    ``,
    `Sua rotina está pronta esperando por você no aplicativo *Rit*. Se precisar adaptar algum exercício ou ajustar seus horários para retomar no seu ritmo, conte com a gente! 🚀`
  ].join('\n');
}

/**
 * Hook disparado no backend ao sincronizar o estado do aluno (`PUT /api/state`).
 * Detecta se houve finalização de um novo treino e envia o relatório para o personal trainer.
 */
export async function notifyWorkoutCompletedIfAny({ dataDir, user, curState, newState, db = { users: [] }, catalogueById = null }) {
  if (!user || !newState) return { notified: 0 };

  const prevWorkouts = Array.isArray(curState?.workouts) ? curState.workouts : [];
  const nextWorkouts = Array.isArray(newState?.workouts) ? newState.workouts : [];
  const prevIds = new Set(prevWorkouts.map(w => w?.id).filter(Boolean));
  const newWorkouts = nextWorkouts.filter(w => w?.id && !prevIds.has(w.id));

  if (newWorkouts.length === 0) return { notified: 0 };

  // 1. Identifica a academia e configurações de notificação
  const tenantId = user.tenantId || 'default';
  const tenant = tenantId !== 'default' ? getTenant(dataDir, tenantId) : null;
  const settings = mergeTenantEvolutionSettings(dataDir, tenantId, tenant?.settings || {});

  // Se o gestor ou personal desativou a notificação no painel
  if (settings.notifyTrainerOnWorkout === false) {
    return { notified: 0, reason: 'Notificação desativada nas configurações da unidade' };
  }

  // 2. Descobre o telefone do Personal Trainer ou da Academia e o Professor Responsável
  let targetPhone = null;
  let targetName = null;
  let trainerName = '';

  // Primeiro: Personal Trainer atribuído ao aluno
  if (user.assignedTrainerId) {
    const trainer = (db.users || []).find(u => u.id === user.assignedTrainerId);
    if (trainer) {
      trainerName = trainer.name;
      if (trainer.phone) {
        targetPhone = trainer.phone;
        targetName = trainer.name;
      }
    }
  }

  // Tenta também buscar o professor que prescreveu a ficha de treino
  if (!trainerName && newWorkouts.length > 0) {
    const allRoutines = [
      ...(Array.isArray(newState?.routines) ? newState.routines : []),
      ...(Array.isArray(curState?.routines) ? curState.routines : [])
    ];
    for (const w of newWorkouts) {
      const matchR = allRoutines.find(r => r.id === w.id || r.id === w.rid || r.name === w.name || (w.routineIds || []).includes(r.id));
      if (matchR?.prescribedBy?.name) {
        trainerName = matchR.prescribedBy.name;
        break;
      }
    }
  }

  // Se o próprio tenant for conta de personal trainer
  if (!trainerName && tenant?.accountType === 'personal') {
    trainerName = tenant.name;
  }

  // Segundo: Telefone da academia / personal titular do tenant
  if (!targetPhone && tenant) {
    targetPhone = tenant.phone || tenant.branding?.contactPhone;
    targetName = tenant.name;
  }

  // Terceiro: Dono/gestor do tenant no banco de dados
  if (!targetPhone && tenantId !== 'default') {
    const owner = (db.users || []).find(
      u => u.tenantId === tenantId && (u.owner || u.saasRole === 'gym_owner' || u.saasRole === 'gym_manager' || u.saasRole === 'admin')
    );
    if (owner?.phone) {
      targetPhone = owner.phone;
      targetName = owner.name;
    }
  }

  if (!targetPhone) {
    return { notified: 0, reason: 'Nenhum telefone de personal trainer ou recepção cadastrado' };
  }

  const gymOrPersonalName = tenant?.name || targetName || 'Academia';

  let sentCount = 0;
  let queuedCount = 0;
  for (const workout of newWorkouts) {
    const message = formatWorkoutWhatsAppMessage({
      studentName: user.name || 'Aluno',
      workout,
      tenantName: gymOrPersonalName,
      trainerName,
      studentGoal: user.goal || '',
      catalogueById
    });

    try {
      const result = await dispatchWhatsAppWithRetry({
        dataDir,
        tenantId,
        kind: 'workout_report',
        recipientName: targetName || gymOrPersonalName,
        phone: targetPhone,
        message,
        tenantSettings: settings,
        dedupKey: `workout_report:${tenantId}:${user.id}:${workout.id}`
      });
      if (result.ok) sentCount++;
      else if (result.queued) queuedCount++;
      else console.warn(`[WhatsApp] Falha ao enviar relatório para ${targetPhone}:`, result.error);
    } catch (err) {
      console.error('[WhatsApp] Exceção no envio:', err.message);
    }
  }

  return { notified: sentCount, queued: queuedCount, targetPhone, targetName };
}

/**
 * Formata resumo semanal de evolução do aluno (check-in de sexta/domingo ou sob demanda).
 */
export function formatWeeklyCheckinWhatsAppMessage({
  studentName = 'Aluno',
  workoutsCount = 0,
  plannedDays = 0,
  totalVolKg = 0,
  prsCount = 0,
  tenantName = 'Sua Academia',
  trainerName = ''
}) {
  const firstName = String(studentName || 'Aluno').trim().split(' ')[0];
  const sender = trainerName ? `Prof. *${trainerName}* (${tenantName})` : `equipe da *${tenantName}*`;
  const freqLine = plannedDays > 0
    ? `*${workoutsCount} de ${plannedDays}* treinos planejados concluídos na semana`
    : `*${workoutsCount}* treino(s) concluído(s) na semana`;
  const lines = [
    `📊 *Resumo da Semana - ${firstName}*`,
    `Aqui é ${sender}! Confira seus números dos últimos 7 dias:`,
    ``,
    `- Frequência: ${freqLine}`,
    `- Tonelagem levantada: *${Math.round(Number(totalVolKg) || 0).toLocaleString('pt-BR')} kg*`
  ];
  if (prsCount > 0) {
    lines.push(`- Novos recordes pessoais (PRs): *${prsCount}* 🏆`);
  }
  lines.push(``);
  lines.push(
    workoutsCount >= Math.max(1, plannedDays)
      ? `Meta semanal batida! Excelente consistência, continue firme na próxima semana! 💪`
      : `Cada sessão conta na construção de resultado. Bora manter o ritmo nesta semana! 🚀`
  );
  return lines.join('\n');
}

/**
 * Formata alerta de vencimento próximo de ficha enviado ao professor/equipe.
 */
export function formatRoutineExpiryTrainerMessage({
  trainerName = 'Professor',
  studentName = 'Aluno',
  routineName = 'Ficha atual',
  daysAge = 25,
  cycleDays = 30,
  tenantName = 'Academia'
}) {
  const firstTrainer = String(trainerName || 'Professor').trim().split(' ')[0];
  const remaining = Math.max(0, Number(cycleDays || 30) - Number(daysAge || 0));
  return [
    `🔔 *Alerta de Renovação de Ficha - ${tenantName}*`,
    `Olá, ${firstTrainer}! A ficha *"${routineName}"* de *${studentName}* completou *${daysAge} dias* de uso (${remaining > 0 ? `vence em ${remaining} dia(s)` : 'ciclo concluído'}).`,
    ``,
    `Acesse o Portal Rit para arquivar o ciclo atual, revisar progressão de cargas e prescrever o próximo bloco.`
  ].join('\n');
}

/**
 * Formata resumo comparativo de avaliação física (Antes vs. Atual) para envio ao aluno.
 */
export function formatAssessmentSummaryWhatsAppMessage({
  studentName = 'Aluno',
  dateStr = '',
  weightKg = null,
  bodyFat = null,
  weightDelta = null,
  bfDelta = null,
  trainerName = '',
  tenantName = 'Academia'
}) {
  const firstName = String(studentName || 'Aluno').trim().split(' ')[0];
  const sender = trainerName ? `Prof. *${trainerName}* (${tenantName})` : `equipe da *${tenantName}*`;
  const lines = [
    `📏 *Avaliação Física Atualizada - ${firstName}*`,
    `Registrada por ${sender}${dateStr ? ` em ${dateStr}` : ''}:`,
    ``
  ];
  if (weightKg !== null && weightKg !== undefined) {
    const dTxt = weightDelta && Number(weightDelta.diff) !== 0
      ? ` (${Number(weightDelta.diff) > 0 ? '+' : ''}${weightDelta.diff} kg vs. início)`
      : '';
    lines.push(`- Peso corporal: *${weightKg} kg*${dTxt}`);
  }
  if (bodyFat !== null && bodyFat !== undefined) {
    const bfTxt = bfDelta && Number(bfDelta.diff) !== 0
      ? ` (${Number(bfDelta.diff) > 0 ? '+' : ''}${bfDelta.diff}% vs. início)`
      : '';
    lines.push(`- Gordura corporal: *${bodyFat}%*${bfTxt}`);
  }
  lines.push(``);
  lines.push(`Abra o aplicativo *Rit* na aba Medidas para acompanhar seu gráfico completo!`);
  return lines.join('\n');
}

/**
 * Formata retorno de revisão biomecânica de vídeo de execução.
 */
export function formatVideoReviewWhatsAppMessage({
  studentName = 'Aluno',
  exerciseName = 'Exercício',
  status = 'reviewed',
  comment = '',
  trainerName = '',
  tenantName = 'Academia'
}) {
  const firstName = String(studentName || 'Aluno').trim().split(' ')[0];
  const sender = trainerName ? `Prof. *${trainerName}*` : `sua equipe (${tenantName})`;
  const title = status === 'adjust_needed'
    ? `🎯 *Ajuste Técnico no Exercício - ${exerciseName}*`
    : `✅ *Execução Aprovada - ${exerciseName}*`;
  return [
    title,
    `Olá, ${firstName}! ${sender} analisou seu vídeo de execução:`,
    ``,
    `"${String(comment || '').trim()}"`,
    ``,
    `Qualquer dúvida técnica, responda por aqui ou consulte no app Rit!`
  ].join('\n');
}
