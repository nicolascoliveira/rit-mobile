import React, { useState } from 'react';
import Icon from '../components/Icon.jsx';
import { Button, TextField, StatusPill } from '../components/ui.jsx';
import { portalApi, toast, getStudentAppUrl } from '../lib/api.js';

export default function AuthView({ bootstrap, onAuthenticated, theme, onToggleTheme, onRefreshBootstrap, onBackToLanding }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [adminName, setAdminName] = useState('Administrador Geral');
  const [setupToken, setSetupToken] = useState('');
  const [loginRole, setLoginRole] = useState('b2b');
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);

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
          window.location.href = getStudentAppUrl(err.data?.tenantId || '');
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

  return (
    <div className="b2b-auth-screen">
      <div className={'b2b-auth-wrap' + (demoAllowed ? '' : ' single')}>
        {/* Coluna 1: Login Oficial por Credenciais */}
        <div className="card" style={{ margin: 0, padding: 28, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
          <div>
            {onBackToLanding && (
              <div style={{ marginBottom: 16 }}>
                <button
                  type="button"
                  onClick={onBackToLanding}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--label-2)',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer'
                  }}
                >
                  ← Voltar para a página inicial
                </button>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <img
                  src={theme === 'light' ? '/rit-logo-light.png' : '/rit-logo.png'}
                  alt="Rit"
                  style={{ height: 34, width: 'auto', display: 'block' }}
                />
                <div style={{ borderLeft: '1px solid var(--sep)', paddingLeft: 12 }}>
                  <div style={{ fontWeight: 800, fontSize: 14.5, lineHeight: 1.2 }}>
                    {bootstrap?.platform?.name || 'Rit Cloud'}
                  </div>
                  <div className="muted small" style={{ fontSize: 12 }}>Academias & Personal Trainers</div>
                </div>
              </div>

              <button
                type="button"
                className="b2b-icon-btn"
                onClick={onToggleTheme}
                title={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
              >
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
              </button>
            </div>

            {isInitialSetup ? (
              <>
                <div style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'rgba(59, 130, 246, 0.1)',
                  border: '1px solid rgba(59, 130, 246, 0.3)',
                  color: 'var(--blue)',
                  fontSize: 12,
                  fontWeight: 600,
                  marginBottom: 16
                }}>
                  🚀 Configuração Inicial de Produção
                </div>
                <h1 style={{ margin: '0 0 6px', fontSize: 24, letterSpacing: '-0.02em' }}>Criar Super Administrador</h1>
                <p className="muted small" style={{ margin: '0 0 22px', lineHeight: 1.45 }}>
                  Configure o acesso mestre da plataforma Rit. Esta conta terá controle total sobre o faturamento, planos e academias.
                </p>

                {setupDisabled ? (
                  <div style={{
                    padding: '14px 16px',
                    borderRadius: 'var(--r)',
                    background: 'rgba(239, 68, 68, 0.1)',
                    border: '1px solid rgba(239, 68, 68, 0.35)',
                    fontSize: 14,
                    lineHeight: 1.5,
                    color: 'var(--label)'
                  }}>
                    <strong>Setup bloqueado em produção.</strong> Defina a variável <code>SETUP_ADMIN_TOKEN</code> (mínimo de 12 caracteres) no servidor e reinicie a API para liberar a criação do Super Administrador.
                  </div>
                ) : (
                  <form onSubmit={handleSetupAdmin} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {setupTokenRequired && (
                      <TextField
                        label="Token de Instalação (SETUP_ADMIN_TOKEN)"
                        type="password"
                        placeholder="Cole o token configurado no servidor"
                        value={setupToken}
                        onChange={setSetupToken}
                        autoComplete="off"
                        required
                      />
                    )}
                    <TextField
                      label="Nome do Administrador"
                      placeholder="ex: Diretoria Rit ou seu nome"
                      value={adminName}
                      onChange={setAdminName}
                    />
                    <TextField
                      label="E-mail Principal"
                      type="email"
                      placeholder="ex: admin@seudominio.com.br"
                      value={identifier}
                      onChange={setIdentifier}
                      autoComplete="username"
                      required
                    />
                    <TextField
                      label="Senha Segura (mínimo 10 caracteres)"
                      type="password"
                      placeholder="Defina uma senha forte (mín. 10 caracteres)"
                      value={password}
                      onChange={setPassword}
                      autoComplete="new-password"
                      required
                    />
                    <div style={{ marginTop: 6 }}>
                      <Button
                        type="submit"
                        variant="primary"
                        icon="shield"
                        block
                        disabled={loading || !identifier || password.length < 10 || (setupTokenRequired && !setupToken.trim())}
                      >
                        {loading ? 'Configurando...' : 'Finalizar e Acessar Plataforma'}
                      </Button>
                    </div>
                  </form>
                )}
              </>
            ) : (
              <>
                <div
                  role="tablist"
                  aria-label="Tipo de acesso"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: 6,
                    padding: 4,
                    borderRadius: 12,
                    background: 'var(--bg-el)',
                    border: 'var(--hair) solid var(--sep)',
                    marginBottom: 20
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={loginRole === 'b2b'}
                    onClick={() => setLoginRole('b2b')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 7,
                      padding: '9px 10px',
                      borderRadius: 9,
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: 700,
                      background: loginRole === 'b2b' ? 'var(--acc)' : 'transparent',
                      color: loginRole === 'b2b' ? 'var(--on-acc)' : 'var(--label-2)',
                      transition: 'all 0.18s ease'
                    }}
                  >
                    <Icon name="dumbbell" size={15} />
                    <span>Academia & Personal</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={loginRole === 'student'}
                    onClick={() => setLoginRole('student')}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 7,
                      padding: '9px 10px',
                      borderRadius: 9,
                      border: 'none',
                      cursor: 'pointer',
                      fontSize: 13,
                      fontWeight: 700,
                      background: loginRole === 'student' ? 'var(--acc)' : 'transparent',
                      color: loginRole === 'student' ? 'var(--on-acc)' : 'var(--label-2)',
                      transition: 'all 0.18s ease'
                    }}
                  >
                    <Icon name="phoneScreen" size={15} />
                    <span>Sou Aluno</span>
                  </button>
                </div>

                {loginRole === 'student' ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    <div>
                      <h1 style={{ margin: '0 0 6px', fontSize: 23, letterSpacing: '-0.02em' }}>Acessar Meu Treino</h1>
                      <p className="muted small" style={{ margin: 0, lineHeight: 1.5 }}>
                        O acesso às suas fichas (Treino A, B, C), animações de execução e histórico de cargas é feito direto no <b>Aplicativo do Aluno</b>.
                      </p>
                    </div>

                    <div
                      style={{
                        padding: '14px 16px',
                        borderRadius: 'var(--r)',
                        background: 'var(--bg-el)',
                        border: 'var(--hair) solid var(--sep)',
                        fontSize: 13,
                        lineHeight: 1.5,
                        color: 'var(--label-2)'
                      }}
                    >
                      Use o <b>nome ou e-mail</b> e a <b>senha</b> enviados pela sua academia ou pelo seu personal trainer.
                    </div>

                    <a
                      href={getStudentAppUrl(gyms[0]?.id || '')}
                      className="btn primary block"
                      style={{
                        textDecoration: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 8,
                        padding: '12px 18px',
                        fontWeight: 700
                      }}
                    >
                      <Icon name="phoneScreen" size={17} />
                      <span>Abrir Aplicativo do Aluno</span>
                      <Icon name="externalLink" size={14} />
                    </a>
                  </div>
                ) : (
                  <>
                    <h1 style={{ margin: '0 0 6px', fontSize: 24, letterSpacing: '-0.02em' }}>Entrar no Painel</h1>
                    <p className="muted small" style={{ margin: '0 0 22px', lineHeight: 1.45 }}>
                      Acesse o painel de gestão com seu <b>e-mail</b> e <b>senha</b> cadastrados.
                    </p>

                    <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      <TextField
                        label="E-mail ou Usuário"
                        placeholder="ex: contato@suaacademia.com.br"
                        value={identifier}
                        onChange={setIdentifier}
                        autoComplete="username"
                      />
                      <TextField
                        label="Senha"
                        type="password"
                        placeholder="Digite sua senha"
                        value={password}
                        onChange={setPassword}
                        autoComplete="current-password"
                      />
                      <div style={{ marginTop: 6 }}>
                        <Button
                          type="submit"
                          variant="primary"
                          icon="key"
                          block
                          disabled={loading}
                        >
                          {loading ? 'Autenticando...' : 'Acessar Painel'}
                        </Button>
                      </div>
                    </form>

                    <div className="muted small" style={{ marginTop: 16, textAlign: 'center', fontSize: 12.5 }}>
                      Ainda não possui conta na Rit?{' '}
                      <a
                        href="https://wa.me/5591985561302?text=Ol%C3%A1%2C%20quero%20criar%20minha%20conta%20na%20plataforma%20Rit!"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--acc-ink)', fontWeight: 700, textDecoration: 'none' }}
                      >
                        Falar com especialista →
                      </a>
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          <div className="muted small" style={{ marginTop: 24, paddingTop: 14, borderTop: 'var(--hair) solid var(--sep)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>Rit · Desenvolvido por <b style={{ color: 'var(--label)' }}>Nicolas Oliveira</b></span>
            <a
              href={getStudentAppUrl(gyms[0]?.id || '')}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--acc-ink)', textDecoration: 'none', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              App do Aluno <Icon name="externalLink" size={13} />
            </a>
          </div>
        </div>

        {/* Coluna 2: Seletor de Unidades Demo (apenas quando SAAS_DEMO=1; nunca exibe Super Admin) */}
        {demoAllowed && (
          <div className="card" style={{ margin: 0, padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
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
