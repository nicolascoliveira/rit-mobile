/* Estado persistente do Tour Guiado & Tutoriais do Portal B2B Rit.
 * Espelha o comportamento de "tour" do app do aluno:
 *  - oferta automática na primeira visita (ou pós-cadastro)
 *  - retomada se o usuário fechar na metade
 *  - botão fixo "Tour Guiado" na barra superior com tutoriais rápidos
 */

export const PORTAL_TOUR_STORAGE_KEY = 'rit_portal_tour_v1';
export const PORTAL_TOUR_VERSION = 1;

export function loadPortalTourState() {
  try {
    const raw = localStorage.getItem(PORTAL_TOUR_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePortalTourState(next) {
  try {
    const payload = {
      version: PORTAL_TOUR_VERSION,
      ...(next && typeof next === 'object' ? next : {})
    };
    localStorage.setItem(PORTAL_TOUR_STORAGE_KEY, JSON.stringify(payload));
    return payload;
  } catch {
    return null;
  }
}

export function clearPortalTourProgress() {
  return savePortalTourState({
    completed: false,
    dismissed: false,
    step: undefined
  });
}

export function markPortalTourDone() {
  return savePortalTourState({
    completed: true,
    dismissed: false,
    step: undefined,
    completedAt: new Date().toISOString()
  });
}

export function markPortalTourDismissed(atStep) {
  return savePortalTourState({
    completed: false,
    dismissed: true,
    step: typeof atStep === 'number' ? atStep : undefined
  });
}

export function markPortalTourStep(stepIndex) {
  const prev = loadPortalTourState() || {};
  return savePortalTourState({
    ...prev,
    completed: false,
    dismissed: false,
    step: stepIndex
  });
}

/**
 * Decide se devemos oferecer o tour automaticamente nesta sessão:
 *  - nunca aparece duas vezes se o usuário concluiu ou dispensou explicitamente
 *  - se parou no meio de um tour anterior (step > 0), oferece retomar de onde parou
 */
export function shouldOfferPortalTour() {
  const st = loadPortalTourState();
  if (!st || st.version !== PORTAL_TOUR_VERSION) {
    return { offer: 'fresh', resumeStep: 0 };
  }
  if (st.completed || st.dismissed) {
    return { offer: null, resumeStep: 0 };
  }
  if (typeof st.step === 'number' && st.step > 0) {
    return { offer: 'resume', resumeStep: st.step };
  }
  return { offer: 'fresh', resumeStep: 0 };
}

/**
 * Passos principais do tour guiado pelo painel B2B.
 * Cada passo pode indicar `tab` para navegar automaticamente até a seção certa.
 */
export function getPortalTourSteps(isPersonal = false) {
  return [
    {
      id: 'welcome-kpis',
      tab: 'dashboard',
      target: '[data-tour="gym-kpis"]',
      prefer: 'bottom',
      title: 'Sua operação em tempo real',
      body: isPersonal
        ? 'Aqui você acompanha alunos ativos, treinos registrados na semana, engajamento e o limite do seu plano em um só lugar.'
        : 'Acompanhe alunos ativos, professores, check-ins da semana e a saúde operacional da academia logo ao abrir o painel.'
    },
    {
      id: 'churn-radar',
      tab: 'dashboard',
      target: '[data-tour="gym-churn"]',
      prefer: 'top',
      title: 'Central Anti-Evasão',
      body: 'O sistema sinaliza automaticamente quem ficou dias sem treinar e prepara o contato de resgate via WhatsApp com um clique.'
    },
    {
      id: 'enroll-students',
      tab: 'students',
      target: '[data-tour="gym-enroll-btn"]',
      prefer: 'bottom',
      title: isPersonal ? 'Meus Alunos & Prescrição' : 'Gestão de Alunos',
      body: 'Cadastre alunos manualmente por aqui ou abra a ficha de qualquer aluno para prescrever treinos e acompanhar a carga evoluindo.'
    },
    {
      id: 'templates-library',
      tab: 'templates',
      target: '[data-tour="gym-templates-head"]',
      prefer: 'bottom',
      title: 'Modelos & Biblioteca de Exercícios',
      body: 'Importe fichas prontas em 1 clique, monte modelos reutilizáveis (ABC, PPL, Upper/Lower) e personalize exercícios da sua marca.'
    },
    {
      id: 'team-staff',
      tab: 'team',
      target: '[data-tour="gym-team-head"]',
      prefer: 'bottom',
      title: isPersonal ? 'Meu Perfil & Equipe' : 'Equipe de Professores',
      body: isPersonal
        ? 'Adicione estagiários ou parceiros com permissões separadas, sem precisar compartilhar a sua senha principal.'
        : 'Cadastre professores e coordenadores para que toda a equipe prescreva treinos ao mesmo tempo no mesmo painel.'
    },
    {
      id: 'onboarding-qr',
      tab: 'onboarding',
      target: '[data-tour="gym-qr-card"]',
      prefer: 'right',
      title: 'QR Code Oficial',
      body: isPersonal
        ? 'Envie ou imprima seu QR Code exclusivo para o aluno escanear e cair direto no seu aplicativo com a sua marca.'
        : 'Baixe o cartaz com QR Code para colocar na recepção e nos aparelhos: seus alunos entram no app em segundos.'
    },
    {
      id: 'onboarding-invite',
      tab: 'onboarding',
      target: '[data-tour="gym-invite-card"]',
      prefer: 'left',
      title: 'Links & Códigos de Convite',
      body: 'Gere links de ativação com ficha inicial já vinculada. Copie e mande no WhatsApp — o aluno cria a senha e já sai treinando.'
    },
    {
      id: 'settings-branding',
      tab: 'settings',
      target: '[data-tour="gym-branding-card"]',
      prefer: 'right',
      title: 'Sua Marca no App do Aluno',
      body: 'Envie seu logotipo, escolha a cor principal e personalize o nome exibido para o aluno enxergar apenas a sua identidade.'
    },
    {
      id: 'settings-whatsapp',
      tab: 'settings',
      target: '[data-tour="gym-whatsapp-box"]',
      prefer: 'left',
      title: 'Automação via WhatsApp',
      body: 'Conecte o WhatsApp da operação para disparar convites, avisos de treino prescrito e mensagens anti-evasão no piloto automático.'
    },
    {
      id: 'billing-plan',
      tab: 'billing',
      target: '[data-tour="gym-billing-head"]',
      prefer: 'bottom',
      title: 'Teste Grátis & Assinatura PIX',
      body: 'Controle os dias restantes do seu teste gratuito, histórico de faturas e gere renovações PIX instantâneas quando quiser fazer upgrade.'
    },
    {
      id: 'reopen-tour',
      tab: null,
      target: '[data-tour="topbar-tour-btn"]',
      prefer: 'bottom',
      title: 'Tour e Tutoriais sempre à mão',
      body: 'Sempre que chegar um novo professor ou você quiser rever um fluxo rápido, clique aqui para reabrir o tour ou escolher um tutorial prático.'
    }
  ];
}

/**
 * Tutoriais curtos e focados (acessíveis no card final do tour e pelo botão "Tour Guiado").
 */
export function getPortalTutorials(isPersonal = false) {
  return [
    {
      id: 'prescribe',
      title: 'Prescrever seu 1º treino',
      duration: '35 seg',
      icon: 'dumbbell',
      summary: 'Importe ou crie um modelo e vincule ao aluno em menos de um minuto.',
      steps: [
        {
          id: 'tut-prescribe-1',
          tab: 'templates',
          target: '[data-tour="gym-templates-head"]',
          prefer: 'bottom',
          title: '1. Escolha ou crie um modelo',
          body: 'Use "Importar Pacote" para começar com fichas testadas ou clique em "Novo Modelo" para montar sua divisão personalizada.'
        },
        {
          id: 'tut-prescribe-2',
          tab: 'students',
          target: '[data-tour="gym-enroll-btn"]',
          prefer: 'bottom',
          title: '2. Abra ou cadastre o aluno',
          body: 'Clique em "Novo Aluno" (ou selecione um aluno da lista abaixo) para abrir o perfil e enviar a ficha direto para o celular dele.'
        }
      ]
    },
    {
      id: 'onboarding',
      title: 'Convidar seus primeiros alunos',
      duration: '30 seg',
      icon: 'qr',
      summary: 'Gere links exclusivos de boas-vindas e o cartaz QR Code para ativação imediata.',
      steps: [
        {
          id: 'tut-onb-1',
          tab: 'onboarding',
          target: '[data-tour="gym-invite-card"]',
          prefer: 'left',
          title: '1. Gere e copie o link de convite',
          body: 'Crie um código de convite (pode até vincular um modelo de treino automático) e clique em copiar link para mandar no WhatsApp.'
        },
        {
          id: 'tut-onb-2',
          tab: 'onboarding',
          target: '[data-tour="gym-qr-card"]',
          prefer: 'right',
          title: '2. Compartilhe o QR Code oficial',
          body: isPersonal
            ? 'Baixe o QR Code pronto para salvar no celular ou anexar no seu PDF/Instagram de boas-vindas.'
            : 'Imprima o cartaz oficial e deixe na catraca ou recepção para novos alunos entrarem no app na hora.'
        }
      ]
    },
    {
      id: 'branding',
      title: 'Personalizar marca e WhatsApp',
      duration: '40 seg',
      icon: 'building',
      summary: 'Deixe o aplicativo do aluno com a sua logo e ative os avisos automáticos.',
      steps: [
        {
          id: 'tut-brand-1',
          tab: 'settings',
          target: '[data-tour="gym-branding-card"]',
          prefer: 'right',
          title: '1. Logotipo e cor da marca',
          body: 'Preencha o nome de exibição, suba sua logo em PNG/SVG e escolha a cor principal que aparece nos botões e gráficos do app do aluno.'
        },
        {
          id: 'tut-brand-2',
          tab: 'settings',
          target: '[data-tour="gym-whatsapp-box"]',
          prefer: 'left',
          title: '2. Conecte o WhatsApp',
          body: 'Escaneie o QR Code de conexão nesta área para ativar notificações automáticas e resgate anti-evasão sem esforço manual.'
        }
      ]
    }
  ];
}

/**
 * Calcula a posição ideal do card ao redor do retângulo alvo no viewport.
 * Tenta na ordem `prefer` -> lados livres -> encaixe inferior/central seguro.
 */
export function placePortalTourCard(targetRect, cardSize, prefer = 'bottom') {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const margin = vw <= 480 ? 12 : 16;
  const gap = 14;
  const cw = Math.min(cardSize.width || 372, vw - margin * 2);
  const ch = Math.min(cardSize.height || 240, vh - margin * 2);
  const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

  if (!targetRect || targetRect.width === 0 || targetRect.height === 0) {
    return {
      left: Math.round(clamp((vw - cw) / 2, margin, Math.max(margin, vw - cw - margin))),
      top: Math.round(clamp((vh - ch) / 2, margin, Math.max(margin, vh - ch - margin))),
      placement: 'center',
      arrowOffset: 0
    };
  }

  const order = [];
  for (const dir of [prefer, 'bottom', 'top', 'right', 'left']) {
    if (!order.includes(dir)) order.push(dir);
  }

  const tryPlace = dir => {
    let left = 0;
    let top = 0;
    if (dir === 'bottom') {
      top = targetRect.bottom + gap;
      left = targetRect.left + targetRect.width / 2 - cw / 2;
      if (top + ch > vh - margin) return null;
    } else if (dir === 'top') {
      top = targetRect.top - gap - ch;
      left = targetRect.left + targetRect.width / 2 - cw / 2;
      if (top < margin) return null;
    } else if (dir === 'right') {
      left = targetRect.right + gap;
      top = targetRect.top + targetRect.height / 2 - ch / 2;
      if (left + cw > vw - margin) return null;
    } else if (dir === 'left') {
      left = targetRect.left - gap - cw;
      top = targetRect.top + targetRect.height / 2 - ch / 2;
      if (left < margin) return null;
    }

    const clampedLeft = Math.round(clamp(left, margin, Math.max(margin, vw - cw - margin)));
    const clampedTop = Math.round(clamp(top, margin, Math.max(margin, vh - ch - margin)));

    const arrowOffset =
      dir === 'bottom' || dir === 'top'
        ? Math.round(clamp(targetRect.left + targetRect.width / 2 - clampedLeft, 24, cw - 24))
        : Math.round(clamp(targetRect.top + targetRect.height / 2 - clampedTop, 24, ch - 24));

    return { left: clampedLeft, top: clampedTop, placement: dir, arrowOffset };
  };

  for (const dir of order) {
    const pos = tryPlace(dir);
    if (pos) return pos;
  }

  // Fallback seguro quando o alvo ocupa quase a tela toda ou em mobile estreito
  const anchorBelow = targetRect.top + targetRect.height / 2 < vh * 0.48;
  return {
    left: Math.round((vw - cw) / 2),
    top: anchorBelow
      ? Math.max(margin, Math.min(vh - ch - margin, Math.round(targetRect.bottom + gap)))
      : Math.max(margin, Math.round(vh - ch - margin)),
    placement: 'floating',
    arrowOffset: 0
  };
}
