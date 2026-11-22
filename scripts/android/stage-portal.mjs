#!/usr/bin/env node
/**
 * Compila o Portal B2B (portal/) em modo embutido para o Capacitor e copia para <targetDistDir>/portal.
 * Uso: node scripts/android/stage-portal.mjs [targetDistDir] [--strict]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORTAL_DIR = path.join(ROOT, 'portal');
const EXCLUDED_TOP_LEVEL = new Set([
  'landing',
  'sw.js',
  'offline.html',
  'robots.txt',
  'sitemap.xml',
  'manifest.webmanifest'
]);

function progress(done, total, desc) {
  const pct = Math.round((done / total) * 100);
  const filled = Math.round((pct / 100) * 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  console.log(`[${bar}] ${pct}% (${done}/${total}) - ${desc}`);
}

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const targetArg = args.find(a => a !== '--strict');
const targetDist = targetArg
  ? path.resolve(process.cwd(), targetArg)
  : path.join(ROOT, 'frontend', 'dist');

const viteBin = path.join(PORTAL_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
const portalModules = path.join(PORTAL_DIR, 'node_modules');

progress(0, 4, 'Verificando dependências do Portal');

if (!fs.existsSync(portalModules) || !fs.existsSync(viteBin)) {
  const msg = 'portal/node_modules não encontrado. Rode `npm --prefix portal ci` antes de empacotar o app unificado.';
  if (strict) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.warn(`⚠ ${msg} Pulando etapa do portal (--strict não informado).`);
  process.exit(0);
}

const tempOut = path.join(PORTAL_DIR, '.dist-mobile');
const destPortal = path.join(targetDist, 'portal');
const apiBase = (process.env.VITE_PORTAL_API_BASE || 'https://painel.treinerit.com.br').trim();

try {
  progress(1, 4, 'Compilando Portal em modo mobile embutido');
  fs.rmSync(tempOut, { recursive: true, force: true });
  execFileSync(process.execPath, [viteBin, 'build', '--outDir', '.dist-mobile'], {
    cwd: PORTAL_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_MOBILE_EMBED: '1',
      VITE_PORTAL_API_BASE: apiBase
    }
  });

  progress(2, 4, 'Copiando build do Portal para dist/portal');
  fs.rmSync(destPortal, { recursive: true, force: true });
  fs.mkdirSync(destPortal, { recursive: true });

  for (const entry of fs.readdirSync(tempOut, { withFileTypes: true })) {
    if (EXCLUDED_TOP_LEVEL.has(entry.name)) continue;
    const srcPath = path.join(tempOut, entry.name);
    const dstPath = path.join(destPortal, entry.name);
    fs.cpSync(srcPath, dstPath, { recursive: true });
  }

  progress(3, 4, 'Validando bundle embutido do Portal');
  const indexHtmlPath = path.join(destPortal, 'index.html');
  if (!fs.existsSync(indexHtmlPath)) {
    throw new Error(`Arquivo ausente após stage: ${indexHtmlPath}`);
  }
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  if (/(?:src|href)="\/assets\//i.test(html)) {
    throw new Error('portal/index.html ainda referencia /assets/ absoluto (base: "./" não aplicado).');
  }

  progress(4, 4, 'Portal embutido pronto em dist/portal');
} finally {
  fs.rmSync(tempOut, { recursive: true, force: true });
}
