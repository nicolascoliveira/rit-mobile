import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { Button, ConfirmModal, Modal, SelectField, TextArea, TextField } from './ui.jsx';
import { portalApi, toast } from '../lib/api.js';
import {
  DEFAULT_MEDIA_CAPS,
  extractYouTubeId,
  fetchGymMediaUrl,
  prepareAndUploadExerciseMedia
} from '../lib/media-upload.js';

const BODY_PART_OPTIONS = [
  { value: 'chest', label: 'Peito' },
  { value: 'back', label: 'Costas' },
  { value: 'upper legs', label: 'Pernas & Glúteos' },
  { value: 'lower legs', label: 'Panturrilhas' },
  { value: 'shoulders', label: 'Ombros' },
  { value: 'upper arms', label: 'Braços (Bíceps & Tríceps)' },
  { value: 'lower arms', label: 'Antebraços' },
  { value: 'waist', label: 'Abdômen & Core' },
  { value: 'full body', label: 'Corpo Inteiro' },
  { value: 'cardio', label: 'Cardio' },
  { value: 'neck', label: 'Pescoço' },
  { value: 'other', label: 'Outro' }
];

/**
 * Miniatura de exercício no Portal B2B com suporte a mídias autenticadas em `/api/gym/media/{hash}`
 * e fallback elegante para links/YouTube ou catálogo estático.
 */
export function GymExThumb({ exerciseId, tenantCustom, customMedia, customUrl, size = 48 }) {
  const hash = customMedia?.poster?.hash || (customMedia?.kind === 'image' ? customMedia.hash : '');
  const [blobUrl, setBlobUrl] = useState('');
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
    if (!hash) {
      setBlobUrl('');
      return;
    }
    let cancelled = false;
    fetchGymMediaUrl(hash).then(u => {
      if (!cancelled) setBlobUrl(u || '');
    });
    return () => { cancelled = true; };
  }, [hash]);

  const boxStyle = size === 48 ? undefined : { width: size, height: size };

  if (hash) {
    if (blobUrl && !imgFailed) {
      return (
        <img
          src={blobUrl}
          alt=""
          className="b2b-ex-thumb"
          style={boxStyle}
          onError={() => setImgFailed(true)}
        />
      );
    }
    return (
      <span className="b2b-ex-thumb b2b-ex-thumb-icon" style={boxStyle}>
        <Icon name={customMedia?.kind === 'video' ? 'video' : 'camera'} size={Math.round(size * 0.44)} />
      </span>
    );
  }

  if (tenantCustom || customMedia?.kind === 'video' || (!tenantCustom && customUrl && !exerciseId)) {
    return (
      <span className="b2b-ex-thumb b2b-ex-thumb-icon" style={boxStyle}>
        <Icon name={customMedia?.kind === 'video' || extractYouTubeId(customUrl) ? 'video' : 'link'} size={Math.round(size * 0.44)} />
      </span>
    );
  }

  if (!tenantCustom && exerciseId) {
    return (
      <img
        src={`/exercise-media/still/${exerciseId}.webp`}
        alt=""
        className="b2b-ex-thumb"
        style={boxStyle}
        loading="lazy"
        onError={e => { e.currentTarget.style.visibility = 'hidden'; }}
      />
    );
  }

  return (
    <span className="b2b-ex-thumb b2b-ex-thumb-icon" style={boxStyle}>
      <Icon name="dumbbell" size={Math.round(size * 0.44)} />
    </span>
  );
}

