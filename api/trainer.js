import crypto from 'node:crypto';
import { stampPut } from './sync-stamps.js';
import { excusedOn } from './nudge.js';
import { addWeighIn } from './weigh-ins.js';
import {
  getSqliteKv,
  setSqliteKv,
  extractTenantIdFromPath,
  readUserStateSqlite,
  writeUserStateSqlite,
  writeUserStateCasSqlite,
  updateUserStateAtomicSqlite,
  getSqliteInstance,
  runInTransaction,
  backfillRelationalTables
} from './sqlite.js';

export const TEMPLATES_FILE = 'templates.json';
export const TEMPLATE_SEED_VERSION = 2;

export const DEFAULT_GYM_TEMPLATES = [
  /* ---------- 1. Adaptação (Iniciante) ---------- */
  {
    id: 'tpl_adapt_fullbody',
    name: 'Adaptação Full Body (Iniciante 3x)',
    category: 'Adaptação',
    emoji: 'figureStrength',
    description: 'Treino de corpo inteiro para alunos nas primeiras 4 semanas (Seg/Qua/Sex).',
    suggestedDays: [1, 3, 5],
    ex: [
      { id: '0739', name: 'Leg Press 45° no Sled', sets: 3, reps: 12, weight: 40, restSec: 90, prog: 'double', note: 'Descer com controle sem tirar o quadril do banco' },
      { id: '0025', name: 'Supino Reto com Barra', sets: 3, reps: 12, weight: 20, restSec: 90, prog: 'double', note: 'Escápulas retraídas e pés firmes no chão' },
      { id: '0198', name: 'Puxada Frontal na Polia', sets: 3, reps: 12, weight: 30, restSec: 75, prog: 'double', note: 'Puxar até a parte superior do peito' },
      { id: '0586', name: 'Mesa Flexora Deitada (Máquina)', sets: 3, reps: 12, weight: 25, restSec: 75, prog: 'double', note: 'Evitar elevar o quadril do estofado' },
      { id: '0405', name: 'Desenvolvimento com Halteres Sentado', sets: 3, reps: 12, weight: 8, restSec: 75, prog: 'double', note: '' },
      { id: '0294', name: 'Rosca Bíceps com Halteres', sets: 2, reps: 12, weight: 6, restSec: 60, prog: 'double', note: '' },
      { id: '0201', name: 'Tríceps Pulley no Cabo', sets: 2, reps: 12, weight: 15, restSec: 60, prog: 'double', note: 'Cotovelos fixos ao lado do tronco' },
      { id: '0274', name: 'Abdominal Supra no Chão', sets: 3, reps: 15, weight: 0, restSec: 45, prog: 'double', note: '' }
    ]
  },
  {
    id: 'tpl_adapt_ab_a',
    name: 'Adaptação AB — Treino A (Superiores + Core)',
    category: 'Adaptação',
    emoji: 'arm',
    description: 'Protocolo de entrada 2x–4x/sem para adaptação de membros superiores e abdômen.',
    suggestedDays: [1, 4],
    ex: [
      { id: '0289', name: 'Supino Reto com Halteres', sets: 3, reps: 12, weight: 10, restSec: 75, prog: 'double', note: '' },
      { id: '0198', name: 'Puxada Frontal na Polia', sets: 3, reps: 12, weight: 30, restSec: 75, prog: 'double', note: '' },
      { id: '0861', name: 'Remada Baixa Sentada no Cabo', sets: 3, reps: 12, weight: 25, restSec: 75, prog: 'double', note: 'Fechar bem as escápulas' },
      { id: '0603', name: 'Desenvolvimento na Máquina', sets: 3, reps: 12, weight: 20, restSec: 75, prog: 'double', note: '' },
      { id: '0294', name: 'Rosca Bíceps com Halteres', sets: 2, reps: 12, weight: 6, restSec: 60, prog: 'double', note: '' },
      { id: '0200', name: 'Tríceps Corda na Polia', sets: 2, reps: 12, weight: 15, restSec: 60, prog: 'double', note: '' },
      { id: '0463', name: 'Prancha Frontal', sets: 3, reps: 30, weight: 0, restSec: 45, prog: 'double', note: 'Manter isometria por 30–40 segundos' }
    ]
  },
  {
    id: 'tpl_adapt_ab_b',
    name: 'Adaptação AB — Treino B (Inferiores + Panturrilha)',
    category: 'Adaptação',
    emoji: 'legs',
    description: 'Adaptação de membros inferiores com máquinas guiadas e amplitude segura.',
    suggestedDays: [2, 5],
    ex: [
      { id: '0739', name: 'Leg Press 45° no Sled', sets: 3, reps: 12, weight: 50, restSec: 90, prog: 'double', note: '' },
      { id: '0585', name: 'Cadeira Extensora (Máquina)', sets: 3, reps: 12, weight: 30, restSec: 75, prog: 'double', note: '' },
      { id: '0599', name: 'Cadeira Flexora (Máquina)', sets: 3, reps: 12, weight: 30, restSec: 75, prog: 'double', note: '' },
      { id: '0597', name: 'Cadeira Abdutora (Máquina)', sets: 3, reps: 15, weight: 30, restSec: 60, prog: 'double', note: '' },
      { id: '0598', name: 'Cadeira Adutora (Máquina)', sets: 3, reps: 15, weight: 30, restSec: 60, prog: 'double', note: '' },
      { id: '0594', name: 'Panturrilha Sentada na Máquina', sets: 3, reps: 15, weight: 20, restSec: 45, prog: 'double', note: '' },
      { id: '0274', name: 'Abdominal Supra no Chão', sets: 3, reps: 15, weight: 0, restSec: 45, prog: 'double', note: '' }
    ]
  },

  /* ---------- 2. Divisão AB (Upper / Lower — 4x/semana) ---------- */
  {
    id: 'tpl_ab_upper',
    name: 'AB Clássico — Treino A: Superiores (Upper)',
    category: 'Divisão AB',
    emoji: 'arm',
    description: 'Divisão Upper/Lower muito usada 4x/semana para força e hipertrofia equilibrada.',
    suggestedDays: [1, 4],
    ex: [
      { id: '0025', name: 'Supino Reto com Barra', sets: 4, reps: 8, weight: 40, restSec: 120, warmupSets: 1, prog: 'double', note: '' },
      { id: '0861', name: 'Remada Baixa Sentada no Cabo', sets: 4, reps: 10, weight: 45, restSec: 90, prog: 'double', note: '' },
      { id: '0314', name: 'Supino Inclinado com Halteres', sets: 3, reps: 10, weight: 18, restSec: 90, prog: 'double', note: '' },
      { id: '0198', name: 'Puxada Frontal na Polia', sets: 3, reps: 10, weight: 40, restSec: 90, prog: 'double', note: '' },
      { id: '0405', name: 'Desenvolvimento com Halteres Sentado', sets: 3, reps: 10, weight: 14, restSec: 75, prog: 'double', note: '' },
      { id: '0334', name: 'Elevação Lateral com Halteres', sets: 3, reps: 14, weight: 8, restSec: 60, prog: 'double', note: '' },
      { id: '0031', name: 'Rosca Direta com Barra', sets: 3, reps: 10, weight: 20, restSec: 60, prog: 'double', note: '' },
      { id: '0200', name: 'Tríceps Corda na Polia', sets: 3, reps: 12, weight: 20, restSec: 60, prog: 'double', note: '' }
    ]
  },
  {
    id: 'tpl_ab_lower',
    name: 'AB Clássico — Treino B: Inferiores (Lower)',
    category: 'Divisão AB',
    emoji: 'legs',
    description: 'Divisão Upper/Lower com foco em compostos de perna, posterior e core.',
    suggestedDays: [2, 5],
    ex: [
      { id: '0043', name: 'Agachamento Livre com Barra', sets: 4, reps: 8, weight: 50, restSec: 120, warmupSets: 2, prog: 'double', note: '' },
      { id: '0085', name: 'Levantamento Terra Romeno (Stiff) com Barra', sets: 4, reps: 10, weight: 45, restSec: 90, prog: 'double', note: '' },
      { id: '0739', name: 'Leg Press 45° no Sled', sets: 3, reps: 12, weight: 120, restSec: 90, prog: 'double', note: '' },
      { id: '0599', name: 'Cadeira Flexora (Máquina)', sets: 3, reps: 12, weight: 35, restSec: 75, prog: 'double', note: '' },
      { id: '0585', name: 'Cadeira Extensora (Máquina)', sets: 3, reps: 12, weight: 40, restSec: 75, prog: 'double', note: '' },
      { id: '0605', name: 'Panturrilha em Pé na Máquina', sets: 4, reps: 15, weight: 40, restSec: 60, prog: 'double', note: '' },
      { id: '1163', name: 'Elevação de Pernas Deitado (Abdominal Infra)', sets: 3, reps: 15, weight: 0, restSec: 45, prog: 'double', note: '' }
    ]
  },

  /* ---------- 3. Hipertrofia ABC (Push / Pull / Legs — 3x a 6x/semana) ---------- */
  {
    id: 'tpl_hipertrofia_a',
    name: 'ABC — Treino A: Peito, Ombros e Tríceps (Push)',
    category: 'Hipertrofia ABC',
    emoji: 'arm',
    description: 'Divisão Push clássica brasileira para hipertrofia de peitoral, deltoides e tríceps.',
    suggestedDays: [1, 4],
    ex: [
      { id: '0025', name: 'Supino Reto com Barra', sets: 4, reps: 8, repsMin: 8, repsMax: 10, weight: 40, restSec: 120, warmupSets: 1, prog: 'double', note: 'Progressão dupla: suba carga ao bater 4x10' },
      { id: '0314', name: 'Supino Inclinado com Halteres', sets: 3, reps: 10, weight: 18, restSec: 90, prog: 'double', note: 'Banco a 30 graus' },
      { id: '0188', name: 'Crucifixo no Crossover (Polia Média)', sets: 3, reps: 12, weight: 15, restSec: 75, prog: 'double', note: 'Pico de contração de 1s' },
      { id: '0405', name: 'Desenvolvimento com Halteres Sentado', sets: 3, reps: 10, weight: 14, restSec: 90, prog: 'double', note: '' },
      { id: '0334', name: 'Elevação Lateral com Halteres', sets: 4, reps: 14, weight: 8, restSec: 60, prog: 'double', note: 'Sem impulso de tronco' },
      { id: '0200', name: 'Tríceps Corda na Polia', sets: 3, reps: 12, weight: 20, restSec: 60, prog: 'double', note: 'Abrir a corda no final' },
      { id: '0060', name: 'Tríceps Testa com Barra', sets: 3, reps: 10, weight: 16, restSec: 60, prog: 'double', note: '' }
    ]
  },
  {
    id: 'tpl_hipertrofia_b',
    name: 'ABC — Treino B: Costas, Posterior e Bíceps (Pull)',
    category: 'Hipertrofia ABC',
    emoji: 'pullup',
    description: 'Divisão Pull para largura e espessura dorsal, deltoide posterior e bíceps.',
    suggestedDays: [2, 5],
    ex: [
      { id: '0198', name: 'Puxada Alta Aberta na Polia', sets: 4, reps: 10, weight: 45, restSec: 90, warmupSets: 1, prog: 'double', note: '' },
      { id: '0861', name: 'Remada Baixa Sentada no Cabo', sets: 4, reps: 10, weight: 45, restSec: 90, prog: 'double', note: 'Alongar bem na fase excêntrica' },
      { id: '0293', name: 'Remada Curvada com Halteres', sets: 3, reps: 12, weight: 18, restSec: 75, prog: 'double', note: '' },
      { id: '0203', name: 'Crucifixo Inverso na Polia com Corda', sets: 3, reps: 15, weight: 15, restSec: 60, prog: 'double', note: '' },
      { id: '0031', name: 'Rosca Direta com Barra', sets: 3, reps: 10, weight: 20, restSec: 75, prog: 'double', note: '' },
      { id: '0313', name: 'Rosca Martelo com Halteres', sets: 3, reps: 12, weight: 10, restSec: 60, prog: 'double', note: '' }
    ]
  },
  {
    id: 'tpl_hipertrofia_c',
    name: 'ABC — Treino C: Pernas Completo & Glúteos (Legs)',
    category: 'Hipertrofia ABC',
    emoji: 'legs',
    description: 'Ênfase em quadríceps, posteriores de coxa, glúteos e panturrilhas.',
    suggestedDays: [3, 6],
    ex: [
      { id: '0043', name: 'Agachamento Livre com Barra', sets: 4, reps: 8, weight: 50, restSec: 120, warmupSets: 2, prog: 'double', note: 'Amplitude completa mantendo coluna neutra' },
      { id: '0739', name: 'Leg Press 45° no Sled', sets: 4, reps: 10, weight: 120, restSec: 120, prog: 'double', note: '' },
      { id: '0085', name: 'Stiff / Terra Romeno com Barra', sets: 4, reps: 10, weight: 45, restSec: 90, prog: 'double', note: 'Sentir alongamento de posteriores' },
      { id: '0585', name: 'Cadeira Extensora (Máquina)', sets: 3, reps: 12, weight: 40, restSec: 75, prog: 'double', note: '' },
      { id: '0586', name: 'Mesa Flexora Deitada (Máquina)', sets: 3, reps: 12, weight: 35, restSec: 75, prog: 'double', note: '' },
      { id: '1060', name: 'Elevação Pélvica com Barra (Hip Thrust)', sets: 3, reps: 12, weight: 50, restSec: 90, prog: 'double', note: 'Pausa de 1s no topo' },
      { id: '0605', name: 'Panturrilha em Pé na Máquina', sets: 4, reps: 15, weight: 40, restSec: 60, prog: 'double', note: '' }
    ]
  },

  /* ---------- 4. Feminino ABC (2 dias Inferiores + 1 Superiores) ---------- */
  {
    id: 'tpl_fem_abc_a',
    name: 'Feminino A — Quadríceps & Adutores',
    category: 'Feminino ABC',
    emoji: 'legs',
    description: 'Ficha clássica feminina focada na parte anterior da coxa e parte interna.',
    suggestedDays: [1, 4],
    ex: [
      { id: '0770', name: 'Agachamento na Máquina Smith', sets: 4, reps: 10, weight: 40, restSec: 90, warmupSets: 1, prog: 'double', note: 'Manter calcanhares apoiados e joelhos alinhados' },
      { id: '0739', name: 'Leg Press 45° no Sled', sets: 4, reps: 12, weight: 100, restSec: 90, prog: 'double', note: 'Pés mais baixos na plataforma para enfatizar quadríceps' },
      { id: '0585', name: 'Cadeira Extensora (Máquina)', sets: 4, reps: 12, weight: 35, restSec: 75, prog: 'double', note: 'Segurar 1s no topo da extensão' },
      { id: '0410', name: 'Agachamento Búlgaro com Halter', sets: 3, reps: 10, weight: 10, restSec: 75, prog: 'double', note: 'Tronco levemente ereto' },
      { id: '0598', name: 'Cadeira Adutora (Máquina)', sets: 3, reps: 15, weight: 35, restSec: 60, prog: 'double', note: '' },
      { id: '0605', name: 'Panturrilha em Pé na Máquina', sets: 4, reps: 15, weight: 35, restSec: 45, prog: 'double', note: '' }
    ]
  },
  {
    id: 'tpl_fem_abc_b',
    name: 'Feminino B — Superiores Completo & Abdômen',
    category: 'Feminino ABC',
    emoji: 'arm',
    description: 'Tônus e definição de costas, ombros, braços e core sem volume excessivo.',
    suggestedDays: [2, 5],
    ex: [
      { id: '0198', name: 'Puxada Frontal na Polia', sets: 3, reps: 12, weight: 30, restSec: 75, prog: 'double', note: '' },
      { id: '0861', name: 'Remada Baixa Sentada no Cabo', sets: 3, reps: 12, weight: 30, restSec: 75, prog: 'double', note: '' },
      { id: '0314', name: 'Supino Inclinado com Halteres', sets: 3, reps: 12, weight: 10, restSec: 75, prog: 'double', note: '' },
      { id: '0334', name: 'Elevação Lateral com Halteres', sets: 3, reps: 14, weight: 5, restSec: 60, prog: 'double', note: '' },
      { id: '0200', name: 'Tríceps Corda na Polia', sets: 3, reps: 12, weight: 15, restSec: 60, prog: 'double', note: '' },
      { id: '0294', name: 'Rosca Bíceps com Halteres', sets: 3, reps: 12, weight: 6, restSec: 60, prog: 'double', note: '' },
      { id: '0463', name: 'Prancha Frontal', sets: 3, reps: 40, weight: 0, restSec: 45, prog: 'double', note: 'Abdômen bem contraído por 40s' }
    ]
  },
  {
    id: 'tpl_fem_abc_c',
    name: 'Feminino C — Glúteos & Posteriores',
    category: 'Feminino ABC',
    emoji: 'flame',
    description: 'Ênfase em glúteo máximo/médio e isquiotibiais com máxima ativação.',
    suggestedDays: [3, 6],
    ex: [
      { id: '1060', name: 'Elevação Pélvica com Barra (Hip Thrust)', sets: 4, reps: 10, weight: 60, restSec: 90, warmupSets: 1, prog: 'double', note: 'Pico de contração de 2s no alto' },
      { id: '1543', name: 'Stiff com Barra', sets: 4, reps: 10, weight: 40, restSec: 90, prog: 'double', note: 'Coluna alinhada, descer deslizando a barra na coxa' },
      { id: '0599', name: 'Cadeira Flexora (Máquina)', sets: 3, reps: 12, weight: 35, restSec: 75, prog: 'double', note: '' },
      { id: '4421', name: 'Coice de Glúteo no Cabo', sets: 3, reps: 12, weight: 15, restSec: 60, prog: 'double', note: 'Evitar hiperextensão lombar' },
      { id: '0597', name: 'Cadeira Abdutora (Máquina)', sets: 4, reps: 15, weight: 40, restSec: 60, prog: 'double', note: '' },
      { id: '0594', name: 'Panturrilha Sentada na Máquina', sets: 3, reps: 15, weight: 25, restSec: 45, prog: 'double', note: '' }
    ]
  },

  /* ---------- 5. Divisão ABCD (Intermediário 4x/semana) ---------- */
  {
    id: 'tpl_abcd_a',
    name: 'ABCD — Treino A: Peito & Abdômen',
    category: 'Divisão ABCD',
    emoji: 'barbell',
    description: 'Divisão intermediária 4x/semana com foco total em peitoral e core.',
    suggestedDays: [1],
    ex: [
      { id: '0025', name: 'Supino Reto com Barra', sets: 4, reps: 8, weight: 45, restSec: 120, warmupSets: 1, prog: 'double', note: '' },
      { id: '0314', name: 'Supino Inclinado com Halteres', sets: 4, reps: 10, weight: 20, restSec: 90, prog: 'double', note: '' },
      { id: '1030', name: 'Crucifixo Peck Deck na Máquina', sets: 3, reps: 12, weight: 40, restSec: 75, prog: 'double', note: '' },
      { id: '0188', name: 'Crucifixo no Crossover (Polia Média)', sets: 3, reps: 12, weight: 15, restSec: 75, prog: 'double', note: '' },
      { id: '0001', name: 'Abdominal Supra (3/4)', sets: 4, reps: 18, weight: 0, restSec: 45, prog: 'double', note: '' },
      { id: '1163', name: 'Elevação de Pernas Deitado (Infra)', sets: 3, reps: 15, weight: 0, restSec: 45, prog: 'double', note: '' }
    ]
  },
  {
    id: 'tpl_abcd_b',
    name: 'ABCD — Treino B: Costas & Trapézio',
    category: 'Divisão ABCD',
    emoji: 'pullup',
    description: 'Volume dedicado a dorsais, romboides, trapézio e lombar.',
    suggestedDays: [2],
    ex: [
      { id: '0652', name: 'Barra Fixa (ou Graviton)', sets: 4, reps: 8, weight: 0, restSec: 90, prog: 'double', note: '' },
      { id: '0027', name: 'Remada Curvada com Barra', sets: 4, reps: 10, weight: 40, restSec: 90, prog: 'double', note: '' },
      { id: '0198', name: 'Puxada Frontal na Polia', sets: 3, reps: 10, weight: 45, restSec: 75, prog: 'double', note: '' },
      { id: '0861', name: 'Remada Baixa Sentada no Cabo', sets: 3, reps: 12, weight: 45, restSec: 75, prog: 'double', note: '' },
      { id: '0095', name: 'Encolhimento de Ombros com Barra (Trapézio)', sets: 4, reps: 12, weight: 50, restSec: 60, prog: 'double', note: '' },
      { id: '0203', name: 'Crucifixo Inverso na Polia com Corda', sets: 3, reps: 15, weight: 15, restSec: 60, prog: 'double', note: '' }
    ]
  },
  {
    id: 'tpl_abcd_c',
    name: 'ABCD — Treino C: Pernas Completo & Panturrilha',
    category: 'Divisão ABCD',
    emoji: 'legs',
    description: 'Treino completo de membros inferiores com recuperação ampla na semana.',
    suggestedDays: [4],
    ex: [
      { id: '0043', name: 'Agachamento Livre com Barra', sets: 4, reps: 8, weight: 60, restSec: 120, warmupSets: 2, prog: 'double', note: '' },
      { id: '0739', name: 'Leg Press 45° no Sled', sets: 4, reps: 10, weight: 140, restSec: 105, prog: 'double', note: '' },
      { id: '0585', name: 'Cadeira Extensora (Máquina)', sets: 3, reps: 12, weight: 45, restSec: 75, prog: 'double', note: '' },
      { id: '0085', name: 'Stiff / Terra Romeno com Barra', sets: 4, reps: 10, weight: 50, restSec: 90, prog: 'double', note: '' },
      { id: '0586', name: 'Mesa Flexora Deitada (Máquina)', sets: 3, reps: 12, weight: 35, restSec: 75, prog: 'double', note: '' },
      { id: '0605', name: 'Panturrilha em Pé na Máquina', sets: 4, reps: 15, weight: 45, restSec: 60, prog: 'double', note: '' }
    ]
  },
  {
    id: 'tpl_abcd_d',
    name: 'ABCD — Treino D: Ombros, Bíceps & Tríceps',
    category: 'Divisão ABCD',
    emoji: 'dumbbell',
    description: 'Fechamento da semana com foco em deltoides completos e braços.',
    suggestedDays: [5],
    ex: [
      { id: '0405', name: 'Desenvolvimento com Halteres Sentado', sets: 4, reps: 10, weight: 16, restSec: 90, prog: 'double', note: '' },
      { id: '0334', name: 'Elevação Lateral com Halteres', sets: 4, reps: 14, weight: 9, restSec: 60, prog: 'double', note: '' },
      { id: '0310', name: 'Elevação Frontal com Halteres', sets: 3, reps: 12, weight: 8, restSec: 60, prog: 'double', note: '' },
      { id: '0447', name: 'Rosca Direta com Barra W (EZ)', sets: 3, reps: 10, weight: 20, restSec: 75, prog: 'double', note: '' },
      { id: '0313', name: 'Rosca Martelo com Halteres', sets: 3, reps: 12, weight: 12, restSec: 60, prog: 'double', note: '' },
      { id: '0200', name: 'Tríceps Corda na Polia', sets: 3, reps: 12, weight: 25, restSec: 60, prog: 'double', note: '' },
      { id: '0060', name: 'Tríceps Testa com Barra', sets: 3, reps: 10, weight: 20, restSec: 75, prog: 'double', note: '' }
    ]
  },

  /* ---------- 6. ABCDE Avançado (Bodybuilding 5x/semana) ---------- */
  {
    id: 'tpl_abcde_a',
    name: 'ABCDE — A: Peito Completo',
    category: 'ABCDE Avançado',
    emoji: 'barbell',
    description: 'Clássico 5x/semana (Seg: Peito) trabalhando todas as porções do peitoral.',
    suggestedDays: [1],
    ex: [
      { id: '0025', name: 'Supino Reto com Barra', sets: 4, reps: 8, weight: 50, restSec: 120, warmupSets: 1, prog: 'double', note: '' },
      { id: '0047', name: 'Supino Inclinado com Barra', sets: 4, reps: 10, weight: 40, restSec: 90, prog: 'double', note: '' },
      { id: '0301', name: 'Supino Declinado com Halteres', sets: 3, reps: 10, weight: 20, restSec: 90, prog: 'double', note: '' },
      { id: '1030', name: 'Crucifixo Peck Deck na Máquina', sets: 3, reps: 12, weight: 45, restSec: 75, prog: 'double', note: '' },
      { id: '1270', name: 'Crossover para Peitoral Superior no Cabo', sets: 3, reps: 14, weight: 15, restSec: 60, prog: 'double', note: '' }
    ]
  },
  {
    id: 'tpl_abcde_b',
    name: 'ABCDE — B: Costas & Dorsal',
    category: 'ABCDE Avançado',
    emoji: 'pullup',
    description: 'Clássico 5x/semana (Ter: Costas) com alto volume de puxadas e remadas.',
    suggestedDays: [2],
    ex: [
      { id: '0652', name: 'Barra Fixa', sets: 4, reps: 8, weight: 0, restSec: 90, prog: 'double', note: '' },
      { id: '0027', name: 'Remada Curvada com Barra', sets: 4, reps: 10, weight: 45, restSec: 90, prog: 'double', note: '' },
      { id: '0606', name: 'Remada Cavalinho na Máquina', sets: 4, reps: 10, weight: 40, restSec: 90, prog: 'double', note: '' },
      { id: '0198', name: 'Puxada Frontal na Polia', sets: 3, reps: 12, weight: 45, restSec: 75, prog: 'double', note: '' },
      { id: '0861', name: 'Remada Baixa Sentada no Cabo', sets: 3, reps: 12, weight: 45, restSec: 75, prog: 'double', note: '' },
      { id: '0375', name: 'Pullover com Halter', sets: 3, reps: 12, weight: 18, restSec: 60, prog: 'double', note: '' }
    ]
  },
  {
    id: 'tpl_abcde_c',
    name: 'ABCDE — C: Pernas & Panturrilhas',
    category: 'ABCDE Avançado',
    emoji: 'legs',
    description: 'Clássico 5x/semana (Qua: Pernas) com estímulo máximo de coxas e panturrilhas.',
    suggestedDays: [3],
    ex: [
      { id: '0043', name: 'Agachamento Livre com Barra', sets: 4, reps: 8, weight: 70, restSec: 120, warmupSets: 2, prog: 'double', note: '' },
      { id: '0739', name: 'Leg Press 45° no Sled', sets: 4, reps: 10, weight: 160, restSec: 120, prog: 'double', note: '' },
      { id: '0743', name: 'Hack Squat no Sled', sets: 3, reps: 10, weight: 60, restSec: 90, prog: 'double', note: '' },
      { id: '0585', name: 'Cadeira Extensora (Máquina)', sets: 4, reps: 12, weight: 50, restSec: 75, prog: 'double', note: '' },
      { id: '0085', name: 'Stiff / Terra Romeno com Barra', sets: 4, reps: 10, weight: 55, restSec: 90, prog: 'double', note: '' },
      { id: '0599', name: 'Cadeira Flexora (Máquina)', sets: 3, reps: 12, weight: 40, restSec: 75, prog: 'double', note: '' },
      { id: '0605', name: 'Panturrilha em Pé na Máquina', sets: 4, reps: 15, weight: 50, restSec: 60, prog: 'double', note: '' },
      { id: '0594', name: 'Panturrilha Sentada na Máquina', sets: 3, reps: 15, weight: 30, restSec: 45, prog: 'double', note: '' }
    ]
  },
  {
    id: 'tpl_abcde_d',
    name: 'ABCDE — D: Ombros & Abdômen',
    category: 'ABCDE Avançado',
    emoji: 'dumbbell',
    description: 'Clássico 5x/semana (Qui: Ombros) nas 3 cabeças do deltoide + core completo.',
    suggestedDays: [4],
    ex: [
      { id: '0091', name: 'Desenvolvimento Sentado com Barra', sets: 4, reps: 8, weight: 30, restSec: 90, prog: 'double', note: '' },
      { id: '0405', name: 'Desenvolvimento com Halteres Sentado', sets: 3, reps: 10, weight: 16, restSec: 90, prog: 'double', note: '' },
      { id: '0334', name: 'Elevação Lateral com Halteres', sets: 4, reps: 14, weight: 10, restSec: 60, prog: 'double', note: '' },
      { id: '0178', name: 'Elevação Lateral na Polia (Unilateral)', sets: 3, reps: 15, weight: 8, restSec: 60, prog: 'double', note: '' },
      { id: '0602', name: 'Crucifixo Invertido Sentado na Máquina', sets: 4, reps: 14, weight: 30, restSec: 60, prog: 'double', note: '' },
      { id: '0857', name: 'Abdominal com Roda Abdominal', sets: 3, reps: 12, weight: 0, restSec: 60, prog: 'double', note: '' },
      { id: '0635', name: 'Abdominal Oblíquo no Chão', sets: 3, reps: 20, weight: 0, restSec: 45, prog: 'double', note: '' }
    ]
  },
  {
    id: 'tpl_abcde_e',
    name: 'ABCDE — E: Braços (Bíceps, Tríceps & Antebraço)',
    category: 'ABCDE Avançado',
    emoji: 'arm',
    description: 'Clássico 5x/semana (Sex: Braços) com volume isolado para bíceps, tríceps e antebraço.',
    suggestedDays: [5],
    ex: [
      { id: '0031', name: 'Rosca Direta com Barra', sets: 4, reps: 10, weight: 25, restSec: 75, prog: 'double', note: '' },
      { id: '0070', name: 'Rosca Scott com Barra', sets: 3, reps: 10, weight: 20, restSec: 75, prog: 'double', note: '' },
      { id: '0285', name: 'Rosca Alternada com Halteres', sets: 3, reps: 12, weight: 12, restSec: 60, prog: 'double', note: '' },
      { id: '0313', name: 'Rosca Martelo com Halteres', sets: 3, reps: 12, weight: 12, restSec: 60, prog: 'double', note: '' },
      { id: '0201', name: 'Tríceps Pulley no Cabo', sets: 4, reps: 10, weight: 30, restSec: 75, prog: 'double', note: '' },
      { id: '0060', name: 'Tríceps Testa Deitado com Barra', sets: 3, reps: 10, weight: 20, restSec: 75, prog: 'double', note: '' },
      { id: '1749', name: 'Tríceps Francês em Pé com Barra EZ', sets: 3, reps: 12, weight: 18, restSec: 60, prog: 'double', note: '' },
      { id: '0126', name: 'Rosca de Punho com Barra (Antebraço)', sets: 3, reps: 15, weight: 15, restSec: 45, prog: 'double', note: '' }
    ]
  },

  /* ---------- 7. Emagrecimento & Cardio ---------- */
  {
    id: 'tpl_emagrec_circuito',
    name: 'Emagrecimento — Circuito Metabólico Full Body',
    category: 'Emagrecimento & Cardio',
    emoji: 'flame',
    description: 'Alta densidade metabólica alternando grandes grupamentos e gasto calórico.',
    suggestedDays: [1, 3, 5],
    ex: [
      { id: '3593', name: 'Agachamento com Barra', sets: 3, reps: 15, weight: 30, restSec: 45, prog: 'double', note: 'Cadência controlada e transição rápida' },
      { id: '0662', name: 'Flexão de Braços', sets: 3, reps: 12, weight: 0, restSec: 45, prog: 'double', note: '' },
      { id: '0861', name: 'Remada Baixa Sentada no Cabo', sets: 3, reps: 15, weight: 35, restSec: 45, prog: 'double', note: '' },
      { id: '0054', name: 'Afundo com Barra (ou Halteres)', sets: 3, reps: 12, weight: 20, restSec: 45, prog: 'double', note: '' },
      { id: '0405', name: 'Desenvolvimento com Halteres Sentado', sets: 3, reps: 15, weight: 10, restSec: 45, prog: 'double', note: '' },
      { id: '1160', name: 'Burpee', sets: 3, reps: 12, weight: 0, restSec: 45, prog: 'double', note: '' },
      { id: '0463', name: 'Prancha Frontal', sets: 3, reps: 40, weight: 0, restSec: 45, prog: 'double', note: '' }
    ]
  },
  {
    id: 'tpl_hiit_cardio',
    name: 'Condicionamento Cardio + Core (HIIT)',
    category: 'Emagrecimento & Cardio',
    emoji: 'heart',
    description: 'Sessão para dias de cardio ativo, queima calórica e fortalecimento abdominal.',
    suggestedDays: [2, 4, 6],
    ex: [
      { id: '3666', name: 'Caminhada em Esteira Inclinada', sets: 1, reps: 15, weight: 0, restSec: 60, prog: 'double', note: '15 min aquecimento / zona aeróbia' },
      { id: '2138', name: 'Bicicleta Ergométrica (Tiros HIIT)', sets: 6, reps: 1, weight: 0, restSec: 60, prog: 'double', note: '30s forte / 60s leve por 6 rounds' },
      { id: '3224', name: 'Polichinelo com Salto', sets: 3, reps: 30, weight: 0, restSec: 30, prog: 'double', note: '' },
      { id: '0001', name: 'Abdominal Supra (3/4)', sets: 3, reps: 20, weight: 0, restSec: 45, prog: 'double', note: '' },
      { id: '0635', name: 'Abdominal Oblíquo no Chão', sets: 3, reps: 20, weight: 0, restSec: 45, prog: 'double', note: '' },
      { id: '0463', name: 'Prancha Frontal', sets: 3, reps: 45, weight: 0, restSec: 45, prog: 'double', note: '' }
    ]
  }
];

