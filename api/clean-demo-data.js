#!/usr/bin/env node
/**
 * api/clean-demo-data.js
 *
 * Utilitário para expurgar academias, alunos, treinos e dados fictícios de demonstração,
 * deixando o banco de dados da Rit 100% limpo para implantação em Produção na VPS.
 *
 * Uso:
 *   node api/clean-demo-data.js [--all]
 *
 * Opções:
 *   --all: Remove todos os tenants (mantém apenas o Super Administrador).
 *   (padrão): Remove apenas os tenants e usuários padrão da demo (ironpower, studiopulse, etc).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getSqliteInstance,
  loadCoreDbFromSqlite,
  saveCoreDbToSqlite,
  runInTransaction
} from './sqlite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '../data');

const removeAll = process.argv.includes('--all');

const KNOWN_DEMO_TENANTS = new Set([
  'ironpower',
  'studiopulse',
  'arenacross',
  'fitclub',
  'thiagopersonal'
]);

async function main() {
  console.log(`[Limpeza de Produção] Inspecionando banco de dados em: ${dataDir}`);
  const inst = getSqliteInstance(dataDir);
  const core = loadCoreDbFromSqlite(dataDir);

  const tableTenantIds = inst.stmts.getAllTenants.all().map(t => t.id);
  const kvRow = inst.stmts.getKv.get('saas_store');
  let saasStore = null;
  if (kvRow) {
    try { saasStore = JSON.parse(kvRow.value); } catch { /* ignore */ }
  }
  const kvTenantIds = saasStore?.tenants && typeof saasStore.tenants === 'object'
    ? Object.keys(saasStore.tenants)
    : [];
  const allTenantIds = [...new Set([...tableTenantIds, ...kvTenantIds])];
  const tenantIdsToRemove = new Set(allTenantIds.filter(tid => removeAll || KNOWN_DEMO_TENANTS.has(tid)));

  // Identifica usuários demo a serem removidos (sem afetar clientes reais quando sem --all)
  const usersToKeep = [];
  const removedUsers = [];

  for (const u of (core.users || [])) {
    const isSuperAdmin = u.saasRole === 'superadmin' || (u.admin && u.owner && !u.tenantId);
    const isDemoUser = Boolean(
      u.tenantId && (tenantIdsToRemove.has(u.tenantId) || KNOWN_DEMO_TENANTS.has(u.tenantId))
    );

    if (isSuperAdmin) {
      // Super admin é sempre preservado
      usersToKeep.push(u);
    } else if (removeAll || isDemoUser) {
      removedUsers.push(u);
    } else {
      usersToKeep.push(u);
    }
  }

  const removedUserIds = new Set(removedUsers.map(u => u.id));

  // Executa expurgo em transação atômica
  runInTransaction(inst, () => {
    // 1. Remove tenants da tabela tenants
    for (const tid of tenantIdsToRemove) {
      inst.stmts.deleteTenantRow.run(tid);
    }

    // 2. Remove fichas e históricos de treino dos alunos removidos
    for (const uid of removedUserIds) {
      inst.stmts.deleteState.run(uid);
      inst.stmts.deleteWatchBox.run(uid);
    }

    // 3. Atualiza saas_store no KV
    if (saasStore && saasStore.tenants) {
      for (const tid of tenantIdsToRemove) {
        delete saasStore.tenants[tid];
      }
      if (removeAll || Object.keys(saasStore.tenants).length === 0) {
        saasStore.seededAt = null;
      }
      inst.stmts.setKv.run('saas_store', JSON.stringify(saasStore), Date.now());
    }

    // 4. Limpa KV de branding e templates dos tenants removidos
    for (const tid of tenantIdsToRemove) {
      inst.stmts.deleteKv.run(`branding:${tid}`);
      inst.stmts.deleteKv.run(`templates:${tid}`);
    }
  });

  // Salva usuários, credenciais, push e convites atualizados no SQLite
  core.users = usersToKeep;
  core.creds = (core.creds || []).filter(c => !removedUserIds.has(c.userId));
  core.subs = (core.subs || []).filter(s => !removedUserIds.has(s.userId));
  core.invites = (core.invites || []).filter(inv => !tenantIdsToRemove.has(inv.tenantId));
  saveCoreDbToSqlite(dataDir, core);

  // Remove pastas em disco de tenants legados se existirem
  const tenantsDiskDir = path.join(dataDir, 'tenants');
  if (fs.existsSync(tenantsDiskDir)) {
    for (const tid of tenantIdsToRemove) {
      const p = path.join(tenantsDiskDir, tid);
      if (fs.existsSync(p)) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }

  console.log('\n======================================================');
  console.log('✅ BASE DE DADOS LIMPA COM SUCESSO PARA PRODUÇÃO!');
  console.log('======================================================');
  console.log(`• Tenants de demonstração removidos: ${tenantIdsToRemove.size}`);
  console.log(`• Usuários/Alunos de teste removidos: ${removedUsers.length}`);
  console.log(`• Usuários restantes no sistema:     ${usersToKeep.length}`);
  for (const u of usersToKeep) {
    console.log(`   - [${u.saasRole || u.role || 'aluno'}] ${u.name} (${u.email || u.id})`);
  }
  console.log('⚠️ Se o serviço "api" estiver em execução, reinicie-o (`docker compose restart api`) para recarregar o cache em memória.');
  console.log('======================================================\n');
}

main().catch(err => {
  console.error('[ERRO] Falha ao limpar dados de demonstração:', err);
  process.exit(1);
});

