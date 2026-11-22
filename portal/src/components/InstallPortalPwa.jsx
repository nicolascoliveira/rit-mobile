import React, { useState } from 'react';
import Icon from './Icon.jsx';
import { Button, Modal } from './ui.jsx';
import { useOnlineStatus, usePortalPwaInstall } from '../lib/pwa-install.js';

export function PortalPwaInstallModal({ open, onClose, isIOS, isAndroid, hasNativePrompt, onNativeInstall }) {
  const [installing, setInstalling] = useState(false);

  const handleNativeClick = async () => {
    if (!onNativeInstall) return;
    setInstalling(true);
    try {
      const result = await onNativeInstall();
      if (result === 'accepted') onClose?.();
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title="Instalar Rit Painel no Dispositivo"
      subtitle="Abra o painel como aplicativo dedicado, sem barra do navegador."
      footer={
        <>
          {hasNativePrompt && (
            <Button variant="primary" icon="download" loading={installing} onClick={handleNativeClick}>
              Instalar Agora
            </Button>
          )}
          <Button variant={hasNativePrompt ? 'ghost' : 'primary'} onClick={onClose}>
            Entendi
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {isIOS ? (
          <div style={{ padding: 16, borderRadius: 'var(--r)', background: 'var(--bg-el)', border: 'var(--hair) solid var(--sep)', lineHeight: 1.55, fontSize: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 10, fontSize: 15 }}>
              <Icon name="share" size={18} style={{ color: 'var(--acc-ink)' }} />
              <span>Como instalar no iPhone ou iPad (Safari):</span>
            </div>
            <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <li>
                Toque no botão <strong>Compartilhar</strong> (quadrado com seta para cima) na barra inferior do Safari.
              </li>
              <li>
                Role a lista de ações e toque em <strong>Adicionar à Tela de Início</strong>.
              </li>
              <li>
                Confirme tocando em <strong>Adicionar</strong> no canto superior direito.
              </li>
            </ol>
          </div>
        ) : isAndroid ? (
          <div style={{ padding: 16, borderRadius: 'var(--r)', background: 'var(--bg-el)', border: 'var(--hair) solid var(--sep)', lineHeight: 1.55, fontSize: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 10, fontSize: 15 }}>
              <Icon name="download" size={18} style={{ color: 'var(--acc-ink)' }} />
              <span>Como instalar no Android (Chrome):</span>
            </div>
            {hasNativePrompt ? (
              <p style={{ margin: 0 }}>
                Toque no botão <strong>Instalar Agora</strong> abaixo para adicionar o atalho oficial do <strong>Rit Painel</strong> na sua tela inicial.
              </p>
            ) : (
              <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <li>Toque no menu <strong>⋮</strong> no canto superior direito do Chrome.</li>
                <li>Selecione <strong>Instalar aplicativo</strong> ou <strong>Adicionar à tela inicial</strong>.</li>
                <li>Confirme a instalação para abrir em tela cheia.</li>
              </ol>
            )}
          </div>
        ) : (
          <div style={{ padding: 16, borderRadius: 'var(--r)', background: 'var(--bg-el)', border: 'var(--hair) solid var(--sep)', lineHeight: 1.55, fontSize: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 10, fontSize: 15 }}>
              <Icon name="download" size={18} style={{ color: 'var(--acc-ink)' }} />
              <span>Como abrir ou instalar no Computador (Chrome ou Edge):</span>
            </div>
            {hasNativePrompt ? (
              <p style={{ margin: 0 }}>
                Clique em <strong>Instalar Agora</strong> abaixo para criar o aplicativo de área de trabalho com janela própria.
              </p>
            ) : (
              <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <li>
                  <strong>Já aparece "Abrir no app" na barra de endereços?</strong> Isso significa que o <strong>Rit Painel já está instalado</strong> no seu computador — basta clicar em <strong>Abrir no app</strong> no topo do navegador para mudar para a janela dedicada.
                </li>
                <li>
                  <strong>Ainda não instalou?</strong> Clique no ícone de <strong>Instalar aplicativo</strong> no lado direito da barra de endereços, ou abra o menu <strong>⋮</strong> do navegador → <strong>Salvar e compartilhar</strong> → <strong>Instalar página como app...</strong>
                </li>
              </ol>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function InstallPortalPwaButton({
  className = '',
  style = null,
  label = 'Instalar Painel',
  variant = 'ghost',
  size = 'sm',
  sidebarMode = false
}) {
  const { standalone, canInstall, hasNativePrompt, isIOS, isAndroid, triggerNativeInstall } = usePortalPwaInstall();
  const [guideOpen, setGuideOpen] = useState(false);

  if (standalone || !canInstall) return null;

  const handleClick = async () => {
    if (hasNativePrompt) {
      const outcome = await triggerNativeInstall();
      if (outcome === 'accepted' || outcome === 'dismissed') return;
    }
    setGuideOpen(true);
  };

  return (
    <>
      {sidebarMode ? (
        <button
          type="button"
          className={`portal-nav-btn ${className}`.trim()}
          style={{ fontSize: 14, ...style }}
          onClick={handleClick}
          title="Instalar Painel como aplicativo"
        >
          <Icon name="download" size={18} />
          <span>{label}</span>
        </button>
      ) : (
        <Button
          variant={variant}
          size={size}
          icon="download"
          className={className}
          style={{ fontSize: 14, ...style }}
          onClick={handleClick}
          title="Instalar Painel no dispositivo"
        >
          {label}
        </Button>
      )}

      <PortalPwaInstallModal
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        isIOS={isIOS}
        isAndroid={isAndroid}
        hasNativePrompt={hasNativePrompt}
        onNativeInstall={triggerNativeInstall}
      />
    </>
  );
}

export function IosInstallHintCard() {
  const { standalone, isIOS } = usePortalPwaInstall();
  const [guideOpen, setGuideOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (standalone || !isIOS || dismissed) return null;

  return (
    <>
      <div
        role="region"
        aria-label="Instalar aplicativo no iPhone"
        style={{
          marginBottom: 16,
          padding: '12px 14px',
          borderRadius: 'var(--r)',
          background: 'var(--bg-el)',
          border: '1px solid rgba(208, 255, 0, 0.28)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          fontSize: 14
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 220px' }}>
          <Icon name="share" size={18} style={{ color: 'var(--acc-ink)', flexShrink: 0 }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Instalar no iPhone / iPad</div>
            <div className="muted" style={{ fontSize: 14 }}>
              Toque em <strong>Compartilhar</strong> e depois em <strong>Adicionar à Tela de Início</strong>.
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button variant="tinted" size="sm" onClick={() => setGuideOpen(true)} style={{ fontSize: 14 }}>
            Ver passo a passo
          </Button>
          <button
            type="button"
            className="b2b-icon-btn"
            aria-label="Fechar aviso"
            onClick={() => setDismissed(true)}
          >
            <Icon name="xmark" size={16} />
          </button>
        </div>
      </div>

      <PortalPwaInstallModal
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        isIOS={true}
        isAndroid={false}
        hasNativePrompt={false}
        onNativeInstall={null}
      />
    </>
  );
}

export function OfflineStatusBanner() {
  const online = useOnlineStatus();
  if (online) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        padding: '10px 16px',
        background: 'rgba(255, 69, 58, 0.14)',
        borderBottom: '1px solid rgba(255, 69, 58, 0.35)',
        color: '#ffb4af',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexWrap: 'wrap',
        fontSize: 14
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name="cloudSlash" size={17} style={{ flexShrink: 0 }} />
        <span>
          <strong>Você está offline.</strong> Alterações em alunos, fichas e pagamentos exigem conexão com a internet.
        </span>
      </div>
      <Button variant="ghost" size="sm" onClick={() => window.location.reload()} style={{ fontSize: 14 }}>
        Tentar reconectar
      </Button>
    </div>
  );
}
