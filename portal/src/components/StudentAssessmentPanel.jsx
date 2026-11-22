import React, { useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { Button, NumberField, SelectField, StatusPill, TextArea, TextField } from './ui.jsx';
import { fmtDateBR, saveStudentAssessment, toast } from '../lib/api.js';

function cleanPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 10) return '';
  return digits.startsWith('55') ? digits : `55${digits}`;
}

const PROTOCOL_OPTIONS = [
  { value: 'pollock_7', label: 'Pollock 7 Dobras' },
  { value: 'pollock_3', label: 'Pollock 3 Dobras' },
  { value: 'bioimpedancia', label: 'Bioimpedância' },
  { value: 'guedes', label: 'Protocolo Guedes' },
  { value: 'circunferencias', label: 'Perimetria & Peso' }
];

const METRIC_META = [
  { key: 'weightKg', label: 'Peso Corporal', unit: 'kg', lowerBetter: null },
  { key: 'bodyFat', label: '% Gordura', unit: '%', lowerBetter: true },
  { key: 'leanMassKg', label: 'Massa Magra', unit: 'kg', lowerBetter: false },
  { key: 'fatMassKg', label: 'Massa Gorda', unit: 'kg', lowerBetter: true },
  { key: 'chest', label: 'Peitoral', unit: 'cm', lowerBetter: null },
  { key: 'waist', label: 'Cintura', unit: 'cm', lowerBetter: true },
  { key: 'abdomen', label: 'Abdômen', unit: 'cm', lowerBetter: true },
  { key: 'hips', label: 'Quadril', unit: 'cm', lowerBetter: null },
  { key: 'upperArmRight', label: 'Braço Dir.', unit: 'cm', lowerBetter: false },
  { key: 'upperArmLeft', label: 'Braço Esq.', unit: 'cm', lowerBetter: false },
  { key: 'thighRight', label: 'Coxa Dir.', unit: 'cm', lowerBetter: false },
  { key: 'thighLeft', label: 'Coxa Esq.', unit: 'cm', lowerBetter: false },
  { key: 'calfRight', label: 'Panturrilha Dir.', unit: 'cm', lowerBetter: false },
  { key: 'calfLeft', label: 'Panturrilha Esq.', unit: 'cm', lowerBetter: false }
];

const todayIso = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

