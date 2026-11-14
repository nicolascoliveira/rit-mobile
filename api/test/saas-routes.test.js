import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSaasRoutes } from '../saas-routes.js';
import { createTenant } from '../tenants.js';
import { boundPort } from './helpers.mjs';

const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function createMockServer({ user = null, isAdminFlag = false }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-saas-test-'));
  const db = {
    users: [
      { id: 'u_admin', name: 'Admin Dono', admin: true, owner: true, saasRole: 'superadmin' },
      { id: 'u_owner_iron', name: 'Gestor Iron', saasRole: 'gym_owner', role: 'trainer', tenantId: 'iron' },
      { id: 'u_trainer', name: 'Prof. Treinador', admin: false, role: 'trainer', saasRole: 'trainer', tenantId: 'iron' },
      { id: 'u_student', name: 'Aluno João', admin: false, role: 'student', saasRole: 'student', tenantId: 'iron' },
      { id: 'u_other_student', name: 'Aluno Alpha', admin: false, role: 'student', saasRole: 'student', tenantId: 'alpha' }
    ],
    invites: []
  };

  let activeUser = user;
  const routes = createSaasRoutes({
    json: (res, status, data) => { res.status = status; res.data = data; },
    readBody: async req => req.body || {},
    readSession: () => activeUser,
    isAdmin: u => !!u && (u.admin === true || isAdminFlag),
    db,
    saveDb: () => {},
    dataDir: tmpDir,
    audit: () => {},
    makeSession: u => 'tok_' + u.id
  });

  return { routes, db, tmpDir, setUser: u => { activeUser = u; } };
}

