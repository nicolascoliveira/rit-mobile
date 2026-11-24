/**
 * api/mercadopago.js
 *
 * Módulo de Integração de Pagamentos PIX via Mercado Pago para o Ecossistema Rit.
 *
 * Funcionalidades:
 * 1. Geração de cobranças PIX dinâmicas com QR Code nativo e Copia e Cola.
 * 2. Suporte a planos mensais e planos anuais com desconto.
 * 3. Consulta de status de pagamento em tempo real (/v1/payments/{id}).
 * 4. Validação de Webhook e assinatura HMAC (X-Signature).
 * 5. Modo de desenvolvimento / simulação automática caso o MERCADO_PAGO_ACCESS_TOKEN não esteja configurado.
 */

import crypto from 'node:crypto';

const getMpApiBase = () => String(process.env.MERCADO_PAGO_API_BASE || 'https://api.mercadopago.com').trim().replace(/\/+$/, '');
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV4(val) {
  return UUID_V4_RE.test(String(val || '').trim());
}

export function ensureIdempotencyUuid(providedKey = '') {
  const clean = String(providedKey || '').trim();
  return isUuidV4(clean) ? clean : crypto.randomUUID();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Executa uma chamada mutante (POST) ao Mercado Pago garantindo envio de `X-Idempotency-Key`
 * em formato UUID v4 gerado uma vez por operação de negócio e reaproveitado em qualquer tentativa.
 */
export async function mpIdempotentRequest({
  endpointPath,
  method = 'POST',
  token,
  idempotencyKey: providedKey = '',
  body,
  maxAttempts = 2,
  retryDelayMs = 150
}) {
  const idempotencyKey = ensureIdempotencyUuid(providedKey);
  const attemptsCap = Math.max(1, Number(maxAttempts || 1));
  let lastErr = null;

  for (let attempt = 1; attempt <= attemptsCap; attempt++) {
    let response;
    try {
      response = await fetch(`${getMpApiBase()}${endpointPath}`, {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (netErr) {
      const err = new Error(`Erro de rede ao comunicar com Mercado Pago: ${netErr?.message || 'network_error'}`);
      err.retryable = true;
      err.idempotencyKey = idempotencyKey;
      lastErr = err;
      if (attempt < attemptsCap) {
        await sleep(retryDelayMs * attempt);
        continue;
      }
      throw err;
    }

    const data = await response.json().catch(() => null);
    if (response.ok && data) {
      return { data, idempotencyKey };
    }

    const isRetryableStatus = response.status === 429 || response.status >= 500;
    const errorMsg = data?.message || data?.error || `Falha na API do Mercado Pago (${response.status})`;
    const err = new Error(`Erro ao gerar PIX: ${errorMsg}`);
    err.status = response.status;
    err.retryable = isRetryableStatus;
    err.idempotencyKey = idempotencyKey;
    lastErr = err;

    if (isRetryableStatus && attempt < attemptsCap) {
      await sleep(retryDelayMs * attempt);
      continue;
    }
    throw err;
  }

  throw lastErr;
}

/**
 * Retorna o Access Token configurado no ambiente.
 */
export function getMercadoPagoToken(env = process.env) {
  const token = (env?.MERCADO_PAGO_ACCESS_TOKEN || '').trim();
  return token || null;
}

const PLACEHOLDER_TOKEN_RE = /^(?:test|mock|changeme|placeholder|example)$/i;
const TEMPLATE_TOKEN_MARKER_RE = /(?:seu[-_]?(?:access[-_]?)?token|your[-_]?(?:access[-_]?)?token|-aqui$|<[^>]+>)/i;

/**
 * Verifica se a integração oficial com o Mercado Pago está configurada com token real.
 */
export function isMercadoPagoConfigured(env = process.env) {
  const token = getMercadoPagoToken(env);
  if (!token) return false;
  if (PLACEHOLDER_TOKEN_RE.test(token)) return false;
  if (TEMPLATE_TOKEN_MARKER_RE.test(token)) return false;
  return true;
}

/**
 * Gera um SVG básico de QR code para ambiente de desenvolvimento/teste.
 */
function generateMockQrCodeSvg(text) {
  const hash = crypto.createHash('md5').update(text).digest('hex');
  // Representação SVG minimalista simulando um QR Code
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
    <rect width="200" height="200" fill="#ffffff"/>
    <!-- Marcadores de canto -->
    <rect x="20" y="20" width="40" height="40" fill="#000000"/>
    <rect x="25" y="25" width="30" height="30" fill="#ffffff"/>
    <rect x="30" y="30" width="20" height="20" fill="#000000"/>

    <rect x="140" y="20" width="40" height="40" fill="#000000"/>
    <rect x="145" y="25" width="30" height="30" fill="#ffffff"/>
    <rect x="150" y="30" width="20" height="20" fill="#000000"/>

    <rect x="20" y="140" width="40" height="40" fill="#000000"/>
    <rect x="25" y="145" width="30" height="30" fill="#ffffff"/>
    <rect x="30" y="150" width="20" height="20" fill="#000000"/>

    <!-- Padrão mock gerado pelo hash -->
    <text x="100" y="105" font-family="sans-serif" font-size="11" font-weight="bold" text-anchor="middle" fill="#000000">PIX SIMULADO</text>
    <text x="100" y="125" font-family="monospace" font-size="9" text-anchor="middle" fill="#666666">${hash.slice(0, 8)}</text>
  </svg>`.trim();
}

/**
 * Cria uma cobrança PIX no Mercado Pago.
 * Se o token de produção não estiver presente, gera uma cobrança simulada para testes locais.
 */
export async function createPixPayment({
  amount,
  description = 'Assinatura Rit',
  payerEmail = 'contato@treinerit.com.br',
  payerName = 'Cliente Rit',
  payerDoc = '',
  externalReference = '',
  notificationUrl = '',
  idempotencyKey: providedIdempotencyKey = '',
  maxAttempts = 2,
  retryDelayMs = 150
}) {
  const parsedAmount = Number(amount);
  const numAmount = Number.isFinite(parsedAmount) ? Math.max(0.01, Number(parsedAmount.toFixed(2))) : 0.01;
  const cleanDoc = String(payerDoc || '').replace(/\D/g, '');
  const nameParts = String(payerName || 'Cliente Rit').trim().split(/\s+/);
  const firstName = nameParts[0] || 'Cliente';
  const lastName = nameParts.slice(1).join(' ') || 'Rit';
  const idempotencyKey = ensureIdempotencyUuid(providedIdempotencyKey);

  if (!isMercadoPagoConfigured()) {
    if (process.env.NODE_ENV === 'production' && !isPixSimulationAllowed()) {
      const err = new Error('Gateway Mercado Pago não configurado em produção.');
      err.statusCode = 503;
      throw err;
    }
    // Ambiente local / testes / homologação sem credencial Mercado Pago
    const mockId = 'mp_sim_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
    const mockPixCopiaECola = `00020126580014br.gov.bcb.pix0136${crypto.randomUUID()}520400005303986540${numAmount.toFixed(2)}5802BR5913Rit Plataforma6009Sao Paulo62070503***6304${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const svg = generateMockQrCodeSvg(mockPixCopiaECola);
    const mockQrCodeBase64 = Buffer.from(svg).toString('base64');
    const expirationDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    return {
      id: mockId,
      status: 'pending',
      amount: numAmount,
      description,
      qrCode: mockPixCopiaECola,
      qrCodeBase64: `data:image/svg+xml;base64,${mockQrCodeBase64}`,
      ticketUrl: '',
      dateCreated: new Date().toISOString(),
      dateOfExpiration: expirationDate,
      externalReference,
      idempotencyKey,
      mock: true
    };
  }

  const token = getMercadoPagoToken();

  const payload = {
    transaction_amount: numAmount,
    description: String(description).slice(0, 120),
    payment_method_id: 'pix',
    payer: {
      email: payerEmail || 'financeiro@treinerit.com.br',
      first_name: firstName,
      last_name: lastName,
      ...(cleanDoc ? {
        identification: {
          type: cleanDoc.length > 11 ? 'CNPJ' : 'CPF',
          number: cleanDoc
        }
      } : {})
    },
    external_reference: String(externalReference || '').slice(0, 200)
  };

  if (notificationUrl && !notificationUrl.includes('localhost') && !notificationUrl.includes('127.0.0.1')) {
    payload.notification_url = notificationUrl;
  }

  const { data } = await mpIdempotentRequest({
    endpointPath: '/v1/payments',
    method: 'POST',
    token,
    idempotencyKey,
    body: payload,
    maxAttempts,
    retryDelayMs
  });

  const qrCode = data.point_of_interaction?.transaction_data?.qr_code || '';
  const qrCodeBase64 = data.point_of_interaction?.transaction_data?.qr_code_base64
    ? `data:image/png;base64,${data.point_of_interaction.transaction_data.qr_code_base64}`
    : '';
  const ticketUrl = data.point_of_interaction?.transaction_data?.ticket_url || '';

  return {
    id: String(data.id),
    status: data.status,
    amount: data.transaction_amount || numAmount,
    description: data.description || description,
    qrCode,
    qrCodeBase64,
    ticketUrl,
    dateCreated: data.date_created || new Date().toISOString(),
    dateOfExpiration: data.date_of_expiration || new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    externalReference: data.external_reference || externalReference,
    idempotencyKey,
    mock: false
  };
}

/**
 * Consulta os detalhes de um pagamento no Mercado Pago pelo ID.
 */
export function isPixSimulationAllowed(env = process.env) {
  return String(env?.SAAS_DEMO || '') === '1';
}

export async function getPayment(paymentId) {
  const cleanPaymentId = String(paymentId || '').trim();
  if (!cleanPaymentId || !/^[A-Za-z0-9_-]{1,80}$/.test(cleanPaymentId)) {
    const err = new Error('ID do pagamento inválido ou não informado');
    err.status = 400;
    err.statusCode = 400;
    throw err;
  }

  const isSimulatedId = cleanPaymentId.startsWith('mp_sim_');
  if (process.env.NODE_ENV === 'production' && !isPixSimulationAllowed()) {
    if (!isMercadoPagoConfigured()) {
      const err = new Error('Gateway Mercado Pago não configurado em produção.');
      err.statusCode = 503;
      throw err;
    }
    if (isSimulatedId) {
      const err = new Error('Identificador de pagamento simulado rejeitado em produção.');
      err.statusCode = 400;
      throw err;
    }
  }

  if (!isMercadoPagoConfigured() || isSimulatedId) {
    return {
      id: cleanPaymentId,
      status: 'pending',
      status_detail: 'pending_waiting_transfer',
      transaction_amount: 0,
      mock: true
    };
  }

  const token = getMercadoPagoToken();
  const response = await fetch(`${getMpApiBase()}/v1/payments/${encodeURIComponent(cleanPaymentId)}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    }
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const err = new Error(`Erro ao consultar pagamento no Mercado Pago: ${data?.message || response.status}`);
    err.status = response.status;
    throw err;
  }

  return data;
}

/**
 * Valida a assinatura HMAC de segurança do webhook do Mercado Pago.
 * Se o secret MERCADO_PAGO_WEBHOOK_SECRET estiver definido, confere o header x-signature.
 */
function timingSafeHexEqual(receivedHex, expectedHex) {
  const a = Buffer.from(String(receivedHex || '').trim().toLowerCase(), 'utf8');
  const b = Buffer.from(String(expectedHex || '').trim().toLowerCase(), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractPaymentIdFromRawBody(rawText) {
  if (!rawText) return '';
  try {
    const parsed = JSON.parse(rawText);
    if (parsed?.data?.id !== undefined && parsed?.data?.id !== null) {
      return String(parsed.data.id);
    }
  } catch { /* fallback para extração tolerante via regex */ }
  const dataObjMatch = /"data"\s*:\s*\{[^}]*"id"\s*:\s*(?:"([^"]+)"|([0-9]+))/.exec(rawText);
  if (dataObjMatch) return dataObjMatch[1] || dataObjMatch[2] || '';
  return '';
}

function isWebhookTimestampFresh(rawTs, nowMs = Date.now(), maxSkewMs = 10 * 60_000) {
  const num = Number(rawTs);
  if (!Number.isFinite(num) || num <= 0) return false;
  const tsMs = num < 1e12 ? num * 1000 : num;
  return Math.abs(nowMs - tsMs) <= maxSkewMs;
}

/**
 * Valida a assinatura HMAC de segurança do webhook utilizando o corpo bruto (`rawBody`)
 * antes de qualquer JSON.parse ou processamento de negócio.
 */
export function verifyWebhookSignature({ headers = {}, query = {}, rawBody = '', dataId: bodyDataId = '', env = process.env } = {}) {
  const secret = (env?.MERCADO_PAGO_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    // Fail-closed em produção ou sempre que o gateway real do Mercado Pago estiver configurado
    if (env?.NODE_ENV === 'production' || isMercadoPagoConfigured(env)) {
      return false;
    }
    // Apenas em ambiente local/teste sem credenciais do Mercado Pago
    return true;
  }

  const rawBuf = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(typeof rawBody === 'string' ? rawBody : '', 'utf8');
  const rawStr = rawBuf.toString('utf8');

  const queryDataId = String(query?.['data.id'] || query?.id || '').trim();
  const rawExtractedId = extractPaymentIdFromRawBody(rawStr);
  // Impede spoofing onde o query param `data.id` assinado difere do `data.id` no payload bruto
  if (queryDataId && rawExtractedId && queryDataId !== rawExtractedId) {
    return false;
  }

  const rawBodySig = headers['x-body-signature'] || headers['x-hub-signature-256'];
  if (rawBodySig) {
    const cleanHex = String(rawBodySig).replace(/^sha256=/i, '').trim();
    const expectedRawHmac = crypto.createHmac('sha256', secret).update(rawBuf).digest('hex');
    if (!timingSafeHexEqual(cleanHex, expectedRawHmac)) return false;
  }

  const xSignature = headers['x-signature'] || headers['X-Signature'];
  const xRequestId = String(headers['x-request-id'] || headers['X-Request-Id'] || '').trim();
  if (!xSignature) return false;

  const rawSigStr = String(xSignature).trim();
  if (/^sha256=/i.test(rawSigStr)) {
    const expectedRaw = crypto.createHmac('sha256', secret).update(rawBuf).digest('hex');
    return timingSafeHexEqual(rawSigStr.slice(7), expectedRaw);
  }

  const parts = Object.fromEntries(
    rawSigStr
      .split(',')
      .map(part => {
        const idx = part.indexOf('=');
        if (idx < 0) return [part.trim(), ''];
        return [part.slice(0, idx).trim(), part.slice(idx + 1).trim()];
      })
  );

  const enforceTimestampWindow = env?.NODE_ENV === 'production';

  // Modo raw payload com timestamp (`t=...,v1=...`, padrão HMAC sobre `${ts}.${rawBody}`)
  if (parts.t && parts.v1 && !parts.ts) {
    if (enforceTimestampWindow && !isWebhookTimestampFresh(parts.t)) return false;
    const signedPayload = Buffer.concat([Buffer.from(`${parts.t}.`, 'utf8'), rawBuf]);
    const expectedRaw = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
    return timingSafeHexEqual(parts.v1, expectedRaw);
  }

  const ts = parts.ts;
  const hash = parts.v1;
  if (!ts || !hash) return false;
  if (enforceTimestampWindow && !isWebhookTimestampFresh(ts)) return false;

  const dataId = queryDataId || rawExtractedId || String(bodyDataId || '').trim();
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const expectedManifestHmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  if (timingSafeHexEqual(hash, expectedManifestHmac)) {
    // Se também vier `v1_body`, exige HMAC sobre os bytes brutos do corpo
    if (parts.v1_body) {
      const signedPayload = Buffer.concat([Buffer.from(`${ts}.`, 'utf8'), rawBuf]);
      const expectedBody = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
      return timingSafeHexEqual(parts.v1_body, expectedBody);
    }
    return true;
  }

  // Alternativa explícita: HMAC assinado sobre `${ts}.${rawBody}` quando sem manifest request-id/query
  if (rawBuf.length > 0 && !xRequestId && !queryDataId) {
    const signedPayload = Buffer.concat([Buffer.from(`${ts}.`, 'utf8'), rawBuf]);
    const expectedBody = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
    return timingSafeHexEqual(hash, expectedBody);
  }

  return false;
}
