import React, { useEffect, useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import {
  Button,
  Modal,
  TextField,
  NumberField,
  SelectField,
  SearchField,
  ChipBar,
  Stepper,
  Segmented
} from './ui.jsx';
import { portalApi, toast } from '../lib/api.js';
import ExerciseMediaModal, { GymExThumb } from './ExerciseMediaModal.jsx';

const ROUTINE_GLYPHS = [
  { id: 'figureStrength', label: 'Geral' },
  { id: 'arm', label: 'Superiores' },
  { id: 'pullup', label: 'Costas' },
  { id: 'legs', label: 'Pernas' },
  { id: 'barbell', label: 'Barra' },
  { id: 'dumbbell', label: 'Halteres' },
  { id: 'flame', label: 'Intenso' },
  { id: 'heart', label: 'Cardio' }
];

const WEEKDAYS = [
  { d: 1, label: 'Seg' },
  { d: 2, label: 'Ter' },
  { d: 3, label: 'Qua' },
  { d: 4, label: 'Qui' },
  { d: 5, label: 'Sex' },
  { d: 6, label: 'Sáb' },
  { d: 0, label: 'Dom' }
];

const BP_FILTERS = [
  { value: '', label: 'Todos' },
  { value: 'chest', label: 'Peito' },
  { value: 'back', label: 'Costas' },
  { value: 'upper legs', label: 'Pernas & Glúteos' },
  { value: 'shoulders', label: 'Ombros' },
  { value: 'upper arms', label: 'Bíceps & Tríceps' },
  { value: 'lower arms', label: 'Antebraços' },
  { value: 'lower legs', label: 'Panturrilhas' },
  { value: 'waist', label: 'Abdômen' },
  { value: 'full body', label: 'Corpo Inteiro' },
  { value: 'cardio', label: 'Cardio' },
  { value: 'neck', label: 'Pescoço' }
];

const dayLabel = d => WEEKDAYS.find(w => w.d === d)?.label || String(d);
const sortDays = list => [...list].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Seg → Dom
const letterOf = idx => String.fromCharCode(65 + (idx % 26));

let workoutKeySeq = 0;
const newKey = () => `wk_${Date.now().toString(36)}_${workoutKeySeq++}`;

const mapExercise = x => ({
  id: x.id || '0025',
  name: x.name || x.id,
  sets: Number(x.sets) || 3,
  reps: Number(x.reps) || 10,
  weight: Number(x.weight) || 0,
  restSec: Number(x.restSec) || 90,
  prog: x.prog || 'double',
  note: x.note || '',
  thumb: `/exercise-media/still/${x.id || '0025'}.webp`
});

const makeWorkout = ({ id, name, emoji, days, ex } = {}) => ({
  key: newKey(),
  id: id || undefined,
  name: name || '',
  emoji: emoji || 'figureStrength',
  days: Array.isArray(days) ? days : [],
  exercises: Array.isArray(ex) ? ex.map(mapExercise) : []
});

/**
 * Estúdio de Prescrição & Criador de Modelos integrado ao catálogo real de 5.632 exercícios do Rit.
 * Pode operar em dois modos:
 *  - `mode="prescribe"`: prescreve/edita ficha diretamente no app de um aluno (`student`)
 *  - `mode="template"`: cria/edita um modelo reutilizável da academia
 *
 * Uma ficha pode ter vários treinos (A, B, C…), cada um com os seus próprios dias da semana e a sua
 * própria lista de exercícios: "segunda treina estes, terça treina aqueles". Cada treino vira uma
 * rotina do aluno (ou um modelo da academia), agendada nos dias escolhidos para ele.
 */
export default function WorkoutBuilderModal({
  open,
  onClose,
  mode = 'prescribe',
  student = null,
  initialRoutine = null,
  initialDays = [1, 4],
  templates = [],
  onSaved
}) {
  const [workouts, setWorkouts] = useState(() => [makeWorkout({ name: '', days: [1, 4] })]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [category, setCategory] = useState('Hipertrofia');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  // Estado do buscador de catálogo
  const [query, setQuery] = useState('');
  const [bp, setBp] = useState('');
  const [eq, setEq] = useState('');
  const [equipments, setEquipments] = useState([]);
  const [catResults, setCatResults] = useState([]);
  const [catTotal, setCatTotal] = useState(0);
  const [catHasMore, setCatHasMore] = useState(false);
  const [catLoading, setCatLoading] = useState(false);
  const [catLoadingMore, setCatLoadingMore] = useState(false);
  const [customOnly, setCustomOnly] = useState(false);
  const [catVersion, setCatVersion] = useState(0);
  const [tenantOverrides, setTenantOverrides] = useState({});
  const [tenantCustomList, setTenantCustomList] = useState([]);
  const [mediaCaps, setMediaCaps] = useState(null);
  const [mediaModal, setMediaModal] = useState(null);
  const [mobilePane, setMobilePane] = useState('routine');
  const [validationError, setValidationError] = useState(null);
  const [attemptedSave, setAttemptedSave] = useState(false);

  useEffect(() => {
    setValidationError(null);
  }, [workouts]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    portalApi('/api/gym/exercise-media')
      .then(res => {
        if (cancelled) return;
        setTenantOverrides(res?.overrides || {});
        setTenantCustomList(Array.isArray(res?.customExercises) ? res.customExercises : []);
        if (res?.media) setMediaCaps(res.media);
      })
      .catch(() => { /* fallback silencioso */ });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    setValidationError(null);
  }, [workouts]);

  useEffect(() => {
    if (!open) return;
    setMobilePane('routine');
    setCustomOnly(false);
    setMediaModal(null);
    setActiveIdx(0);
    setValidationError(null);
    setAttemptedSave(false);
    if (initialRoutine) {
      setCategory(initialRoutine.category || 'Hipertrofia');
      setDescription(initialRoutine.description || '');
      setWorkouts([
        makeWorkout({
          id: initialRoutine.id,
          name: initialRoutine.name || '',
          emoji: initialRoutine.emoji || initialRoutine.glyph,
          days:
            Array.isArray(initialRoutine.suggestedDays) && initialRoutine.suggestedDays.length
              ? initialRoutine.suggestedDays
              : initialDays,
          ex: initialRoutine.ex
        })
      ]);
    } else {
      setCategory('Hipertrofia');
      setDescription('');
      setWorkouts([
        makeWorkout({
          name: mode === 'prescribe' ? 'Treino A — Personalizado' : 'Novo Modelo da Academia',
          days: initialDays
        })
      ]);
    }
  }, [open, initialRoutine, mode]);

  useEffect(() => {
    setValidationError(null);
  }, [workouts]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setCatLoading(true);
      try {
        const sp = new URLSearchParams({ limit: '48', offset: '0' });
        if (query.trim()) sp.set('q', query.trim());
        if (bp) sp.set('bp', bp);
        if (eq) sp.set('eq', eq);
        if (customOnly) sp.set('customOnly', '1');
        const res = await portalApi(`/api/saas/catalogue?${sp.toString()}`);
        if (!cancelled) {
          const list = res.exercises || [];
          const total = Number(res.total) || list.length;
          setCatResults(list);
          setCatTotal(total);
          setCatHasMore(typeof res.hasMore === 'boolean' ? res.hasMore : list.length < total);
          if (Array.isArray(res.equipments) && res.equipments.length > 0 && equipments.length === 0) {
            setEquipments(res.equipments);
          }
        }
      } catch {
        if (!cancelled) {
          setCatResults([]);
          setCatTotal(0);
          setCatHasMore(false);
        }
      } finally {
        if (!cancelled) setCatLoading(false);
      }
    }, 180);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, query, bp, eq, customOnly, catVersion]);

  const loadMoreCatalogue = async () => {
    if (catLoading || catLoadingMore || !catHasMore) return;
    setCatLoadingMore(true);
    try {
      const sp = new URLSearchParams({ limit: '48', offset: String(catResults.length) });
      if (query.trim()) sp.set('q', query.trim());
      if (bp) sp.set('bp', bp);
      if (eq) sp.set('eq', eq);
      if (customOnly) sp.set('customOnly', '1');
      const res = await portalApi(`/api/saas/catalogue?${sp.toString()}`);
      const next = res.exercises || [];
      setCatResults(prev => {
        const seen = new Set(prev.map(x => x.id));
        const merged = [...prev, ...next.filter(x => !seen.has(x.id))];
        const total = Number(res.total) || merged.length;
        setCatTotal(total);
        setCatHasMore(typeof res.hasMore === 'boolean' ? res.hasMore : merged.length < total);
        return merged;
      });
    } catch {
      toast('Erro ao carregar mais exercícios');
    } finally {
      setCatLoadingMore(false);
    }
  };

  const safeIdx = Math.min(activeIdx, workouts.length - 1);
  const active = workouts[safeIdx];
  const exercises = active.exercises;
  const multi = workouts.length > 1;
  const unitLabel = mode === 'prescribe' ? 'treino' : 'modelo';

  // Qual treino (índice) é dono de cada dia da semana.
  const dayOwners = useMemo(() => {
    const map = {};
    workouts.forEach((w, i) => w.days.forEach(d => { map[d] = i; }));
    return map;
  }, [workouts]);

  const totalExercises = useMemo(() => workouts.reduce((n, w) => n + w.exercises.length, 0), [workouts]);

  const patchWorkout = (idx, patch) => {
    setWorkouts(prev => prev.map((w, i) => (i === idx ? { ...w, ...(typeof patch === 'function' ? patch(w) : patch) } : w)));
  };

  const patchActive = patch => patchWorkout(safeIdx, patch);

  const toggleDay = d => {
    const owner = dayOwners[d];
    if (owner === undefined || owner === safeIdx) {
      patchActive(w => ({ days: w.days.includes(d) ? w.days.filter(x => x !== d) : sortDays([...w.days, d]) }));
      return;
    }
    // O dia já pertence a outro treino: passa para o treino atual (um dia, um treino).
    const from = workouts[owner];
    setWorkouts(prev => prev.map((w, i) => {
      if (i === owner) return { ...w, days: w.days.filter(x => x !== d) };
      if (i === safeIdx) return { ...w, days: sortDays([...w.days, d]) };
      return w;
    }));
    toast(`${dayLabel(d)} passou de "${from.name || `Treino ${letterOf(owner)}`}" para "${active.name || `Treino ${letterOf(safeIdx)}`}"`);
  };

  const addWorkout = () => {
    const usedLetters = new Set(workouts.map(w => w.name.trim().toLowerCase()));
    let n = workouts.length;
    let nextName = mode === 'prescribe' ? `Treino ${letterOf(n)}` : `Modelo ${letterOf(n)}`;
    while (usedLetters.has(nextName.toLowerCase())) { n += 1; nextName = (mode === 'prescribe' ? 'Treino ' : 'Modelo ') + letterOf(n); }
    setWorkouts(prev => [...prev, makeWorkout({ name: nextName, emoji: active.emoji, days: [] })]);
    setActiveIdx(workouts.length);
    setAttemptedSave(false);
    setValidationError(null);
    toast(`${nextName} criado. Defina nome, dias ou carregue um modelo.`);
  };

  const duplicateWorkout = () => {
    const copy = makeWorkout({
      name: `${active.name || 'Treino'} (cópia)`,
      emoji: active.emoji,
      days: [],
      ex: active.exercises
    });
    setWorkouts(prev => [...prev.slice(0, safeIdx + 1), copy, ...prev.slice(safeIdx + 1)]);
    setActiveIdx(safeIdx + 1);
    setAttemptedSave(false);
    setValidationError(null);
    toast('Treino duplicado. Escolha os dias dele.');
  };

  const removeWorkoutAt = idx => {
    if (workouts.length <= 1) return;
    const target = workouts[idx];
    if (!target) return;
    const label = target.name || `Treino ${letterOf(idx)}`;
    if (target.exercises.length > 0 && !window.confirm(`Remover "${label}" e os ${target.exercises.length} exercícios dele?`)) return;
    setWorkouts(prev => prev.filter((_, i) => i !== idx));
    setActiveIdx(prev => (prev > idx ? prev - 1 : Math.max(0, Math.min(prev, workouts.length - 2))));
    setValidationError(null);
  };

  const removeWorkout = () => removeWorkoutAt(safeIdx);

  const applyTemplate = tplId => {
    const tpl = templates.find(t => t.id === tplId);
    if (!tpl) return;
    patchActive({
      name: tpl.name,
      emoji: tpl.emoji || 'figureStrength',
      ...(Array.isArray(tpl.suggestedDays) && tpl.suggestedDays.length
        ? { days: sortDays(tpl.suggestedDays.filter(d => dayOwners[d] === undefined || dayOwners[d] === safeIdx)) }
        : {}),
      exercises: (tpl.ex || []).map(mapExercise)
    });
    toast(`Modelo "${tpl.name}" carregado`);
  };

  const addExerciseFromCatalogue = item => {
    patchActive(w => ({
      exercises: [
        ...w.exercises,
        {
          id: item.id,
          name: item.name,
          sets: 3,
          reps: 10,
          weight: item.eq === 'body weight' ? 0 : 20,
          restSec: 90,
          prog: 'double',
          note: '',
          thumb: item.thumb || `/exercise-media/still/${item.id}.webp`
        }
      ]
    }));
    toast(`+ "${item.name}" adicionado a ${active.name || `Treino ${letterOf(safeIdx)}`}`);
  };

  const updateSlot = (idx, field, val) => {
    patchActive(w => ({ exercises: w.exercises.map((it, i) => (i === idx ? { ...it, [field]: val } : it)) }));
  };

  const moveSlot = (idx, dir) => {
    const target = idx + dir;
    if (target < 0 || target >= exercises.length) return;
    patchActive(w => {
      const next = w.exercises.slice();
      const [picked] = next.splice(idx, 1);
      next.splice(target, 0, picked);
      return { exercises: next };
    });
  };

  const removeSlot = idx => {
    patchActive(w => ({ exercises: w.exercises.filter((_, i) => i !== idx) }));
  };

  const validate = () => {
    setAttemptedSave(true);
    const seen = new Map();
    for (let i = 0; i < workouts.length; i++) {
      const w = workouts[i];
      const label = w.name.trim() || `Treino ${letterOf(i)}`;
      if (!w.name.trim()) {
        const msg = multi ? `Informe o nome do treino ${letterOf(i)} antes de salvar.` : 'Informe o nome da ficha antes de salvar.';
        setActiveIdx(i);
        setMobilePane('routine');
        setValidationError({ idx: i, type: 'name', message: msg });
        toast(msg);
        requestAnimationFrame(() => document.getElementById('b2b-wk-name-input')?.focus());
        return false;
      }
      if (w.exercises.length === 0) {
        const msg = multi
          ? `"${label}" está sem exercícios. Adicione pelo menos 1 exercício ou remova este treino para salvar.`
          : 'A ficha está vazia. Adicione pelo menos 1 exercício do catálogo para salvar.';
        setActiveIdx(i);
        setValidationError({ idx: i, type: 'empty', message: msg });
        toast(msg);
        return false;
      }
      const k = w.name.trim().toLowerCase();
      if (seen.has(k)) {
        const msg = `Dois treinos com o nome "${w.name.trim()}". Use um nome diferente para cada treino.`;
        setActiveIdx(i);
        setMobilePane('routine');
        setValidationError({ idx: i, type: 'duplicate', message: msg });
        toast(msg);
        requestAnimationFrame(() => document.getElementById('b2b-wk-name-input')?.focus());
        return false;
      }
      seen.set(k, i);
    }
    setValidationError(null);
    return true;
  };

  const handleSave = async () => {
    if (!validate()) return;

    setSaving(true);
    try {
      if (mode === 'prescribe') {
        for (let i = 0; i < workouts.length; i++) {
          const w = workouts[i];
          await portalApi('/api/gym/prescribe', {
            method: 'POST',
            body: {
              studentId: student.id,
              days: w.days,
              replaceSchedule: true,
              // O aluno recebe um único aviso no WhatsApp, no último treino salvo.
              notifyWhatsApp: i === workouts.length - 1,
              routine: {
                id: w.id,
                name: w.name.trim(),
                emoji: w.emoji,
                ex: w.exercises
              }
            }
          });
        }
        toast(
          multi
            ? `${workouts.length} treinos sincronizados no app de ${student.name}!`
            : `Ficha sincronizada no app de ${student.name}!`
        );
      } else {
        for (const w of workouts) {
          await portalApi('/api/gym/templates', {
            method: 'POST',
            body: {
              id: w.id,
              name: w.name.trim(),
              category: category.trim() || 'Geral',
              description: description.trim(),
              emoji: w.emoji,
              suggestedDays: w.days,
              ex: w.exercises
            }
          });
        }
        toast(
          multi
            ? `${workouts.length} modelos salvos na biblioteca da academia!`
            : 'Modelo de ficha salvo na biblioteca da academia!'
        );
      }
      onSaved?.();
      onClose?.();
    } catch (err) {
      toast(err.message || 'Erro ao salvar ficha');
    } finally {
      setSaving(false);
    }
  };

  const activeLabel = active.name.trim() || `Treino ${letterOf(safeIdx)}`;
  const saveLabel = saving
    ? 'Salvando...'
    : mode === 'prescribe'
      ? (multi ? `Salvar ${workouts.length} Treinos no App do Aluno` : 'Salvar e Sincronizar no App do Aluno')
      : (multi ? `Salvar ${workouts.length} Modelos na Academia` : 'Salvar Modelo na Academia');

  const iconPicker = (
    <div>
      <div className="b2b-field-lbl" style={{ marginBottom: 6 }}>
        {mode === 'prescribe' ? 'Ícone no App do Aluno' : 'Ícone do Modelo'}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {ROUTINE_GLYPHS.map(g => (
          <button
            type="button"
            key={g.id}
            onClick={() => patchActive({ emoji: g.id })}
            title={g.label}
            className={'b2b-day-pill' + (active.emoji === g.id ? ' on' : '')}
            style={{ minWidth: 38, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name={g.id} size={18} />
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={
        mode === 'prescribe'
          ? `${initialRoutine?.id ? 'Editar Ficha' : 'Prescrever Treino'} — ${student?.name || ''}`
          : initialRoutine?.id ? 'Editar Modelo da Academia' : 'Novo Modelo de Ficha da Academia'
      }
      subtitle="Conectado ao catálogo oficial Rit (5.632 exercícios com animações e progressão automática)"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button variant="primary" icon="check" onClick={handleSave} disabled={saving}>
            {saveLabel}
          </Button>
        </>
      }
    >
      {/* Treinos da ficha (A, B, C…): sempre visível no topo (desktop e mobile) */}
      <div className="b2b-wk-bar">
        <div className="b2b-wk-tabs" role="tablist" aria-label="Treinos da ficha">
          {workouts.map((w, i) => {
            const trimmedName = w.name.trim().toLowerCase();
            const dup = Boolean(trimmedName) && workouts.some((other, j) => j !== i && other.name.trim().toLowerCase() === trimmedName);
            const hasErr = attemptedSave && (!trimmedName || w.exercises.length === 0 || dup);
            return (
              <button
                type="button"
                key={w.key}
                role="tab"
                aria-selected={i === safeIdx}
                className={'b2b-wk-tab' + (i === safeIdx ? ' on' : '') + (hasErr ? ' has-error' : '')}
                onClick={() => setActiveIdx(i)}
              >
                <span className="b2b-wk-letter">{letterOf(i)}</span>
                <span className="b2b-wk-meta">
                  <b>{w.name.trim() || `Treino ${letterOf(i)}`}</b>
                  <small>
                    {w.days.length ? sortDays(w.days).map(dayLabel).join(' · ') : 'Sem dia fixo'}
                    {' · '}
                    {w.exercises.length} ex.
                  </small>
                </span>
              </button>
            );
          })}
          <button type="button" className="b2b-wk-add" onClick={addWorkout} title={`Adicionar outro ${unitLabel} com dias e exercícios próprios`}>
            <Icon name="plus" size={15} />
            <span>{mode === 'prescribe' ? 'Novo treino' : 'Novo modelo'}</span>
          </button>
        </div>
      </div>

      {validationError && (
        <div className="b2b-builder-alert" role="alert">
          <div className="b2b-builder-alert-main">
            <Icon name="warning" size={18} className="b2b-builder-alert-icon" />
            <span>{validationError.message}</span>
          </div>
          {validationError.type === 'empty' && (
            <div className="b2b-builder-alert-actions">
              {mobilePane !== 'catalogue' && (
                <span className="b2b-builder-only-mobile">
                  <Button
                    variant="tinted"
                    size="sm"
                    icon="magnifier"
                    onClick={() => setMobilePane('catalogue')}
                  >
                    Abrir Catálogo
                  </Button>
                </span>
              )}
              {multi && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon="trash"
                  style={{ color: 'var(--red)' }}
                  onClick={() => removeWorkoutAt(validationError.idx)}
                >
                  Remover {workouts[validationError.idx]?.name.trim() || `Treino ${letterOf(validationError.idx)}`}
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="b2b-builder-tabs">
        <Segmented
          value={mobilePane}
          onChange={setMobilePane}
          options={[
            { value: 'routine', label: `Ficha (${exercises.length})`, icon: 'dumbbell' },
            { value: 'catalogue', label: 'Catálogo', icon: 'magnifier' }
          ]}
        />
      </div>

      <div className="b2b-grid-equal b2b-builder-grid" data-pane={mobilePane} style={{ marginBottom: 0, alignItems: 'start' }}>
        {/* Lado Esquerdo: Ficha Montada */}
        <div className="b2b-builder-col-routine">
          {mode === 'prescribe' && templates.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <SelectField
                label={`Carregar um Modelo Pronto da Academia em "${activeLabel}" (Opcional)`}
                value=""
                onChange={val => { if (val) applyTemplate(val); }}
                options={[
                  { value: '', label: `— Escolher entre ${templates.length} modelos da academia —` },
                  ...templates.map(t => ({
                    value: t.id,
                    label: `[${t.category || 'Geral'}] ${t.name} (${t.ex?.length || 0} ex.)`
                  }))
                ]}
              />
            </div>
          )}

          <div className="b2b-form-grid" style={{ marginBottom: 14 }}>
            <TextField
              id="b2b-wk-name-input"
              className={validationError && validationError.idx === safeIdx && (validationError.type === 'name' || validationError.type === 'duplicate') ? 'b2b-field-invalid' : ''}
              label={multi ? `Nome do Treino ${letterOf(safeIdx)}` : 'Nome da Ficha / Treino'}
              required
              value={active.name}
              onChange={v => patchActive({ name: v })}
              placeholder="Ex: Treino A — Peito, Ombro e Tríceps"
            />
            {mode === 'template' ? (
              <TextField
                label="Categoria"
                value={category}
                onChange={setCategory}
                placeholder="Ex: Adaptação, Hipertrofia ABC, Emagrecimento"
              />
            ) : iconPicker}
          </div>

          {mode === 'template' && (
            <div className="b2b-form-grid" style={{ marginBottom: 14 }}>
              <TextField
                label="Descrição rápida para a equipe"
                value={description}
                onChange={setDescription}
                placeholder="Ex: Indicado para alunos intermediários 4x a 6x por semana"
              />
              {iconPicker}
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <div className="b2b-field-lbl" style={{ marginBottom: 6 }}>
              {mode === 'prescribe'
                ? `Dias em que o aluno faz ${multi ? activeLabel : 'este treino'}`
                : `Dias da Semana Sugeridos para ${multi ? activeLabel : 'este modelo'}`}
            </div>
            <div className="b2b-days-row">
              {WEEKDAYS.map(w => {
                const owner = dayOwners[w.d];
                const mine = owner === safeIdx;
                const taken = owner !== undefined && !mine;
                return (
                  <button
                    type="button"
                    key={w.d}
                    className={'b2b-day-pill' + (mine ? ' on' : '') + (taken ? ' taken' : '')}
                    onClick={() => toggleDay(w.d)}
                    title={taken ? `${w.label}: ${workouts[owner].name || `Treino ${letterOf(owner)}`} (toque para mover para este treino)` : undefined}
                  >
                    {w.label}
                    {(mine || taken) && multi && <i className="b2b-day-owner">{letterOf(owner)}</i>}
                  </button>
                );
              })}
            </div>
            {multi && (
              <div className="muted small" style={{ marginTop: 6, lineHeight: 1.4 }}>
                A letra no dia mostra qual treino cai nele. Tocar num dia de outro treino move o dia para {activeLabel}.
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <span className="b2b-field-lbl">
              {multi ? `Exercícios de ${activeLabel}` : 'Exercícios Prescritos'} ({exercises.length})
            </span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {exercises.length > 0 && !multi && (
                <span className="muted small">Séries · Reps · Carga · Descanso</span>
              )}
              <Button variant="ghost" size="sm" icon="copy" onClick={duplicateWorkout} title={`Duplicar ${activeLabel}`}>
                Duplicar
              </Button>
              {multi && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon="trash"
                  onClick={removeWorkout}
                  title={`Remover ${activeLabel}`}
                  style={{ color: 'var(--red)' }}
                >
                  Remover
                </Button>
              )}
            </div>
          </div>

          {exercises.length === 0 ? (
            <div style={{ padding: '28px 16px', textAlign: 'center', background: 'var(--bg-el)', borderRadius: 'var(--r)', border: '1px dashed var(--sep)' }}>
              <Icon name="dumbbell" size={26} style={{ opacity: 0.5, marginBottom: 6 }} />
              <div style={{ fontWeight: 600, fontSize: 14 }}>{multi ? `${activeLabel} ainda está vazio` : 'Ficha ainda vazia'}</div>
              <div className="muted small">
                {multi
                  ? `Os exercícios que você tocar no catálogo entram só em ${activeLabel}.`
                  : 'Clique nos exercícios do catálogo para adicioná-los à prescrição.'}
              </div>
              <div className="b2b-builder-only-mobile" style={{ marginTop: 12 }}>
                <Button variant="tinted" size="sm" icon="plus" onClick={() => setMobilePane('catalogue')}>
                  Abrir Catálogo de Exercícios
                </Button>
              </div>
            </div>
          ) : (
            <div style={{ maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
              {exercises.map((slot, idx) => {
                const cx = tenantCustomList.find(c => c.id === slot.id) || null;
                const ov = !cx ? tenantOverrides[slot.id] || null : null;
                const slotMedia = cx?.media || ov?.media || null;
                const slotUrl = cx?.url || ov?.url || '';
                const slotHasVideo = Boolean(slotMedia || slotUrl);
                const isCustomId = Boolean(cx || String(slot.id).startsWith('tx_'));
                return (
                <div key={`${slot.id}-${idx}`} className="b2b-ex-slot">
                  <div className="b2b-ex-slot-top">
                    <GymExThumb
                      exerciseId={slot.id}
                      tenantCustom={isCustomId}
                      customMedia={slotMedia}
                      customUrl={slotUrl}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>{idx + 1}. {cx?.name || slot.name}</span>
                        {slotHasVideo && (
                          <span className="b2b-video-tag">
                            <Icon name="video" size={14} />
                            <span>Vídeo da academia</span>
                          </span>
                        )}
                      </div>
                      <div className="muted" style={{ fontSize: 14 }}>
                        {isCustomId ? 'Exercício da academia' : `ID #${slot.id}`}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        type="button"
                        className={'b2b-icon-btn' + (slotHasVideo ? ' is-accent' : '')}
                        onClick={() => setMediaModal({
                          mode: isCustomId ? 'custom' : 'override',
                          exercise: cx
                            ? { ...cx, customMedia: cx.media || null, customUrl: cx.url || '' }
                            : {
                                id: slot.id,
                                name: slot.name,
                                customMedia: ov?.media || null,
                                customUrl: ov?.url || '',
                                customNote: ov?.note || ''
                              }
                        })}
                        title={isCustomId ? 'Editar exercício e vídeo' : 'Trocar vídeo deste exercício'}
                      >
                        <Icon name={isCustomId ? 'pencil' : 'video'} size={15} />
                      </button>
                      <button type="button" className="b2b-icon-btn" onClick={() => moveSlot(idx, -1)} disabled={idx === 0} title="Subir">
                        <Icon name="arrowUp" size={14} />
                      </button>
                      <button type="button" className="b2b-icon-btn" onClick={() => moveSlot(idx, 1)} disabled={idx === exercises.length - 1} title="Descer">
                        <Icon name="arrowDown" size={14} />
                      </button>
                      <button type="button" className="b2b-icon-btn" onClick={() => removeSlot(idx)} style={{ color: 'var(--red)' }} title="Remover">
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </div>

                  <div className="b2b-ex-controls">
                    <div>
                      <div className="b2b-field-lbl" style={{ marginBottom: 4 }}>Séries</div>
                      <Stepper value={slot.sets} min={1} max={12} onChange={v => updateSlot(idx, 'sets', v)} />
                    </div>
                    <div>
                      <div className="b2b-field-lbl" style={{ marginBottom: 4 }}>Repetições</div>
                      <Stepper value={slot.reps} min={1} max={60} onChange={v => updateSlot(idx, 'reps', v)} />
                    </div>
                    <NumberField
                      label="Carga Inicial"
                      value={slot.weight}
                      min={0}
                      step={1}
                      suffix="kg"
                      onChange={v => updateSlot(idx, 'weight', v === '' ? 0 : v)}
                    />
                    <SelectField
                      label="Descanso"
                      value={String(slot.restSec || 90)}
                      onChange={v => updateSlot(idx, 'restSec', Number(v))}
                      options={[
                        { value: '45', label: '45s' },
                        { value: '60', label: '1 min' },
                        { value: '75', label: '1m 15s' },
                        { value: '90', label: '1m 30s' },
                        { value: '120', label: '2 min' },
                        { value: '180', label: '3 min' }
                      ]}
                    />
                  </div>

                  <div style={{ marginTop: 8 }}>
                    <input
                      type="text"
                      className="field"
                      style={{ minHeight: 38, padding: '6px 10px' }}
                      placeholder="Observação do professor para o aluno (ex: cadência 3010, banco 30°, amplitude máxima)..."
                      value={slot.note || ''}
                      onChange={e => updateSlot(idx, 'note', e.target.value)}
                    />
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Lado Direito: Catálogo Real de 5.632 Exercícios */}
        <div className="b2b-builder-col-cat" style={{ background: 'var(--bg)', padding: 16, borderRadius: 'var(--r-lg)', border: 'var(--hair) solid var(--sep)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>Catálogo de Exercícios (PT-BR)</div>
              <span className="muted num" style={{ fontSize: 14 }}>
                {catLoading ? 'Buscando...' : `Exibindo ${catResults.length} de ${catTotal}`}
              </span>
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon="plus"
              onClick={() => setMediaModal({ mode: 'custom', exercise: null })}
            >
              Novo exercício
            </Button>
          </div>

          {multi && (
            <div className="b2b-cat-target">
              <span className="b2b-wk-letter">{letterOf(safeIdx)}</span>
              <span>
                Adicionando em <b>{activeLabel}</b>
                {active.days.length > 0 && <> · {sortDays(active.days).map(dayLabel).join(', ')}</>}
              </span>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: equipments.length > 0 ? '1fr minmax(140px, 180px)' : '1fr', gap: 8, alignItems: 'end' }}>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="Buscar exercício: supino, agachamento, puxada, rosca..."
            />
            {equipments.length > 0 && (
              <SelectField
                label="Equipamento"
                value={eq}
                onChange={setEq}
                options={[
                  { value: '', label: 'Todos equipamentos' },
                  ...equipments.map(item => ({ value: item.id, label: item.label }))
                ]}
              />
            )}
          </div>

          <div className="b2b-custom-filter-row">
            <button
              type="button"
              className={'chip ichip nocap b2b-custom-filter-btn' + (customOnly ? ' on' : '')}
              onClick={() => setCustomOnly(v => !v)}
            >
              <Icon name="video" size={14} />
              <span>Com vídeo da academia / próprios</span>
            </button>
          </div>

          <div style={{ margin: '6px 0 12px' }}>
            <ChipBar items={BP_FILTERS} value={bp} onChange={setBp} />
          </div>

          <div className="b2b-cat-grid">
            {catResults.map(item => {
              const addedCount = exercises.filter(x => x.id === item.id).length;
              const liveOv = !item.tenantCustom ? tenantOverrides[item.id] : null;
              const hasVideo = Boolean(
                item.hasCustomVideo ||
                item.customMedia ||
                item.customUrl ||
                liveOv?.media ||
                liveOv?.url
              );
              const mediaObj = liveOv?.media || item.customMedia || null;
              const mediaUrl = liveOv?.url ?? item.customUrl ?? '';
              return (
                <div
                  key={item.id}
                  className={'b2b-cat-item' + (addedCount > 0 ? ' added' : '')}
                >
                  <button
                    type="button"
                    className="b2b-cat-main"
                    onClick={() => addExerciseFromCatalogue(item)}
                  >
                    <GymExThumb
                      exerciseId={item.id}
                      tenantCustom={Boolean(item.tenantCustom)}
                      customMedia={mediaObj}
                      customUrl={mediaUrl}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.3, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>{item.name}</span>
                        {addedCount > 0 && (
                          <span className="b2b-cat-badge">
                            <Icon name="check" size={12} />
                            <span>{addedCount > 1 ? `No ${multi ? letterOf(safeIdx) : 'treino'} (${addedCount}×)` : (multi ? `No treino ${letterOf(safeIdx)}` : 'Na ficha')}</span>
                          </span>
                        )}
                        {hasVideo && (
                          <span className="b2b-video-tag">
                            <Icon name="video" size={13} />
                            <span>{item.tenantCustom ? 'Da academia' : 'Vídeo próprio'}</span>
                          </span>
                        )}
                      </div>
                      <div className="muted" style={{ fontSize: 14, marginTop: 2 }}>
                        {item.bpLabel} · {item.eqLabel}
                      </div>
                    </div>
                  </button>
                  <div className="b2b-cat-actions">
                    <button
                      type="button"
                      className={'b2b-icon-btn' + (hasVideo ? ' is-accent' : '')}
                      onClick={() => setMediaModal({
                        mode: item.tenantCustom ? 'custom' : 'override',
                        exercise: liveOv
                          ? { ...item, customMedia: liveOv.media || null, customUrl: liveOv.url || '', customNote: liveOv.note || '' }
                          : item
                      })}
                      title={item.tenantCustom ? 'Editar exercício / vídeo' : 'Trocar vídeo deste exercício'}
                    >
                      <Icon name={item.tenantCustom ? 'pencil' : 'video'} size={15} />
                    </button>
                    <button
                      type="button"
                      className="b2b-icon-btn"
                      onClick={() => addExerciseFromCatalogue(item)}
                      title="Adicionar exercício à ficha"
                      style={{
                        background: addedCount > 0 ? 'color-mix(in srgb, var(--green) 18%, transparent)' : 'var(--acc-soft)',
                        color: addedCount > 0 ? 'var(--green)' : 'var(--acc-ink)'
                      }}
                    >
                      <Icon name="plus" size={15} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {!catLoading && catResults.length === 0 && (
            <div className="muted small" style={{ textAlign: 'center', padding: '16px 8px' }}>
              Nenhum exercício encontrado com os filtros atuais.
            </div>
          )}

          {catHasMore && (
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <Button variant="secondary" size="sm" onClick={loadMoreCatalogue} disabled={catLoadingMore}>
                {catLoadingMore
                  ? 'Carregando...'
                  : `Carregar mais exercícios (${Math.max(0, catTotal - catResults.length)} restantes)`}
              </Button>
            </div>
          )}
        </div>
      </div>

      <ExerciseMediaModal
        open={Boolean(mediaModal)}
        onClose={() => setMediaModal(null)}
        mode={mediaModal?.mode || 'override'}
        exercise={mediaModal?.exercise || null}
        equipments={equipments}
        mediaCaps={mediaCaps}
        activeWorkoutLabel={activeLabel}
        onSaved={ev => {
          if (ev.type === 'override') {
            setTenantOverrides(prev => {
              const next = { ...prev };
              if (ev.override) next[ev.exerciseId] = ev.override;
              else delete next[ev.exerciseId];
              return next;
            });
          } else if (ev.type === 'custom' && ev.exercise) {
            const ex = ev.exercise;
            setTenantCustomList(prev => {
              const idx = prev.findIndex(c => c.id === ex.id);
              return idx >= 0 ? prev.map((c, i) => (i === idx ? ex : c)) : [ex, ...prev];
            });
            setWorkouts(prev => prev.map(w => ({
              ...w,
              exercises: w.exercises.map(s => (s.id === ex.id ? { ...s, name: ex.name } : s))
            })));
            if (ev.addToWorkout) {
              addExerciseFromCatalogue({
                id: ex.id,
                name: ex.name,
                eq: ex.eq,
                tenantCustom: true,
                customMedia: ex.media || null,
                customUrl: ex.url || ''
              });
            }
          }
          setCatVersion(v => v + 1);
        }}
        onDeleted={ev => {
          if (ev.type === 'override') {
            setTenantOverrides(prev => {
              const next = { ...prev };
              delete next[ev.exerciseId];
              return next;
            });
          } else if (ev.type === 'custom') {
            setTenantCustomList(prev => prev.filter(c => c.id !== ev.id));
          }
          setCatVersion(v => v + 1);
        }}
      />
    </Modal>
  );
}