function UploadedMediaPreview({ media }) {
  const [mainUrl, setMainUrl] = useState('');
  const [posterUrl, setPosterUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!media?.hash) {
      setMainUrl('');
      setPosterUrl('');
      return;
    }
    fetchGymMediaUrl(media.hash).then(u => { if (!cancelled) setMainUrl(u || ''); });
    if (media.poster?.hash) {
      fetchGymMediaUrl(media.poster.hash).then(u => { if (!cancelled) setPosterUrl(u || ''); });
    } else {
      setPosterUrl('');
    }
    return () => { cancelled = true; };
  }, [media?.hash, media?.poster?.hash]);

  if (!media?.hash) return null;

  return (
    <div className="b2b-media-preview-box">
      {media.kind === 'video' ? (
        mainUrl ? (
          <video
            key={mainUrl}
            src={mainUrl}
            poster={posterUrl || undefined}
            controls
            muted
            loop
            playsInline
            className="b2b-media-preview-el"
          />
        ) : (
          <div className="b2b-media-preview-loading">Carregando prévia do vídeo...</div>
        )
      ) : (
        mainUrl ? (
          <img src={mainUrl} alt="Prévia da mídia" className="b2b-media-preview-el" />
        ) : (
          <div className="b2b-media-preview-loading">Carregando prévia da imagem...</div>
        )
      )}
      <div className="b2b-media-meta-row">
        <span>
          {media.kind === 'video' ? 'Vídeo próprio' : media.kind === 'gif' ? 'GIF próprio' : 'Imagem própria'}
          {media.dur ? ` · ${media.dur}s` : ''}
          {media.size ? ` · ${(media.size / 1048576).toFixed(1)} MB` : ''}
        </span>
      </div>
    </div>
  );
}

