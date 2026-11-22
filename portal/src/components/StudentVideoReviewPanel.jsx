import React, { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import { Button, EmptyState, Segmented, StatusPill, TextArea } from './ui.jsx';
import { fmtDateBR, saveVideoReview, toast } from '../lib/api.js';
import { fetchStudentVideoUrl } from '../lib/media-upload.js';

function AuthenticatedFormVideo({ studentId, video }) {
  const [videoUrl, setVideoUrl] = useState('');
  const [posterUrl, setPosterUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setVideoUrl('');
    setLoaded(false);
    if (!studentId || !video?.posterHash) {
      setPosterUrl('');
      return;
    }
    let cancelled = false;
    fetchStudentVideoUrl(studentId, video.posterHash).then(u => {
      if (!cancelled) setPosterUrl(u || '');
    });
    return () => { cancelled = true; };
  }, [studentId, video?.posterHash, video?.hash]);

  const handleLoadVideo = async () => {
    if (loading || loaded) return;
    setLoading(true);
    try {
      const u = await fetchStudentVideoUrl(studentId, video.hash);
      if (!u) {
        toast('Vídeo ainda não sincronizado no servidor pelo aplicativo do aluno.');
      } else {
        setVideoUrl(u);
        setLoaded(true);
      }
    } finally {
      setLoading(false);
    }
  };

  if (videoUrl) {
    return (
      <video
        src={videoUrl}
        poster={posterUrl || undefined}
        controls
        playsInline
        preload="metadata"
        style={{ width: '100%', maxHeight: 340, borderRadius: 10, background: '#0f172a' }}
      />
    );
  }

  return (
    <div
      style={{
        position: 'relative',
        borderRadius: 10,
        overflow: 'hidden',
        background: 'var(--bg-el)',
        border: '1px solid var(--sep)',
        minHeight: 140,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: 16
      }}
    >
      {posterUrl && (
        <img
          src={posterUrl}
          alt={video.exerciseName}
          style={{ maxHeight: 180, borderRadius: 8, objectFit: 'cover' }}
        />
      )}
      <Button size="sm" variant="primary" icon="play" onClick={handleLoadVideo} disabled={loading}>
        {loading ? 'Carregando vídeo...' : 'Reproduzir Vídeo de Execução'}
      </Button>
    </div>
  );
}

function VideoReviewCard({ student, video, onReviewed }) {
  const [status, setStatus] = useState(video.review?.status || 'reviewed');
  const [comment, setComment] = useState(video.review?.comment || '');
  const [notifyWhatsApp, setNotifyWhatsApp] = useState(true);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async e => {
    e?.preventDefault();
    if (saving || !comment.trim()) {
      toast('Escreva seu feedback técnico antes de salvar.');
      return;
    }
    setSaving(true);
    try {
      const res = await saveVideoReview({
        studentId: student.id,
        key: video.key,
        hash: video.hash,
        status,
        comment: comment.trim(),
        exerciseName: video.exerciseName,
        notifyWhatsApp
      });
      toast(
        res?.whatsapp?.sent
          ? 'Parecer salvo e enviado ao aluno no WhatsApp!'
          : 'Parecer biomecânico salvo no prontuário do aluno!'
      );
      onReviewed?.();
    } catch (err) {
      toast(err.message || 'Não foi possível salvar a revisão');
    } finally {
      setSaving(false);
    }
  };

  const reviewTone = !video.review
    ? 'warn'
    : video.review.status === 'adjust_needed'
      ? 'bad'
      : 'ok';
  const reviewLabel = !video.review
    ? 'Aguardando Revisão'
    : video.review.status === 'adjust_needed'
      ? 'Ajuste Técnico Solicitado'
      : 'Execução Aprovada';

  return (
    <div className="b2b-card" style={{ padding: 16, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--label)' }}>
            {video.exerciseName}
            {video.setIndex ? ` • Série ${video.setIndex}` : ''}
          </div>
          <div style={{ fontSize: 14, color: 'var(--label-3)' }}>
            {fmtDateBR(video.workoutDate)} • {video.workoutName}
            {video.weightKg != null ? ` • ${video.weightKg} kg x ${video.reps || '-'} reps` : ''}
            {video.rir != null ? ` • RIR ${video.rir}` : ''}
          </div>
        </div>
        <StatusPill tone={reviewTone}>{reviewLabel}</StatusPill>
      </div>

      <AuthenticatedFormVideo studentId={student.id} video={video} />

      <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--label)' }}>Classificação da execução:</span>
          <Segmented
            value={status}
            onChange={setStatus}
            options={[
              { value: 'reviewed', label: 'Aprovado / Ótima Execução' },
              { value: 'adjust_needed', label: 'Ajuste Biomecânico' }
            ]}
          />
        </div>

        <TextArea
          label="Feedback técnico para o aluno"
          placeholder="Ex.: Boa profundidade no agachamento! Na subida, mantenha os joelhos alinhados para fora e controle 2s a descida."
          rows={2}
          value={comment}
          onChange={setComment}
        />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--label)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={notifyWhatsApp}
              onChange={e => setNotifyWhatsApp(e.target.checked)}
              disabled={!student?.phone}
              style={{ width: 17, height: 17, accentColor: 'var(--acc)' }}
            />
            {student?.phone ? 'Notificar aluno via WhatsApp e Push' : 'Aluno sem WhatsApp cadastrado'}
          </label>
          <Button type="submit" variant="primary" icon="check" disabled={saving}>
            {saving ? 'Salvando...' : 'Salvar Análise Técnica'}
          </Button>
        </div>

        {video.review?.at && (
          <div style={{ fontSize: 14, color: 'var(--label-3)' }}>
            Última revisão por <b>{video.review.trainerName}</b> em {fmtDateBR(video.review.at)}
          </div>
        )}
      </form>
    </div>
  );
}

export default function StudentVideoReviewPanel({ student, state, onUpdated }) {
  const videos = Array.isArray(state?.formVideos) ? state.formVideos : [];
  const pendingCount = videos.filter(v => !v.review).length;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 15, color: 'var(--label-2)' }}>
          Vídeos sincronizados pelo aluno para correção técnica na consultoria online ou presencial.
        </div>
        {videos.length > 0 && (
          <StatusPill tone={pendingCount > 0 ? 'warn' : 'ok'}>
            {pendingCount > 0 ? `${pendingCount} aguardando análise` : 'Todos analisados'}
          </StatusPill>
        )}
      </div>

      {videos.length > 0 ? (
        videos.map(v => (
          <VideoReviewCard key={v.key} student={student} video={v} onReviewed={onUpdated} />
        ))
      ) : (
        <EmptyState
          icon="video"
          title="Nenhum vídeo de execução enviado"
          message="Quando o aluno gravar uma série no aplicativo Rit e sincronizar (com envio para nuvem ativado), o vídeo aparecerá aqui para sua revisão."
        />
      )}
    </div>
  );
}