/**
 * Verifica se o usuário tem privilégio de treinador/professor, gestor de academia, superadmin ou admin.
 */
export function isTrainerOrAdmin(user) {
  if (!user) return false;
  return (
    user.admin === true ||
    user.owner === true ||
    user.role === 'trainer' ||
    user.saasRole === 'trainer' ||
    user.saasRole === 'gym_owner' ||
    user.saasRole === 'gym_manager' ||
    user.saasRole === 'superadmin'
  );
}

export function isGymManagerOrOwner(user) {
  if (!user) return false;
  return (
    user.admin === true ||
    user.owner === true ||
    user.saasRole === 'gym_owner' ||
    user.saasRole === 'gym_manager' ||
    user.saasRole === 'superadmin'
  );
}

export function fixLegacyTemplateSlots(templates) {
  let changed = false;
  const list = templates.map(tpl => {
    if (!Array.isArray(tpl?.ex)) return tpl;
    let exChanged = false;
    const nextEx = tpl.ex.map(slot => {
      if (slot && slot.id === '0575' && /leg\s*press/i.test(String(slot.name || ''))) {
        exChanged = true;
        return { ...slot, id: '0739', name: slot.name || 'Leg Press 45° no Sled' };
      }
      return slot;
    });
    if (exChanged) {
      changed = true;
      return { ...tpl, ex: nextEx };
    }
    return tpl;
  });
  return { list, changed };
}

