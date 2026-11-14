# Guia Oficial de Implantação em Produção — Ecossistema Rit

Este manual contém as instruções definitivas passo a passo para colocar a plataforma **Rit** em produção em uma máquina virtual Linux (VPS / Cloud como AWS, DigitalOcean, Hetzner, Linode ou GCP).

---

## 1. Pré-requisitos de Infraestrutura

- **Sistema Operacional**: Ubuntu 22.04 LTS ou 24.04 LTS (x86_64 ou ARM64)
- **Recursos Mínimos**:
  - 2 vCPUs
  - 4 GB de Memória RAM (2 GB livre para Docker/Postgres/Evolution API)
  - 40 GB de Armazenamento SSD (recomenda-se NVMe)
- **Portas Liberadas no Firewall (UFW / Security Group)**:
  - `80/tcp` (HTTP — redirecionamento para HTTPS e renovação Certbot)
  - `443/tcp` (HTTPS seguro)
  - `22/tcp` (Acesso SSH restrito)
  *(Atenção: as portas 3000, 5432, 8080, 8081 e 8082 NÃO devem ser abertas publicamente no firewall; a comunicação é interna via Docker)*

---

## 2. Configuração de Domínios e DNS

No painel do seu provedor de domínio (ex: Registro.br, Cloudflare, GoDaddy), crie as entradas DNS do **Tipo A** apontando para o IP público do seu servidor:

| Tipo | Nome / Host | Aponta para | Finalidade |
| :--- | :--- | :--- | :--- |
| **A** | `@` (`treinerit.com.br`) | `SEU_IP_VPS` | Landing Page Oficial / Institucional |
| **A** | `www` (`www.treinerit.com.br`) | `SEU_IP_VPS` | Redirecionamento Web |
| **A** | `app` (`app.treinerit.com.br`) | `SEU_IP_VPS` | PWA do Aluno (Treinos, Séries e Fichas) |
| **A** | `painel` (`painel.treinerit.com.br`) | `SEU_IP_VPS` | Portal B2B de Gestão das Academias & Rit Admin |
| **A** | `*` (`*.treinerit.com.br`) | `SEU_IP_VPS` | Subdomínios dinâmicos das academias (ex: `ironpower.treinerit.com.br`) |

> [!TIP]
> Se utilizar Cloudflare na frente do seu domínio, ative o Proxy (nuvem laranja) e defina o modo SSL/TLS como **Full (Strict)**.

---

## 3. Preparação do Servidor

Conecte-se via SSH ao seu servidor e instale o Docker e Docker Compose:

```bash
# 1. Atualizar pacotes
sudo apt update && sudo apt upgrade -y

# 2. Instalar Docker e utilitários
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER

# 3. Clonar o repositório da Rit
git clone https://github.com/SEU_USUARIO/opengym.git /opt/rit
cd /opt/rit

# 4. Criar estrutura de dados persistentes
mkdir -p data/backups data/uploads data/certbot/conf data/certbot/www data/evolution_instances data/evolution_pgdata
chmod -R 755 data
```

---

## 4. Configuração das Variáveis de Ambiente (`.env`)

Copie o template de produção e edite com suas credenciais reais:

```bash
cp .env.production.example .env
nano .env
```

### Checklist Obrigatório de Segurança no `.env`:
1. **Domínios & WebAuthn**:
   ```ini
   RP_ID=treinerit.com.br
   ORIGIN=https://app.treinerit.com.br
   RP_NAME=Rit
   DOMAIN_ROOT=treinerit.com.br
   DOMAIN_APP=app.treinerit.com.br
   DOMAIN_PORTAL=painel.treinerit.com.br
   PORTAL_URL=https://painel.treinerit.com.br
   VITE_STUDENT_APP_URL=https://app.treinerit.com.br
   ```
2. **Travas Estritas de Produção**:
   ```ini
   PASSWORD_LOGIN=1
   ALLOW_GUEST=0
   FIRST_USER_ADMIN=0
   SAAS_DEMO=0
   SAAS_AUTO_SEED=0
   TRUST_PROXY=1
   ```
3. **Chaves Criptográficas Fortes**:
   - Gere chaves aleatórias para a Evolution API e Postgres:
   ```bash
   openssl rand -hex 24 # Use para EVOLUTION_API_KEY
   openssl rand -hex 16 # Use para EVOLUTION_DB_PASS
   ```
