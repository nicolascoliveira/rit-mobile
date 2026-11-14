import React, { useEffect, useState } from 'react';
import { getStudentAppUrl } from '../lib/api.js';
import '../landing.css';

const LEGAL_DOCS = {
  terms: {
    eyebrow: 'JURÍDICO • RIT TECNOLOGIA FITNESS',
    title: 'Termos de Uso — Plataforma Rit',
    updatedAt: 'Vigência: 2026',
    sections: [
      {
        heading: '1. Objeto e Licenciamento SaaS B2B',
        body: 'A Rit disponibiliza infraestrutura em nuvem para gestão operacional de academias, estúdios e treinadores independentes, incluindo painel administrativo, prescrição inteligente de treinos e aplicativo web/PWA white-label para alunos.'
      },
      {
        heading: '2. Responsabilidade sobre Cadastros e Treinos',
        body: 'Cada academia contratante (tenant) é responsável pela veracidade cadastral de sua equipe e alunos, bem como pela supervisão técnica de profissionais habilitados (CREF) na prescrição de exercícios físicos.'
      },
      {
        heading: '3. Assinatura, Cobrança e Cancelamento',
        body: 'Os planos corporativos seguem periodicidade mensal conforme capacidade contratada, com faturamento processado via Mercado Pago (PIX ou boleto/link). O cancelamento pode ser solicitado pelo gestor sem multa de fidelidade, respeitando o ciclo vigente.'
      },
      {
        heading: '4. Suporte e Contato Oficial',
        body: 'Solicitações contratuais, notificações ou dúvidas sobre estes Termos podem ser enviadas para contato@treinerit.com.br.'
      }
    ]
  },
  privacy: {
    eyebrow: 'PRIVACIDADE & LGPD • RIT TECNOLOGIA FITNESS',
    title: 'Política de Privacidade e Dados (LGPD)',
    updatedAt: 'Conformidade Lei 13.709/2018',
    sections: [
      {
        heading: '1. Controlador e Operador dos Dados',
        body: 'Para dados de alunos cadastrados em uma unidade, a academia contratante atua como Controladora e a Rit atua como Operadora, tratando informações exclusivamente para execução do serviço contratado.'
      },
      {
        heading: '2. Dados Tratados na Plataforma',
        body: 'Tratamos apenas dados necessários ao funcionamento do serviço: nome, e-mail de acesso, telefone WhatsApp (quando informado para notificações e recuperação), histórico de treinos, check-ins e métricas corporais inseridas na plataforma.'
      },
      {
        heading: '3. Segurança e Não Compartilhamento',
        body: 'A Rit não comercializa dados pessoais com terceiros. Comunicações trafegam criptografadas via HTTPS, senhas utilizam derivação criptográfica com salt individual (scrypt) e o acesso suporta Passkeys/WebAuthn.'
      },
      {
        heading: '4. Direitos do Titular e Encarregado (DPO)',
        body: 'Solicitações de acesso, correção, portabilidade ou exclusão de dados podem ser encaminhadas à academia vinculada ou diretamente ao nosso canal de privacidade em contato@treinerit.com.br.'
      }
    ]
  },
  security: {
    eyebrow: 'INFRAESTRUTURA • RIT TECNOLOGIA FITNESS',
    title: 'Segurança e Disponibilidade SaaS',
    updatedAt: 'Arquitetura Isolada em Produção',
    sections: [
      {
        heading: '1. Isolamento Multi-Tenant',
        body: 'Cada academia opera em escopo lógico e armazenamento segregado por tenantId, com validação estrita de sessão e escopo administrativo no servidor para impedir acesso cruzado entre unidades.'
      },
      {
        heading: '2. Proteção de Aplicação e Autenticação',
        body: 'Contas contam com suporte nativo a Passkeys (FIDO2/WebAuthn), tokens HMAC assinados, proteção contra força bruta, cabeçalhos CSP/HSTS, validação de origem (CORS/CSRF) e trilha de auditoria administrativa.'
      },
      {
        heading: '3. Continuidade, Backups e Disponibilidade',
        body: 'Os bancos de dados e registros de tenants contam com rotinas automatizadas de backup e janela de disponibilidade alvo de 99,5%, com monitoramento contínuo de API e gateway de notificações.'
      },
      {
        heading: '4. Reporte Responsável',
        body: 'Incidentes de segurança ou alertas operacionais devem ser reportados imediatamente para contato@treinerit.com.br.'
      }
    ]
  }
};

const HERO_SCREENS = [
  { id: 'dashboard', label: 'Painel da Academia', src: '/landing/portal-dashboard.png' },
  { id: 'students', label: 'Gestão de Alunos', src: '/landing/portal-students.png' },
  { id: 'templates', label: 'Modelos de Fichas', src: '/landing/portal-templates.png' },
  { id: 'builder', label: 'Catálogo 5.632 Exercícios', src: '/landing/portal-builder.png' },
  { id: 'branding', label: 'App com a Sua Marca', src: '/landing/portal-branding.png' },
  { id: 'personal', label: 'Painel do Personal', src: '/landing/portal-personal.png' }
];