test('SaaS Routes: public branding endpoint and manager branding update', async () => {
  const env = createMockServer({ user: { id: 'u_student', role: 'student', tenantId: 'alpha' } });
  try {
    const resPub = {};
    await env.routes['GET /api/tenant/branding']({ headers: { 'x-tenant-id': 'alpha' }, url: '/api/tenant/branding' }, resPub);
    assert.equal(resPub.status, 200);
    assert.equal(resPub.data.tenant_id, 'alpha');

    // Student cannot update branding
    const resDeny = {};
    await env.routes['PUT /api/tenant/branding']({ headers: { 'x-tenant-id': 'alpha' }, body: { gymName: 'Hack' } }, resDeny);
    assert.equal(resDeny.status, 403);

    // Super admin updates branding
    env.setUser({ id: 'u_admin', admin: true, saasRole: 'superadmin' });
    const resOk = {};
    await env.routes['PUT /api/tenant/branding']({ headers: { 'x-tenant-id': 'alpha' }, body: { gymName: 'Alpha Prime', primaryColor: '#2563eb' } }, resOk);
    assert.equal(resOk.status, 200);
    assert.equal(resOk.data.branding.gymName, 'Alpha Prime');
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});


test('SaaS Routes: Super Admin creates tenant with owner account, suspends and manages plans', async () => {
  const env = createMockServer({ user: { id: 'u_admin', name: 'Super Admin', admin: true, saasRole: 'superadmin' } });
  try {
    const resCreate = {};
    await env.routes['POST /api/saas/admin/tenants']({
      headers: {},
      body: {
        id: 'titan',
        name: 'Titan Gym',
        planId: 'pro',
        ownerName: 'Roberto Titan',
        ownerEmail: 'roberto@titan.com.br',
        ownerPassword: 'titanpassword123',
        primaryColor: '#10b981'
      }
    }, resCreate);
    assert.equal(resCreate.status, 201);
    assert.equal(resCreate.data.tenant.name, 'Titan Gym');
    assert.equal(resCreate.data.ownerCreated, true);

    // Login as the newly created gym owner!
    const resLogin = {};
    await env.routes['POST /api/saas/auth/login']({
      headers: {},
      body: { identifier: 'roberto@titan.com.br', password: 'titanpassword123' }
    }, resLogin);
    assert.equal(resLogin.status, 200);
    assert.equal(resLogin.data.user.saasRole, 'gym_owner');
    assert.equal(resLogin.data.user.tenantId, 'titan');

    // Suspend Titan Gym -> owner login must now be blocked with 403!
    const resSuspend = {};
    await env.routes['POST /api/saas/admin/tenants/status']({
      headers: {},
      body: { id: 'titan', status: 'suspended' }
    }, resSuspend);
    assert.equal(resSuspend.status, 200);

    const resBlocked = {};
    await env.routes['POST /api/saas/auth/login']({
      headers: {},
      body: { identifier: 'roberto@titan.com.br', password: 'titanpassword123' }
    }, resBlocked);
    assert.equal(resBlocked.status, 403);

    // Overview returns executive KPIs
    const resOv = {};
    await env.routes['GET /api/saas/admin/overview']({ headers: {} }, resOv);
    assert.equal(resOv.status, 200);
    assert.equal(resOv.data.metrics.suspendedGyms, 1);
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});


test('SaaS Routes: Gym tenant isolation, student enrollment, catalogue search and workout prescription', async () => {
  const trainer = { id: 'u_trainer', name: 'Prof. Treinador', role: 'trainer', saasRole: 'trainer', tenantId: 'iron' };
  const env = createMockServer({ user: trainer });
  try {
    // 1. Trainer only sees students of 'iron', NEVER 'alpha' even if x-tenant-id header tries to spoof 'alpha'!
    const resList = {};
    await env.routes['GET /api/gym/students']({ headers: { 'x-tenant-id': 'alpha' }, url: '/api/gym/students' }, resList);
    assert.equal(resList.status, 200);
    assert.equal(resList.data.students.length, 1);
    assert.equal(resList.data.students[0].name, 'Aluno João');

    // 2. Search catalogue in Portuguese
    const resCat = {};
    await env.routes['GET /api/saas/catalogue']({ headers: {}, url: '/api/saas/catalogue?bp=chest&limit=10' }, resCat);
    assert.equal(resCat.status, 200);
    assert.ok(resCat.data.exercises.length > 0);
    assert.equal(resCat.data.exercises[0].bp, 'chest');

    // 3. Prescribe workout with multiple weekdays
    const resPresc = {};
    await env.routes['POST /api/gym/prescribe']({
      headers: {},
      body: {
        studentId: 'u_student',
        days: [1, 3, 5],
        routine: {
          name: 'Hipertrofia Peitoral',
          emoji: 'arm',
          ex: [{ id: '0025', sets: 4, reps: 10, weight: 40 }]
        }
      }
    }, resPresc);
    assert.equal(resPresc.status, 200);
    assert.equal(resPresc.data.routine.name, 'Hipertrofia Peitoral');

    // 4. Verify student detail returns enriched routine and weekly schedule
    const resDetail = {};
    await env.routes['GET /api/gym/student']({ headers: {}, url: '/api/gym/student?id=u_student' }, resDetail);
    assert.equal(resDetail.status, 200);
    assert.equal(resDetail.data.state.routines.length, 1);
    assert.deepEqual(resDetail.data.state.week['1'], [resPresc.data.routine.id]);
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});


test('SaaS Routes: SAAS_DEMO is strictly opt-in (blocked by default, enabled only when SAAS_DEMO=1)', async () => {
  const prevDemo = process.env.SAAS_DEMO;
  const env = createMockServer({ user: null });
  try {
    delete process.env.SAAS_DEMO;

    const bootOff = {};
    await env.routes['GET /api/saas/bootstrap']({ headers: {} }, bootOff);
    assert.equal(bootOff.status, 200);
    assert.equal(bootOff.data.demoAllowed, false);
    assert.deepEqual(bootOff.data.gyms, []);

    const seedBlocked = {};
    await env.routes['POST /api/saas/demo/seed']({ headers: {}, body: {} }, seedBlocked);
    assert.equal(seedBlocked.status, 403);

    const demoLoginBlocked = {};
    await env.routes['POST /api/saas/auth/demo-login']({ headers: {}, body: { role: 'superadmin' } }, demoLoginBlocked);
    assert.equal(demoLoginBlocked.status, 403);

    // Explicitly opt-in with SAAS_DEMO='1'
    process.env.SAAS_DEMO = '1';
    const bootOn = {};
    await env.routes['GET /api/saas/bootstrap']({ headers: {} }, bootOn);
    assert.equal(bootOn.status, 200);
    assert.equal(bootOn.data.demoAllowed, true);

    const demoLoginOk = {};
    await env.routes['POST /api/saas/auth/demo-login']({ headers: {}, body: { role: 'superadmin' } }, demoLoginOk);
    assert.equal(demoLoginOk.status, 200);
    assert.equal(demoLoginOk.data.user.saasRole, 'superadmin');
  } finally {
    if (prevDemo === undefined) delete process.env.SAAS_DEMO;
    else process.env.SAAS_DEMO = prevDemo;
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});


test('SaaS Routes: Homonymous students across different gyms do not collide', async () => {
  const env = createMockServer({
    user: { id: 'u_owner_iron', name: 'Gestor Iron', saasRole: 'gym_owner', role: 'trainer', tenantId: 'iron' }
  });
  try {
    // Enroll "João Homônimo" without email in academy 'iron'
    const resIron = {};
    await env.routes['POST /api/gym/students']({
      headers: {},
      body: { name: 'João Homônimo', password: 'ironpassword123' }
    }, resIron);
    assert.equal(resIron.status, 201);
    assert.equal(resIron.data.student.tenantId, 'iron');

    // Enrolling a second "João Homônimo" without email inside the SAME academy 'iron' returns 409
    const resDupSameGym = {};
    await env.routes['POST /api/gym/students']({
      headers: {},
      body: { name: 'João Homônimo', password: 'ironpassword123' }
    }, resDupSameGym);
    assert.equal(resDupSameGym.status, 409);

    // Switch to Super Admin managing academy 'alpha' and enroll another "João Homônimo" without email -> succeeds!
    env.setUser({ id: 'u_admin', name: 'Admin Dono', admin: true, saasRole: 'superadmin' });
    const resAlpha = {};
    await env.routes['POST /api/gym/students']({
      headers: { 'x-tenant-id': 'alpha' },
      body: { name: 'João Homônimo', password: 'alphapassword456' }
    }, resAlpha);
    assert.equal(resAlpha.status, 201);
    assert.equal(resAlpha.data.student.tenantId, 'alpha');

    // Add two homonymous trainers ("Prof. Marcos") in 'iron' and 'alpha' and verify tenant-scoped B2B login
    env.setUser({ id: 'u_owner_iron', name: 'Gestor Iron', saasRole: 'gym_owner', role: 'trainer', tenantId: 'iron' });
    const trIron = {};
    await env.routes['POST /api/gym/team']({
      headers: {},
      body: { name: 'Prof. Marcos', email: 'marcos@iron.com.br', password: 'marcosiron123', saasRole: 'trainer' }
    }, trIron);
    assert.equal(trIron.status, 201);

    env.setUser({ id: 'u_admin', name: 'Admin Dono', admin: true, saasRole: 'superadmin' });
    const trAlpha = {};
    await env.routes['POST /api/gym/team']({
      headers: { 'x-tenant-id': 'alpha' },
      body: { name: 'Prof. Marcos', email: 'marcos@alpha.com.br', password: 'marcosalpha456', saasRole: 'trainer' }
    }, trAlpha);
    assert.equal(trAlpha.status, 201);

    // Login by name ("Prof. Marcos") via /api/saas/auth/login scoped by X-Tenant-Id resolves the right academy trainer
    const loginIron = {};
    await env.routes['POST /api/saas/auth/login']({
      headers: { 'x-tenant-id': 'iron' },
      body: { identifier: 'Prof. Marcos', password: 'marcosiron123' }
    }, loginIron);
    assert.equal(loginIron.status, 200);
    assert.equal(loginIron.data.user.tenantId, 'iron');

    const loginAlpha = {};
    await env.routes['POST /api/saas/auth/login']({
      headers: { 'x-tenant-id': 'alpha' },
      body: { identifier: 'Prof. Marcos', password: 'marcosalpha456' }
    }, loginAlpha);
    assert.equal(loginAlpha.status, 200);
    assert.equal(loginAlpha.data.user.tenantId, 'alpha');
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});


test('server.js HTTP integration: multi-tenant student password signup/login & /api/saas/auth/login rate-limiting', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-saas-http-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), 'b'.repeat(64), { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [] }));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: API_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      ORIGIN: 'http://localhost:8080',
      RP_ID: 'localhost',
      PASSWORD_LOGIN: '1',
      TRUST_PROXY: '1',
      INVITE_ONLY: '',
      SAAS_DEMO: '0',
      SAAS_AUTO_SEED: '1'
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
  const req = async (method, p, { body, ip = '198.51.100.10', headers = {} } = {}) => {
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
    return { status: r.status, body: await r.json(), headers: r.headers };
  };

  // 1. Register two homonymous students ("João Silva") in two different academies via Student App endpoint
  const reg1 = await req('POST', '/api/register/password', {
    headers: { 'X-Tenant-Id': 'ironpower' },
    body: { name: 'João Silva', password: 'password-iron-123' }
  });
  assert.equal(reg1.status, 200);

  const reg2 = await req('POST', '/api/register/password', {
    headers: { 'X-Tenant-Id': 'arenacross' },
    body: { name: 'João Silva', password: 'password-arena-456' }
  });
  assert.equal(reg2.status, 200);
  assert.notEqual(reg1.body.user.id, reg2.body.user.id);

  // Duplicate in the SAME academy is rejected with 409
  const regDup = await req('POST', '/api/register/password', {
    headers: { 'X-Tenant-Id': 'ironpower' },
    body: { name: 'João Silva', password: 'password-other-999' }
  });
  assert.equal(regDup.status, 409);

  // 2. Each homonymous student logs into their own academy via X-Tenant-Id
  const logIron = await req('POST', '/api/login/password', {
    headers: { 'X-Tenant-Id': 'ironpower' },
    body: { name: 'João Silva', password: 'password-iron-123' }
  });
  assert.equal(logIron.status, 200);
  assert.equal(logIron.body.user.id, reg1.body.user.id);

  const logArena = await req('POST', '/api/login/password', {
    headers: { 'X-Tenant-Id': 'arenacross' },
    body: { name: 'João Silva', password: 'password-arena-456' }
  });
  assert.equal(logArena.status, 200);
  assert.equal(logArena.body.user.id, reg2.body.user.id);

  // Wrong academy password fails cleanly
  const logCross = await req('POST', '/api/login/password', {
    headers: { 'X-Tenant-Id': 'ironpower' },
    body: { name: 'João Silva', password: 'password-arena-456' }
  });
  assert.equal(logCross.status, 401);

  // 3. Brute-force lockout on POST /api/saas/auth/login (5 free + 6th locks -> 7th returns 429)
  for (let i = 0; i < 6; i++) {
    const bad = await req('POST', '/api/saas/auth/login', {
      ip: '198.51.100.77',
      body: { identifier: 'admin@rit.com.br', password: 'wrong-password-' + i }
    });
    assert.equal(bad.status, 401);
  }
  const throttled = await req('POST', '/api/saas/auth/login', {
    ip: '198.51.100.77',
    body: { identifier: 'admin@rit.com.br', password: 'wrong-password-7' }
  });
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get('retry-after')) >= 1);

  // 4. Regression test: when a student cookie (gymsid) is present on localhost alongside a manager's
  // Authorization: Bearer token, PUT /api/gym/branding must authenticate as the Bearer manager (not 403)!
  const mgrLogin = await req('POST', '/api/saas/auth/login', {
    ip: '198.51.100.20',
    body: { identifier: 'bruno@arenacross.com.br', password: 'rit2026' }
  });
  assert.equal(mgrLogin.status, 200);
  const mgrToken = mgrLogin.body.token;
  assert.ok(mgrToken);

  const studentCookie = logArena.headers.get('set-cookie')?.split(';')[0] || '';
  assert.ok(studentCookie.startsWith('gymsid='));

  const brandUpdate = await req('PUT', '/api/gym/branding', {
    ip: '198.51.100.20',
    headers: {
      Cookie: studentCookie,
      Authorization: `Bearer ${mgrToken}`,
      Origin: 'http://localhost:8081',
      'Sec-Fetch-Site': 'same-site'
    },
    body: {
      gymName: 'Arena Cross Oficial',
      primaryColor: '#a3e635',
      slogan: 'Treine forte todo dia'
    }
  });
  assert.equal(brandUpdate.status, 200);
  assert.equal(brandUpdate.body.branding.gymName, 'Arena Cross Oficial');
  assert.equal(brandUpdate.body.branding.primaryColor, '#a3e635');
});

