import React, { useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { Button, EmptyState, Segmented, SelectField, StatusPill } from './ui.jsx';
import { LineChart } from './Charts.jsx';
import { archiveStudentCycle, fmtDateBR, toast } from '../lib/api.js';

export default function StudentPeriodizationPanel({ student, state, onUpdated }) {
  const exerciseSeries = useMemo(
    () => (Array.isArray(state?.exerciseSeries) ? state.exerciseSeries : []),
    [state?.exerciseSeries]
  );
  const routineArchive = useMemo(
    () => (Array.isArray(state?.routineArchive) ? state.routineArchive : []),
    [state?.routineArchive]
  );
  const currentRoutinesCount = Array.isArray(state?.routines) ? state.routines.length : 0;

  const [selectedExId, setSelectedExId] = useState('');
  const [metric, setMetric] = useState('maxWeightKg');
  const [archiving, setArchiving] = useState(false);

  const activeEx = useMemo(() => {
    if (!exerciseSeries.length) return null;
    return exerciseSeries.find(e => e.id === selectedExId) || exerciseSeries[0];
  }, [exerciseSeries, selectedExId]);

  const handleArchiveAll = async () => {
    if (archiving || !student?.id || currentRoutinesCount === 0) return;
    setArchiving(true);
    try {
      const res = await archiveStudentCycle({
        studentId: student.id,
        removeCurrent: false,
        reason: 'cycle_snapshot'
      });
      toast(`${res?.archivedCount || 0} ficha(s) fotografadas no histórico de ciclos!`);
      onUpdated?.();
    } catch (err) {
      toast(err.message || 'Erro ao arquivar ciclo atual');
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* Curva de Carga por Exercício */}
      <div className="b2b-card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="b2b-ico-badge" style={{ background: 'var(--acc-tint)', color: 'var(--acc)' }}>
              <Icon name="chart" size={18} />
            </span>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--label)' }}>
                Curva de Carga & Força por Exercício
              </div>
              <div style={{ fontSize: 14, color: 'var(--label-3)' }}>
                Acompanhe progressão de carga máxima, 1RM estimado (Epley) e tonelagem por exercício
              </div>
            </div>
          </div>

          {exerciseSeries.length > 0 && (
            <Segmented
              value={metric}
              onChange={setMetric}
              options={[
                { value: 'maxWeightKg', label: 'Carga Máx. (kg)' },
                { value: 'est1Rm', label: '1RM Estimado' },
                { value: 'volumeKg', label: 'Volume (kg)' }
              ]}
            />
          )}
        </div>

        {exerciseSeries.length > 0 && activeEx ? (
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1.4fr) 1fr', gap: 12, alignItems: 'end' }}>
              <SelectField
                label="Selecione o exercício avaliado"
                value={activeEx.id}
                onChange={setSelectedExId}
                options={exerciseSeries.map(e => ({
                  value: e.id,
                  label: `${e.name} (${e.sessionsCount} sessões)`
                }))}
              />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingBottom: 4 }}>
                <StatusPill tone="muted">Início: {activeEx.firstWeightKg} kg</StatusPill>
                <StatusPill tone="acc">Última: {activeEx.latestWeightKg} kg</StatusPill>
                <StatusPill tone={activeEx.deltaKg >= 0 ? 'ok' : 'warn'}>
                  {activeEx.deltaKg > 0 ? `+${activeEx.deltaKg}` : activeEx.deltaKg} kg
                </StatusPill>
                <StatusPill tone="ok">Melhor 1RM: {activeEx.bestEst1Rm} kg</StatusPill>
              </div>
            </div>

            <LineChart
              data={activeEx.series}
              valueKey={metric}
              labelKey="label"
              formatValue={v => `${Number(v).toLocaleString('pt-BR')} kg`}
            />
          </div>
        ) : (
          <EmptyState
            icon="chart"
            title="Sem registros de carga suficientes"
            message="Assim que o aluno registrar cargas nos treinos pelo aplicativo Rit, a curva aparecerá aqui."
          />
        )}
      </div>

      {/* Histórico de Ciclos / Mesociclos Arquivados */}
      <div className="b2b-card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="b2b-ico-badge" style={{ background: 'var(--bg-el)', color: 'var(--label)' }}>
              <Icon name="clock" size={18} />
            </span>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--label)' }}>
                Histórico de Ciclos & Mesociclos ({routineArchive.length})
              </div>
              <div style={{ fontSize: 14, color: 'var(--label-3)' }}>
                Fichas anteriores preservadas com cargas iniciais vs. finais alcançadas
              </div>
            </div>
          </div>

          {currentRoutinesCount > 0 && (
            <Button size="sm" variant="secondary" icon="rotateCcw" onClick={handleArchiveAll} disabled={archiving}>
              {archiving ? 'Arquivando...' : 'Registrar Snapshot do Ciclo Atual'}
            </Button>
          )}
        </div>

        {routineArchive.length > 0 ? (
          <div style={{ display: 'grid', gap: 12 }}>
            {routineArchive.map(arc => (
              <div key={arc.id} style={{ padding: 14, borderRadius: 10, background: 'var(--bg-el)', border: '1px solid var(--sep)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--label)' }}>{arc.name}</div>
                    <div style={{ fontSize: 14, color: 'var(--label-3)' }}>
                      Arquivado em {fmtDateBR(arc.archivedAt)} {arc.trainerName ? `• ${arc.trainerName}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <StatusPill tone="muted">{arc.durationDays || 0} dias</StatusPill>
                    <StatusPill tone="acc">{arc.workoutsCount || 0} sessões realizadas</StatusPill>
                  </div>
                </div>

                {Array.isArray(arc.exercises) && arc.exercises.length > 0 && (
                  <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                    {arc.exercises.slice(0, 10).map((ex, i) => (
                      <div key={ex.id || i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 14, paddingTop: 4, borderTop: i > 0 ? '1px solid var(--sep)' : 'none' }}>
                        <span style={{ color: 'var(--label)' }}>
                          {ex.name} ({ex.sets}x{ex.reps || '-'})
                        </span>
                        <span className="num" style={{ color: 'var(--label-2)' }}>
                          {ex.initialWeightKg != null ? `${ex.initialWeightKg} kg` : '—'}
                          {' -> '}
                          <b>{ex.finalWeightKg != null ? `${ex.finalWeightKg} kg` : '—'}</b>
                          {ex.deltaKg != null && ex.deltaKg !== 0 && (
                            <span style={{ marginLeft: 8, color: ex.deltaKg > 0 ? 'var(--green)' : 'var(--orange)', fontWeight: 700 }}>
                              ({ex.deltaKg > 0 ? `+${ex.deltaKg}` : ex.deltaKg} kg)
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon="calendar"
            title="Nenhum ciclo arquivado ainda"
            message="Ao renovar uma ficha marcando 'Arquivar fichas anteriores' ou clicar em 'Registrar Snapshot', o histórico completo ficará salvo aqui."
          />
        )}
      </div>
    </div>
  );
}
