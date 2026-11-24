import React, { useEffect, useMemo, useState } from 'react';
import Icon from '../components/Icon.jsx';
import { Button, StatusPill } from '../components/ui.jsx';
import { portalApi, toast, getStudentAppUrl } from '../lib/api.js';
import { isNativePortalApp, openStudentNativeApp } from '../lib/native.js';
import {
  InstallPortalPwaButton,
  IosInstallHintCard,
  OfflineStatusBanner
} from '../components/InstallPortalPwa.jsx';

function AuthPasswordInput({ id, value, onChange, placeholder, autoComplete, required }) {
  const [show, setShow] = useState(false);
  return (
    <div className="b2b-auth-input-wrap">
      <input
        id={id}
        className="b2b-auth-input"
        type={show ? 'text' : 'password'}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        autoComplete={autoComplete}
        required={required}
        style={{ paddingRight: 46 }}
      />
      <button
        type="button"
        className={`b2b-auth-eye${show ? ' active' : ''}`}
        onClick={() => setShow(s => !s)}
        aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}
        title={show ? 'Ocultar senha' : 'Mostrar senha'}
      >
        <Icon name={show ? 'eyeSlash' : 'eye'} size={18} />
      </button>
    </div>
  );
}

export default function AuthView({
  bootstrap,
  onAuthenticated,
  theme,
  onToggleTheme,
  onRefreshBootstrap,
  onBackToLanding,
  initialMode = 'login',
  initialAccountType = 'gym'
}) {
  const [b2bMode, setB2bMode] = useState(() => (
    initialMode === 'signup' ? 'signup' : (initialMode === 'forgot' ? 'forgot' : 'login')
  ));
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [adminName, setAdminName] = useState('Administrador Geral');
  const [setupToken, setSetupToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);

  // Campos de recuperação de senha B2B ("Esqueci minha senha")
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotChallenge, setForgotChallenge] = useState(null);
  const [forgotCode, setForgotCode] = useState('');
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotChannelBusy, setForgotChannelBusy] = useState(false);

  // Campos do auto-cadastro B2B ("Criar Conta")
  const [signupType, setSignupType] = useState(() => (initialAccountType === 'personal' ? 'personal' : 'gym'));
  const [signupGymName, setSignupGymName] = useState('');
  const [signupOwnerName, setSignupOwnerName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPhone, setSignupPhone] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupPlanId, setSignupPlanId] = useState(() => (initialAccountType === 'personal' ? 'personal' : 'starter'));
  const [signupTermsAccepted, setSignupTermsAccepted] = useState(false);
  const [showLegalSummary, setShowLegalSummary] = useState(false);

  const availablePlans = useMemo(() => {
    const list = Array.isArray(bootstrap?.plans) && bootstrap.plans.length
      ? bootstrap.plans
      : [
          { id: 'personal', name: 'Personal Inicial', accountType: 'personal', priceMonthly: 29, maxStudents: 10 },
          { id: 'personal-pro', name: 'Personal Completo', accountType: 'personal', priceMonthly: 49, maxStudents: 999999 },
          { id: 'starter', name: 'Estúdio', accountType: 'gym', priceMonthly: 169, maxStudents: 150 },
          { id: 'pro', name: 'Academia Completa', accountType: 'gym', priceMonthly: 269, maxStudents: 999999 }
        ];
    return list;
  }, [bootstrap?.plans]);

  useEffect(() => {
    setB2bMode(initialMode === 'signup' ? 'signup' : (initialMode === 'forgot' ? 'forgot' : 'login'));
  }, [initialMode]);

  useEffect(() => {
    const nextType = initialAccountType === 'personal' ? 'personal' : 'gym';
    setSignupType(nextType);
    const matching = availablePlans.filter(p => (p.accountType === 'personal' ? 'personal' : 'gym') === nextType);
    if (matching.length) setSignupPlanId(matching[0].id);
  }, [initialAccountType, availablePlans]);

  const handleSelectSignupType = nextType => {
    setSignupType(nextType);
    const matching = availablePlans.filter(p => (p.accountType === 'personal' ? 'personal' : 'gym') === nextType);
    if (matching.length && !matching.some(p => p.id === signupPlanId)) {
      setSignupPlanId(matching[0].id);
    }
  };

  const switchB2bMode = nextMode => {
    setB2bMode(nextMode);
    if (nextMode === 'forgot') {
      if (!forgotEmail && identifier.includes('@')) setForgotEmail(identifier.trim());
    } else {
      setForgotChallenge(null);
      setForgotCode('');
      setForgotNewPassword('');
    }
    if (typeof window !== 'undefined') {
      const targetPath = nextMode === 'signup' ? '/cadastro' : (nextMode === 'forgot' ? '/recuperar-senha' : '/login');
      if (isNativePortalApp()) {
        const nextHash = `#${targetPath}`;
        if (window.location.hash !== nextHash) {
          window.history.pushState(null, '', `${window.location.pathname}${window.location.search}${nextHash}`);
        }
      } else if (window.location.pathname !== targetPath) {
        window.history.pushState(null, '', targetPath);
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const isSetupRoute = typeof window !== 'undefined' && (
    window.location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase() === 'setup-superadmin' ||
    window.location.hash.replace(/^#\/?/, '').toLowerCase() === 'setup-superadmin'
  );
  const isInitialSetup = Boolean(bootstrap && bootstrap.hasSuperAdmin === false && isSetupRoute);
  const setupTokenRequired = Boolean(bootstrap?.setupTokenRequired);
  const setupDisabled = Boolean(bootstrap?.setupDisabled);

  const handleSetupAdmin = async e => {
    e?.preventDefault();
    if (setupDisabled) {
      return toast('Configure SETUP_ADMIN_TOKEN (>= 12 caracteres) no servidor para habilitar o setup inicial.');
    }
    if (!identifier || !password) {
      return toast('Preencha o e-mail e a senha do administrador');
    }
    if (password.length < 10) {
      return toast('A senha de produção deve ter no mínimo 10 caracteres');
    }
    if (setupTokenRequired && !setupToken.trim()) {
      return toast('Informe o token de instalação (SETUP_ADMIN_TOKEN)');
    }
    setLoading(true);
    try {
      const res = await portalApi('/api/saas/auth/setup-admin', {
        method: 'POST',
        body: {
          email: identifier.trim(),
          password,
          name: adminName.trim() || 'Administrador Geral',
          ...(setupToken.trim() ? { setupToken: setupToken.trim() } : {})
        },
        tenantId: ''
      });
      await onRefreshBootstrap?.();
      onAuthenticated(res);
      toast('Administrador Geral configurado com sucesso!');
    } catch (err) {
      toast(err.message || 'Falha ao configurar administrador');
    } finally {
      setLoading(false);
    }
  };

  const handleSignup = async e => {
    e.preventDefault();
    if (!signupGymName.trim() || signupGymName.trim().length < 2) {
      toast(signupType === 'personal' ? 'Informe seu nome ou consultoria' : 'Informe o nome da academia');
      return;
    }
    const ownerValue = (signupOwnerName || (signupType === 'personal' ? signupGymName : '')).trim();
    if (!ownerValue || ownerValue.length < 2) {
      toast('Informe o nome completo do responsável');
      return;
    }
    if (!signupEmail.trim() || !signupEmail.includes('@')) {
      toast('Informe um e-mail válido');
      return;
    }
    if (!signupPassword || signupPassword.length < 10) {
      toast('A senha deve ter no mínimo 10 caracteres');
      return;
    }
    if (!signupTermsAccepted) {
      toast('Aceite os Termos de Uso e a Política de Privacidade (LGPD) para continuar');
      return;
    }
    setLoading(true);
    try {
      const res = await portalApi('/api/saas/auth/register', {
        method: 'POST',
        body: {
          accountType: signupType,
          gymName: signupGymName.trim(),
          ownerName: ownerValue,
          email: signupEmail.trim(),
          phone: signupPhone.trim(),
          password: signupPassword,
          planId: signupPlanId,
          termsAccepted: true,
          termsAcceptedAt: new Date().toISOString()
        },
        tenantId: ''
      });
      toast(res?.message || 'Conta criada! Seus 14 dias grátis começaram.');
      onAuthenticated(res);
    } catch (err) {
      toast(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRequestResetOtp = async (e, channel = 'auto') => {
    e?.preventDefault();
    const cleanEmail = forgotEmail.trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      toast('Informe o e-mail cadastrado da sua conta');
      return;
    }
    if (channel === 'whatsapp') setForgotChannelBusy(true);
    else setLoading(true);
    try {
      const res = await portalApi('/api/auth/verification/send', {
        method: 'POST',
        body: { email: cleanEmail, purpose: 'reset', channel },
        tenantId: ''
      });
      setForgotChallenge(res);
      toast(
        channel === 'whatsapp'
          ? `Código enviado para seu WhatsApp (${res.maskedPhone || 'cadastrado'})!`
          : `Código de 6 dígitos enviado para ${res.maskedEmail || cleanEmail}`
      );
    } catch (err) {
      toast(err.message || 'Não foi possível enviar o código de verificação');
    } finally {
      setLoading(false);
      setForgotChannelBusy(false);
    }
  };

  const handleConfirmResetPassword = async e => {
    e.preventDefault();
    const cleanEmail = forgotEmail.trim().toLowerCase();
    const code = forgotCode.replace(/\D/g, '');
    if (!forgotChallenge?.challengeId) {
      toast('Solicite o código de verificação primeiro');
      return;
    }
    if (code.length !== 6) {
      toast('Digite o código de 6 dígitos recebido');
      return;
    }
    if (!forgotNewPassword || forgotNewPassword.length < 10) {
      toast('A nova senha deve ter no mínimo 10 caracteres');
      return;
    }
    setLoading(true);
    try {
      const res = await portalApi('/api/saas/auth/password-reset', {
        method: 'POST',
        body: {
          email: cleanEmail,
          challengeId: forgotChallenge.challengeId,
          otpCode: code,
          password: forgotNewPassword
        },
        tenantId: ''
      });
      toast(res?.message || 'Senha redefinida com sucesso!');
      if (res?.token && res?.user) {
        onAuthenticated(res);
      } else {
        setIdentifier(cleanEmail);
        switchB2bMode('login');
      }
    } catch (err) {
      toast(err.message || 'Código inválido ou expirado');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = async e => {
    e.preventDefault();
    if (!identifier.trim() || !password) {
      toast('Informe seu e-mail e senha para continuar');
      return;
    }
    setLoading(true);
    try {
      const res = await portalApi('/api/saas/auth/login', {
        method: 'POST',
        body: { identifier: identifier.trim(), password },
        tenantId: ''
      });
      onAuthenticated(res);
    } catch (err) {
      if (err?.data?.code === 'student-account') {
        toast('Conta de aluno identificada! Redirecionando para o App de Treino...');
        setTimeout(() => {
          if (isNativePortalApp()) {
            openStudentNativeApp(err.data?.tenantId || '');
          } else {
            window.location.href = getStudentAppUrl(err.data?.tenantId || '');
          }
        }, 500);
        return;
      }
      toast(err.message || 'Falha ao autenticar');
    } finally {
      setLoading(false);
    }
  };

  const handleQuickDemo = async (mode, tenantId = null) => {
    setLoading(true);
    try {
      const res = await portalApi('/api/saas/auth/demo-login', {
        method: 'POST',
        body: { mode, tenantId },
        tenantId: ''
      });
      await onRefreshBootstrap?.();
      onAuthenticated(res);
    } catch (err) {
      toast(err.message || 'Não foi possível entrar no modo demonstração');
    } finally {
      setLoading(false);
    }
  };

  const handleSeedDemo = async () => {
    setSeeding(true);
    try {
      await portalApi('/api/saas/demo/seed', { method: 'POST', body: {}, tenantId: '' });
      await onRefreshBootstrap?.();
      toast('Ambiente de demonstração populado com academias, equipe e alunos!');
    } catch (err) {
      toast(err.message || 'Erro ao popular dados');
    } finally {
      setSeeding(false);
    }
  };

  const gyms = bootstrap?.gyms || [];
  const demoAllowed = Boolean(bootstrap?.demoAllowed);
  const filteredPlans = useMemo(
    () => availablePlans.filter(p => (p.accountType === 'personal' ? 'personal' : 'gym') === signupType),
    [availablePlans, signupType]
  );

  return (
    <div className="b2b-auth-screen" style={{ flexDirection: 'column', gap: 16 }}>
      <OfflineStatusBanner />
      <div className={'b2b-auth-wrap' + (demoAllowed ? '' : ' single')}>
        {/* Coluna 1: Login / Cadastro / Planos Oficial Rit */}
        <div className="b2b-auth-card">
          <div>
            <div className="b2b-auth-topbar">
              {onBackToLanding ? (
                <button
                  type="button"
                  className="b2b-auth-back"
                  onClick={onBackToLanding}
                >
                  <Icon name="arrowLeft" size={18} />
                  <span>{isNativePortalApp() ? 'App do Aluno' : 'Voltar'}</span>
                </button>
              ) : <div />}

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <InstallPortalPwaButton variant="tinted" label="Instalar" />
                <button
                  type="button"
                  className="b2b-icon-btn"
                  onClick={onToggleTheme}
                  title={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
                  aria-label={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
                >
                  <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
                </button>
              </div>
            </div>

            <div className="b2b-auth-brand">
              <img
                src={theme === 'light' ? '/rit-logo-light.png' : '/rit-logo.png'}
                alt="Rit"
              />
            </div>

            <IosInstallHintCard />

            {isInitialSetup ? (
              <>
                <h1 className="b2b-auth-title">Criar Super Administrador</h1>
                <p className="b2b-auth-subtitle">
                  Configure o acesso mestre da plataforma Rit para controlar planos, faturamento e unidades.
                </p>

                {setupDisabled ? (
                  <div style={{
                    padding: '14px 16px',
                    borderRadius: 14,
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    fontSize: 14,
                    lineHeight: 1.5,
                    color: 'var(--auth-ink)'
                  }}>
                    <strong>Setup bloqueado em produção.</strong> Defina a variável <code>SETUP_ADMIN_TOKEN</code> (mínimo de 12 caracteres) no servidor e reinicie a API para liberar a criação do Super Administrador.
                  </div>
                ) : (
                  <form className="b2b-auth-form" onSubmit={handleSetupAdmin}>
                    {setupTokenRequired && (
                      <div className="b2b-auth-field">
                        <label className="b2b-auth-label" htmlFor="setup-token">Token de Instalação (SETUP_ADMIN_TOKEN)</label>
                        <AuthPasswordInput
                          id="setup-token"
                          placeholder="Cole o token configurado no servidor"
                          value={setupToken}
                          onChange={setSetupToken}
                          autoComplete="off"
                          required
                        />
                      </div>
                    )}
                    <div className="b2b-auth-field">
                      <label className="b2b-auth-label" htmlFor="setup-name">Nome do Administrador</label>
                      <input
                        id="setup-name"
                        className="b2b-auth-input"
                        placeholder="ex: Diretoria Rit ou seu nome"
                        value={adminName}
                        onChange={e => setAdminName(e.target.value)}
                      />
                    </div>
                    <div className="b2b-auth-field">
                      <label className="b2b-auth-label" htmlFor="setup-email">E-mail Principal</label>
                      <input
                        id="setup-email"
                        className="b2b-auth-input"
                        type="email"
                        placeholder="ex: admin@seudominio.com.br"
                        value={identifier}
                        onChange={e => setIdentifier(e.target.value)}
                        autoComplete="username"
                        required
                      />
                    </div>
                    <div className="b2b-auth-field">
                      <label className="b2b-auth-label" htmlFor="setup-pw">Senha Segura (mínimo 10 caracteres)</label>
                      <AuthPasswordInput
                        id="setup-pw"
                        placeholder="Defina uma senha forte (mín. 10 caracteres)"
                        value={password}
                        onChange={setPassword}
                        autoComplete="new-password"
                        required
                      />
                    </div>
                    <div style={{ marginTop: 4 }}>
                      <button
                        type="submit"
                        className="b2b-auth-pill"
                        disabled={loading || !identifier || password.length < 10 || (setupTokenRequired && !setupToken.trim())}
                      >
                        {loading ? 'Configurando…' : 'Finalizar e Acessar Plataforma'}
                      </button>
                    </div>
                  </form>
                )}
              </>
            ) : b2bMode === 'signup' ? (
              <>
                <h1 className="b2b-auth-title">Crie sua Conta</h1>
                <p className="b2b-auth-subtitle">
                  Comece com 14 dias grátis para gerenciar sua {signupType === 'personal' ? 'consultoria' : 'academia'} — sem cartão de crédito.
                </p>

                <form className="b2b-auth-form" onSubmit={handleSignup}>
                  <div className="b2b-auth-field">
                    <span className="b2b-auth-label">Tipo de Operação</span>
                    <div className="b2b-auth-seg" role="tablist" aria-label="Tipo de Operação">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={signupType === 'personal'}
                        className={`b2b-auth-seg-btn${signupType === 'personal' ? ' active' : ''}`}
                        onClick={() => handleSelectSignupType('personal')}
                      >
                        <Icon name="dumbbell" size={16} />
                        <span>Personal Trainer</span>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={signupType === 'gym'}
                        className={`b2b-auth-seg-btn${signupType === 'gym' ? ' active' : ''}`}
                        onClick={() => handleSelectSignupType('gym')}
                      >
                        <Icon name="building" size={16} />
                        <span>Academia / Studio</span>
                      </button>
                    </div>
                  </div>

                  <div className="b2b-auth-field">
                    <span className="b2b-auth-label">Escolha seu plano</span>
                    <div className="b2b-plan-grid" role="radiogroup" aria-label="Planos disponíveis">
                      {filteredPlans.map(p => {
                        const selected = signupPlanId === p.id;
                        const unlimited = Number(p.maxStudents) >= 100000;
                        const recommended = p.id === 'personal-pro' || p.id === 'pro';
                        return (
                          <button
                            key={p.id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className={`b2b-plan-card${selected ? ' selected' : ''}`}
                            onClick={() => setSignupPlanId(p.id)}
                          >
                            <div className="b2b-plan-head">
                              <span className="b2b-plan-name">{p.name}</span>
                              <span className="b2b-plan-radio" aria-hidden="true">
                                {selected && <Icon name="check" size={13} />}
                              </span>
                            </div>
                            <div className="b2b-plan-price">
                              <strong>R$ {p.priceMonthly}</strong>
                              <span>/mês</span>
                            </div>
                            <div className="b2b-plan-meta">
                              {unlimited ? 'Alunos ilimitados' : `Até ${p.maxStudents} alunos`}
                            </div>
                            {recommended && <div className="b2b-plan-tag">Recomendado</div>}
                          </button>
                        );
                      })}
                    </div>
                    <div className="b2b-auth-helper">14 dias grátis para testar · Cancele quando quiser.</div>
                  </div>

                  <div className="b2b-auth-field">
                    <label className="b2b-auth-label" htmlFor="signup-gym-name">
                      {signupType === 'personal' ? 'Nome da Consultoria ou Marca' : 'Nome da Academia ou Studio'}
                    </label>
                    <input
                      id="signup-gym-name"
                      className="b2b-auth-input"
                      placeholder={signupType === 'personal' ? 'ex: Team Ana Silva' : 'ex: Iron Power Academia'}
                      value={signupGymName}
                      onChange={e => setSignupGymName(e.target.value)}
                      required
                    />
                  </div>

                  <div className="b2b-auth-field">
                    <label className="b2b-auth-label" htmlFor="signup-owner">Seu Nome Completo</label>
                    <input
                      id="signup-owner"
                      className="b2b-auth-input"
                      placeholder="ex: João Carlos Souza"
                      value={signupOwnerName}
                      onChange={e => setSignupOwnerName(e.target.value)}
                      autoComplete="name"
                      required
                    />
                  </div>

                  <div className="b2b-auth-field">
                    <label className="b2b-auth-label" htmlFor="signup-email">Endereço de e-mail</label>
                    <input
                      id="signup-email"
                      className="b2b-auth-input"
                      type="email"
                      placeholder="contato@suaacademia.com.br"
                      value={signupEmail}
                      onChange={e => setSignupEmail(e.target.value)}
                      autoComplete="email"
                      required
                    />
                  </div>

                  <div className="b2b-auth-field">
                    <label className="b2b-auth-label" htmlFor="signup-phone">WhatsApp / Telefone (opcional)</label>
                    <input
                      id="signup-phone"
                      className="b2b-auth-input"
                      type="tel"
                      placeholder="(11) 99999-9999"
                      value={signupPhone}
                      onChange={e => setSignupPhone(e.target.value)}
                      autoComplete="tel"
                    />
                  </div>

                  <div className="b2b-auth-field">
                    <label className="b2b-auth-label" htmlFor="signup-password">Crie uma senha (mínimo 10 caracteres)</label>
                    <AuthPasswordInput
                      id="signup-password"
                      placeholder="Defina uma senha forte"
                      value={signupPassword}
                      onChange={setSignupPassword}
                      autoComplete="new-password"
                      required
                    />
                  </div>

                  <div className="b2b-auth-field" style={{ gap: 8 }}>
                    <label
                      htmlFor="signup-terms"
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                        cursor: 'pointer',
                        fontSize: 14,
                        lineHeight: 1.45,
                        color: 'var(--auth-muted)'
                      }}
                    >
                      <input
                        id="signup-terms"
                        type="checkbox"
                        checked={signupTermsAccepted}
                        onChange={e => setSignupTermsAccepted(e.target.checked)}
                        style={{ width: 20, height: 20, marginTop: 2, accentColor: 'var(--acc)', flexShrink: 0 }}
                        required
                      />
                      <span>
                        Li e concordo com os{' '}
                        <button
                          type="button"
                          className="b2b-auth-link"
                          onClick={() => setShowLegalSummary(v => !v)}
                        >
                          Termos de Uso e Política de Privacidade (LGPD)
                        </button>
                      </span>
                    </label>
                    {showLegalSummary && (
                      <div
                        style={{
                          padding: '12px 14px',
                          borderRadius: 12,
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid var(--sep)',
                          fontSize: 14,
                          lineHeight: 1.5,
                          color: 'var(--auth-muted)'
                        }}
                      >
                        <strong style={{ color: 'var(--auth-ink)', display: 'block', marginBottom: 4 }}>
                          Conformidade LGPD &amp; Operação de Saúde (Art. 11)
                        </strong>
                        A academia ou personal atua como Controlador dos dados físicos, medidas e treinos de seus alunos, enquanto a Rit atua como Operadora com isolamento multi-tenant, criptografia em repouso e exclusão definitiva sob solicitação do titular.
                      </div>
                    )}
                  </div>

                  <div style={{ marginTop: 4 }}>
                    <button
                      type="submit"
                      className="b2b-auth-pill"
                      disabled={loading}
                    >
                      {loading ? 'Criando sua conta…' : 'Começar 14 dias grátis'}
                    </button>
                  </div>
                </form>

                <div style={{ marginTop: 18, textAlign: 'center', fontSize: 14, color: 'var(--auth-muted)' }}>
                  Já possui conta na Rit?{' '}
                  <button
                    type="button"
                    className="b2b-auth-link"
                    onClick={() => switchB2bMode('login')}
                  >
                    Fazer login
                  </button>
                </div>
              </>
            ) : b2bMode === 'forgot' ? (
              <>
                <h1 className="b2b-auth-title">Recuperar senha</h1>
                <p className="b2b-auth-subtitle">
                  {forgotChallenge
                    ? 'Digite o código de 6 dígitos recebido e defina uma nova senha de acesso ao painel.'
                    : 'Informe o e-mail da sua academia ou personal para receber um código de verificação.'}
                </p>

                {!forgotChallenge ? (
                  <form className="b2b-auth-form" onSubmit={e => handleRequestResetOtp(e, 'auto')}>
                    <div className="b2b-auth-field">
                      <label className="b2b-auth-label" htmlFor="forgot-email">E-mail cadastrado</label>
                      <input
                        id="forgot-email"
                        className="b2b-auth-input"
                        type="email"
                        placeholder="contato@suaacademia.com.br"
                        value={forgotEmail}
                        onChange={e => setForgotEmail(e.target.value)}
                        autoComplete="email"
                        required
                      />
                    </div>
                    <div style={{ marginTop: 4 }}>
                      <button
                        type="submit"
                        className="b2b-auth-pill"
                        disabled={loading || !forgotEmail.trim()}
                      >
                        {loading ? 'Enviando código…' : 'Enviar código de verificação'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <form className="b2b-auth-form" onSubmit={handleConfirmResetPassword}>
                    <div
                      style={{
                        padding: '12px 14px',
                        borderRadius: 12,
                        background: 'rgba(208, 255, 0, 0.08)',
                        border: '1px solid rgba(208, 255, 0, 0.25)',
                        fontSize: 14,
                        lineHeight: 1.45,
                        color: 'var(--auth-ink)'
                      }}
                    >
                      Código enviado para{' '}
                      <strong>
                        {forgotChallenge.primaryChannel === 'whatsapp'
                          ? (forgotChallenge.maskedPhone || 'seu WhatsApp')
                          : (forgotChallenge.maskedEmail || forgotEmail)}
                      </strong>
                      . Válido por 10 minutos.
                    </div>

                    <div className="b2b-auth-field">
                      <label className="b2b-auth-label" htmlFor="forgot-otp">Código de 6 dígitos</label>
                      <input
                        id="forgot-otp"
                        className="b2b-auth-input"
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="000000"
                        value={forgotCode}
                        onChange={e => setForgotCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        autoComplete="one-time-code"
                        required
                      />
                    </div>

                    <div className="b2b-auth-field">
                      <label className="b2b-auth-label" htmlFor="forgot-new-pw">Nova senha (mínimo 10 caracteres)</label>
                      <AuthPasswordInput
                        id="forgot-new-pw"
                        placeholder="Defina uma nova senha forte"
                        value={forgotNewPassword}
                        onChange={setForgotNewPassword}
                        autoComplete="new-password"
                        required
                      />
                    </div>

                    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <button
                        type="submit"
                        className="b2b-auth-pill"
                        disabled={loading || forgotCode.length !== 6 || forgotNewPassword.length < 10}
                      >
                        {loading ? 'Redefinindo…' : 'Redefinir senha e entrar'}
                      </button>

                      {forgotChallenge.hasPhone && (
                        <Button
                          type="button"
                          variant="tinted"
                          block
                          disabled={forgotChannelBusy || loading}
                          onClick={e => handleRequestResetOtp(e, 'whatsapp')}
                        >
                          {forgotChannelBusy ? 'Enviando no WhatsApp…' : 'Receber código pelo WhatsApp'}
                        </Button>
                      )}

                      <button
                        type="button"
                        className="b2b-auth-link"
                        style={{ alignSelf: 'center', minHeight: 40, fontSize: 14 }}
                        onClick={() => {
                          setForgotChallenge(null);
                          setForgotCode('');
                        }}
                      >
                        Usar outro e-mail ou reenviar
                      </button>
                    </div>
                  </form>
                )}

                <div style={{ marginTop: 18, textAlign: 'center', fontSize: 14, color: 'var(--auth-muted)' }}>
                  Lembrou a senha?{' '}
                  <button
                    type="button"
                    className="b2b-auth-link"
                    onClick={() => switchB2bMode('login')}
                  >
                    Voltar para o login
                  </button>
                </div>
              </>
            ) : (
              <>
                <h1 className="b2b-auth-title">Entrar no Painel</h1>
                <p className="b2b-auth-subtitle">
                  Acesse a gestão de alunos, fichas e planos com seu e-mail e senha cadastrados.
                </p>

                <form className="b2b-auth-form" onSubmit={handleLogin}>
                  <div className="b2b-auth-field">
                    <label className="b2b-auth-label" htmlFor="login-id">E-mail ou Usuário</label>
                    <input
                      id="login-id"
                      className="b2b-auth-input"
                      placeholder="contato@suaacademia.com.br"
                      value={identifier}
                      onChange={e => setIdentifier(e.target.value)}
                      autoComplete="username"
                    />
                  </div>
                  <div className="b2b-auth-field">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <label className="b2b-auth-label" htmlFor="login-pw">Senha</label>
                      <button
                        type="button"
                        className="b2b-auth-link"
                        style={{ fontSize: 14, minHeight: 36, display: 'inline-flex', alignItems: 'center' }}
                        onClick={() => switchB2bMode('forgot')}
                      >
                        Esqueci minha senha
                      </button>
                    </div>
                    <AuthPasswordInput
                      id="login-pw"
                      placeholder="Digite sua senha"
                      value={password}
                      onChange={setPassword}
                      autoComplete="current-password"
                    />
                  </div>
                  <div style={{ marginTop: 4 }}>
                    <button
                      type="submit"
                      className="b2b-auth-pill"
                      disabled={loading}
                    >
                      {loading ? 'Autenticando…' : 'Acessar Painel'}
                    </button>
                  </div>
                </form>

                <div style={{ marginTop: 20, textAlign: 'center', fontSize: 14, display: 'flex', flexDirection: 'column', gap: 10, color: 'var(--auth-muted)' }}>
                  <div>
                    Ainda não possui conta?{' '}
                    <button
                      type="button"
                      className="b2b-auth-link"
                      onClick={() => switchB2bMode('signup')}
                    >
                      Criar conta grátis (14 dias)
                    </button>
                  </div>
                  <div>
                    <a
                      href="https://wa.me/5591985561302?text=Ol%C3%A1%2C%20quero%20tirar%20d%C3%BAvidas%20sobre%20a%20plataforma%20Rit!"
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--auth-muted)', fontSize: 14, fontWeight: 500, textDecoration: 'underline', textUnderlineOffset: 3 }}
                    >
                      Falar com especialista no WhatsApp
                    </a>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="b2b-auth-footer">
            <span>Rit · Personal Trainers & Academias</span>
            {isNativePortalApp() ? (
              <button
                type="button"
                onClick={() => openStudentNativeApp(gyms[0]?.id || '')}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--acc-ink)', fontWeight: 600, fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 5 }}
              >
                Sou aluno <Icon name="chevronRight" size={14} />
              </button>
            ) : (
              <a
                href={getStudentAppUrl(gyms[0]?.id || '')}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--acc-ink)', textDecoration: 'none', fontWeight: 600, fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 5 }}
              >
                Sou aluno <Icon name="externalLink" size={14} />
              </a>
            )}
          </div>
        </div>

        {/* Coluna 2: Seletor de Unidades Demo (apenas quando SAAS_DEMO=1; nunca exibe Super Admin) */}
        {demoAllowed && (
          <div className="b2b-auth-card" style={{ gap: 16 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <StatusPill tone="ok" icon="bolt">Ambiente de Demonstração</StatusPill>
                {!gyms.length && (
                  <Button variant="tinted" size="sm" icon="sparkles" onClick={handleSeedDemo} disabled={seeding}>
                    {seeding ? 'Gerando...' : 'Gerar Unidades Demo'}
                  </Button>
                )}
              </div>
              <h2 style={{ margin: '12px 0 4px', fontSize: 19 }}>Unidades de Demonstração</h2>
              <p className="muted small" style={{ margin: 0, lineHeight: 1.45 }}>
                Teste rapidamente o painel operacional de uma academia exemplo.
              </p>
            </div>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="muted small" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Academias Exemplo ({gyms.length})
              </div>

              {gyms.length === 0 ? (
                <div className="muted small" style={{ padding: 18, textAlign: 'center', background: 'var(--bg-el)', borderRadius: 'var(--r)' }}>
                  Clique em <b>Gerar Unidades Demo</b> para criar academias de exemplo.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 280, overflowY: 'auto', paddingRight: 4 }}>
                  {gyms.map(g => (
                    <div
                      key={g.id}
                      style={{
                        padding: '11px 14px',
                        borderRadius: 'var(--r)',
                        background: 'var(--bg-el)',
                        border: 'var(--hair) solid var(--sep)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: 10
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 200px' }}>
                        <span
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: '50%',
                            background: g.primaryColor || 'var(--acc)',
                            flexShrink: 0
                          }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span>{g.name}</span>
                            <StatusPill tone={g.status}>
                              {g.status === 'active' ? 'Ativa' : g.status === 'trial' ? 'Trial' : g.status === 'past_due' ? 'Atrasada' : 'Suspensa'}
                            </StatusPill>
                          </div>
                          <div className="muted small" style={{ overflowWrap: 'anywhere' }}>
                            Plano {g.planName} · {g.studentCount} alunos · <code>{g.id}</code>
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, marginLeft: 'auto' }}>
                        {isNativePortalApp() ? (
                          <button
                            type="button"
                            onClick={() => openStudentNativeApp(g.id)}
                            className="b2b-icon-btn"
                            style={{ borderRadius: 9, width: 34, height: 34 }}
                            title="Abrir App Mobile do Aluno desta academia"
                          >
                            <Icon name="phoneScreen" size={16} />
                          </button>
                        ) : (
                          <a
                            href={getStudentAppUrl(g.id)}
                            target="_blank"
                            rel="noreferrer"
                            className="b2b-icon-btn"
                            style={{ borderRadius: 9, width: 34, height: 34 }}
                            title="Abrir App Mobile do Aluno desta academia"
                          >
                            <Icon name="phoneScreen" size={16} />
                          </a>
                        )}
                        <Button
                          variant="tinted"
                          size="sm"
                          disabled={loading || g.status === 'suspended'}
                          onClick={() => handleQuickDemo('gym', g.id)}
                        >
                          Painel
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
