import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import Icon from './components/Icon.jsx';
import { Button, StatusPill, ToastHost } from './components/ui.jsx';
import PortalTour from './components/PortalTour.jsx';
import LandingView from './views/LandingView.jsx';
import {
  shouldOfferPortalTour,
  clearPortalTourProgress
} from './lib/portal-tour.js';
import {
  portalApi,
  getStoredToken,
  setStoredToken,
  getTenantOverride,
  setTenantOverride,
  getStoredTheme,
  setStoredTheme,
  applyPortalAccent,
  getStudentAppUrl,
  toast
} from './lib/api.js';

const AuthView = lazy(() => import('./views/AuthView.jsx'));
const SuperAdminPanel = lazy(() => import('./views/SuperAdminPanel.jsx'));
const GymPanel = lazy(() => import('./views/GymPanel.jsx'));

const SUPER_NAV = [
  { id: 'overview', label: 'Visão Executiva', icon: 'chartLine' },
  { id: 'tenants', label: 'Academias & Personais', icon: 'building', badgeKey: 'totalGyms' },
  { id: 'billing', label: 'Planos & Faturamento', icon: 'creditCard', badgeKey: 'pastDueGyms', dangerBadge: true },
  { id: 'settings', label: 'Plataforma & Auditoria', icon: 'shield' }
];

const GYM_NAV = [
  { id: 'dashboard', label: 'Visão & Anti-Evasão', icon: 'activity', badgeKey: 'atRiskCount', dangerBadge: true },
  { id: 'students', label: 'Alunos & Matrículas', icon: 'users', badgeKey: 'totalStudents' },
  { id: 'templates', label: 'Modelos de Fichas', icon: 'dumbbell' },
  { id: 'team', label: 'Equipe & Professores', icon: 'personCircle' },
  { id: 'onboarding', label: 'QR Code & Convites', icon: 'qr' },
  { id: 'billing', label: 'Minha Assinatura', icon: 'creditCard' },
  { id: 'settings', label: 'Configurações', icon: 'gear' }
];