test('SaaS Routes: WhatsApp Evolution API status check and test notification dispatch', async () => {
  const env = createMockServer({
    user: { id: 'u_owner_iron', saasRole: 'gym_owner', role: 'trainer', tenantId: 'iron' }
  });

  const origFetch = globalThis.fetch;
  let intercepted = null;
  globalThis.fetch = async (url, opts) => {
    intercepted = { url, opts };
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'success', instance: { state: 'open' } })
    };
  };

  try {
    // 1. WhatsApp status endpoint
    const resStatus = {};
    await env.routes['GET /api/gym/whatsapp/status'](
      { headers: { 'x-tenant-id': 'iron' } },
      resStatus
    );
    assert.equal(resStatus.status, 200);
    assert.equal(resStatus.data.connected, true);
    assert.ok(resStatus.data.settings);

    // 2. WhatsApp test message dispatch endpoint
    const resTest = {};
    await env.routes['POST /api/gym/whatsapp/test'](
      {
        headers: { 'x-tenant-id': 'iron' },
        body: { phone: '11988887777' }
      },
      resTest
    );
    assert.equal(resTest.status, 200);
    assert.equal(resTest.data.ok, true);
    assert.equal(resTest.data.sentTo, '5511988887777');
    assert.ok(intercepted);
    assert.ok(intercepted.url.includes('/message/sendText/'));
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});


