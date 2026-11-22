/**
 * api/test/student-onboarding-whatsapp.test.js
 *
 * Testes de integração HTTP completos (server.js + SQLite + Mock Evolution API) para
 * o onboarding de alunos com geração segura de convite e saudação automática no WhatsApp:
 *  (a) Criação do aluno gera código de convite único vinculado ao `studentId` e dispara
 *      payload correto no WhatsApp contendo link `/cadastro?tenant=...&convite=CODIGO`
 *      e código isolado + idempotência sob duplo clique (`Idempotency-Key`);
 *  (b) Cadastro/ativação do aluno na rota `POST /api/register/password` vinculando-se
 *      ao `studentId` pré-matriculado + bloqueio (`403 code:'invite'`) ao tentar reutilizar
 *      convite já consumido ou código inválido;
 *  (c) Simulação de falha HTTP 500 na API do WhatsApp provando que o aluno permanece salvo
 *      no banco SQLite (`201 Created`) com status `queued` registrado na outbox e no aluno,
 *      seguido de reenvio manual bem-sucedido invalidando convite anterior quando regenerado.
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

function createEvolutionMockServer() {
  const calls = [];
  let failMode = false;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      let parsedBody = {};
      try {
        parsedBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch {
        parsedBody = {};
      }
      calls.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsedBody
      });

      res.setHeader('Content-Type', 'application/json');
      if (failMode) {
        res.writeHead(500);
        res.end(JSON.stringify({ status: 500, error: 'Evolution API simulated outage' }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({ key: { id: `evo_${calls.length}` }, status: 'PENDING' }));
    });
  });

  return {
    calls,
    setFailMode(v) {
      failMode = Boolean(v);
    },
    listen() {
      return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
          resolve(server.address().port);
        });
      });
    },
    close() {
      return new Promise(resolve => server.close(() => resolve()));
    }
  };
}

test('Onboarding WhatsApp + Convite Único: criação, idempotência, ativação, bloqueio de reuso e resiliência a falha', async t => {
  const evoMock = createEvolutionMockServer();
  const evoPort = await evoMock.listen();
  t.after(async () => {
    await evoMock.close();
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rit-onboarding-wa-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), 'c'.repeat(64), { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [] }));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: API_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      ORIGIN: 'http://localhost:8080',
      PUBLIC_APP_URL: 'https://app.treinerit.com.br',
      RP_ID: 'localhost',
      PASSWORD_LOGIN: '1',
      TRUST_PROXY: '1',
      INVITE_ONLY: '',
      SAAS_DEMO: '0',
      SAAS_AUTO_SEED: '1',
      EVOLUTION_API_URL: `http://127.0.0.1:${evoPort}`,
      EVOLUTION_API_KEY: 'rit-test-secret',
      EVOLUTION_INSTANCE: 'rit'
    }
  });

  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  t.after(() => {
    child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const port = await boundPort(child, () => log);
  const base = `http://127.0.0.1:${port}`;

  const req = async (method, p, { body, ip = '198.51.100.25', headers = {} } = {}) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'same-origin',
        'X-Forwarded-For': ip,
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const jsonBody = await r.json().catch(() => ({}));
    return { status: r.status, body: jsonBody, headers: r.headers };
  };

  // Login como gestor da academia seeded (ironpower)
  const loginRes = await req('POST', '/api/saas/auth/login', {
    body: { identifier: 'carlos@ironpower.com.br', password: 'rit2026' }
  });
  assert.equal(loginRes.status, 200, `Login do gestor falhou: ${JSON.stringify(loginRes.body)}`);
  const ownerToken = loginRes.body.token;
  assert.ok(ownerToken);
  const authHeaders = {
    Authorization: `Bearer ${ownerToken}`,
    'X-Tenant-Id': 'ironpower'
  };

  // =========================================================================
  // (a) Criação do aluno + geração de convite único + payload no WhatsApp
  // =========================================================================
  const createPayload = {
    name: 'Ana Paula Costa',
    phone: '(11) 99123-4567',
    goal: 'Hipertrofia'
  };
  const createRes = await req('POST', '/api/gym/students', {
    headers: { ...authHeaders, 'Idempotency-Key': 'enroll-ana-001' },
    body: createPayload
  });
  assert.equal(createRes.status, 201, `Esperado 201 na matrícula: ${JSON.stringify(createRes.body)}`);
  assert.equal(createRes.body.ok, true);
  const anaId = createRes.body.student?.id;
  const inviteCode = createRes.body.invite?.code;
  const inviteUrl = createRes.body.invite?.url;
  assert.ok(anaId, 'student.id deve existir');
  assert.match(String(inviteCode), /^[A-F0-9]{8}$/, 'invite.code deve ter 8 caracteres hex');
  assert.equal(inviteUrl, `https://app.treinerit.com.br/cadastro?tenant=ironpower&convite=${inviteCode}`);
  assert.equal(createRes.body.whatsapp?.status, 'sent');
  assert.equal(createRes.body.whatsapp?.sent, true);

  // Confirma chamada exata enviada ao mock da Evolution API
  assert.equal(evoMock.calls.length, 1);
  assert.equal(evoMock.calls[0].url, '/message/sendText/rit');
  assert.equal(evoMock.calls[0].headers.apikey, 'rit-test-secret');
  assert.equal(evoMock.calls[0].body.number, '5511991234567', 'Telefone deve ser sanitizado com DDI 55');
  assert.ok(evoMock.calls[0].body.text.includes('*Ana*'));
  assert.ok(evoMock.calls[0].body.text.includes('Iron Power Matriz'));
  assert.ok(evoMock.calls[0].body.text.includes(inviteUrl), 'Payload WhatsApp deve conter o link clicável');
  assert.ok(evoMock.calls[0].body.text.includes(`*${inviteCode}*`), 'Payload WhatsApp deve conter o código isolado');

  // Idempotência: duplo clique com a mesma Idempotency-Key não duplica aluno nem WhatsApp
  const dupClickRes = await req('POST', '/api/gym/students', {
    headers: { ...authHeaders, 'Idempotency-Key': 'enroll-ana-001' },
    body: createPayload
  });
  assert.equal(dupClickRes.status, 201);
  assert.equal(dupClickRes.headers.get('idempotency-replayed'), 'true');
  assert.equal(dupClickRes.body.student.id, anaId);
  assert.equal(dupClickRes.body.invite.code, inviteCode);
  assert.equal(evoMock.calls.length, 1, 'Duplo clique não pode disparar segunda mensagem no WhatsApp');

  // Preview público do convite antes do consumo
  const previewRes = await req('GET', `/api/invite/preview?code=${encodeURIComponent(inviteCode)}`);
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.body.studentName, 'Ana Paula Costa');
  assert.equal(previewRes.body.tenantId, 'ironpower');
  assert.equal(previewRes.body.hasPreEnrolledStudent, true);

  // =========================================================================
  // (b) Cadastro pelo aluno + tentativa de reuso de convite já consumido / inválido
  // =========================================================================
  const registerRes = await req('POST', '/api/register/password', {
    headers: { 'X-Tenant-Id': 'ironpower' },
    body: {
      name: 'Ana Paula Costa',
      email: 'ana.paula@aluno.test',
      password: 'minha-senha-segura-2026',
      code: inviteCode
    }
  });
  assert.equal(registerRes.status, 200, `Cadastro via convite falhou: ${JSON.stringify(registerRes.body)}`);
  assert.equal(registerRes.body.user?.id, anaId, 'Cadastro deve ativar exatamente o studentId pré-matriculado');
  assert.equal(registerRes.body.user?.tenantId, 'ironpower');

  // Login com a senha definida pelo aluno funciona normalmente
  const stuLoginRes = await req('POST', '/api/login/password', {
    headers: { 'X-Tenant-Id': 'ironpower' },
    body: { identifier: 'ana.paula@aluno.test', password: 'minha-senha-segura-2026' }
  });
  assert.equal(stuLoginRes.status, 200);
  assert.equal(stuLoginRes.body.user?.id, anaId);

  // Preview de convite já consumido não funciona mais
  const previewUsedRes = await req('GET', `/api/invite/preview?code=${encodeURIComponent(inviteCode)}`);
  assert.equal(previewUsedRes.status, 404);
  assert.equal(previewUsedRes.body.code, 'invite');

  // Tentativa de reutilizar código de convite já consumido é bloqueada
  const reuseRes = await req('POST', '/api/register/password', {
    headers: { 'X-Tenant-Id': 'ironpower' },
    body: {
      name: 'Terceiro Invasor',
      password: 'outra-senha-segura-2026',
      code: inviteCode
    }
  });
  assert.equal(reuseRes.status, 403);
  assert.equal(reuseRes.body.code, 'invite');

  // Tentativa com código inválido/inexistente também é bloqueada mesmo sem inviteOnly global
  const invalidRes = await req('POST', '/api/register/password', {
    headers: { 'X-Tenant-Id': 'ironpower' },
    body: {
      name: 'Codigo Errado',
      password: 'outra-senha-segura-2026',
      code: 'BAD0CODE'
    }
  });
  assert.equal(invalidRes.status, 403);
  assert.equal(invalidRes.body.code, 'invite');

  // =========================================================================
  // (c) Falha simulada no WhatsApp não faz rollback e grava status queued/pendente
  // =========================================================================
  evoMock.setFailMode(true);
  const marcosRes = await req('POST', '/api/gym/students', {
    headers: { ...authHeaders, 'Idempotency-Key': 'enroll-marcos-001' },
    body: {
      name: 'Marcos Vinicius Rocha',
      phone: '21988776655',
      goal: 'Condicionamento'
    }
  });
  assert.equal(marcosRes.status, 201, 'Falha no WhatsApp nunca deve abortar criação do aluno');
  const marcosId = marcosRes.body.student?.id;
  const marcosFirstInvite = marcosRes.body.invite?.code;
  assert.ok(marcosId);
  assert.ok(marcosFirstInvite);
  assert.equal(marcosRes.body.whatsapp?.status, 'queued');
  assert.equal(marcosRes.body.whatsapp?.queued, true);
  assert.ok(marcosRes.body.whatsapp?.outboxId);

  // Confirma que aluno e seu status persistiram no banco
  const listRes = await req('GET', '/api/gym/students', { headers: authHeaders });
  assert.equal(listRes.status, 200);
  const savedMarcos = listRes.body.students.find(s => s.id === marcosId);
  assert.ok(savedMarcos, 'Aluno deve permanecer salvo no SQLite mesmo com Evolution offline');
  assert.equal(savedMarcos.inviteCode, marcosFirstInvite);
  assert.equal(savedMarcos.welcomeWhatsapp?.status, 'queued');

  // Outbox registra a falha temporária na fila
  const outboxRes = await req('GET', '/api/gym/whatsapp/outbox', { headers: authHeaders });
  assert.equal(outboxRes.status, 200);
  const queuedEntry = outboxRes.body.queue.find(q => q.kind === 'welcome_invite' && q.phone === '5521988776655');
  assert.ok(queuedEntry, 'Item welcome_invite deve estar na outbox pendente');

  // Reenvio manual no painel com regeneração de convite (invalida o anterior)
  evoMock.setFailMode(false);
  const callsBeforeResend = evoMock.calls.length;
  const resendRes = await req('POST', '/api/gym/students/welcome-resend', {
    headers: authHeaders,
    body: { studentId: marcosId, regenerateInvite: true }
  });
  assert.equal(resendRes.status, 200);
  assert.equal(resendRes.body.whatsapp?.status, 'sent');
  const marcosNewInvite = resendRes.body.invite?.code;
  assert.ok(marcosNewInvite);
  assert.notEqual(marcosNewInvite, marcosFirstInvite);
  assert.equal(evoMock.calls.length, callsBeforeResend + 1);
  assert.ok(evoMock.calls[evoMock.calls.length - 1].body.text.includes(marcosNewInvite));

  // Convite anterior revogado deve falhar no cadastro
  const staleInviteSignup = await req('POST', '/api/register/password', {
    headers: { 'X-Tenant-Id': 'ironpower' },
    body: {
      name: 'Marcos Vinicius Rocha',
      password: 'marcos-senha-segura-2026',
      code: marcosFirstInvite
    }
  });
  assert.equal(staleInviteSignup.status, 403);
  assert.equal(staleInviteSignup.body.code, 'invite');

  // Novo convite ativa a conta do Marcos normalmente
  const validInviteSignup = await req('POST', '/api/register/password', {
    headers: { 'X-Tenant-Id': 'ironpower' },
    body: {
      name: 'Marcos Vinicius Rocha',
      password: 'marcos-senha-segura-2026',
      code: marcosNewInvite
    }
  });
  assert.equal(validInviteSignup.status, 200);
  assert.equal(validInviteSignup.body.user?.id, marcosId);
});
