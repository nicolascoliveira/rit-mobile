import {
  getSqliteInstance,
  runInTransaction
} from './sqlite.js';
import {
  getTenant,
  parseMpExternalReference,
  applyGatewayPaymentUpdate
} from './tenants.js';
import { getPayment } from './mercadopago.js';
import { dispatchWhatsAppWithRetry } from './whatsapp.js';

const MAX_WEBHOOK_ATTEMPTS = 6;
const STALE_LOCK_MS = 60 * 1000;
const RETRY_BASE_MS = 500;

const activeFlushes = new Map();
const scheduledTimers = new Map();
const defaultDepsByDir = new Map();

/**
 * Envia confirmação de pagamento PIX no WhatsApp com `dedupKey` determinístico
 * sem PII (usa tenantId + invoiceId) para garantir envio único em retries.
 */
export async function notifyPixPaymentConfirmed({
  dataDir,
  tenant,
  invoice,
  cycle,
  dispatchWhatsApp = dispatchWhatsAppWithRetry
}) {
  if (!tenant || !invoice) return null;
  const targetPhone = tenant.phone || tenant.branding?.contactPhone;
  if (!targetPhone) return null;

  const effCycle = (cycle || invoice.cycle) === 'annual' ? 'annual' : 'monthly';
  const cycleText = effCycle === 'annual' ? 'Anual' : 'Mensal';
  const amount = Number(invoice.amount || 0);
  const targetPlanName = invoice.planName || tenant.planName || 'Rit';
  const dateBr = tenant.nextBillingAt
    ? new Date(tenant.nextBillingAt).toLocaleDateString('pt-BR')
    : new Date().toLocaleDateString('pt-BR');

  const waMsg = [
    `🏋️ *Rit - Confirmação de Assinatura*`,
    ``,
    `Olá, *${tenant.ownerName || tenant.name}*!`,
    `Seu pagamento via PIX no valor de *R$ ${amount.toFixed(2).replace('.', ',')}* referente ao plano *${targetPlanName}* (${cycleText}) foi confirmado com sucesso.`,
    ``,
    `✅ *Sua assinatura está ativa até ${dateBr}.*`,
    `Todos os recursos do seu plano estão liberados para uso.`,
    ``,
    `Bons treinos e muito sucesso!`
  ].join('\n');

  return dispatchWhatsApp({
    dataDir,
    tenantId: tenant.id,
    kind: 'manual',
    recipientName: tenant.ownerName || tenant.name,
    phone: targetPhone,
    message: waMsg,
    dedupKey: `billing_paid:${tenant.id}:${invoice.id}`
  });
}

function getAuditFn(deps) {
  return typeof deps?.audit === 'function' ? deps.audit : () => {};
}

