/**
 * api/email.js
 *
 * Módulo de Verificação de Identidade Dual-Channel (E-mail + WhatsApp) e Dispositivo Confiável (OTP 6 dígitos)
 * para o Ecossistema Rit.
 *
 * Suporta envio de códigos de verificação de 6 dígitos por:
 *   1. Resend HTTP API (`RESEND_API_KEY` + `EMAIL_FROM`) — sem necessidade de servidor SMTP próprio.
 *   2. SMTP direto sobre TLS/STARTTLS (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) —
 *      compatível com Gmail (Senha de App), Hostinger, Titan, Zoho e Amazon SES sem dependências externas.
 *   3. WhatsApp via Evolution API (`dispatchWhatsAppWithRetry`) — entrega instantânea no celular do aluno.
 */

import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { cleanWhatsAppPhone, dispatchWhatsAppWithRetry } from './whatsapp.js';

export const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutos
export const MAX_OTP_ATTEMPTS = 5;
export const TRUSTED_DEVICE_DAYS = 90;

/**
 * Gera um código numérico criptograficamente seguro de 6 dígitos (100000..999999).
 */
export function generateOtpCode() {
  return String(crypto.randomInt(100000, 1000000));
}

/**
 * Calcula o hash HMAC-SHA256 do código OTP vinculado ao challengeId/email.
 */
export function hashOtpCode(code, secret, salt = '') {
  const clean = String(code || '').replace(/\D/g, '');
  return crypto
    .createHmac('sha256', String(secret || 'rit-otp-secret'))
    .update(`${salt}:${clean}`)
    .digest('hex');
}

/**
 * Compara o código OTP informado em tempo constante.
 */
