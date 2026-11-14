import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import { listTenants } from '../tenants.js';
import { loadCoreDbFromSqlite } from '../sqlite.js';

const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function spawnTestServer(dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      ORIGIN: 'https://example.test',
      PORTAL_URL: 'https://painel.example.test',
      RP_ID: 'example.test',
      PASSWORD_LOGIN: '1',
      TRUST_PROXY: '1',
      INVITE_ONLY: '0',
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

test('server.js HTTP security: subdomain/PORTAL_URL CSRF, per-tenant inviteOnly, maxStudents limit, and suspended lock', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-saas-sec-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), 'c'.repeat(64), { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [] }));

  const { child, getLog } = spawnTestServer(dataDir);
  t.after(() => {
    try { child.kill('SIGKILL'); } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const port = await boundPort(child, getLog);
  const base = `http://127.0.0.1:${port}`;
  let ipCounter = 10;
  const req = async (method, p, { body, headers = {}, ip } = {}) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': ip || `198.51.100.${++ipCounter}`,
        'X-Forwarded-Proto': 'https',
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: r.status, body: data, headers: r.headers };
  };

  // 1. Setup initial superadmin, then verify CSRF Origin enforcement on unauthenticated signup and Cookie-auth mutations
  const setupOk = await req('POST', '/api/saas/auth/setup-admin', {
    headers: { Origin: 'https://painel.example.test' },
    body: { email: 'root@example.test', password: 'SuperPassword123!', name: 'Platform Owner' }
  });
  assert.equal(setupOk.status, 200);
  const superToken = setupOk.body.token;
  assert.ok(superToken);

  const evilSignupOrigin = await req('POST', '/api/register/password', {
    headers: { Origin: 'https://evil-example.test' },
    body: { name: 'Intruso CSRF', password: 'StudentPassword123!' }
  });
  assert.equal(evilSignupOrigin.status, 403);

  const wrongSchemeSignupOrigin = await req('POST', '/api/register/password', {
    headers: { Origin: 'http://painel.example.test' },
    body: { name: 'Intruso HTTP', password: 'StudentPassword123!' }
  });
  assert.equal(wrongSchemeSignupOrigin.status, 403);

  const authHeaders = {
    Authorization: `Bearer ${superToken}`,
    Origin: 'https://painel.example.test'
  };

  // 2. Create two tenants: vipgym (inviteOnly=true, maxStudents=1) and opengym (inviteOnly=false)
  const createVip = await req('POST', '/api/saas/admin/tenants', {
    headers: authHeaders,
    body: {
      id: 'vipgym',
      name: 'VIP Gym',
      planId: 'starter',
      ownerName: 'Dono VIP',
      ownerEmail: 'dono@vipgym.test',
      ownerPassword: 'VipOwnerPassword123!'
    }
  });
  assert.equal(createVip.status, 201);

  const createOpen = await req('POST', '/api/saas/admin/tenants', {
    headers: authHeaders,
    body: {
      id: 'opengym2',
      name: 'Open Gym 2',
      planId: 'starter',
      ownerName: 'Dono Open',
      ownerEmail: 'dono@opengym2.test',
      ownerPassword: 'OpenOwnerPassword123!'
    }
  });
  assert.equal(createOpen.status, 201);

  // Set vipgym inviteOnly=true & maxStudentsOverride=1
  const patchVip = await req('PUT', '/api/saas/admin/tenants', {
    headers: authHeaders,
    body: {
      id: 'vipgym',
      settings: { inviteOnly: true },
      maxStudentsOverride: 1
    }
  });
  assert.equal(patchVip.status, 200);
  assert.equal(patchVip.body.tenant.limits.maxStudents, 1);

  // Verify /api/config reflects per-tenant inviteOnly even with global INVITE_ONLY=0
  const cfgVip = await req('GET', '/api/config', { headers: { 'X-Tenant-Id': 'vipgym' } });
  assert.equal(cfgVip.status, 200);
  assert.equal(cfgVip.body.invite_only, true);

  const cfgOpen = await req('GET', '/api/config', { headers: { 'X-Tenant-Id': 'opengym2' } });
  assert.equal(cfgOpen.status, 200);
  assert.equal(cfgOpen.body.invite_only, false);

  // Subdomain origin (https://vipgym.example.test) accepted for student endpoints without Sec-Fetch-Site
  const noInviteSignup = await req('POST', '/api/register/password', {
    headers: { Origin: 'https://vipgym.example.test', 'X-Tenant-Id': 'vipgym' },
    body: { name: 'Aluno Sem Convite', password: 'StudentPassword123!' }
  });
  assert.equal(noInviteSignup.status, 403);
  assert.equal(noInviteSignup.body.code, 'invite');

  // Create invite in opengym2 vs vipgym
  const loginOpenOwner = await req('POST', '/api/saas/auth/login', {
    headers: { Origin: 'https://painel.example.test' },
    body: { identifier: 'dono@opengym2.test', password: 'OpenOwnerPassword123!' }
  });
  assert.equal(loginOpenOwner.status, 200);
  const invOpen = await req('POST', '/api/gym/invites', {
    headers: {
      Origin: 'https://painel.example.test',
      Authorization: `Bearer ${loginOpenOwner.body.token}`,
      'X-Tenant-Id': 'opengym2'
    },
    body: {}
  });
  assert.equal(invOpen.status, 201);

  const loginVipOwner = await req('POST', '/api/saas/auth/login', {
    headers: { Origin: 'https://painel.example.test' },
    body: { identifier: 'dono@vipgym.test', password: 'VipOwnerPassword123!' }
  });
  assert.equal(loginVipOwner.status, 200);
  const vipCookie = loginVipOwner.headers.get('set-cookie')?.split(';')[0] || '';
  assert.ok(vipCookie.startsWith('__Host-gymsid='));

  // Cookie-authenticated mutation without Bearer validates PORTAL_URL / evil Origin
  const evilCookieCsrf = await req('POST', '/api/gym/invites', {
    headers: {
      Origin: 'https://evil-example.test',
      Cookie: vipCookie,
      'X-Tenant-Id': 'vipgym'
    },
    body: {}
  });
  assert.equal(evilCookieCsrf.status, 403);

  const invVip = await req('POST', '/api/gym/invites', {
    headers: {
      Origin: 'https://painel.example.test',
      Cookie: vipCookie,
      'X-Tenant-Id': 'vipgym'
    },
    body: {}
  });
  assert.equal(invVip.status, 201);

  // Cross-tenant invite must be rejected on vipgym!
  const crossInviteSignup = await req('POST', '/api/register/password', {
    headers: { Origin: 'https://vipgym.example.test', 'X-Tenant-Id': 'vipgym' },
    body: { name: 'Aluno Cruzado', password: 'StudentPassword123!', code: invOpen.body.invite.code }
  });
  assert.equal(crossInviteSignup.status, 403);
  assert.equal(crossInviteSignup.body.code, 'invite');

  // Valid vipgym invite succeeds (1st student -> fills maxStudents=1)
  const validInviteSignup = await req('POST', '/api/register/password', {
    headers: { Origin: 'https://vipgym.example.test', 'X-Tenant-Id': 'vipgym' },
    body: { name: 'Aluno VIP 1', password: 'StudentPassword123!', code: invVip.body.invite.code }
  });
  assert.equal(validInviteSignup.status, 200);

  // Etapa 6: creating another invite while at maxStudents=1 must be blocked with plan-limit
  const invVipAtCap = await req('POST', '/api/gym/invites', {
    headers: {
      Origin: 'https://painel.example.test',
      Authorization: `Bearer ${loginVipOwner.body.token}`,
      'X-Tenant-Id': 'vipgym'
    },
    body: {}
  });
  assert.equal(invVipAtCap.status, 403);
  assert.equal(invVipAtCap.body.code, 'plan-limit');

  // Temporarily allow 2 slots to pre-mint 1 pending invite, verify 3rd invite is blocked (active + pending >= 2),
  // then tighten back to maxStudents=1 so signup with pre-minted invite STILL hits plan-limit on register
  const bumpVipCap = await req('PUT', '/api/saas/admin/tenants', {
    headers: authHeaders,
    body: { id: 'vipgym', maxStudentsOverride: 2 }
  });
  assert.equal(bumpVipCap.status, 200);

  const invVip2 = await req('POST', '/api/gym/invites', {
    headers: {
      Origin: 'https://painel.example.test',
      Authorization: `Bearer ${loginVipOwner.body.token}`,
      'X-Tenant-Id': 'vipgym'
    },
    body: {}
  });
  assert.equal(invVip2.status, 201);

  const invVip3OverPending = await req('POST', '/api/gym/invites', {
    headers: {
      Origin: 'https://painel.example.test',
      Authorization: `Bearer ${loginVipOwner.body.token}`,
      'X-Tenant-Id': 'vipgym'
    },
    body: {}
  });
  assert.equal(invVip3OverPending.status, 403);
  assert.equal(invVip3OverPending.body.code, 'plan-limit');

  const restoreVipCap = await req('PUT', '/api/saas/admin/tenants', {
    headers: authHeaders,
    body: { id: 'vipgym', maxStudentsOverride: 1 }
  });
  assert.equal(restoreVipCap.status, 200);

  const overLimitSignup = await req('POST', '/api/register/password', {
    headers: { Origin: 'https://vipgym.example.test', 'X-Tenant-Id': 'vipgym' },
    body: { name: 'Aluno VIP 2', password: 'StudentPassword123!', code: invVip2.body.invite.code }
  });
  assert.equal(overLimitSignup.status, 403);
  assert.equal(overLimitSignup.body.code, 'plan-limit');

  // 3. Suspend vipgym -> login blocked cleanly
  const suspendVip = await req('POST', '/api/saas/admin/tenants/status', {
    headers: authHeaders,
    body: { id: 'vipgym', status: 'suspended' }
  });
  assert.equal(suspendVip.status, 200);

  const suspendedLogin = await req('POST', '/api/login/password', {
    headers: { Origin: 'https://vipgym.example.test', 'X-Tenant-Id': 'vipgym' },
    body: { name: 'Aluno VIP 1', password: 'StudentPassword123!' }
  });
  assert.equal(suspendedLogin.status, 403);
});

