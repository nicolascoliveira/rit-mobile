import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../components/Icon.jsx';
import {
  Button,
  Section,
  Row,
  Segmented,
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
  ConfirmModal
} from '../components/ui.jsx';
import { LineChart, BarRow } from '../components/Charts.jsx';
import QrCodeBox from '../components/QrCodeBox.jsx';
import WorkoutBuilderModal from '../components/WorkoutBuilderModal.jsx';
import { exportStudentDossierPdf, shareStudentDossierPdf } from '../lib/dossier-pdf.js';
import {
  portalApi,
  toast,
  fmtDateBR,
  getStudentAppUrl,
  applyPortalAccent,
  inkOn,
  generateTempPassword,
  getOrRotateIntentKey
} from '../lib/api.js';

const WEEKDAY_MAP = [
  { d: 1, short: 'Seg', full: 'Segunda' },
  { d: 2, short: 'Ter', full: 'Terça' },
  { d: 3, short: 'Qua', full: 'Quarta' },
  { d: 4, short: 'Qui', full: 'Quinta' },
  { d: 5, short: 'Sex', full: 'Sexta' },
  { d: 6, short: 'Sáb', full: 'Sábado' },
  { d: 0, short: 'Dom', full: 'Domingo' }
];

const BRAND_SWATCHES = [
  '#D0FF00',
  '#a3e635',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#06b6d4',
  '#3b82f6',
  '#6366f1',
  '#a855f7',
  '#ec4899'
];

const CHURN_BADGES = {
  healthy: { label: 'Frequência em Dia', tone: 'ok' },
  new: { label: 'Novo Aluno', tone: 'ok' },
  warning: { label: 'Atenção', tone: 'warn' },
  critical: { label: 'Risco de Evasão', tone: 'bad' },
  disabled: { label: 'Matrícula Inativa', tone: 'muted' }
};

const ROLE_LABELS = {
  gym_owner: 'Proprietário',
  gym_manager: 'Coordenador',
  trainer: 'Professor'
};