const GALLERY_ITEMS = [
  {
    id: 'g1',
    label: 'Visão & Anti-Evasão',
    desktop: '/landing/portal-dashboard.png',
    mobile: '/landing/student-pt-home.png',
    dTitle: 'Painel da Academia — Visão & Anti-Evasão',
    mTitle: 'App do Aluno — Início & Treino do Dia'
  },
  {
    id: 'g2',
    label: 'Alunos & Rotinas',
    desktop: '/landing/portal-students.png',
    mobile: '/landing/student-pt-plan.png',
    dTitle: 'Gestão de Alunos, Matrículas & Prontuário',
    mTitle: 'App do Aluno — Rotina Semanal (A/B/C)'
  },
  {
    id: 'g3',
    label: 'Estúdio de Prescrição',
    desktop: '/landing/portal-builder.png',
    mobile: '/landing/student-pt-workout.png',
    dTitle: 'Estúdio de Prescrição — 5.632 Exercícios PT-BR',
    mTitle: 'App do Aluno — Execução & Progresso de Carga'
  },
  {
    id: 'g4',
    label: 'App com a Sua Marca',
    desktop: '/landing/portal-branding.png',
    mobile: '/landing/student-pt-stats.png',
    dTitle: 'Personalização com a Sua Marca em Tempo Real',
    mTitle: 'App do Aluno — Estatísticas & Evolução'
  },
  {
    id: 'g5',
    label: 'QR Code & Recepção',
    desktop: '/landing/portal-qrcode.png',
    mobile: '/landing/student-pt-home.png',
    dTitle: 'QR Code Oficial de Recepção & Convites',
    mTitle: 'App do Aluno — Acesso Rápido via QR Code'
  }
];

const FAQ_LEFT = [
  {
    num: '001',
    q: 'A Rit é indicada para qual tipo de negócio fitness?',
    a: 'A Rit foi desenvolvida para academias, estúdios e personal trainers que precisam unir gestão de treinos e gestão de alunos em uma única plataforma — oferecendo painel profissional na web e aplicativo personalizado para os alunos.'
  },
  {
    num: '002',
    q: 'Os alunos precisam pagar para utilizar o aplicativo?',
    a: 'Não. O aplicativo é disponibilizado gratuitamente para os alunos pela sua academia ou pelo seu personal trainer como parte do acompanhamento e suporte aos treinos.'
  },
  {
    num: '003',
    q: 'Como funciona a personalização com a marca da academia no aplicativo?',
    a: 'No painel de identidade visual, você configura o nome da sua academia, frase de destaque, cor principal, logotipo e WhatsApp da recepção. As alterações refletem imediatamente no aplicativo utilizado pelos seus alunos.'
  }
];

const FAQ_RIGHT = [
  {
    num: '004',
    q: 'Posso cadastrar múltiplos professores na minha academia?',
    a: 'Sim. As academias contam com gestão completa de equipe e professores, permitindo que cada instrutor prescreva fichas, utilize os modelos padronizados da unidade e acompanhe os alunos sob sua responsabilidade.'
  },
  {
    num: '005',
    q: 'Como o aluno acessa os treinos e visualiza os exercícios?',
    a: 'O aluno escaneia o QR Code oficial na recepção ou acessa o link enviado pelo profissional no WhatsApp. No aplicativo, ele consulta suas fichas (Treino A, B, C), visualiza a execução ilustrada de mais de 5.600 exercícios e acompanha seu histórico.'
  },
  {
    num: '006',
    q: 'A implantação da plataforma na minha operação é complexa?',
    a: 'Não. A plataforma é 100% em nuvem e já vem equipada com modelos de fichas prontos e catálogo completo de exercícios em português. Você ativa sua conta e começa a matricular e prescrever no mesmo dia.'
  }
];

