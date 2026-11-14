#!/usr/bin/env node
/**
 * api/create-superadmin.js
 *
 * Utilitário de Linha de Comando para Criar ou Redefinir o Super Administrador da Rit em Produção.
 *
 * Uso:
 *   node api/create-superadmin.js <email> <senha> [nome]
 *
 * Exemplo em Docker:
 *   docker compose exec api node create-superadmin.js "admin@rit.com.br" "SenhaSegura123!" "Diretoria Rit"
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getSqliteInstance, loadCoreDbFromSqlite, saveCoreDbToSqlite } from './sqlite.js';
import { hashPassword, normalizeEmail } from './password.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '../data');

const args = process.argv.slice(2);
const emailInput = args[0];
const passwordInput = args[1];
const nameInput = args[2] || 'Administrador Geral';

if (!emailInput || !passwordInput) {
  console.log(`
Uso:
  node create-superadmin.js <email> <senha> [nome]

Exemplo:
  node create-superadmin.js "admin@rit.com.br" "MinhaSenhaForte2026!" "Admin Geral"
`);
  process.exit(1);
}

const normEmail = normalizeEmail(emailInput);
if (!normEmail || !normEmail.includes('@')) {
  console.error('Erro: E-mail inválido.');
  process.exit(1);
}

if (passwordInput.length < 8) {
  console.error('Erro: A senha deve conter pelo menos 8 caracteres.');
  process.exit(1);
}

async function main() {
  getSqliteInstance(dataDir);
  const db = loadCoreDbFromSqlite(dataDir);
  db.users = Array.isArray(db.users) ? db.users : [];

  let user = db.users.find(u => (u.email && normalizeEmail(u.email) === normEmail) || u.saasRole === 'superadmin');
  const nowIso = new Date().toISOString();
  const hash = await hashPassword(passwordInput);

  if (user) {
    user.email = normEmail;
    user.name = nameInput || user.name || 'Administrador Geral';
    user.saasRole = 'superadmin';
    user.role = 'admin';
    user.admin = true;
    user.owner = true;
    user.disabled = false;
    user.pw = { h: hash, set: nowIso };
    user.sv = (user.sv || 0) + 1;
    console.log(`✔ Super Administrador existente atualizado com sucesso: ${normEmail}`);
  } else {
    user = {
      id: 'u_' + crypto.randomBytes(6).toString('hex'),
      name: nameInput,
      email: normEmail,
      saasRole: 'superadmin',
      role: 'admin',
      admin: true,
      owner: true,
      created: nowIso,
      pw: { h: hash, set: nowIso },
      sv: 1
    };
    db.users.push(user);
    console.log(`✔ Novo Super Administrador criado com sucesso: ${normEmail} (ID: ${user.id})`);
  }

  saveCoreDbToSqlite(dataDir, db);
  console.log(`✔ Dados gravados com sucesso no banco SQLite WAL em: ${dataDir}`);
  console.log(`⚠️ Se o serviço "api" estiver em execução, reinicie-o (ex.: docker compose restart api) para recarregar o usuário em memória.`);
  console.log(`Agora você pode fazer login no Portal Administrativo com este e-mail e senha.`);
}

main().catch(err => {
  console.error('Falha ao criar superadmin:', err.message);
  process.exit(1);
});