export default function ExerciseMediaModal({
  open,
  onClose,
  mode = 'override', // 'override' | 'custom'
  exercise = null,
  equipments = [],
  mediaCaps = DEFAULT_MEDIA_CAPS,
  activeWorkoutLabel = '',
  onSaved,
  onDeleted
}) {
  const isCustomMode = mode === 'custom';
  const isEditingCustom = isCustomMode && Boolean(exercise?.id);
  const caps = { ...DEFAULT_MEDIA_CAPS, ...(mediaCaps || {}) };

  const [name, setName] = useState('');
  const [bp, setBp] = useState('chest');
  const [eq, setEq] = useState('barbell');
  const [desc, setDesc] = useState('');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [media, setMedia] = useState(null);
  const [addToWorkout, setAddToWorkout] = useState(true);

  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setUploading(false);
    setProgress(null);
    setSaving(false);
    setConfirmDeleteOpen(false);
    setAddToWorkout(true);

    if (isCustomMode) {
      setName(exercise?.name || '');
      setBp(exercise?.bp || 'chest');
      setEq(exercise?.eq || 'other');
      setDesc(exercise?.desc || exercise?.customNote || '');
      setUrl(exercise?.customUrl || exercise?.url || '');
      setMedia(exercise?.customMedia || exercise?.media || null);
      setNote('');
    } else {
      setName(exercise?.name || exercise?.id || '');
      setUrl(exercise?.customUrl || '');
      setNote(exercise?.customNote || '');
      setMedia(exercise?.customMedia || null);
    }
  }, [open, isCustomMode, exercise]);

  const ytId = extractYouTubeId(url);
  const submitUrl = (() => {
    const trimmed = url.trim();
    if (!trimmed) return '';
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return ytId ? `https://${trimmed}` : trimmed;
  })();
  const hasExistingOverride = !isCustomMode && Boolean(exercise?.customMedia || exercise?.customUrl || exercise?.customNote);

  const handleFileChange = async evt => {
    const file = evt.target?.files?.[0];
    if (evt.target) evt.target.value = '';
    if (!file) return;

    setUploading(true);
    setProgress({ stage: 'Preparando arquivo...', pct: 2 });
    try {
      const ref = await prepareAndUploadExerciseMedia(file, caps, p => setProgress(p));
      setMedia(ref);
      toast('Mídia enviada! Clique em salvar para aplicar aos alunos.');
    } catch (err) {
      toast(err?.message || 'Erro ao enviar arquivo de vídeo/imagem.');
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    if (uploading || saving) return;

    if (isCustomMode) {
      if (!name.trim()) {
        toast('Informe o nome do exercício.');
        return;
      }
      setSaving(true);
      try {
        const res = await portalApi('/api/gym/custom-exercises', {
          method: 'POST',
          body: {
            id: exercise?.id || undefined,
            name: name.trim(),
            bp,
            eq,
            desc: desc.trim(),
            media: media || null,
            url: submitUrl
          }
        });
        toast(isEditingCustom ? 'Exercício da academia atualizado!' : 'Exercício criado e disponível na academia!');
        onSaved?.({ type: 'custom', exercise: res.exercise, addToWorkout: !isEditingCustom && addToWorkout });
        onClose?.();
      } catch (err) {
        toast(err?.message || 'Erro ao salvar exercício customizado.');
      } finally {
        setSaving(false);
      }
      return;
    }

    if (!media && !submitUrl && !note.trim()) {
      toast('Envie um vídeo/foto, informe um link de vídeo ou restaure o padrão.');
      return;
    }

    setSaving(true);
    try {
      const res = await portalApi('/api/gym/exercise-media', {
        method: 'PUT',
        body: {
          exerciseId: exercise.id,
          media: media || null,
          url: submitUrl,
          note: note.trim()
        }
      });
      toast('Vídeo da academia atualizado para todos os alunos!');
      onSaved?.({ type: 'override', exerciseId: exercise.id, override: res.override || null });
      onClose?.();
    } catch (err) {
      toast(err?.message || 'Erro ao salvar vídeo do exercício.');
    } finally {
      setSaving(false);
    }
  };

  const performDeleteCustom = async () => {
    if (!exercise?.id || uploading || saving) return;
    setSaving(true);
    try {
      await portalApi(`/api/gym/custom-exercises?id=${encodeURIComponent(exercise.id)}`, { method: 'DELETE' });
      toast('Exercício excluído.');
      setConfirmDeleteOpen(false);
      onDeleted?.({ type: 'custom', id: exercise.id });
      onClose?.();
    } catch (err) {
      toast(err?.message || 'Erro ao excluir exercício.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteOrRestore = async () => {
    if (uploading || saving) return;
    if (isCustomMode) {
      if (!exercise?.id) return;
      setConfirmDeleteOpen(true);
      return;
    }

    setSaving(true);
    try {
      await portalApi(`/api/gym/exercise-media?exerciseId=${encodeURIComponent(exercise.id)}`, { method: 'DELETE' });
      toast('Animação oficial do catálogo restaurada!');
      onDeleted?.({ type: 'override', exerciseId: exercise.id });
      onClose?.();
    } catch (err) {
      toast(err?.message || 'Erro ao restaurar padrão.');
    } finally {
      setSaving(false);
    }
  };

  const equipmentOptions = [
    ...equipments.map(item => ({ value: item.id, label: item.label })),
    ...(equipments.some(e => e.id === 'other') ? [] : [{ value: 'other', label: 'Outro / Sem aparelho específico' }])
  ];

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        size="md"
        title={
          isCustomMode
            ? (isEditingCustom ? `Editar Exercício — ${exercise?.name || ''}` : 'Novo Exercício da Academia')
            : `Vídeo do Exercício — ${exercise?.name || exercise?.id || ''}`
        }
        subtitle={
          isCustomMode
            ? 'Disponível para todos os professores e visível no app dos alunos da academia.'
            : 'Substitui a animação do catálogo por seu vídeo, foto ou link do YouTube para todos os alunos desta academia.'
        }
        footer={
          <>
            {(hasExistingOverride || isEditingCustom) && (
              <Button
                variant="ghost"
                icon={isEditingCustom ? 'trash' : 'rotateCcw'}
                onClick={handleDeleteOrRestore}
                disabled={saving || uploading}
                style={{ color: 'var(--red)', marginRight: 'auto' }}
              >
                {isEditingCustom ? 'Excluir exercício' : 'Restaurar padrão do catálogo'}
              </Button>
            )}
            <Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
            <Button variant="primary" icon="check" onClick={handleSave} loading={saving} disabled={uploading}>
              {saving
                ? 'Salvando...'
                : isCustomMode
                  ? (isEditingCustom ? 'Salvar alterações' : (addToWorkout && activeWorkoutLabel ? 'Criar e adicionar' : 'Criar exercício'))
                  : 'Salvar para a academia'}
            </Button>
          </>
        }
      >
        <div className="b2b-media-editor">
          {isCustomMode && (
            <>
              <TextField
                label="Nome do exercício"
                required
                value={name}
                onChange={setName}
                placeholder="Ex: Agachamento no Pêndulo articulado"
              />
              <div className="b2b-form-grid">
                <SelectField
                  label="Grupo muscular"
                  value={bp}
                  onChange={setBp}
                  options={BODY_PART_OPTIONS}
                />
                <SelectField
                  label="Equipamento"
                  value={eq}
                  onChange={setEq}
                  options={equipmentOptions}
                />
              </div>
              <TextArea
                label="Instruções de execução (opcional)"
                rows={2}
                value={desc}
                onChange={setDesc}
                placeholder="Descreva postura, cadência e execução para o aluno..."
              />
            </>
          )}

          <div className="b2b-media-upload-card">
            <div className="b2b-media-upload-head">
              <div>
                <div className="b2b-field-lbl" style={{ marginBottom: 4 }}>Upload de Vídeo, GIF ou Foto</div>
                <div className="b2b-media-caps">
                  MP4, MOV ou WebM até {caps.videoMB} MB ({caps.videoSec}s) · GIF até {caps.gifMB} MB · Foto até {caps.imageMB} MB
                </div>
              </div>
              <label
                className={'btn secondary sm b2b-upload-lbl' + (uploading ? ' is-disabled' : '')}
                aria-disabled={uploading || saving}
              >
                <Icon name="upload" size={16} />
                <span>{uploading ? 'Enviando...' : (media ? 'Trocar arquivo' : 'Escolher vídeo / foto')}</span>
                <input
                  type="file"
                  accept="video/mp4,video/quicktime,video/webm,image/gif,image/jpeg,image/png,image/webp"
                  onChange={handleFileChange}
                  disabled={uploading || saving}
                  style={{ display: 'none' }}
                />
              </label>
            </div>

            {uploading && progress && (
              <div className="b2b-media-progress">
                <div className="b2b-media-progress-bar">
                  <div style={{ width: `${progress.pct || 0}%` }} />
                </div>
                <span>{progress.stage} ({progress.pct || 0}%)</span>
              </div>
            )}

            {media && (
              <div style={{ marginTop: 10 }}>
                <UploadedMediaPreview media={media} />
                <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
                  <Button variant="ghost" size="sm" icon="trash" onClick={() => setMedia(null)} style={{ color: 'var(--red)' }}>
                    Remover arquivo enviado
                  </Button>
                </div>
              </div>
            )}
          </div>

          <TextField
            label="Ou cole um link de YouTube / vídeo externo (opcional)"
            value={url}
            onChange={setUrl}
            placeholder="https://www.youtube.com/watch?v=... ou https://..."
            hint="Aceita YouTube, Shorts ou link HTTPS direto. Se enviar vídeo e link juntos, o player mostra seu vídeo primeiro e deixa o link logo abaixo."
          />

          {ytId && (
            <div>
              <div className="b2b-media-yt-wrap">
                {/* Portal sends Referrer-Policy: same-origin, so the iframe must opt into sending its origin or YouTube blocks playback with Error 153. */}
                <iframe
                  key={ytId}
                  src={`https://www.youtube-nocookie.com/embed/${ytId}?playsinline=1`}
                  title="Prévia do YouTube"
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  allowFullScreen
                  referrerPolicy="strict-origin-when-cross-origin"
                />
              </div>
              <div style={{ marginTop: 6, display: 'flex', justifyContent: 'flex-end', fontSize: 14 }}>
                <a
                  href={`https://www.youtube.com/watch?v=${ytId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--label-2)', textDecoration: 'underline' }}
                >
                  Abrir vídeo no YouTube
                </a>
              </div>
            </div>
          )}

          {!isCustomMode && (
            <TextArea
              label="Orientação técnica padrão deste exercício na academia (opcional)"
              rows={2}
              value={note}
              onChange={setNote}
              placeholder="Ex: Padrão da academia: executar com pausa de 1s na base..."
            />
          )}

          {isCustomMode && !isEditingCustom && activeWorkoutLabel && (
            <label className="b2b-media-check">
              <input
                type="checkbox"
                checked={addToWorkout}
                onChange={e => setAddToWorkout(e.target.checked)}
              />
              <span>Adicionar automaticamente em <b>{activeWorkoutLabel}</b> ao salvar</span>
            </label>
          )}
        </div>
      </Modal>

      <ConfirmModal
        open={confirmDeleteOpen}
        onClose={() => !saving && setConfirmDeleteOpen(false)}
        title="Excluir exercício da biblioteca?"
        subtitle={exercise?.name || ''}
        message={
          <>
            Deseja excluir permanentemente o exercício <b>"{exercise?.name}"</b> da biblioteca da academia?
          </>
        }
        confirmLabel="Excluir exercício"
        confirmVariant="danger"
        confirmIcon="trash"
        loading={saving}
        onConfirm={performDeleteCustom}
      />
    </>
  );
}
