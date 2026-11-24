import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { saveTenantBranding } from '../tenants.js';
import { loadCoreDbFromSqlite, upsertUserSqlite, readUserStateSqlite, writeUserStateSqlite, closeAllSqliteInstances } from '../sqlite.js';

const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function spawnTestServer(dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      ORIGIN: 'https://app.treinerit.com.br',
      PORTAL_URL: 'https://painel.treinerit.com.br',
      RP_ID: 'treinerit.com.br',
      PASSWORD_LOGIN: '1',
      TRUST_PROXY: '1',
      SAAS_DEMO: '0',
      SAAS_AUTO_SEED: '0',
      ...extraEnv
    }
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  return { child, getLog: () => log };
}

test('saveTenantBranding sanitizes XSS protocols while keeping safe HTTPS and raster data URLs', t => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rit-brand-xss-'));
  const tDir = path.join(baseDir, 'tenants', 'academia-segura');
  fs.mkdirSync(tDir, { recursive: true });
  t.after(() => {
    closeAllSqliteInstances();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const first = saveTenantBranding(tDir, {
    gymName: 'Academia Segura',
    logoUrl: 'javascript:alert(document.domain)'
  });
  assert.equal(first.logoUrl, '');

  const second = saveTenantBranding(tDir, {
    logoUrl: 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+'
  });
  assert.equal(second.logoUrl, '');

  const third = saveTenantBranding(tDir, {
    logoUrl: 'https://cdn.treinerit.com.br/logo.png'
  });
  assert.equal(third.logoUrl, 'https://cdn.treinerit.com.br/logo.png');

  const fourth = saveTenantBranding(tDir, {
    logoUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
  });
  assert.equal(fourth.logoUrl, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');
});

test('multi-tenant isolation on /api/admin/*, PUT /api/data review preservation, LGPD terms, and password reset OTP controls', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rit-sec-audit-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), 's'.repeat(64), { mode: 0o600 });

  const { child, getLog } = spawnTestServer(dataDir);
  t.after(() => {
    try { child.kill('SIGKILL'); } catch {}
    closeAllSqliteInstances();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const port = await boundPort(child, getLog);
  const base = `http://127.0.0.1:${port}`;
  let ipSeq = 20;
  const apiReq = async (method, p, { body, headers = {}, ip } = {}) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': ip || `203.0.113.${++ipSeq}`,
        'X-Forwarded-Proto': 'https',
        Origin: 'https://painel.treinerit.com.br',
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  };

  // 1. Setup superadmin
  const setupRes = await apiReq('POST', '/api/saas/auth/setup-admin', {
    body: { email: 'owner@treinerit.com.br', password: 'SuperOwnerPass!2026', name: 'Dono Rit' }
  });
  assert.equal(setupRes.status, 200);
  const superToken = setupRes.body.token;
  const superHeaders = { Authorization: `Bearer ${superToken}` };

  // 2. LGPD terms rejection when termsAccepted: false on POST /api/saas/auth/register
  const noTermsRes = await apiReq('POST', '/api/saas/auth/register', {
    body: {
      gymName: 'Academia Sem Termos',
      ownerName: 'Sem Termos',
      email: 'noterms@example.test',
      password: 'GymPassword!2026',
      termsAccepted: false
    }
  });
  assert.equal(noTermsRes.status, 400);

  // 3. Register Tenant A and Tenant B with explicit LGPD acceptance
  const acceptedAt = '2026-11-24T12:00:00.000Z';
  const regA = await apiReq('POST', '/api/saas/auth/register', {
    body: {
      gymName: 'Academia Alpha',
      ownerName: 'Gestor Alpha',
      email: 'alpha@example.test',
      phone: '5511999990001',
      password: 'AlphaPassword!2026',
      termsAccepted: true,
      termsAcceptedAt: acceptedAt
    }
  });
  assert.equal(regA.status, 201, JSON.stringify(regA.body));
  const tokenA = regA.body.token;
  const tenantA = regA.body.tenant.id;
  const userA = regA.body.user;
  assert.equal(loadCoreDbFromSqlite(dataDir).users.find(u => u.id === userA.id)?.termsAcceptedAt, acceptedAt);

  const regB = await apiReq('POST', '/api/saas/auth/register', {
    body: {
      gymName: 'Academia Beta',
      ownerName: 'Gestor Beta',
      email: 'beta@example.test',
      phone: '5511999990002',
      password: 'BetaPassword!2026',
      termsAccepted: true,
      termsAcceptedAt: acceptedAt
    }
  });
  assert.equal(regB.status, 201, JSON.stringify(regB.body));
  const tokenB = regB.body.token;

  // Enroll one student in Tenant B and generate an invite in Tenant B
  const studentBRes = await apiReq('POST', '/api/gym/students', {
    headers: { Authorization: `Bearer ${tokenB}` },
    body: { name: 'Aluno Beta', phone: '5511988887777', email: 'alunob@example.test' }
  });
  assert.equal(studentBRes.status, 201, JSON.stringify(studentBRes.body));
  const studentBId = studentBRes.body.student.id;
  const inviteBCode = studentBRes.body.invite.code;

  // 4. gym_owner is blocked (403) from legacy /api/admin/*, and even a tenant-scoped admin:true cannot cross tenant boundaries
  const headersA = { Authorization: `Bearer ${tokenA}` };
  assert.equal((await apiReq('GET', '/api/admin/users', { headers: headersA })).status, 403);

  // Promote userA to legacy admin:true (scoped to Tenant A) via superadmin so we explicitly test adminCanAccessUser / adminCanAccessInvite isolation
  assert.equal((await apiReq('POST', '/api/admin/user/role', {
    headers: superHeaders,
    body: { id: userA.id, admin: true }
  })).status, 200);

  const listUsersA = await apiReq('GET', '/api/admin/users', { headers: headersA });
  assert.equal(listUsersA.status, 200);
  assert.ok(!listUsersA.body.users.some(u => u.id === studentBId), 'Tenant A must not list Tenant B students');
  assert.ok(!listUsersA.body.users.some(u => u.saasRole === 'superadmin'), 'Tenant A must not list superadmin');

  const getUserBFromA = await apiReq('GET', `/api/admin/user?id=${encodeURIComponent(studentBId)}`, { headers: headersA });
  assert.equal(getUserBFromA.status, 404);

  const delUserBFromA = await apiReq('POST', '/api/admin/user/delete', {
    headers: headersA,
    body: { id: studentBId }
  });
  assert.equal(delUserBFromA.status, 404);

  const listInvitesA = await apiReq('GET', '/api/admin/invites', { headers: headersA });
  assert.equal(listInvitesA.status, 200);
  assert.ok(!listInvitesA.body.invites.some(inv => inv.code === inviteBCode));

  const revokeInviteBFromA = await apiReq('POST', '/api/admin/invites/revoke', {
    headers: headersA,
    body: { code: inviteBCode }
  });
  assert.equal(revokeInviteBFromA.status, 404);

  const auditFromA = await apiReq('GET', '/api/admin/audit', { headers: headersA });
  assert.equal(auditFromA.status, 200);
  assert.ok(!auditFromA.body.events.some(ev => String(ev.msg || ev.user || '').includes('beta@example.test')));

  // Superadmin CAN access across tenants
  const superUsers = await apiReq('GET', '/api/admin/users', { headers: superHeaders });
  assert.equal(superUsers.status, 200);
  assert.ok(superUsers.body.users.some(u => u.id === studentBId));
  assert.equal((await apiReq('GET', '/api/admin/audit', { headers: superHeaders })).status, 200);

  // 5. PUT /api/data preserves trainer-written videoReviews and assessments for students
  const studentAEnroll = await apiReq('POST', '/api/gym/students', {
    headers: headersA,
    body: { name: 'Aluno Alpha', email: 'alunoa@example.test' }
  });
  assert.equal(studentAEnroll.status, 201);
  const activateStudentA = await apiReq('POST', '/api/register/password', {
    headers: { Origin: 'https://app.treinerit.com.br' },
    body: {
      name: 'Aluno Alpha',
      password: 'StudentAlpha!2026',
      code: studentAEnroll.body.invite.code,
      tenantId: tenantA
    }
  });
  assert.equal(activateStudentA.status, 200);
  assert.equal(activateStudentA.body?.user?.saasRole, 'student');
  assert.equal(activateStudentA.status, 200, JSON.stringify(activateStudentA.body));
  const studentId = activateStudentA.body.user.id;
  const studentCookie = activateStudentA.headers.get('set-cookie')?.split(';')[0];
  assert.ok(studentCookie);

  // Seed trainer-prescribed assessments & videoReviews in student state
  const currentState = readUserStateSqlite(dataDir, studentId) || { unit: 'kg', routines: [], workouts: [], _rev: 0 };
  const trainerReviews = [{ id: 'vr-1', comment: 'Ajustar profundidade no agachamento', at: 1700000000000 }];
  const trainerAssessments = [{ id: 'as-1', bodyFat: 14.2, date: '2026-11-01' }];
  writeUserStateSqlite(dataDir, studentId, {
    ...currentState,
    _rev: (currentState._rev || 0) + 1,
    videoReviews: trainerReviews,
    assessments: trainerAssessments
  });

  // Student tries to PUT state omitting / overwriting videoReviews and assessments
  const revBeforePut = (await apiReq('GET', '/api/data', {
    headers: { Cookie: studentCookie, Origin: 'https://app.treinerit.com.br' }
  })).body.rev;

  const studentPut = await apiReq('PUT', '/api/data', {
    headers: { Cookie: studentCookie, Origin: 'https://app.treinerit.com.br' },
    body: {
      baseRev: revBeforePut,
      state: {
        unit: 'kg',
        routines: [],
        workouts: [{ id: 'w-a1', d: '2026-11-24' }],
        videoReviews: [],
        assessments: []
      }
    }
  });
  assert.equal(studentPut.status, 200, JSON.stringify(studentPut.body));
  assert.equal(studentPut.body.rev, revBeforePut + 1);

  const afterGet = await apiReq('GET', '/api/data', {
    headers: { Cookie: studentCookie, Origin: 'https://app.treinerit.com.br' }
  });
  assert.deepEqual(afterGet.body.state.videoReviews, trainerReviews);
  assert.deepEqual(afterGet.body.state.assessments, trainerAssessments);

  // 6. Superadmin OTP password reset blocked + OTP quota (429 on 6th request) + successful B2B password reset
  const superOtp = await apiReq('POST', '/api/auth/verification/send', {
    body: { email: 'owner@treinerit.com.br', purpose: 'reset' }
  });
  assert.equal(superOtp.status, 403);
  assert.equal(superOtp.body.code, 'superadmin-reset-blocked');

  let lastChallenge = null;
  for (let i = 1; i <= 5; i++) {
    const r = await apiReq('POST', '/api/auth/verification/send', {
      body: { email: 'alpha@example.test', purpose: 'reset', channel: 'email' }
    });
    assert.equal(r.status, 200, `Attempt ${i} should pass: ${JSON.stringify(r.body)}`);
    lastChallenge = r.body;
  }
  const sixthOtp = await apiReq('POST', '/api/auth/verification/send', {
    body: { email: 'alpha@example.test', purpose: 'reset', channel: 'email' }
  });
  assert.equal(sixthOtp.status, 429);
  assert.equal(sixthOtp.body.code, 'otp-rate-limited');
  assert.ok(sixthOtp.headers.get('retry-after'));

  assert.ok(lastChallenge?.challengeId && lastChallenge?.devOtpCode);
  const resetRes = await apiReq('POST', '/api/saas/auth/password-reset', {
    body: {
      email: 'alpha@example.test',
      challengeId: lastChallenge.challengeId,
      otpCode: lastChallenge.devOtpCode,
      password: 'NewAlphaPassword!2026'
    }
  });
  assert.equal(resetRes.status, 200, JSON.stringify(resetRes.body));

  const oldLogin = await apiReq('POST', '/api/saas/auth/login', {
    body: { email: 'alpha@example.test', password: 'AlphaPassword!2026' }
  });
  assert.equal(oldLogin.status, 401);

  const newLogin = await apiReq('POST', '/api/saas/auth/login', {
    body: { email: 'alpha@example.test', password: 'NewAlphaPassword!2026' }
  });
  assert.equal(newLogin.status, 200);
  assert.ok(newLogin.body.token);
});
