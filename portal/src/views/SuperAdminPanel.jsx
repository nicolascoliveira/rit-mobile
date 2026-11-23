import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../components/Icon.jsx';
import {
  Button,
  Section,
  Row,
  Switch,
  SearchField,
  TextField,
  NumberField,
  TextArea,
  SelectField,
  ChipBar,
  StatusPill,
  KpiTile,
  CardHead,
  EmptyState,
  Modal,
  ConfirmModal,
  LoadingState
} from '../components/ui.jsx';
import { LineChart, BarRow, StackBar } from '../components/Charts.jsx';
import { portalApi, toast, fmtBRL, fmtDateBR, getStudentAppUrl, generateTempPassword, getOrRotateIntentKey } from '../lib/api.js';

const BRAND_SWATCHES = [
  '#D0FF00',
  '#a3e635',
  '#06b6d4',
  '#3b82f6',
  '#6366f1',
  '#a855f7',
  '#ec4899',
  '#f43f5e',
  '#f97316',
  '#eab308'
];

const STATUS_LABELS = {
  active: 'Ativa',
  trial: 'Em Trial',
  past_due: 'Inadimplente',
  suspended: 'Suspensa'
};

const INVOICE_LABELS = {
  paid: { label: 'Pago', tone: 'ok' },
  pending: { label: 'Pendente', tone: 'warn' },
  overdue: { label: 'Vencida', tone: 'bad' }
};

function slugifyName(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 32);
}

