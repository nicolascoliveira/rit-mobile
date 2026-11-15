import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import {
  getPortalTourSteps,
  getPortalTutorials,
  markPortalTourDismissed,
  markPortalTourDone,
  markPortalTourStep,
  placePortalTourCard
} from '../lib/portal-tour.js';
import './PortalTour.css';

export default function PortalTour({
  session,
  onSetSession,
  onClose,
  currentTab,
  onSelectTab,
  isPersonal = false
}) {
  const cardRef = useRef(null);
  const scrolledForStepRef = useRef('');
  const [rect, setRect] = useState(null);
  const [cardSize, setCardSize] = useState({ width: 372, height: 248 });

  const steps = useMemo(() => getPortalTourSteps(isPersonal), [isPersonal]);
  const tutorials = useMemo(() => getPortalTutorials(isPersonal), [isPersonal]);

  const activeTutorial = useMemo(() => {
    if (!session || session.kind !== 'tutorial') return null;
    return tutorials.find(t => t.id === session.tutorialId) || tutorials[0] || null;
  }, [session, tutorials]);

  const activeSteps = useMemo(() => {
    if (session?.kind === 'tutorial' && activeTutorial) return activeTutorial.steps;
    if (session?.kind === 'tour') return steps;
    return null;
  }, [session?.kind, activeTutorial, steps]);

  const stepIndex = useMemo(() => {
    if (!activeSteps || !activeSteps.length) return 0;
    const raw = Number(session?.step || 0);
    return Math.max(0, Math.min(activeSteps.length - 1, Number.isFinite(raw) ? raw : 0));
  }, [activeSteps, session?.step]);

  const currentStep = activeSteps ? activeSteps[stepIndex] : null;

  // Navega automaticamente até a aba dona do elemento destacado
  useEffect(() => {
    if (!currentStep) return;
    if (currentStep.tab && currentStep.tab !== currentTab && typeof onSelectTab === 'function') {
      onSelectTab(currentStep.tab);
    }
  }, [currentStep, currentTab, onSelectTab]);

  // Mede o alvo com fallback de espera caso a aba esteja montando
  const measureTarget = useCallback(() => {
    if (!currentStep) {
      setRect(null);
      return;
    }
    const el = currentStep.target ? document.querySelector(currentStep.target) : null;
    if (!el) {
      setRect(null);
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      setRect(null);
      return;
    }
    const pad = 8;
    setRect({
      left: Math.round(r.left - pad),
      top: Math.round(r.top - pad),
      right: Math.round(r.right + pad),
      bottom: Math.round(r.bottom + pad),
      width: Math.round(r.width + pad * 2),
      height: Math.round(r.height + pad * 2)
    });
  }, [currentStep]);

  useEffect(() => {
    if (!currentStep) {
      setRect(null);
      scrolledForStepRef.current = '';
      return undefined;
    }

    const stepKey = `${session?.kind}:${activeTutorial?.id || 'main'}:${currentStep.id}`;
    const reduced = typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const tryScrollAndMeasure = () => {
      const el = currentStep.target ? document.querySelector(currentStep.target) : null;
      if (el && scrolledForStepRef.current !== stepKey) {
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight || 800;
        if (r.height > 0 && (r.top < 78 || r.bottom > vh - 36)) {
          el.scrollIntoView({
            behavior: reduced ? 'auto' : 'smooth',
            block: 'center',
            inline: 'nearest'
          });
        }
        scrolledForStepRef.current = stepKey;
      }
      measureTarget();
    };

    tryScrollAndMeasure();
    const t1 = setTimeout(tryScrollAndMeasure, 90);
    const t2 = setTimeout(tryScrollAndMeasure, 260);
    const t3 = setTimeout(measureTarget, 480);

    const onViewportChange = () => measureTarget();
    window.addEventListener('resize', onViewportChange, { passive: true });
    window.addEventListener('scroll', onViewportChange, { passive: true, capture: true });

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [currentStep, session?.kind, activeTutorial?.id, currentTab, measureTarget]);

  useLayoutEffect(() => {
    if (!cardRef.current || !currentStep) return;
    const box = cardRef.current.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      setCardSize(prev =>
        Math.abs(prev.width - box.width) < 2 && Math.abs(prev.height - box.height) < 2
          ? prev
          : { width: Math.round(box.width), height: Math.round(box.height) }
      );
    }
  }, [currentStep, stepIndex, rect]);

  const handleClosePause = useCallback(() => {
    if (session?.kind === 'tour') {
      markPortalTourStep(stepIndex);
    }
    onClose?.();
  }, [session?.kind, stepIndex, onClose]);

  const handleDismiss = useCallback(() => {
    markPortalTourDismissed(session?.kind === 'tour' ? stepIndex : undefined);
    onClose?.();
  }, [session?.kind, stepIndex, onClose]);

  const handleNext = useCallback(() => {
    if (!activeSteps) return;
    if (stepIndex + 1 < activeSteps.length) {
      const nextIdx = stepIndex + 1;
      if (session?.kind === 'tour') {
        markPortalTourStep(nextIdx);
      }
      onSetSession?.({ ...session, step: nextIdx });
    } else if (session?.kind === 'tutorial') {
      onSetSession?.({ kind: 'hub' });
    } else {
      markPortalTourDone();
      onSetSession?.({ kind: 'done' });
    }
  }, [activeSteps, stepIndex, session, onSetSession]);

  const handlePrev = useCallback(() => {
    if (!activeSteps || stepIndex <= 0) return;
    const prevIdx = stepIndex - 1;
    if (session?.kind === 'tour') {
      markPortalTourStep(prevIdx);
    }
    onSetSession?.({ ...session, step: prevIdx });
  }, [activeSteps, stepIndex, session, onSetSession]);

  // Atalhos de teclado durante o tour
  useEffect(() => {
    if (!session) return undefined;
    const onKeyDown = e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (session.kind === 'tour' || session.kind === 'tutorial') {
          handleClosePause();
        } else {
          onClose?.();
        }
      } else if (currentStep && e.key === 'ArrowRight') {
        e.preventDefault();
        handleNext();
      } else if (currentStep && e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePrev();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [session, currentStep, handleClosePause, handleNext, handlePrev, onClose]);

  if (!session) return null;

  /* 1. Modal de boas-vindas ou retomada */
  if (session.kind === 'offer' || session.kind === 'resume') {
    const isResume = session.kind === 'resume';
    const resumeIdx = Math.max(0, Math.min(steps.length - 1, Number(session.resumeStep || 0)));
    return (
      <div className="portal-tour-backdrop" role="dialog" aria-modal="true" aria-labelledby="portal-tour-offer-title">
        <div className="portal-tour-modal">
          <div className="portal-tour-badge-row">
            <span className="portal-tour-pill">
              <Icon name="sparkles" size={16} />
              {session.isNewSignup ? 'Conta criada com sucesso' : 'Guia do painel'}
            </span>
            <button
              type="button"
              className="portal-tour-close-icon"
              aria-label="Fechar"
              onClick={handleDismiss}
            >
              <Icon name="xmark" size={16} />
            </button>
          </div>
          <h2 id="portal-tour-offer-title" className="portal-tour-title">
            {isResume
              ? 'Continuar tour pelo painel?'
              : session.isNewSignup
                ? 'Bem-vindo à Rit! Quer fazer um tour de 1 minuto?'
                : 'Quer conhecer as principais ferramentas do painel?'}
          </h2>
          <p className="portal-tour-body">
            {isResume
              ? `Você parou no passo ${resumeIdx + 1} de ${steps.length}. Podemos continuar exatamente de onde você deixou ou abrir os tutoriais rápidos.`
              : 'Em menos de 1 minuto mostramos onde prescrever treinos, gerar o QR Code de convite, configurar sua marca white-label e ativar o WhatsApp automático.'}
          </p>
          <div className="portal-tour-actions portal-tour-actions-between">
            <button type="button" className="portal-tour-btn portal-tour-btn-ghost" onClick={handleDismiss}>
              Agora não
            </button>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {isResume && (
                <button
                  type="button"
                  className="portal-tour-btn"
                  onClick={() => onSetSession?.({ kind: 'hub' })}
                >
                  Tutoriais
                </button>
              )}
              <button
                type="button"
                className="portal-tour-btn portal-tour-btn-primary"
                onClick={() => onSetSession?.({ kind: 'tour', step: isResume ? resumeIdx : 0 })}
              >
                {isResume ? `Continuar (passo ${resumeIdx + 1})` : 'Fazer tour agora'}
                <Icon name="chevronRight" size={16} />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* 2. Central do botão "Tour Guiado" e card de conclusão com tutoriais rápidos */
  if (session.kind === 'hub' || session.kind === 'done') {
    const isDone = session.kind === 'done';
    return (
      <div className="portal-tour-backdrop" role="dialog" aria-modal="true" aria-labelledby="portal-tour-hub-title">
        <div className="portal-tour-modal portal-tour-modal-wide">
          <div className="portal-tour-badge-row">
            <span className="portal-tour-pill">
              <Icon name={isDone ? 'check' : 'lightbulb'} size={16} />
              {isDone ? 'Tour concluído' : 'Tour Guiado & Tutoriais'}
            </span>
            <button
              type="button"
              className="portal-tour-close-icon"
              aria-label="Fechar"
              onClick={onClose}
            >
              <Icon name="xmark" size={16} />
            </button>
          </div>
          <h2 id="portal-tour-hub-title" className="portal-tour-title">
            {isDone ? 'Tudo pronto para operar seu painel' : 'Escolha o guia ou tutorial prático'}
          </h2>
          <p className="portal-tour-body">
            {isDone
              ? 'Você já conhece os pontos-chave do portal. Se quiser praticar um fluxo específico na prática, toque em um dos tutoriais abaixo:'
              : 'Faça o tour completo pelo painel ou vá direto ao tutorial interativo do que você quer configurar agora:'}
          </p>

          <div className="portal-tutorials-list">
            {tutorials.map(tut => (
              <button
                key={tut.id}
                type="button"
                className="portal-tutorial-item"
                onClick={() => onSetSession?.({ kind: 'tutorial', tutorialId: tut.id, step: 0 })}
              >
                <span className="portal-tutorial-ico" aria-hidden="true">
                  <Icon name={tut.icon} size={18} />
                </span>
                <span className="portal-tutorial-copy">
                  <span className="portal-tutorial-head">
                    <span>{tut.title}</span>
                    <span className="portal-tutorial-time">{tut.duration}</span>
                  </span>
                  <span className="portal-tutorial-desc">{tut.summary}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="portal-tour-actions portal-tour-actions-between">
            <button type="button" className="portal-tour-btn portal-tour-btn-ghost" onClick={onClose}>
              {isDone ? 'Começar a usar' : 'Fechar'}
            </button>
            <button
              type="button"
              className="portal-tour-btn portal-tour-btn-primary"
              onClick={() => onSetSession?.({ kind: 'tour', step: 0 })}
            >
              <Icon name="sparkles" size={16} />
              {isDone ? 'Rever tour completo' : 'Iniciar tour completo'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* 3. Spotlight ativo (tour completo ou mini-tutorial) */
  if (!currentStep) return null;

  const pos = placePortalTourCard(rect, cardSize, currentStep.prefer);
  const arrowStyle =
    pos.placement === 'bottom' || pos.placement === 'top'
      ? { left: pos.arrowOffset }
      : pos.placement === 'left' || pos.placement === 'right'
        ? { top: pos.arrowOffset }
        : null;

  const isLast = stepIndex + 1 >= activeSteps.length;
  const isTutorial = session.kind === 'tutorial';

  return (
    <>
      <div className="portal-tour-click-shield" onClick={handleClosePause} aria-hidden="true" />
      <div className="portal-tour-layer" role="dialog" aria-modal="true" aria-labelledby="portal-tour-step-title">
        {rect && (
          <div
            className="portal-tour-hole"
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height
            }}
          />
        )}

        <div
          ref={cardRef}
          className="portal-tour-card"
          style={{ left: pos.left, top: pos.top }}
        >
          {arrowStyle && (
            <span className={`portal-tour-arrow portal-tour-arrow-${pos.placement}`} style={arrowStyle} aria-hidden="true" />
          )}

          <div className="portal-tour-card-top">
            <span className="portal-tour-counter">
              {isTutorial && activeTutorial
                ? `${activeTutorial.title} · ${stepIndex + 1}/${activeSteps.length}`
                : `Passo ${stepIndex + 1} de ${activeSteps.length}`}
            </span>
            <button
              type="button"
              className="portal-tour-close-icon"
              aria-label="Pausar e fechar tour"
              onClick={handleClosePause}
            >
              <Icon name="xmark" size={16} />
            </button>
          </div>

          <h3 id="portal-tour-step-title" className="portal-tour-card-title">
            {currentStep.title}
          </h3>
          <p className="portal-tour-card-body">{currentStep.body}</p>

          <div className="portal-tour-progress" aria-hidden="true">
            {activeSteps.map((st, idx) => (
              <span
                key={st.id}
                className={`portal-tour-dot${idx < stepIndex ? ' is-done' : ''}${idx === stepIndex ? ' is-active' : ''}`}
              />
            ))}
          </div>

          <div className="portal-tour-actions portal-tour-actions-between">
            <button
              type="button"
              className="portal-tour-btn portal-tour-btn-ghost"
              onClick={isTutorial ? () => onSetSession?.({ kind: 'hub' }) : handleDismiss}
            >
              {isTutorial ? 'Tutoriais' : 'Pular tour'}
            </button>

            <div style={{ display: 'flex', gap: 8 }}>
              {stepIndex > 0 && (
                <button type="button" className="portal-tour-btn" onClick={handlePrev}>
                  <Icon name="chevronLeft" size={15} />
                  Voltar
                </button>
              )}
              <button type="button" className="portal-tour-btn portal-tour-btn-primary" onClick={handleNext}>
                {isLast ? (isTutorial ? 'Concluir' : 'Finalizar') : 'Próximo'}
                {!isLast && <Icon name="chevronRight" size={15} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
