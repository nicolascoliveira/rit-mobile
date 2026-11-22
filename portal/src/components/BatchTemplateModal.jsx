import React, { useMemo, useState } from 'react';
import { Button, Modal, SearchField, SelectField, StatusPill } from './ui.jsx';
import { applyTemplateBatch, toast } from '../lib/api.js';

const WEEKDAYS = [
  { d: 1, label: 'Seg' },
  { d: 2, label: 'Ter' },
  { d: 3, label: 'Qua' },
  { d: 4, label: 'Qui' },
  { d: 5, label: 'Sex' },
  { d: 6, label: 'Sáb' },
  { d: 0, label: 'Dom' }
];

export default function BatchTemplateModal({
  open,
  onClose,
  template = null,
  templates = [],
  students = [],
  onApplied
}) {
  const [templateId, setTemplateId] = useState('');
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [days, setDays] = useState([1, 3, 5]);
  const [archivePrevious, setArchivePrevious] = useState(false);
  const [saving, setSaving] = useState(false);

  const effectiveTplId = templateId || template?.id || templates[0]?.id || '';

  const activeStudents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return students
      .filter(s => !s.disabled)
      .filter(s => !q || String(s.name || '').toLowerCase().includes(q) || String(s.goal || '').toLowerCase().includes(q));
  }, [students, query]);

  const toggleStudent = id => {
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  };

  const toggleDay = d => {
    setDays(prev => (prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]));
  };

  const handleApply = async () => {
    if (saving || !effectiveTplId || !selectedIds.length) return;
    setSaving(true);
    try {
      const res = await applyTemplateBatch({
        templateId: effectiveTplId,
        studentIds: selectedIds,
        days,
        archivePrevious
      });
      toast(`Modelo aplicado para ${res.appliedCount || 0} aluno(s)!`);
      setSelectedIds([]);
      onApplied?.(res);
      onClose?.();
    } catch (err) {
      toast(err.message || 'Erro ao aplicar modelo em lote');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Aplicar Modelo de Treino em Lote"
      subtitle="Escolha um modelo da academia e libere para vários alunos simultaneamente"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            icon="check"
            onClick={handleApply}
            disabled={saving || !effectiveTplId || selectedIds.length === 0}
          >
            {saving ? 'Aplicando...' : `Aplicar para ${selectedIds.length} Aluno(s)`}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <SelectField
          label="Modelo de ficha"
          value={effectiveTplId}
          onChange={setTemplateId}
          options={templates.map(t => ({
            value: t.id,
            label: `${t.name} (${(t.ex || []).length} exercícios)`
          }))}
        />

        <div>
          <div className="b2b-field-lbl" style={{ marginBottom: 6 }}>Dias programados na semana</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {WEEKDAYS.map(w => (
              <button
                key={w.d}
                type="button"
                onClick={() => toggleDay(w.d)}
                className={'b2b-day-pill' + (days.includes(w.d) ? ' on' : '')}
                style={{ fontSize: 14, minWidth: 44 }}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14, color: 'var(--label)' }}>
          <input
            type="checkbox"
            checked={archivePrevious}
            onChange={e => setArchivePrevious(e.target.checked)}
            style={{ width: 17, height: 17, accentColor: 'var(--acc)' }}
          />
          Arquivar fichas de mesmo nome no histórico antes de atualizar
        </label>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <SearchField value={query} onChange={setQuery} placeholder="Filtrar alunos por nome ou objetivo..." />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="ghost" onClick={() => setSelectedIds(activeStudents.map(s => s.id))}>
              Marcar visíveis ({activeStudents.length})
            </Button>
            {selectedIds.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setSelectedIds([])}>
                Limpar ({selectedIds.length})
              </Button>
            )}
          </div>
        </div>

        <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--sep)', borderRadius: 10, padding: 8, display: 'grid', gap: 4 }}>
          {activeStudents.map(st => {
            const checked = selectedIds.includes(st.id);
            return (
              <label
                key={st.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 10px',
                  borderRadius: 8,
                  cursor: 'pointer',
                  background: checked ? 'var(--acc-tint)' : 'transparent',
                  fontSize: 14
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleStudent(st.id)}
                    style={{ width: 17, height: 17, accentColor: 'var(--acc)' }}
                  />
                  <b style={{ color: 'var(--label)' }}>{st.name}</b>
                </span>
                <StatusPill tone={st.routineStatus === 'missing' ? 'warn' : 'muted'}>
                  {st.routineCount || 0} ficha(s)
                </StatusPill>
              </label>
            );
          })}
          {activeStudents.length === 0 && (
            <div style={{ padding: 14, fontSize: 14, color: 'var(--label-3)', textAlign: 'center' }}>
              Nenhum aluno ativo encontrado com este filtro.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