export default function SuperAdminPanel({ activeTab = 'overview', onChangeTab, onImpersonate, onDataChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [auditEvents, setAuditEvents] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);

  // Filtros de Academias
  const [tenantQuery, setTenantQuery] = useState('');
  const [tenantStatusFilter, setTenantStatusFilter] = useState('all');

  // Filtros de Faturas
  const [invStatusFilter, setInvStatusFilter] = useState('all');

  // Modal: Nova Academia
  const [createOpen, setCreateOpen] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const [newForm, setNewForm] = useState({
    accountType: 'gym',
    name: '',
    id: '',
    document: '',
    city: '',
    phone: '',
    planId: 'pro',
    status: 'active',
    ownerName: '',
    ownerEmail: '',
    ownerPassword: generateTempPassword(),
    primaryColor: '#D0FF00',
    slogan: 'Seu treino na palma da mão'
  });
  const [creating, setCreating] = useState(false);

  // Modal: Editar Academia
  const [editTenant, setEditTenant] = useState(null);
  const [savingTenant, setSavingTenant] = useState(false);

  // Modal: Senha do Gestor
  const [pwModalTenant, setPwModalTenant] = useState(null);
  const [newOwnerPw, setNewOwnerPw] = useState('');
  const [savingPw, setSavingPw] = useState(false);

  // Modal: Excluir Academia
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Modal: Suspender Academia
  const [suspendTarget, setSuspendTarget] = useState(null);
  const [suspending, setSuspending] = useState(false);

  // Modal: Editar Plano SaaS
  const [editPlan, setEditPlan] = useState(null);
  const [savingPlan, setSavingPlan] = useState(false);

  // Modal: Nova Fatura / Pagamento
  const [invModalOpen, setInvModalOpen] = useState(false);
  const [invForm, setInvForm] = useState({
    tenantId: '',
    refMonth: new Date().toISOString().slice(0, 7),
    amount: 269,
    method: 'PIX',
    status: 'paid',
    note: ''
  });
  const [savingInv, setSavingInv] = useState(false);

  // Formulário Plataforma
  const [platformForm, setPlatformForm] = useState({
    name: '',
    supportEmail: '',
    supportPhone: '',
    trialDays: 14
  });
  const [savingPlatform, setSavingPlatform] = useState(false);
  const [auditQuery, setAuditQuery] = useState('');

  // Gateway Central WhatsApp (Evolution API)
  const [centralWa, setCentralWa] = useState(null);
  const [mpStatus, setMpStatus] = useState(null);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [qrBase64, setQrBase64] = useState(null);
  const [loadingQr, setLoadingQr] = useState(false);
  const [testingWa, setTestingWa] = useState(false);
  const [testPhoneInput, setTestPhoneInput] = useState('');
  const [disconnectingWa, setDisconnectingWa] = useState(false);

  const onDataChangedRef = useRef(onDataChanged);
  onDataChangedRef.current = onDataChanged;
  const mountedRef = useRef(true);
  const [togglingTenantId, setTogglingTenantId] = useState(null);
  const [payingInvoiceId, setPayingInvoiceId] = useState(null);
  const inFlightActionRef = useRef(new Set());
  const createTenantIdemRef = useRef(null);
  const recordInvoiceIdemRef = useRef(null);
  const payInvoiceIdemRef = useRef(null);

  const runSingleFlight = async (key, setBusyKey, busyVal, fn) => {
    if (inFlightActionRef.current.has(key)) return;
    inFlightActionRef.current.add(key);
    setBusyKey?.(busyVal);
    try {
      return await fn();
    } finally {
      inFlightActionRef.current.delete(key);
      if (mountedRef.current) setBusyKey?.(typeof busyVal === 'boolean' ? false : null);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadOverview = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await portalApi('/api/saas/admin/overview', { tenantId: '' });
      if (!mountedRef.current) return;
      setData(res);
      if (res.platform) {
        setPlatformForm({
          name: res.platform.name || 'Rit Cloud',
          supportEmail: res.platform.supportEmail || '',
          supportPhone: res.platform.supportPhone || '',
          trialDays: Number(res.platform.trialDays || 14)
        });
      }
      onDataChangedRef.current?.(res);
    } catch (err) {
      if (mountedRef.current) {
        toast(err.message || 'Erro ao carregar dados executivos');
      }
    } finally {
      if (!silent && mountedRef.current) setLoading(false);
    }
  }, []);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      const res = await portalApi('/api/saas/admin/audit', { tenantId: '' });
      setAuditEvents(res.events || []);
    } catch {
      setAuditEvents([]);
    } finally {
      setAuditLoading(false);
    }
  }, []);

  const loadCentralWaStatus = useCallback(async () => {
    try {
      const res = await portalApi('/api/saas/admin/whatsapp/status', { tenantId: '' });
      setCentralWa(res);
      if (res?.connected && qrModalOpen) {
        setQrModalOpen(false);
        toast('WhatsApp oficial da Rit conectado com sucesso! 🎉');
      }
    } catch {}
  }, [qrModalOpen]);

  const loadMpStatus = useCallback(async () => {
    try {
      const res = await portalApi('/api/saas/admin/mercadopago/status', { tenantId: '' });
      if (res && res.ok) setMpStatus(res);
    } catch {}
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (activeTab === 'settings') {
      loadAudit();
      loadCentralWaStatus();
      loadMpStatus();
    }
  }, [activeTab, loadAudit, loadCentralWaStatus, loadMpStatus]);

  const fetchCentralWaQr = useCallback(async ({ showMissingToast = true } = {}) => {
    const res = await portalApi('/api/saas/admin/whatsapp/qr', { tenantId: '' });
    if (!mountedRef.current) return res;
    if (res?.connected) {
      setCentralWa(p => ({ ...(p || {}), connected: true, state: 'open' }));
      setQrModalOpen(false);
      toast('WhatsApp oficial da Rit já está conectado! 🎉');
      return res;
    }
    if (res?.base64) {
      setQrBase64(res.base64);
      setQrModalOpen(true);
    } else if (showMissingToast) {
      toast('Iniciando sessão do WhatsApp... tente novamente em instantes.');
    }
    return res;
  }, []);

  useEffect(() => {
    if (!qrModalOpen) return;
    const statusTimer = setInterval(() => {
      loadCentralWaStatus();
    }, 2000);
    // QR Code do Baileys expira rapidamente; renova em segundo plano enquanto o modal estiver aberto.
    const qrTimer = setInterval(() => {
      fetchCentralWaQr({ showMissingToast: false }).catch(() => {});
    }, 20000);
    return () => {
      clearInterval(statusTimer);
      clearInterval(qrTimer);
    };
  }, [qrModalOpen, loadCentralWaStatus, fetchCentralWaQr]);

  const handleOpenQrModal = async () => {
    setLoadingQr(true);
    try {
      await fetchCentralWaQr({ showMissingToast: true });
    } catch (err) {
      toast(err.message || 'Erro ao gerar QR Code do WhatsApp');
    } finally {
      if (mountedRef.current) setLoadingQr(false);
    }
  };

  const handleDisconnectWa = async () => {
    setDisconnectingWa(true);
    try {
      await portalApi('/api/saas/admin/whatsapp/disconnect', { method: 'POST', tenantId: '' });
      setCentralWa({ connected: false, state: 'close' });
      setQrBase64(null);
      setConfirmDisconnectWa(false);
      toast('WhatsApp oficial da Rit desconectado.');
    } catch (err) {
      toast(err.message || 'Erro ao desconectar');
    } finally {
      setDisconnectingWa(false);
    }
  };

  const handleTestCentralWa = async () => {
    if (!testPhoneInput.trim()) {
      toast('Digite um número de telefone com DDD para testar o envio');
      return;
    }
    setTestingWa(true);
    try {
      const res = await portalApi('/api/saas/admin/whatsapp/test', {
        method: 'POST',
        body: { phone: testPhoneInput.trim() },
        tenantId: ''
      });
      toast(res.message || 'Mensagem de teste enviada com sucesso no WhatsApp!');
    } catch (err) {
      toast(err.message || 'Falha ao enviar mensagem de teste');
    } finally {
      setTestingWa(false);
    }
  };

  const [confirmDisconnectWa, setConfirmDisconnectWa] = useState(false);
  const [adminWaModal, setAdminWaModal] = useState(null);
  const [sendingAdminWa, setSendingAdminWa] = useState(false);

  const handleSendAdminWhatsApp = async e => {
    e?.preventDefault();
    if (!adminWaModal?.phone?.trim() || !adminWaModal?.message?.trim()) {
      toast('Informe o telefone e a mensagem');
      return;
    }
    setSendingAdminWa(true);
    try {
      const res = await portalApi('/api/saas/admin/whatsapp/send', {
        method: 'POST',
        tenantId: '',
        body: {
          phone: adminWaModal.phone.trim(),
          message: adminWaModal.message.trim()
        }
      });
      toast(res.message || 'Mensagem enviada com sucesso via WhatsApp!');
      setAdminWaModal(null);
    } catch (err) {
      toast(err.message || 'Falha ao enviar mensagem');
    } finally {
      setSendingAdminWa(false);
    }
  };

  const tenants = data?.tenants || [];
  const plans = data?.plans || [];
  const metrics = data?.metrics || {};
  const recentInvoices = data?.recentInvoices || [];

  const filteredTenants = useMemo(() => {
    const q = tenantQuery.trim().toLowerCase();
    return tenants.filter(t => {
      if (tenantStatusFilter === 'personal') {
        if (t.accountType !== 'personal' && !String(t.planId || '').startsWith('personal')) return false;
      } else if (tenantStatusFilter === 'gym') {
        if (t.accountType === 'personal' || String(t.planId || '').startsWith('personal')) return false;
      } else if (tenantStatusFilter !== 'all' && t.status !== tenantStatusFilter) {
        return false;
      }
      if (!q) return true;
      const hay = `${t.name} ${t.id} ${t.city || ''} ${t.document || ''} ${t.ownerName || ''} ${t.ownerEmail || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [tenants, tenantQuery, tenantStatusFilter]);

  const filteredInvoices = useMemo(() => {
    if (invStatusFilter === 'all') return recentInvoices;
    return recentInvoices.filter(inv => inv.status === invStatusFilter);
  }, [recentInvoices, invStatusFilter]);

  const filteredAudit = useMemo(() => {
    const q = auditQuery.trim().toLowerCase();
    if (!q) return auditEvents;
    return auditEvents.filter(ev => JSON.stringify(ev).toLowerCase().includes(q));
  }, [auditEvents, auditQuery]);

  const openCreateModal = () => {
    setSlugEdited(false);
    createTenantIdemRef.current = null;
    setNewForm({
      accountType: 'gym',
      name: '',
      id: '',
      document: '',
      city: '',
      phone: '',
      planId: 'pro',
      status: 'active',
      ownerName: '',
      ownerEmail: '',
      ownerPassword: generateTempPassword(),
      primaryColor: '#D0FF00',
      slogan: 'Seu treino na palma da mão'
    });
    setCreateOpen(true);
  };

  const handleCreateTenant = async e => {
    e?.preventDefault();
    if (!newForm.name.trim() || !newForm.id.trim()) {
      toast('Informe o nome da academia e o identificador (slug)');
      return;
    }
    const payload = {
      ...newForm,
      name: newForm.name.trim(),
      id: newForm.id.trim().toLowerCase()
    };
    const idemKey = getOrRotateIntentKey(createTenantIdemRef, payload);
    await runSingleFlight('create-tenant', setCreating, true, async () => {
      try {
        await portalApi('/api/saas/admin/tenants', {
          method: 'POST',
          tenantId: '',
          idempotencyKey: idemKey,
          body: payload
        });
        createTenantIdemRef.current = null;
        toast(`Academia "${newForm.name}" provisionada com sucesso!`);
        setCreateOpen(false);
        await loadOverview(true);
      } catch (err) {
        toast(err.message || 'Erro ao criar academia');
      }
    });
  };

  const handleUpdateTenant = async e => {
    e?.preventDefault();
    if (!editTenant) return;
    setSavingTenant(true);
    try {
      await portalApi('/api/saas/admin/tenants', {
        method: 'PUT',
        tenantId: '',
        body: {
          id: editTenant.id,
          name: editTenant.name,
          accountType: editTenant.accountType || (String(editTenant.planId || '').startsWith('personal') ? 'personal' : 'gym'),
          document: editTenant.document,
          city: editTenant.city,
          phone: editTenant.phone,
          ownerName: editTenant.ownerName,
          ownerEmail: editTenant.ownerEmail,
          planId: editTenant.planId,
          mrr: Number(editTenant.mrr || 0),
          status: editTenant.status,
          notes: editTenant.notes,
          primaryColor: editTenant.primaryColor
        }
      });
      toast('Dados da academia atualizados!');
      setEditTenant(null);
      await loadOverview(true);
    } catch (err) {
      toast(err.message || 'Erro ao atualizar academia');
    } finally {
      setSavingTenant(false);
    }
  };

  const handleToggleStatus = async (tenant, force = false) => {
    const nextStatus = tenant.status === 'suspended' ? 'active' : 'suspended';
    if (nextStatus === 'suspended' && !force) {
      setSuspendTarget(tenant);
      return;
    }
    await runSingleFlight(`toggle-status:${tenant.id}`, setTogglingTenantId, tenant.id, async () => {
      try {
        await portalApi('/api/saas/admin/tenants/status', {
          method: 'POST',
          tenantId: '',
          body: { id: tenant.id, status: nextStatus }
        });
        toast(nextStatus === 'suspended' ? `Acesso de ${tenant.name} suspenso.` : `${tenant.name} reativada!`);
        await loadOverview(true);
      } catch (err) {
        toast(err.message || 'Falha ao alterar status');
      }
    });
  };

  const handleResetOwnerPassword = async e => {
    e?.preventDefault();
    if (!pwModalTenant || newOwnerPw.length < 10) {
      toast('Informe uma senha com pelo menos 10 caracteres');
      return;
    }
    setSavingPw(true);
    try {
      await portalApi('/api/saas/admin/tenants/owner-password', {
        method: 'POST',
        tenantId: '',
        body: {
          tenantId: pwModalTenant.id,
          password: newOwnerPw,
          ownerEmail: pwModalTenant.ownerEmail,
          ownerName: pwModalTenant.ownerName
        }
      });
      toast(`Senha do gestor de ${pwModalTenant.name} redefinida!`);
      setPwModalTenant(null);
      setNewOwnerPw('');
      await loadOverview(true);
    } catch (err) {
      toast(err.message || 'Erro ao redefinir senha');
    } finally {
      setSavingPw(false);
    }
  };

  const handleDeleteTenant = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await portalApi('/api/saas/admin/tenants', {
        method: 'DELETE',
        tenantId: '',
        body: { id: deleteTarget.id }
      });
      toast(`Academia "${deleteTarget.name}" removida do sistema.`);
      setDeleteTarget(null);
      await loadOverview(true);
    } catch (err) {
      toast(err.message || 'Erro ao remover academia');
    } finally {
      setDeleting(false);
    }
  };

  const handleSavePlan = async e => {
    e?.preventDefault();
    if (!editPlan) return;
    setSavingPlan(true);
    try {
      await portalApi('/api/saas/admin/plans', {
        method: 'PUT',
        tenantId: '',
        body: editPlan
      });
      toast(`Plano ${editPlan.name} atualizado!`);
      setEditPlan(null);
      await loadOverview(true);
    } catch (err) {
      toast(err.message || 'Erro ao salvar plano');
    } finally {
      setSavingPlan(false);
    }
  };

  const openInvoiceModal = (defaultTenant = null) => {
    const t = defaultTenant || tenants[0] || null;
    recordInvoiceIdemRef.current = null;
    setInvForm({
      tenantId: t?.id || '',
      refMonth: new Date().toISOString().slice(0, 7),
      amount: t?.mrr ?? 269,
      method: 'PIX',
      status: 'paid',
      note: ''
    });
    setInvModalOpen(true);
  };

  const handleRecordInvoice = async e => {
    e?.preventDefault();
    if (!invForm.tenantId) {
      toast('Selecione a academia cliente');
      return;
    }
    const idemKey = getOrRotateIntentKey(recordInvoiceIdemRef, invForm);
    await runSingleFlight('record-invoice', setSavingInv, true, async () => {
      try {
        await portalApi('/api/saas/admin/tenants/invoice', {
          method: 'POST',
          tenantId: '',
          idempotencyKey: idemKey,
          body: invForm
        });
        recordInvoiceIdemRef.current = null;
        toast('Fatura registrada com sucesso!');
        setInvModalOpen(false);
        await loadOverview(true);
      } catch (err) {
        toast(err.message || 'Erro ao registrar fatura');
      }
    });
  };

  const handleMarkInvoicePaid = async inv => {
    const payload = {
      tenantId: inv.tenantId,
      id: inv.id,
      status: 'paid',
      method: inv.method || 'PIX'
    };
    const idemKey = getOrRotateIntentKey(payInvoiceIdemRef, payload);
    await runSingleFlight(`pay-invoice:${inv.id}`, setPayingInvoiceId, inv.id, async () => {
      try {
        await portalApi('/api/saas/admin/tenants/invoice', {
          method: 'POST',
          tenantId: '',
          idempotencyKey: idemKey,
          body: payload
        });
        payInvoiceIdemRef.current = null;
        toast(`Pagamento confirmado para ${inv.tenantName}!`);
        await loadOverview(true);
      } catch (err) {
        toast(err.message || 'Erro ao confirmar recebimento');
      }
    });
  };

  const handleSavePlatform = async e => {
    e?.preventDefault();
    setSavingPlatform(true);
    try {
      await portalApi('/api/saas/admin/platform', {
        method: 'PUT',
        tenantId: '',
        body: platformForm
      });
      toast('Configurações globais da plataforma salvas!');
      await loadOverview(true);
    } catch (err) {
      toast(err.message || 'Erro ao salvar configurações');
    } finally {
      setSavingPlatform(false);
    }
  };

  if (loading && !data) {
    return <LoadingState label="Carregando central executiva..." cards={4} />;
  }

  const planColors = ['#3b82f6', '#a3e635', '#a855f7', '#06b6d4'];
  const planBreakdown = data?.planBreakdown || [];
  const maxPlanRev = Math.max(1, ...planBreakdown.map(p => p.revenue || 0));

  return (
    <div>
      {/* =================================================================
          ABA 1: VISÃO EXECUTIVA
         ================================================================= */}
      {activeTab === 'overview' && (
        <div>
          <div className="b2b-page-head">
            <div>
              <h1>Visão Executiva — Rit</h1>
              <p>Acompanhamento consolidado de receita recorrente (MRR), academias, personal trainers e volume de treinos em tempo real.</p>
            </div>
            <div className="b2b-head-actions">
              <Button variant="ghost" icon="reset" onClick={() => loadOverview()}>
                Atualizar
              </Button>
              <Button variant="primary" icon="plus" onClick={openCreateModal}>
                Provisionar Cliente
              </Button>
            </div>
          </div>

          <div className="b2b-kpi-grid">
            <KpiTile
              label="MRR (Receita Recorrente)"
              value={fmtBRL(metrics.mrr || 0)}
              sub={`ARR projetado: ${fmtBRL(metrics.arr || 0)}`}
              icon="creditCard"
              tint="var(--acc)"
              onClick={() => onChangeTab?.('billing')}
            />
            <KpiTile
              label="Contas Ativas (Acad. + Personal)"
              value={`${metrics.activeGyms || 0} / ${metrics.totalGyms || 0}`}
              sub={`${metrics.trialGyms || 0} em Trial · ${metrics.pastDueGyms || 0} atrasadas`}
              icon="building"
              tint="var(--indigo)"
              onClick={() => onChangeTab?.('tenants')}
            />
            <KpiTile
              label="Alunos na Plataforma"
              value={String(metrics.totalStudents || 0)}
              sub={`${metrics.activeStudents30d || 0} treinaram nos últimos 30d`}
              icon="users"
              tint="var(--teal)"
              onClick={() => onChangeTab?.('tenants')}
            />
            <KpiTile
              label="Treinos Registrados"
              value={String(metrics.totalWorkoutsLogged || 0)}
              sub={`${metrics.workoutsLast30d || 0} em 30d · ${metrics.liveTrainingNow || 0} treinando agora`}
              icon="activity"
              tint="var(--orange)"
            />
          </div>

          <div className="b2b-grid-2">
            <div className="card" style={{ margin: 0 }}>
              <CardHead
                icon="chartLine"
                iconTint="var(--acc)"
                title="Evolução de MRR"
                subtitle="Crescimento da receita mensal recorrente nos últimos 6 meses"
              />
              <LineChart
                data={data?.mrrSeries || []}
                valueKey="value"
                labelKey="label"
                height={185}
                formatValue={fmtBRL}
              />
            </div>

            <div className="card" style={{ margin: 0 }}>
              <CardHead
                icon="crown"
                iconTint="var(--indigo)"
                title="Receita por Plano"
                subtitle="Distribuição da carteira entre os planos de assinatura"
                action={
                  <Button variant="ghost" size="sm" onClick={() => onChangeTab?.('billing')}>
                    Ver Planos
                  </Button>
                }
              />
              <div style={{ marginBottom: 18 }}>
                <StackBar
                  segments={planBreakdown.map((p, idx) => ({
                    label: `${p.name} (${p.count})`,
                    value: Math.max(p.count, 0),
                    display: `${p.count} un.`,
                    color: planColors[idx % planColors.length]
                  }))}
                />
              </div>
              <div>
                {planBreakdown.map((p, idx) => (
                  <BarRow
                    key={p.id}
                    label={`Plano ${p.name} (${fmtBRL(p.priceMonthly)}/mês)`}
                    value={p.revenue}
                    max={maxPlanRev}
                    rightText={`${fmtBRL(p.revenue)} · ${p.count} acad.`}
                    color={planColors[idx % planColors.length]}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <CardHead
              icon="building"
              iconTint="var(--teal)"
              title="Carteira de Academias & Personal Trainers (Acesso Rápido)"
              subtitle="Entre com 1 clique no painel operacional de qualquer academia ou personal trainer para suporte ou auditoria"
              action={
                <Button variant="tinted" size="sm" trailingIcon="chevronRight" onClick={() => onChangeTab?.('tenants')}>
                  Gerenciar Todas ({tenants.length})
                </Button>
              }
            />

            {tenants.length === 0 ? (
              <EmptyState
                icon="building"
                title="Nenhum cliente cadastrado"
                message="Provisione sua primeira academia ou personal trainer para liberar o painel e o aplicativo personalizado dos alunos."
                action={<Button variant="primary" icon="plus" onClick={openCreateModal}>Provisionar Primeiro Cliente</Button>}
              />
            ) : (
              <div className="b2b-table-wrap b2b-table-wrap-stack" style={{ border: 'none' }}>
                <table className="b2b-table b2b-table-stack">
                  <thead>
                    <tr>
                      <th>Cliente (Academia / Personal)</th>
                      <th>Plano & MRR</th>
                      <th>Alunos / Limite</th>
                      <th>Treinos (30d)</th>
                      <th>Status</th>
                      <th style={{ textAlign: 'right' }}>Acesso Direto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenants.map(t => (
                      <tr key={t.id}>
                        <td className="b2b-td-main">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                            <span
                              style={{
                                width: 12,
                                height: 12,
                                borderRadius: '50%',
                                background: t.branding?.primaryColor || 'var(--acc)',
                                flexShrink: 0
                              }}
                            />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <span>{t.name}</span>
                                <span
                                  className={'b2b-type-badge' + ((t.accountType === 'personal' || String(t.planId || '').startsWith('personal')) ? ' is-personal' : '')}
                                >
                                  {(t.accountType === 'personal' || String(t.planId || '').startsWith('personal')) ? 'Personal' : 'Academia'}
                                </span>
                              </div>
                              <div className="muted small">
                                <code>{t.id}</code> {t.city ? `· ${t.city}` : ''}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td data-label="Plano & MRR">
                          <div>
                            <div style={{ fontWeight: 600 }}>{t.planName}</div>
                            <div className="muted small num">{fmtBRL(t.mrr)}/mês</div>
                          </div>
                        </td>
                        <td data-label="Alunos / Limite">
                          <div>
                            <div className="num" style={{ fontWeight: 600 }}>
                              {t.studentCount} <span className="muted">/ {(t.limits?.maxStudents >= 100000 ? 'Ilimitado' : (t.limits?.maxStudents || 'Ilimitado'))}</span>
                            </div>
                            {t.atRiskCount > 0 && (
                              <div className="small" style={{ color: 'var(--orange)' }}>
                                {t.atRiskCount} em alerta de evasão
                              </div>
                            )}
                          </div>
                        </td>
                        <td data-label="Treinos (30d)" className="num">
                          <span>
                            <span style={{ fontWeight: 600 }}>{t.workoutsLast30d || 0}</span>
                            <span className="muted small"> ({t.workoutCount || 0} total)</span>
                          </span>
                        </td>
                        <td data-label="Status">
                          <StatusPill tone={t.status}>{STATUS_LABELS[t.status] || t.status}</StatusPill>
                        </td>
                        <td className="b2b-td-actions">
                          <div className="b2b-row-actions">
                            <a
                              href={getStudentAppUrl(t.id)}
                              target="_blank"
                              rel="noreferrer"
                              className="btn ghost sm"
                              title="Abrir Aplicativo do Aluno"
                              aria-label={`Abrir Aplicativo do Aluno de ${t.name}`}
                            >
                              <Icon name="phoneScreen" size={15} />
                              <span>App Aluno</span>
                            </a>
                            {t.phone && (
                              <Button
                                variant="ghost"
                                size="sm"
                                icon="chat"
                                title="Enviar mensagem via WhatsApp Oficial"
                                aria-label={`Enviar WhatsApp para ${t.name}`}
                                style={{ color: 'var(--green)' }}
                                onClick={() => {
                                  setAdminWaModal({
                                    targetName: t.name,
                                    phone: t.phone,
                                    message: `Olá equipe da ${t.name}! Aqui é Nicolas Oliveira do suporte da Rit Cloud.`
                                  });
                                }}
                              />
                            )}
                            <Button
                              variant="tinted"
                              size="sm"
                              icon="eye"
                              onClick={() => onImpersonate?.(t)}
                            >
                              Acessar Painel
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =================================================================
          ABA 2: GESTÃO DE ACADEMIAS CLIENTES (MULTI-TENANT)
         ================================================================= */}
      {activeTab === 'tenants' && (
        <div>
          <div className="b2b-page-head">
            <div>
              <h1>Academias & Personal Trainers</h1>
              <p>Provisione novas academias ou personal trainers independentes, gerencie planos, credenciais e status de acesso.</p>
            </div>
            <div className="b2b-head-actions">
              <Button variant="primary" icon="plus" onClick={openCreateModal}>
                Novo Cliente (Academia / Personal)
              </Button>
            </div>
          </div>

          <div className="b2b-toolbar">
            <SearchField
              value={tenantQuery}
              onChange={setTenantQuery}
              placeholder="Buscar por nome, slug, cidade, CNPJ/CPF/CREF ou responsável..."
            />
            <ChipBar
              value={tenantStatusFilter}
              onChange={setTenantStatusFilter}
              items={[
                { value: 'all', label: 'Todos', count: tenants.length },
                { value: 'gym', label: 'Academias', count: tenants.filter(t => t.accountType !== 'personal' && !String(t.planId || '').startsWith('personal')).length },
                { value: 'personal', label: 'Personais', count: tenants.filter(t => t.accountType === 'personal' || String(t.planId || '').startsWith('personal')).length },
                { value: 'active', label: 'Ativos', count: tenants.filter(t => t.status === 'active').length },
                { value: 'trial', label: 'Em Trial', count: tenants.filter(t => t.status === 'trial').length },
                { value: 'past_due', label: 'Atrasados', count: tenants.filter(t => t.status === 'past_due').length },
                { value: 'suspended', label: 'Suspensos', count: tenants.filter(t => t.status === 'suspended').length }
              ]}
            />
          </div>

          {filteredTenants.length === 0 ? (
            <div className="card">
              <EmptyState
                icon="building"
                title="Nenhuma academia encontrada"
                message="Ajuste os filtros de busca ou cadastre uma nova academia cliente."
                action={<Button variant="primary" icon="plus" onClick={openCreateModal}>Nova Academia</Button>}
              />
            </div>
          ) : (
            <div className="b2b-table-wrap b2b-table-wrap-stack">
              <table className="b2b-table b2b-table-stack">
                <thead>
                  <tr>
                    <th>Unidade / Identificador</th>
                    <th>Gestor Responsável</th>
                    <th>Plano & Mensalidade</th>
                    <th>Uso do Plano</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Ações Administrativas</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTenants.map(t => {
                    const maxSt = t.limits?.maxStudents || 400;
                    const pct = Math.min(100, Math.round(((t.studentCount || 0) / maxSt) * 100));
                    return (
                      <tr key={t.id}>
                        <td className="b2b-td-main">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
                            <span
                              style={{
                                width: 14,
                                height: 14,
                                borderRadius: 4,
                                background: t.branding?.primaryColor || 'var(--acc)',
                                flexShrink: 0
                              }}
                            />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 700, fontSize: 14.5, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                <span>{t.name}</span>
                                <span
                                  className={'b2b-type-badge' + ((t.accountType === 'personal' || String(t.planId || '').startsWith('personal')) ? ' is-personal' : '')}
                                >
                                  {(t.accountType === 'personal' || String(t.planId || '').startsWith('personal')) ? 'Personal' : 'Academia'}
                                </span>
                              </div>
                              <div className="muted small">
                                <code>?tenant={t.id}</code>
                                {t.city ? ` · ${t.city}` : ''}
                                {t.document ? ` · ${t.document}` : ''}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td data-label="Gestor">
                          <div>
                            <div style={{ fontWeight: 600 }}>{t.ownerName || 'Não informado'}</div>
                            <div className="muted small">{t.ownerEmail || '—'}</div>
                          </div>
                        </td>
                        <td data-label="Plano & MRR">
                          <div>
                            <div style={{ fontWeight: 700 }}>{t.planName}</div>
                            <div className="muted small num">{fmtBRL(t.mrr)}/mês</div>
                          </div>
                        </td>
                        <td data-label="Uso do Plano">
                          <div style={{ flex: '1 1 140px', minWidth: 0 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 4 }}>
                              <span className="num"><b>{t.studentCount}</b> / {maxSt} alunos</span>
                              <span className="muted num">{t.trainerCount} prof.</span>
                            </div>
                            <div className="b2b-barrow-track">
                              <div
                                className="b2b-barrow-fill"
                                style={{
                                  width: `${pct}%`,
                                  background: pct > 90 ? 'var(--red)' : pct > 75 ? 'var(--orange)' : 'var(--acc)'
                                }}
                              />
                            </div>
                          </div>
                        </td>
                        <td data-label="Status">
                          <StatusPill tone={t.status}>{STATUS_LABELS[t.status] || t.status}</StatusPill>
                        </td>
                        <td className="b2b-td-actions">
                          <div className="b2b-row-actions">
                            <Button
                              variant="tinted"
                              size="sm"
                              icon="eye"
                              onClick={() => onImpersonate?.(t)}
                              title="Entrar no painel desta academia"
                              aria-label={`Acessar painel de ${t.name}`}
                            >
                              Painel
                            </Button>
                            <a
                              href={getStudentAppUrl(t.id)}
                              target="_blank"
                              rel="noreferrer"
                              className="btn ghost sm"
                              title="Abrir App do Aluno"
                              aria-label={`Abrir App do Aluno de ${t.name}`}
                            >
                              <Icon name="phoneScreen" size={15} />
                            </a>
                            {t.phone && (
                              <Button
                                variant="ghost"
                                size="sm"
                                icon="chat"
                                title="Enviar mensagem via WhatsApp Oficial"
                                aria-label={`Enviar WhatsApp para ${t.name}`}
                                style={{ color: 'var(--green)' }}
                                onClick={() => {
                                  setAdminWaModal({
                                    targetName: t.name,
                                    phone: t.phone,
                                    message: `Olá equipe da ${t.name}! Aqui é Nicolas Oliveira do suporte da Rit Cloud.`
                                  });
                                }}
                              />
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              icon="pencil"
                              title="Editar cadastro, plano e limites"
                              aria-label={`Editar cliente ${t.name}`}
                              onClick={() =>
                                setEditTenant({
                                  ...t,
                                  primaryColor: t.branding?.primaryColor || '#a3e635'
                                })
                              }
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              icon="key"
                              title="Redefinir senha do gestor da academia"
                              aria-label={`Redefinir senha do gestor de ${t.name}`}
                              onClick={() => {
                                setPwModalTenant(t);
                                setNewOwnerPw('');
                              }}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={t.status === 'suspended' ? 'check' : 'lock'}
                              title={t.status === 'suspended' ? 'Reativar acesso da academia' : 'Suspender acesso por inadimplência'}
                              aria-label={t.status === 'suspended' ? `Reativar acesso de ${t.name}` : `Suspender acesso de ${t.name}`}
                              disabled={togglingTenantId === t.id}
                              onClick={() => handleToggleStatus(t)}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              icon="trash"
                              title="Remover academia"
                              aria-label={`Remover cliente ${t.name}`}
                              className="ghost-danger"
                              onClick={() => setDeleteTarget(t)}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* =================================================================
          ABA 3: PLANOS & FATURAMENTO
         ================================================================= */}
      {activeTab === 'billing' && (
        <div>
          <div className="b2b-page-head">
            <div>
              <h1>Planos & Faturamento</h1>
              <p>Configure os pacotes comerciais oferecidos às academias e acompanhe o recebimento de mensalidades.</p>
            </div>
            <div className="b2b-head-actions">
              <Button variant="primary" icon="plus" onClick={() => openInvoiceModal()}>
                Registrar Fatura / Pagamento
              </Button>
            </div>
          </div>

          <div className="b2b-grid-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(235px, 100%), 1fr))' }}>
            {plans.map(plan => {
              const stat = planBreakdown.find(b => b.id === plan.id) || { count: 0, revenue: 0 };
              const feats = plan.features || {};
              return (
                <div
                  key={plan.id}
                  className="card"
                  style={{
                    margin: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    borderColor: plan.recommended ? 'var(--acc)' : undefined
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontWeight: 800, fontSize: 18 }}>Plano {plan.name}</span>
                      {plan.recommended && <StatusPill tone="ok" icon="star">Mais Assinado</StatusPill>}
                    </div>
                    <p className="muted small" style={{ margin: '0 0 14px', minHeight: 34 }}>{plan.tagline}</p>

                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 16 }}>
                      <span className="num" style={{ fontSize: 30, fontWeight: 800 }}>{fmtBRL(plan.priceMonthly)}</span>
                      <span className="muted small">/mês</span>
                    </div>

                    <div style={{ borderTop: 'var(--hair) solid var(--sep)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13.5 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Icon name="users" size={16} style={{ color: 'var(--acc-ink)' }} />
                        <span>{plan.maxStudents >= 100000 ? <>Alunos ativos <b>ilimitados</b></> : <>Até <b>{plan.maxStudents}</b> alunos ativos</>}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Icon name="personCircle" size={16} style={{ color: 'var(--acc-ink)' }} />
                        <span>{plan.maxTrainers >= 100000 ? <>Professores / staff <b>ilimitados</b></> : <>Até <b>{plan.maxTrainers}</b> {plan.maxTrainers === 1 ? 'profissional titular' : 'professores / staff'}</>}</span>
                      </div>
                      {[
                        ['whiteLabel', 'App Personalizado com Marca Própria'],
                        ['whatsappAlerts', 'Alertas Anti-Evasão via WhatsApp'],
                        ['customExercises', 'Catálogo 5.632 Exercícios + Modelos'],
                        ['aiCoach', 'Rit AI Coach Integrado'],
                        ['multiUnit', 'Operação Multi-Unidade / Franquias']
                      ].map(([k, lbl]) => (
                        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: feats[k] ? 1 : 0.45 }}>
                          <Icon name={feats[k] ? 'check' : 'xmark'} size={15} style={{ color: feats[k] ? 'var(--green)' : 'var(--label-3)' }} />
                          <span>{lbl}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ marginTop: 18, paddingTop: 14, borderTop: 'var(--hair) solid var(--sep)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div className="small muted">
                      <b style={{ color: 'var(--label)' }}>{stat.count}</b> acad. · <span className="num">{fmtBRL(stat.revenue)}</span>
                    </div>
                    <Button
                      variant="tinted"
                      size="sm"
                      icon="pencil"
                      onClick={() =>
                        setEditPlan({
                          ...plan,
                          features: { ...plan.features }
                        })
                      }
                    >
                      Editar Plano
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="card">
            <CardHead
              icon="creditCard"
              iconTint="var(--green)"
              title="Livro Razão de Faturas & Assinaturas"
              subtitle="Histórico recente de cobranças das academias clientes"
              action={
                <ChipBar
                  value={invStatusFilter}
                  onChange={setInvStatusFilter}
                  items={[
                    { value: 'all', label: 'Todas' },
                    { value: 'paid', label: 'Pagas' },
                    { value: 'pending', label: 'Pendentes' },
                    { value: 'overdue', label: 'Vencidas' }
                  ]}
                />
              }
            />

            {filteredInvoices.length === 0 ? (
              <EmptyState
                icon="creditCard"
                title="Nenhuma fatura neste filtro"
                message="Registre pagamentos manuais (PIX/Boleto/Cartão) para manter o controle financeiro da carteira."
              />
            ) : (
              <div className="b2b-table-wrap b2b-table-wrap-stack" style={{ border: 'none' }}>
                <table className="b2b-table b2b-table-stack">
                  <thead>
                    <tr>
                      <th>Competência</th>
                      <th>Academia Cliente</th>
                      <th>Valor</th>
                      <th>Método</th>
                      <th>Data Pagamento</th>
                      <th>Status</th>
                      <th style={{ textAlign: 'right' }}>Ação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredInvoices.map(inv => {
                      const st = INVOICE_LABELS[inv.status] || { label: inv.status, tone: 'muted' };
                      return (
                        <tr key={inv.id}>
                          <td data-label="Competência" className="num" style={{ fontWeight: 600 }}>{inv.refMonth || '—'}</td>
                          <td data-label="Academia">
                            <div>
                              <div style={{ fontWeight: 600 }}>{inv.tenantName}</div>
                              {inv.note && <div className="muted small">{inv.note}</div>}
                            </div>
                          </td>
                          <td data-label="Valor" className="num" style={{ fontWeight: 700 }}>{fmtBRL(inv.amount)}</td>
                          <td data-label="Método">{inv.method || 'PIX'}</td>
                          <td data-label="Pagamento" className="muted small">{inv.paidAt ? fmtDateBR(inv.paidAt) : 'Aguardando'}</td>
                          <td data-label="Status">
                            <StatusPill tone={st.tone}>{st.label}</StatusPill>
                          </td>
                          <td className="b2b-td-actions" style={{ textAlign: 'right' }}>
                            {inv.status !== 'paid' ? (
                              <Button
                                variant="tinted"
                                size="sm"
                                icon="check"
                                disabled={payingInvoiceId === inv.id}
                                onClick={() => handleMarkInvoicePaid(inv)}
                              >
                                {payingInvoiceId === inv.id ? 'Confirmando...' : 'Confirmar Pago'}
                              </Button>
                            ) : (
                              <span className="muted small">Liquidada</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =================================================================
          ABA 4: CONFIGURAÇÕES DA PLATAFORMA & AUDITORIA DE SEGURANÇA
         ================================================================= */}
      {activeTab === 'settings' && (
        <div>
          <div className="b2b-page-head">
            <div>
              <h1>Plataforma & Auditoria</h1>
              <p>Parâmetros globais da plataforma Rit e trilha de auditoria em tempo real das operações sensíveis.</p>
            </div>
            <div className="b2b-head-actions">
              <Button variant="ghost" icon="reset" onClick={loadAudit} disabled={auditLoading}>
                Atualizar Logs
              </Button>
            </div>
          </div>

          <div className="b2b-grid-2">
            <div style={{ minWidth: 0 }}>
              <form className="card" onSubmit={handleSavePlatform}>
                <CardHead
                  icon="gear"
                  iconTint="var(--acc)"
                  title="Identidade & Suporte da Plataforma"
                  subtitle="Exibido no cabeçalho de login e comunicações com gestores"
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <TextField
                    label="Nome Comercial da Plataforma"
                    value={platformForm.name}
                    onChange={v => setPlatformForm(p => ({ ...p, name: v }))}
                    placeholder="Ex: Rit"
                  />
                  <div className="b2b-form-grid">
                    <TextField
                      label="E-mail de Suporte"
                      type="email"
                      value={platformForm.supportEmail}
                      onChange={v => setPlatformForm(p => ({ ...p, supportEmail: v }))}
                    />
                    <TextField
                      label="WhatsApp Comercial / Suporte"
                      value={platformForm.supportPhone}
                      onChange={v => setPlatformForm(p => ({ ...p, supportPhone: v }))}
                    />
                  </div>
                  <NumberField
                    label="Dias Padrão de Trial para Novas Academias"
                    min={1}
                    max={90}
                    suffix="dias"
                    value={platformForm.trialDays}
                    onChange={v => setPlatformForm(p => ({ ...p, trialDays: v }))}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                    <Button type="submit" variant="primary" icon="check" disabled={savingPlatform}>
                      {savingPlatform ? 'Salvando...' : 'Salvar Parâmetros'}
                    </Button>
                  </div>
                </div>
              </form>

              {/* Card: Gateway WhatsApp Oficial da Rit */}
              <div className="card" style={{ marginTop: 16 }}>
                <CardHead
                  icon="chat"
                  iconTint="var(--green)"
                  title="Gateway WhatsApp Oficial da Rit"
                  subtitle="Canal central que dispara relatórios de treino concluído e notificações para todos os professores e academias clientes."
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div className="b2b-subcard" style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap'
                  }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span>Status do Robô:</span>
                        <StatusPill tone={centralWa?.connected ? 'ok' : 'bad'}>
                          {centralWa?.connected ? 'Conectado e Operante' : 'Desconectado'}
                        </StatusPill>
                      </div>
                      <div className="muted" style={{ marginTop: 4, fontSize: 14 }}>
                        {centralWa?.connected ? (
                          <>
                            Número Pareado: <b>{centralWa.instanceInfo?.phone || 'Conectado'}</b>
                            {centralWa.instanceInfo?.profileName ? ` (${centralWa.instanceInfo.profileName})` : ''} · Instância: <code>rit</code>
                          </>
                        ) : (
                          'Aponte a câmera do WhatsApp oficial da Rit para iniciar os envios automatizados da plataforma.'
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 8 }}>
                      {!centralWa?.connected ? (
                        <Button
                          variant="primary"
                          icon="chat"
                          size="sm"
                          onClick={handleOpenQrModal}
                          loading={loadingQr}
                        >
                          {loadingQr ? 'Carregando...' : 'Conectar WhatsApp (QR Code)'}
                        </Button>
                      ) : (
                        <Button
                          variant="danger"
                          size="sm"
                          icon="trash"
                          onClick={() => setConfirmDisconnectWa(true)}
                          loading={disconnectingWa}
                        >
                          {disconnectingWa ? 'Desconectando...' : 'Desconectar WhatsApp'}
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Teste de Envio */}
                  <div style={{ borderTop: '1px solid var(--sep)', paddingTop: 12 }}>
                    <div className="muted" style={{ marginBottom: 6, fontWeight: 600, fontSize: 14 }}>
                      Disparo de Mensagem de Teste pelo Robô Central:
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                        <TextField
                          placeholder="Número com DDD (ex: 5591985594558)"
                          value={testPhoneInput}
                          onChange={setTestPhoneInput}
                        />
                      </div>
                      <Button
                        variant="tinted"
                        icon="chat"
                        size="sm"
                        disabled={!testPhoneInput.trim()}
                        loading={testingWa}
                        onClick={handleTestCentralWa}
                      >
                        {testingWa ? 'Enviando...' : 'Enviar Teste'}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Card: Gateway Mercado Pago Oficial */}
              <div className="card" style={{ marginTop: 16 }}>
                <CardHead
                  icon="creditCard"
                  iconTint="var(--acc)"
                  title="Gateway Mercado Pago (PIX Oficial)"
                  subtitle="Conta que recebe os pagamentos de assinaturas das academias e personais via PIX instantâneo."
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div className="b2b-subcard" style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap'
                  }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span>Status da Integração:</span>
                        <StatusPill tone={mpStatus?.configured ? 'ok' : 'warn'}>
                          {mpStatus?.configured ? 'Conectado em Produção' : 'Modo Simulação Ativo (Aguardando Token no .env)'}
                        </StatusPill>
                      </div>
                      <div className="muted" style={{ marginTop: 4, fontSize: 14 }}>
                        {mpStatus?.configured ? (
                          <>Credencial Ativa: <code>{mpStatus.maskedToken}</code> · Os valores caem diretamente no seu Mercado Pago</>
                        ) : (
                          <>Para vincular sua conta real, configure o <code>MERCADO_PAGO_ACCESS_TOKEN</code> no arquivo <code>.env</code></>
                        )}
                      </div>
                    </div>
                  </div>

                  <div style={{ borderTop: '1px solid var(--sep)', paddingTop: 12, fontSize: 14, lineHeight: 1.6, color: 'var(--label-2)' }}>
                    <div><strong>URL do Webhook para Notificações:</strong></div>
                    <code style={{
                      display: 'inline-block',
                      maxWidth: '100%',
                      overflowWrap: 'anywhere',
                      wordBreak: 'break-all',
                      marginTop: 4,
                      padding: '4px 8px',
                      background: 'var(--surface-2)',
                      borderRadius: 6,
                      color: 'var(--label)'
                    }}>
                      {mpStatus?.webhookUrl || (typeof window !== 'undefined' ? `${window.location.origin}/api/saas/billing/webhook` : '/api/saas/billing/webhook')}
                    </code>
                  </div>
                </div>
              </div>

              <Section title="Arquitetura & Segurança de Dados">
                <Row
                  icon="personCircle"
                  iconTint="var(--acc)"
                  title="Desenvolvedor & Autor do Sistema"
                  subtitle="Ecossistema Rit (Academias, Studios e Personal Trainers)"
                  value="Nicolas Oliveira"
                />
                <Row
                  icon="shield"
                  iconTint="var(--green)"
                  title="Isolamento Estrito por Unidade"
                  subtitle="Dados de gestores, alunos, convites e identidade particionados por unidade"
                  value="Ativo"
                />
                <Row
                  icon="lock"
                  iconTint="var(--indigo)"
                  title="Criptografia de Credenciais"
                  subtitle="Senhas protegidas com Node crypto.scrypt + salt aleatório"
                  value="scrypt"
                />
                <Row
                  icon="cloud"
                  iconTint="var(--teal)"
                  title="Sincronização Offline-First com App do Aluno"
                  subtitle="Fichas prescritas usam sync-stamps LWW sem conflito no celular"
                  value="Tempo Real"
                />
              </Section>
            </div>

            <div className="card" style={{ margin: 0 }}>
              <CardHead
                icon="shield"
                iconTint="var(--orange)"
                title="Trilha de Auditoria Global"
                subtitle="Últimos eventos administrativos, logins e prescrições"
              />
              <div style={{ marginBottom: 12 }}>
                <SearchField
                  value={auditQuery}
                  onChange={setAuditQuery}
                  placeholder="Filtrar evento (ex: saas.login, gym.prescribe, tenant)..."
                />
              </div>

              {auditLoading ? (
                <div className="muted small" style={{ padding: 24, textAlign: 'center' }}>Carregando eventos...</div>
              ) : filteredAudit.length === 0 ? (
                <EmptyState
                  icon="clipboard"
                  title="Sem eventos registrados"
                  message="As ações executadas nos painéis aparecerão automaticamente aqui."
                />
              ) : (
                <div style={{ maxHeight: 460, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {filteredAudit.map((ev, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: '10px 12px',
                        borderRadius: 'var(--r)',
                        background: 'var(--bg-el)',
                        border: 'var(--hair) solid var(--sep)',
                        fontSize: 13
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                        <code style={{ fontWeight: 700, overflowWrap: 'anywhere', color: ev.ok === false ? 'var(--red)' : 'var(--acc-ink)' }}>
                          {ev.ev || ev.event || 'evento'}
                        </code>
                        <span className="muted small num">
                          {ev.ts ? new Date(ev.ts).toLocaleString('pt-BR') : ''}
                        </span>
                      </div>
                      <div className="muted small" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>
                        {ev.actorName || ev.user || 'Sistema'}
                        {ev.targetName ? ` → ${ev.targetName}` : ''}
                        {ev.msg ? ` · ${ev.msg}` : ''}
                        {ev.ip ? ` (${ev.ip})` : ''}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* =================================================================
          MODAIS DO PAINEL DO DONO DO SISTEMA
         ================================================================= */}

      {/* Modal 1: Novo Cliente (Academia ou Personal Trainer) */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        size="lg"
        title="Provisionar Academia ou Personal Trainer"
        subtitle="Cria o ambiente isolado, aplica a identidade do aplicativo, gera fichas-modelo e libera o login do responsável."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancelar</Button>
            <Button variant="primary" icon="check" onClick={handleCreateTenant} disabled={creating}>
              {creating ? 'Provisionando...' : 'Criar Conta & Liberar Painel'}
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreateTenant} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SelectField
            label="Tipo de Cliente"
            value={newForm.accountType || 'gym'}
            onChange={v => {
              setNewForm(p => ({
                ...p,
                accountType: v,
                planId: v === 'personal' ? 'personal' : (String(p.planId || '').startsWith('personal') ? 'pro' : p.planId),
                slogan: v === 'personal' ? 'Consultoria individual e periodização sob medida' : 'Seu treino na palma da mão'
              }));
            }}
            options={[
              { value: 'gym', label: 'Academia / Studio / Box Cross' },
              { value: 'personal', label: 'Personal Trainer Independente (Consultoria Online & Presencial)' }
            ]}
          />

          <div className="b2b-form-grid">
            <TextField
              label={newForm.accountType === 'personal' ? 'Nome Profissional / Marca do Personal' : 'Nome Fantasia da Academia'}
              required
              placeholder={newForm.accountType === 'personal' ? 'Ex: Thiago Mendes Personal' : 'Ex: Iron Power Matriz'}
              value={newForm.name}
              onChange={v => {
                setNewForm(p => ({
                  ...p,
                  name: v,
                  id: slugEdited ? p.id : slugifyName(v)
                }));
              }}
            />
            <TextField
              label="Slug / Identificador Único"
              required
              placeholder={newForm.accountType === 'personal' ? 'ex: thiagopersonal' : 'ex: ironpower'}
              hint={`URL do App do Aluno: ?tenant=${newForm.id || 'slug'}`}
              value={newForm.id}
              onChange={v => {
                setSlugEdited(true);
                setNewForm(p => ({ ...p, id: slugifyName(v) }));
              }}
            />
          </div>

          <div className="b2b-form-grid">
            <SelectField
              label="Plano Contratado"
              value={newForm.planId}
              onChange={v => setNewForm(p => ({ ...p, planId: v, accountType: v.startsWith('personal') ? 'personal' : (p.accountType === 'personal' ? 'gym' : p.accountType) }))}
              options={plans.map(pl => ({
                value: pl.id,
                label: `${pl.name} — ${fmtBRL(pl.priceMonthly)}/mês (${pl.maxStudents >= 100000 ? 'alunos ilimitados' : `até ${pl.maxStudents} alunos`})`
              }))}
            />
            <SelectField
              label="Status Inicial da Assinatura"
              value={newForm.status}
              onChange={v => setNewForm(p => ({ ...p, status: v }))}
              options={[
                { value: 'active', label: 'Ativa (Faturamento liberado)' },
                { value: 'trial', label: `Período de Testes (${platformForm.trialDays} dias grátis)` }
              ]}
            />
          </div>

          <div className="b2b-form-grid">
            <TextField
              label={newForm.accountType === 'personal' ? 'CPF / CREF do Personal' : 'CNPJ / Documento'}
              placeholder={newForm.accountType === 'personal' ? 'CPF ou CREF 000000-G/UF' : '00.000.000/0001-00'}
              value={newForm.document}
              onChange={v => setNewForm(p => ({ ...p, document: v }))}
            />
            <TextField
              label="Cidade / UF"
              placeholder="Ex: São Paulo - SP"
              value={newForm.city}
              onChange={v => setNewForm(p => ({ ...p, city: v }))}
            />
          </div>

          <div style={{ borderTop: 'var(--hair) solid var(--sep)', paddingTop: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>
              {newForm.accountType === 'personal' ? 'Credenciais do Personal Trainer Titular' : 'Credenciais do Proprietário / Gestor da Academia'}
            </div>
            <div className="b2b-form-grid">
              <TextField
                label={newForm.accountType === 'personal' ? 'Nome do Personal Trainer' : 'Nome do Gestor'}
                required
                placeholder="Ex: Carlos Eduardo"
                value={newForm.ownerName}
                onChange={v => setNewForm(p => ({ ...p, ownerName: v }))}
              />
              <TextField
                label="WhatsApp de Contato"
                placeholder="(11) 99999-0000"
                value={newForm.phone}
                onChange={v => setNewForm(p => ({ ...p, phone: v }))}
              />
              <TextField
                label="E-mail de Login"
                type="email"
                required
                placeholder={newForm.accountType === 'personal' ? 'contato@personal.com.br' : 'gestor@academia.com.br'}
                value={newForm.ownerEmail}
                onChange={v => setNewForm(p => ({ ...p, ownerEmail: v }))}
              />
              <TextField
                label="Senha Inicial"
                placeholder="Mínimo de 10 caracteres"
                required
                value={newForm.ownerPassword}
                onChange={v => setNewForm(p => ({ ...p, ownerPassword: v }))}
              />
            </div>
          </div>

          <div style={{ borderTop: 'var(--hair) solid var(--sep)', paddingTop: 14 }}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>Cor Principal do Aplicativo</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {BRAND_SWATCHES.map(hex => (
                <button
                  type="button"
                  key={hex}
                  aria-label={`Selecionar cor ${hex}`}
                  aria-pressed={newForm.primaryColor === hex}
                  onClick={() => setNewForm(p => ({ ...p, primaryColor: hex }))}
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: '50%',
                    background: hex,
                    border: newForm.primaryColor === hex ? '3px solid var(--label)' : '2px solid transparent',
                    cursor: 'pointer'
                  }}
                />
              ))}
              <input
                type="color"
                aria-label="Cor personalizada do aplicativo"
                value={newForm.primaryColor}
                onChange={e => setNewForm(p => ({ ...p, primaryColor: e.target.value }))}
                style={{ width: 36, height: 32, border: 'none', background: 'transparent', cursor: 'pointer' }}
              />
            </div>
          </div>
        </form>
      </Modal>

      {/* Modal 2: Editar Academia / Personal */}
      <Modal
        open={Boolean(editTenant)}
        onClose={() => setEditTenant(null)}
        size="lg"
        title={`Editar Cliente — ${editTenant?.name || ''}`}
        subtitle={`Identificador: ${editTenant?.id || ''}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditTenant(null)}>Cancelar</Button>
            <Button variant="primary" icon="check" onClick={handleUpdateTenant} disabled={savingTenant}>
              {savingTenant ? 'Salvando...' : 'Salvar Alterações'}
            </Button>
          </>
        }
      >
        {editTenant && (
          <form onSubmit={handleUpdateTenant} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="b2b-form-grid">
              <TextField
                label="Nome Comercial / Marca"
                value={editTenant.name}
                onChange={v => setEditTenant(p => ({ ...p, name: v }))}
              />
              <SelectField
                label="Tipo de Conta"
                value={editTenant.accountType || (String(editTenant.planId || '').startsWith('personal') ? 'personal' : 'gym')}
                onChange={v => setEditTenant(p => ({ ...p, accountType: v }))}
                options={[
                  { value: 'gym', label: 'Academia / Studio' },
                  { value: 'personal', label: 'Personal Trainer Independente' }
                ]}
              />
              <SelectField
                label="Status de Acesso"
                value={editTenant.status}
                onChange={v => setEditTenant(p => ({ ...p, status: v }))}
                options={[
                  { value: 'active', label: 'Ativa' },
                  { value: 'trial', label: 'Em Trial' },
                  { value: 'past_due', label: 'Inadimplente (Aviso)' },
                  { value: 'suspended', label: 'Suspensa (Bloqueia Logins)' }
                ]}
              />
              <SelectField
                label="Plano Contratado"
                value={editTenant.planId}
                onChange={v => {
                  const chosen = plans.find(pl => pl.id === v);
                  setEditTenant(p => ({
                    ...p,
                    planId: v,
                    mrr: chosen ? chosen.priceMonthly : p.mrr
                  }));
                }}
                options={plans.map(pl => ({ value: pl.id, label: `${pl.name} (${fmtBRL(pl.priceMonthly)})` }))}
              />
              <NumberField
                label="Mensalidade Negociada (MRR)"
                min={0}
                step={1}
                suffix="R$"
                value={editTenant.mrr}
                onChange={v => setEditTenant(p => ({ ...p, mrr: v }))}
              />
              <TextField
                label="Gestor Responsável"
                value={editTenant.ownerName || ''}
                onChange={v => setEditTenant(p => ({ ...p, ownerName: v }))}
              />
              <TextField
                label="E-mail do Gestor"
                value={editTenant.ownerEmail || ''}
                onChange={v => setEditTenant(p => ({ ...p, ownerEmail: v }))}
              />
              <TextField
                label="CNPJ / Documento"
                value={editTenant.document || ''}
                onChange={v => setEditTenant(p => ({ ...p, document: v }))}
              />
              <TextField
                label="Cidade / UF"
                value={editTenant.city || ''}
                onChange={v => setEditTenant(p => ({ ...p, city: v }))}
              />
            </div>

            <TextArea
              label="Observações Internas do Contrato"
              rows={2}
              value={editTenant.notes || ''}
              onChange={v => setEditTenant(p => ({ ...p, notes: v }))}
              placeholder="Condições comerciais negociadas, data de renovação, etc."
            />
          </form>
        )}
      </Modal>

      {/* Modal 3: Redefinir Senha do Gestor */}
      <Modal
        open={Boolean(pwModalTenant)}
        onClose={() => setPwModalTenant(null)}
        size="sm"
        title="Redefinir Senha do Gestor"
        subtitle={pwModalTenant ? `${pwModalTenant.name} (${pwModalTenant.ownerEmail || pwModalTenant.id})` : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPwModalTenant(null)}>Cancelar</Button>
            <Button variant="primary" icon="key" onClick={handleResetOwnerPassword} disabled={savingPw}>
              {savingPw ? 'Salvando...' : 'Atualizar Senha'}
            </Button>
          </>
        }
      >
        <form onSubmit={handleResetOwnerPassword}>
          <TextField
            label="Nova Senha de Acesso ao Painel da Academia"
            type="password"
            placeholder="Mínimo de 10 caracteres"
            value={newOwnerPw}
            onChange={setNewOwnerPw}
            autoComplete="new-password"
            autoFocus
          />
        </form>
      </Modal>

      {/* Modal 4: Excluir Academia */}
      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        size="sm"
        title="Excluir Academia Cliente?"
        subtitle="Esta ação remove permanentemente a unidade, contas vinculadas e configurações de marca."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancelar</Button>
            <Button variant="danger" icon="trash" onClick={handleDeleteTenant} disabled={deleting}>
              {deleting ? 'Excluindo...' : 'Confirmar Exclusão'}
            </Button>
          </>
        }
      >
        {deleteTarget && (
          <p style={{ margin: 0, lineHeight: 1.5 }}>
            Confirma a exclusão definitiva da unidade <b>{deleteTarget.name}</b> (<code>{deleteTarget.id}</code>) com{' '}
            <b>{deleteTarget.studentCount}</b> alunos cadastrados?
          </p>
        )}
      </Modal>

      {/* Modal 5: Editar Plano SaaS */}
      <Modal
        open={Boolean(editPlan)}
        onClose={() => setEditPlan(null)}
        size="md"
        title={editPlan ? `Configurar Plano ${editPlan.name}` : ''}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditPlan(null)}>Cancelar</Button>
            <Button variant="primary" icon="check" onClick={handleSavePlan} disabled={savingPlan}>
              {savingPlan ? 'Salvando...' : 'Salvar Plano'}
            </Button>
          </>
        }
      >
        {editPlan && (
          <form onSubmit={handleSavePlan} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="b2b-form-grid">
              <TextField
                label="Nome do Plano"
                value={editPlan.name}
                onChange={v => setEditPlan(p => ({ ...p, name: v }))}
              />
              <NumberField
                label="Valor Mensal (R$)"
                min={0}
                value={editPlan.priceMonthly}
                onChange={v => setEditPlan(p => ({ ...p, priceMonthly: v }))}
              />
              <NumberField
                label="Limite de Alunos Ativos"
                min={1}
                value={editPlan.maxStudents}
                onChange={v => setEditPlan(p => ({ ...p, maxStudents: v }))}
              />
              <NumberField
                label="Limite de Professores / Equipe"
                min={1}
                value={editPlan.maxTrainers}
                onChange={v => setEditPlan(p => ({ ...p, maxTrainers: v }))}
              />
            </div>

            <TextField
              label="Descrição Curta"
              value={editPlan.tagline || ''}
              onChange={v => setEditPlan(p => ({ ...p, tagline: v }))}
            />

            <Section title="Recursos Inclusos no Plano">
              {[
                ['whiteLabel', 'App Personalizado com Marca e Cores da Academia'],
                ['whatsappAlerts', 'Central Anti-Evasão com Alerta WhatsApp'],
                ['customExercises', 'Catálogo 5.632 Exercícios & Biblioteca de Modelos'],
                ['aiCoach', 'Rit AI Coach para Alunos'],
                ['multiUnit', 'Suporte a Múltiplas Unidades / Rede']
              ].map(([key, label]) => (
                <Row key={key} title={label}>
                  <Switch
                    checked={Boolean(editPlan.features?.[key])}
                    label={label}
                    onChange={val =>
                      setEditPlan(p => ({
                        ...p,
                        features: { ...(p.features || {}), [key]: val }
                      }))
                    }
                  />
                </Row>
              ))}
            </Section>
          </form>
        )}
      </Modal>

      {/* Modal 6: Registrar Fatura / Pagamento */}
      <Modal
        open={invModalOpen}
        onClose={() => setInvModalOpen(false)}
        size="md"
        title="Registrar Fatura / Mensalidade"
        footer={
          <>
            <Button variant="ghost" onClick={() => setInvModalOpen(false)}>Cancelar</Button>
            <Button variant="primary" icon="check" onClick={handleRecordInvoice} disabled={savingInv}>
              {savingInv ? 'Registrando...' : 'Salvar Fatura'}
            </Button>
          </>
        }
      >
        <form onSubmit={handleRecordInvoice} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <SelectField
            label="Academia Cliente"
            value={invForm.tenantId}
            onChange={v => {
              const found = tenants.find(x => x.id === v);
              setInvForm(p => ({
                ...p,
                tenantId: v,
                amount: found ? found.mrr : p.amount
              }));
            }}
            options={[
              { value: '', label: '— Selecione a academia —' },
              ...tenants.map(t => ({ value: t.id, label: `${t.name} (${fmtBRL(t.mrr)}/mês)` }))
            ]}
          />
          <div className="b2b-form-grid">
            <TextField
              label="Mês de Referência (AAAA-MM)"
              value={invForm.refMonth}
              onChange={v => setInvForm(p => ({ ...p, refMonth: v }))}
              placeholder="2026-11"
            />
            <NumberField
              label="Valor Cobrado (R$)"
              min={0}
              value={invForm.amount}
              onChange={v => setInvForm(p => ({ ...p, amount: v }))}
            />
            <SelectField
              label="Método de Pagamento"
              value={invForm.method}
              onChange={v => setInvForm(p => ({ ...p, method: v }))}
              options={[
                { value: 'PIX', label: 'PIX Empresarial' },
                { value: 'Cartão de Crédito', label: 'Cartão de Crédito Recorrente' },
                { value: 'Boleto Bancário', label: 'Boleto Bancário' },
                { value: 'Transferência', label: 'TED / Transferência' }
              ]}
            />
            <SelectField
              label="Situação"
              value={invForm.status}
              onChange={v => setInvForm(p => ({ ...p, status: v }))}
              options={[
                { value: 'paid', label: 'Pago / Liquidado' },
                { value: 'pending', label: 'Pendente (A vencer)' },
                { value: 'overdue', label: 'Em Atraso (Vencida)' }
              ]}
            />
          </div>
          <TextField
            label="Observação / Comprovante (Opcional)"
            value={invForm.note}
            onChange={v => setInvForm(p => ({ ...p, note: v }))}
            placeholder="Ex: NF-e #1042 emitida"
          />
        </form>
      </Modal>

      <ConfirmModal
        open={Boolean(suspendTarget)}
        onClose={() => !suspending && setSuspendTarget(null)}
        title={suspendTarget ? `Suspender "${suspendTarget.name}"` : 'Suspender Academia'}
        message={
          suspendTarget
            ? `Tem certeza que deseja suspender o acesso operacional de "${suspendTarget.name}"? Os alunos continuarão vendo os treinos já sincronizados, mas novas sincronizações e o painel de gestão da unidade ficarão bloqueados até a reativação.`
            : ''
        }
        confirmLabel="Suspender Acesso"
        confirmVariant="danger"
        loading={suspending}
        onConfirm={async () => {
          if (!suspendTarget) return;
          await runSingleFlight(`confirm-suspend:${suspendTarget.id}`, setSuspending, true, async () => {
            await handleToggleStatus(suspendTarget, true);
            setSuspendTarget(null);
          });
        }}
      />

      {/* Modal: Conectar WhatsApp Oficial da Rit via QR Code */}
      <Modal
        open={qrModalOpen}
        onClose={() => setQrModalOpen(false)}
        title="Conectar WhatsApp Oficial da Rit"
        subtitle="Aponte a câmera do WhatsApp para parear o Robô Central"
        size="sm"
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 14, padding: '10px 0' }}>
          {loadingQr && !qrBase64 ? (
            <div style={{ padding: '60px 0' }} className="muted">Gerando QR Code de conexão...</div>
          ) : qrBase64 ? (
            <>
              <div style={{ padding: 12, background: '#fff', borderRadius: 14, boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}>
                <img
                  src={qrBase64}
                  alt="QR Code WhatsApp"
                  style={{ width: 'min(240px, 100%)', height: 'auto', aspectRatio: '1 / 1', display: 'block', borderRadius: 8 }}
                />
              </div>
              <div style={{ fontSize: 14, color: 'var(--label-2)', maxWidth: 320, lineHeight: 1.5 }}>
                1. Abra o <b>WhatsApp</b> no celular do Rit.<br />
                2. Vá em <b>Aparelhos Conectados</b>.<br />
                3. Toque em <b>Conectar um aparelho</b> e aponte para o código acima.<br />
                <span>O código é renovado automaticamente a cada ~20s.</span>
              </div>
            </>
          ) : (
            <div style={{ padding: '30px 0' }}>
              <div className="muted" style={{ marginBottom: 12 }}>Aguardando inicialização do gateway...</div>
              <Button size="sm" variant="tinted" onClick={handleOpenQrModal} loading={loadingQr}>
                {loadingQr ? 'Gerando...' : 'Tentar Novamente'}
              </Button>
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: 4 }}>
            {qrBase64 && (
              <Button variant="tinted" size="sm" onClick={handleOpenQrModal} loading={loadingQr}>
                {loadingQr ? 'Atualizando...' : 'Atualizar QR'}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setQrModalOpen(false)}>Fechar</Button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={confirmDisconnectWa}
        onClose={() => !disconnectingWa && setConfirmDisconnectWa(false)}
        title="Desconectar WhatsApp Oficial?"
        message="Os envios automáticos de treinos concluídos e notificações da plataforma serão pausados até um novo pareamento por QR Code."
        confirmLabel="Desconectar WhatsApp"
        confirmVariant="danger"
        confirmIcon="trash"
        loading={disconnectingWa}
        onConfirm={handleDisconnectWa}
      />

      {/* Modal: Enviar WhatsApp Oficial pelo Super Admin */}
      <Modal
        open={Boolean(adminWaModal)}
        onClose={() => !sendingAdminWa && setAdminWaModal(null)}
        title={adminWaModal ? `WhatsApp — ${adminWaModal.targetName}` : 'Enviar WhatsApp'}
        subtitle="Disparo oficial via Gateway Central da Rit"
        size="md"
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', width: '100%', gap: 8 }}>
            <Button variant="ghost" onClick={() => setAdminWaModal(null)} disabled={sendingAdminWa}>
              Cancelar
            </Button>
            <Button
              variant="success"
              icon="chat"
              loading={sendingAdminWa}
              onClick={handleSendAdminWhatsApp}
              disabled={!adminWaModal?.phone?.trim() || !adminWaModal?.message?.trim()}
            >
              {sendingAdminWa ? 'Disparando...' : 'Enviar Agora via WhatsApp'}
            </Button>
          </div>
        }
      >
        {adminWaModal && (
          <form onSubmit={handleSendAdminWhatsApp} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <TextField
              label="Telefone com DDD"
              value={adminWaModal.phone}
              onChange={v => setAdminWaModal(p => ({ ...p, phone: v }))}
              placeholder="ex: 91985594558 ou 11999998888"
              required
            />
            <TextArea
              label="Mensagem"
              rows={5}
              value={adminWaModal.message}
              onChange={v => setAdminWaModal(p => ({ ...p, message: v }))}
              placeholder="Digite a mensagem para o cliente..."
              required
            />
            <div style={{ fontSize: 14, color: 'var(--label-2)' }}>
              A mensagem será entregue pelo Robô Central da Rit diretamente na conversa do cliente.
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