export default function StudentAssessmentPanel({
  student,
  state,
  onUpdated,
  onDownloadPdf,
  pdfBusy = false
}) {
  const comp = state?.bodyComparison || { count: 0, before: null, current: null, deltas: {} };
  const assessments = useMemo(
    () => (Array.isArray(state?.assessments) ? state.assessments.slice().reverse() : []),
    [state?.assessments]
  );

  const [date, setDate] = useState(todayIso);
  const [protocol, setProtocol] = useState('bioimpedancia');
  const [weightKg, setWeightKg] = useState('');
  const [heightCm, setHeightCm] = useState('');
  const [bodyFat, setBodyFat] = useState('');
  const [goalWeightKg, setGoalWeightKg] = useState('');
  const [chest, setChest] = useState('');
  const [waist, setWaist] = useState('');
  const [abdomen, setAbdomen] = useState('');
  const [hips, setHips] = useState('');
  const [upperArmRight, setUpperArmRight] = useState('');
  const [upperArmLeft, setUpperArmLeft] = useState('');
  const [thighRight, setThighRight] = useState('');
  const [thighLeft, setThighLeft] = useState('');
  const [calfRight, setCalfRight] = useState('');
  const [calfLeft, setCalfLeft] = useState('');
  const [clinicalNotes, setClinicalNotes] = useState('');
  const [showSkinfolds, setShowSkinfolds] = useState(false);
  const [skinfolds, setSkinfolds] = useState({
    triceps: '',
    subscapular: '',
    abdominal: '',
    iliacCrest: '',
    frontThigh: ''
  });
  const [notifyWhatsApp, setNotifyWhatsApp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastWhatsappText, setLastWhatsappText] = useState('');

  const handleSave = async e => {
    e?.preventDefault();
    if (saving || !student?.id) return;
    setSaving(true);
    try {
      const cleanFoldPayload = {};
      for (const [k, v] of Object.entries(skinfolds)) {
        if (v !== '' && v !== null) cleanFoldPayload[k] = Number(v);
      }
      const res = await saveStudentAssessment({
        studentId: student.id,
        d: date,
        protocol,
        weightKg: weightKg === '' ? undefined : Number(weightKg),
        heightCm: heightCm === '' ? undefined : Number(heightCm),
        bodyFat: bodyFat === '' ? undefined : Number(bodyFat),
        goalWeightKg: goalWeightKg === '' ? undefined : Number(goalWeightKg),
        chest: chest === '' ? undefined : Number(chest),
        waist: waist === '' ? undefined : Number(waist),
        abdomen: abdomen === '' ? undefined : Number(abdomen),
        hips: hips === '' ? undefined : Number(hips),
        upperArmRight: upperArmRight === '' ? undefined : Number(upperArmRight),
        upperArmLeft: upperArmLeft === '' ? undefined : Number(upperArmLeft),
        thighRight: thighRight === '' ? undefined : Number(thighRight),
        thighLeft: thighLeft === '' ? undefined : Number(thighLeft),
        calfRight: calfRight === '' ? undefined : Number(calfRight),
        calfLeft: calfLeft === '' ? undefined : Number(calfLeft),
        skinfolds: cleanFoldPayload,
        clinicalNotes,
        notifyWhatsApp
      });
      if (res?.whatsappText) setLastWhatsappText(res.whatsappText);
      toast(
        res?.whatsapp?.sent
          ? 'Avaliação registrada e enviada no WhatsApp!'
          : 'Avaliação física salva e sincronizada no app do aluno!'
      );
      setWeightKg('');
      setBodyFat('');
      setChest('');
      setWaist('');
      setAbdomen('');
      setHips('');
      setUpperArmRight('');
      setUpperArmLeft('');
      setThighRight('');
      setThighLeft('');
      setCalfRight('');
      setCalfLeft('');
      setClinicalNotes('');
      onUpdated?.();
    } catch (err) {
      toast(err.message || 'Não foi possível salvar a avaliação');
    } finally {
      setSaving(false);
    }
  };

  const phoneDigits = cleanPhone(student?.phone);
  const waHref = phoneDigits && lastWhatsappText
    ? `https://wa.me/${phoneDigits}?text=${encodeURIComponent(lastWhatsappText)}`
    : null;

  const compRows = METRIC_META.filter(m => comp.before?.[m.key] != null || comp.current?.[m.key] != null);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* Comparativo Antes vs. Atual */}
      <div className="b2b-card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="b2b-ico-badge" style={{ background: 'var(--acc-tint)', color: 'var(--acc)' }}>
              <Icon name="ruler" size={18} />
            </span>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--label)' }}>
                Comparativo Antes vs. Atual
              </div>
              <div style={{ fontSize: 14, color: 'var(--label-3)' }}>
                {comp.count > 1 && comp.before?.d && comp.current?.d
                  ? `Evolução de ${fmtDateBR(comp.before.d)} até ${fmtDateBR(comp.current.d)} (${comp.count} registros)`
                  : comp.count === 1
                    ? `1º registro em ${fmtDateBR(comp.current?.d)}. Lance uma nova avaliação para gerar deltas.`
                    : 'Nenhuma medida lançada ainda para este aluno.'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {waHref && (
              <Button
                size="sm"
                variant="secondary"
                icon="chat"
                onClick={() => window.open(waHref, '_blank', 'noopener,noreferrer')}
              >
                Enviar Resumo no WhatsApp
              </Button>
            )}
            <Button size="sm" variant="secondary" icon="download" onClick={onDownloadPdf} disabled={pdfBusy}>
              {pdfBusy ? 'Gerando PDF...' : 'Baixar Laudo Comparativo (PDF)'}
            </Button>
          </div>
        </div>

        {compRows.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(185px, 1fr))', gap: 10 }}>
            {compRows.map(m => {
              const cur = comp.current?.[m.key];
              const bef = comp.before?.[m.key];
              const deltaObj = comp.deltas?.[m.key];
              const diff = deltaObj?.diff;
              let pillTone = 'muted';
              if (diff != null && diff !== 0 && m.lowerBetter !== null) {
                const improved = m.lowerBetter ? diff < 0 : diff > 0;
                pillTone = improved ? 'ok' : 'warn';
              } else if (diff != null && diff !== 0) {
                pillTone = 'acc';
              }
              return (
                <div key={m.key} style={{ padding: 12, borderRadius: 10, background: 'var(--bg-el)', border: '1px solid var(--sep)' }}>
                  <div style={{ fontSize: 14, color: 'var(--label-3)', marginBottom: 4 }}>{m.label}</div>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
                    <span className="num" style={{ fontSize: 20, fontWeight: 700, color: 'var(--label)' }}>
                      {cur != null ? `${cur} ${m.unit}` : '—'}
                    </span>
                    {deltaObj && (
                      <StatusPill tone={pillTone}>
                        {diff > 0 ? `+${diff}` : `${diff}`} {m.unit}
                      </StatusPill>
                    )}
                  </div>
                  {bef != null && deltaObj && (
                    <div style={{ fontSize: 14, color: 'var(--label-3)', marginTop: 4 }}>
                      Início: <b className="num">{bef} {m.unit}</b>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ padding: '12px 0', fontSize: 14, color: 'var(--label-3)' }}>
            Os indicadores de antes/depois aparecem aqui automaticamente assim que a avaliação inicial for lançada abaixo.
          </div>
        )}
      </div>

      {/* Formulário de Lançamento */}
      <form className="b2b-card" style={{ padding: 16, display: 'grid', gap: 14 }} onSubmit={handleSave}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--label)' }}>
              Registrar Nova Avaliação Presencial / Online
            </div>
            <div style={{ fontSize: 14, color: 'var(--label-3)' }}>
              As medidas são sincronizadas na aba Medidas do app Rit do aluno.
            </div>
          </div>
          <Button type="button" size="sm" variant="ghost" icon="plus" onClick={() => setShowSkinfolds(v => !v)}>
            {showSkinfolds ? 'Ocultar Dobras Cutâneas' : 'Incluir Dobras Cutâneas (mm)'}
          </Button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <TextField label="Data da avaliação" type="date" value={date} onChange={setDate} />
          <SelectField label="Protocolo" value={protocol} onChange={setProtocol} options={PROTOCOL_OPTIONS} />
          <NumberField label="Peso atual" suffix="kg" step="0.1" min={20} max={350} value={weightKg} onChange={setWeightKg} />
          <NumberField label="Altura" suffix="cm" step="1" min={100} max={240} value={heightCm} onChange={setHeightCm} />
          <NumberField label="% Gordura (BF)" suffix="%" step="0.1" min={2} max={65} value={bodyFat} onChange={setBodyFat} />
          <NumberField label="Meta de Peso" suffix="kg" step="0.5" min={20} max={350} value={goalWeightKg} onChange={setGoalWeightKg} />
        </div>

        <div style={{ borderTop: '1px solid var(--sep)', paddingTop: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--label)', marginBottom: 8 }}>
            Perimetria / Circunferências (cm)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            <NumberField label="Peitoral" suffix="cm" step="0.5" min={30} max={220} value={chest} onChange={setChest} />
            <NumberField label="Cintura" suffix="cm" step="0.5" min={30} max={220} value={waist} onChange={setWaist} />
            <NumberField label="Abdômen" suffix="cm" step="0.5" min={30} max={220} value={abdomen} onChange={setAbdomen} />
            <NumberField label="Quadril" suffix="cm" step="0.5" min={30} max={220} value={hips} onChange={setHips} />
            <NumberField label="Braço Dir." suffix="cm" step="0.5" min={15} max={90} value={upperArmRight} onChange={setUpperArmRight} />
            <NumberField label="Braço Esq." suffix="cm" step="0.5" min={15} max={90} value={upperArmLeft} onChange={setUpperArmLeft} />
            <NumberField label="Coxa Dir." suffix="cm" step="0.5" min={20} max={130} value={thighRight} onChange={setThighRight} />
            <NumberField label="Coxa Esq." suffix="cm" step="0.5" min={20} max={130} value={thighLeft} onChange={setThighLeft} />
            <NumberField label="Panturrilha Dir." suffix="cm" step="0.5" min={15} max={80} value={calfRight} onChange={setCalfRight} />
            <NumberField label="Panturrilha Esq." suffix="cm" step="0.5" min={15} max={80} value={calfLeft} onChange={setCalfLeft} />
          </div>
        </div>

        {showSkinfolds && (
          <div style={{ borderTop: '1px solid var(--sep)', paddingTop: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--label)', marginBottom: 8 }}>
              Dobras Cutâneas (mm)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: 10 }}>
              <NumberField label="Tríceps" suffix="mm" step="0.5" min={1} max={100} value={skinfolds.triceps} onChange={v => setSkinfolds(p => ({ ...p, triceps: v }))} />
              <NumberField label="Subescapular" suffix="mm" step="0.5" min={1} max={100} value={skinfolds.subscapular} onChange={v => setSkinfolds(p => ({ ...p, subscapular: v }))} />
              <NumberField label="Abdominal" suffix="mm" step="0.5" min={1} max={100} value={skinfolds.abdominal} onChange={v => setSkinfolds(p => ({ ...p, abdominal: v }))} />
              <NumberField label="Supra-ilíaca" suffix="mm" step="0.5" min={1} max={100} value={skinfolds.iliacCrest} onChange={v => setSkinfolds(p => ({ ...p, iliacCrest: v }))} />
              <NumberField label="Coxa Medial" suffix="mm" step="0.5" min={1} max={100} value={skinfolds.frontThigh} onChange={v => setSkinfolds(p => ({ ...p, frontThigh: v }))} />
            </div>
          </div>
        )}

        <TextArea
          label="Parecer técnico / Anamnese e observações posturais"
          placeholder="Ex.: Boa simetria de membros, manter foco em estabilidade de core e redução gradual de gordura abdominal..."
          rows={2}
          value={clinicalNotes}
          onChange={setClinicalNotes}
        />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14, color: 'var(--label)' }}>
            <input
              type="checkbox"
              checked={notifyWhatsApp}
              onChange={e => setNotifyWhatsApp(e.target.checked)}
              disabled={!phoneDigits}
              style={{ width: 17, height: 17, accentColor: 'var(--acc)' }}
            />
            {phoneDigits ? 'Enviar resumo comparativo automático via WhatsApp' : 'Aluno sem WhatsApp cadastrado'}
          </label>
          <Button type="submit" variant="primary" icon="check" disabled={saving}>
            {saving ? 'Salvando avaliação...' : 'Salvar Avaliação Física'}
          </Button>
        </div>
      </form>

      {/* Histórico de Avaliações */}
      {assessments.length > 0 && (
        <div className="b2b-card" style={{ padding: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--label)', marginBottom: 10 }}>
            Histórico de Avaliações Registradas ({assessments.length})
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            {assessments.map(a => (
              <div key={a.id || a.d} style={{ padding: 12, borderRadius: 10, background: 'var(--bg-el)', border: '1px solid var(--sep)', fontSize: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ fontWeight: 700, color: 'var(--label)' }}>
                    {fmtDateBR(a.d)} {a.trainerName ? `• Avaliador: ${a.trainerName}` : ''}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {a.weightKg != null && <StatusPill tone="acc">{a.weightKg} kg</StatusPill>}
                    {a.bodyFat != null && <StatusPill tone="ok">{a.bodyFat}% BF</StatusPill>}
                    {a.bmi != null && <StatusPill tone="muted">IMC {a.bmi}</StatusPill>}
                    {a.leanMassKg != null && <StatusPill tone="muted">Massa Magra {a.leanMassKg} kg</StatusPill>}
                  </div>
                </div>
                {a.clinicalNotes && (
                  <div style={{ marginTop: 6, color: 'var(--label-2)' }}>{a.clinicalNotes}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
