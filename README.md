# Chatwoot — deploy de produção

- **URL:** https://visualchat.wendellcarvalho.com.br
- **Versão:** `chatwoot/chatwoot:v4.19.0-ce` (Community Edition, só código MIT)
- **Onde roda:** Docker Swarm, stack `chatwoot` (Id 20 no Portainer — http://146.190.114.40:9000)
- **Deploy em:** 2026-10-23

## Estrutura

```
/home/infra/deploy/chatwoot/
├── docker-compose.yml   # definição do stack (cópia do que está no Portainer)
├── .env                 # segredos (chmod 600) — também cadastrados como Env do stack no Portainer
├── scripts/
│   ├── status.sh        # estado das tasks do stack (somente leitura)
│   └── logs.sh          # logs: scripts/logs.sh rails|sidekiq|blip_bridge|postgres|redis [linhas]
├── blip-bridge/server.mjs  # ponte Blip -> Chatwoot (espelho das respostas)
├── docs/                # prompts e notas operacionais
└── README.md
/home/infra/chatwoot/    # clone do código-fonte (referência, não é usado no deploy)
```

Volumes Docker: `chatwoot_storage` (anexos), `chatwoot_postgres_data`, `chatwoot_redis_data`.
Redes: `chatwoot_internal` (privada do stack) e `traefik_public` (externa, só o `rails`).

## Serviços

| Serviço | Imagem | Função |
|---|---|---|
| chatwoot_rails | chatwoot v4.19.0-ce | Web/API; roda `db:chatwoot_prepare` (migrações) ao iniciar |
| chatwoot_sidekiq | chatwoot v4.19.0-ce | Jobs em segundo plano |
| chatwoot_postgres | pgvector/pgvector:pg16 | Banco (sem porta exposta) |
| chatwoot_redis | redis:7-alpine | Filas/cache, com senha (sem porta exposta) |

HTTPS: Traefik do servidor, por labels no serviço `rails` (certresolver `le`). O Traefik não foi alterado.

## WhatsApp + espelho da Blip

- Caixa de entrada id 1 "WhatsApp 48 9126-5138" (WABA Olimpo 1010161848711467, phone_number_id 264802675700802).
  Mensagens dos clientes chegam pela Meta (webhook do app "CHAT SUPORTE WENDEL").
- O atendimento é feito na **Blip** (roteador `wendellroteador`). As respostas da Blip não chegam pela Meta,
  então o serviço `chatwoot_blip_bridge` recebe o Webhook da Blip (só "Mensagens") em
  `https://visualchat.wendellcarvalho.com.br/blip-webhook/<BLIP_WEBHOOK_PATH_TOKEN>` e registra cada mensagem
  enviada (🤖 bot, 👤 atendente) na conversa do cliente, assinada pelo Agent Bot "Blip".
- As mensagens entram com `source_id=blip:<id>`: o Chatwoot **não** as reenvia ao cliente.
- Celular BR: a Meta manda o número sem o 9 e a Blip com o 9; a ponte procura as duas formas.
- A ponte usa o token de usuário (CHATWOOT_USER_TOKEN) para achar contatos: se for regenerado, atualizar o `.env`
  e as variáveis do stack. Código montado de `blip-bridge/` (bind mount); para recarregar, forçar update do serviço.

## Estado do atendimento (IA × humano)

A ponte mantém o campo de conversa `atendimento` a partir de evidências da Blip e reflete no modelo nativo:

| Evidência na Blip | Estado | No Chatwoot |
|---|---|---|
| mensagem do bot | IA | pendente, responsável = Agent Bot "Blip" (fora de "Não atribuídas") |
| ticket da Blip Desk `Waiting`/`Transferred` | Aguardando atendente | aberta sem responsável (transferência nativa do bot) |
| mensagem com `#messageEmitter=Human` (traz `#message.agentIdentity`) | Atendimento humano | aberta, atribuída ao atendente (criado automaticamente pelo e-mail da Blip) |
| ticket `Closed*`, pedido de avaliação do bot, ou 24h sem atividade | Finalizado | resolvida (Histórico) |

- Atributos auxiliares: `atendimento_desde`, `ia_inicio`, `transferido_em`, `humano_inicio`, `atendente_blip`,
  `finalizado_por` (IA / Atendente / Inatividade), `finalizado_em`. Cada mudança gera uma nota privada "🔁 Atendimento: …".
- Após "Finalizado", 30 min de fechamento: mensagens da pesquisa de satisfação não reabrem o atendimento.
- Pastas (do usuário infra): **Ao vivo** (IA + aguardando + humano, não resolvidas), **Aguardando atendente**,
  **Histórico IA** (`ia_inicio` preenchido e sem `humano_inicio`) e **Histórico humano** (`humano_inicio` preenchido).
  Atualizam em tempo real: cada mudança de estado dispara `conversation.updated` e o painel refiltra.
- Caixa com "reabrir conversa anterior" (`lock_to_single_conversation`): resposta do cliente reabre a mesma conversa.
- Pesquisa de satisfação: nota 1-5 do cliente logo após o pedido vira `avaliacao` (+ `avaliacao_de` IA/Atendente).
- `scripts/fix-duplicate-conversations.py`: encerra duplicadas antigas do mesmo cliente (idempotente).
- Encerramento automático da conta: 24h (`auto_resolve_after=1440`, sem mensagem ao cliente).
- `scripts/finalize-stale.py`: finaliza conversas antigas sem estado e inativas há mais de 24h (idempotente).

## Operação

- **Atualizar versão:** no Portainer → Stacks → chatwoot → Editor, trocar `CHATWOOT_IMAGE` nas variáveis
  (ex.: `chatwoot/chatwoot:v4.20.0-ce`) → *Update the stack*. Migrações rodam sozinhas. Atualize também o `.env` daqui.
- **Backup do banco:** no Portainer, console do container `chatwoot_postgres` → `pg_dump -U postgres chatwoot > /tmp/chatwoot.sql`.
- **E-mail (SMTP):** ainda não configurado. Adicionar `SMTP_ADDRESS`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`,
  `SMTP_AUTHENTICATION=login`, `MAILER_SENDER_EMAIL` ao bloco `x-chatwoot-env` e às variáveis do stack.
- **Cadastro público** desativado (`ENABLE_ACCOUNT_SIGNUP=false`): novos agentes são convidados pelo admin.

## Regras

Este stack é isolado: não altera Traefik, redes ou outros stacks. Qualquer mudança em recurso compartilhado precisa
de autorização explícita.