function mergeDefaultTemplates(existing = []) {
  const { list, changed: fixedSlots } = fixLegacyTemplateSlots(Array.isArray(existing) ? existing : []);
  const seen = new Set(list.map(t => t.id));
  const now = Date.now();
  let added = 0;
  for (const def of DEFAULT_GYM_TEMPLATES) {
    if (seen.has(def.id)) continue;
    list.push({ ...structuredClone(def), createdAt: now, updatedAt: now });
    seen.add(def.id);
    added++;
  }
  return { templates: list, added, fixed: fixedSlots, changed: added > 0 || fixedSlots };
}

const DEFAULT_TEMPLATE_ID_SET = new Set(DEFAULT_GYM_TEMPLATES.map(t => t.id));

function syncTemplatesKvMirrorInTx(inst, slug) {
  const rows = inst.stmts.getTenantTemplates.all(slug);
  const list = rows.map(r => JSON.parse(r.data));
  inst.stmts.setKv.run(`templates:${slug}`, JSON.stringify(list), Date.now());
  return list;
}

function importDefaultTemplatesInTx(inst, slug) {
  const now = Date.now();
  const rows = inst.stmts.getTenantTemplates.all(slug);
  const currentList = rows.map(r => JSON.parse(r.data));
  const { list: fixedList, changed: fixedSlots } = fixLegacyTemplateSlots(currentList);

  if (fixedSlots) {
    fixedList.forEach((tpl, idx) => {
      const defKey = tpl.defaultKey || (DEFAULT_TEMPLATE_ID_SET.has(tpl.id) ? tpl.id : null);
      inst.stmts.upsertTemplateRow.run(
        slug,
        String(tpl.id),
        defKey,
        idx,
        JSON.stringify({ ...tpl, updatedAt: now }),
        Number(tpl.createdAt || now),
        now
      );
    });
  }

  let added = 0;
  let sortBase = fixedList.length;
  for (const def of DEFAULT_GYM_TEMPLATES) {
    const rec = { ...structuredClone(def), defaultKey: def.id, createdAt: now, updatedAt: now };
    const ins = inst.stmts.insertTemplateIgnore.run(
      slug,
      def.id,
      def.id,
      sortBase + added,
      JSON.stringify(rec),
      now,
      now
    );
    if (ins.changes === 1) added++;
  }

  inst.stmts.setKv.run(`templates_seed_v:${slug}`, JSON.stringify(TEMPLATE_SEED_VERSION), now);
  const templates = syncTemplatesKvMirrorInTx(inst, slug);
  return { added, fixed: fixedSlots, total: templates.length, templates };
}