export default function LandingView({ onOpenLogin }) {
  const [heroScreen, setHeroScreen] = useState(HERO_SCREENS[0].src);
  const [heroFading, setHeroFading] = useState(false);
  const [activeGallery, setActiveGallery] = useState(GALLERY_ITEMS[0]);
  const [galleryFading, setGalleryFading] = useState(false);
  const [openFaq, setOpenFaq] = useState({ '001': true });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [legalDoc, setLegalDoc] = useState(null);

  useEffect(() => {
    if (!legalDoc) return undefined;
    const onKeyDown = e => {
      if (e.key === 'Escape') setLegalDoc(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [legalDoc]);

  const handleHeroChange = (src) => {
    if (src === heroScreen) return;
    setHeroFading(true);
    setTimeout(() => {
      setHeroScreen(src);
      setHeroFading(false);
    }, 120);
  };

  const handleGalleryChange = (item) => {
    if (item.id === activeGallery.id) return;
    setGalleryFading(true);
    setTimeout(() => {
      setActiveGallery(item);
      setGalleryFading(false);
    }, 120);
  };

  const toggleFaq = num => {
    setOpenFaq(prev => ({ ...prev, [num]: !prev[num] }));
  };

  return (
    <div className="rit-landing-root">
      {/* 1. TOP ANNOUNCEMENT BAR */}
      <div className="rit-topbar">
        <div className="rit-topbar-inner">
          <span className="rit-topbar-text">Sua academia tem mais de 200 alunos?</span>
          <span className="rit-topbar-dot">•</span>
          <a href="#planos" className="rit-topbar-cta">
            Converse com nosso time para migrar!
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </a>
        </div>
      </div>

      {/* 2. MAIN NAVBAR */}
      <header className="rit-navbar">
        <div className="rit-container rit-navbar-inner">
          <a href="#top" className="rit-brand" aria-label="Rit Home">
            <img src="/landing/rit-logo-neon.png" alt="Rit — Tecnologia para o treinamento físico" fetchPriority="high" decoding="async" />
          </a>

          <nav className="rit-nav-links" aria-label="Navegação principal">
            <a href="#ecossistema">Ecossistema</a>
            <span className="rit-nav-dot">•</span>
            <a href="#solucoes">Soluções</a>
            <span className="rit-nav-dot">•</span>
            <a href="#planos">Modelos</a>
            <span className="rit-nav-dot">•</span>
            <a href="#por-que-escolher">Por que a Rit</a>
            <span className="rit-nav-dot">•</span>
            <a href="#telas">Telas do Sistema</a>
            <span className="rit-nav-dot">•</span>
            <a href="#faq">FAQ</a>
          </nav>

          <div className="rit-nav-actions">
            <a href={getStudentAppUrl()} className="btn-dark-pill btn-student-nav">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#D0FF00" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" /><line x1="12" y1="18" x2="12.01" y2="18" /></svg>
              App do Aluno
            </a>
            <button type="button" onClick={onOpenLogin} className="btn-dark-pill btn-login-nav">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" /></svg>
              Fazer login
            </button>
            <button type="button" onClick={onOpenLogin} className="btn-lime-glow btn-signup-nav">
              Criar conta
              <span className="btn-circle-icon">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" /></svg>
              </span>
            </button>
            <button
              type="button"
              className={'rit-hamburger-btn' + (mobileMenuOpen ? ' open' : '')}
              onClick={() => setMobileMenuOpen(v => !v)}
              aria-label={mobileMenuOpen ? 'Fechar menu' : 'Abrir menu'}
              aria-expanded={mobileMenuOpen}
            >
              {mobileMenuOpen ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
              )}
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="rit-mobile-drawer">
            <div className="rit-container rit-mobile-drawer-inner">
              <nav className="rit-mobile-nav-links" aria-label="Menu mobile">
                <a href="#ecossistema" onClick={() => setMobileMenuOpen(false)}>Ecossistema</a>
                <a href="#solucoes" onClick={() => setMobileMenuOpen(false)}>Soluções</a>
                <a href="#planos" onClick={() => setMobileMenuOpen(false)}>Modelos e Planos</a>
                <a href="#por-que-escolher" onClick={() => setMobileMenuOpen(false)}>Por que a Rit</a>
                <a href="#telas" onClick={() => setMobileMenuOpen(false)}>Telas do Sistema</a>
                <a href="#faq" onClick={() => setMobileMenuOpen(false)}>FAQ</a>
              </nav>

              <div className="rit-mobile-drawer-actions">
                <a
                  href={getStudentAppUrl()}
                  className="btn-dark-pill"
                  onClick={() => setMobileMenuOpen(false)}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D0FF00" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" /><line x1="12" y1="18" x2="12.01" y2="18" /></svg>
                  App do Aluno
                </a>
                <button
                  type="button"
                  className="btn-dark-pill"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    onOpenLogin();
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" /></svg>
                  Fazer login
                </button>
                <button
                  type="button"
                  className="btn-lime-glow"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    onOpenLogin();
                  }}
                >
                  Criar conta
                  <span className="btn-circle-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" /></svg>
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}
      </header>

      {/* 3. HERO SECTION */}
      <section id="top" className="rit-hero">
        <div className="rit-container">
          <div className="rit-hero-center">
            <div className="rit-hero-pill">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
              <span>Gestão de treinos e alunos em um só ecossistema.</span>
            </div>

            <h1 className="rit-hero-title">
              Gestão de treinos e alunos para academias e personais
            </h1>

            <p className="rit-hero-sub">
              Centralize a gestão da sua carteira de alunos, prescreva fichas em segundos com mais de 5.600 exercícios ilustrados, acompanhe a frequência para evitar evasão e entregue um aplicativo moderno com a sua marca.
            </p>

            <div className="rit-hero-ctas">
              <button type="button" onClick={onOpenLogin} className="btn-lime-glow">
                Criar minha conta
                <span className="btn-circle-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" /></svg>
                </span>
              </button>

              <a href="#planos" className="btn-dark-specialist">
                Falar com um especialista
                <span className="btn-circle-lime">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" /></svg>
                </span>
              </a>
            </div>

            <div className="rit-screen-tabs" role="tablist" aria-label="Visualizar telas reais da plataforma Rit">
              {HERO_SCREENS.map(s => (
                <button
                  key={s.id}
                  type="button"
                  className={'rit-screen-tab' + (heroScreen === s.src ? ' active' : '')}
                  onClick={() => handleHeroChange(s.src)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="rit-hero-stage">
            <div className="rit-hero-wings" aria-hidden="true" />
            <img src="/landing/rit-mark-neon.png" alt="" className="rit-hero-wing-mark left" aria-hidden="true" decoding="async" />
            <img src="/landing/rit-mark-neon.png" alt="" className="rit-hero-wing-mark right" aria-hidden="true" decoding="async" />

            <div className="rit-tablet-bezel">
              <div className="rit-tablet-screen">
                <img
                  src={heroScreen}
                  alt="Print real do painel operacional Rit para Academias e Personal Trainers"
                  fetchPriority="high"
                  decoding="async"
                  style={{ opacity: heroFading ? 0.35 : 1, transition: 'opacity 0.18s ease-in-out' }}
                />
              </div>
            </div>
          </div>
        </div>
        <div className="rit-hero-fade" aria-hidden="true" />
      </section>

      {/* 4. ECOSYSTEM MARQUEE STRIP */}
      <section id="ecossistema" className="rit-marquee-section" aria-label="Segmentos e recursos atendidos pela Rit">
        <div className="rit-marquee-mask">
          <div className="rit-marquee-track">
            <span className="rit-marquee-item">Gestão de Treinos</span>
            <span className="rit-marquee-item">Gestão de Alunos</span>
            <span className="rit-marquee-item">Academias Independentes</span>
            <span className="rit-marquee-item">Personal Trainers</span>
            <span className="rit-marquee-item">App com a Sua Marca</span>
            <span className="rit-marquee-item">Retenção Anti-Evasão</span>
            <span className="rit-marquee-item">Gestão de Treinos</span>
            <span className="rit-marquee-item">Gestão de Alunos</span>
            <span className="rit-marquee-item">Academias Independentes</span>
            <span className="rit-marquee-item">Personal Trainers</span>
            <span className="rit-marquee-item">App com a Sua Marca</span>
            <span className="rit-marquee-item">Retenção Anti-Evasão</span>
          </div>

          <div className="rit-marquee-track reverse">
            <span className="rit-marquee-item">5.600+ Exercícios Ilustrados</span>
            <span className="rit-marquee-item">Consultoria Online & Presencial</span>
            <span className="rit-marquee-item">Controle de Frequência</span>
            <span className="rit-marquee-item">Modelos de Fichas A/B/C</span>
            <span className="rit-marquee-item">QR Code na Recepção</span>
            <span className="rit-marquee-item">Evolução do Aluno</span>
            <span className="rit-marquee-item">5.600+ Exercícios Ilustrados</span>
            <span className="rit-marquee-item">Consultoria Online & Presencial</span>
            <span className="rit-marquee-item">Controle de Frequência</span>
            <span className="rit-marquee-item">Modelos de Fichas A/B/C</span>
            <span className="rit-marquee-item">QR Code na Recepção</span>
            <span className="rit-marquee-item">Evolução do Aluno</span>
          </div>
        </div>
      </section>

      {/* 5. SECTION: ACOMPANHAMENTO CONTÍNUO */}
      <section className="rit-support-section">
        <div className="rit-container">
          <div className="rit-support-header">
            <div>
              <div className="rit-section-tag">
                <span className="rit-tag-icon">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" /></svg>
                </span>
                <span className="rit-tag-label">Gestão de Treinos & Alunos</span>
              </div>
              <h2 className="rit-grad-h2">
                Controle seus alunos de perto e atualize treinos de onde estiver.
              </h2>
            </div>

            <p className="rit-support-desc">
              A Rit integra gestão de alunos e prescrição de treinos em um só painel: cadastre sua carteira, monte fichas padronizadas ou personalizadas e acompanhe a execução e frequência no aplicativo em tempo real.
            </p>
          </div>

          <div className="rit-support-grid">
            <div className="rit-bento-dark">
              <div className="rit-orbit-visual">
                <div className="rit-orbit-hub">
                  <img src="/landing/rit-mark-neon.png" alt="Símbolo Rit" loading="lazy" decoding="async" />
                </div>
                <div className="rit-orbit-node n1">
                  <img src="/landing/student-pt-home.png" alt="App do aluno" loading="lazy" decoding="async" />
                </div>
                <div className="rit-orbit-node n2">
                  <img src="/landing/student-pt-plan.png" alt="Plano semanal" loading="lazy" decoding="async" />
                </div>
                <div className="rit-orbit-node n3">
                  <img src="/landing/student-pt-stats.png" alt="Estatísticas" loading="lazy" decoding="async" />
                </div>
                <div className="rit-orbit-node n4">
                  <img src="/landing/portal-dashboard.png" alt="Painel Web" loading="lazy" decoding="async" />
                </div>
                <div className="rit-orbit-node n5">
                  <img src="/landing/rit-mark-neon.png" alt="Rit" loading="lazy" decoding="async" />
                </div>
              </div>

              <div>
                <div className="rit-channel-pills">
                  <span className="rit-channel-pill">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="2" width="14" height="20" rx="2" /><line x1="12" y1="18" x2="12.01" y2="18" /></svg>
                  </span>
                  <span className="rit-channel-pill">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                  </span>
                  <span className="rit-channel-pill">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
                  </span>
                </div>

                <div className="rit-bento-foot">
                  <h3>Experiência integrada em múltiplos canais</h3>
                  <p>Painel web para gestão de treinos e alunos, aplicativo para o aluno e contato ágil via WhatsApp</p>
                </div>
              </div>
            </div>

            <div className="rit-bento-dark">
              <div className="rit-pulse-stack">
                <div className="rit-pulse-bolt">
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
                  <span className="rit-pulse-bolt-sub">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                  </span>
                </div>

                <div className="rit-alert-rows">
                  <div className="rit-alert-row">
                    <div className="rit-alert-user">
                      <div className="rit-alert-avatar">LO</div>
                      <div className="rit-alert-meta">
                        <b>Lucas Oliveira</b>
                        <span>Concluiu Treino A • Peito e Tríceps</span>
                      </div>
                    </div>
                    <span className="rit-alert-btn">Acompanhar</span>
                  </div>

                  <div className="rit-alert-row dim-1">
                    <div className="rit-alert-user">
                      <div className="rit-alert-avatar">MS</div>
                      <div className="rit-alert-meta">
                        <b>Mariana Santos</b>
                        <span>Solicitou atualização da ficha B</span>
                      </div>
                    </div>
                    <span className="rit-alert-btn">Prescrever</span>
                  </div>

                  <div className="rit-alert-row dim-2">
                    <div className="rit-alert-user">
                      <div className="rit-alert-avatar">RA</div>
                      <div className="rit-alert-meta">
                        <b>Rafael Almeida</b>
                        <span>Alerta anti-evasão • 6 dias sem treino</span>
                      </div>
                    </div>
                    <span className="rit-alert-btn">Acionar</span>
                  </div>
                </div>
              </div>

              <div className="rit-bento-foot">
                <h3>Gestão ativa de alunos e frequência</h3>
                <p>Acompanhe treinos concluídos, pedidos de atualização de ficha e alertas de ausência para evitar evasão.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 6. SECTION: SOLUÇÕES (001, 002, 003 + CTA) */}
      <section id="solucoes" className="rit-solutions-section">
        <div className="rit-container rit-solutions-layout">
          <div className="rit-solutions-sticky">
            <div className="rit-section-tag">
              <span className="rit-tag-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></svg>
              </span>
              <span className="rit-tag-label">Gestão completa de treinos e alunos</span>
            </div>

            <h2 className="rit-grad-h2">
              Gestão de treinos e alunos para cada perfil de operação
            </h2>
          </div>

          <div className="rit-solutions-cards">
            <article className="rit-sol-card rit-corner-dots">
              <div>
                <div className="rit-sol-head">
                  <div className="rit-sol-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
                  </div>
                  <h3>Para Academias: Gestão de Alunos, Professores e Fichas</h3>
                </div>
                <p className="rit-sol-body">
                  Gerencie toda a base de alunos e a equipe de professores em um só painel, padronize modelos de fichas para a musculação, reduza a evasão com indicadores de frequência e entregue um aplicativo com a marca da sua academia.
                </p>
              </div>
              <div className="rit-sol-foot">
                <span className="rit-num-pill">001</span>
                <span className="rit-sol-arrow">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
                </span>
              </div>
            </article>

            <article className="rit-sol-card rit-corner-dots">
              <div>
                <div className="rit-sol-head">
                  <div className="rit-sol-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /></svg>
                  </div>
                  <h3>Para Personal Trainers: Carteira de Alunos & Prescrição</h3>
                </div>
                <p className="rit-sol-body">
                  Organize seus alunos presenciais e de consultoria online com histórico, vencimentos e frequência. Monte e atualize treinos em poucos cliques com catálogo de 5.600+ exercícios ilustrados sem depender de planilhas.
                </p>
              </div>
              <div className="rit-sol-foot">
                <span className="rit-num-pill">002</span>
                <span className="rit-sol-arrow">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
                </span>
              </div>
            </article>

            <article className="rit-sol-card rit-corner-dots">
              <div>
                <div className="rit-sol-head">
                  <div className="rit-sol-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                  </div>
                  <h3>Para os Alunos: Treino e Evolução na Palma da Mão</h3>
                </div>
                <p className="rit-sol-body">
                  Consulta rápida das fichas de treinamento (Treino A, B, C), visualização clara dos exercícios com orientações de execução dos movimentos e gráficos de evolução para transformar o ritmo de treino em rotina.
                </p>
              </div>
              <div className="rit-sol-foot">
                <span className="rit-num-pill">003</span>
                <span className="rit-sol-arrow">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>
                </span>
              </div>
            </article>

            <div className="rit-sol-cta-slot">
              <a
                href="https://wa.me/5591985561302?text=Ol%C3%A1%2C%20gostaria%20de%20conhecer%20a%20plataforma%20Rit!"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-lime-glow"
              >
                Fale com nossa equipe
                <span className="btn-circle-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" /></svg>
                </span>
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* 7. LIGHT CONTRAST SECTION */}
      <section className="rit-light-section">
        <div className="rit-container">
          <div className="rit-qr-showcase">
            <div>
              <div className="rit-section-tag">
                <span className="rit-tag-icon">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 2L15 9L22 12L15 15L12 22L9 15L2 12L9 9L12 2Z" /></svg>
                </span>
                <span className="rit-tag-label">Experiência Mobile Rit</span>
              </div>

              <h2 className="rit-light-h2">
                Seu treino, no seu ritmo. Direto no celular do aluno
              </h2>

              <p className="rit-light-sub">
                Com o QR Code da Rit na recepção da academia ou link exclusivo enviado pelo personal trainer, o aluno acessa sua ficha completa e registra cada série sem complicação.
              </p>

              <div className="rit-black-callout">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
                <span>Rápido, intuitivo e sincronizado ao painel do professor.</span>
              </div>

              <div style={{ marginTop: 18 }}>
                <a href={getStudentAppUrl()} className="btn-lime-glow">
                  Acessar App do Aluno
                  <span className="btn-circle-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" /></svg>
                  </span>
                </a>
              </div>
            </div>

            <div className="rit-qr-stage">
              <div className="rit-phone-frame">
                <div className="rit-phone-notch" />
                <div className="rit-phone-screen">
                  <img src="/landing/student-pt-home.png" alt="Print real do aplicativo mobile Rit para o aluno" loading="lazy" decoding="async" />
                </div>
              </div>
              <div className="rit-phone-frame secondary">
                <div className="rit-phone-notch" />
                <div className="rit-phone-screen">
                  <img src="/landing/student-pt-plan.png" alt="Print real da rotina semanal de treinos no app Rit" loading="lazy" decoding="async" />
                </div>
              </div>
            </div>
          </div>

          <div id="planos" className="rit-plans-grid">
            <div className="rit-plan-dark-card">
              <div className="rit-plan-pill-head">
                <div className="rit-plan-pill-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                </div>
                <h3>Personal Trainers</h3>
              </div>

              <div className="rit-plan-rows">
                <div className="rit-plan-row">
                  <div>Ativação Imediata</div>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                </div>
                <div className="rit-plan-row">
                  <div>De 10 a Alunos Ilimitados</div>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                </div>
                <div className="rit-plan-row">
                  <div>A partir de R$ 29 <span className="sub">/mês no PIX</span></div>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2" /></svg>
                </div>
              </div>
            </div>

            <div className="rit-plan-center-col">
              <div className="rit-plan-center-text">
                <h3>Custo sob controle, <span>evolução sem limite</span></h3>
                <p>Planos transparentes adaptados ao momento do seu negócio fitness. Sem burocracia, apenas tecnologia e organização.</p>
              </div>

              <div className="rit-plan-lime-box">
                <div className="rit-plan-lime-thumb">
                  <img src="/landing/rit-mark-neon.png" alt="Símbolo Rit" loading="lazy" decoding="async" />
                </div>
                <div className="rit-plan-lime-content">
                  <h4>Condições especiais para academias e redes.</h4>
                  <a
                    href="https://wa.me/5591985561302?text=Ol%C3%A1%2C%20gostaria%20de%20conversar%20sobre%20as%20condi%C3%A7%C3%B5es%20especiais%20para%20academias!"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-white-pill"
                  >
                    Fale com nossa equipe
                    <span className="btn-circle-dark">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" /></svg>
                    </span>
                  </a>
                </div>
              </div>
            </div>

            <div className="rit-plan-dark-card">
              <div className="rit-plan-pill-head">
                <div className="rit-plan-pill-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>
                </div>
                <h3>Academias & Studios</h3>
              </div>

              <div className="rit-plan-rows">
                <div className="rit-plan-row">
                  <div>App com a Sua Marca</div>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                </div>
                <div className="rit-plan-row">
                  <div>Até 150 ou Ilimitado</div>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                </div>
                <div className="rit-plan-row">
                  <div>A partir de R$ 169 <span className="sub">/mês no PIX</span></div>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2" /></svg>
                </div>
              </div>
            </div>
          </div>

          <div id="por-que-escolher">
            <div className="rit-why-header">
              <div className="rit-section-tag">
                <span className="rit-tag-icon">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><polyline points="20 6 9 17 4 12" /></svg>
                </span>
                <span className="rit-tag-label">Por que escolher a Rit?</span>
              </div>

              <h2 className="rit-light-h2">
                Gestão organizada para você, aplicativo fluido para seus alunos.
              </h2>

              <p className="rit-light-sub" style={{ maxWidth: 640 }}>
                A Rit foi criada para academias e personal trainers que precisam unir gestão de treinos e gestão de alunos sem planilhas nem fichas de papel — do acesso por QR Code à evolução de cada carga.
              </p>
            </div>

            <div className="rit-bento-row-1">
              <div className="rit-why-card glow-top">
                <div className="rit-chat-demo">
                  <div className="rit-chat-msg right">
                    <div className="rit-chat-bubble light">
                      Professor! Acabei o ciclo do Treino A, podemos ajustar as cargas da semana?
                    </div>
                    <div className="rit-chat-av">LO</div>
                  </div>
                  <div className="rit-chat-msg">
                    <div className="rit-chat-av" style={{ borderColor: '#8116E0', color: '#D0FF00' }}>PR</div>
                    <div className="rit-chat-bubble dark">
                      <b>@Lucas</b> ficha atualizada na Rit! Já liberada no seu aplicativo para o treino de hoje.
                    </div>
                  </div>
                </div>

                <div>
                  <h3>Conexão direta entre profissional e aluno</h3>
                  <p>Aproxime o acompanhamento diário com envio rápido de fichas, alertas no WhatsApp e histórico compartilhado.</p>
                </div>
              </div>

              <div className="rit-why-card glow-right">
                <div />
                <div style={{ position: 'relative', zIndex: 2, maxWidth: 240 }}>
                  <h3>Interface intuitiva e fluida</h3>
                  <p>Experiência simples e eficiente tanto para sua equipe técnica quanto para seus alunos.</p>
                </div>
                <div className="rit-mini-portal">
                  <img src="/landing/portal-dashboard.png" alt="Interface do painel Rit" loading="lazy" decoding="async" />
                </div>
              </div>
            </div>

            <div className="rit-bento-row-2">
              <div className="rit-why-card">
                <div className="rit-notif-stack">
                  <div className="rit-check-orb">
                    <div className="rit-check-orb-inner">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    </div>
                  </div>

                  <div className="rit-workout-toast">
                    <div className="rit-toast-badge">R</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, fontWeight: 700, color: '#FEFFFC' }}>
                        <span>Ficha Prescrita</span>
                        <span style={{ color: '#8e8e93', fontWeight: 400 }}>Agora</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: '#8e8e93' }}>Treino A — Peito, Ombros e Tríceps sincronizado</div>
                    </div>
                  </div>

                  <div className="rit-workout-toast t2">
                    <div className="rit-toast-badge">R</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#FEFFFC' }}>Treino Concluído</div>
                      <div style={{ fontSize: 11, color: '#8e8e93' }}>Lucas Oliveira • 6 exercícios finalizados</div>
                    </div>
                  </div>

                  <div className="rit-workout-toast t3">
                    <div className="rit-toast-badge">R</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#FEFFFC' }}>Nova Matrícula</div>
                      <div style={{ fontSize: 11, color: '#8e8e93' }}>QR Code escaneado na recepção</div>
                    </div>
                  </div>
                </div>

                <div>
                  <h3>Prescrição rápida e padronizada</h3>
                  <p>Monte fichas em segundos utilizando modelos prontos da academia ou o catálogo de 5.632 exercícios.</p>
                </div>
              </div>

              <div className="rit-bento-center-stack">
                <div className="rit-why-card" style={{ minHeight: 245, alignItems: 'center', textAlign: 'center', justifyContent: 'center' }}>
                  <div className="rit-check-orb" style={{ marginBottom: 14 }}>
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#D0FF00" strokeWidth="2.2"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                  </div>
                  <h3>Privacidade total e dados isolados em nuvem</h3>
                  <p>Ambientes isolados por unidade ou personal, sincronização em nuvem e acesso imediato.</p>
                </div>

                <div className="rit-why-card lime-solid">
                  <div style={{ marginBottom: 16 }}>
                    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="#080808" strokeWidth="2.2"><line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" /></svg>
                  </div>
                  <h3>Mais retenção e valor percebido</h3>
                  <p>Ofereça uma experiência moderna que fideliza seus alunos e reduz a evasão.</p>
                </div>
              </div>

              <div className="rit-why-card rit-why-tall-visual">
                <div className="rit-why-tall-bg">
                  <img src="/landing/rit-coach.jpg" alt="Personal Trainer e Coach Fitness parceiro Rit" loading="lazy" decoding="async" />
                </div>
                <div className="rit-why-circle-wrap">
                  <svg viewBox="0 0 200 200" className="rit-spinning-circle">
                    <defs>
                      <path id="coachCirclePath" d="M 100, 100 m -74, 0 a 74,74 0 1,1 148,0 a 74,74 0 1,1 -148,0" />
                    </defs>
                    <text fill="#FEFFFC" fontSize="12" fontWeight="700" letterSpacing="3.5" opacity="0.9">
                      <textPath href="#coachCirclePath" startOffset="0%">
                        • VERSATILIDADE • VERSATILIDADE • VERSATILIDADE 
                      </textPath>
                    </text>
                  </svg>
                </div>
                <div className="rit-why-glass-box">
                  <div className="rit-why-glass-icon">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3">
                      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                    </svg>
                  </div>
                  <h3>Versatilidade operacional</h3>
                  <p>Funciona com a mesma excelência para o personal trainer autônomo ou para academias com milhares de alunos.</p>
                </div>
              </div>
            </div>

            <div className="rit-bento-row-3">
              <div className="rit-why-card rit-why-bottom-wide">
                <div>
                  <h3>Evolução visível e execução guiada</h3>
                  <p>Visualização animada dos exercícios, orientações biomecânicas e acompanhamento de carga em cada sessão.</p>
                </div>
                <div className="rit-why-bottom-phone">
                  <img src="/landing/student-pt-stats.png" alt="Tela de estatísticas e progresso no aplicativo Rit" loading="lazy" decoding="async" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 8. REAL SYSTEM INTERACTIVE GALLERY */}
      <section id="telas" className="rit-gallery-section">
        <div className="rit-container">
          <div className="rit-gallery-head">
            <div className="rit-section-tag">
              <span className="rit-tag-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
              </span>
              <span className="rit-tag-label">Por dentro da plataforma</span>
            </div>
            <h2 className="rit-grad-h2" style={{ marginBottom: 12 }}>Conheça as telas reais do ecossistema Rit</h2>
            <p style={{ color: 'var(--rit-text-muted)', fontSize: 15 }}>
              Navegue entre as telas reais de gestão de treinos, gestão de alunos e o aplicativo utilizado pelos alunos no dia a dia.
            </p>

            <div className="rit-screen-tabs" style={{ marginTop: 22 }}>
              {GALLERY_ITEMS.map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={'rit-screen-tab' + (activeGallery.id === item.id ? ' active' : '')}
                  onClick={() => handleGalleryChange(item)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="rit-gallery-grid">
            <div className="rit-gallery-desktop">
              <div className="rit-gallery-desktop-frame">
                <img
                  src={activeGallery.desktop}
                  alt={activeGallery.dTitle}
                  loading="lazy"
                  decoding="async"
                  style={{ opacity: galleryFading ? 0.35 : 1, transition: 'opacity 0.18s ease-in-out' }}
                />
              </div>
              <div className="rit-gallery-caption">
                <b>{activeGallery.dTitle}</b>
                <span>Painel de Gestão • Rit Cloud</span>
              </div>
            </div>

            <div className="rit-gallery-mobile">
              <div className="rit-gallery-mobile-frame">
                <img
                  src={activeGallery.mobile}
                  alt={activeGallery.mTitle}
                  loading="lazy"
                  decoding="async"
                  style={{ opacity: galleryFading ? 0.35 : 1, transition: 'opacity 0.18s ease-in-out' }}
                />
              </div>
              <div className="rit-gallery-caption">
                <b>{activeGallery.mTitle}</b>
                <span>App do Aluno • iOS & Android</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 9. TESTIMONIALS */}
      <section className="rit-testimonials-section">
        <div className="rit-container">
          <div className="rit-testimonials-head">
            <div className="rit-section-tag">
              <span className="rit-tag-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              </span>
              <span className="rit-tag-label">Depoimentos</span>
            </div>
            <h2>Profissionais e academias que evoluíram com a Rit</h2>
          </div>

          <div className="rit-testi-top">
            <div className="rit-quote-mark">“</div>
            <p className="rit-testi-text">
              A implantação na academia foi imediata. Substituímos as fichas de papel pelo aplicativo com a nossa marca e hoje conseguimos enxergar exatamente quais alunos estão perdendo frequência antes de cancelarem a matrícula.
            </p>
            <div className="rit-testi-author">
              <div className="rit-testi-avatar">CE</div>
              <div>
                <b>Carlos Eduardo Mendes</b>
                <span>Proprietário • Iron Power Matriz</span>
              </div>
            </div>
          </div>

          <div className="rit-testi-grid">
            <div className="rit-testi-card">
              <div>
                <div className="rit-quote-mark">“</div>
                <p className="rit-testi-text">
                  Organizei toda a minha carteira de consultoria online e presencial em um único painel. Monto os treinos em minutos e meus alunos elogiam a clareza das animações de execução.
                </p>
              </div>
              <div className="rit-testi-author">
                <div className="rit-testi-avatar">TM</div>
                <div>
                  <b>Thiago Mendes</b>
                  <span>Personal Trainer • Consultoria & Presencial</span>
                </div>
              </div>
            </div>

            <div className="rit-testi-card">
              <div>
                <div className="rit-quote-mark">“</div>
                <p className="rit-testi-text">
                  A Rit trouxe o padrão tecnológico que nosso studio precisava. O QR Code na recepção facilita o acesso do aluno no primeiro dia e a interface transmite muita confiança.
                </p>
              </div>
              <div className="rit-testi-author">
                <div className="rit-testi-avatar">RA</div>
                <div>
                  <b>Renata Alencar</b>
                  <span>Gestora • Studio Pulse Boutique</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 10. FAQ */}
      <section id="faq" className="rit-faq-section">
        <div className="rit-container">
          <div className="rit-faq-head">
            <div className="rit-section-tag">
              <span className="rit-tag-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
              </span>
              <span className="rit-tag-label">FAQ</span>
            </div>
            <h2>Dúvidas Frequentes</h2>
            <p>Tire suas dúvidas sobre a plataforma Rit!</p>
          </div>

          <div className="rit-faq-grid">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {FAQ_LEFT.map(item => (
                <div
                  key={item.num}
                  className={'rit-faq-item' + (openFaq[item.num] ? ' open' : '')}
                  onClick={() => toggleFaq(item.num)}
                >
                  <div className="rit-faq-top">
                    <span className="rit-num-pill">{item.num}</span>
                    <span className="rit-faq-plus">+</span>
                  </div>
                  <div className="rit-faq-q">{item.q}</div>
                  <div className="rit-faq-a">{item.a}</div>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              {FAQ_RIGHT.map(item => (
                <div
                  key={item.num}
                  className={'rit-faq-item' + (openFaq[item.num] ? ' open' : '')}
                  onClick={() => toggleFaq(item.num)}
                >
                  <div className="rit-faq-top">
                    <span className="rit-num-pill">{item.num}</span>
                    <span className="rit-faq-plus">+</span>
                  </div>
                  <div className="rit-faq-q">{item.q}</div>
                  <div className="rit-faq-a">{item.a}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 11. FOOTER */}
      <footer className="rit-footer">
        <div className="rit-container">
          <div className="rit-footer-top">
            <div className="rit-footer-brand">
              <img src="/landing/rit-logo-neon.png" alt="Rit" loading="lazy" decoding="async" />
              <span className="dot">•</span>
              <span className="tagline">Seu treino, no seu ritmo.</span>
            </div>

            <div className="rit-footer-col">
              <h4>Navegue</h4>
              <ul>
                <li><a href="#ecossistema">Ecossistema</a></li>
                <li><a href="#solucoes">Soluções</a></li>
                <li><a href="#planos">Modelos e Planos</a></li>
                <li><a href="#por-que-escolher">Por que a Rit</a></li>
                <li><a href="#telas">Telas do Sistema</a></li>
                <li><a href="#faq">FAQ</a></li>
              </ul>
            </div>

            <div className="rit-footer-col">
              <h4>Plataforma & Transparência</h4>
              <ul>
                <li><button type="button" onClick={onOpenLogin}>Acessar Painel (Academias & Personais)</button></li>
                <li><a href={getStudentAppUrl()} target="_blank" rel="noopener noreferrer">Acessar Aplicativo do Aluno</a></li>
                <li><button type="button" onClick={() => setLegalDoc('terms')}>Termos de Uso</button></li>
                <li><button type="button" onClick={() => setLegalDoc('privacy')}>Política de Privacidade e Dados</button></li>
                <li><button type="button" onClick={() => setLegalDoc('security')}>Segurança e Disponibilidade SaaS</button></li>
              </ul>
            </div>

            <div className="rit-footer-col">
              <h4>Redes sociais</h4>
              <ul>
                <li>
                  <a href="https://instagram.com/treinerit" target="_blank" rel="noopener noreferrer">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#D0FF00" strokeWidth="2.2"><rect x="2" y="2" width="20" height="20" rx="5" /><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" /><line x1="17.5" y1="6.5" x2="17.51" y2="6.5" /></svg>
                    @treinerit
                  </a>
                </li>
              </ul>
            </div>
          </div>

          <div className="rit-footer-bottom">
            <div className="rit-footer-legal">
              <b>@ 2026 RIT TECNOLOGIA FITNESS LTDA — UMA PLATAFORMA. DIFERENTES FORMAS DE TREINAR.</b>
              <span>TECNOLOGIA PARA CONECTAR QUEM OFERECE TREINAMENTO A QUEM BUSCA EVOLUÇÃO • BRASIL</span>
            </div>

            <div className="rit-footer-managers">
              <h5>Consultores de implantação</h5>
              <div className="rit-manager-pills">
                <a
                  href="https://wa.me/5591985561302?text=Ol%C3%A1%2C%20gostaria%20de%20falar%20com%20um%20especialista%20Rit!"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rit-manager-pill"
                >
                  <span>+55 (91) 98556-1302</span>
                  <span className="badge">Especialista Rit</span>
                </a>
                <a href="mailto:contato@treinerit.com.br" className="rit-manager-pill">
                  <span>contato@treinerit.com.br</span>
                </a>
              </div>
            </div>
          </div>
        </div>
      </footer>

      <div className="rit-wa-float">
        <a
          href="https://wa.me/5591985561302?text=Ol%C3%A1%2C%20gostaria%20de%20conhecer%20os%20planos%20da%20plataforma%20Rit%20para%20minha%20academia!"
          target="_blank"
          rel="noopener noreferrer"
          className="rit-wa-bubble"
          aria-label="Abrir conversa no WhatsApp com consultor Rit"
        >
          Oi, está com dúvidas?
        </a>
        <a
          href="https://wa.me/5591985561302?text=Ol%C3%A1%2C%20gostaria%20de%20conhecer%20os%20planos%20da%20plataforma%20Rit%20para%20minha%20academia!"
          target="_blank"
          rel="noopener noreferrer"
          className="rit-wa-btn"
          aria-label="Falar com consultor Rit via WhatsApp"
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
        </a>
      </div>

      {legalDoc && LEGAL_DOCS[legalDoc] && (
        <div
          className="rit-legal-backdrop"
          role="presentation"
          onClick={() => setLegalDoc(null)}
        >
          <div
            className="rit-legal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rit-legal-title"
            onClick={e => e.stopPropagation()}
          >
            <div className="rit-legal-head">
              <div>
                <div className="rit-legal-eyebrow">{LEGAL_DOCS[legalDoc].eyebrow}</div>
                <h2 id="rit-legal-title">{LEGAL_DOCS[legalDoc].title}</h2>
                <div className="rit-legal-meta">{LEGAL_DOCS[legalDoc].updatedAt}</div>
              </div>
              <button
                type="button"
                className="rit-legal-close"
                aria-label="Fechar documento legal"
                onClick={() => setLegalDoc(null)}
              >
                ×
              </button>
            </div>
            <div className="rit-legal-body">
              {LEGAL_DOCS[legalDoc].sections.map(sec => (
                <section key={sec.heading} className="rit-legal-section">
                  <h3>{sec.heading}</h3>
                  <p>{sec.body}</p>
                </section>
              ))}
            </div>
            <div className="rit-legal-foot">
              <button type="button" className="rit-legal-done" onClick={() => setLegalDoc(null)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
