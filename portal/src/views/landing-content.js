export const campaign = {
  origin: 'https://treinerit.com.br',
  signup: '/cadastro',
  login: '/login',
  contact: 'https://wa.me/5591985561302',
  mail: 'mailto:contato@treinerit.com.br',
  instagram: 'https://instagram.com/treinerit',
  hero: {
    label: 'Gestão de treinos para academias e personais',
    title: ['O treino', 'ganha ritmo.'],
    description: 'Crie fichas no painel, entregue no app do aluno e acompanhe cada etapa da evolução.',
    primary: 'Criar conta',
    secondary: 'Ver como funciona'
  },
  chapters: [
    {
      id: 'prescrever', label: 'Prescrever', title: 'A ficha começa com você.',
      description: 'Monte séries, escolha exercícios do catálogo ilustrado e salve seus modelos no estúdio de prescrição.',
      asset: 'portal-builder.png', alt: 'Estúdio de prescrição do Rit com catálogo de exercícios e edição da ficha',
      device: 'desktop', context: 'Estúdio de prescrição'
    },
    {
      id: 'treinar', label: 'Treinar', title: 'O treino vai para a mão do aluno.',
      description: 'A ficha abre no celular pelo link ou QR Code. Durante a sessão, o aluno consulta os exercícios e registra séries, repetições e cargas.',
      asset: 'student-pt-workout.png', alt: 'Aplicativo Rit na tela de execução do treino, com séries e controles de carga',
      device: 'phone', context: 'App do aluno'
    },
    {
      id: 'acompanhar', label: 'Acompanhar', title: 'Cada sessão informa a próxima.',
      description: 'Consulte a frequência, veja a evolução das cargas e identifique quem precisa de acompanhamento.',
      asset: 'portal-dashboard.png', alt: 'Painel Rit com frequência, alunos ativos e indicadores de acompanhamento',
      device: 'desktop', context: 'Painel de acompanhamento'
    }
  ],
  audiences: [
    {
      type: 'personal', title: 'Personal trainers', description: 'Organize sua carteira, reutilize modelos de treino e acompanhe alunos presenciais ou de consultoria online.',
      bullets: ['Carteira de alunos', 'Modelos de fichas', 'Histórico individual'], action: 'Começar como personal'
    },
    {
      type: 'gym', title: 'Academias e estúdios', description: 'Conecte sua equipe ao mesmo painel e entregue aos alunos um app com a identidade da sua unidade.',
      bullets: ['Gestão de equipe', 'App com a sua marca', 'Convites por link e QR Code'], action: 'Começar como academia'
    }
  ],
  questions: [
    ['Como o aluno recebe a ficha?', 'Pelo link enviado pelo profissional ou pelo QR Code da unidade. Após entrar no app, o aluno pode consultar a rotina e registrar o treino.'],
    ['O aluno precisa contratar um plano?', 'A academia ou o personal contrata a plataforma e oferece acesso ao app aos seus alunos.'],
    ['Posso usar minha marca no app?', 'O painel permite configurar o nome da unidade, logotipo e cor principal para personalizar o app da academia.'],
    ['Uma academia pode cadastrar vários professores?', 'Sim. O gestor cadastra a equipe e pode atribuir alunos a cada profissional.']
  ],
  platform: [
    { title: 'Prescrição', asset: 'portal-builder.png', alt: 'Catálogo e editor de fichas do painel Rit', text: 'Crie treinos com séries, repetições e descanso. Salve um modelo para reaproveitá-lo na próxima prescrição.' },
    { title: 'Histórico de treino', asset: 'student-pt-stats.png', alt: 'Histórico e gráficos de evolução no aplicativo Rit', text: 'Quem treina pode consultar sessões registradas, cargas e recordes pessoais no próprio aplicativo.', phone: true },
    { title: 'Identidade da unidade', asset: 'portal-branding.png', alt: 'Tela de configuração da identidade visual da academia', text: 'Configure nome, cores e logotipo da unidade e compartilhe o acesso com os alunos por link ou QR Code.' }
  ]
};

export const landingPages = {
  home: {
    path: '/', title: 'Rit | Treinos e alunos no mesmo ritmo',
    description: 'Prescreva treinos, entregue fichas no app do aluno e acompanhe a evolução. Plataforma para academias, estúdios e personal trainers.'
  },
  platform: {
    path: '/plataforma', title: 'Plataforma Rit | Prescrição, app e acompanhamento',
    description: 'Conheça as telas reais da Rit para prescrever fichas, acompanhar o treino do aluno e personalizar o app da academia.'
  },
  missing: {
    title: 'Página não encontrada | Rit',
    description: 'Volte à página inicial para conhecer a plataforma Rit.'
  }
};

export function currentLandingPage(path) {
  const cleanPath = path.replace(/\/+$/, '') || '/';
  if (cleanPath === '/' || cleanPath === '/site') return 'home';
  if (cleanPath === '/plataforma') return 'platform';
  return 'missing';
}

export const LEGAL_DOCS = {
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
