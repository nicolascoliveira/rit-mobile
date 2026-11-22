import React, { useMemo, useState } from 'react';
import Icon from './Icon.jsx';
import { Button, Modal, SelectField, StatusPill, TextArea } from './ui.jsx';
import { importStudentsBatch, toast } from '../lib/api.js';
import { MAX_STUDENT_IMPORT_ROWS, parseStudentImportRows } from '../../../api/student-import.js';

export default function BatchImportModal({
  open,
  onClose,
  templates = [],
  team = [],
  canManage = false,
  onImported
}) {
  const [rawText, setRawText] = useState('');
  const [assignedTrainerId, setAssignedTrainerId] = useState('');
  const [initialTemplateId, setInitialTemplateId] = useState('');
  const [sendWelcome, setSendWelcome] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);

  const previewRows = useMemo(() => parseStudentImportRows(rawText), [rawText]);
  const tooManyRows = previewRows.length > MAX_STUDENT_IMPORT_ROWS;

  const handleFile = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const txt = await file.text();
      setRawText(txt);
      setResult(null);
    } catch {
      toast('Não foi possível ler o arquivo selecionado.');
    }
  };

  const handleSubmit = async () => {
    if (submitting || tooManyRows || previewRows.length === 0) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await importStudentsBatch({
        rows: previewRows,
        assignedTrainerId: assignedTrainerId || undefined,
        initialTemplateId: initialTemplateId || undefined,
        sendWelcome
      });
      setResult(res);
      toast(`${res.createdCount || 0} aluno(s) importados! ${res.queuedWhatsappCount ? `${res.queuedWhatsappCount} convite(s) na fila do WhatsApp.` : ''}`);
      onImported?.(res);
    } catch (err) {
      toast(err.message || 'Erro ao importar alunos em lote');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setResult(null);
    onClose?.();
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      size="lg"
      title="Importação Rápida de Alunos (CSV ou Lista)"
      subtitle="Cadastre múltiplos alunos de uma planilha, atribua um treino inicial e dispare convites com espaçamento anti-bloqueio"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose}>Fechar</Button>
          <Button
            variant="primary"
            icon="upload"
            onClick={handleSubmit}
            disabled={submitting || tooManyRows || previewRows.length === 0}
          >
            {submitting ? 'Importando...' : `Importar${!tooManyRows && previewRows.length ? ` ${previewRows.length}` : ''} alunos`}
          </Button>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <label className="btn secondary sm" style={{ cursor: 'pointer', fontSize: 14 }}>
            <Icon name="upload" size={16} />
            Carregar arquivo .CSV ou .TXT
            <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={handleFile} style={{ display: 'none' }} />
          </label>
          <span style={{ fontSize: 14, color: 'var(--label-3)' }}>
            Ordem: Nome, WhatsApp, E-mail, Objetivo (separados por vírgula ou ponto e vírgula)
          </span>
        </div>

        <TextArea
          label="Cole a lista aqui (com ou sem cabeçalho)"
          placeholder={'Ana Paula; 11999990001; ana@exemplo.com; Hipertrofia\nBruno Silva; 11999990002; bruno@exemplo.com; Emagrecimento'}
          rows={6}
          value={rawText}
          onChange={v => { setRawText(v); setResult(null); }}
        />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {canManage && team.length > 0 && (
            <SelectField
              label="Professor responsável padrão"
              value={assignedTrainerId}
              onChange={setAssignedTrainerId}
              options={[
                { value: '', label: 'Eu mesmo (usuário atual)' },
                ...team.filter(m => !m.disabled).map(m => ({ value: m.id, label: m.name }))
              ]}
            />
          )}
          <SelectField
            label="Ficha inicial automática (opcional)"
            value={initialTemplateId}
            onChange={setInitialTemplateId}
            options={[
              { value: '', label: 'Não aplicar ficha agora' },
              ...templates.map(t => ({ value: t.id, label: t.name }))
            ]}
          />
        </div>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14, color: 'var(--label)' }}>
          <input
            type="checkbox"
            checked={sendWelcome}
            onChange={e => setSendWelcome(e.target.checked)}
            style={{ width: 17, height: 17, accentColor: 'var(--acc)' }}
          />
          Enfileirar convite de boas-vindas no WhatsApp com intervalo gradual anti-ban (3,5s a 7s entre envios)
        </label>

        {tooManyRows && (
          <div role="alert">Importe até {MAX_STUDENT_IMPORT_ROWS} alunos por lote.</div>
        )}

        {previewRows.length > 0 && !tooManyRows && !result && (
          <div style={{ padding: 12, borderRadius: 10, background: 'var(--bg-el)', border: '1px solid var(--sep)' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--label)', marginBottom: 8 }}>
              Pré-visualização ({previewRows.length} linha(s) detectada(s)):
            </div>
            <div style={{ maxHeight: 200, overflowY: 'auto', display: 'grid', gap: 6 }}>
              {previewRows.slice(0, 12).map((r, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, fontSize: 14, paddingBottom: 4, borderBottom: '1px solid var(--sep)' }}>
                  <span style={{ fontWeight: 600, color: 'var(--label)' }}>{r.name || '(sem nome)'}</span>
                  <span style={{ color: 'var(--label-3)' }}>
                    {[r.phone || 'sem WhatsApp', r.email || 'sem e-mail', r.goal].filter(Boolean).join(' · ')}
                  </span>
                </div>
              ))}
              {previewRows.length > 12 && (
                <div style={{ fontSize: 14, color: 'var(--label-3)' }}>+ {previewRows.length - 12} aluno(s)...</div>
              )}
            </div>
          </div>
        )}

        {result && (
          <div style={{ padding: 14, borderRadius: 10, background: 'var(--surface)', border: '1px solid var(--sep)', display: 'grid', gap: 8, fontSize: 14 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <StatusPill tone="ok">{result.createdCount} cadastrado(s)</StatusPill>
              {result.skippedCount > 0 && <StatusPill tone="warn">{result.skippedCount} ignorado(s)</StatusPill>}
              {result.queuedWhatsappCount > 0 && (
                <StatusPill tone="acc">{result.queuedWhatsappCount} convite(s) na fila (~{result.estimatedDurationSec}s)</StatusPill>
              )}
            </div>
            {Array.isArray(result.skipped) && result.skipped.length > 0 && (
              <div style={{ maxHeight: 140, overflowY: 'auto', color: 'var(--orange)' }}>
                {result.skipped.map((sk, idx) => (
                  <div key={idx}>Linha {sk.row} ({sk.name}): {sk.reason}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