/**
 * Lê os templates da academia na tabela relacional `gym_templates` do SQLite.
 */
export function loadTemplates(tenantDir, { seedIfMissing = false } = {}) {
  const slug = extractTenantIdFromPath(tenantDir);
  const inst = getSqliteInstance(tenantDir);
  backfillRelationalTables(inst);

  const seedVerKey = `templates_seed_v:${slug}`;
  const rows = inst.stmts.getTenantTemplates.all(slug);
  if (rows.length > 0) {
    const seedVer = Number(getSqliteKv(tenantDir, seedVerKey, 1));
    if (seedIfMissing && seedVer < TEMPLATE_SEED_VERSION) {
      return runInTransaction(inst, () => importDefaultTemplatesInTx(inst, slug)).templates;
    }
    return rows.map(r => JSON.parse(r.data));
  }

  // Se o gestor excluiu explicitamente todos os templates após já ter sido semeado, não recria
  const seedVer = Number(getSqliteKv(tenantDir, seedVerKey, 0));
  if (seedIfMissing) {
    return runInTransaction(inst, () => {
      const recheck = inst.stmts.getTenantTemplates.all(slug);
      if (recheck.length > 0 || seedVer >= TEMPLATE_SEED_VERSION) {
        return recheck.map(r => JSON.parse(r.data));
      }
      return importDefaultTemplatesInTx(inst, slug).templates;
    });
  }
  return [];
}

/**
 * Importa/restaura os modelos padrão da Rit na academia atomicamente sem apagar os existentes
 * e sem duplicar caso 2 cliques/requisições rodem no mesmo milissegundo (`INSERT OR IGNORE`).
 */
export function importDefaultTemplates(tenantDir) {
  const slug = extractTenantIdFromPath(tenantDir);
  const inst = getSqliteInstance(tenantDir);
  backfillRelationalTables(inst);
  return runInTransaction(inst, () => importDefaultTemplatesInTx(inst, slug));
}

/**
 * Salva a lista de templates da academia no SQLite (`gym_templates` + espelho KV).
 */
export function saveTemplates(tenantDir, templates) {
  const slug = extractTenantIdFromPath(tenantDir);
  const inst = getSqliteInstance(tenantDir);
  const list = Array.isArray(templates) ? templates : [];
  const now = Date.now();
  return runInTransaction(inst, () => {
    inst.stmts.clearTenantTemplates.run(slug);
    list.forEach((tpl, idx) => {
      if (!tpl || !tpl.id) return;
      const id = String(tpl.id);
      const defKey = tpl.defaultKey || (DEFAULT_TEMPLATE_ID_SET.has(id) ? id : null);
      inst.stmts.upsertTemplateRow.run(
        slug,
        id,
        defKey,
        idx,
        JSON.stringify(tpl),
        Number(tpl.createdAt || now),
        Number(tpl.updatedAt || now)
      );
    });
    syncTemplatesKvMirrorInTx(inst, slug);
    return list;
  });
}

/**
 * Salva ou atualiza um template individual atomicamente dentro de `BEGIN IMMEDIATE`.
 */
export function upsertTemplate(tenantDir, template) {
  const slug = extractTenantIdFromPath(tenantDir);
  const inst = getSqliteInstance(tenantDir);
  backfillRelationalTables(inst);
  const ex = Array.isArray(template.ex) ? template.ex.map(normalizeExerciseSlot) : [];
  return runInTransaction(inst, () => {
    const now = Date.now();
    const id = String(template.id || 'tpl_' + crypto.randomBytes(6).toString('hex'));
    const currentRows = inst.stmts.getTenantTemplates.all(slug);
    const existingRow = currentRows.find(r => r.id === id);
    const prev = existingRow ? JSON.parse(existingRow.data) : null;
    const record = {
      ...(prev || {}),
      ...template,
      id,
      name: String(template.name || prev?.name || 'Modelo de Treino').trim(),
      category: String(template.category || prev?.category || 'Geral').trim(),
      emoji: String(template.emoji || template.glyph || prev?.emoji || 'figureStrength'),
      description: String(template.description ?? prev?.description ?? '').trim(),
      suggestedDays: Array.isArray(template.suggestedDays) ? template.suggestedDays.map(Number).filter(d => d >= 0 && d <= 6) : (prev?.suggestedDays || []),
      ex,
      updatedAt: now,
      createdAt: prev?.createdAt || template.createdAt || now
    };
    const defKey = record.defaultKey || existingRow?.default_key || (DEFAULT_TEMPLATE_ID_SET.has(id) ? id : null);
    const sortOrder = existingRow ? Number(existingRow.sort_order) : currentRows.length;
    inst.stmts.upsertTemplateRow.run(
      slug,
      id,
      defKey,
      sortOrder,
      JSON.stringify(record),
      Number(record.createdAt || now),
      now
    );
    syncTemplatesKvMirrorInTx(inst, slug);
    return record;
  });
}

/**
 * Remove um template por ID atomicamente no SQLite.
 */
export function removeTemplate(tenantDir, templateId) {
  const slug = extractTenantIdFromPath(tenantDir);
  const inst = getSqliteInstance(tenantDir);
  backfillRelationalTables(inst);
  return runInTransaction(inst, () => {
    inst.stmts.deleteTemplateRow.run(slug, String(templateId));
    syncTemplatesKvMirrorInTx(inst, slug);
    return true;
  });
}

/**
 * Normaliza um exercício de rotina para o formato exato esperado pelo app `Rit`.
 */
export function normalizeExerciseSlot(raw = {}) {
  const sets = Math.max(1, Math.min(20, Number(raw.sets) || 3));
  const reps = Math.max(1, Math.min(200, Number(raw.reps) || 10));
  const out = {
    id: String(raw.id || '0025').trim(),
    sets,
    reps,
    weight: Math.max(0, Number(raw.weight) || 0),
    restSec: raw.restSec !== undefined ? Math.max(0, Math.min(600, Number(raw.restSec) || 90)) : 90,
    prog: ['double', 'linear', 'triple', 'none'].includes(raw.prog) ? raw.prog : 'double'
  };
  if (raw.name) out.name = String(raw.name).trim();
  if (raw.repsMin !== undefined && Number(raw.repsMin) > 0) out.repsMin = Number(raw.repsMin);
  if (raw.repsMax !== undefined && Number(raw.repsMax) > 0) out.repsMax = Number(raw.repsMax);
  if (raw.warmupSets !== undefined && Number(raw.warmupSets) > 0) out.warmupSets = Math.min(5, Number(raw.warmupSets));
  if (raw.note) out.note = String(raw.note).slice(0, 300);
  if (raw.sg !== undefined && raw.sg !== null && raw.sg !== '') out.sg = raw.sg;
  return out;
}

/**
 * Lê o estado de treino de um aluno no SQLite (`user_states`).
 */
export function readStudentState(dataOrTenantDir, studentId, stateOps = null) {
  if (stateOps?.readState) return stateOps.readState(studentId);
  const st = readUserStateSqlite(dataOrTenantDir, studentId);
  return st || null;
}

/**
 * Salva o estado de treino de um aluno com carimbos de sincronização (`stampPut`) no SQLite (`user_states`).
 */
const studentMetricsCache = new Map(); // studentId -> { rev, ts, wLen, rLen, routines, prescribedCount, lastWorkout, workoutDates, week }

export function evictStudentSummary(studentId) {
  if (studentId) studentMetricsCache.delete(studentId);
  else studentMetricsCache.clear();
}

export function saveStudentState(dataOrTenantDir, studentId, nextState, stateOps = null, prevState = undefined) {
  evictStudentSummary(studentId);
  if (stateOps?.writeState) {
    return stateOps.writeState(studentId, nextState, prevState);
  }
  const inst = getSqliteInstance(dataOrTenantDir);
  return runInTransaction(inst, () => {
    const cur = prevState || readStudentState(dataOrTenantDir, studentId);
    const now = Date.now();
    const curRev = cur?._rev || 0;
    try {
      stampPut(cur, nextState, { overRead: true, stamped: false, now });
    } catch { /* fallback if state is minimal */ }
    nextState._rev = curRev + 1;
    nextState._ts = now;
    nextState._wids = [...(Array.isArray(cur?._wids) ? cur._wids : []), ...(cur?._wid ? [cur._wid] : [])]
      .filter(x => typeof x === 'string')
      .slice(-32);
    nextState._wid = crypto.randomBytes(8).toString('hex');

    writeUserStateSqlite(dataOrTenantDir, studentId, nextState);
    if (stateOps?.evictCache) stateOps.evictCache(studentId);
    return nextState;
  });
}

function mutateStudentStateAtomic(dataOrTenantDir, studentId, stateOps, mutateFn) {
  evictStudentSummary(studentId);
  if (stateOps?.updateAtomic) {
    return stateOps.updateAtomic(studentId, (prev) => {
      const base = ensureBaseStudentState(prev);
      return mutateFn(base, prev);
    });
  }
  if (stateOps?.writeState) {
    const prev = readStudentState(dataOrTenantDir, studentId, stateOps);
    const state = ensureBaseStudentState(prev);
    const out = mutateFn(state, prev);
    if (out === null) return null;
    saveStudentState(dataOrTenantDir, studentId, out.state || state, stateOps, prev);
    return out.result;
  }

  let fnResult;
  updateUserStateAtomicSqlite(dataOrTenantDir, studentId, (cur) => {
    const state = ensureBaseStudentState(cur);
    const out = mutateFn(state, cur);
    if (out === null) {
      fnResult = null;
      return null;
    }
    const nextState = out.state || state;
    fnResult = out.result;
    const now = Date.now();
    const curRev = cur?._rev || 0;
    try {
      stampPut(cur, nextState, { overRead: true, stamped: false, now });
    } catch { /* fallback if state is minimal */ }
    nextState._rev = curRev + 1;
    nextState._ts = now;
    nextState._wids = [...(Array.isArray(cur?._wids) ? cur._wids : []), ...(cur?._wid ? [cur._wid] : [])]
      .filter(x => typeof x === 'string')
      .slice(-32);
    nextState._wid = crypto.randomBytes(8).toString('hex');
    return nextState;
  });
  if (stateOps?.evictCache) stateOps.evictCache(studentId);
  return fnResult;
}

function ensureBaseStudentState(cur) {
  const base = cur && typeof cur === 'object' ? structuredClone(cur) : {
    routines: [],
    week: {},
    dayPlan: {},
    workouts: [],
    bodyweight: [],
    bw: [],
    measurements: [],
    assessments: [],
    routineArchive: [],
    videoReviews: {},
    customEx: []
  };
  if (!Array.isArray(base.routines)) base.routines = [];
  if (!base.week || typeof base.week !== 'object' || Array.isArray(base.week)) base.week = {};
  if (!base.dayPlan || typeof base.dayPlan !== 'object' || Array.isArray(base.dayPlan)) base.dayPlan = {};
  if (!Array.isArray(base.workouts)) base.workouts = [];
  if (!Array.isArray(base.bodyweight)) base.bodyweight = [];
  if (!Array.isArray(base.measurements)) base.measurements = [];
  if (!Array.isArray(base.assessments)) base.assessments = [];
  if (!Array.isArray(base.routineArchive)) base.routineArchive = [];
  if (!base.videoReviews || typeof base.videoReviews !== 'object' || Array.isArray(base.videoReviews)) base.videoReviews = {};
  return base;
}