test('clean-demo-data CLI removes demo tenants cleanly via deleteKv while keeping real customers (including u_st_*)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-clean-demo-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), 'd'.repeat(64), { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [] }));

  const { child, getLog } = spawnTestServer(dataDir, {
    SAAS_AUTO_SEED: '1',
    RP_ID: 'localhost',
    ORIGIN: 'http://localhost:8080',
    PORTAL_URL: 'http://localhost:8081'
  });

  try {
    const port = await boundPort(child, getLog);
    const base = `http://127.0.0.1:${port}`;
    const call = async (method, p, { body, headers = {} } = {}) => {
      const r = await fetch(`${base}${p}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'same-origin',
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: r.status, body: await r.json() };
    };

    // Login as seeded superadmin (ensureSaasDemoSeed runs asynchronously after startup)
    await new Promise(r => setTimeout(r, 250));
    let loginSa = null;
    for (let i = 0; i < 20; i++) {
      loginSa = await call('POST', '/api/saas/auth/login', {
        headers: { 'X-Forwarded-For': `198.51.100.${100 + i}` },
        body: { identifier: 'admin@rit.com.br', password: 'rit2026' }
      });
      if (loginSa.status === 200) break;
      await new Promise(r => setTimeout(r, 200));
    }
    assert.equal(loginSa.status, 200);
    const saHeaders = { Authorization: `Bearer ${loginSa.body.token}` };

    const cr = await call('POST', '/api/saas/admin/tenants', {
      headers: saHeaders,
      body: {
        id: 'realfit',
        name: 'Real Fit Academia',
        planId: 'pro',
        ownerName: 'Dona Clara',
        ownerEmail: 'clara@realfit.com.br',
        ownerPassword: 'ClaraPassword123!'
      }
    });
    assert.equal(cr.status, 201);

    const loginOwner = await call('POST', '/api/saas/auth/login', {
      body: { identifier: 'clara@realfit.com.br', password: 'ClaraPassword123!' }
    });
    assert.equal(loginOwner.status, 200);

    const addStu = await call('POST', '/api/gym/students', {
      headers: { Authorization: `Bearer ${loginOwner.body.token}`, 'X-Tenant-Id': 'realfit' },
      body: { name: 'Cliente Real VIP', email: 'cliente@realfit.com.br', password: 'ClientePassword123!' }
    });
    assert.equal(addStu.status, 201);
    assert.ok(addStu.body.student.id.startsWith('u_st_'));

    // Stop server gracefully so SQLite locks close before running CLI
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));

    const out = execFileSync(process.execPath, ['clean-demo-data.js'], {
      cwd: API_DIR,
      env: { ...process.env, DATA_DIR: dataDir },
      encoding: 'utf8'
    });
    assert.match(out, /BASE DE DADOS LIMPA COM SUCESSO/i);

    const remainingTenants = listTenants(dataDir);
    assert.equal(remainingTenants.some(t => t.id === 'ironpower'), false);
    assert.equal(remainingTenants.some(t => t.id === 'arenacross'), false);
    assert.equal(remainingTenants.some(t => t.id === 'realfit'), true);

    const core = loadCoreDbFromSqlite(dataDir);
    assert.equal(core.users.some(u => u.email === 'cliente@realfit.com.br'), true);
    assert.equal(core.users.some(u => u.email === 'bruno@arenacross.com.br'), false);
  } finally {
    try { child.kill('SIGKILL'); } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Etapa 4 HTTP lock: expired trial & past_due block students/trainers/operations while allowing owner billing recovery', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-trial-lock-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), 'f'.repeat(64), { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [] }));

  const { child, getLog } = spawnTestServer(dataDir);
  t.after(() => {
    try { child.kill('SIGKILL'); } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const port = await boundPort(child, getLog);
  const base = `http://127.0.0.1:${port}`;
  const req = async (method, p, { body, headers = {} } = {}) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'same-origin',
        Origin: 'https://example.test',
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed, headers: r.headers };
  };

  // Setup superadmin and active tenant + owner + trainer + student
  const sa = await req('POST', '/api/saas/auth/setup-admin', {
    body: { email: 'root@example.test', password: 'StrongAdminPassword2026!', name: 'Root' }
  });
  assert.equal(sa.status, 200);
  const saHeaders = { Authorization: `Bearer ${sa.body.token}` };

  const created = await req('POST', '/api/saas/admin/tenants', {
    headers: saHeaders,
    body: {
      id: 'triallock',
      name: 'Trial Lock Gym',
      planId: 'starter',
      status: 'active',
      ownerName: 'Dono Trial',
      ownerEmail: 'dono@triallock.test',
      ownerPassword: 'OwnerPassword2026!'
    }
  });
  assert.equal(created.status, 201);

  const ownerActiveLogin = await req('POST', '/api/saas/auth/login', {
    body: { identifier: 'dono@triallock.test', password: 'OwnerPassword2026!' }
  });
  assert.equal(ownerActiveLogin.status, 200);
  const ownerBearer = { Authorization: `Bearer ${ownerActiveLogin.body.token}`, 'X-Tenant-Id': 'triallock' };

  const addTrainer = await req('POST', '/api/gym/team', {
    headers: ownerBearer,
    body: { name: 'Prof Bloqueado', email: 'prof@triallock.test', password: 'TrainerPassword2026!', saasRole: 'trainer' }
  });
  assert.equal(addTrainer.status, 201);

  const addStu = await req('POST', '/api/gym/students', {
    headers: ownerBearer,
    body: { name: 'Aluno Bloqueado', email: 'aluno@triallock.test', password: 'StudentPassword2026!' }
  });
  assert.equal(addStu.status, 201);

  const stuLoginOk = await req('POST', '/api/login/password', {
    headers: { Origin: 'https://triallock.example.test', 'X-Tenant-Id': 'triallock' },
    body: { name: 'Aluno Bloqueado', password: 'StudentPassword2026!' }
  });
  assert.equal(stuLoginOk.status, 200);
  const stuCookie = (stuLoginOk.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(stuCookie.includes('='));

  // Transition tenant to expired trial
  const expireTrial = await req('PUT', '/api/saas/admin/tenants', {
    headers: saHeaders,
    body: {
      id: 'triallock',
      status: 'trial',
      trialEndsAt: new Date(Date.now() - 3600_000).toISOString()
    }
  });
  assert.equal(expireTrial.status, 200);

  // Student session invalidated & login blocked
  const stuSyncBlocked = await req('GET', '/api/me', {
    headers: { Cookie: stuCookie, Origin: 'https://triallock.example.test' }
  });
  assert.equal(stuSyncBlocked.status, 401);

  const stuLoginBlocked = await req('POST', '/api/login/password', {
    headers: { Origin: 'https://triallock.example.test', 'X-Tenant-Id': 'triallock' },
    body: { name: 'Aluno Bloqueado', password: 'StudentPassword2026!' }
  });
  assert.equal(stuLoginBlocked.status, 403);

  // Trainer B2B login & operational endpoints blocked
  const trainerBlocked = await req('POST', '/api/saas/auth/login', {
    body: { identifier: 'prof@triallock.test', password: 'TrainerPassword2026!' }
  });
  assert.equal(trainerBlocked.status, 403);

  // Owner B2B login succeeds in billingOnly mode; operational routes blocked, billing routes allowed
  const ownerExpiredLogin = await req('POST', '/api/saas/auth/login', {
    body: { identifier: 'dono@triallock.test', password: 'OwnerPassword2026!' }
  });
  assert.equal(ownerExpiredLogin.status, 200);
  assert.equal(ownerExpiredLogin.body.billingOnly, true);
  assert.equal(ownerExpiredLogin.body.blockReason, 'trial_expired');

  const billingOwnerHeaders = { Authorization: `Bearer ${ownerExpiredLogin.body.token}`, 'X-Tenant-Id': 'triallock' };
  const gymOvBlocked = await req('GET', '/api/gym/overview', { headers: billingOwnerHeaders });
  assert.equal(gymOvBlocked.status, 403);
  assert.equal(gymOvBlocked.body.billingRequired, true);

  const billingStatusOk = await req('GET', '/api/saas/billing/status', { headers: billingOwnerHeaders });
  assert.equal(billingStatusOk.status, 200);
  assert.equal(billingStatusOk.body.accessBlocked, true);
  assert.equal(billingStatusOk.body.blockReason, 'trial_expired');

  // Same enforcement for past_due, while suspended blocks even owner billing
  const setPastDue = await req('POST', '/api/saas/admin/tenants/status', {
    headers: saHeaders,
    body: { id: 'triallock', status: 'past_due' }
  });
  assert.equal(setPastDue.status, 200);

  const billingStatusPastDue = await req('GET', '/api/saas/billing/status', { headers: billingOwnerHeaders });
  assert.equal(billingStatusPastDue.status, 200);
  assert.equal(billingStatusPastDue.body.blockReason, 'past_due');

  const setSuspended = await req('POST', '/api/saas/admin/tenants/status', {
    headers: saHeaders,
    body: { id: 'triallock', status: 'suspended' }
  });
  assert.equal(setSuspended.status, 200);

  const suspendedBillingDenied = await req('GET', '/api/saas/billing/status', { headers: billingOwnerHeaders });
  assert.equal(suspendedBillingDenied.status, 401);
});

test('Etapa 7 HTTP security: SaaS auth CSRF + Bearer non-bypass, prod localhost CORS lock, and homonymous login isolation', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-etapa7-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), 'e'.repeat(64), { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [], creds: [], subs: [], invites: [] }));

  const { child, getLog } = spawnTestServer(dataDir, {
    NODE_ENV: 'production',
    ORIGIN: 'https://rit.example.test',
    PORTAL_URL: 'https://painel.example.test',
    RP_ID: 'rit.example.test',
    SETUP_ADMIN_TOKEN: 'etapa7-setup-token-2026'
  });

  t.after(() => {
    try { child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const port = await boundPort(child, getLog);
  const base = `http://127.0.0.1:${port}`;
  let ipCounter = 10;

  const rawCall = async (method, p, { headers = {}, body, rawBody, contentType = 'application/json', ip } = {}) => {
    const reqHeaders = {
      'X-Forwarded-For': ip || `203.0.113.${++ipCounter}`,
      ...headers
    };
    let payload;
    if (rawBody !== undefined) {
      reqHeaders['Content-Type'] = contentType;
      payload = rawBody;
    } else if (body !== undefined) {
      reqHeaders['Content-Type'] = contentType;
      payload = JSON.stringify(body);
    }
    const r = await fetch(`${base}${p}`, { method, headers: reqHeaders, body: payload });
    const ct = r.headers.get('content-type') || '';
    const parsed = ct.includes('application/json') ? await r.json().catch(() => null) : await r.text().catch(() => '');
    return { status: r.status, headers: r.headers, body: parsed };
  };

  // 1. Production CORS: reject arbitrary localhost/127.0.0.1 origins, keep Capacitor & configured PORTAL_URL
  for (const blockedOrig of ['http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost']) {
    const pre = await rawCall('OPTIONS', '/api/saas/auth/login', {
      headers: {
        Origin: blockedOrig,
        'Access-Control-Request-Method': 'POST'
      }
    });
    assert.equal(pre.headers.get('access-control-allow-origin'), null, `Expected CORS rejection for ${blockedOrig}`);
  }
  for (const allowedOrig of ['https://localhost', 'capacitor://localhost', 'https://painel.example.test']) {
    const pre = await rawCall('OPTIONS', '/api/saas/auth/login', {
      headers: {
        Origin: allowedOrig,
        'Access-Control-Request-Method': 'POST'
      }
    });
    assert.equal(pre.headers.get('access-control-allow-origin'), allowedOrig, `Expected CORS allow for ${allowedOrig}`);
  }

  // 2. setup-admin CSRF: reject foreign Origin and text/plain form submissions
  const setupEvil = await rawCall('POST', '/api/saas/auth/setup-admin', {
    headers: { Origin: 'https://evil.example.test', 'Sec-Fetch-Site': 'cross-site' },
    body: {
      email: 'root@rit.example.test',
      password: 'SuperAdminPassword2026!',
      name: 'Diretoria',
      setupToken: 'etapa7-setup-token-2026'
    }
  });
  assert.equal(setupEvil.status, 403);

  const setupTextPlain = await rawCall('POST', '/api/saas/auth/setup-admin', {
    headers: { Origin: 'https://painel.example.test', 'Sec-Fetch-Site': 'same-origin' },
    contentType: 'text/plain',
    rawBody: '{"email":"root@rit.example.test"}'
  });
  assert.equal(setupTextPlain.status, 415);

  const setupOk = await rawCall('POST', '/api/saas/auth/setup-admin', {
    headers: { Origin: 'https://painel.example.test', 'Sec-Fetch-Site': 'same-origin' },
    body: {
      email: 'root@rit.example.test',
      password: 'SuperAdminPassword2026!',
      name: 'Diretoria',
      setupToken: 'etapa7-setup-token-2026'
    }
  });
  assert.equal(setupOk.status, 200);
  const saToken = setupOk.body.token;
  assert.ok(saToken);

  const saHeaders = {
    Origin: 'https://painel.example.test',
    'Sec-Fetch-Site': 'same-origin',
    Authorization: `Bearer ${saToken}`
  };

  // Create two active gyms + homonymous trainers ("Prof. Carlos")
  for (const g of [
    { id: 'alpha', name: 'Academia Alpha', ownerEmail: 'dono@alpha.example', trainerEmail: 'carlos@alpha.example', trainerPw: 'CarlosAlphaPassword2026!' },
    { id: 'iron', name: 'Academia Iron', ownerEmail: 'dono@iron.example', trainerEmail: 'carlos@iron.example', trainerPw: 'CarlosIronPassword2026!' }
  ]) {
    const cr = await rawCall('POST', '/api/saas/admin/tenants', {
      headers: saHeaders,
      body: {
        id: g.id,
        name: g.name,
        planId: 'starter',
        status: 'active',
        ownerName: `Dono ${g.id}`,
        ownerEmail: g.ownerEmail,
        ownerPassword: 'OwnerPassword2026!'
      }
    });
    assert.equal(cr.status, 201);

    const addTrainer = await rawCall('POST', '/api/gym/team', {
      headers: { ...saHeaders, 'X-Tenant-Id': g.id },
      body: {
        name: 'Prof. Carlos',
        email: g.trainerEmail,
        password: g.trainerPw,
        saasRole: 'trainer'
      }
    });
    assert.equal(addTrainer.status, 201);
  }

  // 3. Bearer token CANNOT bypass CSRF Origin / Sec-Fetch-Site check on /api/saas/auth/login
  const bearerBypassAttempt = await rawCall('POST', '/api/saas/auth/login', {
    headers: {
      Origin: 'https://evil.example.test',
      'Sec-Fetch-Site': 'cross-site',
      Authorization: `Bearer ${saToken}`
    },
    body: { identifier: 'carlos@alpha.example', password: 'CarlosAlphaPassword2026!' }
  });
  assert.equal(bearerBypassAttempt.status, 403);

  const crossSiteNoOrigin = await rawCall('POST', '/api/saas/auth/login', {
    headers: { 'Sec-Fetch-Site': 'cross-site' },
    body: { identifier: 'carlos@alpha.example', password: 'CarlosAlphaPassword2026!' }
  });
  assert.equal(crossSiteNoOrigin.status, 403);

  const loginTextPlain = await rawCall('POST', '/api/saas/auth/login', {
    headers: { Origin: 'https://painel.example.test', 'Sec-Fetch-Site': 'same-origin' },
    contentType: 'text/plain',
    rawBody: '{"identifier":"carlos@alpha.example"}'
  });
  assert.equal(loginTextPlain.status, 415);

  // 4. Homonymous name login without tenantHint returns 409 ambiguous-identifier, throttles amb: bucket, and NEVER locks innocent users
  for (let i = 0; i < 6; i++) {
    const amb = await rawCall('POST', '/api/saas/auth/login', {
      ip: `203.0.113.${200 + i}`,
      headers: { Origin: 'https://painel.example.test', 'Sec-Fetch-Site': 'same-origin' },
      body: { identifier: 'Prof. Carlos', password: 'WrongPasswordAttempt2026!' }
    });
    assert.equal(amb.status, 409);
    assert.equal(amb.body.code, 'ambiguous-identifier');
  }

  const ambThrottled = await rawCall('POST', '/api/saas/auth/login', {
    ip: '203.0.113.210',
    headers: { Origin: 'https://painel.example.test', 'Sec-Fetch-Site': 'same-origin' },
    body: { identifier: 'Prof. Carlos', password: 'WrongPasswordAttempt2026!' }
  });
  assert.equal(ambThrottled.status, 429);

  // Both homonymous trainers remain completely unlocked via unique email or X-Tenant-Id
  const alphaEmailOk = await rawCall('POST', '/api/saas/auth/login', {
    ip: '203.0.113.220',
    headers: { Origin: 'https://painel.example.test', 'Sec-Fetch-Site': 'same-origin' },
    body: { identifier: 'carlos@alpha.example', password: 'CarlosAlphaPassword2026!' }
  });
  assert.equal(alphaEmailOk.status, 200);
  assert.equal(alphaEmailOk.body.user.tenantId, 'alpha');

  const ironScopedOk = await rawCall('POST', '/api/saas/auth/login', {
    ip: '203.0.113.221',
    headers: { Origin: 'https://painel.example.test', 'Sec-Fetch-Site': 'same-origin', 'X-Tenant-Id': 'iron' },
    body: { identifier: 'Prof. Carlos', password: 'CarlosIronPassword2026!' }
  });
  assert.equal(ironScopedOk.status, 200);
  assert.equal(ironScopedOk.body.user.tenantId, 'iron');
});