async function processClaimedEvent(dataDir, eventRow, deps = {}) {
  const fetchPayment = deps.fetchPayment || getPayment;
  const dispatchWhatsApp = deps.dispatchWhatsApp || dispatchWhatsAppWithRetry;
  const auditFn = getAuditFn(deps);
  const inst = getSqliteInstance(dataDir);

  let parsedBody = {};
  try {
    parsedBody = JSON.parse(eventRow.raw_payload || '{}');
  } catch {
    parsedBody = {};
  }

  const paymentId = eventRow.resource_id || parsedBody?.data?.id || parsedBody?.id || '';
  if (!paymentId) {
    inst.stmts.updateWebhookEventOutcome.run(
      'ignored',
      Number(eventRow.attempts || 0) + 1,
      0,
      Date.now(),
      JSON.stringify({ ok: true, ignored: true, reason: 'missing_payment_id' }),
      null,
      eventRow.event_id
    );
    return { outcome: 'ignored' };
  }

  let payment;
  try {
    payment = await fetchPayment(paymentId);
  } catch (err) {
    const nextAttempt = Number(eventRow.attempts || 0) + 1;
    const isTerminal = err?.status && Number(err.status) >= 400 && Number(err.status) < 500 && Number(err.status) !== 429 && Number(err.status) !== 408;
    if (!isTerminal && nextAttempt < MAX_WEBHOOK_ATTEMPTS) {
      const delayMs = Math.min(60000, RETRY_BASE_MS * (2 ** (nextAttempt - 1)));
      const nextAt = Date.now() + delayMs;
      inst.stmts.updateWebhookEventOutcome.run(
        'queued',
        nextAttempt,
        nextAt,
        null,
        null,
        String(err?.message || 'gateway_fetch_error').slice(0, 500),
        eventRow.event_id
      );
      scheduleWebhookTimer(dataDir, delayMs, deps);
      return { outcome: 'retry_scheduled', nextAttempt, delayMs };
    }
    inst.stmts.updateWebhookEventOutcome.run(
      'failed',
      nextAttempt,
      0,
      Date.now(),
      JSON.stringify({ ok: false, error: err?.message || 'gateway_fetch_failed' }),
      String(err?.message || 'gateway_fetch_failed').slice(0, 500),
      eventRow.event_id
    );
    return { outcome: 'failed', error: err?.message };
  }

  const mpPid = String(payment?.id || paymentId);
  let { tenantId, invoiceId, cycle, planId } = parseMpExternalReference(payment?.external_reference);
  if (!tenantId) {
    const byMp = inst.stmts.getInvoiceByMpPayment.get(mpPid);
    if (byMp) {
      tenantId = byMp.tenant_id;
      if (!invoiceId) invoiceId = byMp.id;
    }
  }

  if (!tenantId || !getTenant(dataDir, tenantId)) {
    inst.stmts.updateWebhookEventOutcome.run(
      'ignored',
      Number(eventRow.attempts || 0) + 1,
      0,
      Date.now(),
      JSON.stringify({ ok: true, ignored: true, reason: 'tenant_not_found', paymentId: mpPid }),
      null,
      eventRow.event_id
    );
    return { outcome: 'ignored' };
  }

  let resUpdate;
  try {
    resUpdate = applyGatewayPaymentUpdate(dataDir, tenantId, payment, {
      invoiceId,
      mpPaymentId: mpPid,
      cycle,
      planId
    });
  } catch (err) {
    inst.stmts.updateWebhookEventOutcome.run(
      'failed',
      Number(eventRow.attempts || 0) + 1,
      0,
      Date.now(),
      null,
      String(err?.message || err),
      eventRow.event_id
    );
    return { outcome: 'failed', error: String(err?.message || err) };
  }

  if (resUpdate?.amountMismatch) {
    auditFn(null, 'saas.billing.amount_mismatch', {
      ok: false,
      msg: `${tenantId} mp=${mpPid} paid=${resUpdate.paidAmt} expected=${resUpdate.expectedAmount}`
    });
    inst.stmts.updateWebhookEventOutcome.run(
      'ignored',
      Number(eventRow.attempts || 0) + 1,
      0,
      Date.now(),
      JSON.stringify({ ok: false, ignored: true, reason: 'amount_mismatch', paidAmt: resUpdate.paidAmt, expectedAmount: resUpdate.expectedAmount }),
      null,
      eventRow.event_id
    );
    return resUpdate;
  }

  if (resUpdate?.outcome === 'approved' && !resUpdate.alreadyPaid) {
    try {
      await notifyPixPaymentConfirmed({
        dataDir,
        tenant: resUpdate.tenant,
        invoice: resUpdate.invoice,
        cycle,
        dispatchWhatsApp
      });
    } catch (e) {
      console.error('Falha ao enviar WhatsApp de confirmação de pagamento:', e.message);
    }
    auditFn(null, 'saas.billing.pix_approved', {
      msg: `${resUpdate.tenant.id} R$${resUpdate.invoice.amount} ${cycle} (MP ${mpPid})`
    });
  }

  const finalStatus = resUpdate?.outcome === 'ignored' ? 'ignored' : 'processed';
  const resultPayload = {
    ok: true,
    outcome: resUpdate?.outcome || payment?.status || 'processed',
    alreadyPaid: Boolean(resUpdate?.alreadyPaid),
    updated: Boolean(resUpdate?.updated),
    tenantId,
    invoiceId: resUpdate?.invoice?.id || invoiceId || null,
    mpPaymentId: mpPid
  };

  inst.stmts.updateWebhookEventOutcome.run(
    finalStatus,
    Number(eventRow.attempts || 0) + 1,
    0,
    Date.now(),
    JSON.stringify(resultPayload),
    null,
    eventRow.event_id
  );
  return resultPayload;
}

