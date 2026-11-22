/* Mobile notification inbox: every non-rest-timer sendPush(userId, payload) queues into SQLite
   even when the user has zero Web Push subscriptions (APK-only student), and GET /api/notifications/pending
   serves items strictly after `since` to the signed-in user only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';
import {
  enqueueMobileNotificationSqlite,
  listMobileNotificationsSqlite,
  deleteMobileNotificationsSqlite,
  closeSqliteInstance
} from '../sqlite.js';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const mintSession = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0:b`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};

test('SQLite mobile notification inbox enqueues, filters by sinceId, isolates users, and deletes cleanly', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rit-mob-notif-unit-'));
  t.after(() => {
    closeSqliteInstance(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const a1 = enqueueMobileNotificationSqlite(dir, 'u_ana', {
    title: 'Nova ficha liberada no Rit!',
    body: 'Prof. Lucas atualizou Treino A.',
    tag: 'prescription-update',
    url: '#/'
  });
  const a2 = enqueueMobileNotificationSqlite(dir, 'u_ana', {
    title: 'Resumo da semana: 4/4 treinos',
    body: 'Parabéns pela constância!',
    tag: 'weekly-summary',
    url: '#/'
  });
  enqueueMobileNotificationSqlite(dir, 'u_bea', {
    title: 'Somente para Bea',
    body: 'Outro aluno',
    tag: 'test'
  });

  const initial = listMobileNotificationsSqlite(dir, 'u_ana', { sinceId: 0 });
  assert.equal(initial.latestId, a2.id);
  assert.equal(initial.notifications.length, 2);
  assert.equal(initial.notifications[0].id, a1.id);
  assert.equal(initial.notifications[1].id, a2.id);

  const afterFirst = listMobileNotificationsSqlite(dir, 'u_ana', { sinceId: a1.id });
  assert.equal(afterFirst.notifications.length, 1);
  assert.equal(afterFirst.notifications[0].id, a2.id);

  const afterLatest = listMobileNotificationsSqlite(dir, 'u_ana', { sinceId: a2.id });
  assert.equal(afterLatest.notifications.length, 0);

  const bea = listMobileNotificationsSqlite(dir, 'u_bea', { sinceId: 0 });
  assert.equal(bea.notifications.length, 1);
  assert.equal(bea.notifications[0].title, 'Somente para Bea');

  deleteMobileNotificationsSqlite(dir, 'u_ana');
  const gone = listMobileNotificationsSqlite(dir, 'u_ana', { sinceId: 0 });
  assert.equal(gone.latestId, 0);
  assert.equal(gone.notifications.length, 0);
});

test('GET /api/notifications/pending delivers push notifications to APK-only users with zero Web Push subs', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rit-mob-notif-srv-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [
      { id: 'u_ana', name: 'Ana', created: now },
      { id: 'u_bea', name: 'Bea', created: now }
    ],
    creds: [],
    subs: [],
    invites: []
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  t.after(() => {
    child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${await boundPort(child, () => log)}`;

  // Unauthenticated must be rejected
  const unauth = await fetch(`${base}/api/notifications/pending`);
  assert.equal(unauth.status, 401);

  const anaHeaders = { Authorization: `Bearer ${mintSession('u_ana')}` };
  const beaHeaders = { Authorization: `Bearer ${mintSession('u_bea')}` };

  // Trigger a push for Ana (even with 0 Web Push subs)
  const testRes = await fetch(`${base}/api/push/test`, {
    method: 'POST',
    headers: { ...anaHeaders, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(testRes.status, 200);

  // Ana receives the queued notification via native Bearer token
  const pending1 = await fetch(`${base}/api/notifications/pending?since=0`, { headers: anaHeaders });
  assert.equal(pending1.status, 200);
  const body1 = await pending1.json();
  assert.equal(body1.ok, true);
  assert.equal(body1.notifications.length, 1);
  assert.ok(body1.latestId > 0);
  assert.ok(body1.notifications[0].title.length > 0);

  // Polling again with since=latestId returns empty (deduplicated)
  const pending2 = await fetch(`${base}/api/notifications/pending?since=${body1.latestId}`, { headers: anaHeaders });
  const body2 = await pending2.json();
  assert.equal(body2.notifications.length, 0);

  // Bea does not see Ana's notification
  const pendingBea = await fetch(`${base}/api/notifications/pending?since=0`, { headers: beaHeaders });
  const bodyBea = await pendingBea.json();
  assert.equal(bodyBea.notifications.length, 0);
});