const VALID_SHA256_RE = /^[0-9a-f]{64}$/;
const LB_TO_KG = 0.45359237;
const ASSESSMENT_WEIGH_IN_ID = 'trainer-assessment';
const CIRCUMFERENCE_FIELDS = [
  'neck', 'shoulders', 'chest', 'waist', 'abdomen', 'hips',
  'upperArmLeft', 'upperArmRight', 'forearmLeft', 'forearmRight',
  'thighLeft', 'thighRight', 'calfLeft', 'calfRight'
];
const SKINFOLD_FIELDS = [
  'triceps', 'subscapular', 'biceps', 'iliacCrest', 'supraspinale',
  'abdominal', 'frontThigh', 'medialCalf', 'chestFold', 'midaxillary'
];

function roundMetric(val, decimals = 1) {
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

function cleanPositiveNum(val, min, max, decimals = 1) {
  if (val === undefined || val === null || val === '') return null;
  const n = Number(String(val).replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return roundMetric(n, decimals);
}

function normalizeIsoDay(raw, nowMs = Date.now()) {
  const str = String(raw || '').trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  return new Date(nowMs - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function stampEditedKey(state, key, nowMs) {
  if (!state.edited || typeof state.edited !== 'object' || Array.isArray(state.edited)) {
    state.edited = {};
  }
  state.edited[key] = nowMs;
}

/**
 * Unifica `state.bodyweight` (formato nativo do app do aluno) e `state.bw` (legado B2B)
 * em quilogramas e em ordem cronológica crescente por data `d`.
 */
export function normalizeBodyweightSeries(state) {
  const byDay = new Map();
  const sources = [
    { items: state?.bw, toKg: 1 },
    { items: state?.bodyweight, toKg: state?.unit === 'lb' ? LB_TO_KG : 1 }
  ];
  for (const { items, toKg } of sources) {
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== 'object') continue;
      const d = typeof item.d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(item.d) ? item.d.slice(0, 10) : '';
      if (!d) continue;
      const t = Number(item.t) || Date.parse(`${d}T12:00:00Z`) || 0;
      const prev = byDay.get(d);
      const rawWeight = item.w ?? item.weight ?? item.value;
      const weight = Number(String(rawWeight).replace(',', '.'));
      // Avaliações antigas gravavam o mesmo valor em kg nos dois campos.
      const isLegacyAssessment = item.src === 'trainer' && !Array.isArray(item.ins) && prev?.t === t && prev.w === weight;
      const w = cleanPositiveNum(weight * (isLegacyAssessment ? 1 : toKg), 15, 450, 1);
      if (w !== null && (!prev || t >= prev.t)) {
        byDay.set(d, { d, w, t, ...(item.src ? { src: String(item.src).slice(0, 24) } : {}) });
      }
    }
  }
  return Array.from(byDay.values()).sort((a, b) => a.d.localeCompare(b.d));
}

function buildBodySnapshotFromDay({ day, bwMap, measMap, assessMap }) {
  const bw = bwMap.get(day);
  const meas = measMap.get(day);
  const assess = assessMap.get(day);
  const weightKg = cleanPositiveNum(assess?.weightKg ?? bw?.w, 15, 450, 1);
  const bodyFat = cleanPositiveNum(assess?.bodyFat ?? meas?.bodyFat, 2, 70, 1);
  const leanMassKg = weightKg !== null && bodyFat !== null
    ? roundMetric(weightKg * (1 - bodyFat / 100), 1)
    : cleanPositiveNum(assess?.leanMassKg, 10, 350, 1);
  const fatMassKg = weightKg !== null && bodyFat !== null
    ? roundMetric(weightKg * (bodyFat / 100), 1)
    : cleanPositiveNum(assess?.fatMassKg, 1, 300, 1);

  const snap = {
    d: day,
    weightKg,
    bodyFat,
    leanMassKg,
    fatMassKg
  };
  for (const field of CIRCUMFERENCE_FIELDS) {
    const val = cleanPositiveNum(meas?.[field] ?? assess?.circumferences?.[field], 10, 300, 1);
    if (val !== null) snap[field] = val;
  }
  return snap;
}

/**
 * Calcula automaticamente o comparativo Antes vs. Atual de peso, composição corporal e medidas.
 */
export function computeBodyComparison(state) {
  const bwSeries = normalizeBodyweightSeries(state);
  const measList = (Array.isArray(state?.measurements) ? state.measurements : [])
    .filter(m => m && typeof m === 'object' && /^\d{4}-\d{2}-\d{2}/.test(String(m.d || '')))
    .slice()
    .sort((a, b) => String(a.d).localeCompare(String(b.d)));
  const assessList = (Array.isArray(state?.assessments) ? state.assessments : [])
    .filter(a => a && typeof a === 'object' && /^\d{4}-\d{2}-\d{2}/.test(String(a.d || '')))
    .slice()
    .sort((a, b) => String(a.d).localeCompare(String(b.d)));

  const bwMap = new Map(bwSeries.map(x => [x.d, x]));
  const measMap = new Map(measList.map(x => [String(x.d).slice(0, 10), x]));
  const assessMap = new Map(assessList.map(x => [String(x.d).slice(0, 10), x]));
  const allDays = Array.from(new Set([...bwMap.keys(), ...measMap.keys(), ...assessMap.keys()])).sort();

  if (!allDays.length) {
    return { count: 0, before: null, current: null, deltas: {} };
  }

  const snaps = allDays.map(day => buildBodySnapshotFromDay({ day, bwMap, measMap, assessMap }));
  const metricKeys = ['weightKg', 'bodyFat', 'leanMassKg', 'fatMassKg', ...CIRCUMFERENCE_FIELDS];
  const before = { d: snaps[0].d };
  const current = { d: snaps[snaps.length - 1].d };
  const deltas = {};

  for (const key of metricKeys) {
    let firstVal = null;
    let lastVal = null;
    let firstDay = null;
    let lastDay = null;
    for (const s of snaps) {
      if (s[key] !== null && s[key] !== undefined) {
        if (firstVal === null) {
          firstVal = s[key];
          firstDay = s.d;
        }
        lastVal = s[key];
        lastDay = s.d;
      }
    }
    if (firstVal !== null) before[key] = firstVal;
    if (lastVal !== null) current[key] = lastVal;
    if (firstVal !== null && lastVal !== null && firstDay !== lastDay) {
      const diff = roundMetric(lastVal - firstVal, 1);
      const pct = firstVal > 0 ? roundMetric((diff / firstVal) * 100, 1) : null;
      deltas[key] = { before: firstVal, current: lastVal, diff, pct, beforeDate: firstDay, currentDate: lastDay };
    }
  }

  return {
    count: allDays.length,
    before,
    current,
    deltas
  };
}

/**
 * Registra avaliação física e antropometria do aluno pelo painel B2B,
 * compatibilizando `state.bodyweight`, `state.measurements` e `state.assessments`.
 */
export function recordStudentAssessment(dataOrTenantDir, studentId, payload = {}, trainerUser = null, stateOps = null) {
  const now = Date.now();
  const d = normalizeIsoDay(payload.d || payload.date, now);
  const weightKg = cleanPositiveNum(payload.weightKg ?? payload.weight, 15, 450, 1);
  const heightCm = cleanPositiveNum(payload.heightCm ?? payload.height, 80, 260, 1);
  const bodyFat = cleanPositiveNum(payload.bodyFat ?? payload.bf, 2, 70, 1);
  const goalWeightKg = cleanPositiveNum(payload.goalWeightKg, 15, 450, 1);
  const goalBodyFat = cleanPositiveNum(payload.goalBodyFat, 2, 70, 1);

  const circumferences = {};
  const circSrc = payload.circumferences && typeof payload.circumferences === 'object' ? payload.circumferences : payload;
  for (const field of CIRCUMFERENCE_FIELDS) {
    const v = cleanPositiveNum(circSrc?.[field], 10, 300, 1);
    if (v !== null) circumferences[field] = v;
  }

  const skinfolds = {};
  const foldSrc = payload.skinfolds && typeof payload.skinfolds === 'object' ? payload.skinfolds : {};
  for (const field of SKINFOLD_FIELDS) {
    const v = cleanPositiveNum(foldSrc?.[field], 1, 120, 1);
    if (v !== null) skinfolds[field] = v;
  }

  const clinicalNotes = String(payload.clinicalNotes ?? payload.notes ?? '').trim().slice(0, 1200);
  const protocol = String(payload.protocol || 'pollock_bioimpedancia').trim().slice(0, 64);

  if (
    weightKg === null
    && bodyFat === null
    && heightCm === null
    && Object.keys(circumferences).length === 0
    && Object.keys(skinfolds).length === 0
    && !clinicalNotes
  ) {
    const err = new Error('Informe ao menos peso, % gordura, uma medida corporal ou observação clínica.');
    err.status = 400;
    err.code = 'assessment-empty';
    throw err;
  }

  let result = null;
  mutateStudentStateAtomic(dataOrTenantDir, studentId, stateOps, (state) => {
    if (weightKg !== null) {
      state.bodyweight = state.bodyweight.filter(item => item && typeof item.d === 'string');
      const day = state.bodyweight.find(item => item.d === d);
      if (day?.src === 'trainer' && !Array.isArray(day.ins)) day.ins = [];
      const previousReading = Array.isArray(day?.ins)
        ? day.ins.find(reading => reading?.id === ASSESSMENT_WEIGH_IN_ID)
        : null;
      const localTimestamp = new Date(now - 3 * 3600000).toISOString();
      addWeighIn(state, {
        d,
        at: previousReading ? previousReading.at : (localTimestamp.startsWith(d) ? localTimestamp.slice(11, 16) : null),
        w: state.unit === 'lb' ? weightKg / LB_TO_KG : weightKg,
        t: now,
        id: ASSESSMENT_WEIGH_IN_ID,
        src: 'trainer'
      });

      const legacyBw = Array.isArray(state.bw) ? state.bw.filter(x => x && x.d !== d) : [];
      legacyBw.push({ d, w: weightKg, t: now });
      legacyBw.sort((a, b) => String(a.d).localeCompare(String(b.d)));
      state.bw = legacyBw;
    }

    if (bodyFat !== null || Object.keys(circumferences).length > 0) {
      const measArr = Array.isArray(state.measurements) ? state.measurements.filter(x => x && typeof x === 'object') : [];
      const idx = measArr.findIndex(m => String(m.d || '').slice(0, 10) === d);
      const existing = idx >= 0 ? { ...measArr[idx] } : { d };
      const merged = {
        ...existing,
        d,
        t: now,
        ...circumferences,
        ...(bodyFat !== null ? { bodyFat } : {})
      };
      if (idx >= 0) measArr[idx] = merged;
      else measArr.push(merged);
      measArr.sort((a, b) => String(a.d).localeCompare(String(b.d)));
      state.measurements = measArr;
    }

    const leanMassKg = weightKg !== null && bodyFat !== null ? roundMetric(weightKg * (1 - bodyFat / 100), 1) : null;
    const fatMassKg = weightKg !== null && bodyFat !== null ? roundMetric(weightKg * (bodyFat / 100), 1) : null;
    const bmi = weightKg !== null && heightCm !== null ? roundMetric(weightKg / Math.pow(heightCm / 100, 2), 1) : null;

    const assessRecord = {
      id: payload.id ? String(payload.id).slice(0, 64) : 'av_' + crypto.randomBytes(6).toString('hex'),
      d,
      t: now,
      trainerId: trainerUser?.id || 'staff',
      trainerName: trainerUser?.name || 'Professor',
      protocol,
      ...(heightCm !== null ? { heightCm } : {}),
      ...(weightKg !== null ? { weightKg } : {}),
      ...(bodyFat !== null ? { bodyFat } : {}),
      ...(bmi !== null ? { bmi } : {}),
      ...(leanMassKg !== null ? { leanMassKg } : {}),
      ...(fatMassKg !== null ? { fatMassKg } : {}),
      ...(goalWeightKg !== null ? { goalWeightKg } : {}),
      ...(goalBodyFat !== null ? { goalBodyFat } : {}),
      ...(Object.keys(skinfolds).length ? { skinfolds } : {}),
      ...(Object.keys(circumferences).length ? { circumferences } : {}),
      ...(clinicalNotes ? { clinicalNotes } : {})
    };

    const assessList = Array.isArray(state.assessments) ? state.assessments.filter(Boolean) : [];
    const exIdx = assessList.findIndex(a => a.d === d);
    if (exIdx >= 0) assessList[exIdx] = { ...assessList[exIdx], ...assessRecord, id: assessList[exIdx].id || assessRecord.id };
    else assessList.push(assessRecord);
    assessList.sort((a, b) => String(a.d).localeCompare(String(b.d)));
    state.assessments = assessList.slice(-50);
    stampEditedKey(state, 'assessments', now);

    result = {
      assessment: assessList.find(a => a.d === d) || assessRecord,
      bodyweight: normalizeBodyweightSeries(state),
      measurements: state.measurements,
      assessments: state.assessments,
      bodyComparison: computeBodyComparison(state)
    };
    return state;
  });

  return result;
}

function captureInitialWeightsForRoutine(state, exList = []) {
  const weights = {};
  for (const ex of exList) {
    if (!ex?.id) continue;
    const logged = cleanPositiveNum(state?.exWeights?.[ex.id]?.w, 0.5, 2000, 1);
    const target = cleanPositiveNum(ex.w ?? ex.weight, 0.5, 2000, 1);
    if (logged !== null) weights[ex.id] = logged;
    else if (target !== null) weights[ex.id] = target;
  }
  return weights;
}

function buildRoutineArchiveSnapshot(state, routine, { archivedAt = Date.now(), reason = 'renewed', trainerUser = null, resolveNameFn = null } = {}) {
  if (!routine || typeof routine !== 'object') return null;
  const prescribedAt = Number(routine.prescribedBy?.at) || archivedAt;
  const exList = Array.isArray(routine.ex) ? routine.ex : [];
  const exIds = new Set(exList.map(e => String(e?.id || '')).filter(Boolean));
  const workouts = Array.isArray(state?.workouts) ? state.workouts : [];

  const maxLoggedDuring = new Map();
  let workoutsCount = 0;
  for (const w of workouts) {
    if (!w || typeof w !== 'object') continue;
    const wMs = Number(w.end) || Number(w.start) || (w.d ? Date.parse(`${w.d}T12:00:00Z`) : 0);
    if (wMs && prescribedAt && wMs < prescribedAt - 86400000) continue;
    const wExIds = Array.isArray(w.entries) ? w.entries.map(e => String(e?.id || '')) : [];
    const matchesRoutine = (w.routineId && w.routineId === routine.id) || wExIds.some(id => exIds.has(id));
    if (!matchesRoutine) continue;
    workoutsCount += 1;
    for (const entry of w.entries || []) {
      const eid = String(entry?.id || '');
      if (!eid) continue;
      for (const s of entry.sets || []) {
        if (s?.done === false || s?.warmup) continue;
        const sw = cleanPositiveNum(s?.w, 0.5, 2000, 1);
        if (sw !== null && sw > (maxLoggedDuring.get(eid) || 0)) {
          maxLoggedDuring.set(eid, sw);
        }
      }
    }
  }

  const initialMap = routine.prescribedBy?.initialWeights || {};
  const exercises = exList.map(e => {
    const id = String(e?.id || '');
    const initW = cleanPositiveNum(initialMap[id] ?? e?.w ?? e?.weight, 0.5, 2000, 1);
    const finW = cleanPositiveNum(maxLoggedDuring.get(id) ?? state?.exWeights?.[id]?.w ?? e?.w ?? e?.weight, 0.5, 2000, 1);
    const deltaKg = initW !== null && finW !== null ? roundMetric(finW - initW, 1) : null;
    return {
      id,
      name: (typeof resolveNameFn === 'function' ? resolveNameFn(id) : null) || e?.name || id,
      sets: Number(e?.sets) || 3,
      reps: e?.reps ?? null,
      initialWeightKg: initW,
      finalWeightKg: finW,
      deltaKg
    };
  });

  const durationDays = Math.max(0, Math.round((archivedAt - prescribedAt) / 86400000));
  return {
    id: 'arc_' + crypto.randomBytes(6).toString('hex'),
    routineId: routine.id || null,
    name: String(routine.name || 'Treino Arquivado'),
    emoji: String(routine.emoji || 'figureStrength'),
    prescribedAt: routine.prescribedBy?.at || null,
    archivedAt,
    durationDays,
    reason: String(reason || 'renewed').slice(0, 40),
    trainerName: trainerUser?.name || routine.prescribedBy?.trainerName || 'Professor',
    workoutsCount,
    exercises
  };
}

export function archiveRoutineSnapshotsInState(state, routinesToArchive, options = {}) {
  const archivedAt = Number(options.archivedAt) || Date.now();
  const list = Array.isArray(routinesToArchive) ? routinesToArchive.filter(r => r && typeof r === 'object') : [];
  if (!list.length) return [];
  if (!Array.isArray(state.routineArchive)) state.routineArchive = [];
  const created = [];
  for (const r of list) {
    const snap = buildRoutineArchiveSnapshot(state, r, { ...options, archivedAt });
    if (snap) {
      state.routineArchive.push(snap);
      created.push(snap);
    }
  }
  state.routineArchive = state.routineArchive.slice(-30);
  stampEditedKey(state, 'routineArchive', archivedAt);
  return created;
}

function replaceRoutineScheduleReferences(state, oldId, newId) {
  if (!oldId || oldId === newId) return;
  for (const [day, entry] of Object.entries(state.week)) {
    const ids = [].concat(entry || []);
    if (!ids.includes(oldId)) continue;
    const replacement = ids.map(id => id === oldId ? newId : id).filter(Boolean);
    if (replacement.length === 0) delete state.week[day];
    else state.week[day] = Array.isArray(entry) ? [...new Set(replacement)] : replacement[0];
  }
  for (const [date, id] of Object.entries(state.dayPlan)) {
    if (id !== oldId) continue;
    if (newId) state.dayPlan[date] = newId;
    else delete state.dayPlan[date];
  }
}

/**
 * Arquiva uma ficha específica ou todas as fichas atuais do aluno no histórico de ciclos (`state.routineArchive`).
 */
export function archiveStudentRoutines(dataOrTenantDir, studentId, { routineIds = null, removeCurrent = false, reason = 'cycle_completed', trainerUser = null, resolveNameFn = null } = {}, stateOps = null) {
  let out = { archived: [], routineArchive: [] };
  mutateStudentStateAtomic(dataOrTenantDir, studentId, stateOps, (state) => {
    const now = Date.now();
    const idSet = Array.isArray(routineIds) && routineIds.length ? new Set(routineIds.map(String)) : null;
    const targets = idSet
      ? state.routines.filter(r => idSet.has(String(r.id)))
      : state.routines.slice();
    const archived = archiveRoutineSnapshotsInState(state, targets, { archivedAt: now, reason, trainerUser, resolveNameFn });

    if (removeCurrent && targets.length) {
      const removedIds = new Set(targets.map(r => r.id));
      state.routines = state.routines.filter(r => !removedIds.has(r.id));
      for (const id of removedIds) replaceRoutineScheduleReferences(state, id, null);
    }
    out = { archived, routineArchive: state.routineArchive };
    return state;
  });
  return out;
}

/**
 * Constrói séries históricas de carga, 1RM estimado (Epley) e tonelagem por exercício para gráficos.
 */
export function buildExerciseLoadHistory(state, resolveNameFn = null) {
  const map = new Map();
  const workouts = (Array.isArray(state?.workouts) ? state.workouts : [])
    .filter(w => w && typeof w === 'object' && Array.isArray(w.entries))
    .slice()
    .sort((a, b) => String(a.d || '').localeCompare(String(b.d || '')));

  for (const w of workouts) {
    const d = String(w.d || '').slice(0, 10);
    if (!d) continue;
    const parts = d.split('-');
    const label = parts.length === 3 ? `${parts[2]}/${parts[1]}` : d;

    for (const entry of w.entries) {
      const id = String(entry?.id || '');
      if (!id) continue;
      let maxW = 0;
      let best1Rm = 0;
      let volKg = 0;
      let topReps = 0;
      let hasWork = false;
      for (const s of entry.sets || []) {
        if (!s || s.done === false || s.warmup) continue;
        const sw = Number(s.w) || 0;
        const sr = Number(s.r) || 0;
        if (sw <= 0 && sr <= 0) continue;
        hasWork = true;
        if (sw > maxW) {
          maxW = sw;
          topReps = sr;
        }
        if (sw > 0 && sr > 0) {
          volKg += sw * sr;
          const epley = sr === 1 ? sw : sw * (1 + sr / 30);
          if (epley > best1Rm) best1Rm = epley;
        }
      }
      if (!hasWork || maxW <= 0) continue;

      if (!map.has(id)) {
        map.set(id, {
          id,
          name: (typeof resolveNameFn === 'function' ? resolveNameFn(id) : null) || entry.name || id,
          series: []
        });
      }
      map.get(id).series.push({
        d,
        label,
        maxWeightKg: roundMetric(maxW, 1),
        est1Rm: roundMetric(best1Rm, 1),
        volumeKg: Math.round(volKg),
        topReps
      });
    }
  }

  const exercises = [];
  for (const item of map.values()) {
    const s = item.series;
    if (!s.length) continue;
    const bestWeightKg = Math.max(...s.map(p => p.maxWeightKg || 0));
    const bestEst1Rm = Math.max(...s.map(p => p.est1Rm || 0));
    exercises.push({
      id: item.id,
      name: item.name,
      sessionsCount: s.length,
      firstWeightKg: s[0].maxWeightKg,
      latestWeightKg: s[s.length - 1].maxWeightKg,
      deltaKg: roundMetric((s[s.length - 1].maxWeightKg || 0) - (s[0].maxWeightKg || 0), 1),
      bestWeightKg,
      bestEst1Rm: roundMetric(bestEst1Rm, 1),
      series: s.slice(-24)
    });
  }
  exercises.sort((a, b) => b.sessionsCount - a.sessionsCount || a.name.localeCompare(b.name));
  return { exercises };
}

function makeVideoReviewKey(w, entryIdx, setIdx, hash) {
  const wid = String(w?.id || w?.d || 'w');
  return `${wid}:${entryIdx}:${setIdx}:${hash}`;
}

export function isMediaHashInStudentState(state, hash) {
  if (!VALID_SHA256_RE.test(String(hash || ''))) return false;
  for (const w of Array.isArray(state?.workouts) ? state.workouts : []) {
    if (!w || typeof w !== 'object') continue;
    for (const m of Array.isArray(w.media) ? w.media : []) {
      if (m && m.hash === hash && m.local !== true) return true;
      if (m?.poster?.hash === hash && m.local !== true) return true;
    }
    for (const e of Array.isArray(w.entries) ? w.entries : []) {
      for (const s of Array.isArray(e?.sets) ? e.sets : []) {
        const mediaList = Array.isArray(s?.media) ? s.media : (s?.media ? [s.media] : []);
        for (const m of mediaList) {
          if (!m || typeof m !== 'object' || m.local === true) continue;
          if (m.hash === hash || m.poster?.hash === hash) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Lista vídeos/mídias de execução enviados pelo aluno nos treinos (excluindo `local: true`).
 */
export function collectStudentFormVideos(state, resolveNameFn = null, limit = 40) {
  const reviews = state?.videoReviews && typeof state.videoReviews === 'object' ? state.videoReviews : {};
  const workouts = (Array.isArray(state?.workouts) ? state.workouts : [])
    .slice()
    .sort((a, b) => String(b?.d || '').localeCompare(String(a?.d || '')));

  const items = [];
  for (const w of workouts) {
    if (!w || typeof w !== 'object') continue;
    const entries = Array.isArray(w.entries) ? w.entries : [];
    for (let eIdx = 0; eIdx < entries.length; eIdx++) {
      const entry = entries[eIdx];
      const sets = Array.isArray(entry?.sets) ? entry.sets : [];
      for (let sIdx = 0; sIdx < sets.length; sIdx++) {
        const set = sets[sIdx];
        const mediaList = Array.isArray(set?.media) ? set.media : (set?.media ? [set.media] : []);
        for (const m of mediaList) {
          if (!m || typeof m !== 'object' || m.local === true) continue;
          if (!VALID_SHA256_RE.test(String(m.hash || ''))) continue;
          const key = makeVideoReviewKey(w, eIdx, sIdx, m.hash);
          const review = reviews[key] || reviews[m.hash] || null;
          items.push({
            key,
            hash: m.hash,
            kind: m.kind || 'video',
            mime: m.mime || 'video/mp4',
            dur: m.dur || null,
            width: m.width || null,
            height: m.height || null,
            posterHash: m.poster?.hash || null,
            workoutId: w.id || null,
            workoutDate: w.d || null,
            workoutName: w.name || w.routineName || 'Treino',
            exerciseId: entry.id || null,
            exerciseName: (typeof resolveNameFn === 'function' ? resolveNameFn(entry.id) : null) || entry.name || entry.id || 'Exercício',
            setIndex: sIdx + 1,
            weightKg: set.w ?? null,
            reps: set.r ?? null,
            rpe: set.rpe ?? null,
            rir: set.rir ?? null,
            at: m.at || w.end || w.start || null,
            review
          });
          if (items.length >= limit) return items;
        }
      }
    }
    for (let mIdx = 0; mIdx < (Array.isArray(w.media) ? w.media.length : 0); mIdx++) {
      const m = w.media[mIdx];
      if (!m || typeof m !== 'object' || m.local === true) continue;
      if (!VALID_SHA256_RE.test(String(m.hash || ''))) continue;
      const key = makeVideoReviewKey(w, -1, mIdx, m.hash);
      const review = reviews[key] || reviews[m.hash] || null;
      items.push({
        key,
        hash: m.hash,
        kind: m.kind || 'video',
        mime: m.mime || 'video/mp4',
        dur: m.dur || null,
        width: m.width || null,
        height: m.height || null,
        posterHash: m.poster?.hash || null,
        workoutId: w.id || null,
        workoutDate: w.d || null,
        workoutName: w.name || w.routineName || 'Treino',
        exerciseId: null,
        exerciseName: 'Registro geral da sessão',
        setIndex: null,
        weightKg: null,
        reps: null,
        at: m.at || w.end || w.start || null,
        review
      });
      if (items.length >= limit) return items;
    }
  }
  return items;
}

/**
 * Registra o parecer/correção biomecânica do professor sobre um vídeo de execução do aluno.
 */
export function saveStudentVideoReview(dataOrTenantDir, studentId, { key, hash, status = 'reviewed', comment = '', trainerUser = null } = {}, stateOps = null) {
  const cleanHash = String(hash || '').trim().toLowerCase();
  if (!VALID_SHA256_RE.test(cleanHash)) {
    const err = new Error('Hash de vídeo inválido.');
    err.status = 400;
    err.code = 'invalid-media-hash';
    throw err;
  }
  const cleanComment = String(comment || '').trim().slice(0, 1000);
  if (!cleanComment) {
    const err = new Error('Escreva um feedback técnico para o aluno.');
    err.status = 400;
    err.code = 'empty-review-comment';
    throw err;
  }

  let savedReview = null;
  let videos = [];
  mutateStudentStateAtomic(dataOrTenantDir, studentId, stateOps, (state) => {
    if (!isMediaHashInStudentState(state, cleanHash)) {
      const err = new Error('Vídeo não encontrado ou restrito ao dispositivo do aluno.');
      err.status = 404;
      err.code = 'video-not-found';
      throw err;
    }
    const now = Date.now();
    if (!state.videoReviews || typeof state.videoReviews !== 'object' || Array.isArray(state.videoReviews)) {
      state.videoReviews = {};
    }
    const targetKey = String(key || cleanHash).slice(0, 140);
    savedReview = {
      key: targetKey,
      hash: cleanHash,
      status: status === 'adjust_needed' ? 'adjust_needed' : 'reviewed',
      comment: cleanComment,
      trainerId: trainerUser?.id || 'staff',
      trainerName: trainerUser?.name || 'Professor',
      at: now
    };
    state.videoReviews[targetKey] = savedReview;
    const keys = Object.keys(state.videoReviews);
    if (keys.length > 100) {
      keys.sort((a, b) => (Number(state.videoReviews[a]?.at) || 0) - (Number(state.videoReviews[b]?.at) || 0));
      for (const k of keys.slice(0, keys.length - 100)) delete state.videoReviews[k];
    }
    stampEditedKey(state, 'videoReviews', now);
    videos = collectStudentFormVideos(state, null, 40);
    return state;
  });

  return { review: savedReview, videos };
}

/**
 * Calcula diferença de dias entre `YYYY-MM-DD` (ou timestamp) e hoje.
 */
export function daysSinceDate(isoDateOrTs, nowMs = Date.now()) {
  if (!isoDateOrTs) return null;
  let ts;
  if (typeof isoDateOrTs === 'number') {
    ts = isoDateOrTs;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(String(isoDateOrTs))) {
    ts = Date.parse(String(isoDateOrTs) + 'T12:00:00Z');
  } else {
    ts = Date.parse(String(isoDateOrTs));
  }
  if (Number.isNaN(ts)) return null;
  return Math.max(0, Math.floor((nowMs - ts) / 86400000));
}

/**
 * Lista todos os alunos de uma academia com indicadores reais de frequência, retenção/evasão e treino ao vivo.
 */
export function listStudents(db, dataOrTenantDir, options = {}) {
  const {
    tenantId = null,
    includeDisabled = false,
    churnDaysThreshold = 5,
    routineCycleDays = 30,
    includeWorkoutDates = false,
    stateOps = null,
    livePresence = null,
    nowMs = Date.now()
  } = options;

  const safeCycleDays = Math.max(1, Number(routineCycleDays || 30) || 30);
  const users = Array.isArray(db?.users) ? db.users : [];
  const trainersById = new Map(
    users
      .filter(u => u.role === 'trainer' || u.saasRole === 'trainer' || u.saasRole === 'gym_owner' || u.saasRole === 'gym_manager')
      .map(u => [u.id, u.name])
  );

  const students = users.filter(u => {
    if (!includeDisabled && u.disabled) return false;
    if (u.role === 'trainer' || u.saasRole === 'trainer' || u.saasRole === 'gym_owner' || u.saasRole === 'gym_manager' || u.saasRole === 'superadmin') return false;
    if (u.admin && !u.tenantId) return false;
    if (tenantId && tenantId !== 'default') {
      return u.tenantId === tenantId;
    }
    return (!u.tenantId || u.tenantId === 'default') && !u.admin;
  });

  const sevenDaysAgo = new Date(nowMs - 7 * 86400000).toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date(nowMs - 14 * 86400000).toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(nowMs - 30 * 86400000).toISOString().slice(0, 10);

  return students.map(u => {
    const state = readStudentState(dataOrTenantDir, u.id, stateOps);
    const rev = state?._rev ?? -1;
    const ts = state?._ts ?? null;
    const rawWLen = Array.isArray(state?.workouts) ? state.workouts.length : 0;
    const rawRLen = Array.isArray(state?.routines) ? state.routines.length : 0;

    let summary = studentMetricsCache.get(u.id);
    if (
      !summary ||
      summary.rev !== rev ||
      summary.ts !== ts ||
      summary.wLen !== rawWLen ||
      summary.rLen !== rawRLen ||
      summary.feedbackEvents === undefined
    ) {
      const workouts = Array.isArray(state?.workouts) ? state.workouts.filter(Boolean) : [];
      const routines = Array.isArray(state?.routines) ? state.routines.filter(Boolean) : [];
      const prescribedCount = routines.filter(r => r.prescribedBy).length;
      const routineIdSet = new Set(routines.map(r => r.id).filter(Boolean));

      let lastPrescribedAt = 0;
      for (const r of routines) {
        const at = Number(r?.prescribedBy?.at || 0);
        if (Number.isFinite(at) && at > lastPrescribedAt) lastPrescribedAt = at;
      }

      const rawWeek = state?.week && typeof state.week === 'object' ? state.week : {};
      let scheduledDaysCount = 0;
      for (let d = 0; d <= 6; d++) {
        const ids = [].concat(rawWeek[String(d)] || []).filter(id => id && routineIdSet.has(id));
        if (ids.length > 0) scheduledDaysCount++;
      }
      const plannedWeeklyDays = routines.length === 0
        ? 0
        : (scheduledDaysCount > 0 ? scheduledDaysCount : Math.min(Math.max(routines.length, 3), 5));

      let lastWorkout = null;
      const workoutDates = [];
      const feedbackEvents = [];
      for (const w of workouts) {
        if (w?.d) {
          workoutDates.push(w.d);
          if (!lastWorkout || w.d > lastWorkout) lastWorkout = w.d;
          const noteStr = String(w.note || '').trim();
          const prCount = Array.isArray(w.prs) ? w.prs.length : 0;
          if (noteStr || prCount > 0) {
            feedbackEvents.push({
              workoutId: w.id || '',
              date: w.d,
              routineName: String(w.name || 'Treino').trim(),
              note: noteStr,
              prCount,
              vol: Number(w.vol || 0)
            });
          }
        }
      }
      feedbackEvents.sort((a, b) => String(b.date).localeCompare(String(a.date)));

      const firstR = routines[0]
        ? {
            id: routines[0].id,
            name: routines[0].name,
            emoji: routines[0].emoji || 'figureStrength',
            ex: Array.isArray(routines[0].ex) ? routines[0].ex : [],
            prescribedBy: routines[0].prescribedBy || null
          }
        : null;

      summary = {
        rev,
        ts,
        wLen: rawWLen,
        rLen: rawRLen,
        workoutCount: workouts.length,
        routineCount: routines.length,
        prescribedCount,
        lastPrescribedAt: lastPrescribedAt || null,
        plannedWeeklyDays,
        firstRoutine: firstR,
        lastWorkout,
        workoutDates,
        feedbackEvents,
        routines: routines.map(r => ({
          id: r.id,
          name: r.name,
          emoji: r.emoji || 'figureStrength',
          exCount: Array.isArray(r.ex) ? r.ex.length : 0,
          prescribedBy: r.prescribedBy || null
        })),
        week: rawWeek
      };
      if (state) studentMetricsCache.set(u.id, summary);
    }

    const {
      workoutCount,
      routineCount,
      prescribedCount,
      lastPrescribedAt,
      plannedWeeklyDays,
      firstRoutine,
      lastWorkout,
      workoutDates,
      feedbackEvents,
      routines: mappedRoutines,
      week
    } = summary;

    const workoutsLast7d = workoutDates.filter(d => d >= sevenDaysAgo).length;
    const workoutsLast30d = workoutDates.filter(d => d >= thirtyDaysAgo).length;
    const daysInactive = lastWorkout ? daysSinceDate(lastWorkout, nowMs) : null;
    const accountAgeDays = u.created ? daysSinceDate(u.created, nowMs) : 0;

    let churnStatus = 'healthy';
    if (u.disabled) {
      churnStatus = 'disabled';
    } else if (lastWorkout === null) {
      churnStatus = accountAgeDays >= churnDaysThreshold ? 'critical' : 'new';
    } else if (daysInactive >= Math.max(10, churnDaysThreshold * 2)) {
      churnStatus = 'critical';
    } else if (daysInactive >= churnDaysThreshold) {
      churnStatus = 'warning';
    }

    // Quick-Win Anti-Falso-Positivo no Churn: desconta dias justificados (viagem/doença/recuperação) via nudge.js
    const recentIsoCandidates = [
      new Date(nowMs).toISOString().slice(0, 10),
      new Date(nowMs - 3 * 3600 * 1000).toISOString().slice(0, 10),
      new Date(nowMs - 86400000).toISOString().slice(0, 10),
      new Date(nowMs - 86400000 - 3 * 3600 * 1000).toISOString().slice(0, 10)
    ];
    const TAG_LABELS = {
      sick: 'Saúde / Atestado',
      travel: 'Viagem',
      rest: 'Descanso programado',
      injured: 'Recuperação / Lesão'
    };
    let excusedInfo = null;
    for (const iso of recentIsoCandidates) {
      if (excusedOn(state, iso)) {
        const note = state?.dayNotes?.[iso];
        const tag = String(note?.tag || 'excused');
        excusedInfo = {
          iso,
          kind: tag,
          label: String(note?.text || TAG_LABELS[tag] || 'Ausência justificada').slice(0, 120)
        };
        break;
      }
    }
    if ((churnStatus === 'warning' || churnStatus === 'critical') && excusedInfo) {
      churnStatus = 'excused';
    }

    const routineAgeDays = lastPrescribedAt
      ? Math.max(0, Math.floor((nowMs - lastPrescribedAt) / 86400000))
      : null;
    const daysUntilRoutineExpiry = routineAgeDays !== null
      ? (safeCycleDays - routineAgeDays)
      : null;

    let routineStatus = 'up_to_date';
    if (routineCount === 0) {
      routineStatus = 'missing';
    } else if (daysUntilRoutineExpiry !== null && daysUntilRoutineExpiry < 0) {
      routineStatus = 'expired';
    } else if (daysUntilRoutineExpiry !== null && daysUntilRoutineExpiry <= 5) {
      routineStatus = 'expiring_soon';
    }

    const onboardingPending = Boolean(!u.disabled && !u.onboardedAt && !u.lastPull && workoutCount === 0);
    const weeklyGoalHit = Boolean(!u.disabled && plannedWeeklyDays > 0 && workoutsLast7d >= plannedWeeklyDays);
    const recentFeedbacks = (feedbackEvents || [])
      .filter(f => f.date >= fourteenDaysAgo)
      .slice(0, 3);

    const live = typeof livePresence === 'function' ? livePresence(u.id) : null;
    const formVideos = collectStudentFormVideos(state, null, 20);
    const pendingVideoReviewsCount = formVideos.filter(v => !v.review).length;
    const bwSeries = normalizeBodyweightSeries(state);
    const latestBw = bwSeries.length ? bwSeries[bwSeries.length - 1] : null;
    const measArr = Array.isArray(state?.measurements) ? state.measurements : [];
    const latestMeas = measArr.length ? measArr[measArr.length - 1] : null;
    const assessArr = Array.isArray(state?.assessments) ? state.assessments : [];
    const latestAssess = assessArr.length ? assessArr[assessArr.length - 1] : null;

    return {
      id: u.id,
      name: u.name,
      email: u.email || '',
      phone: u.phone || '',
      goal: u.goal || '',
      notes: u.notes || '',
      tenantId: u.tenantId || 'default',
      disabled: Boolean(u.disabled),
      assignedTrainerId: u.assignedTrainerId || null,
      assignedTrainerName: u.assignedTrainerId ? (trainersById.get(u.assignedTrainerId) || '') : '',
      created: u.created || null,
      inviteCode: u.inviteCode || null,
      welcomeWhatsapp: u.welcomeWhatsapp || null,
      onboardedAt: u.onboardedAt || null,
      lastSync: ts || u.lastPull || null,
      lastWorkout,
      lastWorkoutDate: lastWorkout,
      daysInactive,
      churnStatus,
      excused: Boolean(excusedInfo),
      excusedReason: excusedInfo?.label || null,
      pendingVideoReviewsCount,
      latestWeightKg: latestAssess?.weightKg ?? latestBw?.w ?? null,
      latestBodyFat: latestAssess?.bodyFat ?? latestMeas?.bodyFat ?? null,
      latestAssessmentAt: latestAssess?.t || latestMeas?.t || null,
      routineArchiveCount: Array.isArray(state?.routineArchive) ? state.routineArchive.length : 0,
      workoutCount,
      workoutsLast7d,
      workoutsLast30d,
      routineCount,
      prescribedCount,
      lastPrescribedAt,
      routineAgeDays,
      daysUntilRoutineExpiry,
      routineStatus,
      plannedWeeklyDays,
      weeklyGoalHit,
      onboardingPending,
      recentFeedbacks,
      firstRoutine,
      routines: mappedRoutines,
      week,
      ...(includeWorkoutDates ? { _workoutDates: workoutDates } : {}),
      trainingNow: live ? {
        routineName: live.name || 'Treino em andamento',
        startedAt: live.startedAt || null,
        setsDone: live.setsDone || 0
      } : null
    };
  });
}

/**
 * Prescreve ou atualiza uma rotina/ficha para o aluno atomicamente (`BEGIN IMMEDIATE`),
 * agendando nos dias da semana (`state.week`) sem perder prescrições ou treinos simultâneos.
 */
export function prescribeRoutineToStudent(dataOrTenantDir, studentId, { routine, day, days, replaceSchedule = false, archivePrevious = false, trainerUser, recordNotice = true }, stateOps = null) {
  return mutateStudentStateAtomic(dataOrTenantDir, studentId, stateOps, (state) => {
    const now = Date.now();
    const routineId = routine.id || 'r_' + crypto.randomBytes(6).toString('hex');
    const normalizedEx = Array.isArray(routine.ex) ? routine.ex.map(normalizeExerciseSlot) : [];
    const trainerName = trainerUser?.name || 'Professor';

    const existingIdx = state.routines.findIndex(r => r.id === routineId || r.name === String(routine.name || 'Treino Prescrito').trim());
    if (archivePrevious && existingIdx >= 0) {
      archiveRoutineSnapshotsInState(state, [state.routines[existingIdx]], { archivedAt: now, reason: 'renewed', trainerUser });
    }

    const routineRecord = {
      id: routineId,
      name: String(routine.name || 'Treino Prescrito').trim(),
      emoji: String(routine.emoji || routine.glyph || 'figureStrength'),
      ex: normalizedEx,
      prescribedBy: {
        trainerId: trainerUser?.id || 'staff',
        name: trainerName,
        trainerName,
        at: now,
        initialWeights: captureInitialWeightsForRoutine(state, normalizedEx)
      }
    };

    const finalRoutineId = existingIdx >= 0 && !archivePrevious ? state.routines[existingIdx].id : routineId;
    routineRecord.id = finalRoutineId;

    if (existingIdx >= 0) {
      replaceRoutineScheduleReferences(state, state.routines[existingIdx].id, finalRoutineId);
      state.routines[existingIdx] = routineRecord;
    } else {
      state.routines.push(routineRecord);
    }

    const targetDays = Array.isArray(days)
      ? days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
      : (day !== undefined && day !== null && day !== '' && Number.isInteger(Number(day)) && Number(day) >= 0 && Number(day) <= 6)
        ? [Number(day)]
        : null;

    if (targetDays) {
      if (replaceSchedule) {
        for (const k of Object.keys(state.week)) {
          const nextList = [].concat(state.week[k] || []).filter(id => id !== finalRoutineId);
          if (nextList.length) state.week[k] = nextList;
          else delete state.week[k];
        }
      }
      for (const d of targetDays) {
        const key = String(d);
        const currentList = [].concat(state.week[key] || []).filter(Boolean);
        if (!currentList.includes(finalRoutineId)) {
          currentList.push(finalRoutineId);
        }
        if (currentList.length) state.week[key] = currentList;
      }
    }

    if (recordNotice !== false) {
      const prescribedList = state.routines.filter(r => r?.prescribedBy);
      const activeList = prescribedList.length > 0 ? prescribedList : state.routines;
      state.prescriptionNotice = {
        id: 'pn_' + now + '_' + crypto.randomBytes(3).toString('hex'),
        at: now,
        trainerId: trainerUser?.id || 'staff',
        trainerName,
        routineIds: activeList.map(r => r.id),
        routineNames: activeList.map(r => r.name)
      };
    }

    return { state, result: routineRecord };
  });
}

/**
 * Prescreve ou atualiza um lote de fichas (ex.: Treinos A, B e C) atomicamente em uma única
 * transação (`BEGIN IMMEDIATE`), registrando um único `prescriptionNotice` consolidado para o aluno.
 */
export function prescribeRoutinesBatchToStudent(dataOrTenantDir, studentId, { routines = [], archivePrevious = false, replaceAll = false, trainerUser = null }, stateOps = null) {
  return mutateStudentStateAtomic(dataOrTenantDir, studentId, stateOps, (state) => {
    const now = Date.now();
    const trainerName = trainerUser?.name || 'Professor';
    const prescribedRecords = [];
    const replacedIds = replaceAll ? state.routines.map(r => r?.id).filter(Boolean) : [];

    if (archivePrevious && state.routines.length) {
      archiveRoutineSnapshotsInState(state, state.routines, { archivedAt: now, reason: replaceAll ? 'new_cycle' : 'renewed', trainerUser });
    }
    if (replaceAll) {
      state.routines = [];
      state.week = {};
    }

    for (const item of Array.isArray(routines) ? routines : []) {
      const rInput = item?.routine || item;
      if (!rInput || !rInput.name || !Array.isArray(rInput.ex)) continue;

      const routineId = rInput.id || 'r_' + crypto.randomBytes(6).toString('hex');
      const normalizedEx = rInput.ex.map(normalizeExerciseSlot);
      const targetName = String(rInput.name || 'Treino Prescrito').trim();

      const routineRecord = {
        id: routineId,
        name: targetName,
        emoji: String(rInput.emoji || rInput.glyph || 'figureStrength'),
        ex: normalizedEx,
        prescribedBy: {
          trainerId: trainerUser?.id || 'staff',
          name: trainerName,
          trainerName,
          at: now,
          initialWeights: captureInitialWeightsForRoutine(state, normalizedEx)
        }
      };

      const existingIdx = state.routines.findIndex(r => r.id === routineId || r.name === targetName);
      const finalRoutineId = existingIdx >= 0 && !archivePrevious ? state.routines[existingIdx].id : routineId;
      routineRecord.id = finalRoutineId;

      if (existingIdx >= 0) {
        replaceRoutineScheduleReferences(state, state.routines[existingIdx].id, finalRoutineId);
        state.routines[existingIdx] = routineRecord;
      } else {
        state.routines.push(routineRecord);
      }

      const rawDays = item?.days ?? rInput.days ?? rInput.suggestedDays;
      const rawDay = item?.day ?? rInput.day;
      const replaceSchedule = Boolean(item?.replaceSchedule ?? rInput.replaceSchedule);
      const targetDays = Array.isArray(rawDays)
        ? rawDays.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6)
        : (rawDay !== undefined && rawDay !== null && rawDay !== '' && Number.isInteger(Number(rawDay)) && Number(rawDay) >= 0 && Number(rawDay) <= 6)
          ? [Number(rawDay)]
          : null;

      if (targetDays) {
        if (replaceSchedule) {
          for (const k of Object.keys(state.week)) {
            const nextList = [].concat(state.week[k] || []).filter(id => id !== finalRoutineId);
            if (nextList.length) state.week[k] = nextList;
            else delete state.week[k];
          }
        }
        for (const d of targetDays) {
          const key = String(d);
          const currentList = [].concat(state.week[key] || []).filter(Boolean);
          if (!currentList.includes(finalRoutineId)) {
            currentList.push(finalRoutineId);
          }
          if (currentList.length) state.week[key] = currentList;
        }
      }

      prescribedRecords.push(routineRecord);
    }

    if (replacedIds.length) {
      const keptIds = new Set(state.routines.map(r => r.id));
      for (const id of replacedIds) {
        if (!keptIds.has(id)) replaceRoutineScheduleReferences(state, id, null);
      }
    }

    const prescribedList = state.routines.filter(r => r?.prescribedBy);
    const activeList = prescribedList.length > 0 ? prescribedList : state.routines;
    state.prescriptionNotice = {
      id: 'pn_' + now + '_' + crypto.randomBytes(3).toString('hex'),
      at: now,
      trainerId: trainerUser?.id || 'staff',
      trainerName,
      routineIds: activeList.map(r => r.id),
      routineNames: activeList.map(r => r.name)
    };

    return {
      state,
      result: {
        routines: prescribedRecords,
        allRoutines: state.routines,
        week: state.week,
        prescriptionNotice: state.prescriptionNotice
      }
    };
  });
}

/**
 * Remove uma rotina prescrita do aluno atomicamente e limpa referências em `state.week` e `state.dayPlan`.
 */
export function removeStudentRoutine(dataOrTenantDir, studentId, routineId, stateOps = null) {
  const res = mutateStudentStateAtomic(dataOrTenantDir, studentId, stateOps, (state, prev) => {
    if (!prev) return null;
    state.routines = state.routines.filter(r => r.id !== routineId);
    for (const d of Object.keys(state.week)) {
      const filtered = [].concat(state.week[d] || []).filter(id => id !== routineId);
      if (filtered.length) state.week[d] = filtered;
      else delete state.week[d];
    }
    for (const iso of Object.keys(state.dayPlan)) {
      if (state.dayPlan[iso] === routineId) delete state.dayPlan[iso];
    }
    return { state, result: true };
  });
  return Boolean(res);
}

/**
 * Atualiza diretamente a agenda semanal (`state.week`) do aluno atomicamente.
 */
export function updateStudentWeekSchedule(dataOrTenantDir, studentId, weekMap, stateOps = null) {
  return mutateStudentStateAtomic(dataOrTenantDir, studentId, stateOps, (state) => {
    const validRoutineIds = new Set(state.routines.map(r => r.id));
    const cleanWeek = {};
    if (weekMap && typeof weekMap === 'object') {
      for (let d = 0; d <= 6; d++) {
        const k = String(d);
        const raw = weekMap[k];
        if (!raw) continue;
        const ids = [].concat(raw).filter(id => validRoutineIds.has(id));
        if (ids.length) cleanWeek[k] = [...new Set(ids)];
      }
    }
    state.week = cleanWeek;
    return { state, result: state.week };
  });
}