function parsePortalRoute() {
  if (typeof window === 'undefined') {
    return { isLoginRoute: false, authMode: 'login', signupAccountType: 'gym', tab: '' };
  }
  const isPortalSubdomain = /^(painel|portal|admin|gestao)\./i.test(window.location.hostname || '');
  const rawPath = window.location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  const rawHash = window.location.hash.replace(/^#\/?/, '').toLowerCase();
  const sp = new URLSearchParams(window.location.search || '');
  const searchMode = (sp.get('mode') || '').toLowerCase();
  const searchType = (sp.get('tipo') || sp.get('type') || '').toLowerCase();

  // Suporta /painel/<aba>, /<aba> ou legado #<aba>
  let route = rawPath || rawHash;
  if (route.startsWith('painel/')) {
    route = route.slice('painel/'.length);
  }
  if (route === 'branding' || route === 'configuracoes' || route === 'configuracao') {
    route = 'settings';
  }

  const isKnownTab = SUPER_NAV.some(i => i.id === route) || GYM_NAV.some(i => i.id === route);
  const isSignupRoute =
    rawPath === 'cadastro' ||
    rawPath === 'criar-conta' ||
    rawPath === 'signup' ||
    rawHash === 'cadastro' ||
    rawHash === 'criar-conta' ||
    rawHash === 'signup' ||
    searchMode === 'signup' ||
    searchMode === 'cadastro';

  const isLoginRoute =
    isSignupRoute ||
    rawPath === 'login' ||
    rawPath === 'entrar' ||
    rawPath === 'painel' ||
    rawPath === 'setup-superadmin' ||
    rawPath.startsWith('painel/') ||
    rawHash === 'login' ||
    rawHash === 'entrar' ||
    rawHash === 'setup-superadmin' ||
    isKnownTab ||
    (isPortalSubdomain && rawPath !== 'site' && rawHash !== 'site');

  return {
    isLoginRoute,
    authMode: isSignupRoute ? 'signup' : 'login',
    signupAccountType: searchType === 'personal' ? 'personal' : 'gym',
    tab: isKnownTab ? route : ''
  };
}

export default function App() {
  const [theme, setTheme] = useState(() => setStoredTheme(getStoredTheme()));
  const [showLogin, setShowLogin] = useState(() => parsePortalRoute().isLoginRoute);
  const [authMode, setAuthMode] = useState(() => parsePortalRoute().authMode);
  const [signupAccountType, setSignupAccountType] = useState(() => parsePortalRoute().signupAccountType);
  const [tourSession, setTourSession] = useState(null);
  const [booting, setBooting] = useState(() => Boolean(parsePortalRoute().isLoginRoute || getStoredToken()));
  const [bootstrap, setBootstrap] = useState(null);
  const [user, setUser] = useState(null);
  const [activeTenant, setActiveTenant] = useState(null);
  const isPortalSubdomain = typeof window !== 'undefined' && /^(painel|portal|admin|gestao)\./i.test(window.location.hostname || '');

  const [superTab, setSuperTab] = useState(() => {
    const { tab } = parsePortalRoute();
    return SUPER_NAV.some(i => i.id === tab) ? tab : 'overview';
  });
  const [gymTab, setGymTab] = useState(() => {
    const { tab } = parsePortalRoute();
    return GYM_NAV.some(i => i.id === tab) ? tab : 'dashboard';
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  const [superMetrics, setSuperMetrics] = useState({});
  const [gymKpis, setGymKpis] = useState({});

  const selectSuperTab = useCallback(tab => {
    setSuperTab(tab);
    if (typeof window !== 'undefined') {
      const nextPath = tab === 'overview' ? '/painel' : `/painel/${tab}`;
      if (window.location.pathname !== nextPath || window.location.hash) {
        window.history.replaceState(null, '', nextPath);
      }
    }
  }, []);

  const selectGymTab = useCallback(tab => {
    setGymTab(tab);
    if (typeof window !== 'undefined') {
      const nextPath = tab === 'dashboard' ? '/painel' : `/painel/${tab}`;
      if (window.location.pathname !== nextPath || window.location.hash) {
        window.history.replaceState(null, '', nextPath);
      }
    }
  }, []);

  useEffect(() => {
    const syncFromUrl = () => {
      const { isLoginRoute, authMode: nextMode, signupAccountType: nextType, tab } = parsePortalRoute();
      setShowLogin(isLoginRoute);
      setAuthMode(nextMode);
      setSignupAccountType(nextType);
      if (SUPER_NAV.some(i => i.id === tab)) setSuperTab(tab);
      if (GYM_NAV.some(i => i.id === tab)) setGymTab(tab);
    };
    window.addEventListener('popstate', syncFromUrl);
    window.addEventListener('hashchange', syncFromUrl);
    return () => {
      window.removeEventListener('popstate', syncFromUrl);
      window.removeEventListener('hashchange', syncFromUrl);
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const isLandingVisible = !booting && !user && !showLogin && !isPortalSubdomain;
    document.title = isLandingVisible
      ? 'Rit — Gestão de Treinos e Alunos para Academias e Personal Trainers'
      : 'Rit — Central de Gestão (Academias & Personal Trainers)';
    const robotsMeta = document.querySelector('meta[name="robots"]');
    if (robotsMeta) {
      robotsMeta.setAttribute(
        'content',
        isLandingVisible
          ? 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
          : 'noindex, nofollow'
      );
    }
  }, [booting, user, showLogin, isPortalSubdomain]);

  const refreshBootstrap = useCallback(async () => {
    try {
      const res = await portalApi('/api/saas/bootstrap', { tenantId: '' });
      setBootstrap(res);
      return res;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshBootstrap();
      const token = getStoredToken();
      if (token) {
        try {
          const me = await portalApi('/api/saas/auth/me');
          if (!cancelled && me?.user) {
            setUser(me.user);
            if (me.user.saasRole === 'superadmin') {
              const savedOverride = getTenantOverride();
              if (savedOverride && me.tenant) {
                setActiveTenant(me.tenant);
              } else {
                setTenantOverride('');
                setActiveTenant(null);
              }
            } else {
              setActiveTenant(me.tenant || null);
              if (me.billingOnly || me.tenant?.accessBlocked) {
                setGymTab('billing');
              }
            }
          }
        } catch {
          setStoredToken('');
          setTenantOverride('');
        }
      }
      if (!cancelled) setBooting(false);
    })();
    return () => { cancelled = true; };
  }, [refreshBootstrap]);

  const isSuperUser = user?.saasRole === 'superadmin';
  const isGymMode = Boolean(user && (!isSuperUser || activeTenant));

  // Sincroniza cor de destaque (Lime padrão no Super Admin, cor White-Label da academia no Painel da Academia)
  useEffect(() => {
    if (isGymMode && activeTenant?.branding?.primaryColor) {
      applyPortalAccent(activeTenant.branding.primaryColor, theme);
    } else {
      applyPortalAccent(null, theme);
    }
  }, [isGymMode, activeTenant?.branding?.primaryColor, theme]);

  useEffect(() => {
    const tenantLocked = Boolean(
      activeTenant?.accessBlocked ||
      activeTenant?.status === 'past_due' ||
      (activeTenant?.status === 'trial' &&
        activeTenant?.trialEndsAt &&
        Date.parse(activeTenant.trialEndsAt) <= Date.now())
    );
    if (!isGymMode || isSuperUser || tenantLocked) return undefined;
    if (autoTourCheckedRef.current) return undefined;
    autoTourCheckedRef.current = true;

    const isNew = pendingNewSignupRef.current;
    pendingNewSignupRef.current = false;
    const timer = setTimeout(() => {
      if (isNew) {
        setTourSession({ kind: 'offer', isNewSignup: true });
        return;
      }
      const { offer, resumeStep } = shouldOfferPortalTour();
      if (offer === 'fresh') setTourSession({ kind: 'offer' });
      else if (offer === 'resume') setTourSession({ kind: 'resume', resumeStep });
    }, isNew ? 420 : 850);

    return () => clearTimeout(timer);
  }, [
    isGymMode,
    isSuperUser,
    activeTenant?.accessBlocked,
    activeTenant?.status,
    activeTenant?.trialEndsAt
  ]);

  const handleToggleTheme = () => {
    const next = setStoredTheme(theme === 'dark' ? 'light' : 'dark');
    setTheme(next);
  };

  const autoTourCheckedRef = useRef(false);
  const pendingNewSignupRef = useRef(false);

  const openAuthPortal = useCallback((mode = 'login', accountType = 'gym') => {
    const nextMode = mode === 'signup' ? 'signup' : 'login';
    const nextType = accountType === 'personal' ? 'personal' : 'gym';
    setAuthMode(nextMode);
    setSignupAccountType(nextType);
    if (typeof window !== 'undefined') {
      const targetUrl = nextMode === 'signup'
        ? (nextType === 'personal' ? '/cadastro?tipo=personal' : '/cadastro')
        : '/login';
      window.history.pushState(null, '', targetUrl);
    }
    setShowLogin(true);
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  const handleAuthenticated = res => {
    if (!res?.token || !res?.user) return;
    setStoredToken(res.token);
    setUser(res.user);
    if (res.user.saasRole === 'superadmin') {
      setTenantOverride('');
      setActiveTenant(null);
      selectSuperTab('overview');
      toast(`Bem-vindo ao Painel do Dono do Sistema, ${res.user.name}!`);
    } else {
      setTenantOverride(res.user.tenantId || '');
      setActiveTenant(res.tenant || null);
      if (res.isNewSignup) {
        clearPortalTourProgress();
        pendingNewSignupRef.current = true;
      }
      autoTourCheckedRef.current = false;
      if (res.billingOnly || res.tenant?.accessBlocked) {
        selectGymTab('billing');
        toast('Regularize sua assinatura via PIX para liberar todos os módulos da academia.');
      } else {
        selectGymTab('dashboard');
        toast(res.isNewSignup
          ? `Conta criada! Bem-vindo ao painel da ${res.tenant?.name || 'sua unidade'}!`
          : `Bem-vindo ao painel da ${res.tenant?.name || 'academia'}!`);
      }
    }
  };

  const handleLogout = async () => {
    try {
      await portalApi('/api/logout', { method: 'POST', body: {} });
    } catch { /* ignore */ }
    setStoredToken('');
    setTenantOverride('');
    setUser(null);
    setActiveTenant(null);
    setTourSession(null);
    autoTourCheckedRef.current = false;
    pendingNewSignupRef.current = false;
    setAuthMode('login');
    applyPortalAccent(null, theme);
    if (typeof window !== 'undefined') {
      window.history.pushState(null, '', '/login');
    }
    setShowLogin(true);
    await refreshBootstrap();
  };

  const handleStartImpersonation = useCallback(tenant => {
    if (!tenant?.id) return;
    setTenantOverride(tenant.id);
    setActiveTenant(tenant);
    setGymKpis({});
    selectGymTab('dashboard');
    setMobileOpen(false);
    toast(`Inspecionando painel da unidade: ${tenant.name}`);
  }, [selectGymTab]);

  const handleStopImpersonation = useCallback(() => {
    setTenantOverride('');
    setActiveTenant(null);
    setGymKpis({});
    selectSuperTab('overview');
    setMobileOpen(false);
    applyPortalAccent(null, theme);
  }, [theme, selectSuperTab]);

  const handleTenantUpdated = useCallback(updatedTenant => {
    setActiveTenant(prev => {
      // Se não há tenant ativo (ex: Super Admin clicou em Voltar ao Painel SaaS), ignora resposta tardia
      if (!prev) return null;
      if (updatedTenant?.id && prev.id && updatedTenant.id !== prev.id) return prev;
      return updatedTenant;
    });
  }, []);

  const handleSuperDataChanged = useCallback(ov => {
    setSuperMetrics(ov?.metrics || {});
    if (ov?.platform) {
      setBootstrap(prev => (prev ? { ...prev, platform: ov.platform } : prev));
    }
  }, []);

  if (booting) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="muted" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img
            src={theme === 'light' ? '/rit-logo-light.png' : '/rit-logo.png'}
            alt="Rit"
            style={{ height: 28, width: 'auto' }}
          />
          <span>Inicializando plataforma Rit...</span>
        </div>
        <ToastHost />
      </div>
    );
  }

  if (!user) {
    if (!showLogin) {
      return (
        <>
          <LandingView
            onOpenLogin={() => openAuthPortal('login', 'gym')}
            onOpenSignup={({ accountType = 'gym' } = {}) => openAuthPortal('signup', accountType)}
          />
          <ToastHost />
        </>
      );
    }
    return (
      <Suspense fallback={<div style={{ minHeight: '100vh', background: '#080808' }} />}>
        <AuthView
          bootstrap={bootstrap}
          onAuthenticated={handleAuthenticated}
          theme={theme}
          onToggleTheme={handleToggleTheme}
          onRefreshBootstrap={refreshBootstrap}
          initialMode={authMode}
          initialAccountType={signupAccountType}
          onBackToLanding={() => {
            if (isPortalSubdomain && typeof window !== 'undefined') {
              const rootHost = window.location.hostname.replace(/^(painel|portal|admin|gestao)\./i, '');
              window.location.href = `${window.location.protocol}//${rootHost}`;
              return;
            }
            window.history.pushState(null, '', '/');
            setShowLogin(false);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
        <ToastHost />
      </Suspense>
    );
  }

  const isPersonalTenant = isGymMode && (activeTenant?.accountType === 'personal' || String(activeTenant?.planId || '').startsWith('personal'));
  const isTenantBillingLocked = Boolean(
    isGymMode &&
    !isSuperUser &&
    (activeTenant?.accessBlocked ||
      activeTenant?.status === 'past_due' ||
      (activeTenant?.status === 'trial' &&
        activeTenant?.trialEndsAt &&
        Date.parse(activeTenant.trialEndsAt) <= Date.now()))
  );
  const navItems = isGymMode
    ? GYM_NAV.map(item =>
        isPersonalTenant && item.id === 'team'
          ? { ...item, label: 'Perfil & Equipe' }
          : isPersonalTenant && item.id === 'students'
            ? { ...item, label: 'Alunos & Consultoria' }
            : item
      )
    : SUPER_NAV;
  const currentTab = isGymMode ? gymTab : superTab;
  const badgeSource = isGymMode ? gymKpis : superMetrics;

  const sidebarTitle = isGymMode
    ? (activeTenant?.branding?.gymName || activeTenant?.name || (isPersonalTenant ? 'Painel do Personal' : 'Painel da Academia'))
    : (bootstrap?.platform?.name || 'Rit Cloud');

  const sidebarSub = isGymMode
    ? `${isPersonalTenant ? 'Personal Trainer' : 'Painel da Academia'} · Plano ${activeTenant?.planName || (isPersonalTenant ? 'Personal' : 'Pro')}`
    : 'Painel Dono do Sistema (Rit)';

  const roleLabel = isSuperUser
    ? 'Dono do Sistema · Rit'
    : isPersonalTenant
      ? 'Personal Trainer Titular'
      : user.saasRole === 'gym_owner'
        ? 'Proprietário da Academia'
        : user.saasRole === 'gym_manager'
          ? 'Coordenador'
          : 'Professor';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Barra de Inspeção (visível EXCLUSIVAMENTE para o Super Admin quando inspeciona uma academia) */}
      {isSuperUser && activeTenant && (
        <div className="b2b-impersonate-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Icon name="eye" size={17} />
            <span>
              Modo Inspeção (visível só para você): visualizando <b>{activeTenant.name}</b> (<code>{activeTenant.id}</code>)
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <a
              href={getStudentAppUrl(activeTenant.id)}
              target="_blank"
              rel="noreferrer"
              className="btn ghost sm"
              style={{ color: '#fff', borderColor: 'rgba(255,255,255,0.35)' }}
            >
              <Icon name="phoneScreen" size={14} />
              <span>App Aluno</span>
            </a>
            <Button
              variant="plain"
              size="sm"
              icon="arrowLeft"
              onClick={handleStopImpersonation}
              style={{ background: '#ffffff', color: '#000000', fontWeight: 700 }}
            >
              Voltar à Central Rit
            </Button>
          </div>
        </div>
      )}

      <div className="portal-layout" style={{ flex: 1 }}>
        {/* Backdrop Mobile */}
        {mobileOpen && (
          <div
            onClick={() => setMobileOpen(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 110 }}
          />
        )}

        {/* Sidebar Lateral Nativa */}
        <aside className={'portal-sidebar' + (mobileOpen ? ' open' : '')}>
          <div className="portal-sidebar-logo">
            {!isGymMode ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <img
                  src={theme === 'light' ? '/rit-logo-light.png' : '/rit-logo.png'}
                  alt="Rit"
                  style={{ height: 30, width: 'auto', objectFit: 'contain', alignSelf: 'flex-start' }}
                />
                <div className="portal-logo-sub">{sidebarSub}</div>
              </div>
            ) : (
              <>
                <div className="portal-logo-icon" style={{ overflow: 'hidden' }}>
                  {activeTenant?.branding?.logoUrl && !activeTenant.branding.logoUrl.startsWith('blob:') ? (
                    <img
                      src={activeTenant.branding.logoUrl}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <Icon name="dumbbell" size={20} />
                  )}
                </div>
                <div className="portal-logo-meta">
                  <div className="portal-logo-title">{sidebarTitle}</div>
                  <div className="portal-logo-sub">{sidebarSub}</div>
                </div>
              </>
            )}
          </div>

          <div className="portal-nav-group-lbl">
            {isGymMode ? (isPersonalTenant ? 'Gestão da Consultoria' : 'Gestão da Academia') : 'Administração Rit'}
          </div>

          <nav className="portal-nav">
            {navItems.map(item => {
              const rawBadge = item.badgeKey ? badgeSource?.[item.badgeKey] : null;
              const showBadge = rawBadge !== null && rawBadge !== undefined && Number(rawBadge) > 0;
              return (
                <button
                  type="button"
                  key={item.id}
                  className={'portal-nav-btn' + (currentTab === item.id ? ' active' : '')}
                  onClick={() => {
                    if (isGymMode) {
                      if (isTenantBillingLocked && item.id !== 'billing') {
                        selectGymTab('billing');
                        toast('Assinatura vencida ou degustação encerrada. Regularize via PIX para liberar este módulo.');
                      } else {
                        selectGymTab(item.id);
                      }
                    } else {
                      selectSuperTab(item.id);
                    }
                    setMobileOpen(false);
                  }}
                >
                  <Icon name={item.icon} size={19} />
                  <span>{item.label}</span>
                  {showBadge && (
                    <span className={'portal-nav-badge num' + (item.dangerBadge ? ' danger' : '')}>
                      {rawBadge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="portal-sidebar-foot">
            {isGymMode && activeTenant?.id && (
              <a
                href={getStudentAppUrl(activeTenant.id)}
                target="_blank"
                rel="noreferrer"
                className="portal-nav-btn"
                style={{ textDecoration: 'none' }}
              >
                <Icon name="phoneScreen" size={18} />
                <span>Aplicativo do Aluno</span>
                <Icon name="externalLink" size={14} style={{ marginLeft: 'auto', opacity: 0.6 }} />
              </a>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 8px 2px' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user.name}
                </div>
                <div className="muted small" style={{ fontSize: 11.5 }}>{roleLabel}</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="b2b-icon-btn"
                  onClick={handleToggleTheme}
                  title={theme === 'dark' ? 'Tema Claro' : 'Tema Escuro'}
                >
                  <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
                </button>
                <button
                  type="button"
                  className="b2b-icon-btn"
                  onClick={handleLogout}
                  title="Sair da conta"
                  style={{ color: 'var(--red)' }}
                >
                  <Icon name="signOut" size={16} />
                </button>
              </div>
            </div>
            <div className="muted" style={{ fontSize: 10.5, padding: '2px 8px 0', opacity: 0.65 }}>
              Rit · Desenvolvido por Nicolas Oliveira
            </div>
          </div>
        </aside>

        {/* Área Principal */}
        <div className="portal-content">
          <header className="portal-topbar">
            <div className="portal-topbar-l">
              <button
                type="button"
                className="portal-mobile-btn"
                onClick={() => setMobileOpen(v => !v)}
                aria-label="Abrir menu"
              >
                <Icon name="menu" size={20} />
              </button>
              <StatusPill tone="ok" icon={isGymMode ? 'dumbbell' : 'crown'} className="portal-topbar-pill">
                {isGymMode ? (isPersonalTenant ? 'Painel do Personal' : 'Painel da Academia') : 'Administração Rit'}
              </StatusPill>
              {(() => {
                const activeNav = navItems.find(i => i.id === currentTab);
                if (!activeNav) return null;
                return (
                  <div className="portal-topbar-crumb">
                    <Icon name="chevronRight" size={14} className="muted" />
                    <Icon name={activeNav.icon} size={15} style={{ color: 'var(--acc-ink)' }} />
                    <span>{activeNav.label}</span>
                  </div>
                );
              })()}
            </div>

            <div className="portal-topbar-r">
              {isGymMode && activeTenant?.id && (
                <a
                  href={getStudentAppUrl(activeTenant.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="btn ghost sm portal-topbar-app-link"
                  title="Abrir Aplicativo do Aluno"
                >
                  <Icon name="phoneScreen" size={15} />
                  <span>App do Aluno</span>
                </a>
              )}
              {isGymMode && !isTenantBillingLocked && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon="sparkles"
                  data-tour="topbar-tour-btn"
                  onClick={() => setTourSession({ kind: 'hub' })}
                  title="Abrir Tour Guiado e Tutoriais do Painel"
                  style={{ fontSize: 14 }}
                >
                  Tour Guiado
                </Button>
              )}
              <button
                type="button"
                className="b2b-icon-btn"
                onClick={handleToggleTheme}
                title={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
              >
                <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
              </button>
              <Button variant="ghost" size="sm" icon="signOut" className="portal-topbar-logout" onClick={handleLogout} title="Sair da conta" aria-label="Sair da conta">
                Sair
              </Button>
            </div>
          </header>

          <main className="portal-main">
            <Suspense fallback={<div className="muted" style={{ padding: 32 }}>Carregando painel...</div>}>
              {isGymMode ? (
                <GymPanel
                  key={activeTenant?.id || user?.tenantId || 'default'}
                  activeTab={isTenantBillingLocked ? 'billing' : gymTab}
                  onChangeTab={selectGymTab}
                  user={user}
                  tenantSlug={activeTenant?.id || user?.tenantId || 'default'}
                  onTenantUpdated={handleTenantUpdated}
                  onStatsLoaded={setGymKpis}
                  demoAllowed={Boolean(bootstrap?.demoAllowed)}
                  billingLocked={isTenantBillingLocked}
                />
              ) : (
                <SuperAdminPanel
                  activeTab={superTab}
                  onChangeTab={selectSuperTab}
                  onImpersonate={handleStartImpersonation}
                  onDataChanged={handleSuperDataChanged}
                />
              )}
            </Suspense>
          </main>
        </div>
      </div>

      {isGymMode && !isTenantBillingLocked && (
        <PortalTour
          session={tourSession}
          onSetSession={setTourSession}
          onClose={() => setTourSession(null)}
          currentTab={gymTab}
          onSelectTab={selectGymTab}
          isPersonal={isPersonalTenant}
        />
      )}

      <ToastHost />
    </div>
  );
}