4. **Mercado Pago (PIX)**:
   - Cole seu `MERCADO_PAGO_ACCESS_TOKEN` de produção (`APP_USR-...`).
   - Cole o `MERCADO_PAGO_WEBHOOK_SECRET` gerado no painel de desenvolvedor.

---

## 5. Emissão dos Certificados SSL Gratuitos (Let's Encrypt)

Antes de rodar o compose final com HTTPS, gere o certificado SSL inicial:

```bash
# Iniciar nginx temporário para o desafio ACME
docker run -d --name temp-nginx -p 80:80 \
  -v $(pwd)/data/certbot/www:/var/www/certbot \
  nginx:alpine

# Emitir certificado com Certbot
docker run --rm \
  -v $(pwd)/data/certbot/conf:/etc/letsencrypt \
  -v $(pwd)/data/certbot/www:/var/www/certbot \
  certbot/certbot certonly --webroot -w /var/www/certbot \
  -d treinerit.com.br -d www.treinerit.com.br -d app.treinerit.com.br -d painel.treinerit.com.br \
  --email seu-email@treinerit.com.br --agree-tos --no-eff-email

# Remover container temporário
docker stop temp-nginx && docker rm temp-nginx
```

---

## 6. Inicialização dos Containers em Produção

Compile as imagens e inicie a stack padrão (`docker-compose.yml`, atrás do Nginx da VPS configurado em `deploy/nginx-vps.conf`):

```bash
docker compose up -d --build
```

Verifique se todos os containers estão saudáveis:
```bash
docker compose ps
```

*(Opcional: caso prefira gerenciar Nginx + Certbot em containers, utilize `docker compose -f docker-compose.prod.yml up -d --build`.)*

---

## 7. Criação do Primeiro Super Administrador

Crie o usuário Master da Rit via linha de comando segura:

```bash
docker compose exec api \
  node create-superadmin.js "diretoria@treinerit.com.br" "SuaSenhaForte2026!#" "Super Admin Geral"
```

Acesse **`https://painel.treinerit.com.br`** e faça login com essas credenciais para acessar o painel global.

---

## 8. Pareamento do WhatsApp Gateway (Evolution API)

1. No Portal de Gestão (`https://painel.treinerit.com.br`), acesse **Configurações da Plataforma** ou aba **WhatsApp**.
2. Clique em **"Conectar WhatsApp / Gerar QR Code"**.
3. No smartphone da academia/empresa, abra o WhatsApp -> **Aparelhos conectados** -> **Conectar aparelho**.
4. Escaneie o QR Code exibido na tela.
5. Em menos de 5 segundos o status mudará para `open` (Conectado).
6. Faça um disparo de teste na interface para confirmar o envio instantâneo.

---

## 9. Configuração de Webhook no Mercado Pago

1. Acesse o [Painel de Desenvolvedores do Mercado Pago](https://www.mercadopago.com.br/developers/panel/app).
2. Selecione sua aplicação de produção.
3. Acesse **Webhooks / Notificações IPN**.
4. Configure a URL do Webhook:
   ```
   https://app.treinerit.com.br/api/saas/billing/webhook
   ```
5. Marque o evento: **Pagamentos (`payment`)**.
6. Copie a chave secreta de assinatura e adicione no `.env` em `MERCADO_PAGO_WEBHOOK_SECRET`.

---

## 10. Agendamento do Backup Diário Automático

Adicione o script de backup no Crontab da VPS:

```bash
sudo chmod +x /opt/rit/scripts/backup-db.sh
sudo crontab -e
```

Adicione a linha:
```cron
0 3 * * * /bin/bash /opt/rit/scripts/backup-db.sh >> /var/log/rit-backup.log 2>&1
```
Isso gerará diariamente às 03:00 da manhã um backup atômico do SQLite, dump compactado do Postgres da Evolution API e backup dos uploads em `/opt/rit/data/backups/daily_archives`.

---

## 11. Monitoramento & Comandos Úteis

- **Ver logs em tempo real da API**:
  `docker compose logs -f api`
- **Ver logs da Evolution API**:
  `docker compose logs -f evolution-api`
- **Reiniciar serviços sem downtime perceptível**:
  `docker compose restart web portal`
- **Atualizar o código após um novo pacote/commit**:
  `docker compose up -d --build`