export function verifyOtpCode(inputCode, expectedHash, secret, salt = '') {
  const clean = String(inputCode || '').replace(/\D/g, '');
  if (clean.length !== 6 || !expectedHash) return false;
  const actualHash = hashOtpCode(clean, secret, salt);
  const a = Buffer.from(actualHash, 'utf8');
  const b = Buffer.from(String(expectedHash), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Emite um token criptografado de Dispositivo Confiável (`trustedDeviceToken`)
 * vinculado ao ID do usuário, ao `deviceId` do aparelho e ao `sessionVersion` (`user.sv`).
 * Se o aluno trocar a senha ou encerrar todas as sessões, `user.sv` muda e invalida o token.
 */
export function makeTrustedDeviceToken(user, deviceId, secret) {
  if (!user?.id || !secret) return null;
  const cleanDev = String(deviceId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
  const ver = Number(user.sv || 0);
  const exp = Date.now() + TRUSTED_DEVICE_DAYS * 86400000;
  const payload = `td.${user.id}.${cleanDev}.${ver}.${exp}`;
  const mac = crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

/**
 * Verifica se o `trustedDeviceToken` apresentado pelo aparelho é válido para o usuário atual.
 */
export function verifyTrustedDeviceToken(token, user, deviceId, secret) {
  if (!token || typeof token !== 'string' || !user?.id || !secret) return false;
  const lastDot = token.lastIndexOf('.');
  if (lastDot < 0) return false;
  const payload = token.slice(0, lastDot);
  const mac = token.slice(lastDot + 1);
  const expectedMac = crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
  try {
    const a = Buffer.from(mac, 'utf8');
    const b = Buffer.from(expectedMac, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  } catch {
    return false;
  }
  const parts = payload.split('.');
  if (parts.length !== 5 || parts[0] !== 'td') return false;
  const [, uid, dev, verStr, expStr] = parts;
  const cleanDev = String(deviceId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default';
  if (uid !== String(user.id)) return false;
  if (dev !== cleanDev) return false;
  if (Number(verStr) !== Number(user.sv || 0)) return false;
  if (Number(expStr) <= Date.now()) return false;
  return true;
}

/**
 * Mascara um e-mail para exibição segura na tela (ex.: `jo***@gmail.com`).
 */
export function maskEmailAddress(email) {
  const clean = String(email || '').trim().toLowerCase();
  const atIdx = clean.indexOf('@');
  if (atIdx <= 0) return '';
  const local = clean.slice(0, atIdx);
  const domain = clean.slice(atIdx + 1);
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

/**
 * Mascara um telefone para exibição segura na tela (ex.: `(11) 9****-4321`).
 */
export function maskPhoneNumber(phone) {
  const digits = cleanWhatsAppPhone(phone);
  if (!digits || digits.length < 8) return '';
  const last4 = digits.slice(-4);
  if (digits.startsWith('55') && digits.length >= 12) {
    const ddd = digits.slice(2, 4);
    return `(${ddd}) 9****-${last4}`;
  }
  return `****-${last4}`;
}

/**
 * Verifica se há provedor de e-mail transacional configurado (Resend API ou SMTP).
 */
export function isEmailProviderConfigured(env = process.env) {
  const resendKey = String(env?.RESEND_API_KEY || '').trim();
  if (resendKey && !/^(test|mock|changeme|placeholder)$/i.test(resendKey)) return true;
  const smtpUser = String(env?.SMTP_USER || '').trim();
  const smtpPass = String(env?.SMTP_PASS || '').trim();
  if (smtpUser && smtpPass) return true;
  return false;
}
export const isEmailDeliveryConfigured = isEmailProviderConfigured;

/**
 * Formata a mensagem de WhatsApp com o código de verificação de 6 dígitos.
 */
export function formatVerificationWhatsAppMessage({
  code,
  studentName = 'Aluno(a)',
  tenantName = 'Rit',
  purpose = 'login'
} = {}) {
  const firstName = String(studentName || 'Aluno(a)').trim().split(/\s+/)[0] || 'Aluno(a)';
  const gym = String(tenantName || 'Rit').trim() || 'Rit';
  const actionLabel = purpose === 'register'
    ? 'confirmar a criação da sua conta'
    : purpose === 'reset'
      ? 'redefinir a senha da sua conta'
      : 'autorizar o acesso neste aparelho';

  return [
    `🔐 *Código de Verificação — ${gym}*`,
    ``,
    `Olá, *${firstName}*!`,
    `Use o código de 6 dígitos abaixo para ${actionLabel} no aplicativo *Rit*:`,
    ``,
    `*${code}*`,
    ``,
    `⏳ _Este código expira em 10 minutos. Por segurança, nunca compartilhe este código._`
  ].join('\n');
}

function buildVerificationEmailHtml({ code, studentName = 'Aluno(a)', tenantName = 'Rit', purpose = 'login' }) {
  const firstName = String(studentName || 'Aluno(a)').trim().split(/\s+/)[0] || 'Aluno(a)';
  const gym = String(tenantName || 'Rit').trim() || 'Rit';
  const title = purpose === 'register'
    ? 'Confirme seu cadastro'
    : purpose === 'reset'
      ? 'Redefinição de senha'
      : 'Código de acesso em novo aparelho';
  return `<!DOCTYPE html>
<html lang="pt-BR">
<body style="margin:0;padding:24px;background:#0c0e12;color:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:460px;margin:0 auto;background:#16181d;border:1px solid #272a33;border-radius:16px;padding:28px;text-align:center;">
    <div style="font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#d0ff00;margin-bottom:8px;">${gym} · Aplicativo Rit</div>
    <h1 style="font-size:20px;margin:0 0 12px;color:#ffffff;">${title}</h1>
    <p style="font-size:15px;line-height:1.5;color:#a1a1aa;margin:0 0 22px;">
      Olá, <strong style="color:#ffffff;">${firstName}</strong>! Digite o código de 6 dígitos abaixo no aplicativo para continuar:
    </p>
    <div style="background:#0c0e12;border:1px solid #323642;border-radius:12px;padding:16px 20px;font-size:32px;font-weight:800;letter-spacing:0.22em;color:#d0ff00;margin-bottom:20px;">
      ${code}
    </div>
    <p style="font-size:13px;color:#71717a;margin:0;">
      Este código é válido por 10 minutos. Se você não solicitou este código, ignore esta mensagem.
    </p>
  </div>
</body>
</html>`;
}

/**
 * Envia e-mail via SMTP TLS direto (porta 465) usando `node:tls` (compatível com Gmail App Password, Titan, Hostinger, Zoho).
 */
function sendSmtpTlsMail({ host, port = 465, user, pass, from, to, subject, html, textBody, timeoutMs = 10000 }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = res => {
      if (settled) return;
      settled = true;
      resolve(res);
    };

    const socket = tls.connect({ host, port: Number(port) || 465, servername: host, rejectUnauthorized: true });
    const timer = setTimeout(() => {
      try { socket.destroy(); } catch { /* ignore */ }
      finish({ ok: false, provider: 'smtp', error: 'Tempo esgotado ao conectar ao servidor SMTP' });
    }, timeoutMs);

    let step = 0;
    let buf = '';
    const sendLine = line => socket.write(line + '\r\n');
    const fromAddr = (/<([^>]+)>/.exec(from)?.[1] || from || user).trim();
    const toAddr = String(to).trim();

    socket.on('error', err => {
      clearTimeout(timer);
      finish({ ok: false, provider: 'smtp', error: err?.message || 'Erro de conexão SMTP' });
    });

    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\r\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!/^\d{3} /.test(line)) continue;
        const code = Number(line.slice(0, 3));
        if (code >= 400) {
          clearTimeout(timer);
          try { sendLine('QUIT'); socket.end(); } catch { /* ignore */ }
          finish({ ok: false, provider: 'smtp', error: `SMTP ${line}` });
          return;
        }
        if (step === 0 && code === 220) {
          step = 1;
          sendLine(`EHLO rit.app`);
        } else if (step === 1 && code === 250) {
          step = 2;
          sendLine('AUTH LOGIN');
        } else if (step === 2 && code === 334) {
          step = 3;
          sendLine(Buffer.from(String(user), 'utf8').toString('base64'));
        } else if (step === 3 && code === 334) {
          step = 4;
          sendLine(Buffer.from(String(pass), 'utf8').toString('base64'));
        } else if (step === 4 && code === 235) {
          step = 5;
          sendLine(`MAIL FROM:<${fromAddr}>`);
        } else if (step === 5 && code === 250) {
          step = 6;
          sendLine(`RCPT TO:<${toAddr}>`);
        } else if (step === 6 && code === 250) {
          step = 7;
          sendLine('DATA');
        } else if (step === 7 && code === 354) {
          step = 8;
          const boundary = 'rit_mime_' + crypto.randomBytes(8).toString('hex');
          const msg = [
            `From: ${from || user}`,
            `To: <${toAddr}>`,
            `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
            `MIME-Version: 1.0`,
            `Content-Type: multipart/alternative; boundary="${boundary}"`,
            ``,
            `--${boundary}`,
            `Content-Type: text/plain; charset=UTF-8`,
            `Content-Transfer-Encoding: 8bit`,
            ``,
            textBody,
            `--${boundary}`,
            `Content-Type: text/html; charset=UTF-8`,
            `Content-Transfer-Encoding: 8bit`,
            ``,
            html,
            `--${boundary}--`,
            `.`
          ].join('\r\n');
          sendLine(msg);
        } else if (step === 8 && code === 250) {
          step = 9;
          clearTimeout(timer);
          try { sendLine('QUIT'); socket.end(); } catch { /* ignore */ }
          finish({ ok: true, provider: 'smtp' });
        }
      }
    });
  });
}

/**
 * Envia o e-mail de verificação via Resend API ou SMTP TLS.
 */
export async function sendVerificationEmail({
  to,
  code,
  studentName = 'Aluno(a)',
  tenantName = 'Rit',
  purpose = 'login',
  env = process.env
} = {}) {
  const cleanTo = String(to || '').trim().toLowerCase();
  if (!cleanTo || !cleanTo.includes('@')) {
    return { ok: false, provider: 'none', error: 'E-mail de destino inválido' };
  }

  const gym = String(tenantName || 'Rit').trim() || 'Rit';
  const subject = `${code} é o seu código de verificação ${gym}`;
  const textBody = `Olá, ${studentName}!\n\nSeu código de verificação no aplicativo ${gym} (Rit) é: ${code}\n\nEste código expira em 10 minutos.`;
  const html = buildVerificationEmailHtml({ code, studentName, tenantName: gym, purpose });

  const resendKey = String(env?.RESEND_API_KEY || '').trim();
  const fromAddress = String(env?.EMAIL_FROM || env?.SMTP_FROM || `${gym} <nao-responda@treinerit.com.br>`).trim();

  if (resendKey && !/^(test|mock|changeme|placeholder)$/i.test(resendKey)) {
    try {
      const res = await fetch(String(env?.RESEND_API_URL || 'https://api.resend.com/emails'), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: fromAddress,
          to: [cleanTo],
          subject,
          html,
          text: textBody
        })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        return { ok: true, provider: 'resend', id: data?.id || null };
      }
      return { ok: false, provider: 'resend', error: data?.message || `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, provider: 'resend', error: err?.message || 'Falha de rede Resend API' };
    }
  }

  const smtpUser = String(env?.SMTP_USER || '').trim();
  const smtpPass = String(env?.SMTP_PASS || '').trim();
  if (smtpUser && smtpPass) {
    const smtpHost = String(env?.SMTP_HOST || 'smtp.gmail.com').trim();
    const smtpPort = Number(env?.SMTP_PORT || 465);
    const smtpFrom = String(env?.SMTP_FROM || env?.EMAIL_FROM || `${gym} <${smtpUser}>`).trim();
    return sendSmtpTlsMail({
      host: smtpHost,
      port: smtpPort,
      user: smtpUser,
      pass: smtpPass,
      from: smtpFrom,
      to: cleanTo,
      subject,
      html,
      textBody
    });
  }

  return { ok: false, provider: 'unconfigured', error: 'Provedor de e-mail não configurado no servidor' };
}

/**
 * Dispara o código de verificação de 6 dígitos de forma inteligente (Dual-Channel: WhatsApp + E-mail).
 * - Se `channel === 'whatsapp'`: envia via WhatsApp (Evolution API).
 * - Se `channel === 'email'`: envia via E-mail (Resend/SMTP) e, se o provedor de e-mail não estiver configurado mas houver WhatsApp, faz fallback automático para o WhatsApp.
 * - Se `channel === 'auto'`: dispara nos canais disponíveis (WhatsApp e/ou E-mail).
 */
export async function dispatchDualChannelVerification({
  dataDir,
  tenant = null,
  tenantId = 'default',
  tenantName = '',
  tenantSettings = null,
  email = '',
  phone = '',
  studentName = 'Aluno(a)',
  code,
  purpose = 'login',
  channel = 'auto',
  preferredChannel = '',
  env = process.env
} = {}) {
  const effectiveChannel = preferredChannel || channel || 'auto';
  const effectiveTenantName = tenantName || tenant?.name || 'Rit';
  const effectiveTenantSettings = tenantSettings || tenant?.settings || {};
  const cleanPhone = cleanWhatsAppPhone(phone);
  const emailConfigured = isEmailProviderConfigured(env);
  const channelsSent = [];
  const errors = [];

  const wantWhatsApp = Boolean(cleanPhone) && (
    effectiveChannel === 'whatsapp' ||
    effectiveChannel === 'auto' ||
    (effectiveChannel === 'email' && !emailConfigured)
  );
  const wantEmail = Boolean(email) && (
    effectiveChannel === 'email' ||
    (effectiveChannel === 'auto' && emailConfigured)
  );

  if (wantWhatsApp) {
    try {
      const waMsg = formatVerificationWhatsAppMessage({
        code,
        studentName,
        tenantName: effectiveTenantName,
        purpose
      });
      const waRes = await dispatchWhatsAppWithRetry({
        dataDir,
        tenantId,
        kind: 'auth_otp',
        recipientName: studentName,
        phone: cleanPhone,
        message: waMsg,
        tenantSettings: effectiveTenantSettings
      });
      if (waRes.ok || waRes.queued) {
        channelsSent.push('whatsapp');
      } else if (waRes.error) {
        errors.push(`whatsapp: ${waRes.error}`);
      }
    } catch (err) {
      errors.push(`whatsapp: ${err?.message || 'erro'}`);
    }
  }

  if (wantEmail && emailConfigured) {
    const emailRes = await sendVerificationEmail({
      to: email,
      code,
      studentName,
      tenantName: effectiveTenantName,
      purpose,
      env
    });
    if (emailRes.ok) {
      channelsSent.push('email');
    } else if (emailRes.error) {
      errors.push(`email: ${emailRes.error}`);
    }
  }

  // Se nenhum provedor externo estiver configurado (ex.: ambiente local de desenvolvimento/teste),
  // marca o canal virtual 'email' como simulado para permitir fluxo completo de UX.
  if (channelsSent.length === 0 && env?.NODE_ENV !== 'production') {
    channelsSent.push(cleanPhone ? 'whatsapp' : 'email');
  }

  return {
    ok: channelsSent.length > 0,
    channelsSent,
    maskedEmail: maskEmailAddress(email),
    maskedPhone: maskPhoneNumber(cleanPhone),
    hasPhone: Boolean(cleanPhone),
    emailConfigured,
    errors
  };
}