export default function GymPanel({
  activeTab = 'dashboard',
  onChangeTab,
  user,
  tenantSlug,
  onTenantUpdated,
  onStatsLoaded,
  demoAllowed = false,
  billingLocked = false
}) {
  const isManager =
    user?.saasRole === 'superadmin' ||
    user?.saasRole === 'gym_owner' ||
    user?.saasRole === 'gym_manager' ||
    user?.isAdmin;

  const [overview, setOverview] = useState(null);
  const [students, setStudents] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [team, setTeam] = useState([]);
  const [maxTrainers, setMaxTrainers] = useState(10);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);

  // Filtros de Alunos
  const [studentQuery, setStudentQuery] = useState('');
  const [studentFilter, setStudentFilter] = useState('all');

  // Filtro de Templates
  const [tplCategory, setTplCategory] = useState('all');

  // Estúdio de Prescrição / Modelos (WorkoutBuilderModal)
  const [builderState, setBuilderState] = useState({
    open: false,
    mode: 'prescribe',
    student: null,
    initialRoutine: null,
    initialDays: [1, 4]
  });
  const [returnToDossierStudentId, setReturnToDossierStudentId] = useState(null);

  // Modal: Aplicar Modelo Rápido para um Aluno
  const [applyTplModal, setApplyTplModal] = useState(null);
  const [applyStudentId, setApplyStudentId] = useState('');
  const [applyDays, setApplyDays] = useState([1, 3, 5]);
  const [applyingTpl, setApplyingTpl] = useState(false);

  // Modal: Matricular Novo Aluno
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollForm, setEnrollForm] = useState({
    name: '',
    email: '',
    phone: '',
    goal: 'Hipertrofia & Força',
    assignedTrainerId: '',
    password: generateTempPassword(),
    initialTemplateId: '',
    notes: ''
  });
  const [enrolling, setEnrolling] = useState(false);

  // Modal: Editar Aluno Cadastrado
  const [editingStudent, setEditingStudent] = useState(null);
  const [editStudentForm, setEditStudentForm] = useState({
    id: '',
    name: '',
    email: '',
    phone: '',
    goal: '',
    assignedTrainerId: '',
    notes: ''
  });
  const [savingEditStudent, setSavingEditStudent] = useState(false);

  // Modal: Envio Direto de WhatsApp via API
  const [waSendModal, setWaSendModal] = useState(null);
  const [sendingWaMsg, setSendingWaMsg] = useState(false);

  // Modal: Prontuário Completo do Aluno
  const [dossierOpen, setDossierOpen] = useState(false);
  const [dossierTab, setDossierTab] = useState('routines');
  const [dossierLoading, setDossierLoading] = useState(false);
  const [dossierData, setDossierData] = useState(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [studentPwInput, setStudentPwInput] = useState('');
  const [resetCodeGenerated, setResetCodeGenerated] = useState('');
  const [savingStudentProfile, setSavingStudentProfile] = useState(false);
  const [expandedWorkoutIdx, setExpandedWorkoutIdx] = useState(null);

  // Modal de Confirmação Unificado
  const [confirmState, setConfirmState] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  // Modal: Novo / Editar Profissional da Equipe
  const [memberModal, setMemberModal] = useState(null);
  const [savingMember, setSavingMember] = useState(false);

  // Convites
  const [inviteNote, setInviteNote] = useState('');
  const [creatingInvite, setCreatingInvite] = useState(false);

  // Branding Form
  const [brandForm, setBrandForm] = useState({
    gymName: '',
    slogan: '',
    primaryColor: '#D0FF00',
    logoUrl: '',
    contactPhone: '',
    address: '',
    instagram: '',
    seasonalTheme: 'auto',
    churnDaysThreshold: 5,
    notifyTrainerOnWorkout: true,
    notifyStudentOnPrescribe: true
  });
  const [savingBrand, setSavingBrand] = useState(false);
  const [testingWa, setTestingWa] = useState(false);
  const [waStatus, setWaStatus] = useState(null);
  const [showAdvancedWa, setShowAdvancedWa] = useState(false);
  const [sendingChurnBatch, setSendingChurnBatch] = useState(false);
  const [retryingOutbox, setRetryingOutbox] = useState(false);

  // Minha Assinatura & Cobrança PIX (Mercado Pago)
  const [billingData, setBillingData] = useState(null);
  const [loadingBilling, setLoadingBilling] = useState(false);
  const [pixModalOpen, setPixModalOpen] = useState(false);
  const [checkoutPlanId, setCheckoutPlanId] = useState('');
  const [checkoutCycle, setCheckoutCycle] = useState('annual');
  const [generatingPix, setGeneratingPix] = useState(false);
  const [activePix, setActivePix] = useState(null);
  const [simulatingPix, setSimulatingPix] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [importingDefaults, setImportingDefaults] = useState(false);
  const [settingStudentPw, setSettingStudentPw] = useState(false);
  const [generatingResetCode, setGeneratingResetCode] = useState(false);
  const [togglingStudentStatus, setTogglingStudentStatus] = useState(false);

  const callbacksRef = useRef({ onTenantUpdated, onStatsLoaded });
  callbacksRef.current = { onTenantUpdated, onStatsLoaded };
  const mountedRef = useRef(true);
  const reqSeqRef = useRef(0);
  const inFlightActionRef = useRef(new Set());
  const checkoutIdemRef = useRef(null);
  const simulateIdemRef = useRef(null);

  const runSingleFlight = async (key, setBusy, fn) => {
    if (inFlightActionRef.current.has(key)) return;
    inFlightActionRef.current.add(key);
    setBusy?.(true);
    try {
      return await fn();
    } finally {
      inFlightActionRef.current.delete(key);
      if (mountedRef.current) setBusy?.(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadAllGymData = useCallback(async (silent = false) => {
    if (billingLocked && !silent) {
      setLoading(false);
      return;
    }
    const seq = ++reqSeqRef.current;
    if (!silent) setLoading(true);
    try {
      const reqOpts = tenantSlug ? { tenantId: tenantSlug } : {};
      const [ovRes, stRes, tplRes, tmRes, invRes] = await Promise.all([
        portalApi('/api/gym/overview', reqOpts),
        portalApi('/api/gym/students', reqOpts),
        portalApi('/api/gym/templates', reqOpts),
        portalApi('/api/gym/team', reqOpts),
        portalApi('/api/gym/invites', reqOpts)
      ]);

      if (!mountedRef.current || seq !== reqSeqRef.current) return;

      setOverview(ovRes);
      setStudents(stRes.students || []);
      setTemplates(tplRes.templates || []);
      setTeam(tmRes.team || []);
      setMaxTrainers(tmRes.maxTrainers || ovRes.tenant?.limits?.maxTrainers || 10);
      setInvites(invRes.invites || []);

      if (ovRes.tenant) {
        const b = ovRes.tenant.branding || {};
        const s = ovRes.tenant.settings || {};
        setBrandForm({
          gymName: b.gymName || ovRes.tenant.name || '',
          slogan: b.slogan || '',
          primaryColor: b.primaryColor || '#D0FF00',
          logoUrl: b.logoUrl || '',
          contactPhone: b.contactPhone || '',
          address: b.address || '',
          instagram: b.instagram || '',
          seasonalTheme: b.seasonalTheme || 'auto',
          churnDaysThreshold: Number(s.churnDaysThreshold || 5),
          notifyTrainerOnWorkout: s.notifyTrainerOnWorkout !== false,
          notifyStudentOnPrescribe: s.notifyStudentOnPrescribe !== false
        });
        callbacksRef.current.onTenantUpdated?.(ovRes.tenant);
      }
      callbacksRef.current.onStatsLoaded?.(ovRes.kpis || {});

      // Checa status da conexão WhatsApp de forma transparente em background
      portalApi('/api/gym/whatsapp/status', reqOpts)
        .then(wa => {
          if (mountedRef.current && seq === reqSeqRef.current) setWaStatus(wa);
        })
        .catch(() => {});
    } catch (err) {
      if (mountedRef.current && seq === reqSeqRef.current) {
        if (err?.data?.billingRequired) {
          onChangeTab?.('billing');
        }
        toast(err.message || 'Erro ao carregar dados da academia');
      }
    } finally {
      if (!silent && mountedRef.current && seq === reqSeqRef.current) {
        setLoading(false);
      }
    }
  }, [tenantSlug]);

  const prevBillingLockedRef = useRef(billingLocked);
  useEffect(() => {
    loadAllGymData();
  }, [loadAllGymData]);

  useEffect(() => {
    const wasLocked = prevBillingLockedRef.current;
    prevBillingLockedRef.current = billingLocked;
    if (wasLocked && !billingLocked) {
      loadAllGymData(true);
    }
  }, [billingLocked, loadAllGymData]);

  const openStudentDossier = async (studentId, initialSection = 'routines') => {
    setDossierOpen(true);
    setDossierTab(initialSection);
    setDossierLoading(true);
    setResetCodeGenerated('');
    setStudentPwInput('');
    setExpandedWorkoutIdx(null);
    try {
      const res = await portalApi(`/api/gym/student?id=${encodeURIComponent(studentId)}`);
      setDossierData(res);
    } catch (err) {
      toast(err.message || 'Erro ao abrir prontuário');
      setDossierOpen(false);
    } finally {
      setDossierLoading(false);
    }
  };

  const refreshDossierIfOpen = async studentId => {
    if (dossierOpen && dossierData?.student?.id === studentId) {
      try {
        const res = await portalApi(`/api/gym/student?id=${encodeURIComponent(studentId)}`);
        setDossierData(res);
      } catch { /* ignore */ }
    }
  };

  const openPrescribeForStudent = (student, routine = null, days = [1, 4]) => {
    if (dossierOpen && student?.id) {
      setReturnToDossierStudentId(student.id);
      setDossierOpen(false);
    }
    setBuilderState({
      open: true,
      mode: 'prescribe',
      student,
      initialRoutine: routine,
      initialDays: days
    });
  };

  const openTemplateBuilder = (tpl = null) => {
    setBuilderState({
      open: true,
      mode: 'template',
      student: null,
      initialRoutine: tpl,
      initialDays: tpl?.suggestedDays || [1, 3, 5]
    });
  };

  const filteredStudents = useMemo(() => {
    const q = studentQuery.trim().toLowerCase();
    return students.filter(s => {
      if (studentFilter === 'healthy' && s.churnStatus !== 'healthy' && s.churnStatus !== 'new') return false;
      if (studentFilter === 'risk' && s.churnStatus !== 'critical' && s.churnStatus !== 'warning') return false;
      if (studentFilter === 'noroutine' && (s.disabled || s.routineCount > 0)) return false;
      if (studentFilter === 'disabled' && !s.disabled) return false;
      if (studentFilter === 'all' && s.disabled) return false;
      if (!q) return true;
      const hay = `${s.name} ${s.email || ''} ${s.phone || ''} ${s.goal || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [students, studentQuery, studentFilter]);

  const templateCategories = useMemo(() => {
    const set = new Set(templates.map(t => t.category || 'Geral'));
    return ['all', ...Array.from(set)];
  }, [templates]);

  const filteredTemplates = useMemo(() => {
    if (tplCategory === 'all') return templates;
    return templates.filter(t => (t.category || 'Geral') === tplCategory);
  }, [templates, tplCategory]);

  // Matricular Aluno
  const handleEnrollStudent = async e => {
    e?.preventDefault();
    if (!enrollForm.name.trim()) {
      toast('Informe o nome completo do aluno');
      return;
    }
    await runSingleFlight('enroll-student', setEnrolling, async () => {
      try {
        await portalApi('/api/gym/students', {
          method: 'POST',
          body: {
            ...enrollForm,
            name: enrollForm.name.trim()
          }
        });
        toast(`Aluno ${enrollForm.name} matriculado com sucesso!`);
        setEnrollOpen(false);
        await loadAllGymData(true);
      } catch (err) {
        toast(err.message || 'Erro ao matricular aluno');
      }
    });
  };

  // Editar Aluno
  const openEditStudentModal = student => {
    setEditingStudent(student);
    setEditStudentForm({
      id: student.id,
      name: student.name || '',
      email: student.email || '',
      phone: student.phone || '',
      goal: student.goal || '',
      assignedTrainerId: student.assignedTrainerId || '',
      notes: student.notes || ''
    });
  };

  const handleSaveStudent = async e => {
    e?.preventDefault();
    if (!editStudentForm.name.trim()) {
      toast('Informe o nome completo do aluno');
      return;
    }
    setSavingEditStudent(true);
    try {
      const reqOpts = tenantSlug ? { tenantId: tenantSlug } : {};
      await portalApi('/api/gym/students', {
        ...reqOpts,
        method: 'PUT',
        body: {
          id: editStudentForm.id,
          name: editStudentForm.name.trim(),
          email: editStudentForm.email.trim(),
          phone: editStudentForm.phone.trim(),
          goal: editStudentForm.goal.trim(),
          assignedTrainerId: editStudentForm.assignedTrainerId || null,
          notes: editStudentForm.notes.trim()
        }
      });
      toast(`Dados de ${editStudentForm.name} atualizados com sucesso!`);
      setEditingStudent(null);
      await loadAllGymData(true);
    } catch (err) {
      toast(err.message || 'Erro ao salvar alterações do aluno');
    } finally {
      setSavingEditStudent(false);
    }
  };

  // Envio Direto de WhatsApp pelo Rit
  const handleOpenStudentWhatsApp = (student, defaultType = 'general', customMsg = '') => {
    const firstName = (student?.name || 'Aluno').split(' ')[0];
    const phone = student?.phone || '';
    if (!phone && defaultType !== 'invite') {
      toast('Este aluno não possui número de WhatsApp cadastrado. Clique em Editar para adicionar o telefone.');
      return;
    }

    const trainerName = team.find(t => t.id === student?.assignedTrainerId)?.name;
    const gymName = tenant.name || (isPersonal ? 'sua consultoria' : 'sua academia');
    const senderIdentity = trainerName ? `o Prof. ${trainerName} da ${gymName}` : `a equipe da ${gymName}`;

    let defaultMsg = customMsg;
    if (!defaultMsg) {
      if (defaultType === 'churn') {
        defaultMsg = `Olá, ${firstName}! Tudo bem? Aqui é ${senderIdentity}.\n\nSentimos sua falta nos treinos nos últimos dias! 💪\nSua rotina está pronta no seu aplicativo *Rit*. Quer ajustar algum exercício para retomar no seu ritmo essa semana? Conte com a gente!`;
      } else {
        defaultMsg = `Olá, ${firstName}! Tudo bem? Aqui é ${senderIdentity}.\n\nSua ficha de treino atualizada já está disponível no seu aplicativo *Rit*! Vamos treinar hoje? 🏋️‍♂️`;
      }
    }

    setWaSendModal({
      studentId: student?.id || null,
      studentName: student?.name || 'Aluno',
      phone,
      message: defaultMsg,
      type: defaultType
    });
  };

  const handleSendWhatsAppMessage = async e => {
    e?.preventDefault();
    if (!waSendModal?.phone) {
      toast('Telefone de destino ausente');
      return;
    }
    if (!waSendModal?.message?.trim()) {
      toast('Digite a mensagem a ser enviada');
      return;
    }

    setSendingWaMsg(true);
    try {
      const reqOpts = tenantSlug ? { tenantId: tenantSlug } : {};
      await portalApi('/api/gym/whatsapp/send', {
        ...reqOpts,
        method: 'POST',
        body: {
          phone: waSendModal.phone,
          message: waSendModal.message.trim()
        }
      });
      toast(`Mensagem enviada com sucesso no WhatsApp de ${waSendModal.studentName.split(' ')[0]}! 🚀`);
      setWaSendModal(null);
    } catch (err) {
      toast(err.message || 'Falha ao enviar mensagem pelo WhatsApp');
    } finally {
      setSendingWaMsg(false);
    }
  };

  // Salvar Perfil do Aluno no Prontuário
  const handleSaveStudentProfile = async e => {
    e?.preventDefault();
    if (!dossierData?.student) return;
    setSavingStudentProfile(true);
    try {
      await portalApi('/api/gym/students', {
        method: 'PUT',
        body: dossierData.student
      });
      toast('Dados cadastrais do aluno atualizados!');
      await loadAllGymData(true);
    } catch (err) {
      toast(err.message || 'Erro ao salvar perfil do aluno');
    } finally {
      setSavingStudentProfile(false);
    }
  };

  const handleDeleteStudentRoutine = (routineId, routineName = 'ficha') => {
    if (!dossierData?.student) return;
    const studentId = dossierData.student.id;
    const studentName = dossierData.student.name;
    setConfirmState({
      title: 'Remover Ficha do Aluno?',
      subtitle: `${studentName} · ${routineName}`,
      message: (
        <>
          Deseja remover a ficha <b>{routineName}</b> do aplicativo de <b>{studentName}</b>? O histórico de treinos já realizados será preservado.
        </>
      ),
      confirmLabel: 'Remover Ficha',
      confirmVariant: 'danger',
      confirmIcon: 'trash',
      onConfirm: async () => {
        await portalApi('/api/gym/student/routine/delete', {
          method: 'POST',
          body: { studentId, routineId }
        });
        toast('Ficha removida do aplicativo do aluno.');
        await refreshDossierIfOpen(studentId);
        await loadAllGymData(true);
      }
    });
  };

  const handleSetStudentPassword = async () => {
    if (!dossierData?.student || studentPwInput.length < 10) {
      toast('Digite uma senha com pelo menos 10 caracteres');
      return;
    }
    await runSingleFlight('student-password', setSettingStudentPw, async () => {
      try {
        await portalApi('/api/gym/students/password', {
          method: 'POST',
          body: { id: dossierData.student.id, password: studentPwInput }
        });
        setStudentPwInput('');
        toast('Nova senha definida para o aluno!');
      } catch (err) {
        toast(err.message || 'Erro ao alterar senha');
      }
    });
  };

  const handleGenerateStudentResetCode = async () => {
    if (!dossierData?.student) return;
    await runSingleFlight('student-reset-code', setGeneratingResetCode, async () => {
      try {
        const res = await portalApi('/api/gym/students/password', {
          method: 'POST',
          body: { id: dossierData.student.id, mode: 'reset-code' }
        });
        setResetCodeGenerated(res.code || '');
        toast('Código temporário gerado!');
      } catch (err) {
        toast(err.message || 'Erro ao gerar código');
      }
    });
  };

  const handleToggleStudentDisabled = async () => {
    if (!dossierData?.student) return;
    const studentId = dossierData.student.id;
    const next = !dossierData.student.disabled;
    await runSingleFlight(`student-disabled:${studentId}`, setTogglingStudentStatus, async () => {
      try {
        await portalApi('/api/gym/students', {
          method: 'PUT',
          body: { id: studentId, disabled: next }
        });
        setDossierData(prev => ({ ...prev, student: { ...prev.student, disabled: next } }));
        toast(next ? 'Matrícula bloqueada.' : 'Matrícula reativada!');
        await loadAllGymData(true);
      } catch (err) {
        toast(err.message || 'Erro ao atualizar matrícula');
      }
    });
  };

  const handleDeleteStudent = () => {
    if (!dossierData?.student) return;
    const student = dossierData.student;
    setConfirmState({
      title: 'Excluir Aluno Permanentemente?',
      subtitle: student.email || student.phone || student.name,
      message: (
        <>
          Tem certeza que deseja excluir permanentemente o aluno <b>{student.name}</b> e todo o seu histórico de fichas e treinos?
        </>
      ),
      confirmLabel: 'Confirmar Exclusão',
      confirmVariant: 'danger',
      confirmIcon: 'trash',
      onConfirm: async () => {
        await portalApi('/api/gym/students', {
          method: 'DELETE',
          body: { id: student.id }
        });
        toast('Aluno removido da unidade.');
        setDossierOpen(false);
        await loadAllGymData(true);
      }
    });
  };

  // Aplicar Modelo Rápido
  const handleQuickApplyTemplate = async e => {
    e?.preventDefault();
    if (!applyTplModal || !applyStudentId) {
      toast('Selecione um aluno para receber a ficha');
      return;
    }
    setApplyingTpl(true);
    try {
      await portalApi('/api/gym/prescribe', {
        method: 'POST',
        body: {
          studentId: applyStudentId,
          days: applyDays,
          routine: {
            name: applyTplModal.name,
            emoji: applyTplModal.emoji || 'figureStrength',
            ex: applyTplModal.ex || []
          }
        }
      });
      const stName = students.find(s => s.id === applyStudentId)?.name || 'aluno';
      toast(`Ficha "${applyTplModal.name}" enviada para o app de ${stName}!`);
      setApplyTplModal(null);
      await loadAllGymData(true);
    } catch (err) {
      toast(err.message || 'Erro ao prescrever modelo');
    } finally {
      setApplyingTpl(false);
    }
  };

  const handleDeleteTemplate = tpl => {
    setConfirmState({
      title: 'Excluir Modelo de Ficha?',
      subtitle: tpl.category || 'Biblioteca de Modelos',
      message: (
        <>
          Deseja excluir o modelo <b>"{tpl.name}"</b> da biblioteca? As fichas já prescritas para os alunos não serão afetadas.
        </>
      ),
      confirmLabel: 'Excluir Modelo',
      confirmVariant: 'danger',
      confirmIcon: 'trash',
      onConfirm: async () => {
        await portalApi('/api/gym/templates', {
          method: 'DELETE',
          body: { id: tpl.id }
        });
        toast('Modelo removido da biblioteca.');
        await loadAllGymData(true);
      }
    });
  };

  const handleImportDefaultTemplates = async () => {
    await runSingleFlight('import-defaults', setImportingDefaults, async () => {
      try {
        const res = await portalApi('/api/gym/templates/import-defaults', {
          method: 'POST',
          body: {}
        });
        if (res?.added > 0) {
          toast(`${res.added} modelo(s) brasileiro(s) importado(s) para a biblioteca!`);
        } else {
          toast('Todos os modelos padrão da Rit já estão na biblioteca.');
        }
        await loadAllGymData(true);
      } catch (e) {
        toast(e?.message || 'Erro ao importar modelos padrão.');
      }
    });
  };

  // Equipe
  const handleSaveTeamMember = async e => {
    e?.preventDefault();
    if (!memberModal) return;
    const rawPw = String(memberModal.password || '');
    if (rawPw.trim() && rawPw.length < 10) {
      toast('A senha do profissional deve ter pelo menos 10 caracteres');
      return;
    }
    setSavingMember(true);
    try {
      if (memberModal.isNew) {
        await portalApi('/api/gym/team', {
          method: 'POST',
          body: memberModal
        });
        toast(`Profissional ${memberModal.name} adicionado à equipe!`);
      } else {
        await portalApi('/api/gym/team', {
          method: 'PUT',
          body: memberModal
        });
        toast('Cadastro do profissional atualizado!');
      }
      setMemberModal(null);
      await loadAllGymData(true);
    } catch (err) {
      toast(err.message || 'Erro ao salvar profissional');
    } finally {
      setSavingMember(false);
    }
  };

  const handleRemoveTeamMember = member => {
    setConfirmState({
      title: 'Remover Profissional da Equipe?',
      subtitle: member.email || member.cref || member.name,
      message: (
        <>
          Confirma a remoção de <b>{member.name}</b> da equipe? O acesso deste profissional ao painel será encerrado.
        </>
      ),
      confirmLabel: 'Remover da Equipe',
      confirmVariant: 'danger',
      confirmIcon: 'trash',
      onConfirm: async () => {
        await portalApi('/api/gym/team', {
          method: 'DELETE',
          body: { id: member.id }
        });
        toast('Profissional removido da equipe.');
        await loadAllGymData(true);
      }
    });
  };

  // Convites & Configurações de Onboarding
  const handleCreateInvite = async e => {
    e?.preventDefault();
    setCreatingInvite(true);
    try {
      await portalApi('/api/gym/invites', {
        method: 'POST',
        body: { note: inviteNote }
      });
      setInviteNote('');
      toast('Novo código de convite gerado!');
      await loadAllGymData(true);
    } catch (err) {
      toast(err.message || 'Erro ao gerar convite');
    } finally {
      setCreatingInvite(false);
    }
  };

  const handleRevokeInvite = code => {
    setConfirmState({
      title: 'Revogar Código de Convite?',
      subtitle: `Código: ${code}`,
      message: (
        <>
          Deseja invalidar o convite <code>{code}</code>? Ele não poderá mais ser utilizado para auto-cadastro no app.
        </>
      ),
      confirmLabel: 'Revogar Convite',
      confirmVariant: 'danger',
      confirmIcon: 'trash',
      onConfirm: async () => {
        await portalApi('/api/gym/invites/revoke', {
          method: 'POST',
          body: { code }
        });
        toast('Convite revogado.');
        await loadAllGymData(true);
      }
    });
  };

  const handleUpdateSetting = async patch => {
    try {
      await portalApi('/api/gym/settings', {
        method: 'PUT',
        body: patch
      });
      toast('Configuração de acesso atualizada!');
      await loadAllGymData(true);
    } catch (err) {
      toast(err.message || 'Erro ao atualizar configuração');
    }
  };

  // Upload local de Logotipo / Foto (redimensiona para 160x160 Data URL leve)
  const handleLogoFileUpload = e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('Selecione um arquivo de imagem válido (PNG, JPG, WebP ou SVG).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = 160;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        let dataUrl = canvas.toDataURL('image/webp', 0.88);
        if (!dataUrl || dataUrl.length > 140000) {
          dataUrl = canvas.toDataURL('image/jpeg', 0.84);
        }
        setBrandForm(p => ({ ...p, logoUrl: dataUrl }));
        toast('Imagem carregada! Clique em "Salvar e Publicar no App" para publicar.');
      };
      img.onerror = () => toast('Não foi possível processar esta imagem.');
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  };

  // White-Label Branding
  const handleSaveBranding = async e => {
    e?.preventDefault();
    const rawLogo = String(brandForm.logoUrl || '').trim();
    const isBlobLogo = rawLogo.startsWith('blob:');
    const cleanLogo = isBlobLogo ? '' : rawLogo;
    if (isBlobLogo) {
      setBrandForm(p => ({ ...p, logoUrl: '' }));
    }
    setSavingBrand(true);
    try {
      const reqOpts = tenantSlug ? { tenantId: tenantSlug } : {};
      const res = await portalApi('/api/gym/branding', {
        ...reqOpts,
        method: 'PUT',
        body: {
          gymName: brandForm.gymName,
          slogan: brandForm.slogan,
          primaryColor: brandForm.primaryColor,
          logoUrl: cleanLogo,
          contactPhone: brandForm.contactPhone,
          address: brandForm.address,
          instagram: brandForm.instagram,
          seasonalTheme: brandForm.seasonalTheme || 'auto',
          settings: {
            churnDaysThreshold: Number(brandForm.churnDaysThreshold || 5),
            notifyTrainerOnWorkout: brandForm.notifyTrainerOnWorkout !== false,
            notifyStudentOnPrescribe: brandForm.notifyStudentOnPrescribe !== false
          }
        }
      });
      applyPortalAccent(brandForm.primaryColor);
      if (res.tenant) onTenantUpdated?.(res.tenant);
      if (isBlobLogo) {
        toast('Cor e nome salvos! (Links temporários "blob:" não funcionam fora da aba original — use o botão "Enviar Imagem do Computador")');
      } else {
        toast('Configurações salvas e atualizadas com sucesso!');
      }
      await loadAllGymData(true);
    } catch (err) {
      toast(err.message || 'Erro ao salvar configurações');
    } finally {
      setSavingBrand(false);
    }
  };

  const handleTestWhatsApp = async () => {
    const phone = String(brandForm.contactPhone || '').trim();
    if (!phone) {
      toast('Preencha o campo de WhatsApp acima antes de testar');
      return;
    }
    setTestingWa(true);
    try {
      const reqOpts = tenantSlug ? { tenantId: tenantSlug } : {};
      const res = await portalApi('/api/gym/whatsapp/test', {
        ...reqOpts,
        method: 'POST',
        body: { phone }
      });
      toast(res.message || 'Mensagem de teste enviada com sucesso no WhatsApp!');
      await loadAllGymData(true);
    } catch (err) {
      toast(err.message || 'Falha ao conectar com a Evolution API');
    } finally {
      setTestingWa(false);
    }
  };

  const handleChurnBatchWhatsApp = async () => {
    setSendingChurnBatch(true);
    try {
      const reqOpts = tenantSlug ? { tenantId: tenantSlug } : {};
      const res = await portalApi('/api/gym/whatsapp/churn-batch', {
        ...reqOpts,
        method: 'POST',
        body: {}
      });
      toast(res.message || 'Mensagens de recuperação enviadas no WhatsApp!');
      await loadAllGymData(true);
    } catch (err) {
      toast(err.message || 'Falha ao disparar mensagens anti-evasão');
    } finally {
      setSendingChurnBatch(false);
    }
  };

  const handleRetryOutbox = async () => {
    setRetryingOutbox(true);
    try {
      const reqOpts = tenantSlug ? { tenantId: tenantSlug } : {};
      const res = await portalApi('/api/gym/whatsapp/outbox/retry', {
        ...reqOpts,
        method: 'POST',
        body: {}
      });
      toast(res.message || 'Fila de mensagens processada!');
      if (res.outbox) {
        setWaStatus(prev => (prev ? { ...prev, outbox: res.outbox } : prev));
      } else {
        await loadAllGymData(true);
      }
    } catch (err) {
      toast(err.message || 'Erro ao reprocessar fila');
    } finally {
      setRetryingOutbox(false);
    }
  };

  const loadBillingData = useCallback(async () => {
    try {
      setLoadingBilling(true);
      const reqOpts = tenantSlug ? { tenantId: tenantSlug } : {};
      const res = await portalApi('/api/saas/billing/status', reqOpts);
      if (res && res.ok) {
        setBillingData(res);
        if (res.status === 'active' && !res.accessBlocked && billingLocked) {
          callbacksRef.current.onTenantUpdated?.({
            id: res.tenantId,
            name: res.name,
            accountType: res.accountType,
            status: res.status,
            planId: res.planId,
            mrr: res.mrr,
            nextBillingAt: res.nextBillingAt,
            trialEndsAt: res.trialEndsAt,
            accessBlocked: false,
            blockReason: null
          });
        }
      }
    } catch (e) {
      console.warn('Erro ao carregar status de faturamento:', e);
    } finally {
      setLoadingBilling(false);
    }
  }, [tenantSlug, billingLocked]);

  useEffect(() => {
    if (activeTab === 'billing') {
      loadBillingData();
    }
  }, [activeTab, loadBillingData]);

  const openPixCheckout = (planId = null) => {
    const isPers = overview?.tenant?.accountType === 'personal' || String(overview?.tenant?.planId || '').startsWith('personal');
    const currentPId = overview?.tenant?.planId || (isPers ? 'personal-pro' : 'starter');
    setCheckoutPlanId(planId || currentPId);
    setCheckoutCycle('annual');
    checkoutIdemRef.current = null;
    setActivePix(null);
    setCopiedCode(false);
    setPixModalOpen(true);
  };

  const handleGeneratePix = async () => {
    const targetTenantId = tenantSlug || overview?.tenant?.id;
    const idemKey = getOrRotateIntentKey(checkoutIdemRef, {
      tenantId: targetTenantId,
      planId: checkoutPlanId,
      cycle: checkoutCycle
    });
    await runSingleFlight('generate-pix', setGeneratingPix, async () => {
      try {
        const res = await portalApi('/api/saas/billing/checkout-pix', {
          method: 'POST',
          tenantId: targetTenantId,
          idempotencyKey: idemKey,
          body: {
            planId: checkoutPlanId,
            cycle: checkoutCycle
          }
        });
        if (res.ok && res.pix) {
          checkoutIdemRef.current = null;
          setActivePix({
            ...res.pix,
            invoiceId: res.invoice?.id
          });
          toast(res.reused ? 'PIX pendente em aberto reutilizado!' : 'Cobrança PIX gerada com sucesso!');
          loadBillingData();
        }
      } catch (err) {
        toast(err.message || 'Erro ao gerar PIX');
      }
    });
  };

  const handleCopyPixCode = () => {
    if (!activePix?.qrCode) return;
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(activePix.qrCode);
      }
      setCopiedCode(true);
      toast('Código PIX Copia e Cola copiado com sucesso!');
      setTimeout(() => setCopiedCode(false), 4000);
    } catch {
      toast('Selecione e copie o código PIX manualmente.');
    }
  };

  const handleSimulatePayment = async () => {
    if (!activePix?.invoiceId) return;
    const targetTenantId = tenantSlug || overview?.tenant?.id;
    const idemKey = getOrRotateIntentKey(simulateIdemRef, {
      tenantId: targetTenantId,
      invoiceId: activePix.invoiceId
    });
    await runSingleFlight(`simulate-pix:${activePix.invoiceId}`, setSimulatingPix, async () => {
      try {
        const res = await portalApi('/api/saas/billing/simulate-pix', {
          method: 'POST',
          tenantId: targetTenantId,
          idempotencyKey: idemKey,
          body: {
            invoiceId: activePix.invoiceId
          }
        });
        if (res.ok) {
          simulateIdemRef.current = null;
          toast('Pagamento PIX confirmado com sucesso! Sua assinatura foi ativada.');
          setActivePix(null);
          setPixModalOpen(false);
          if (res.tenant) {
            callbacksRef.current.onTenantUpdated?.(res.tenant);
          }
          loadBillingData();
          loadAllGymData(true);
        }
      } catch (err) {
        toast(err.message || 'Erro ao simular pagamento');
      }
    });
  };

  // Polling automático da fatura quando o modal de PIX estiver aberto
  useEffect(() => {
    if (!pixModalOpen || !activePix?.invoiceId) return;
    const interval = setInterval(async () => {
      try {
        const res = await portalApi(`/api/saas/billing/invoice?id=${activePix.invoiceId}`, {
          tenantId: tenantSlug || overview?.tenant?.id
        });
        if (res.ok && res.invoice?.status === 'paid') {
          toast('Pagamento PIX confirmado com sucesso! Sua assinatura foi liberada.');
          setActivePix(null);
          setPixModalOpen(false);
          loadBillingData();
          loadAllGymData(true);
        }
      } catch { /* ignora erro de polling */ }
    }, 4000);
    return () => clearInterval(interval);
  }, [pixModalOpen, activePix?.invoiceId, tenantSlug, overview?.tenant?.id, loadBillingData, loadAllGymData]);

  if (loading && !overview) {
    return (
      <div style={{ padding: '60px 0', textAlign: 'center' }} className="muted">
        Carregando painel operacional...
      </div>
    );
  }

  const tenant = overview?.tenant || {};
  const isPersonal = tenant.accountType === 'personal' || String(tenant.planId || '').startsWith('personal');
  const kpis = overview?.kpis || {};
  const churnAlerts = overview?.churnAlerts || [];
  const liveNow = overview?.liveNow || [];
  const studentAppUrl = getStudentAppUrl(tenant.id);
  const weekdayDist = overview?.weekdayDistribution || [];
  const maxWeekday = Math.max(1, ...weekdayDist.map(d => d.count || 0));

  const openEnrollModal = () => {
    setEnrollForm({
      name: '',
      email: '',
      phone: '',
      goal: 'Hipertrofia & Força',
      assignedTrainerId: team[0]?.id || '',
      password: generateTempPassword(),
      initialTemplateId: templates[0]?.id || '',
      notes: ''
    });
    setEnrollOpen(true);
  };

  return (
    <div>
      {/* =================================================================
          ABA 1: DASHBOARD DA UNIDADE & CENTRAL ANTI-EVASÃO
         ================================================================= */}
      {activeTab === 'dashboard' && (
        <div>
          <div className="b2b-page-head">
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h1>{tenant.name || (isPersonal ? 'Painel do Personal' : 'Painel da Academia')}</h1>
                <StatusPill tone="ok">Plano {tenant.planName || (isPersonal ? 'Personal' : 'Pro')}</StatusPill>
              </div>
              <p>
                {isPersonal
                  ? 'Gestão da sua consultoria online e presencial, retenção ativa de alunos e prescrição sincronizada direto no aplicativo dos seus alunos.'
                  : 'Gestão de alunos em tempo real, retenção ativa anti-evasão e prescrição sincronizada ao aplicativo.'}
              </p>
            </div>
            <div className="b2b-head-actions">
              <a
                href={studentAppUrl}
                target="_blank"
                rel="noreferrer"
                className="btn ghost"
              >
                <Icon name="phoneScreen" />
                <span>Abrir App do Aluno</span>
              </a>
              <Button variant="primary" icon="userPlus" data-tour="gym-enroll-btn" onClick={openEnrollModal}>
                Matricular Aluno
              </Button>
            </div>
          </div>

          <div className="b2b-kpi-grid" data-tour="gym-kpis">
            <KpiTile
              label="Alunos Ativos"
              value={`${kpis.totalStudents || 0} / ${tenant.limits?.maxStudents >= 100000 ? 'Ilimitado' : (tenant.limits?.maxStudents || 'Ilimitado')}`}
              sub={`${kpis.activeStudents7d || 0} treinaram nos últimos 7 dias`}
              icon="users"
              tint="var(--acc)"
              onClick={() => onChangeTab?.('students')}
            />
            <KpiTile
              label={isPersonal ? 'Treinando Agora (Ao Vivo)' : 'No Salão Agora (Ao Vivo)'}
              value={String(kpis.liveNowCount || 0)}
              sub={`${kpis.workoutsToday || 0} treinos hoje · ${kpis.workoutsWeek || 0} na semana`}
              icon="bolt"
              tint="var(--green)"
            />
            <KpiTile
              label="Alerta Anti-Evasão"
              value={String(kpis.atRiskCount || 0)}
              sub={`Ausentes há +${kpis.churnDaysThreshold || 5} dias`}
              icon="warning"
              tint="var(--orange)"
              onClick={() => {
                setStudentFilter('risk');
                onChangeTab?.('students');
              }}
            />
            <KpiTile
              label="Treinos Concluídos (30d)"
              value={String(kpis.workoutsMonth || 0)}
              sub={`${kpis.withoutRoutineCount || 0} alunos aguardando ficha`}
              icon="dumbbell"
              tint="var(--indigo)"
              onClick={() => onChangeTab?.('templates')}
            />
          </div>

          {liveNow.length > 0 && (
            <div className="card" style={{ borderColor: 'var(--green)' }}>
              <CardHead
                icon="bolt"
                iconTint="var(--green)"
                title={`Alunos Treinando Agora (${liveNow.length})`}
                subtitle="Sessões ativas sincronizadas em tempo real pelo aplicativo"
              />
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {liveNow.map(l => (
                  <div
                    key={l.id}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 999,
                      background: 'var(--bg-el)',
                      border: 'var(--hair) solid var(--sep)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 13.5
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--green)' }} />
                    <b>{l.name}</b>
                    {l.routineName && <span className="muted small">· {l.routineName}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="b2b-grid-2">
            <div className="card" style={{ margin: 0 }}>
              <CardHead
                icon="chartLine"
                iconTint="var(--acc)"
                title="Frequência Diária de Treinos (14 dias)"
                subtitle="Total de treinos finalizados pelos alunos no app da unidade"
              />
              <LineChart
                data={overview?.dailyWorkouts || []}
                valueKey="count"
                labelKey="date"
                height={180}
                formatValue={v => `${v} treinos`}
              />
            </div>

            <div className="card" style={{ margin: 0 }}>
              <CardHead
                icon="calendar"
                iconTint="var(--indigo)"
                title="Distribuição por Dia da Semana (30d)"
                subtitle="Identifique os dias de maior movimento e evasão no salão"
              />
              <div>
                {weekdayDist.map(w => (
                  <BarRow
                    key={w.day}
                    label={w.day}
                    value={w.count}
                    max={maxWeekday}
                    rightText={`${w.count} treinos`}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="card" data-tour="gym-churn">
            <CardHead
              icon="warning"
              iconTint="var(--orange)"
              title="Central Anti-Evasão (Retenção Proativa)"
              subtitle="Alunos ausentes que precisam de contato rápido da equipe ou renovação de ficha"
              action={
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {churnAlerts.some(s => s.phone) && (
                    <Button
                      variant="tinted"
                      size="sm"
                      icon="chat"
                      disabled={sendingChurnBatch}
                      onClick={() => handleChurnBatchWhatsApp(churnAlerts.slice(0, 12).filter(s => s.phone).map(s => s.id))}
                      style={{ color: 'var(--green)' }}
                    >
                      {sendingChurnBatch ? 'Disparando...' : '⚡ Recuperar Ausentes no WhatsApp'}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setStudentFilter('risk');
                      onChangeTab?.('students');
                    }}
                  >
                    Ver Todos Alunos
                  </Button>
                </div>
              }
            />

            {churnAlerts.length === 0 ? (
              <EmptyState
                icon="trophy"
                title="Retenção excelente! Zero alertas críticos hoje"
                message="Todos os alunos ativos registraram treinos dentro da janela esperada da academia."
              />
            ) : (
              <div className="b2b-table-wrap b2b-table-wrap-stack" style={{ border: 'none' }}>
                <table className="b2b-table b2b-table-stack">
                  <thead>
                    <tr>
                      <th>Aluno</th>
                      <th>Tempo sem Treinar</th>
                      <th>Último Treino</th>
                      <th>Fichas Ativas</th>
                      <th style={{ textAlign: 'right' }}>Ação de Retenção</th>
                    </tr>
                  </thead>
                  <tbody>
                    {churnAlerts.slice(0, 12).map(s => {
                      return (
                        <tr key={s.id}>
                          <td className="b2b-td-main">
                            <div style={{ fontWeight: 700 }}>{s.name}</div>
                            <div className="muted small">{s.goal || s.phone || s.email || 'Aluno matriculado'}</div>
                          </td>
                          <td data-label="Ausência">
                            <StatusPill tone={s.churnStatus}>
                              {s.daysInactive != null ? `${s.daysInactive} dias ausente` : 'Nunca treinou'}
                            </StatusPill>
                          </td>
                          <td data-label="Último Treino" className="muted small">{fmtDateBR(s.lastWorkoutDate)}</td>
                          <td data-label="Fichas" className="num">{s.routineCount} ficha(s)</td>
                          <td className="b2b-td-actions">
                            <div className="b2b-row-actions">
                              <Button
                                variant="tinted"
                                size="sm"
                                icon="chat"
                                style={{ color: 'var(--green)' }}
                                onClick={() => handleOpenStudentWhatsApp(s, 'churn')}
                              >
                                Recuperar via WhatsApp
                              </Button>
                              <Button
                                variant="tinted"
                                size="sm"
                                icon="dumbbell"
                                onClick={() => openPrescribeForStudent(s)}
                              >
                                Nova Ficha
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                icon="clipboard"
                                onClick={() => openStudentDossier(s.id)}
                              >
                                Prontuário
                              </Button>
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
        </div>
      )}

      {/* =================================================================
          ABA 2: ALUNOS, MATRÍCULAS & PRONTUÁRIO DE PRESCRIÇÃO
         ================================================================= */}
      {activeTab === 'students' && (
        <div>
          <div className="b2b-page-head">
            <div>
              <h1>Alunos & Matrículas</h1>
              <p>Gerencie o prontuário individual, prescreva fichas personalizadas no app e acompanhe a evolução de cargas.</p>
            </div>
            <div className="b2b-head-actions">
              <Button variant="primary" icon="userPlus" data-tour="gym-enroll-btn" onClick={openEnrollModal}>
                Matricular Aluno
              </Button>
            </div>
          </div>

          <div className="b2b-toolbar">
            <SearchField
              value={studentQuery}
              onChange={setStudentQuery}
              placeholder="Buscar aluno por nome, telefone, e-mail ou objetivo..."
            />
            <ChipBar
              value={studentFilter}
              onChange={setStudentFilter}
              items={[
                { value: 'all', label: 'Ativos', count: students.filter(s => !s.disabled).length },
                { value: 'healthy', label: 'Em Dia', count: students.filter(s => s.churnStatus === 'healthy' || s.churnStatus === 'new').length },
                { value: 'risk', label: 'Alerta Evasão', count: students.filter(s => s.churnStatus === 'critical' || s.churnStatus === 'warning').length },
                { value: 'noroutine', label: 'Sem Ficha', count: students.filter(s => !s.disabled && s.routineCount === 0).length },
                { value: 'disabled', label: 'Inativos', count: students.filter(s => s.disabled).length }
              ]}
            />
          </div>

          {filteredStudents.length === 0 ? (
            <div className="card">
              <EmptyState
                icon="users"
                title="Nenhum aluno encontrado neste filtro"
                message="Matricule novos alunos ou ajuste sua busca."
                action={<Button variant="primary" icon="userPlus" onClick={openEnrollModal}>Matricular Aluno</Button>}
              />
            </div>
          ) : (
            <div className="b2b-table-wrap b2b-table-wrap-stack">
              <table className="b2b-table b2b-table-stack">
                <thead>
                  <tr>
                    <th>Aluno / Objetivo</th>
                    <th>Fichas no App</th>
                    <th>Frequência</th>
                    <th>Status de Retenção</th>
                    <th style={{ textAlign: 'right' }}>Prescrição & Prontuário</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStudents.map(s => {
                    const badge = CHURN_BADGES[s.churnStatus] || { label: s.churnStatus, tone: 'muted' };
                    return (
                      <tr key={s.id}>
                        <td className="b2b-td-main">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                            <div
                              style={{
                                width: 36,
                                height: 36,
                                borderRadius: '50%',
                                background: 'var(--surface-2)',
                                color: 'var(--acc-ink)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontWeight: 800,
                                fontSize: 14,
                                flexShrink: 0
                              }}
                            >
                              {s.name.slice(0, 1).toUpperCase()}
                            </div>
                            <div>
                              <div style={{ fontWeight: 700, fontSize: 14.5 }}>{s.name}</div>
                              <div className="muted small">
                                {s.goal || 'Condicionamento Geral'}
                                {s.assignedTrainerName ? ` · Prof. ${s.assignedTrainerName}` : ''}
                                {s.phone ? ` · ${s.phone}` : s.email ? ` · ${s.email}` : ''}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td data-label="Fichas no App">
                          {s.routineCount > 0 ? (
                            <span className="num" style={{ fontWeight: 600 }}>{s.routineCount} ficha(s)</span>
                          ) : (
                            <StatusPill tone="warn">Aguardando Ficha</StatusPill>
                          )}
                        </td>
                        <td data-label="Frequência">
                          <div className="num" style={{ fontWeight: 600 }}>
                            {s.workoutsLast7d} <span className="muted small">em 7d</span> · {s.workoutsLast30d} <span className="muted small">em 30d</span>
                          </div>
                          <div className="muted small">Último: {fmtDateBR(s.lastWorkoutDate)}</div>
                        </td>
                        <td data-label="Retenção">
                          <StatusPill tone={badge.tone}>
                            {badge.label}
                            {s.daysInactive != null && (s.churnStatus === 'warning' || s.churnStatus === 'critical')
                              ? ` (${s.daysInactive}d)`
                              : ''}
                          </StatusPill>
                        </td>
                        <td className="b2b-td-actions">
                          <div className="b2b-row-actions">
                            {s.phone && (
                              <Button
                                variant="ghost"
                                size="sm"
                                icon="chat"
                                title="Enviar mensagem via WhatsApp API"
                                style={{ color: 'var(--green)' }}
                                onClick={() => handleOpenStudentWhatsApp(s, 'general')}
                              />
                            )}
                            <Button
                              variant="tinted"
                              size="sm"
                              icon="pencil"
                              title="Editar dados cadastrais do aluno"
                              onClick={() => openEditStudentModal(s)}
                            >
                              Editar
                            </Button>
                            <Button
                              variant="tinted"
                              size="sm"
                              icon="plus"
                              onClick={() => openPrescribeForStudent(s)}
                            >
                              Prescrever
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              icon="clipboard"
                              onClick={() => openStudentDossier(s.id)}
                            >
                              Prontuário
                            </Button>
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
          ABA 3: BIBLIOTECA DE MODELOS DE FICHAS DA ACADEMIA
         ================================================================= */}
      {activeTab === 'templates' && (
        <div>
          <div className="b2b-page-head" data-tour="gym-templates-head">
            <div>
              <h1>{isPersonal ? 'Meus Modelos de Fichas' : 'Modelos de Fichas da Academia'}</h1>
              <p>
                {isPersonal
                  ? 'Padronize sua metodologia de consultoria e envie fichas completas para seus alunos em segundos.'
                  : 'Padronize a metodologia de treino da sua unidade e envie fichas completas para os alunos em segundos.'}
              </p>
            </div>
            <div className="b2b-head-actions">
              <Button variant="secondary" icon="dumbbell" disabled={importingDefaults} onClick={handleImportDefaultTemplates}>
                {importingDefaults ? 'Importando...' : 'Importar Modelos da Rit'}
              </Button>
              <Button variant="primary" icon="plus" onClick={() => openTemplateBuilder(null)}>
                Novo Modelo de Ficha
              </Button>
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <ChipBar
              value={tplCategory}
              onChange={setTplCategory}
              items={templateCategories.map(c => ({
                value: c,
                label: c === 'all' ? 'Todas Categorias' : c
              }))}
            />
          </div>

          {filteredTemplates.length === 0 ? (
            <div className="card">
              <EmptyState
                icon="dumbbell"
                title="Nenhum modelo nesta categoria"
                message="Crie modelos de Adaptação, Hipertrofia ABC ou Emagrecimento usando o catálogo oficial de 5.632 exercícios."
                action={<Button variant="primary" icon="plus" onClick={() => openTemplateBuilder(null)}>Criar Modelo</Button>}
              />
            </div>
          ) : (
            <div className="b2b-grid-3">
              {filteredTemplates.map(tpl => (
                <div
                  key={tpl.id}
                  className="card"
                  style={{ margin: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span className="lrow-i" style={{ '--tint': 'var(--acc)', width: 38, height: 38, borderRadius: 10 }}>
                          <Icon name={tpl.emoji || 'figureStrength'} size={20} />
                        </span>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 15.5 }}>{tpl.name}</div>
                          <StatusPill tone="ok">{tpl.category || 'Geral'}</StatusPill>
                        </div>
                      </div>
                    </div>

                    {tpl.description && (
                      <p className="muted small" style={{ margin: '0 0 12px', lineHeight: 1.4 }}>
                        {tpl.description}
                      </p>
                    )}

                    <div style={{ background: 'var(--bg-el)', borderRadius: 'var(--r)', padding: '10px 12px', border: 'var(--hair) solid var(--sep)' }}>
                      <div className="muted small" style={{ fontWeight: 700, marginBottom: 6 }}>
                        {tpl.ex?.length || 0} exercícios configurados:
                      </div>
                      {(tpl.ex || []).slice(0, 4).map((x, idx) => (
                        <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingRight: 8 }}>
                            {idx + 1}. {x.name || `#${x.id}`}
                          </span>
                          <span className="muted num" style={{ flexShrink: 0 }}>{x.sets}×{x.reps}</span>
                        </div>
                      ))}
                      {(tpl.ex?.length || 0) > 4 && (
                        <div className="muted small" style={{ marginTop: 4 }}>
                          + {tpl.ex.length - 4} exercício(s) adicional(is)
                        </div>
                      )}
                    </div>
                  </div>

                  <div style={{ marginTop: 16, paddingTop: 12, borderTop: 'var(--hair) solid var(--sep)', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <Button
                      variant="primary"
                      size="sm"
                      icon="userPlus"
                      onClick={() => {
                        setApplyTplModal(tpl);
                        setApplyStudentId(students.find(s => !s.disabled)?.id || '');
                        setApplyDays(Array.isArray(tpl.suggestedDays) && tpl.suggestedDays.length ? tpl.suggestedDays : [1, 3, 5]);
                      }}
                    >
                      Aplicar em Aluno
                    </Button>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Button variant="ghost" size="sm" icon="pencil" onClick={() => openTemplateBuilder(tpl)} title="Editar Modelo" />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="trash"
                        style={{ color: 'var(--red)' }}
                        onClick={() => handleDeleteTemplate(tpl)}
                        title="Remover Modelo"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* =================================================================
          ABA 4: EQUIPE TÉCNICA & PROFESSORES
         ================================================================= */}
      {activeTab === 'team' && (
        <div>
          <div className="b2b-page-head" data-tour="gym-team-head">
            <div>
              <h1>{isPersonal ? 'Meu Perfil & Equipe' : 'Equipe & Professores'}</h1>
              <p>
                {isPersonal
                  ? `Gerencie seu cadastro profissional ou adicione treinadores parceiros (${team.length} / ${maxTrainers >= 100000 ? 'Ilimitado' : maxTrainers} vagas do plano).`
                  : `Gerencie coordenadores e instrutores de salão autorizados a prescrever fichas (${team.length} / ${maxTrainers >= 100000 ? 'Ilimitado' : maxTrainers} vagas do plano).`}
              </p>
            </div>
            {isManager && (
              <div className="b2b-head-actions">
                <Button
                  variant="primary"
                  icon="userPlus"
                  onClick={() =>
                    setMemberModal({
                      isNew: true,
                      name: '',
                      email: '',
                      phone: '',
                      cref: '',
                      specialty: 'Musculação & Hipertrofia',
                      saasRole: 'trainer',
                      password: generateTempPassword()
                    })
                  }
                >
                  Novo Profissional
                </Button>
              </div>
            )}
          </div>

          <div className="b2b-table-wrap b2b-table-wrap-stack">
            <table className="b2b-table b2b-table-stack">
              <thead>
                <tr>
                  <th>Profissional</th>
                  <th>Função</th>
                  <th>CREF / Especialidade</th>
                  <th>Alunos Vinculados</th>
                  <th>Status</th>
                  {isManager && <th style={{ textAlign: 'right' }}>Ações</th>}
                </tr>
              </thead>
              <tbody>
                {team.map(m => (
                  <tr key={m.id}>
                    <td className="b2b-td-main">
                      <div style={{ fontWeight: 700 }}>{m.name}</div>
                      <div className="muted small">{m.email}{m.phone ? ` · ${m.phone}` : ''}</div>
                    </td>
                    <td data-label="Função">
                      <StatusPill tone={m.saasRole === 'gym_owner' ? 'ok' : 'muted'}>
                        {ROLE_LABELS[m.saasRole] || 'Professor'}
                      </StatusPill>
                    </td>
                    <td data-label="CREF / Especialidade">
                      <div>
                        <div>{m.cref || '—'}</div>
                        <div className="muted small">{m.specialty || 'Instrutor'}</div>
                      </div>
                    </td>
                    <td data-label="Alunos" className="num" style={{ fontWeight: 600 }}>{m.assignedStudents || 0} aluno(s)</td>
                    <td data-label="Status">
                      <StatusPill tone={m.disabled ? 'bad' : 'ok'}>
                        {m.disabled ? 'Inativo' : 'Ativo'}
                      </StatusPill>
                    </td>
                    {isManager && (
                      <td className="b2b-td-actions">
                        <div className="b2b-row-actions">
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="pencil"
                            onClick={() => setMemberModal({ ...m, isNew: false, password: '' })}
                          >
                            Editar
                          </Button>
                          {m.saasRole !== 'gym_owner' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              icon="trash"
                              style={{ color: 'var(--red)' }}
                              onClick={() => handleRemoveTeamMember(m)}
                            />
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* =================================================================
          ABA 5: RECEPÇÃO, QR CODE DO APP & CONVITES
         ================================================================= */}
      {activeTab === 'onboarding' && (
        <div>
          <div className="b2b-page-head">
            <div>
              <h1>{isPersonal ? 'QR Code & Convite de Alunos' : 'QR Code & Recepção de Alunos'}</h1>
              <p>
                {isPersonal
                  ? 'Compartilhe o link ou QR Code do seu aplicativo com novos alunos de consultoria ou gere códigos individuais.'
                  : 'Imprima o QR Code oficial para o balcão da academia ou gere códigos individuais de convite.'}
              </p>
            </div>
          </div>

          <div className="b2b-grid-2">
            <div className="card" style={{ margin: 0 }} data-tour="gym-qr-card">
              <CardHead
                icon="qr"
                iconTint="var(--acc)"
                title={isPersonal ? 'QR Code Oficial do Seu App' : 'QR Code Oficial do App da Academia'}
                subtitle={isPersonal ? 'Ao escanear, o aluno abre o aplicativo já personalizado com a sua marca e cores' : 'Ao escanear, o aluno abre o aplicativo já personalizado com a marca e cores da sua unidade'}
              />

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '14px 0 20px', gap: 14 }}>
                <QrCodeBox value={studentAppUrl} size={188} />
                <code className="b2b-url-code">
                  {studentAppUrl}
                </code>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                  <Button
                    variant="tinted"
                    icon="copy"
                    onClick={() => {
                      navigator.clipboard?.writeText(studentAppUrl);
                      toast('Link exclusivo do App copiado!');
                    }}
                  >
                    Copiar Link do App
                  </Button>
                  <a href={studentAppUrl} target="_blank" rel="noreferrer" className="btn primary">
                    <Icon name="externalLink" />
                    <span>Testar App Agora</span>
                  </a>
                </div>
              </div>

              {isManager && (
                <Section title="Política de Auto-Cadastro no App">
                  <Row
                    icon="lock"
                    iconTint="var(--indigo)"
                    title="Exigir Código de Convite"
                    subtitle="Apenas alunos matriculados na recepção ou com código podem criar conta"
                  >
                    <Switch
                      checked={Boolean(tenant.settings?.inviteOnly)}
                      label="Exigir Código de Convite"
                      onChange={val => handleUpdateSetting({ ...(tenant.settings || {}), inviteOnly: val })}
                    />
                  </Row>
                  <Row
                    icon="person"
                    iconTint="var(--teal)"
                    title="Permitir Demonstração (Visitante)"
                    subtitle="Permite testar o app sem login antes da matrícula (experimental)"
                  >
                    <Switch
                      checked={Boolean(tenant.settings?.allowGuest)}
                      label="Permitir Visitante"
                      onChange={val => handleUpdateSetting({ ...(tenant.settings || {}), allowGuest: val })}
                    />
                  </Row>
                </Section>
              )}
            </div>

            <div className="card" style={{ margin: 0 }} data-tour="gym-invite-card">
              <CardHead
                icon="key"
                iconTint="var(--orange)"
                title="Códigos de Convite da Unidade"
                subtitle="Gere códigos únicos para enviar a novos alunos matriculados"
              />

              <form onSubmit={handleCreateInvite} className="b2b-invite-form">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <TextField
                    placeholder="Identificação (ex: Matrícula Plano Anual - Mariana)"
                    value={inviteNote}
                    onChange={setInviteNote}
                  />
                </div>
                <Button type="submit" variant="primary" icon="plus" disabled={creatingInvite}>
                  Gerar
                </Button>
              </form>

              {invites.length === 0 ? (
                <EmptyState
                  icon="key"
                  title="Nenhum convite emitido"
                  message="Você pode matricular alunos diretamente na aba Alunos ou gerar convites de auto-cadastro aqui."
                />
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 380, overflowY: 'auto' }}>
                  {invites.map(inv => (
                    <div key={inv.code} className="b2b-invite-row">
                      <div style={{ minWidth: 0, flex: '1 1 180px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <code style={{ fontWeight: 800, fontSize: 15, letterSpacing: '0.06em' }}>{inv.code}</code>
                          <StatusPill tone={inv.usedBy ? 'muted' : 'ok'}>
                            {inv.usedBy ? `Usado por ${inv.usedByName || 'aluno'}` : 'Disponível'}
                          </StatusPill>
                        </div>
                        {inv.note && <div className="muted small" style={{ marginTop: 2, overflowWrap: 'anywhere' }}>{inv.note}</div>}
                      </div>
                      {!inv.usedBy && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', maxWidth: '100%' }}>
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="chat"
                            style={{ color: 'var(--green)' }}
                            title="Enviar Convite no WhatsApp"
                            onClick={() => {
                              const gymName = tenant.name || (isPersonal ? 'sua consultoria' : 'nossa academia');
                              const defaultMsg = `Olá! 🎉 Seja muito bem-vindo(a) à *${gymName}*!\n\nSeu treino personalizado já está disponível no nosso aplicativo oficial *Rit*.\n\nSeu código exclusivo de acesso: *${inv.code}*\n\nAcesse o app pelo link:\n${studentAppUrl}\n\nQualquer dúvida, conte com seu professor e com nossa equipe!`;
                              setWaSendModal({
                                studentId: null,
                                studentName: inv.note ? `Convidado (${inv.note})` : 'Novo Aluno',
                                phone: '',
                                message: defaultMsg,
                                type: 'invite'
                              });
                            }}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="copy"
                            title="Copiar código"
                            onClick={() => {
                              navigator.clipboard?.writeText(inv.code);
                              toast(`Código ${inv.code} copiado!`);
                            }}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="trash"
                            title="Revogar convite"
                            style={{ color: 'var(--red)' }}
                            onClick={() => handleRevokeInvite(inv.code)}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* =================================================================
          ABA 5.1: MINHA ASSINATURA & COBRANÇA PIX (MERCADO PAGO)
         ================================================================= */}
      {activeTab === 'billing' && (
        <div>
          <div className="b2b-page-head" data-tour="gym-billing-head">
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <h1>Minha Assinatura</h1>
                <StatusPill tone={tenant.status === 'active' ? 'ok' : (tenant.status === 'trial' ? 'accent' : 'bad')}>
                  {tenant.status === 'active'
                    ? 'Assinatura Ativa'
                    : (tenant.status === 'trial'
                        ? 'Período de Degustação'
                        : (tenant.status === 'past_due' ? 'Fatura Pendente' : 'Suspensa'))}
                </StatusPill>
              </div>
              <p>
                {isPersonal
                  ? 'Acompanhe seu plano de consultoria, limites de alunos, renovação da assinatura e faturas pagas via PIX.'
                  : 'Acompanhe o plano da sua unidade, limites contratados, renovação da assinatura e faturas pagas via PIX.'}
              </p>
            </div>
            <div className="b2b-head-actions">
              <Button variant="primary" icon="creditCard" onClick={() => openPixCheckout()}>
                Renovar ou Mudar de Plano (PIX)
              </Button>
            </div>
          </div>

          {/* Alerta quando o painel está restrito ao pagamento (trial expirado ou fatura vencida) */}
          {(billingLocked || billingData?.accessBlocked) && (
            <div style={{
              marginBottom: 20,
              padding: '14px 16px',
              borderRadius: 12,
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.35)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap'
            }}>
              <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--fg)' }}>
                <strong>
                  {billingData?.blockReason === 'trial_expired'
                    ? 'Período de degustação encerrado.'
                    : 'Assinatura com pagamento pendente.'}
                </strong>{' '}
                O acesso de alunos, professores e cadastros fica bloqueado até a confirmação do PIX abaixo.
              </div>
              <Button variant="primary" size="sm" icon="creditCard" onClick={() => openPixCheckout()}>
                Pagar via PIX agora
              </Button>
            </div>
          )}

          {/* Cards de Resumo da Assinatura Atual */}
          <div className="b2b-kpi-grid" style={{ marginBottom: 24 }}>
            <KpiTile
              label="Plano Vigente"
              value={tenant.planName || (isPersonal ? 'Personal Completo' : 'Estúdio')}
              sub={`Mensalidade base: R$ ${tenant.mrr || (isPersonal ? 49 : 169)} /mês`}
              icon="dumbbell"
              tint="var(--acc)"
            />
            <KpiTile
              label="Próximo Vencimento"
              value={tenant.nextBillingAt ? fmtDateBR(tenant.nextBillingAt) : 'Sem data definida'}
              sub={tenant.status === 'active' ? 'Renovação automática via PIX' : 'Aguardando regularização'}
              icon="calendar"
              tint={tenant.status === 'active' ? 'var(--green)' : 'var(--red)'}
            />
            <KpiTile
              label="Limite de Alunos"
              value={`${kpis.totalStudents || 0} / ${tenant.limits?.maxStudents >= 100000 ? 'Ilimitado' : (tenant.limits?.maxStudents || 'Ilimitado')}`}
              sub={tenant.limits?.maxStudents >= 100000 ? 'Sem limite de alunos cadastrados' : 'Vagas do plano contratado'}
              icon="users"
              tint="var(--acc)"
              onClick={() => onChangeTab?.('students')}
            />
            <KpiTile
              label="Limite de Treinadores"
              value={`${team.length} / ${tenant.limits?.maxTrainers >= 100000 ? 'Ilimitado' : (tenant.limits?.maxTrainers || 1)}`}
              sub={isPersonal ? 'Acesso individual do Personal' : 'Treinadores autorizados no salão'}
              icon="personCircle"
              tint="var(--blue)"
              onClick={() => onChangeTab?.('team')}
            />
          </div>

          {/* Seção: Planos Oficiais da Rit */}
          <div className="card" style={{ marginBottom: 24 }}>
            <CardHead
              icon="creditCard"
              iconTint="var(--acc)"
              title="Planos & Valores Oficiais Rit"
              subtitle="Escolha seu plano e economize até 18% optando pelo pagamento anual via PIX"
            />
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))',
              gap: 16,
              marginTop: 12
            }}>
              {(billingData?.availablePlans?.length ? billingData.availablePlans : [
                { id: 'personal', name: 'Personal Inicial', accountType: 'personal', priceMonthly: 29, priceAnnualMonthly: 24, maxStudents: 10, maxTrainers: 1 },
                { id: 'personal-pro', name: 'Personal Completo', accountType: 'personal', priceMonthly: 49, priceAnnualMonthly: 39, maxStudents: 100000, maxTrainers: 1 },
                { id: 'starter', name: 'Estúdio', accountType: 'gym', priceMonthly: 169, priceAnnualMonthly: 139, maxStudents: 150, maxTrainers: 3 },
                { id: 'pro', name: 'Academia Completa', accountType: 'gym', priceMonthly: 269, priceAnnualMonthly: 219, maxStudents: 100000, maxTrainers: 100000 }
              ]).map(p => {
                const isCurrent = (tenant.planId === p.id) || (!tenant.planId && isPersonal && p.id === 'personal-pro') || (!tenant.planId && !isPersonal && p.id === 'starter');
                const isTargetForType = isPersonal ? p.accountType === 'personal' : p.accountType === 'gym';
                return (
                  <div
                    key={p.id}
                    style={{
                      border: isCurrent ? '2px solid var(--acc)' : '1px solid var(--sep)',
                      borderRadius: 14,
                      padding: '18px 16px',
                      background: isCurrent ? 'var(--surface-2)' : 'var(--surface-1)',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      position: 'relative'
                    }}
                  >
                    {isCurrent && (
                      <span style={{
                        position: 'absolute',
                        top: -10,
                        right: 14,
                        background: 'var(--acc)',
                        color: 'var(--on-acc)',
                        fontSize: 10,
                        fontWeight: 800,
                        padding: '2px 8px',
                        borderRadius: 99,
                        textTransform: 'uppercase',
                        letterSpacing: 0.5
                      }}>
                        Plano Atual
                      </span>
                    )}
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 8 }}>
                        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{p.name}</h3>
                        <span className="muted small" style={{ textTransform: 'uppercase', fontSize: 10, fontWeight: 700 }}>
                          {p.accountType === 'personal' ? 'Personal' : 'Academia'}
                        </span>
                      </div>

                      <div style={{ margin: '14px 0 10px 0' }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                          <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>R$</span>
                          <span style={{ fontSize: 26, fontWeight: 800, color: 'var(--acc)' }}>{p.priceMonthly}</span>
                          <span style={{ fontSize: 13, color: 'var(--muted)' }}>/mês no PIX</span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--green)', marginTop: 4, fontWeight: 600 }}>
                          Ou R$ {p.priceAnnualMonthly} /mês no plano anual
                        </div>
                      </div>

                      <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 18px 0', fontSize: 12.5, lineHeight: 1.8 }}>
                        <li style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ color: 'var(--green)' }}>✓</span>
                          <span><strong>{p.maxStudents >= 100000 ? 'Alunos Ilimitados' : `Até ${p.maxStudents} alunos`}</strong></span>
                        </li>
                        <li style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ color: 'var(--green)' }}>✓</span>
                          <span>{p.maxTrainers >= 100000 ? 'Treinadores Ilimitados' : (p.maxTrainers === 1 ? '1 Acesso de Professor' : `Até ${p.maxTrainers} treinadores`)}</span>
                        </li>
                        <li style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ color: 'var(--green)' }}>✓</span>
                          <span>+5.600 Exercícios com Animação 3D</span>
                        </li>
                        <li style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ color: 'var(--green)' }}>✓</span>
                          <span>Robô de Treinos e Alertas WhatsApp</span>
                        </li>
                      </ul>
                    </div>

                    <Button
                      variant={isCurrent ? 'ghost' : (isTargetForType ? 'primary' : 'ghost')}
                      size="sm"
                      icon="creditCard"
                      onClick={() => openPixCheckout(p.id)}
                      style={{ width: '100%', marginTop: 8 }}
                    >
                      {isCurrent ? 'Renovar com PIX' : 'Escolher este Plano (PIX)'}
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Tabela de Histórico de Faturas & Pagamentos */}
          <div className="card">
            <CardHead
              icon="activity"
              iconTint="var(--acc)"
              title="Histórico de Faturas & Pagamentos"
              subtitle="Comprovantes e faturas geradas para sua unidade"
            />
            {loadingBilling ? (
              <div style={{ padding: '30px 0', textAlign: 'center' }} className="muted">
                Carregando faturas...
              </div>
            ) : (!tenant.invoices || tenant.invoices.length === 0) ? (
              <EmptyState
                icon="creditCard"
                title="Nenhuma fatura registrada"
                message="Suas faturas pagas e pendentes aparecerão aqui após a primeira cobrança via PIX."
              />
            ) : (
              <div className="b2b-table-wrap b2b-table-wrap-stack">
                <table className="b2b-table b2b-table-stack">
                  <thead>
                    <tr>
                      <th>Referência</th>
                      <th>Descrição / Plano</th>
                      <th>Valor</th>
                      <th>Forma</th>
                      <th>Status</th>
                      <th>Data</th>
                      <th style={{ textAlign: 'right' }}>Ação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tenant.invoices.map(inv => {
                      const isPaid = inv.status === 'paid';
                      return (
                        <tr key={inv.id || inv.refMonth}>
                          <td className="b2b-td-main"><strong>{inv.refMonth || 'Mensal'}</strong></td>
                          <td data-label="Descrição">{inv.note || inv.planName || 'Assinatura Rit'}</td>
                          <td data-label="Valor"><strong>R$ {Number(inv.amount || 0).toFixed(2).replace('.', ',')}</strong></td>
                          <td data-label="Forma">{inv.method || 'PIX'}</td>
                          <td data-label="Status">
                            <StatusPill tone={isPaid ? 'ok' : 'bad'}>
                              {isPaid ? 'Paga' : 'Pendente'}
                            </StatusPill>
                          </td>
                          <td data-label="Data" className="muted small">
                            {inv.paidAt ? fmtDateBR(inv.paidAt) : (inv.createdAt ? fmtDateBR(inv.createdAt) : '—')}
                          </td>
                          <td className="b2b-td-actions" style={{ textAlign: 'right' }}>
                            {!isPaid && (
                              <Button
                                size="xs"
                                variant="primary"
                                icon="creditCard"
                                onClick={() => {
                                  if (inv.qrCode) {
                                    setActivePix({
                                      invoiceId: inv.id,
                                      amount: inv.amount,
                                      cycle: inv.cycle || 'monthly',
                                      planId: inv.planId || tenant.planId,
                                      qrCode: inv.qrCode,
                                      qrCodeBase64: inv.qrCodeBase64,
                                      ticketUrl: inv.ticketUrl,
                                      expiresAt: inv.expiresAt,
                                      mock: String(inv.mpPaymentId || '').startsWith('mp_sim_'),
                                      simulationAllowed: Boolean(billingData?.simulationAllowed ?? demoAllowed)
                                    });
                                    setPixModalOpen(true);
                                  } else {
                                    openPixCheckout(inv.planId);
                                  }
                                }}
                              >
                                Pagar com PIX
                              </Button>
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
          ABA 6: CONFIGURAÇÕES DA UNIDADE & IDENTIDADE DO APLICATIVO
         ================================================================= */}
      {(activeTab === 'settings' || activeTab === 'branding') && (
        <div>
          <div className="b2b-page-head">
            <div>
              <h1>{isPersonal ? 'Configurações da Consultoria' : 'Configurações da Academia'}</h1>
              <p>
                {isPersonal
                  ? 'Configure os parâmetros da sua consultoria, canais de atendimento, regras operacionais e a identidade do aplicativo dos alunos.'
                  : 'Configure os parâmetros da sua unidade, canais de atendimento, regras operacionais e a identidade do aplicativo dos alunos.'}
              </p>
            </div>
          </div>

          <div className="b2b-grid-2" style={{ alignItems: 'start' }}>
            <form className="card" style={{ margin: 0 }} data-tour="gym-branding-card" onSubmit={handleSaveBranding}>
              <CardHead
                icon="gear"
                iconTint="var(--acc)"
                title={isPersonal ? 'Configurações & Parâmetros do Personal' : 'Configurações & Parâmetros da Unidade'}
                subtitle="As alterações refletem imediatamente no aplicativo dos seus alunos"
              />

              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="b2b-form-grid">
                  <TextField
                    label="Nome Exibido no App do Aluno"
                    required
                    value={brandForm.gymName}
                    onChange={v => setBrandForm(p => ({ ...p, gymName: v }))}
                  />
                  <TextField
                    label="Slogan / Frase de Destaque"
                    value={brandForm.slogan}
                    onChange={v => setBrandForm(p => ({ ...p, slogan: v }))}
                    placeholder="Ex: Treine pesado, evolua todo dia"
                  />
                </div>

                <div>
                  <div className="b2b-field-lbl" style={{ marginBottom: 8 }}>Cor de Destaque Principal (Botões, Gráficos e Conquistas)</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    {BRAND_SWATCHES.map(hex => (
                      <button
                        type="button"
                        key={hex}
                        onClick={() => {
                          setBrandForm(p => ({ ...p, primaryColor: hex }));
                          applyPortalAccent(hex);
                        }}
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: '50%',
                          background: hex,
                          border: brandForm.primaryColor.toLowerCase() === hex ? '3px solid var(--label)' : '2px solid transparent',
                          cursor: 'pointer'
                        }}
                      />
                    ))}
                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '4px 10px 4px 6px',
                        borderRadius: 99,
                        background: 'var(--b2b-input-bg)',
                        border: '1px solid var(--b2b-input-border)',
                        cursor: 'pointer'
                      }}
                    >
                      <input
                        type="color"
                        value={brandForm.primaryColor}
                        onChange={e => {
                          const c = e.target.value;
                          setBrandForm(p => ({ ...p, primaryColor: c }));
                          applyPortalAccent(c);
                        }}
                        style={{ width: 26, height: 26, border: 'none', padding: 0, background: 'transparent', cursor: 'pointer' }}
                      />
                      <code className="small muted">{brandForm.primaryColor}</code>
                    </label>
                  </div>
                </div>

                <div className="b2b-form-grid">
                  <TextField
                    label={isPersonal ? 'WhatsApp de Atendimento' : 'WhatsApp da Recepção'}
                    value={brandForm.contactPhone}
                    onChange={v => setBrandForm(p => ({ ...p, contactPhone: v }))}
                    placeholder="(11) 99999-0000"
                  />
                  <TextField
                    label={isPersonal ? 'Instagram Profissional' : 'Instagram da Unidade'}
                    value={brandForm.instagram}
                    onChange={v => setBrandForm(p => ({ ...p, instagram: v }))}
                    placeholder={isPersonal ? '@seuperfil' : '@suaacademia'}
                  />
                </div>

                <div className="b2b-form-grid">
                  <TextField
                    label={isPersonal ? 'Local de Atendimento / Cidade' : 'Endereço da Unidade'}
                    value={brandForm.address}
                    onChange={v => setBrandForm(p => ({ ...p, address: v }))}
                    placeholder={isPersonal ? 'Ex: Consultoria Online / São Paulo - SP' : 'Rua, número e bairro'}
                  />
                  <NumberField
                    label="Janela de Alerta Anti-Evasão"
                    min={2}
                    max={60}
                    suffix="dias"
                    hint="Dias sem treino para avisar o professor"
                    value={brandForm.churnDaysThreshold}
                    onChange={v => setBrandForm(p => ({ ...p, churnDaysThreshold: v }))}
                  />
                </div>

                <SelectField
                  label="Campanha & Tema Sazonal no App dos Alunos"
                  value={brandForm.seasonalTheme || 'auto'}
                  onChange={v => setBrandForm(p => ({ ...p, seasonalTheme: v }))}
                  hint="Adiciona detalhes temáticos sutis no app sem alterar a cor principal da sua marca"
                  options={[
                    { value: 'auto', label: 'Automático pelo Calendário (Verão em Jan/Fev, Halloween em Out, Natal em Dez)' },
                    { value: 'verao', label: '☀️ Projeto Verão (Ativar campanha de Verão & Hidratação agora)' },
                    { value: 'halloween', label: '🎃 Halloween Fitness (Ativar campanha de Outubro agora)' },
                    { value: 'christmas', label: '🎄 Especial de Fim de Ano (Ativar campanha de Natal & Desafios agora)' },
                    { value: 'off', label: 'Desativado (Manter somente o tema clássico o ano inteiro)' }
                  ]}
                />

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div className="b2b-field-lbl">Logotipo da Academia / Foto do Personal (Opcional)</div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <label className="btn tinted sm" style={{ cursor: 'pointer' }}>
                      <Icon name="plus" size={15} />
                      <span>Enviar Imagem do Computador / Celular</span>
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={handleLogoFileUpload}
                      />
                    </label>
                    {brandForm.logoUrl && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        icon="trash"
                        style={{ color: 'var(--red)' }}
                        onClick={() => setBrandForm(p => ({ ...p, logoUrl: '' }))}
                      >
                        Remover Logo
                      </Button>
                    )}
                  </div>
                  <TextField
                    value={brandForm.logoUrl.startsWith('data:image/') ? '' : brandForm.logoUrl}
                    onChange={v => setBrandForm(p => ({ ...p, logoUrl: v }))}
                    placeholder={
                      brandForm.logoUrl.startsWith('data:image/')
                        ? '✓ Imagem enviada do dispositivo (ou cole uma URL pública https://...)'
                        : 'Ou cole uma URL pública de imagem (https://...)'
                    }
                  />
                  {brandForm.logoUrl.startsWith('blob:') && (
                    <div className="small" style={{ color: 'var(--orange)' }}>
                      Atenção: links iniciados com <code>blob:</code> (como do ChatGPT) são temporários daquela aba e não abrem no app. Clique em <b>Enviar Imagem do Computador / Celular</b> acima para subir o arquivo real!
                    </div>
                  )}
                </div>

                {/* Automação WhatsApp & Notificação de Treinos */}
                <div data-tour="gym-whatsapp-box" style={{ padding: '16px 14px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--sep)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <Icon name="chat" size={18} style={{ color: 'var(--green)' }} />
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>Relatório Automático de Treinos Concluídos</div>
                        <div className="muted small">Envia o resumo de cargas, tempo e novos recordes ao professor responsável assim que o aluno conclui o treino.</div>
                      </div>
                    </div>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={brandForm.notifyTrainerOnWorkout}
                        onChange={e => setBrandForm(p => ({ ...p, notifyTrainerOnWorkout: e.target.checked }))}
                      />
                      <span style={{ fontSize: 13, fontWeight: 600 }}>Ativo</span>
                    </label>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 10, borderTop: '1px solid var(--sep)', marginBottom: 8, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <Icon name="dumbbell" size={18} style={{ color: 'var(--accent)' }} />
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>Avisar Aluno ao Prescrever Nova Ficha</div>
                        <div className="muted small">Dispara no WhatsApp do aluno um aviso automático sempre que o professor liberar ou atualizar uma ficha de treino.</div>
                      </div>
                    </div>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={brandForm.notifyStudentOnPrescribe}
                        onChange={e => setBrandForm(p => ({ ...p, notifyStudentOnPrescribe: e.target.checked }))}
                      />
                      <span style={{ fontSize: 13, fontWeight: 600 }}>Ativo</span>
                    </label>
                  </div>

                  {/* Destino dos Relatórios & Status da Conexão */}
                  <div style={{
                    marginTop: 10,
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: 'var(--surface-1)',
                    border: '1px solid var(--sep)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    flexWrap: 'wrap'
                  }}>
                    <div style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span className="muted">Destino dos avisos gerais (Recepção / Atendimento):</span>
                      <strong style={{ color: brandForm.contactPhone ? 'var(--label)' : 'var(--orange)' }}>
                        {brandForm.contactPhone ? brandForm.contactPhone : '(Preencha o WhatsApp de Atendimento acima)'}
                      </strong>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {waStatus?.outbox && (
                        <span className="muted small" style={{ fontSize: 11.5 }}>
                          Entregues: <b>{waStatus.outbox.sentCount || 0}</b>
                          {waStatus.outbox.queuedCount > 0 && (
                            <span style={{ color: 'var(--orange)', marginLeft: 8 }}>
                              • Fila de Reenvio: <b>{waStatus.outbox.queuedCount}</b>
                            </span>
                          )}
                        </span>
                      )}
                      {waStatus?.connected ? (
                        <span style={{ fontSize: 12, padding: '4px 10px', borderRadius: 99, background: 'rgba(34, 197, 94, 0.15)', color: 'var(--green)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          🟢 Notificações Ativas via Rit
                        </span>
                      ) : (
                        <span style={{ fontSize: 12, padding: '4px 10px', borderRadius: 99, background: 'rgba(234, 179, 8, 0.15)', color: 'var(--orange, #eab308)', fontWeight: 600 }}>
                          ⚪ Notificações em Configuração
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={{ marginTop: 9, fontSize: 12, lineHeight: 1.45 }} className="muted">
                    💡 <b>Acompanhamento Personalizado + Fila Anti-Falha:</b> Se o WhatsApp oscilar no momento do envio, o Rit guarda o aviso na fila inteligente e reenvia automaticamente assim que a conexão voltar.
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
                    <Button
                      type="button"
                      variant="tinted"
                      size="sm"
                      icon="chat"
                      disabled={testingWa || !brandForm.contactPhone}
                      onClick={handleTestWhatsApp}
                      style={{ color: 'var(--green)' }}
                    >
                      {testingWa ? 'Enviando Teste...' : 'Enviar WhatsApp de Teste'}
                    </Button>
                    {waStatus?.outbox?.queuedCount > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={retryingOutbox}
                        onClick={handleRetryOutbox}
                      >
                        {retryingOutbox ? 'Reenviando...' : `Reenviar Fila (${waStatus.outbox.queuedCount})`}
                      </Button>
                    )}
                  </div>
                </div>

                {isManager && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                    <Button type="submit" variant="primary" icon="check" block disabled={savingBrand}>
                      {savingBrand ? 'Salvando Configurações...' : 'Salvar Configurações'}
                    </Button>
                  </div>
                )}
              </div>
            </form>

            {/* Preview Mobile ao Vivo */}
            <div
              className="card"
              style={{
                margin: 0,
                padding: '22px 20px 26px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                position: 'sticky',
                top: 82
              }}
            >
              <div className="muted small" style={{ marginBottom: 14, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Simulação em Tempo Real — App do Aluno
              </div>

              {(() => {
                const accentHex = brandForm.primaryColor || '#D0FF00';
                const accentFg = inkOn(accentHex);
                return (
                  <div className="b2b-phone-preview">
                    {/* Status Bar simulada */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.72)', marginBottom: 14, padding: '0 4px' }}>
                      <span>09:41</span>
                      <span style={{ width: 64, height: 16, borderRadius: 99, background: '#18181b' }} />
                      <span>5G · 100%</span>
                    </div>

                    {/* Header White-Label */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 14 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            width: 36,
                            height: 36,
                            borderRadius: 10,
                            background: accentHex,
                            color: accentFg,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                            overflow: 'hidden'
                          }}
                        >
                          {brandForm.logoUrl ? (
                            <img
                              src={brandForm.logoUrl}
                              alt=""
                              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                              onError={e => { e.currentTarget.style.display = 'none'; }}
                            />
                          ) : (
                            <Icon name="dumbbell" size={18} />
                          )}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontWeight: 800, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {brandForm.gymName || 'Sua Academia'}
                            </span>
                            <span style={{ fontSize: 9.5, background: 'rgba(255,255,255,0.1)', color: accentHex, padding: '1px 5px', borderRadius: 4, fontWeight: 800 }}>
                              Rit
                            </span>
                          </div>
                          <div style={{ fontSize: 11, color: 'rgba(235,235,245,0.62)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {brandForm.slogan || (isPersonal ? 'Consultoria & Treinos' : 'App Oficial da Academia')}
                          </div>
                        </div>
                      </div>
                      <Icon name="flame" size={18} style={{ color: accentHex, flexShrink: 0 }} />
                    </div>

                    {brandForm.seasonalTheme && brandForm.seasonalTheme !== 'off' && (
                      <div
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 10px',
                          borderRadius: 999,
                          fontSize: 11,
                          fontWeight: 700,
                          marginBottom: 12,
                          background: 'rgba(251, 191, 36, 0.12)',
                          border: '1px solid rgba(251, 191, 36, 0.28)',
                          color: '#fde047'
                        }}
                      >
                        <span>
                          {brandForm.seasonalTheme === 'verao'
                            ? '☀️ Campanha Ativa: Projeto Verão'
                            : brandForm.seasonalTheme === 'halloween'
                              ? '🎃 Campanha Ativa: Halloween Fitness'
                              : brandForm.seasonalTheme === 'christmas'
                                ? '🎄 Campanha Ativa: Especial Fim de Ano'
                                : '✨ Temas Sazonais: Automático'}
                        </span>
                      </div>
                    )}

                    {/* Card da Ficha Prescrita */}
                    <div style={{ background: '#18181c', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: 14, marginBottom: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
                        <span style={{ fontSize: 10.5, color: 'rgba(235,235,245,0.6)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.04em' }}>
                          Ficha de Hoje • {brandForm.gymName || tenant.name || (isPersonal ? 'Personal' : 'Academia')}
                        </span>
                        <span style={{ fontSize: 9.5, color: accentHex, fontWeight: 800 }}>
                          No App Rit
                        </span>
                      </div>
                      <div style={{ fontWeight: 800, fontSize: 16, margin: '2px 0 3px' }}>
                        Treino A — Superiores
                      </div>
                      <div style={{ fontSize: 11.5, color: 'rgba(235,235,245,0.72)', marginBottom: 12 }}>
                        Prescrito por <b>{team?.[0]?.name ? `Prof. ${team[0].name}` : isPersonal ? (brandForm.gymName || 'Seu Personal') : 'Professor da Unidade'}</b>
                      </div>
                      <div style={{ fontSize: 12.5, color: 'rgba(235,235,245,0.82)', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>1. Supino Reto c/ Barra</span>
                          <b className="num" style={{ flexShrink: 0 }}>4×10</b>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>2. Desenvolvimento Halteres</span>
                          <b className="num" style={{ flexShrink: 0 }}>3×12</b>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>3. Tríceps Corda Polia</span>
                          <b className="num" style={{ flexShrink: 0 }}>3×15</b>
                        </div>
                      </div>
                      <div
                        style={{
                          background: accentHex,
                          color: accentFg,
                          fontWeight: 800,
                          fontSize: 13.5,
                          borderRadius: 11,
                          padding: '10px 12px',
                          textAlign: 'center'
                        }}
                      >
                        Iniciar Treino Agora
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, margin: '2px 0 10px', fontSize: 10.5, color: 'rgba(235,235,245,0.45)' }}>
                      <span>Plataforma</span>
                      <b style={{ color: accentHex }}>Rit</b>
                      <span>• {brandForm.gymName || tenant.name || 'Sua Academia'}</span>
                    </div>

                    {(brandForm.contactPhone || brandForm.instagram || brandForm.address) && (
                      <div style={{ background: '#141417', borderRadius: 12, padding: '8px 11px', marginBottom: 12, fontSize: 11, color: 'rgba(235,235,245,0.65)', display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {brandForm.address && (
                          <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {brandForm.address}
                          </div>
                        )}
                        {(brandForm.contactPhone || brandForm.instagram) && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <span>{brandForm.contactPhone || ''}</span>
                            <span style={{ color: accentHex, fontWeight: 600 }}>{brandForm.instagram || ''}</span>
                          </div>
                        )}
                      </div>
                    )}

                    <div style={{ display: 'flex', justifyContent: 'space-around', paddingTop: 10, borderTop: '0.5px solid rgba(255,255,255,0.12)', color: 'rgba(235,235,245,0.5)' }}>
                      <Icon name="house" size={19} style={{ color: accentHex }} />
                      <Icon name="calendar" size={19} />
                      <Icon name="chart" size={19} />
                      <Icon name="gear" size={19} />
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* =================================================================
          MODAIS DO PAINEL DA ACADEMIA
         ================================================================= */}

      {/* Estúdio Completo de Prescrição & Modelos (5.632 Exercícios) */}
      <WorkoutBuilderModal
        open={builderState.open}
        onClose={() => {
          setBuilderState(prev => ({ ...prev, open: false }));
          if (returnToDossierStudentId) {
            const stId = returnToDossierStudentId;
            setReturnToDossierStudentId(null);
            openStudentDossier(stId, 'routines');
          }
        }}
        mode={builderState.mode}
        student={builderState.student}
        initialRoutine={builderState.initialRoutine}
        initialDays={builderState.initialDays}
        templates={templates}
        onSaved={async () => {
          await loadAllGymData(true);
          const stId = builderState.student?.id || returnToDossierStudentId;
          setBuilderState(prev => ({ ...prev, open: false }));
          if (stId) {
            setReturnToDossierStudentId(null);
            await openStudentDossier(stId, 'routines');
          }
        }}
      />

      {/* Modal: Matricular Novo Aluno */}
      <Modal
        open={enrollOpen}
        onClose={() => setEnrollOpen(false)}
        size="lg"
        title="Matricular Novo Aluno na Unidade"
        subtitle="Cria o acesso do aluno no aplicativo e já pode enviar uma ficha inicial automaticamente."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEnrollOpen(false)}>Cancelar</Button>
            <Button variant="primary" icon="check" onClick={handleEnrollStudent} disabled={enrolling}>
              {enrolling ? 'Matriculando...' : 'Concluir Matrícula'}
            </Button>
          </>
        }
      >
        <form onSubmit={handleEnrollStudent} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="b2b-form-grid">
            <TextField
              label="Nome Completo do Aluno"
              required
              placeholder="Ex: Rafael Oliveira"
              value={enrollForm.name}
              onChange={v => setEnrollForm(p => ({ ...p, name: v }))}
            />
            <TextField
              label="WhatsApp / Celular"
              placeholder="(11) 99999-0000"
              value={enrollForm.phone}
              onChange={v => setEnrollForm(p => ({ ...p, phone: v }))}
            />
            <TextField
              label="E-mail de Login no App"
              type="email"
              placeholder="aluno@email.com"
              value={enrollForm.email}
              onChange={v => setEnrollForm(p => ({ ...p, email: v }))}
            />
            <TextField
              label="Senha Inicial do App"
              placeholder="Mínimo de 10 caracteres"
              required
              value={enrollForm.password}
              onChange={v => setEnrollForm(p => ({ ...p, password: v }))}
            />
            <SelectField
              label="Objetivo Principal"
              value={enrollForm.goal}
              onChange={v => setEnrollForm(p => ({ ...p, goal: v }))}
              options={[
                { value: 'Hipertrofia & Força', label: 'Hipertrofia & Ganho Muscular' },
                { value: 'Emagrecimento & Definição', label: 'Emagrecimento & Definição' },
                { value: 'Adaptação / Iniciante', label: 'Adaptação / Iniciante' },
                { value: 'Condicionamento & Saúde', label: 'Condicionamento & Saúde' },
                { value: 'Performance Esportiva', label: 'Performance Esportiva' }
              ]}
            />
            <SelectField
              label="Professor Responsável"
              value={enrollForm.assignedTrainerId}
              onChange={v => setEnrollForm(p => ({ ...p, assignedTrainerId: v }))}
              options={[
                { value: '', label: '— Qualquer professor da equipe —' },
                ...team.map(m => ({ value: m.id, label: m.name }))
              ]}
            />
          </div>

          <SelectField
            label="Ficha Inicial Automática (Opcional)"
            hint="O aluno já abre o aplicativo no 1º dia com esta ficha pronta para treinar"
            value={enrollForm.initialTemplateId}
            onChange={v => setEnrollForm(p => ({ ...p, initialTemplateId: v }))}
            options={[
              { value: '', label: '— Deixar para o professor montar depois —' },
              ...templates.map(t => ({ value: t.id, label: `${t.name} (${t.ex?.length || 0} exercícios)` }))
            ]}
          />

          <TextArea
            label="Observações / Anamnese Rápida (Restrições articulares, lesões, horários)"
            rows={2}
            value={enrollForm.notes}
            onChange={v => setEnrollForm(p => ({ ...p, notes: v }))}
            placeholder="Ex: Condromalácia patelar leve; evitar agachamento profundo livre nas primeiras 4 semanas."
          />
        </form>
      </Modal>

      {/* Modal: Aplicar Modelo Rápido para Aluno */}
      <Modal
        open={Boolean(applyTplModal)}
        onClose={() => setApplyTplModal(null)}
        size="md"
        title={applyTplModal ? `Enviar "${applyTplModal.name}" para Aluno` : ''}
        subtitle="Sincroniza imediatamente a ficha no aplicativo do aluno escolhido"
        footer={
          <>
            <Button variant="ghost" onClick={() => setApplyTplModal(null)}>Cancelar</Button>
            <Button variant="primary" icon="check" onClick={handleQuickApplyTemplate} disabled={applyingTpl}>
              {applyingTpl ? 'Sincronizando...' : 'Prescrever no App do Aluno'}
            </Button>
          </>
        }
      >
        <form onSubmit={handleQuickApplyTemplate} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SelectField
            label="Selecione o Aluno"
            value={applyStudentId}
            onChange={setApplyStudentId}
            options={[
              { value: '', label: '— Escolha um aluno ativo —' },
              ...students.filter(s => !s.disabled).map(s => ({
                value: s.id,
                label: `${s.name} (${s.routineCount} ficha(s) atuais)`
              }))
            ]}
          />

          <div>
            <div className="b2b-field-lbl" style={{ marginBottom: 8 }}>Agendar nos Dias da Semana</div>
            <div className="b2b-days-row">
              {WEEKDAY_MAP.map(w => (
                <button
                  type="button"
                  key={w.d}
                  className={'b2b-day-pill' + (applyDays.includes(w.d) ? ' on' : '')}
                  onClick={() =>
                    setApplyDays(prev =>
                      prev.includes(w.d) ? prev.filter(x => x !== w.d) : [...prev, w.d].sort()
                    )
                  }
                >
                  {w.short}
                </button>
              ))}
            </div>
          </div>
        </form>
      </Modal>

      {/* Modal: Prontuário Completo do Aluno */}
      <Modal
        open={dossierOpen}
        onClose={() => setDossierOpen(false)}
        size="xl"
        title={dossierData?.student ? `Prontuário do Aluno — ${dossierData.student.name}` : 'Prontuário do Aluno'}
        subtitle={dossierData?.student ? `${dossierData.student.goal || 'Aluno Matriculado'} ${dossierData.student.email ? `· ${dossierData.student.email}` : ''}` : ''}
        footer={
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {dossierData?.student?.phone && (
                <Button
                  variant="tinted"
                  size="sm"
                  icon="chat"
                  style={{ color: 'var(--green)' }}
                  onClick={() => handleOpenStudentWhatsApp(dossierData.student, 'general')}
                >
                  Enviar WhatsApp ao Aluno
                </Button>
              )}
              {dossierData?.student && (
                <>
                  <Button
                    variant="tinted"
                    size="sm"
                    icon="download"
                    disabled={exportingPdf}
                    onClick={async () => {
                      setExportingPdf(true);
                      try {
                        const profName = team.find(t => t.id === dossierData.student.assignedTrainerId)?.name || user?.name || '';
                        const res = await exportStudentDossierPdf({
                          dossierData,
                          tenant,
                          branding: brandForm,
                          trainerName: profName
                        });
                        if (res?.ok) toast(`Relatório ${res.filename} baixado.`);
                        else toast('Não foi possível gerar o PDF do relatório.');
                      } catch {
                        toast('Erro ao gerar o PDF do relatório.');
                      } finally {
                        setExportingPdf(false);
                      }
                    }}
                  >
                    {exportingPdf ? 'Gerando PDF...' : 'Baixar Relatório (PDF)'}
                  </Button>
                  {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="share"
                      disabled={exportingPdf}
                      onClick={async () => {
                        setExportingPdf(true);
                        try {
                          const profName = team.find(t => t.id === dossierData.student.assignedTrainerId)?.name || user?.name || '';
                          const res = await shareStudentDossierPdf({
                            dossierData,
                            tenant,
                            branding: brandForm,
                            trainerName: profName
                          });
                          if (!res?.ok) toast('Não foi possível gerar o PDF para compartilhar.');
                          else if (!res.shared && !res.cancelled) toast(`Relatório ${res.filename} baixado.`);
                        } catch {
                          toast('Erro ao compartilhar o PDF do relatório.');
                        } finally {
                          setExportingPdf(false);
                        }
                      }}
                    >
                      Compartilhar PDF
                    </Button>
                  )}
                </>
              )}
            </div>
            <Button variant="ghost" onClick={() => setDossierOpen(false)}>Fechar Prontuário</Button>
          </div>
        }
      >
        {dossierLoading || !dossierData ? (
          <div style={{ padding: 36, textAlign: 'center' }} className="muted">Carregando prontuário e histórico do aluno...</div>
        ) : (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
              <Segmented
                value={dossierTab}
                onChange={setDossierTab}
                options={[
                  { value: 'routines', label: `Fichas & Agenda (${dossierData.state?.routines?.length || 0})` },
                  { value: 'history', label: `Treinos Realizados (${dossierData.state?.workouts?.length || 0})` },
                  { value: 'profile', label: 'Cadastro & Senha' }
                ]}
              />

              {dossierTab === 'routines' && (
                <Button
                  variant="primary"
                  size="sm"
                  icon="plus"
                  onClick={() => openPrescribeForStudent(dossierData.student)}
                >
                  Prescrever Nova Ficha
                </Button>
              )}
            </div>

            {/* Sub-aba 1: Fichas & Agenda Semanal */}
            {dossierTab === 'routines' && (
              <div>
                <div style={{ marginBottom: 18, padding: 14, borderRadius: 'var(--r)', background: 'var(--bg-el)', border: 'var(--hair) solid var(--sep)' }}>
                  <div className="b2b-field-lbl" style={{ marginBottom: 8 }}>Agenda Semanal no App do Aluno</div>
                  <div className="b2b-week-schedule-grid">
                    {WEEKDAY_MAP.map(w => {
                      const dayRIds = dossierData.state?.week?.[String(w.d)] || [];
                      const dayNames = dayRIds
                        .map(rid => dossierData.state?.routines?.find(r => r.id === rid)?.name)
                        .filter(Boolean);
                      return (
                        <div
                          key={w.d}
                          style={{
                            padding: '8px 6px',
                            borderRadius: 10,
                            background: dayNames.length ? 'var(--acc-soft)' : 'var(--surface)',
                            border: 'var(--hair) solid var(--sep)',
                            textAlign: 'center'
                          }}
                        >
                          <div style={{ fontWeight: 800, fontSize: 12, color: dayNames.length ? 'var(--acc-ink)' : 'var(--label-2)' }}>
                            {w.short}
                          </div>
                          <div style={{ fontSize: 11, marginTop: 4, lineHeight: 1.25 }}>
                            {dayNames.length ? dayNames.join(', ') : <span className="muted">Descanso</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {(dossierData.state?.routines || []).length === 0 ? (
                  <EmptyState
                    icon="dumbbell"
                    title="Aluno ainda sem ficha prescrita"
                    message="Clique em Prescrever Nova Ficha para montar o treino e sincronizar direto no celular do aluno."
                    action={
                      <Button variant="primary" icon="plus" onClick={() => openPrescribeForStudent(dossierData.student)}>
                        Prescrever Primeira Ficha
                      </Button>
                    }
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {dossierData.state.routines.map(r => {
                      const scheduledDays = WEEKDAY_MAP.filter(w =>
                        (dossierData.state.week?.[String(w.d)] || []).includes(r.id)
                      ).map(w => w.d);

                      return (
                        <div
                          key={r.id}
                          style={{
                            padding: 16,
                            borderRadius: 'var(--r-lg)',
                            background: 'var(--bg-el)',
                            border: 'var(--hair) solid var(--sep)'
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span className="lrow-i" style={{ '--tint': 'var(--acc)' }}>
                                <Icon name={r.emoji || 'figureStrength'} />
                              </span>
                              <div>
                                <div style={{ fontWeight: 700, fontSize: 16 }}>{r.name}</div>
                                <div className="muted small">
                                  {r.ex?.length || 0} exercícios
                                  {r.prescribedBy?.name ? ` · Prescrito por ${r.prescribedBy.name}` : ''}
                                </div>
                              </div>
                            </div>

                            <div style={{ display: 'flex', gap: 8 }}>
                              {dossierData?.student?.phone && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  icon="chat"
                                  style={{ color: 'var(--green)' }}
                                  title="Avisar Aluno desta Ficha no WhatsApp"
                                  onClick={() => {
                                    const sName = dossierData.student.name.split(' ')[0];
                                    const profName = r.prescribedBy?.name || team.find(t => t.id === dossierData.student.assignedTrainerId)?.name;
                                    const gymName = tenant.name || (isPersonal ? 'sua consultoria' : 'sua academia');
                                    const profText = profName ? `pelo Prof. ${profName}` : `pela equipe da ${gymName}`;
                                    handleOpenStudentWhatsApp(
                                      dossierData.student,
                                      'custom',
                                      `Olá, ${sName}! 💪\n\nSua ficha de treino *${r.name}* foi prescrita ${profText} na *${gymName}* e já está liberada no seu aplicativo *Rit*!\n\nAbra o app para conferir a execução guiada dos ${r.ex?.length || 0} exercícios e iniciar os treinos. Bom treino! 🏋️‍♂️`
                                    );
                                  }}
                                />
                              )}
                              <Button
                                variant="tinted"
                                size="sm"
                                icon="pencil"
                                onClick={() => openPrescribeForStudent(dossierData.student, r, scheduledDays)}
                              >
                                Editar Ficha
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                icon="trash"
                                style={{ color: 'var(--red)' }}
                                onClick={() => handleDeleteStudentRoutine(r.id, r.name)}
                                title="Remover Ficha"
                              />
                            </div>
                          </div>

                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(240px, 100%), 1fr))', gap: 8 }}>
                            {(r.ex || []).map((slot, idx) => (
                              <div
                                key={idx}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 10,
                                  padding: '8px 10px',
                                  borderRadius: 10,
                                  background: 'var(--surface)',
                                  border: 'var(--hair) solid var(--sep)',
                                  minWidth: 0
                                }}
                              >
                                {slot.thumb && (
                                  <img
                                    src={slot.thumb}
                                    alt=""
                                    style={{ width: 38, height: 38, borderRadius: 8, background: '#fff', objectFit: 'cover' }}
                                    onError={e => { e.currentTarget.style.display = 'none'; }}
                                  />
                                )}
                                <div style={{ minWidth: 0, flex: 1 }}>
                                  <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {idx + 1}. {slot.name}
                                  </div>
                                  <div className="muted small num">
                                    {slot.sets}×{slot.reps} {slot.weight ? `· ${slot.weight}kg` : ''} · {slot.restSec || 90}s
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Sub-aba 2: Histórico de Treinos & Evolução */}
            {dossierTab === 'history' && (
              <div>
                {((dossierData.state?.records?.length > 0) || (dossierData.state?.bw?.length > 0)) && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 12, marginBottom: 16 }}>
                    {dossierData.state?.records?.length > 0 && (
                      <div style={{ padding: 14, borderRadius: 'var(--r)', background: 'var(--bg-el)', border: 'var(--hair) solid var(--sep)' }}>
                        <div className="b2b-field-lbl" style={{ marginBottom: 8 }}>🏆 Melhores Cargas Confirmadas (PRs)</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {dossierData.state.records.slice(0, 8).map(rec => (
                            <span
                              key={rec.id}
                              style={{
                                fontSize: 12,
                                padding: '4px 9px',
                                borderRadius: 8,
                                background: 'var(--surface)',
                                border: 'var(--hair) solid var(--sep)'
                              }}
                            >
                              <b>{rec.name}:</b> {rec.weight} kg
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {dossierData.state?.bw?.length > 0 && (
                      <div style={{ padding: 14, borderRadius: 'var(--r)', background: 'var(--bg-el)', border: 'var(--hair) solid var(--sep)' }}>
                        <div className="b2b-field-lbl" style={{ marginBottom: 8 }}>⚖️ Evolução de Peso Corporal</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {dossierData.state.bw.slice(-6).map((b, idx) => (
                            <span
                              key={idx}
                              style={{
                                fontSize: 12,
                                padding: '4px 9px',
                                borderRadius: 8,
                                background: 'var(--surface)',
                                border: 'var(--hair) solid var(--sep)'
                              }}
                            >
                              <b>{b.w || b.weight} kg</b> <span className="muted">({fmtDateBR(b.d || b.date)})</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {(dossierData.state?.workouts || []).length === 0 ? (
                  <EmptyState
                    icon="history"
                    title="Nenhum treino concluído ainda"
                    message="Assim que o aluno finalizar seus treinos no aplicativo, as cargas, séries e datas aparecerão aqui."
                  />
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div className="muted small" style={{ marginBottom: 4 }}>
                      Clique em qualquer sessão concluída abaixo para inspecionar os exercícios, séries e cargas registradas pelo aluno.
                    </div>
                    {dossierData.state.workouts.map((w, i) => {
                      const isExpanded = expandedWorkoutIdx === i;
                      const exList = Array.isArray(w.ex) ? w.ex : [];
                      return (
                        <div
                          key={w.id || i}
                          style={{
                            borderRadius: 'var(--r)',
                            background: 'var(--bg-el)',
                            border: isExpanded ? '1px solid var(--acc)' : 'var(--hair) solid var(--sep)',
                            overflow: 'hidden'
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => setExpandedWorkoutIdx(isExpanded ? null : i)}
                            style={{
                              width: '100%',
                              padding: '12px 16px',
                              background: 'transparent',
                              border: 'none',
                              color: 'inherit',
                              font: 'inherit',
                              textAlign: 'left',
                              cursor: 'pointer',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              flexWrap: 'wrap',
                              gap: 12
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span>{w.name || 'Sessão de Treino'}</span>
                              </div>
                              <div className="muted small">
                                {exList.length} exercício(s) executado(s)
                                {w.dur ? ` · ${Math.round(w.dur / 60)} min` : ''}
                              </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <StatusPill tone="ok">{fmtDateBR(w.d)}</StatusPill>
                              <Icon
                                name="chevronRight"
                                size={16}
                                style={{
                                  color: 'var(--label-3)',
                                  transform: isExpanded ? 'rotate(90deg)' : 'none',
                                  transition: 'transform .18s ease'
                                }}
                              />
                            </div>
                          </button>

                          {isExpanded && (
                            <div
                              style={{
                                padding: '0 16px 14px',
                                borderTop: 'var(--hair) solid var(--sep)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 8,
                                paddingTop: 12
                              }}
                            >
                              {exList.length === 0 ? (
                                <div className="muted small">Sem exercícios detalhados registrados nesta sessão.</div>
                              ) : (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(230px, 100%), 1fr))', gap: 8 }}>
                                  {exList.map((ex, exIdx) => {
                                    const setsArr = Array.isArray(ex.sets) ? ex.sets : null;
                                    const setsSummary = setsArr
                                      ? setsArr
                                          .filter(s => s && (s.done !== false))
                                          .map(s => `${s.w || 0}kg × ${s.r || 0}`)
                                          .join(' · ')
                                      : `${ex.sets || 3}×${ex.reps || 10}${ex.weight ? ` · ${ex.weight}kg` : ''}`;

                                    return (
                                      <div
                                        key={exIdx}
                                        style={{
                                          padding: '8px 11px',
                                          borderRadius: 10,
                                          background: 'var(--surface)',
                                          border: 'var(--hair) solid var(--sep)'
                                        }}
                                      >
                                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                                          {exIdx + 1}. {ex.name || `#${ex.id}`}
                                        </div>
                                        <div className="muted small num" style={{ marginTop: 2 }}>
                                          {setsSummary || 'Concluído'}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Sub-aba 3: Cadastro & Credenciais */}
            {dossierTab === 'profile' && (
              <div className="b2b-grid-equal" style={{ marginBottom: 0, alignItems: 'start' }}>
                <form onSubmit={handleSaveStudentProfile} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <TextField
                    label="Nome Completo"
                    value={dossierData.student.name}
                    onChange={v => setDossierData(p => ({ ...p, student: { ...p.student, name: v } }))}
                  />
                  <div className="b2b-form-grid">
                    <TextField
                      label="E-mail"
                      value={dossierData.student.email || ''}
                      onChange={v => setDossierData(p => ({ ...p, student: { ...p.student, email: v } }))}
                      placeholder="aluno@email.com"
                    />
                    <TextField
                      label="WhatsApp"
                      value={dossierData.student.phone || ''}
                      onChange={v => setDossierData(p => ({ ...p, student: { ...p.student, phone: v } }))}
                      placeholder="(11) 99999-0000"
                    />
                  </div>
                  <TextField
                    label="Objetivo Atual"
                    value={dossierData.student.goal || ''}
                    onChange={v => setDossierData(p => ({ ...p, student: { ...p.student, goal: v } }))}
                  />
                  <SelectField
                    label="Professor Responsável"
                    value={dossierData.student.assignedTrainerId || ''}
                    onChange={v => setDossierData(p => ({ ...p, student: { ...p.student, assignedTrainerId: v } }))}
                    hint="O professor selecionado recebe relatórios de treino do aluno automaticamente"
                    options={[
                      { value: '', label: 'Nenhum / Recepção Geral da Academia' },
                      ...team.map(t => ({
                        value: t.id,
                        label: `${t.name} (${t.specialty || t.email || 'Professor'})`
                      }))
                    ]}
                  />
                  <TextArea
                    label="Anamnese / Restrições Médicas"
                    rows={3}
                    value={dossierData.student.notes || ''}
                    onChange={v => setDossierData(p => ({ ...p, student: { ...p.student, notes: v } }))}
                    placeholder="Restrições articulares, lesões prévias ou observações clínicas..."
                  />
                  <Button type="submit" variant="primary" icon="check" block disabled={savingStudentProfile}>
                    {savingStudentProfile ? 'Salvando...' : 'Salvar Dados do Aluno'}
                  </Button>
                </form>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div style={{ padding: 16, borderRadius: 'var(--r-lg)', background: 'var(--bg-el)', border: 'var(--hair) solid var(--sep)' }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>Acesso & Senha do App do Aluno</div>
                    <div className="muted small" style={{ marginBottom: 12 }}>
                      Defina uma nova senha direta ou gere um código temporário para o aluno redefinir no celular.
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                      <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                        <TextField
                          placeholder="Nova senha (mín. 10 caracteres)"
                          value={studentPwInput}
                          onChange={setStudentPwInput}
                        />
                      </div>
                      <Button variant="tinted" icon="key" disabled={settingStudentPw} onClick={handleSetStudentPassword}>
                        {settingStudentPw ? 'Salvando...' : 'Definir'}
                      </Button>
                    </div>
                    <Button variant="ghost" size="sm" block icon="bolt" disabled={generatingResetCode} onClick={handleGenerateStudentResetCode}>
                      {generatingResetCode ? 'Gerando...' : 'Gerar Código Temporário de Recuperação'}
                    </Button>
                    {resetCodeGenerated && (
                      <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--b2b-input-bg)', border: '1px solid var(--b2b-input-border)', fontWeight: 700, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <div>
                          <span className="small muted">Ativo por 15 min:</span>
                          <code style={{ fontSize: 15, color: 'var(--acc-ink)', letterSpacing: '0.04em', marginLeft: 8 }}>{resetCodeGenerated}</code>
                        </div>
                        {dossierData?.student?.phone && (
                          <Button
                            variant="tinted"
                            size="sm"
                            icon="chat"
                            style={{ color: 'var(--green)' }}
                            onClick={() => {
                              const sName = dossierData.student.name.split(' ')[0];
                              const gymName = tenant.name || (isPersonal ? 'sua consultoria' : 'sua academia');
                              handleOpenStudentWhatsApp(
                                dossierData.student,
                                'custom',
                                `Olá, ${sName}! 🔐\n\nAqui é da *${gymName}*. Seu código para redefinir sua senha no aplicativo de treinos *Rit* é: *${resetCodeGenerated}* (válido por 15 minutos).\n\nAbra o aplicativo Rit e utilize este código para acessar sua conta.`
                              );
                            }}
                          >
                            Enviar Código via WhatsApp
                          </Button>
                        )}
                      </div>
                    )}
                  </div>

                  <div style={{ padding: 16, borderRadius: 'var(--r-lg)', background: 'var(--bg-el)', border: 'var(--hair) solid var(--sep)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ fontWeight: 700 }}>Status da Matrícula</div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      <Button variant="tinted" icon="lock" style={{ flex: 1 }} disabled={togglingStudentStatus} onClick={handleToggleStudentDisabled}>
                        {togglingStudentStatus
                          ? 'Atualizando...'
                          : dossierData.student.disabled ? 'Reativar Matrícula' : 'Trancar / Bloquear Acesso'}
                      </Button>
                      {isManager && (
                        <Button variant="danger" icon="trash" style={{ flex: 1 }} onClick={handleDeleteStudent}>
                          Excluir Aluno
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Modal: Novo / Editar Profissional da Equipe */}
      <Modal
        open={Boolean(memberModal)}
        onClose={() => setMemberModal(null)}
        size="md"
        title={memberModal?.isNew ? 'Adicionar Profissional à Equipe' : `Editar Profissional — ${memberModal?.name || ''}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setMemberModal(null)}>Cancelar</Button>
            <Button variant="primary" icon="check" onClick={handleSaveTeamMember} disabled={savingMember}>
              {savingMember ? 'Salvando...' : 'Salvar Profissional'}
            </Button>
          </>
        }
      >
        {memberModal && (
          <form onSubmit={handleSaveTeamMember} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="b2b-form-grid">
              <TextField
                label="Nome Completo"
                required
                value={memberModal.name}
                onChange={v => setMemberModal(p => ({ ...p, name: v }))}
              />
              <SelectField
                label="Nível de Permissão"
                value={memberModal.saasRole}
                onChange={v => setMemberModal(p => ({ ...p, saasRole: v }))}
                options={[
                  { value: 'trainer', label: 'Professor / Instrutor (Prescreve e gerencia alunos)' },
                  { value: 'gym_manager', label: 'Coordenador / Gestor (Acesso completo à unidade)' }
                ]}
              />
              <TextField
                label="E-mail de Login"
                type="email"
                required={memberModal.isNew}
                disabled={!memberModal.isNew}
                value={memberModal.email}
                onChange={v => setMemberModal(p => ({ ...p, email: v }))}
              />
              <TextField
                label={memberModal.isNew ? 'Senha Inicial' : 'Nova Senha (deixe em branco para manter)'}
                placeholder="Mínimo de 10 caracteres"
                value={memberModal.password || ''}
                onChange={v => setMemberModal(p => ({ ...p, password: v }))}
              />
              <TextField
                label="Registro CREF"
                placeholder="Ex: 012345-G/SP"
                value={memberModal.cref || ''}
                onChange={v => setMemberModal(p => ({ ...p, cref: v }))}
              />
              <TextField
                label="Especialidade"
                placeholder="Ex: Musculação, Funcional, Reabilitação"
                value={memberModal.specialty || ''}
                onChange={v => setMemberModal(p => ({ ...p, specialty: v }))}
              />
            </div>
          </form>
        )}
      </Modal>

      {/* Modal: Editar Aluno */}
      <Modal
        open={Boolean(editingStudent)}
        onClose={() => setEditingStudent(null)}
        size="md"
        title={editingStudent ? `Editar Aluno — ${editingStudent.name}` : 'Editar Aluno'}
        subtitle="Atualize os dados cadastrais e o professor responsável deste aluno"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditingStudent(null)}>Cancelar</Button>
            <Button variant="primary" icon="check" onClick={handleSaveStudent} disabled={savingEditStudent}>
              {savingEditStudent ? 'Salvando...' : 'Salvar Alterações'}
            </Button>
          </>
        }
      >
        {editingStudent && (
          <form onSubmit={handleSaveStudent} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <TextField
              label="Nome Completo *"
              value={editStudentForm.name}
              onChange={v => setEditStudentForm(p => ({ ...p, name: v }))}
              placeholder="Ex: Lucas Oliveira"
              required
            />
            <div className="b2b-form-grid">
              <TextField
                label="WhatsApp / Celular"
                value={editStudentForm.phone}
                onChange={v => setEditStudentForm(p => ({ ...p, phone: v }))}
                placeholder="(11) 98888-7777"
              />
              <TextField
                label="E-mail (para login no App)"
                type="email"
                value={editStudentForm.email}
                onChange={v => setEditStudentForm(p => ({ ...p, email: v }))}
                placeholder="aluno@email.com"
              />
            </div>
            <TextField
              label="Objetivo Atual"
              value={editStudentForm.goal}
              onChange={v => setEditStudentForm(p => ({ ...p, goal: v }))}
              placeholder="Ex: Hipertrofia & Força, Emagrecimento, etc."
            />
            <SelectField
              label="Professor Responsável"
              value={editStudentForm.assignedTrainerId}
              onChange={v => setEditStudentForm(p => ({ ...p, assignedTrainerId: v }))}
              hint="O professor selecionado receberá automaticamente no WhatsApp os relatórios de treino concluído deste aluno"
              options={[
                { value: '', label: 'Nenhum / Recepção Geral da Academia' },
                ...team.map(t => ({
                  value: t.id,
                  label: `${t.name} (${t.specialty || t.email || 'Professor'})`
                }))
              ]}
            />
            <TextArea
              label="Anamnese / Observações Médicas"
              rows={3}
              value={editStudentForm.notes}
              onChange={v => setEditStudentForm(p => ({ ...p, notes: v }))}
              placeholder="Restrições articulares, histórico de lesões ou observações..."
            />
          </form>
        )}
      </Modal>

      <ConfirmModal
        open={Boolean(confirmState)}
        onClose={() => !confirmBusy && setConfirmState(null)}
        title={confirmState?.title || 'Confirmar ação'}
        message={confirmState?.message || ''}
        confirmLabel={confirmState?.confirmLabel || 'Confirmar'}
        confirmVariant={confirmState?.danger === false ? 'primary' : 'danger'}
        loading={confirmBusy}
        onConfirm={async () => {
          if (!confirmState?.onConfirm) return;
          await runSingleFlight('confirm-modal', setConfirmBusy, async () => {
            await confirmState.onConfirm();
            setConfirmState(null);
          });
        }}
      />

      {/* Modal: Enviar WhatsApp pelo Robô Rit */}
      <Modal
        open={Boolean(waSendModal)}
        onClose={() => !sendingWaMsg && setWaSendModal(null)}
        size="md"
        title={waSendModal ? `Enviar WhatsApp — ${waSendModal.studentName}` : 'Enviar WhatsApp'}
        subtitle="Mensagem enviada com a identidade da sua unidade pelo Rit"
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', width: '100%', gap: 8 }}>
            <Button variant="ghost" onClick={() => setWaSendModal(null)} disabled={sendingWaMsg}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              icon="chat"
              onClick={handleSendWhatsAppMessage}
              disabled={sendingWaMsg || !waSendModal?.message?.trim() || !waSendModal?.phone?.trim()}
              style={{ background: 'var(--green)', borderColor: 'var(--green)' }}
            >
              {sendingWaMsg ? 'Enviando...' : 'Enviar no WhatsApp'}
            </Button>
          </div>
        }
      >
        {waSendModal && (
          <form onSubmit={handleSendWhatsAppMessage} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{
              padding: '10px 14px',
              borderRadius: 10,
              background: 'var(--surface-1)',
              border: '1px solid var(--sep)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 10
            }}>
              <div style={{ minWidth: 0 }}>
                <span className="muted small">Destinatário:</span>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{waSendModal.studentName}</div>
              </div>
              <div style={{ textAlign: 'right', minWidth: 0 }}>
                <span className="muted small">Canal:</span>
                <div style={{ fontWeight: 700, color: 'var(--green)', fontSize: 12 }}>🟢 Notificação Oficial Rit</div>
              </div>
            </div>

            <TextField
              label="Número do WhatsApp (com DDD)"
              value={waSendModal.phone}
              onChange={v => setWaSendModal(p => ({ ...p, phone: v }))}
              placeholder="ex: 91985594558 ou 11999998888"
              required
            />

            <TextArea
              label="Mensagem a ser enviada no WhatsApp"
              rows={5}
              value={waSendModal.message}
              onChange={v => setWaSendModal(p => ({ ...p, message: v }))}
              placeholder="Digite a mensagem..."
              required
            />

            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--green)', fontWeight: 700 }}>⚡ Envio Oficial:</span>
              <span>A mensagem é entregue diretamente no WhatsApp do aluno em nome da sua unidade pelo aplicativo Rit.</span>
            </div>
          </form>
        )}
      </Modal>

      {/* Modal: Pagamento & Checkout PIX (Mercado Pago) */}
      <Modal
        open={pixModalOpen}
        onClose={() => {
          if (!generatingPix) {
            setPixModalOpen(false);
            setActivePix(null);
          }
        }}
        size="md"
        title={activePix ? 'Pagar com PIX Oficial' : 'Contratar / Renovar Assinatura'}
        subtitle={activePix ? 'Aponte a câmera do aplicativo do seu banco ou use o Copia e Cola' : 'Selecione seu plano e a forma de faturamento'}
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', width: '100%', gap: 8 }}>
            <Button
              variant="ghost"
              onClick={() => {
                setPixModalOpen(false);
                setActivePix(null);
              }}
              disabled={generatingPix || simulatingPix}
            >
              {activePix ? 'Fechar' : 'Cancelar'}
            </Button>
            {!activePix ? (
              <Button
                variant="primary"
                icon="creditCard"
                onClick={handleGeneratePix}
                disabled={generatingPix || !checkoutPlanId}
              >
                {generatingPix ? 'Gerando PIX...' : 'Gerar Código PIX'}
              </Button>
            ) : (
              <Button
                variant="primary"
                icon="copy"
                onClick={handleCopyPixCode}
                style={{ background: 'var(--green)', borderColor: 'var(--green)' }}
              >
                {copiedCode ? 'Código Copiado!' : 'Copiar Código PIX'}
              </Button>
            )}
          </div>
        }
      >
        {!activePix ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Seletor de Ciclo de Faturamento */}
            <div>
              <label className="field-label" style={{ marginBottom: 6, display: 'block' }}>Ciclo de Pagamento</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setCheckoutCycle('annual')}
                  style={{
                    padding: '12px 14px',
                    borderRadius: 10,
                    border: checkoutCycle === 'annual' ? '2px solid var(--acc)' : '1px solid var(--sep)',
                    background: checkoutCycle === 'annual' ? 'var(--surface-2)' : 'var(--surface-1)',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <strong style={{ fontSize: 14 }}>Anual com Desconto</strong>
                    <span style={{
                      fontSize: 10,
                      fontWeight: 800,
                      background: 'var(--green)',
                      color: '#000',
                      padding: '2px 6px',
                      borderRadius: 4
                    }}>
                      -18% OFF
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                    Pagamento à vista via PIX (12 meses de acesso)
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setCheckoutCycle('monthly')}
                  style={{
                    padding: '12px 14px',
                    borderRadius: 10,
                    border: checkoutCycle === 'monthly' ? '2px solid var(--acc)' : '1px solid var(--sep)',
                    background: checkoutCycle === 'monthly' ? 'var(--surface-2)' : 'var(--surface-1)',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  <strong style={{ fontSize: 14 }}>Mensal</strong>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                    Cobrança a cada 30 dias via PIX
                  </div>
                </button>
              </div>
            </div>

            {/* Seleção do Plano */}
            <div>
              <label className="field-label" style={{ marginBottom: 6, display: 'block' }}>Escolha o Plano</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(billingData?.availablePlans?.length ? billingData.availablePlans : [
                  { id: 'personal', name: 'Personal Inicial', accountType: 'personal', priceMonthly: 29, priceAnnualMonthly: 24, maxStudents: 10 },
                  { id: 'personal-pro', name: 'Personal Completo', accountType: 'personal', priceMonthly: 49, priceAnnualMonthly: 39, maxStudents: 100000 },
                  { id: 'starter', name: 'Estúdio', accountType: 'gym', priceMonthly: 169, priceAnnualMonthly: 139, maxStudents: 150 },
                  { id: 'pro', name: 'Academia Completa', accountType: 'gym', priceMonthly: 269, priceAnnualMonthly: 219, maxStudents: 100000 }
                ]).map(p => {
                  const isSelected = checkoutPlanId === p.id;
                  const rate = checkoutCycle === 'annual' ? p.priceAnnualMonthly : p.priceMonthly;
                  const total = checkoutCycle === 'annual' ? (p.priceAnnualMonthly * 12) : p.priceMonthly;
                  return (
                    <div
                      key={p.id}
                      onClick={() => setCheckoutPlanId(p.id)}
                      style={{
                        padding: '12px 14px',
                        borderRadius: 10,
                        border: isSelected ? '2px solid var(--acc)' : '1px solid var(--sep)',
                        background: isSelected ? 'var(--surface-2)' : 'var(--surface-1)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 10
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <strong style={{ fontSize: 14 }}>{p.name}</strong>
                          <span className="muted small">({p.maxStudents >= 100000 ? 'Alunos Ilimitados' : `Até ${p.maxStudents} alunos`})</span>
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                          {checkoutCycle === 'annual'
                            ? `R$ ${total.toFixed(2).replace('.', ',')} à vista (equivale a R$ ${rate}/mês)`
                            : `R$ ${rate.toFixed(2).replace('.', ',')} /mês`}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--acc)' }}>
                          R$ {rate}
                        </span>
                        <span className="muted small"> /mês</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, textAlign: 'center' }}>
            <div style={{
              background: 'var(--surface-1)',
              border: '1px solid var(--sep)',
              borderRadius: 12,
              padding: '12px 16px',
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <div style={{ textAlign: 'left' }}>
                <span className="muted small">Total a Pagar ({activePix.cycleLabel || (activePix.cycle === 'annual' ? 'Anual' : 'Mensal')}):</span>
                <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--acc)' }}>
                  R$ {Number(activePix.amount || 0).toFixed(2).replace('.', ',')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span className="muted small">Plano:</span>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{activePix.planName || 'Rit'}</div>
              </div>
            </div>

            {/* Renderização do QR Code */}
            <div style={{
              padding: 16,
              background: '#ffffff',
              borderRadius: 16,
              boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
              display: 'inline-block'
            }}>
              {activePix.qrCodeBase64 && activePix.qrCodeBase64.startsWith('data:image/png') ? (
                <img
                  src={activePix.qrCodeBase64}
                  alt="QR Code PIX Mercado Pago"
                  style={{ width: 200, height: 200, display: 'block' }}
                />
              ) : (
                <QrCodeBox value={activePix.qrCode} size={200} />
              )}
            </div>

            {/* Código Copia e Cola */}
            <div style={{ width: '100%' }}>
              <label className="field-label" style={{ marginBottom: 6, display: 'block', textAlign: 'left' }}>
                PIX Copia e Cola
              </label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  type="text"
                  readOnly
                  value={activePix.qrCode || ''}
                  onClick={e => e.target.select()}
                  style={{
                    flex: '1 1 180px',
                    minWidth: 0,
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--sep)',
                    background: 'var(--surface-2)',
                    color: 'var(--fg)',
                    fontSize: 16,
                    fontFamily: 'monospace'
                  }}
                />
                <Button variant="primary" icon="copy" size="sm" onClick={handleCopyPixCode}>
                  {copiedCode ? 'Copiado!' : 'Copiar'}
                </Button>
              </div>
            </div>

            <div style={{
              fontSize: 12,
              color: 'var(--muted)',
              lineHeight: 1.5,
              background: 'var(--surface-2)',
              borderRadius: 10,
              padding: '10px 14px',
              width: '100%',
              textAlign: 'left'
            }}>
              <div style={{ fontWeight: 700, color: 'var(--fg)', marginBottom: 4 }}>
                🟢 Como pagar:
              </div>
              <div>1. Abra o app do seu banco ou carteira digital.</div>
              <div>2. Escolha <strong>PIX</strong> &gt; <strong>Ler QR Code</strong> ou <strong>PIX Copia e Cola</strong>.</div>
              <div>3. Confirme o valor e finalize. A liberação da assinatura é instantânea!</div>
            </div>

            {/* Alerta de simulação caso esteja explicitamente habilitado pelo servidor (SAAS_DEMO=1) */}
            {activePix.mock && Boolean(activePix.simulationAllowed ?? billingData?.simulationAllowed ?? demoAllowed) && (
              <div style={{
                width: '100%',
                padding: '10px 14px',
                borderRadius: 10,
                background: 'rgba(34, 197, 94, 0.1)',
                border: '1px solid rgba(34, 197, 94, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: 10
              }}>
                <div style={{ textAlign: 'left', minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--green)' }}>
                    Modo Simulação Ativo
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                    Ambiente local sem token de produção configurado.
                  </div>
                </div>
                <Button
                  size="xs"
                  variant="primary"
                  onClick={handleSimulatePayment}
                  disabled={simulatingPix}
                  style={{ background: 'var(--green)', borderColor: 'var(--green)' }}
                >
                  {simulatingPix ? 'Confirmando...' : 'Simular Pagamento'}
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