test('SaaS Security: strict tenant isolation blocks cross-tenant IDOR and simulate-pix without SAAS_DEMO', async () => {
  const env = createMockServer({
    user: { id: 'u_trainer', role: 'trainer', saasRole: 'trainer', tenantId: 'iron' }
  });

  try {
    // 1. Treinador da academia Iron tenta acessar aluno da academia Alpha -> Bloqueado com 404
    const resIdor = {};
    await env.routes['GET /api/gym/student'](
      { url: '/api/gym/student?id=u_other_student', headers: {} },
      resIdor
    );
    assert.equal(resIdor.status, 404);
    assert.ok(resIdor.data.error.includes('não encontrado'));

    // 2. Treinador da academia Iron acessa seu próprio aluno com sucesso
    const resOk = {};
    await env.routes['GET /api/gym/student'](
      { url: '/api/gym/student?id=u_student', headers: {} },
      resOk
    );
    assert.equal(resOk.status, 200);
    assert.equal(resOk.data.ok, true);

    // 3. Usuário com papel trainer mas SEM tenantId é barrado com 403
    env.setUser({ id: 'u_rogue_trainer', role: 'trainer', saasRole: 'trainer' });
    const resRogue = {};
    await env.routes['GET /api/gym/students'](
      { url: '/api/gym/students', headers: {} },
      resRogue
    );
    assert.equal(resRogue.status, 403);

    // 4. simulate-pix é estritamente bloqueado quando SAAS_DEMO !== '1'
    process.env.SAAS_DEMO = '0';
    createTenant(env.tmpDir, { id: 'iron', name: 'Iron Gym' });
    env.setUser({ id: 'u_owner_iron', saasRole: 'gym_owner', role: 'trainer', tenantId: 'iron' });
    const resSim = {};
    await env.routes['POST /api/saas/billing/simulate-pix'](
      {
        body: { tenantId: 'iron', invoiceId: 'inv_fake' },
        headers: {}
      },
      resSim
    );
    assert.equal(resSim.status, 403);
    assert.ok(resSim.data.error.includes('demonstração'));
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});


test('SaaS Routes security: privilege escalation blocked, public branding zero-leak, and central WhatsApp isolation', async () => {
  const env = createMockServer({ user: null });
  try {
    // Seed a gym_manager inside iron and configure secret Evolution API settings
    env.db.users.push({
      id: 'u_mgr_iron',
      name: 'Gerente Iron',
      role: 'trainer',
      saasRole: 'gym_manager',
      tenantId: 'iron'
    });
    createTenant(env.tmpDir, {
      id: 'iron',
      name: 'Iron Academia',
      settings: {
        inviteOnly: true,
        allowGuest: false,
        welcomeMessage: 'Bem-vindo à Iron!',
        evolutionUrl: 'https://evo.iron.example',
        evolutionApiKey: 'SUPER_SECRET_EVO_KEY',
        evolutionInstance: ''
      }
    });

    // 1. Unknown tenant slug on GET /api/tenant/branding must NOT create a directory on disk
    const resGhost = {};
    await env.routes['GET /api/tenant/branding'](
      { headers: {}, url: '/api/tenant/branding?tenant=nonexistent_slug_xyz' },
      resGhost
    );
    assert.equal(resGhost.status, 200);
    assert.equal(fs.existsSync(path.join(env.tmpDir, 'tenants', 'nonexistent_slug_xyz')), false);

    // 2. Public branding on real tenant must only expose safe public settings
    const resPub = {};
    await env.routes['GET /api/tenant/branding'](
      { headers: { 'x-tenant-id': 'iron' }, url: '/api/tenant/branding' },
      resPub
    );
    assert.equal(resPub.status, 200);
    assert.equal(resPub.data.settings.inviteOnly, true);
    assert.equal(resPub.data.settings.welcomeMessage, 'Bem-vindo à Iron!');
    assert.equal(resPub.data.settings.evolutionApiKey, undefined);
    assert.equal(resPub.data.settings.evolutionUrl, undefined);

    // 3. Regular trainer never receives evolutionApiKey/evolutionApiKeyEnc/evolutionUrl/evolutionInstance on /me & /overview, and cannot escalate via /students*
    env.setUser(env.db.users.find(u => u.id === 'u_trainer'));
    const resMe = {};
    await env.routes['GET /api/saas/auth/me']({ headers: { 'x-tenant-id': 'iron' }, url: '/api/saas/auth/me' }, resMe);
    assert.equal(resMe.status, 200);
    assert.equal(resMe.data.tenant.settings.evolutionApiKey, undefined);
    assert.equal(resMe.data.tenant.settings.evolutionApiKeyEnc, undefined);
    assert.equal(resMe.data.tenant.settings.evolutionUrl, undefined);
    assert.equal(resMe.data.tenant.settings.evolutionInstance, undefined);
    assert.equal(resMe.data.tenant.settings.hasEvolutionApiKey, false);

    const resOverview = {};
    await env.routes['GET /api/gym/overview']({ headers: { 'x-tenant-id': 'iron' }, url: '/api/gym/overview' }, resOverview);
    assert.equal(resOverview.status, 200);
    assert.equal(resOverview.data.tenant.settings.evolutionApiKey, undefined);
    assert.equal(resOverview.data.tenant.settings.evolutionApiKeyEnc, undefined);
    assert.equal(resOverview.data.tenant.settings.evolutionUrl, undefined);
    assert.equal(resOverview.data.tenant.settings.hasEvolutionApiKey, false);

    const resEscEdit = {};
    await env.routes['PUT /api/gym/students'](
      { headers: { 'x-tenant-id': 'iron' }, body: { id: 'u_owner_iron', name: 'Pwned' } },
      resEscEdit
    );
    assert.equal(resEscEdit.status, 403);

    const resEscPwd = {};
    await env.routes['POST /api/gym/students/password'](
      { headers: { 'x-tenant-id': 'iron' }, body: { id: 'u_owner_iron', newPassword: 'hackedpassword123' } },
      resEscPwd
    );
    assert.equal(resEscPwd.status, 403);

    const resEscDel = {};
    await env.routes['DELETE /api/gym/students'](
      { headers: { 'x-tenant-id': 'iron' }, url: '/api/gym/students?id=u_owner_iron' },
      resEscDel
    );
    assert.equal(resEscDel.status, 403);

    // 4. gym_manager cannot modify gym_owner via PUT /api/gym/team
    env.setUser(env.db.users.find(u => u.id === 'u_mgr_iron'));
    const resTeamEsc = {};
    await env.routes['PUT /api/gym/team'](
      { headers: { 'x-tenant-id': 'iron' }, body: { id: 'u_owner_iron', saasRole: 'gym_manager' } },
      resTeamEsc
    );
    assert.equal(resTeamEsc.status, 403);

    // 5. Tenant without dedicated evolutionInstance cannot touch central WhatsApp QR/disconnect
    env.setUser(env.db.users.find(u => u.id === 'u_owner_iron'));
    const resWaQr = {};
    await env.routes['GET /api/gym/whatsapp/qr'](
      { headers: { 'x-tenant-id': 'iron' }, url: '/api/gym/whatsapp/qr' },
      resWaQr
    );
    assert.equal(resWaQr.status, 403);

    const resWaDisc = {};
    await env.routes['POST /api/gym/whatsapp/disconnect'](
      { headers: { 'x-tenant-id': 'iron' }, body: {} },
      resWaDisc
    );
    assert.equal(resWaDisc.status, 403);
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});


test('B2B password policy enforces >= 10 chars, blocks common passwords, and generates random temp passwords when omitted', async () => {
  const env = createMockServer({
    user: { id: 'u_admin', name: 'Admin Dono', admin: true, saasRole: 'superadmin' }
  });
  try {
    // 1. POST /api/saas/admin/tenants rejects < 10 chars or common passwords and auto-generates random >= 10 chars when omitted
    const resShortOwner = {};
    await env.routes['POST /api/saas/admin/tenants']({
      headers: {},
      body: { id: 'passgym', name: 'Pass Gym', ownerName: 'Dono', ownerEmail: 'dono@passgym.com.br', ownerPassword: 'short9999' }
    }, resShortOwner);
    assert.equal(resShortOwner.status, 400);

    const resCommonOwner = {};
    await env.routes['POST /api/saas/admin/tenants']({
      headers: {},
      body: { id: 'passgym', name: 'Pass Gym', ownerName: 'Dono', ownerEmail: 'dono@passgym.com.br', ownerPassword: 'Password123!' }
    }, resCommonOwner);
    assert.equal(resCommonOwner.status, 400);
    assert.equal(resCommonOwner.data.code, 'too-common');

    const resAutoOwner = {};
    await env.routes['POST /api/saas/admin/tenants']({
      headers: {},
      body: { id: 'passgym', name: 'Pass Gym', ownerName: 'Dono', ownerEmail: 'dono@passgym.com.br' }
    }, resAutoOwner);
    assert.equal(resAutoOwner.status, 201);
    assert.equal(typeof resAutoOwner.data.initialOwnerPassword, 'string');
    assert.ok(resAutoOwner.data.initialOwnerPassword.length >= 10);
    assert.notEqual(resAutoOwner.data.initialOwnerPassword, 'academia2026');

    // 2. POST /api/saas/admin/tenants/owner-password enforces >= 10 chars + passwordProblem
    const resOwnerPwShort = {};
    await env.routes['POST /api/saas/admin/tenants/owner-password']({
      headers: {},
      body: { tenantId: 'passgym', password: '123456789' }
    }, resOwnerPwShort);
    assert.equal(resOwnerPwShort.status, 400);

    const resOwnerPwOk = {};
    await env.routes['POST /api/saas/admin/tenants/owner-password']({
      headers: {},
      body: { tenantId: 'passgym', password: 'StrongOwner8' }
    }, resOwnerPwOk);
    assert.equal(resOwnerPwOk.status, 200);

    // Switch to owner of passgym
    const ownerUser = env.db.users.find(u => u.email === 'dono@passgym.com.br');
    assert.ok(ownerUser);
    env.setUser(ownerUser);

    // 3. POST /api/gym/students & POST /api/gym/students/password
    const resShortStu = {};
    await env.routes['POST /api/gym/students']({
      headers: {},
      body: { name: 'Aluno Curto', email: 'aluno1@passgym.com.br', password: 'abc123456' }
    }, resShortStu);
    assert.equal(resShortStu.status, 400);

    const resAutoStu = {};
    await env.routes['POST /api/gym/students']({
      headers: {},
      body: { name: 'Aluno Seguro', email: 'aluno2@passgym.com.br' }
    }, resAutoStu);
    assert.equal(resAutoStu.status, 201);
    assert.equal(typeof resAutoStu.data.initialPassword, 'string');
    assert.ok(resAutoStu.data.initialPassword.length >= 10);
    assert.notEqual(resAutoStu.data.initialPassword, 'treino2026');

    const resStuPwShort = {};
    await env.routes['POST /api/gym/students/password']({
      headers: {},
      body: { id: resAutoStu.data.student.id, password: '123456789' }
    }, resStuPwShort);
    assert.equal(resStuPwShort.status, 400);
    assert.ok(resStuPwShort.data.error.includes('10'));

    const resStuPwCommon = {};
    await env.routes['POST /api/gym/students/password']({
      headers: {},
      body: { id: resAutoStu.data.student.id, password: 'senha123456' }
    }, resStuPwCommon);
    assert.equal(resStuPwCommon.status, 400);
    assert.equal(resStuPwCommon.data.code, 'too-common');

    const resStuPwOk = {};
    await env.routes['POST /api/gym/students/password']({
      headers: {},
      body: { id: resAutoStu.data.student.id, password: 'StudentOk8' }
    }, resStuPwOk);
    assert.equal(resStuPwOk.status, 200);

    // 4. POST /api/gym/team & PUT /api/gym/team
    const resShortTeam = {};
    await env.routes['POST /api/gym/team']({
      headers: {},
      body: { name: 'Prof Curto', email: 'prof1@passgym.com.br', password: 'prof12345', saasRole: 'trainer' }
    }, resShortTeam);
    assert.equal(resShortTeam.status, 400);

    const resAutoTeam = {};
    await env.routes['POST /api/gym/team']({
      headers: {},
      body: { name: 'Prof Seguro', email: 'prof2@passgym.com.br', saasRole: 'trainer' }
    }, resAutoTeam);
    assert.equal(resAutoTeam.status, 201);
    assert.equal(typeof resAutoTeam.data.initialPassword, 'string');
    assert.ok(resAutoTeam.data.initialPassword.length >= 10);
    assert.notEqual(resAutoTeam.data.initialPassword, 'professor2026');

    const resPutShortTeam = {};
    await env.routes['PUT /api/gym/team']({
      headers: {},
      body: { id: resAutoTeam.data.member.id, password: '123456789' }
    }, resPutShortTeam);
    assert.equal(resPutShortTeam.status, 400);

    const resPutCommonTeam = {};
    await env.routes['PUT /api/gym/team']({
      headers: {},
      body: { id: resAutoTeam.data.member.id, password: 'admin.2026' }
    }, resPutCommonTeam);
    assert.equal(resPutCommonTeam.status, 400);
    assert.equal(resPutCommonTeam.data.code, 'too-common');

    const resPutOkTeam = {};
    await env.routes['PUT /api/gym/team']({
      headers: {},
      body: { id: resAutoTeam.data.member.id, password: 'UpdatedTeam8' }
    }, resPutOkTeam);
    assert.equal(resPutOkTeam.status, 200);
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});


test('SaaS Routes: Catalogue pagination (offset/hasMore/ranking) and trainer templates import', async () => {
  const trainer = { id: 'u_trainer_cat', name: 'Prof. Silva', role: 'trainer', saasRole: 'trainer', tenantId: 'iron' };
  const env = createMockServer({ user: trainer });
  try {
    const page1 = {};
    await env.routes['GET /api/saas/catalogue']({ headers: {}, url: '/api/saas/catalogue?bp=chest&limit=10&offset=0' }, page1);
    assert.equal(page1.status, 200);
    assert.equal(page1.data.exercises.length, 10);
    assert.equal(page1.data.offset, 0);
    assert.equal(page1.data.hasMore, true);
    assert.ok(page1.data.total > 100);

    const page2 = {};
    await env.routes['GET /api/saas/catalogue']({ headers: {}, url: '/api/saas/catalogue?bp=chest&limit=10&offset=10' }, page2);
    assert.equal(page2.status, 200);
    assert.equal(page2.data.exercises.length, 10);
    assert.equal(page2.data.offset, 10);
    assert.notEqual(page1.data.exercises[0].id, page2.data.exercises[0].id);

    const searchSupino = {};
    await env.routes['GET /api/saas/catalogue']({ headers: {}, url: '/api/saas/catalogue?q=supino&limit=5' }, searchSupino);
    assert.equal(searchSupino.status, 200);
    assert.ok(searchSupino.data.exercises.length > 0);
    assert.match(searchSupino.data.exercises[0].name.toLowerCase(), /supino/);

    const trainerTpls = {};
    await env.routes['GET /api/trainer/templates']({ headers: {}, url: '/api/trainer/templates' }, trainerTpls);
    assert.equal(trainerTpls.status, 200);
    assert.ok(trainerTpls.data.templates.length >= 20);

    const importRes = {};
    await env.routes['POST /api/gym/templates/import-defaults']({ headers: {}, body: {} }, importRes);
    assert.equal(importRes.status, 200);
    assert.equal(importRes.data.added, 0);
    assert.ok(importRes.data.total >= 20);
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test('Etapa 3: gym_owner nunca recebe evolutionApiKey em rotas HTTP, branding nao altera gateway e disconnect nao vaza chave da plataforma', async () => {
  const { resolveTenantEvolutionSettings } = await import('../tenants.js');
  const origEnvKey = process.env.EVOLUTION_API_KEY;
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;

  process.env.EVOLUTION_API_KEY = 'PLATFORM_MASTER_KEY_DO_NOT_LEAK';
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const env = createMockServer({
    user: { id: 'u_owner_iron', name: 'Gestor Iron', saasRole: 'gym_owner', role: 'trainer', tenantId: 'iron' }
  });

  try {
    createTenant(env.tmpDir, {
      id: 'iron',
      name: 'Iron Academia',
      settings: {
        evolutionUrl: 'https://evo.iron.example',
        evolutionApiKey: 'GYM_OWN_SECRET_KEY',
        evolutionInstance: 'iron_inst'
      }
    });

    // 1. gym_owner never receives evolutionApiKey/evolutionApiKeyEnc in /me or /overview
    const resMe = {};
    await env.routes['GET /api/saas/auth/me']({ headers: { 'x-tenant-id': 'iron' }, url: '/api/saas/auth/me' }, resMe);
    assert.equal(resMe.status, 200);
    assert.equal(resMe.data.tenant.settings.evolutionApiKey, undefined);
    assert.equal(resMe.data.tenant.settings.evolutionApiKeyEnc, undefined);
    assert.equal(resMe.data.tenant.settings.hasEvolutionApiKey, true);
    assert.equal(resMe.data.tenant.settings.evolutionUrl, 'https://evo.iron.example');

    const resOv = {};
    await env.routes['GET /api/gym/overview']({ headers: { 'x-tenant-id': 'iron' }, url: '/api/gym/overview' }, resOv);
    assert.equal(resOv.status, 200);
    assert.equal(resOv.data.tenant.settings.evolutionApiKey, undefined);
    assert.equal(resOv.data.tenant.settings.evolutionApiKeyEnc, undefined);
    assert.equal(resOv.data.tenant.settings.hasEvolutionApiKey, true);

    // 2. PUT /api/gym/branding strips evolution* fields
    const resBrand = {};
    await env.routes['PUT /api/gym/branding'](
      {
        headers: { 'x-tenant-id': 'iron' },
        body: {
          gymName: 'Iron Branding',
          settings: {
            churnDaysThreshold: 7,
            evolutionUrl: 'http://127.0.0.1:8082',
            evolutionApiKey: 'HIJACKED',
            evolutionInstance: 'hijacked_inst'
          }
        }
      },
      resBrand
    );
    assert.equal(resBrand.status, 200);
    assert.equal(resBrand.data.tenant.settings.evolutionUrl, 'https://evo.iron.example');
    assert.equal(resBrand.data.tenant.settings.evolutionApiKey, undefined);
    assert.equal(resolveTenantEvolutionSettings(env.tmpDir, 'iron').evolutionApiKey, 'GYM_OWN_SECRET_KEY');
    assert.equal(resolveTenantEvolutionSettings(env.tmpDir, 'iron').evolutionInstance, 'iron_inst');

    // 3. PUT /api/gym/settings rejects internal/SSRF URLs cleanly
    for (const badUrl of ['http://localhost:8082', 'https://evo.iron.internal', 'http://169.254.169.254/latest/meta-data']) {
      const resBad = {};
      await env.routes['PUT /api/gym/settings'](
        { headers: { 'x-tenant-id': 'iron' }, body: { evolutionUrl: badUrl } },
        resBad
      );
      assert.equal(resBad.status, 400);
    }

    // 4. POST /api/gym/whatsapp/disconnect with custom evolutionUrl and cleared tenant key fails closed (503) and NEVER sends platform key
    const resClear = {};
    await env.routes['PUT /api/gym/settings'](
      {
        headers: { 'x-tenant-id': 'iron' },
        body: { evolutionUrl: 'https://custom-evo.example.com', clearEvolutionApiKey: true, evolutionInstance: 'custom_inst' }
      },
      resClear
    );
    assert.equal(resClear.status, 200);
    assert.equal(resClear.data.settings.hasEvolutionApiKey, false);
    assert.equal(resClear.data.settings.evolutionApiKey, undefined);

    const resDisc = {};
    await env.routes['POST /api/gym/whatsapp/disconnect'](
      { headers: { 'x-tenant-id': 'iron' }, body: {} },
      resDisc
    );
    assert.equal(resDisc.status, 503);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = origFetch;
    if (origEnvKey === undefined) delete process.env.EVOLUTION_API_KEY;
    else process.env.EVOLUTION_API_KEY = origEnvKey;
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});

test('Etapa 6: student-only guards, assignedTrainerId active-staff validation, re-enable/invite quotas, and admin flag in saasPublicUser', async () => {
  const env = createMockServer({
    user: { id: 'u_sup_6', name: 'Super Root', saasRole: 'superadmin', admin: true }
  });

  try {
    await env.routes['POST /api/saas/admin/tenants'](
      {
        headers: {},
        body: {
          id: 'gym6',
          name: 'Gym Six',
          planId: 'starter',
          ownerName: 'Dono Six',
          ownerEmail: 'dono@gym6.com',
          ownerPassword: 'OwnerSixPass#2026'
        }
      },
      {}
    );

    await env.routes['PUT /api/saas/admin/tenants'](
      {
        headers: {},
        body: { id: 'gym6', maxStudentsOverride: 1, maxTrainersOverride: 2 }
      },
      {}
    );

    await env.routes['POST /api/saas/admin/tenants'](
      {
        headers: {},
        body: {
          id: 'other6',
          name: 'Other Six',
          planId: 'starter',
          ownerName: 'Dono Other',
          ownerEmail: 'dono@other6.com',
          ownerPassword: 'OwnerOtherPass#2026'
        }
      },
      {}
    );

    const owner6 = env.db.users.find(u => u.tenantId === 'gym6' && u.saasRole === 'gym_owner');
    const otherOwner6 = env.db.users.find(u => u.tenantId === 'other6' && u.saasRole === 'gym_owner');

    // 1. admin flag in saasPublicUser is false for gym_owner/trainer and true for superadmin
    const resSuperMe = {};
    await env.routes['GET /api/saas/auth/me']({ headers: {}, url: '/api/saas/auth/me' }, resSuperMe);
    assert.equal(resSuperMe.status, 200);
    assert.equal(resSuperMe.data.user.admin, true);

    env.setUser(owner6);
    const resOwnerMe = {};
    await env.routes['GET /api/saas/auth/me']({ headers: { 'x-tenant-id': 'gym6' }, url: '/api/saas/auth/me' }, resOwnerMe);
    assert.equal(resOwnerMe.status, 200);
    assert.equal(resOwnerMe.data.user.saasRole, 'gym_owner');
    assert.equal(resOwnerMe.data.user.admin, false);

    // Create 2nd trainer in gym6 (now at maxTrainers = 2)
    const resTr2 = {};
    await env.routes['POST /api/gym/team'](
      {
        headers: { 'x-tenant-id': 'gym6' },
        body: { name: 'Prof Disabled', email: 'tr2@gym6.com', password: 'TrainerSixPass#2026' }
      },
      resTr2
    );
    assert.equal(resTr2.status, 201);
    const tr2Id = resTr2.data.member.id;

    // 2. Enroll 1st student using active trainer, then reject cross-tenant/disabled/student assignedTrainerId
    const resBadCrossTrainer = {};
    await env.routes['POST /api/gym/students'](
      {
        headers: { 'x-tenant-id': 'gym6' },
        body: {
          name: 'Aluno Bad Cross',
          email: 'badcross@gym6.com',
          password: 'StudentSixPass#11',
          assignedTrainerId: otherOwner6.id
        }
      },
      resBadCrossTrainer
    );
    assert.equal(resBadCrossTrainer.status, 400);
    assert.equal(resBadCrossTrainer.data.code, 'invalid-assigned-trainer');

    // Disable tr2 and test disabled trainer rejection & trainer re-enable quota
    await env.routes['PUT /api/gym/team'](
      { headers: { 'x-tenant-id': 'gym6' }, body: { id: tr2Id, disabled: true } },
      {}
    );

    const resBadDisabledTrainer = {};
    await env.routes['POST /api/gym/students'](
      {
        headers: { 'x-tenant-id': 'gym6' },
        body: {
          name: 'Aluno Bad Dis',
          email: 'baddis@gym6.com',
          password: 'StudentSixPass#12',
          assignedTrainerId: tr2Id
        }
      },
      resBadDisabledTrainer
    );
    assert.equal(resBadDisabledTrainer.status, 400);
    assert.equal(resBadDisabledTrainer.data.code, 'invalid-assigned-trainer');

    // Fill 2nd trainer slot while tr2 is disabled
    const resTr3 = {};
    await env.routes['POST /api/gym/team'](
      {
        headers: { 'x-tenant-id': 'gym6' },
        body: { name: 'Prof Active 2', email: 'tr3@gym6.com', password: 'TrainerSixPass#3333' }
      },
      resTr3
    );
    assert.equal(resTr3.status, 201);
    const tr3Id = resTr3.data.member.id;

    // Attempting to re-enable tr2 (disabled: false) must hit maxTrainers = 2 quota!
    const resReenableTr2 = {};
    await env.routes['PUT /api/gym/team'](
      { headers: { 'x-tenant-id': 'gym6' }, body: { id: tr2Id, disabled: false } },
      resReenableTr2
    );
    assert.equal(resReenableTr2.status, 403);
    assert.equal(resReenableTr2.data.code, 'plan-limit');

    // Enroll valid student assigned to tr3 (fills maxStudents = 1)
    const resSt1 = {};
    await env.routes['POST /api/gym/students'](
      {
        headers: { 'x-tenant-id': 'gym6' },
        body: {
          name: 'Aluno One',
          email: 'st1@gym6.com',
          password: 'StudentSixPass#21',
          assignedTrainerId: tr3Id
        }
      },
      resSt1
    );
    assert.equal(resSt1.status, 201);
    const st1Id = resSt1.data.student.id;

    // Student ID itself cannot be assignedTrainerId in PUT /api/gym/students
    const resPutSelfTrainer = {};
    await env.routes['PUT /api/gym/students'](
      {
        headers: { 'x-tenant-id': 'gym6' },
        body: { id: st1Id, assignedTrainerId: st1Id }
      },
      resPutSelfTrainer
    );
    assert.equal(resPutSelfTrainer.status, 400);
    assert.equal(resPutSelfTrainer.data.code, 'invalid-assigned-trainer');

    // Disable st1, enroll st2, then re-enabling st1 (disabled: false) must hit maxStudents = 1 quota!
    await env.routes['PUT /api/gym/students'](
      { headers: { 'x-tenant-id': 'gym6' }, body: { id: st1Id, disabled: true } },
      {}
    );

    const resInv1 = {};
    await env.routes['POST /api/gym/invites']({ headers: { 'x-tenant-id': 'gym6' }, body: { note: 'vaga 1' } }, resInv1);
    assert.equal(resInv1.status, 201);

    // 2nd pending invite when activeStudents(0) + pendingInvites(1) >= maxStudents(1) must be blocked!
    const resInv2 = {};
    await env.routes['POST /api/gym/invites']({ headers: { 'x-tenant-id': 'gym6' }, body: { note: 'excesso' } }, resInv2);
    assert.equal(resInv2.status, 403);
    assert.equal(resInv2.data.code, 'plan-limit');

    // Revoke inv1, then minting a fresh invite succeeds again!
    const resRevoke = {};
    await env.routes['POST /api/gym/invites/revoke'](
      { headers: { 'x-tenant-id': 'gym6' }, body: { code: resInv1.data.invite.code } },
      resRevoke
    );
    assert.equal(resRevoke.status, 200);

    const resInv3 = {};
    await env.routes['POST /api/gym/invites']({ headers: { 'x-tenant-id': 'gym6' }, body: { note: 'apos revogar' } }, resInv3);
    assert.equal(resInv3.status, 201);

    const resSt2 = {};
    await env.routes['POST /api/gym/students'](
      {
        headers: { 'x-tenant-id': 'gym6' },
        body: { name: 'Aluno Two', email: 'st2@gym6.com', password: 'StudentSixPass#22' }
      },
      resSt2
    );
    assert.equal(resSt2.status, 201);

    const resReenableSt1 = {};
    await env.routes['PUT /api/gym/students'](
      { headers: { 'x-tenant-id': 'gym6' }, body: { id: st1Id, disabled: false } },
      resReenableSt1
    );
    assert.equal(resReenableSt1.status, 403);
    assert.equal(resReenableSt1.data.code, 'plan-limit');

    // 3. Student-only target guards block targeting staff/superadmin on student routes (even as owner or superadmin)
    for (const actor of [owner6, env.db.users.find(u => u.id === 'u_sup_6') || { id: 'u_sup_6', name: 'Super Root', saasRole: 'superadmin', admin: true }]) {
      env.setUser(actor);
      const targetStaffId = tr3Id;

      const rGet = {};
      await env.routes['GET /api/gym/student']({ headers: { 'x-tenant-id': 'gym6' }, url: `/api/gym/student?id=${targetStaffId}` }, rGet);
      assert.equal(rGet.status, 403);

      const rPut = {};
      await env.routes['PUT /api/gym/students']({ headers: { 'x-tenant-id': 'gym6' }, body: { id: targetStaffId, name: 'Hijack' } }, rPut);
      assert.equal(rPut.status, 403);

      const rPwd = {};
      await env.routes['POST /api/gym/students/password']({ headers: { 'x-tenant-id': 'gym6' }, body: { id: targetStaffId, mode: 'reset-code' } }, rPwd);
      assert.equal(rPwd.status, 403);

      const rDel = {};
      await env.routes['DELETE /api/gym/students']({ headers: { 'x-tenant-id': 'gym6' }, body: { id: targetStaffId } }, rDel);
      assert.equal(rDel.status, 403);

      const rPrescribe = {};
      await env.routes['POST /api/gym/prescribe'](
        { headers: { 'x-tenant-id': 'gym6' }, body: { studentId: targetStaffId, routine: { name: 'R1', ex: [{ id: '0025' }] } } },
        rPrescribe
      );
      assert.equal(rPrescribe.status, 403);

      const rDelRot = {};
      await env.routes['POST /api/gym/student/routine/delete'](
        { headers: { 'x-tenant-id': 'gym6' }, body: { studentId: targetStaffId, routineId: 'r1' } },
        rDelRot
      );
      assert.equal(rDelRot.status, 403);

      const rWeek = {};
      await env.routes['POST /api/gym/student/week'](
        { headers: { 'x-tenant-id': 'gym6' }, body: { studentId: targetStaffId, week: { 1: 'r1' } } },
        rWeek
      );
      assert.equal(rWeek.status, 403);

      const rLegacyGet = {};
      await env.routes['GET /api/trainer/student']({ headers: { 'x-tenant-id': 'gym6' }, url: `/api/trainer/student?id=${targetStaffId}` }, rLegacyGet);
      assert.equal(rLegacyGet.status, 403);

      const rLegacyPrescribe = {};
      await env.routes['POST /api/trainer/prescribe'](
        { headers: { 'x-tenant-id': 'gym6' }, body: { studentId: targetStaffId, routine: { name: 'R1', ex: [{ id: '0025' }] } } },
        rLegacyPrescribe
      );
      assert.equal(rLegacyPrescribe.status, 403);
    }
  } finally {
    fs.rmSync(env.tmpDir, { recursive: true, force: true });
  }
});


