import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { boundPort } from './helpers.mjs';
import * as M from './media-samples.mjs';
import { hashPassword } from '../password.js';
import { createTenant, getTenantDir, saveTenantBranding } from '../tenants.js';
import {
  clearTenantExercisesData,
  getTenantExercisesPayload,
  readTenantMediaState,
  tenantMediaBucket,
} from '../exercise-media.js';
import {
  closeSqliteInstance,
  upsertUserSqlite,
} from '../sqlite.js';

const API_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const ORIGIN = 'http://localhost:8080';

function mintSession(uid, sv = 0) {
  const payload = `${uid}:${Date.now() + 86400000}:${sv}`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rit-tenant-iso-'));
  fs.writeFileSync(path.join(dir, 'secret'), SECRET, { mode: 0o600 });
  return dir;
}

async function startServer(t, { dataDir, env = {} }) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dataDir,
      ORIGIN,
      PORTAL_URL: ORIGIN,
      RP_ID: 'localhost',
      PASSWORD_LOGIN: '1',
      MEDIA_UPLOADS: '1',
      MEDIA_MIN_FREE_MB: '1',
      TRUST_PROXY: '1',
      ...env,
    },
  });
  const h = { api: '', log: '', dataDir };
  child.stdout.on('data', d => { h.log += d; });
  child.stderr.on('data', d => { h.log += d; });
  t.after(() => {
    child.kill('SIGKILL');
    try { closeSqliteInstance(dataDir); } catch { /* ignore */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  h.api = `http://127.0.0.1:${await boundPort(child, () => h.log)}`;
  h.reqJson = async (method, urlPath, { body, cookie, token, headers = {} } = {}) => {
    const r = await fetch(`${h.api}${urlPath}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Origin: ORIGIN,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed, headers: r.headers };
  };
  return h;
}

test('Bloco 1 + Bloco 2: isolamento cross-tenant (?tenant=), trava automática e vídeos/exercícios da academia', async t => {
  const dataDir = makeTempDir();
  const pwHash = await hashPassword('SenhaForte123!');

  createTenant(dataDir, { id: 'teste', name: 'Academia Teste', planId: 'pro' });
  saveTenantBranding(getTenantDir(dataDir, 'teste'), { gymName: 'Academia Teste', primaryColor: '#10b981' });

  createTenant(dataDir, { id: 'gabrielleite', name: 'Studio Gabriel Leite', planId: 'pro' });
  saveTenantBranding(getTenantDir(dataDir, 'gabrielleite'), { gymName: 'Studio Gabriel Leite', primaryColor: '#2563eb' });

  const users = [
    { id: 'u_super', name: 'Super Admin', email: 'super@rit.com.br', created: new Date().toISOString(), admin: true, owner: true, saasRole: 'superadmin', tenantId: 'default', pw: { h: pwHash, set: new Date().toISOString() } },
    { id: 'u_st_teste', name: 'Aluno Teste', email: 'aluno.teste@rit.com.br', created: new Date().toISOString(), role: 'student', saasRole: 'student', tenantId: 'teste' },
    { id: 'u_st_gabriel', name: 'Aluno Gabriel', email: 'aluno.gabriel@rit.com.br', created: new Date().toISOString(), role: 'student', saasRole: 'student', tenantId: 'gabrielleite' },
    { id: 'u_st_default', name: 'Aluno Default', email: 'aluno.default@rit.com.br', created: new Date().toISOString(), role: 'student', saasRole: 'student', tenantId: 'default' },
    { id: 'u_tr_teste', name: 'Prof Teste', email: 'prof.teste@rit.com.br', created: new Date().toISOString(), role: 'trainer', saasRole: 'trainer', tenantId: 'teste', pw: { h: pwHash, set: new Date().toISOString() } },
    { id: 'u_tr_gabriel', name: 'Prof Gabriel', email: 'prof.gabriel@rit.com.br', created: new Date().toISOString(), role: 'trainer', saasRole: 'trainer', tenantId: 'gabrielleite', pw: { h: pwHash, set: new Date().toISOString() } },
  ];
  for (const u of users) upsertUserSqlite(dataDir, u);

  const h = await startServer(t, { dataDir });

  // ----- BLOCO 1: Isolamento de ?tenant= no backend -----
  // Visitante não autenticado pode visualizar preview via ?tenant=gabrielleite
  const pubBrand = await h.reqJson('GET', '/api/tenant/branding?tenant=gabrielleite');
  assert.equal(pubBrand.status, 200);
  assert.equal(pubBrand.body.tenant_id, 'gabrielleite');
  assert.equal(pubBrand.body.branding.gymName, 'Studio Gabriel Leite');
  assert.equal(pubBrand.body.locked, undefined);

  const pubCfg = await h.reqJson('GET', '/api/config?tenant=gabrielleite');
  assert.equal(pubCfg.status, 200);
  assert.equal(pubCfg.body.tenant_id, 'gabrielleite');

  // Aluno da academia "teste" acessando ?tenant=gabrielleite recebe o próprio tenant "teste" + locked: true
  const testeCookie = `gymsid=${mintSession('u_st_teste')}`;
  const lockedBrand = await h.reqJson('GET', '/api/tenant/branding?tenant=gabrielleite', { cookie: testeCookie });
  assert.equal(lockedBrand.status, 200);
  assert.equal(lockedBrand.body.tenant_id, 'teste');
  assert.equal(lockedBrand.body.branding.gymName, 'Academia Teste');
  assert.equal(lockedBrand.body.locked, true);

  const lockedCfg = await h.reqJson('GET', '/api/config?tenant=gabrielleite', {
    cookie: testeCookie,
    headers: { 'X-Tenant-Id': 'gabrielleite' },
  });
  assert.equal(lockedCfg.status, 200);
  assert.equal(lockedCfg.body.tenant_id, 'teste');

  // Aluno "default" acessando ?tenant=gabrielleite é travado em "default"
  const defCookie = `gymsid=${mintSession('u_st_default')}`;
  const defBrand = await h.reqJson('GET', '/api/tenant/branding?tenant=gabrielleite', { cookie: defCookie });
  assert.equal(defBrand.status, 200);
  assert.equal(defBrand.body.tenant_id, 'default');
  assert.equal(defBrand.body.locked, true);

  const defCfg = await h.reqJson('GET', '/api/config?tenant=gabrielleite', { cookie: defCookie });
  assert.equal(defCfg.status, 200);
  assert.equal(defCfg.body.tenant_id, 'default');

  // Superadmin mantém preview de qualquer academia via ?tenant=
  const superCookie = `gymsid=${mintSession('u_super')}`;
  const superBrand = await h.reqJson('GET', '/api/tenant/branding?tenant=gabrielleite', { cookie: superCookie });
  assert.equal(superBrand.status, 200);
  assert.equal(superBrand.body.tenant_id, 'gabrielleite');
  assert.equal(superBrand.body.locked, undefined);

  // ----- BLOCO 2: Login B2B dos professores via /api/saas/auth/login -----
  const loginTeste = await h.reqJson('POST', '/api/saas/auth/login', {
    body: { email: 'prof.teste@rit.com.br', password: 'SenhaForte123!' },
  });
  assert.equal(loginTeste.status, 200);
  const trTesteToken = loginTeste.body.token;
  assert.ok(trTesteToken);

  const loginGabriel = await h.reqJson('POST', '/api/saas/auth/login', {
    body: { email: 'prof.gabriel@rit.com.br', password: 'SenhaForte123!' },
  });
  assert.equal(loginGabriel.status, 200);
  const trGabrielToken = loginGabriel.body.token;
  assert.ok(trGabrielToken);

  // Professor de "teste" envia MP4, poster PNG e foto WebP para bucket da academia
  const mp4Bytes = M.mp4({ seconds: 4, mdatBytes: 1500 });
  const mp4Hash = M.sha(mp4Bytes);
  const posterBytes = M.png(512);
  const posterHash = M.sha(posterBytes);
  const webpBytes = M.webp(600);
  const webpHash = M.sha(webpBytes);

  const missing1 = await h.reqJson('POST', '/api/gym/media/missing', {
    token: trTesteToken,
    body: { hashes: [mp4Hash, posterHash, webpHash] },
  });
  assert.equal(missing1.status, 200);
  assert.deepEqual(missing1.body.missing.sort(), [mp4Hash, posterHash, webpHash].sort());

  const uploadFile = async (hash, bytes, mime) => {
    const r = await fetch(`${h.api}/api/gym/media/${hash}`, {
      method: 'PUT',
      headers: {
        Origin: ORIGIN,
        Authorization: `Bearer ${trTesteToken}`,
        'Content-Type': mime,
      },
      body: bytes,
    });
    return { status: r.status, body: await r.json() };
  };

  const upVideo = await uploadFile(mp4Hash, mp4Bytes, 'video/mp4');
  assert.equal(upVideo.status, 201);
  const upPoster = await uploadFile(posterHash, posterBytes, 'image/png');
  assert.equal(upPoster.status, 201);
  const upWebp = await uploadFile(webpHash, webpBytes, 'image/webp');
  assert.equal(upWebp.status, 201);

  // Deduplicação funciona após envio
  const missing2 = await h.reqJson('POST', '/api/gym/media/missing', {
    token: trTesteToken,
    body: { hashes: [mp4Hash, posterHash, webpHash] },
  });
  assert.equal(missing2.status, 200);
  assert.deepEqual(missing2.body.missing, []);

  // Sobrescreve vídeo/link/nota do exercício de catálogo 0025 para o tenant "teste"
  const overrideRes = await h.reqJson('PUT', '/api/gym/exercise-media', {
    token: trTesteToken,
    body: {
      exerciseId: '0025',
      media: {
        kind: 'video',
        hash: mp4Hash,
        mime: 'video/mp4',
        size: mp4Bytes.length,
        width: 720,
        height: 405,
        dur: 4,
        poster: { hash: posterHash, mime: 'image/png', size: posterBytes.length, width: 320, height: 180 },
      },
      url: 'https://www.youtube.com/watch?v=99QhMQoxmOk',
      note: 'Cotovelos 45 graus — vídeo oficial Academia Teste',
    },
  });
  assert.equal(overrideRes.status, 200);
  assert.equal(overrideRes.body.override.exerciseId, '0025');
  assert.equal(overrideRes.body.override.media.hash, mp4Hash);

  // Cria exercício próprio tx_ na academia "teste" com imagem WebP
  const customRes = await h.reqJson('POST', '/api/gym/custom-exercises', {
    token: trTesteToken,
    body: {
      n: 'Supino Máquina Academia Teste',
      bp: 'chest',
      eq: 'leverage machine',
      cat: 'strength',
      media: {
        kind: 'image',
        hash: webpHash,
        mime: 'image/webp',
        size: webpBytes.length,
        width: 480,
        height: 360,
      },
      note: 'Ajustar banco no pino 3',
    },
  });
  assert.equal(customRes.status, 200);
  const customId = customRes.body.exercise.id;
  assert.ok(customId.startsWith('tx_'), `esperava prefixo tx_, veio ${customId}`);

  // Catálogo do Portal retorna o exercício próprio + override para prof_teste, e NADA para prof_gabriel
  const catSearch = await h.reqJson('GET', `/api/saas/catalogue?q=${encodeURIComponent('Supino Máquina Academia')}`, {
    token: trTesteToken,
  });
  assert.equal(catSearch.status, 200);
  assert.ok(catSearch.body.exercises.some(e => e.id === customId && e.tenantCustom === true));

  const catCustomOnly = await h.reqJson('GET', '/api/saas/catalogue?customOnly=1', { token: trTesteToken });
  assert.equal(catCustomOnly.status, 200);
  const customIds = catCustomOnly.body.exercises.map(e => e.id);
  assert.ok(customIds.includes(customId));
  assert.ok(customIds.includes('0025'));

  const catByIds = await h.reqJson('GET', `/api/saas/catalogue?ids=${customId},0025`, { token: trTesteToken });
  assert.equal(catByIds.status, 200);
  assert.equal(catByIds.body.exercises.find(e => e.id === '0025')?.hasCustomVideo, true);

  const catGabriel = await h.reqJson('GET', '/api/saas/catalogue?customOnly=1', { token: trGabrielToken });
  assert.equal(catGabriel.status, 200);
  assert.equal(catGabriel.body.exercises.length, 0);

  // Aluno de "teste" recebe overrides e tx_ mesmo se abrir ?tenant=gabrielleite
  const stExTeste = await h.reqJson('GET', '/api/tenant/exercises?tenant=gabrielleite', {
    cookie: testeCookie,
    headers: { 'X-Tenant-Id': 'gabrielleite' },
  });
  assert.equal(stExTeste.status, 200);
  assert.equal(stExTeste.body.tenant_id, 'teste');
  assert.equal(stExTeste.body.overrides['0025']?.media?.hash, mp4Hash);
  assert.equal(stExTeste.body.customExercises.length, 1);
  assert.equal(stExTeste.body.customExercises[0].id, customId);

  // Aluno de "gabrielleite" NÃO vê nada de "teste", mesmo tentando forçar ?tenant=teste
  const gabrielCookie = `gymsid=${mintSession('u_st_gabriel')}`;
  const stExGabriel = await h.reqJson('GET', '/api/tenant/exercises?tenant=teste', {
    cookie: gabrielCookie,
    headers: { 'X-Tenant-Id': 'teste' },
  });
  assert.equal(stExGabriel.status, 200);
  assert.equal(stExGabriel.body.tenant_id, 'gabrielleite');
  assert.deepEqual(stExGabriel.body.overrides, {});
  assert.deepEqual(stExGabriel.body.customExercises, []);

  // Aluno de "teste" baixa os arquivos via /api/media/{hash} com SHA-256 íntegro
  const dlVideo = await fetch(`${h.api}/api/media/${mp4Hash}`, { headers: { Cookie: testeCookie, Origin: ORIGIN } });
  assert.equal(dlVideo.status, 200);
  const dlVideoBuf = Buffer.from(await dlVideo.arrayBuffer());
  assert.equal(M.sha(dlVideoBuf), mp4Hash);

  const dlWebp = await fetch(`${h.api}/api/media/${webpHash}`, { headers: { Cookie: testeCookie, Origin: ORIGIN } });
  assert.equal(dlWebp.status, 200);
  const dlWebpBuf = Buffer.from(await dlWebp.arrayBuffer());
  assert.equal(M.sha(dlWebpBuf), webpHash);

  // Aluno de "gabrielleite" recebe 404 mesmo tentando spoofing ?tenant=teste e X-Tenant-Id: teste
  const crossDl = await fetch(`${h.api}/api/media/${mp4Hash}?tenant=teste`, {
    headers: { Cookie: gabrielCookie, Origin: ORIGIN, 'X-Tenant-Id': 'teste' },
  });
  assert.equal(crossDl.status, 404);

  // Restaurar padrão em 0025 remove override, preserva tx_ no estado de GC do tenant
  const delOv = await h.reqJson('DELETE', '/api/gym/exercise-media?exerciseId=0025', { token: trTesteToken });
  assert.equal(delOv.status, 200);
  assert.equal(delOv.body.deleted, true);

  const gcStateAfterDel = readTenantMediaState(dataDir, 'teste');
  const keptHashes = gcStateAfterDel.customEx.flatMap(ex => [ex.media?.hash, ex.media?.poster?.hash]).filter(Boolean);
  assert.ok(!keptHashes.includes(mp4Hash), 'hash do override removido não fica mais retido para GC');
  assert.ok(keptHashes.includes(webpHash), 'hash do exercício próprio tx_ continua protegido no GC');

  // Exclusão da academia pelo Super Admin apaga dados SQLite + pasta de mídia __tenant__teste
  const bucketDir = path.join(dataDir, 'uploads', tenantMediaBucket('teste'));
  assert.equal(fs.existsSync(bucketDir), true);

  const delTenant = await h.reqJson('DELETE', '/api/saas/admin/tenants', {
    cookie: superCookie,
    body: { id: 'teste' },
  });
  assert.equal(delTenant.status, 200);
  assert.equal(delTenant.body.ok, true);
  assert.equal(fs.existsSync(bucketDir), false, 'pasta de mídia do tenant deve ser removida');

  const payloadAfter = getTenantExercisesPayload(dataDir, 'teste');
  assert.deepEqual(payloadAfter.overrides, {});
  assert.deepEqual(payloadAfter.customExercises, []);
  clearTenantExercisesData(dataDir, 'teste');
});
