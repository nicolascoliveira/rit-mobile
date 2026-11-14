import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_GYM_TEMPLATES,
  isTrainerOrAdmin,
  loadTemplates,
  saveTemplates,
  importDefaultTemplates,
  upsertTemplate,
  removeTemplate,
  prescribeRoutineToStudent,
  removeStudentRoutine,
  readStudentState,
  listStudents
} from '../trainer.js';
import { getCatalogueIndex } from '../saas-routes.js';

test('isTrainerOrAdmin checks permissions correctly', () => {
  assert.equal(isTrainerOrAdmin({ admin: true }), true);
  assert.equal(isTrainerOrAdmin({ owner: true }), true);
  assert.equal(isTrainerOrAdmin({ role: 'trainer' }), true);
  assert.equal(isTrainerOrAdmin({ saasRole: 'gym_owner' }), true);
  assert.equal(isTrainerOrAdmin({ saasRole: 'superadmin' }), true);
  assert.equal(isTrainerOrAdmin({ role: 'student' }), false);
  assert.equal(isTrainerOrAdmin(null), false);
});

test('gym templates management (CRUD + default seeding)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-trainer-test-'));
  try {
    assert.deepEqual(loadTemplates(tmpDir), []);

    const tpl1 = upsertTemplate(tmpDir, {
      name: 'Adaptação Iniciante',
      description: 'Treino geral 3x na semana',
      ex: [{ id: '0025', sets: 3, reps: 10, weight: 20 }]
    });
    assert.ok(tpl1.id);
    assert.equal(tpl1.name, 'Adaptação Iniciante');
    assert.equal(tpl1.ex[0].weight, 20);

    upsertTemplate(tmpDir, { id: tpl1.id, name: 'Adaptação Iniciante v2', ex: tpl1.ex });
    assert.equal(loadTemplates(tmpDir)[0].name, 'Adaptação Iniciante v2');

    removeTemplate(tmpDir, tpl1.id);
    assert.equal(loadTemplates(tmpDir).length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('prescribeRoutineToStudent schedules onto state.week with sync stamps and calculates churn', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-prescribe-test-'));
  try {
    const studentId = 'u_aluno_123';
    const trainerUser = { id: 'u_prof_999', name: 'Prof. Carlos' };

    const prescribed = prescribeRoutineToStudent(tmpDir, studentId, {
      routine: {
        name: 'Peito e Tríceps A',
        emoji: 'arm',
        ex: [{ id: '0025', sets: 4, reps: 8, weight: 50, restSec: 120 }]
      },
      days: [1, 4], // Segunda e Quinta
      trainerUser
    });

    assert.equal(prescribed.name, 'Peito e Tríceps A');
    assert.equal(prescribed.prescribedBy.trainerName, 'Prof. Carlos');

    const state = readStudentState(tmpDir, studentId);
    assert.ok(state);
    assert.equal(state.routines.length, 1);
    assert.deepEqual(state.week['1'], [prescribed.id]);
    assert.deepEqual(state.week['4'], [prescribed.id]);
    assert.equal(state._rev, 1);
    assert.ok(state._wid);

    const fakeDb = {
      users: [
        { id: studentId, name: 'João Silva', role: 'student', tenantId: 'iron', created: new Date(Date.now() - 15 * 86400000).toISOString() },
        { id: 'u_prof_999', name: 'Prof. Carlos', role: 'trainer', tenantId: 'iron' },
        { id: 'u_other_gym', name: 'Aluno Outra Academia', role: 'student', tenantId: 'outra' }
      ]
    };
    const students = listStudents(fakeDb, tmpDir, { tenantId: 'iron', churnDaysThreshold: 5 });
    assert.equal(students.length, 1);
    assert.equal(students[0].name, 'João Silva');
    assert.equal(students[0].routineCount, 1);
    assert.equal(students[0].prescribedCount, 1);
    assert.equal(students[0].churnStatus, 'critical'); // criado há 15 dias sem treinos

    removeStudentRoutine(tmpDir, studentId, prescribed.id);
    const afterDel = readStudentState(tmpDir, studentId);
    assert.equal(afterDel.routines.length, 0);
    assert.equal(afterDel.week['1'], undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('DEFAULT_GYM_TEMPLATES use valid catalogue IDs and v2 backfill preserves custom templates', () => {
  const idx = getCatalogueIndex();
  assert.ok(DEFAULT_GYM_TEMPLATES.length >= 20);
  const stillDir = path.resolve(process.cwd(), 'catalogue', 'media', 'still');
  const hasStillDir = fs.existsSync(stillDir);
  for (const tpl of DEFAULT_GYM_TEMPLATES) {
    assert.ok(tpl.id && tpl.name && tpl.category);
    assert.ok(Array.isArray(tpl.ex) && tpl.ex.length > 0);
    for (const slot of tpl.ex) {
      assert.ok(idx.byId.has(slot.id), `Missing exercise ID ${slot.id} in ${tpl.id}`);
      if (hasStillDir) {
        assert.ok(fs.existsSync(path.join(stillDir, `${slot.id}.webp`)), `Missing still image for ${slot.id}`);
      }
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-seedv2-test-'));
  try {
    // Simula academia antiga (v1) com um modelo antigo bugado (0575 como Leg Press) + 1 customizado
    saveTemplates(tmpDir, [
      {
        id: 'tpl_adapt_fullbody',
        name: 'Adaptação Antiga',
        ex: [{ id: '0575', name: 'Leg Press 45°', sets: 3, reps: 12, weight: 40 }]
      },
      {
        id: 'tpl_custom_academia',
        name: 'Meu Treino Customizado',
        ex: [{ id: '0025', name: 'Supino com barra', sets: 4, reps: 8, weight: 40 }]
      }
    ]);

    const backfilled = loadTemplates(tmpDir, { seedIfMissing: true });
    assert.equal(backfilled.length, DEFAULT_GYM_TEMPLATES.length + 1);
    assert.ok(backfilled.some(t => t.id === 'tpl_custom_academia'));
    const adapt = backfilled.find(t => t.id === 'tpl_adapt_fullbody');
    assert.equal(adapt.ex[0].id, '0739');

    // Se o gestor excluir um modelo padrão depois do backfill, o próximo load não recria sozinho
    removeTemplate(tmpDir, 'tpl_abcde_e');
    const afterRemove = loadTemplates(tmpDir, { seedIfMissing: true });
    assert.equal(afterRemove.some(t => t.id === 'tpl_abcde_e'), false);

    // Mas importDefaultTemplates permite reimportar sob demanda sem mexer nos demais
    const imported = importDefaultTemplates(tmpDir);
    assert.equal(imported.added, 1);
    assert.ok(imported.templates.some(t => t.id === 'tpl_abcde_e'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