function scheduleWebhookTimer(dataDir, delayMs, deps) {
  if (!dataDir) return;
  const merged = { ...(defaultDepsByDir.get(dataDir) || {}), ...(deps || {}) };
  defaultDepsByDir.set(dataDir, merged);
  if (scheduledTimers.has(dataDir)) {
    clearTimeout(scheduledTimers.get(dataDir));
  }
  const timer = setTimeout(() => {
    scheduledTimers.delete(dataDir);
    flushWebhookQueue(dataDir, defaultDepsByDir.get(dataDir) || merged).catch(err => {
      console.error('webhook worker flush:', err?.message || err);
    });
  }, Math.max(10, Number(delayMs) || RETRY_BASE_MS));
  if (typeof timer.unref === 'function') timer.unref();
  scheduledTimers.set(dataDir, timer);
}

/**
 * Drena todos os eventos de webhook devidos na fila persistida em SQLite (`webhook_events`).
 * Serializa execuções simultâneas por `dataDir` e usa claim atômico `BEGIN IMMEDIATE`.
 */
export async function flushWebhookQueue(dataDir, deps = {}) {
  if (!dataDir) return { processed: 0 };
  const merged = { ...(defaultDepsByDir.get(dataDir) || {}), ...(deps || {}) };
  defaultDepsByDir.set(dataDir, merged);

  if (activeFlushes.has(dataDir)) {
    return activeFlushes.get(dataDir);
  }

  const runPromise = (async () => {
    const inst = getSqliteInstance(dataDir);
    let processed = 0;

    while (true) {
      const claimed = runInTransaction(inst, () => {
        const now = Date.now();
        inst.stmts.reclaimStaleWebhookLocks.run(now - STALE_LOCK_MS);
        const due = inst.stmts.getDueWebhookEvents.all(now, 10);
        for (const row of due) {
          const locked = inst.stmts.claimWebhookEvent.get(now, row.event_id);
          if (locked) return locked;
        }
        return null;
      });

      if (!claimed) break;
      await processClaimedEvent(dataDir, claimed, defaultDepsByDir.get(dataDir) || merged);
      processed++;
    }

    return { processed };
  })().finally(() => {
    activeFlushes.delete(dataDir);
  });

  activeFlushes.set(dataDir, runPromise);
  return runPromise;
}

/**
 * Agenda drenagem assíncrona no próximo tick (`setImmediate`) para responder 2xx rápido ao gateway.
 */
export function scheduleWebhookFlush(dataDir, deps = {}) {
  if (!dataDir) return;
  const merged = { ...(defaultDepsByDir.get(dataDir) || {}), ...(deps || {}) };
  defaultDepsByDir.set(dataDir, merged);
  setImmediate(() => {
    flushWebhookQueue(dataDir, defaultDepsByDir.get(dataDir) || merged).catch(err => {
      console.error('webhook worker flush:', err?.message || err);
    });
  });
}

/**
 * Recupera no boot quaisquer webhooks que ficaram em `processing` durante reinicialização/crash.
 */
export function recoverWebhookQueueOnBoot(dataDir, deps = {}) {
  if (!dataDir) return 0;
  const merged = { ...(defaultDepsByDir.get(dataDir) || {}), ...(deps || {}) };
  defaultDepsByDir.set(dataDir, merged);
  const inst = getSqliteInstance(dataDir);
  const info = runInTransaction(inst, () => inst.stmts.reclaimStaleWebhookLocks.run(Date.now() + 1));
  const pending = inst.stmts.countPendingWebhookEvents.get();
  if (pending && Number(pending.cnt || 0) > 0) {
    scheduleWebhookFlush(dataDir, merged);
  }
  return Number(info?.changes || 0);
}

