import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUI } from '../store/useUI.js';
import { api } from '../lib/api.js';
import Icon from '../components/Icon.jsx';
import { Button, Segmented } from '../components/ui.jsx';
import '../admin.css';

const DAYS_LABEL = {
  '1': 'Segunda-feira',
  '2': 'Terça-feira',
  '3': 'Quarta-feira',
  '4': 'Quinta-feira',
  '5': 'Sexta-feira',
  '6': 'Sábado',
  '0': 'Domingo'
};

const BP_FILTERS = [
  { value: '', label: 'Todos' },
  { value: 'chest', label: 'Peito' },
  { value: 'back', label: 'Costas' },
  { value: 'upper legs', label: 'Pernas' },
  { value: 'shoulders', label: 'Ombros' },
  { value: 'upper arms', label: 'Braços' },
  { value: 'lower arms', label: 'Antebraços' },
  { value: 'lower legs', label: 'Panturrilhas' },
  { value: 'waist', label: 'Abdômen' },
  { value: 'full body', label: 'Full Body' },
  { value: 'cardio', label: 'Cardio' },
  { value: 'neck', label: 'Pescoço' }
];

export default function Trainer() {
  const navigate = useNavigate();
  const toast = useUI(s => s.toast);

  const [tab, setTab] = useState('students');
  const [students, setStudents] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const submitLockRef = useRef(false);

  const runSingleFlight = async fn => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setSubmitting(true);
    try {
      return await fn();
    } finally {
      submitLockRef.current = false;
      setSubmitting(false);
    }
  };

  const [selectedStudent, setSelectedStudent] = useState(null);
  const [routineName, setRoutineName] = useState('');
  const [routineDay, setRoutineDay] = useState('1');
  const [routineExercises, setRoutineExercises] = useState([
    { id: '0025', name: 'Supino Reto com Barra', sets: 4, reps: 10, weight: 0 }
  ]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');

  const [isCreatingTemplate, setIsCreatingTemplate] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateExercises, setNewTemplateExercises] = useState([
    { id: '0025', name: 'Supino Reto com Barra', sets: 3, reps: 10, weight: 0 }
  ]);

  // Busca no catálogo oficial (5.632 exercícios)
  const [catQuery, setCatQuery] = useState('');
  const [catBp, setCatBp] = useState('');
  const [catResults, setCatResults] = useState([]);
  const [catTotal, setCatTotal] = useState(0);
  const [catHasMore, setCatHasMore] = useState(false);
  const [catLoading, setCatLoading] = useState(false);
  const [catLoadingMore, setCatLoadingMore] = useState(false);
  const [deleteTplConfirm, setDeleteTplConfirm] = useState(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const [resStudents, resTemplates] = await Promise.all([
        api('/api/trainer/students').catch(() => ({ students: [] })),
        api('/api/trainer/templates').catch(() => ({ templates: [] }))
      ]);
      setStudents(resStudents?.students || []);
      setTemplates(resTemplates?.templates || []);
    } catch (e) {
      toast(e.message || 'Erro ao carregar dados do treinador');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!selectedStudent && !isCreatingTemplate) return;
    let cancelled = false;
    setCatLoading(true);
    const tm = setTimeout(async () => {
      try {
        const sp = new URLSearchParams({ limit: '36', offset: '0' });
        if (catQuery.trim()) sp.set('q', catQuery.trim());
        if (catBp) sp.set('bp', catBp);
        const res = await api(`/api/saas/catalogue?${sp.toString()}`);
        if (!cancelled) {
          const list = res?.exercises || res?.items || [];
          const total = Number(res?.total) || list.length;
          setCatResults(list);
          setCatTotal(total);
          setCatHasMore(typeof res?.hasMore === 'boolean' ? res.hasMore : list.length < total);
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
    return () => {
      cancelled = true;
      clearTimeout(tm);
    };
  }, [catQuery, catBp, selectedStudent, isCreatingTemplate]);

  const loadMoreCat = async () => {
    if (catLoading || catLoadingMore || !catHasMore) return;
    setCatLoadingMore(true);
    try {
      const sp = new URLSearchParams({ limit: '36', offset: String(catResults.length) });
      if (catQuery.trim()) sp.set('q', catQuery.trim());
      if (catBp) sp.set('bp', catBp);
      const res = await api(`/api/saas/catalogue?${sp.toString()}`);
      const next = res?.exercises || res?.items || [];
      setCatResults(prev => {
        const seen = new Set(prev.map(x => x.id));
        const merged = [...prev, ...next.filter(x => !seen.has(x.id))];
        const total = Number(res?.total) || merged.length;
        setCatTotal(total);
        setCatHasMore(typeof res?.hasMore === 'boolean' ? res.hasMore : merged.length < total);
        return merged;
      });
    } catch {
      toast('Erro ao carregar mais exercícios.');
    } finally {
      setCatLoadingMore(false);
    }
  };

  const renderCataloguePicker = target => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <label className="muted small">Catálogo Oficial (5.632 Exercícios):</label>
        <span className="muted small">
          {catLoading ? 'Buscando...' : `Exibindo ${catResults.length} de ${catTotal}`}
        </span>
      </div>
      <input
        type="search"
        className="field"
        value={catQuery}
        onChange={e => setCatQuery(e.target.value)}
        placeholder="Digite p/ buscar: Supino, Agachamento, Remada..."
      />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        {BP_FILTERS.map(f => (
          <button
            type="button"
            key={f.value || 'all'}
            onClick={() => setCatBp(f.value)}
            className="tag"
            style={{
              cursor: 'pointer',
              border: '1px solid var(--sep)',
              background: catBp === f.value ? 'var(--acc-soft)' : 'transparent',
              color: catBp === f.value ? 'var(--acc)' : 'inherit',
              fontWeight: catBp === f.value ? 700 : 500
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div
        style={{
          marginTop: 8,
          borderRadius: 12,
          background: 'var(--bg-elevated, var(--surface))',
          border: '1px solid var(--sep)',
          maxHeight: 210,
          overflowY: 'auto',
          padding: 6
        }}
      >
        {catLoading ? (
          <div className="muted small" style={{ padding: 8 }}>Buscando exercícios...</div>
        ) : catResults.length === 0 ? (
          <div className="muted small" style={{ padding: 8 }}>Nenhum exercício encontrado.</div>
        ) : (
          catResults.map(item => (
            <button
              type="button"
              key={item.id}
              onClick={() => addExerciseFromCat(item, target)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '8px 10px',
                border: 'none',
                borderRadius: 8,
                background: 'transparent',
                color: 'inherit',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'pointer'
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{item.name}</div>
                <div className="muted small">{item.bpLabel || item.muscle} · {item.eqLabel || item.equipment}</div>
              </div>
              <span className="tag acc">+ Adicionar</span>
            </button>
          ))
        )}
        {catHasMore && !catLoading && (
          <div style={{ padding: '8px 6px 4px', textAlign: 'center' }}>
            <Button variant="ghost" size="sm" onClick={loadMoreCat} disabled={catLoadingMore}>
              {catLoadingMore ? 'Carregando...' : `Carregar mais (${Math.max(0, catTotal - catResults.length)} restantes)`}
            </Button>
          </div>
        )}
      </div>
    </div>
  );

  const addExerciseFromCat = (item, target = 'routine') => {
    const row = {
      id: item.id || '0025',
      name: item.name || 'Exercício',
      muscle: item.bpLabel || item.muscle || '',
      equipment: item.eqLabel || item.equipment || '',
      thumb: item.thumb || '',
      sets: 3,
      reps: 10,
      weight: 0
    };
    if (target === 'template') {
      setNewTemplateExercises(prev => [...prev, row]);
    } else {
      setRoutineExercises(prev => [...prev, row]);
    }
    setCatQuery('');
    setCatResults([]);
    toast(`+ ${row.name} adicionado`);
  };

  const addExerciseRow = (target = 'routine') => {
    const row = { id: 'custom_' + Date.now(), name: '', sets: 3, reps: 10, weight: 0 };
    if (target === 'template') {
      setNewTemplateExercises(prev => [...prev, row]);
    } else {
      setRoutineExercises(prev => [...prev, row]);
    }
  };

  const removeExerciseRow = (idx, target = 'routine') => {
    if (target === 'template') {
      setNewTemplateExercises(prev => prev.filter((_, i) => i !== idx));
    } else {
      setRoutineExercises(prev => prev.filter((_, i) => i !== idx));
    }
  };

  const updateExerciseField = (idx, field, val, target = 'routine') => {
    if (target === 'template') {
      setNewTemplateExercises(prev => prev.map((ex, i) => (i === idx ? { ...ex, [field]: val } : ex)));
    } else {
      setRoutineExercises(prev => prev.map((ex, i) => (i === idx ? { ...ex, [field]: val } : ex)));
    }
  };

  const handleSelectTemplate = tplId => {
    setSelectedTemplateId(tplId);
    const tpl = templates.find(t => t.id === tplId);
    if (tpl) {
      setRoutineName(tpl.name);
      if (Array.isArray(tpl.ex) && tpl.ex.length > 0) {
        setRoutineExercises(
          tpl.ex.map(e => ({
            id: e.id || '0025',
            name: e.name || 'Exercício',
            sets: e.sets || 3,
            reps: e.reps || 10,
            weight: e.weight || 0
          }))
        );
      }
    }
  };

  const handlePrescribe = async () => {
    if (!selectedStudent) return;
    if (!routineName.trim()) {
      toast('Informe o nome da rotina (ex: Treino A - Peito)');
      return;
    }
    const validEx = routineExercises.filter(e => String(e.name || '').trim());
    if (validEx.length === 0) {
      toast('Adicione pelo menos 1 exercício com nome');
      return;
    }
    await runSingleFlight(async () => {
      try {
        await api('/api/trainer/prescribe', {
          method: 'POST',
          body: JSON.stringify({
            studentId: selectedStudent.id,
            day: parseInt(routineDay, 10),
            routine: {
              name: routineName.trim(),
              ex: validEx
            }
          })
        });
        toast(`Ficha prescrita com sucesso para ${selectedStudent.name}!`);
        setSelectedStudent(null);
        setRoutineName('');
        setCatQuery('');
        loadData();
      } catch (e) {
        toast(e.message || 'Erro ao prescrever ficha');
      }
    });
  };

  const handleSaveNewTemplate = async () => {
    if (!newTemplateName.trim()) {
      toast('Dê um nome para o modelo');
      return;
    }
    const validEx = newTemplateExercises.filter(e => String(e.name || '').trim());
    if (validEx.length === 0) {
      toast('Adicione pelo menos 1 exercício ao modelo');
      return;
    }
    await runSingleFlight(async () => {
      try {
        await api('/api/trainer/template', {
          method: 'POST',
          body: JSON.stringify({
            name: newTemplateName.trim(),
            ex: validEx
          })
        });
        toast('Modelo de treino salvo com sucesso!');
        setIsCreatingTemplate(false);
        setNewTemplateName('');
        setCatQuery('');
        loadData();
      } catch (e) {
        toast(e.message || 'Erro ao salvar modelo');
      }
    });
  };

  const handleDeleteTemplate = async tplId => {
    await runSingleFlight(async () => {
      try {
        await api('/api/trainer/template/delete', {
          method: 'POST',
          body: JSON.stringify({ id: tplId })
        });
        toast('Modelo excluído');
        setDeleteTplConfirm(null);
        loadData();
      } catch (e) {
        toast(e.message || 'Erro ao excluir modelo');
      }
    });
  };

  return (
    <div className="adm-page" style={{ padding: 20, maxWidth: 900, margin: '0 auto' }}>
      <header className="adm-header" style={{ marginBottom: 20 }}>
        <button
          type="button"
          className="adm-back"
          onClick={() => navigate(-1)}
          style={{ background: 'none', border: 'none', color: 'var(--acc-ink)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}
        >
          <Icon name="chevronLeft" /> Voltar
        </button>
        <h1 style={{ margin: 0, fontSize: '1.6rem', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="figureStrength" /> Área do Professor
        </h1>
        <p className="muted small" style={{ margin: '4px 0 0 0' }}>
          Prescreva fichas de treino rápidas pelo celular ou utilize o Painel Web da Academia para o catálogo completo.
        </p>
      </header>

      <div style={{ marginBottom: 18 }}>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'students', label: `Alunos (${students.length})` },
            { value: 'templates', label: `Modelos (${templates.length})` }
          ]}
        />
      </div>

      {loading ? (
        <div className="muted" style={{ padding: 40, textAlign: 'center' }}>Carregando dados da academia...</div>
      ) : tab === 'students' ? (
        <section>
          {students.length === 0 ? (
            <div className="card" style={{ padding: 24, textAlign: 'center', margin: 0 }}>
              <p className="muted">Nenhum aluno cadastrado nesta academia ainda.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {students.map(s => (
                <div key={s.id} className="card" style={{ margin: 0, padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                  <div style={{ minWidth: 0, flex: '1 1 180px' }}>
                    <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{s.name}</h3>
                    <div className="muted small" style={{ marginTop: 4 }}>
                      <span>Treinos: <b>{s.workoutCount}</b></span> · <span>Fichas: <b>{s.routineCount ?? s.prescribedCount ?? 0}</b></span>
                      {s.lastWorkout && <span> · Último: <b>{s.lastWorkout}</b></span>}
                    </div>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    icon="plus"
                    onClick={() => {
                      setSelectedStudent(s);
                      setRoutineName(`Treino de ${s.name}`);
                    }}
                  >
                    Prescrever
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : (
        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
            <h2 style={{ fontSize: '1.1rem', margin: 0 }}>Modelos Prontos da Academia</h2>
            <Button variant="primary" size="sm" icon="plus" onClick={() => setIsCreatingTemplate(true)}>Novo Modelo</Button>
          </div>

          {templates.length === 0 ? (
            <div className="card" style={{ margin: 0, padding: 24, textAlign: 'center' }}>
              <p className="muted">Nenhum modelo cadastrado.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {templates.map(t => (
                <div key={t.id} className="card" style={{ margin: 0, padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
                  <div style={{ minWidth: 0, flex: '1 1 180px' }}>
                    <h3 style={{ margin: 0, fontSize: '1.05rem' }}>{t.name}</h3>
                    <div className="muted small" style={{ marginTop: 4 }}>
                      <span>{t.ex?.length || 0} exercícios configurados</span>
                    </div>
                  </div>
                  {deleteTplConfirm === t.id ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Button variant="ghost" size="sm" disabled={submitting} onClick={() => setDeleteTplConfirm(null)}>Cancelar</Button>
                      <Button variant="primary" size="sm" disabled={submitting} onClick={() => handleDeleteTemplate(t.id)} style={{ background: 'var(--red)', color: '#fff' }}>
                        {submitting ? 'Excluindo...' : 'Confirmar'}
                      </Button>
                    </div>
                  ) : (
                    <Button variant="ghost" size="sm" icon="trash" disabled={submitting} onClick={() => setDeleteTplConfirm(t.id)} style={{ color: 'var(--red)' }}>
                      Excluir
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {selectedStudent && (
        <div style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.75)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', zIndex: 1000,
          padding: 'max(14px, env(safe-area-inset-top)) 14px max(14px, env(safe-area-inset-bottom))',
          overflowY: 'auto'
        }}>
          <div className="card" style={{ width: '100%', maxWidth: 580, maxHeight: 'calc(100dvh - 28px)', overflowY: 'auto', overflowX: 'hidden', padding: 20, margin: 'auto 0' }}>
            <h2 style={{ marginTop: 0 }}>Prescrever Ficha — {selectedStudent.name}</h2>

            {templates.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <label className="muted small" style={{ display: 'block', marginBottom: 6 }}>Modelo Pronto da Academia:</label>
                <select
                  className="adm-select"
                  style={{ width: '100%', minHeight: 42 }}
                  value={selectedTemplateId}
                  onChange={e => handleSelectTemplate(e.target.value)}
                >
                  <option value="">— Selecione um modelo (opcional) —</option>
                  {templates.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label className="muted small" style={{ display: 'block', marginBottom: 6 }}>Nome da Ficha:</label>
              <input
                type="text"
                className="field"
                value={routineName}
                onChange={e => setRoutineName(e.target.value)}
                placeholder="Ex: Treino A - Peito e Tríceps"
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label className="muted small" style={{ display: 'block', marginBottom: 6 }}>Dia da Semana:</label>
              <select
                className="adm-select"
                style={{ width: '100%', minHeight: 42 }}
                value={routineDay}
                onChange={e => setRoutineDay(e.target.value)}
              >
                {Object.entries(DAYS_LABEL).map(([d, label]) => (
                  <option key={d} value={d}>{label}</option>
                ))}
              </select>
            </div>

            {renderCataloguePicker('routine')}

            <div style={{ marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label className="muted small">Exercícios da Ficha ({routineExercises.length}):</label>
                <Button variant="tinted" size="sm" icon="plus" onClick={() => addExerciseRow('routine')}>
                  Linha Manual
                </Button>
              </div>

              {routineExercises.map((ex, idx) => (
                <div
                  key={idx}
                  style={{
                    background: 'var(--surface-2)',
                    padding: '10px 12px',
                    borderRadius: 'var(--r)',
                    marginBottom: 8,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="text"
                      className="field"
                      style={{ flex: 1, minWidth: 0, minHeight: 38, fontSize: 16 }}
                      value={ex.name}
                      onChange={e => updateExerciseField(idx, 'name', e.target.value, 'routine')}
                      placeholder="Nome do Exercício"
                    />
                    {routineExercises.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="xmark"
                        onClick={() => removeExerciseRow(idx, 'routine')}
                        title="Remover exercício"
                      />
                    )}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="muted small" style={{ fontSize: 11, marginBottom: 2 }}>Séries</div>
                      <input
                        type="number"
                        className="field num"
                        style={{ width: '100%', minHeight: 38, textAlign: 'center' }}
                        value={ex.sets}
                        onChange={e => updateExerciseField(idx, 'sets', parseInt(e.target.value, 10) || 1, 'routine')}
                      />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div className="muted small" style={{ fontSize: 11, marginBottom: 2 }}>Reps</div>
                      <input
                        type="number"
                        className="field num"
                        style={{ width: '100%', minHeight: 38, textAlign: 'center' }}
                        value={ex.reps}
                        onChange={e => updateExerciseField(idx, 'reps', parseInt(e.target.value, 10) || 1, 'routine')}
                      />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div className="muted small" style={{ fontSize: 11, marginBottom: 2 }}>Carga (kg)</div>
                      <input
                        type="number"
                        className="field num"
                        style={{ width: '100%', minHeight: 38, textAlign: 'center' }}
                        value={ex.weight || 0}
                        onChange={e => updateExerciseField(idx, 'weight', parseFloat(e.target.value) || 0, 'routine')}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 10, marginTop: 20 }}>
              <Button variant="ghost" disabled={submitting} onClick={() => { setSelectedStudent(null); setCatQuery(''); }}>Cancelar</Button>
              <Button variant="primary" icon="check" disabled={submitting} onClick={handlePrescribe}>{submitting ? 'Enviando...' : 'Salvar e Enviar ao Aluno'}</Button>
            </div>
          </div>
        </div>
      )}

      {isCreatingTemplate && (
        <div style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.75)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', zIndex: 1000,
          padding: 'max(14px, env(safe-area-inset-top)) 14px max(14px, env(safe-area-inset-bottom))',
          overflowY: 'auto'
        }}>
          <div className="card" style={{ width: '100%', maxWidth: 560, maxHeight: 'calc(100dvh - 28px)', overflowY: 'auto', overflowX: 'hidden', padding: 20, margin: 'auto 0' }}>
            <h2 style={{ marginTop: 0 }}>Criar Modelo de Ficha</h2>
            <div style={{ marginBottom: 14 }}>
              <label className="muted small" style={{ display: 'block', marginBottom: 6 }}>Nome do Modelo:</label>
              <input
                type="text"
                className="field"
                value={newTemplateName}
                onChange={e => setNewTemplateName(e.target.value)}
                placeholder="Ex: Hipertrofia Pernas e Glúteos"
              />
            </div>

            {renderCataloguePicker('template')}

            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label className="muted small">Exercícios do Modelo ({newTemplateExercises.length}):</label>
                <Button variant="tinted" size="sm" icon="plus" onClick={() => addExerciseRow('template')}>
                  Linha Manual
                </Button>
              </div>
              {newTemplateExercises.map((ex, idx) => (
                <div
                  key={idx}
                  style={{
                    background: 'var(--surface-2)',
                    padding: '10px 12px',
                    borderRadius: 'var(--r)',
                    marginBottom: 8,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="text"
                      className="field"
                      style={{ flex: 1, minWidth: 0, minHeight: 38, fontSize: 16 }}
                      value={ex.name}
                      onChange={e => updateExerciseField(idx, 'name', e.target.value, 'template')}
                      placeholder="Nome do Exercício"
                    />
                    {newTemplateExercises.length > 1 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="xmark"
                        onClick={() => removeExerciseRow(idx, 'template')}
                        title="Remover exercício"
                      />
                    )}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="muted small" style={{ fontSize: 11, marginBottom: 2 }}>Séries</div>
                      <input
                        type="number"
                        className="field num"
                        style={{ width: '100%', minHeight: 38, textAlign: 'center' }}
                        value={ex.sets}
                        onChange={e => updateExerciseField(idx, 'sets', parseInt(e.target.value, 10) || 1, 'template')}
                      />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div className="muted small" style={{ fontSize: 11, marginBottom: 2 }}>Reps</div>
                      <input
                        type="number"
                        className="field num"
                        style={{ width: '100%', minHeight: 38, textAlign: 'center' }}
                        value={ex.reps}
                        onChange={e => updateExerciseField(idx, 'reps', parseInt(e.target.value, 10) || 1, 'template')}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 10, marginTop: 20 }}>
              <Button variant="ghost" disabled={submitting} onClick={() => { setIsCreatingTemplate(false); setCatQuery(''); }}>Cancelar</Button>
              <Button variant="primary" icon="check" disabled={submitting} onClick={handleSaveNewTemplate}>{submitting ? 'Salvando...' : 'Salvar Modelo'}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
