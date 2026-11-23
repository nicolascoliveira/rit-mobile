/**
 * api/test/email-otp-auth.test.js
 *
 * Testes de integração HTTP completos (server.js + SQLite + Mock Evolution API):
 *  1. Cadastro de aluno com Código de Convite do professor + E-mail obrigatório + Código OTP de 6 dígitos
 *     (entrega dual-channel WhatsApp + E-mail), bloqueando tentativa sem e-mail ou com OTP incorreto;
 *  2. Login subsequente no mesmo aparelho confiável (`trustedDeviceToken` + `deviceId`) entra
 *     direto com E-mail + Senha sem pedir novo código de 6 dígitos;
 *  3. Login em novo aparelho não confiável exige desafio OTP de 6 dígitos, permite reenvio via
 *     WhatsApp/E-mail, bloqueia código errado (`401 otp-invalid`) e autentica emitindo novo `trustedDeviceToken`;
 *  4. Verificação do endpoint `GET /.well-known/assetlinks.json` para Android App Links (`br.com.treinerit.app`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function createEvolutionMock() {
  const messages = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = {}; }
      messages.push({ url: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ key: { id: `msg_${messages.length}` }, status: 'PENDING' }));
    });
  });
  return {
    messages,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise(resolve => server.close(() => resolve()))
  };
}

test('Fluxo completo: E-mail obrigatório + OTP 6 dígitos (WhatsApp/E-mail) + Convite do Professor + Trusted Device + AssetLinks', async t => {
  const evo = createEvolutionMock();
  const evoPort = await evo.listen();
  t.after(async () => { await evo.close(); });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rit-email-otp-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), 'd'.repeat(64), { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [] }));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      RP_ID: 'localhost',
      ORIGIN: 'http://localhost:8080',
      PASSWORD_LOGIN: '1',
      SAAS_AUTO_SEED: '1',
      EVOLUTION_API_URL: `http://127.0.0.1:${evoPort}`,
      EVOLUTION_API_KEY: 'test-evo-key',
      EVOLUTION_INSTANCE: 'rit-instance',
      ALLOW_LOCAL_WEBHOOKS: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  t.after(() => {
    child.kill('SIGTERM');
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const port = await boundPort(child);
  const baseUrl = `http://127.0.0.1:${port}`;

  const reqJson = async (method, urlPath, body, headers = {}) => {
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: {
        Origin: 'http://localhost:8080',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };

  // 1. Verifica Digital Asset Links para o APK br.com.treinerit.app
  const assetLinks = await reqJson('GET', '/.well-known/assetlinks.json');
  assert.equal(assetLinks.status, 200);
  assert.equal(Array.isArray(assetLinks.data), true);
  assert.equal(assetLinks.data[0]?.target?.package_name, 'br.com.treinerit.app');

  // 2. Login do personal/dono da academia demo (ironpower) para gerar convite de aluno com telefone
  const ownerLogin = await reqJson('POST', '/api/saas/auth/login', {
    identifier: 'carlos@ironpower.com.br',
    password: 'rit2026'
  });
  assert.equal(ownerLogin.status, 200);
  const ownerToken = ownerLogin.data.token;

  const createStudent = await reqJson(
    'POST',
    '/api/gym/students',
    {
      name: 'Rafael Costa',
      phone: '11988887777',
      email: 'rafael.costa@aluno.com.br',
      goal: 'Hipertrofia'
    },
    { Authorization: `Bearer ${ownerToken}` }
  );
  assert.equal(createStudent.status, 201);
  const inviteCode = createStudent.data.invite?.code;
  assert.ok(inviteCode);

  // 3. Preview do convite retorna nome, e-mail e telefone mascarado do aluno pré-matriculado
  const preview = await reqJson('GET', `/api/invite/preview?code=${encodeURIComponent(inviteCode)}`);
  assert.equal(preview.status, 200);
  assert.equal(preview.data.studentName, 'Rafael Costa');
  assert.equal(preview.data.studentEmail, 'rafael.costa@aluno.com.br');
  assert.equal(preview.data.hasPhone, true);

  // 4. Solicita código de verificação de 6 dígitos para o cadastro
  const msgCountBefore = evo.messages.length;
  const sendRegOtp = await reqJson('POST', '/api/auth/verification/send', {
    purpose: 'register',
    email: 'rafael.costa@aluno.com.br',
    name: 'Rafael Costa',
    password: 'senhasegura2026',
    code: inviteCode,
    channel: 'auto'
  });
  assert.equal(sendRegOtp.status, 200);
  assert.equal(sendRegOtp.data.verificationRequired, true);
  assert.ok(sendRegOtp.data.challengeId);
  assert.match(sendRegOtp.data.devOtpCode, /^\d{6}$/);
  assert.ok(evo.messages.length > msgCountBefore, 'Deve enviar o código OTP via WhatsApp');

  // 5. Tentativa de cadastro com código OTP errado é bloqueada com 403 otp-invalid (sem consumir o convite)
  const badReg = await reqJson('POST', '/api/register/password', {
    name: 'Rafael Costa',
    email: 'rafael.costa@aluno.com.br',
    password: 'senhasegura2026',
    code: inviteCode,
    challengeId: sendRegOtp.data.challengeId,
    otpCode: '000000',
    deviceId: 'dev_celular_principal',
    requireEmailOtp: true
  });
  assert.equal(badReg.status, 403);
  assert.equal(badReg.data.code, 'otp-invalid');

  // 6. Cadastro com o código OTP correto ativa a conta e retorna trustedDeviceToken
  const goodReg = await reqJson('POST', '/api/register/password', {
    name: 'Rafael Costa',
    email: 'rafael.costa@aluno.com.br',
    password: 'senhasegura2026',
    code: inviteCode,
    challengeId: sendRegOtp.data.challengeId,
    otpCode: sendRegOtp.data.devOtpCode,
    deviceId: 'dev_celular_principal',
    requireEmailOtp: true,
    mobile: true
  });
  assert.equal(goodReg.status, 200);
  assert.equal(goodReg.data.user.name, 'Rafael Costa');
  assert.ok(goodReg.data.trustedDeviceToken, 'Deve emitir trustedDeviceToken para o aparelho verificado');

  // 7. Login apenas com nome (sem e-mail) é recusado quando requireEmailOtp está ativo
  const nameOnlyLogin = await reqJson('POST', '/api/login/password', {
    name: 'Rafael Costa',
    password: 'senhasegura2026',
    requireEmailOtp: true,
    deviceId: 'dev_celular_principal',
    trustedDeviceToken: goodReg.data.trustedDeviceToken
  });
  assert.equal(nameOnlyLogin.status, 400);
  assert.equal(nameOnlyLogin.data.code, 'email-invalid');

  // 8. Login subsequente no mesmo aparelho confiável (E-mail + Senha + trustedDeviceToken) entra direto sem OTP
  const trustedLogin = await reqJson('POST', '/api/login/password', {
    name: 'rafael.costa@aluno.com.br',
    password: 'senhasegura2026',
    requireEmailOtp: true,
    deviceId: 'dev_celular_principal',
    trustedDeviceToken: goodReg.data.trustedDeviceToken
  });
  assert.equal(trustedLogin.status, 200);
  assert.equal(trustedLogin.data.verificationRequired, undefined);
  assert.equal(trustedLogin.data.user.id, goodReg.data.user.id);
  assert.ok(trustedLogin.data.trustedDeviceToken);

  // 9. Login em um NOVO aparelho (deviceId diferente) exige código OTP de 6 dígitos
  const newDeviceStep1 = await reqJson('POST', '/api/login/password', {
    name: 'rafael.costa@aluno.com.br',
    password: 'senhasegura2026',
    requireEmailOtp: true,
    deviceId: 'dev_novo_aparelho_2'
  });
  assert.equal(newDeviceStep1.status, 200);
  assert.equal(newDeviceStep1.data.verificationRequired, true);
  assert.ok(newDeviceStep1.data.challengeId);
  assert.match(newDeviceStep1.data.devOtpCode, /^\d{6}$/);

  // 10. Código OTP incorreto no login do novo aparelho retorna 401 otp-invalid
  const newDeviceBadOtp = await reqJson('POST', '/api/login/password', {
    name: 'rafael.costa@aluno.com.br',
    password: 'senhasegura2026',
    requireEmailOtp: true,
    deviceId: 'dev_novo_aparelho_2',
    challengeId: newDeviceStep1.data.challengeId,
    otpCode: '000000'
  });
  assert.equal(newDeviceBadOtp.status, 401);
  assert.equal(newDeviceBadOtp.data.code, 'otp-invalid');

  // 11. Código OTP correto no novo aparelho conclui login e emite trustedDeviceToken para o novo aparelho
  const newDeviceGoodOtp = await reqJson('POST', '/api/login/password', {
    name: 'rafael.costa@aluno.com.br',
    password: 'senhasegura2026',
    requireEmailOtp: true,
    deviceId: 'dev_novo_aparelho_2',
    challengeId: newDeviceStep1.data.challengeId,
    otpCode: newDeviceStep1.data.devOtpCode
  });
  assert.equal(newDeviceGoodOtp.status, 200);
  assert.equal(newDeviceGoodOtp.data.user.id, goodReg.data.user.id);
  assert.ok(newDeviceGoodOtp.data.trustedDeviceToken);

  // 12. Fluxo "Esqueceu a senha?" self-service via código de 6 dígitos (purpose: 'reset')
  const sendResetOtp = await reqJson('POST', '/api/auth/verification/send', {
    purpose: 'reset',
    email: 'rafael.costa@aluno.com.br',
    channel: 'auto'
  });
  assert.equal(sendResetOtp.status, 200);
  assert.equal(sendResetOtp.data.purpose, 'reset');
  assert.ok(sendResetOtp.data.challengeId);
  assert.match(sendResetOtp.data.devOtpCode, /^\d{6}$/);

  // Tentativa de reset com código OTP errado deve falhar com 400 reset-invalid
  const badReset = await reqJson('POST', '/api/login/password-reset', {
    name: 'rafael.costa@aluno.com.br',
    challengeId: sendResetOtp.data.challengeId,
    otpCode: '000000',
    next: 'novasenhaforte2027'
  });
  assert.equal(badReset.status, 400);
  assert.equal(badReset.data.code, 'reset-invalid');

  // Reset com o código OTP correto altera a senha e autentica o aluno
  const goodReset = await reqJson('POST', '/api/login/password-reset', {
    name: 'rafael.costa@aluno.com.br',
    challengeId: sendResetOtp.data.challengeId,
    otpCode: sendResetOtp.data.devOtpCode,
    next: 'novasenhaforte2027',
    deviceId: 'dev_novo_aparelho_2',
    mobile: true
  });
  assert.equal(goodReset.status, 200);
  assert.equal(goodReset.data.user.id, goodReg.data.user.id);
  assert.ok(goodReset.data.trustedDeviceToken);
});
