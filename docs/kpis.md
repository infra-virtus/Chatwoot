# Dicionário de KPIs — Atendimento WhatsApp (Chatwoot + Blip)

Revisão de 2026-11-03. Fuso de referência: **America/Sao_Paulo** (o banco grava em UTC).
Unidade de análise: **conversa** (caixa "WhatsApp 48 9126-5138"). Uma conversa pode ter vários ciclos IA → humano;
os campos `ia_inicio`, `transferido_em` e `humano_inicio` guardam o **primeiro** de cada no ciclo atual.

## Fontes de dados

| Fonte | O que traz | Confiabilidade |
|---|---|---|
| Mensagens do cliente (Meta → Chatwoot) | volume de entrada, horário real | alta |
| Respostas espelhadas da Blip (ponte, assinadas pelo bot "Blip") | 🤖 bot / 👤 atendente, texto | alta para conteúdo; horário = chegada no Chatwoot (a Blip pode atrasar) |
| Campos da ponte (`atendimento`, `ia_inicio`, `transferido_em`, `humano_inicio`, `atendente_blip`, `finalizado_por`, `finalizado_em`) | estado e marcos do atendimento | alta; desde 2026-11-03 usam o horário original da Blip |
| Nota da pesquisa da Blip (`avaliacao`, `avaliacao_de`) | CSAT real (1–5) | alta; só quando o cliente responde com número logo após o pedido |
| Eventos nativos de relatório do Chatwoot (`reporting_events`) | resoluções, transferência do bot | parcial — ver tabela de situação |

Antes de 2026-10-30 18h (UTC) não há marcos de estado: comparar períodos só a partir de 2026-10-31.

## KPIs por público

### Operacional — supervisoras (tempo real / dia)

| KPI | Fórmula | Situação |
|---|---|---|
| Atendimentos ao vivo IA / humano | conversas com `atendimento` = IA ou Atendimento humano e status ≠ resolvida | ✅ pastas "Ao vivo IA" e "Ao vivo humano" |
| Fila aguardando atendente | `atendimento` = Aguardando atendente e status ≠ resolvida | ✅ pasta + aba "Não atribuídas" |
| **Tempo de 1ª resposta (SLA)** | `primeira_resposta_em − transferido_em` (mediana e p90) | ✅ Dashboard, aba Humano (destaque) |
| % respondidos na meta | respondidos em até `SLA_RESPOSTA_MIN` (padrão 15 min) ÷ (respondidos + encerrados sem resposta) | ✅ Dashboard, aba Humano |
| Na fila acima da meta (agora) | fila com `agora − transferido_em` > meta | ✅ Dashboard, aba Humano |
| Tempo da 1ª resposta humana (FRT) | 1ª mensagem 👤 − transferência | ✅ nativo desde 2026-11-03 16h14 UTC (respostas em nome do atendente) |
| Conversas por atendente (carga) | conversas com responsável = atendente, abertas | ✅ nativo (responsável atual) |
| Abandono na fila | transferidas e finalizadas sem `humano_inicio` ÷ transferidas finalizadas | ✅ Dashboard, aba Humano |
| Volume por hora (pico) | atendimentos / transferências por dia da semana × hora | ✅ mapas de calor nas abas IA e Humano |

### Tático — gerente (semana / mês)

| KPI | Fórmula | Situação |
|---|---|---|
| Atendimentos recebidos | conversas criadas no período (ou com `ia_inicio` no período) | ✅ nativo (conversas criadas) |
| Taxa de transferência IA → humano | conversas com `transferido_em` ÷ conversas com `ia_inicio` | ⚠️ nativo conta só a 1ª transferência por conversa |
| Contenção da IA (resolvidas só pela IA) | finalizadas sem `transferido_em` ÷ conversas com `ia_inicio` | ✅ nativo (bot ligado à caixa em 2026-11-03) — vale para conversas novas |
| TMA humano | `finalizado_em − humano_inicio` (só finalizadas por atendente) | ✅ Dashboard, aba Humano |
| CSAT (geral, IA, atendente) | média e % de notas 4–5 em `avaliacao` | ✅ nativo (notas da Blip registradas no CSAT do Chatwoot; 26 históricas importadas) |
| Resoluções por atendente | conversas resolvidas com o atendente responsável | ✅ nativo |
| Recontato / reabertura | conversas reabertas em até 7 dias ÷ finalizadas | ❌ não medido |

### Estratégico — head (mês / trimestre)

Recebidos, contenção da IA, taxa de transferência, CSAT, TME p90 e abandono — com tendência mês a mês e meta.

## SLA de 1ª resposta

- `transferido_em`: ticket da Blip entrando na fila (Waiting/Transferred); recomeça a cada nova transferência.
- `primeira_resposta_em`: 1ª mensagem 👤 do atendente no ciclo (hora da Blip), gravada pela ponte desde 2026-11-03;
  histórico desde 30/10 preenchido por `scripts/backfill-primeira-resposta.py` (hora de chegada no Chatwoot).
- Na prática coincide com `humano_inicio` (a Blip só envia eventos de mensagem), mas o campo próprio mantém o SLA
  correto se o webhook passar a receber "ticket assumido".
- Meta: `SLA_RESPOSTA_MIN` no serviço da ponte (padrão 15). Conta 24h por dia: transferências fora do expediente
  e em feriados (ex.: 02/11) entram com a espera real até o dia seguinte.
- Cada número do Dashboard tem um ícone ⓘ com a definição, a conta com os valores do período e a fonte.

## Situação dos relatórios nativos do Chatwoot neste arranjo

| Métrica nativa | Situação | Motivo |
|---|---|---|
| Conversas, mensagens recebidas | correto | dados nativos |
| Mensagens enviadas | número certo, sem separar bot × humano | tudo entra pelo bot "Blip" |
| Tempo de 1ª resposta, tempo de resposta | ✅ desde 2026-11-03 | respostas do atendente entram em nome dele (tokens via scripts/refresh-agent-tokens.sh) |
| Mensagens por atendente | ✅ desde 2026-11-03 | idem |
| Resoluções / por atendente | correto (responsável no momento de resolver) | evento de resolução |
| Tempo de resolução | **inflado** | conta desde a criação da conversa, inclui IA e até 24h de inatividade |
| Transferências do bot | parcial | só a 1ª por conversa |
| Resolvidas pelo bot / painel de Bot | ✅ para conversas novas | bot "Blip" ligado à caixa |
| "Sem resposta" (unattended) | ✅ para conversas novas | a 1ª resposta do atendente agora é registrada |
| CSAT nativo | ✅ | notas da pesquisa da Blip registradas pela ponte |
| Horário comercial | não configurado | expediente da caixa desligado |

## Regras de qualidade (validate-data)

- Medianas e p90 para tempos (médias são distorcidas por casos de 20h+).
- Nunca "média de médias": agregar a partir das conversas.
- Comparar só períodos completos e com a mesma definição (a partir de 2026-10-31).
- Taxas sempre com numerador e denominador explícitos no painel.

## Auditoria dos dados (`node scripts/auditoria-dados.mjs [de] [até]`)

Roteiro da skill validate-data, somente leitura. Confere:
1. **Consistência interna** — partes somam o todo (só IA + com atendente = recebidos; finalizados + em andamento;
   faixas do SLA; séries diárias; mapas de calor; CSAT), taxas entre 0 e 100%, p90 ≥ mediana.
2. **Qualidade** — datas fora de ordem, notas fora de 1–5, atendente fora do domínio, ciclos duplicados ou fantasmas,
   finalizados sem início, estados divergentes do status.
3. **Fonte independente** — recontagem pelas notas "🔁 Atendimento: X → Y" das conversas (tolerância 3%: as notas usam
   a hora de chegada no Chatwoot e o painel a hora da Blip).
4. **CSAT** — notas ⭐ × campo `avaliacao` × CSAT nativo (a importação de 03/11 grava a data da importação).
5. **Relatórios nativos** — só ordem de grandeza: o nativo conta conversas criadas, cada resolução (inclusive
   reaberturas) e a média da 1ª resposta desde a criação da conversa; o painel conta atendimentos e usa mediana.

Correções de dados feitas em 2026-11-05: `fix-ciclos-repesquisa.py` (24 ciclos-fantasma do pedido de avaliação
repetido), `reconstruir-ciclos.py` (20 atendimentos de 30/10–03/11 sobrescritos antes da lista `ciclos` e 2 notas ⭐).
Resultado em 31/10–04/11: 33 ok, 6 avisos explicados, 0 falhas.

### Notas da pesquisa (2026-11-05)
- Fonte principal: confirmação da Blip "Pronto, salvei aqui a avaliação ... Nota: N" (sem janela de tempo); a resposta
  numérica do cliente vale até 30 min após o pedido. Mensagens da pesquisa (repetição, "...sua experiência com a nossa
  equipe...", pedido de comentário, confirmação) continuam o atendimento finalizado, sem abrir um novo.
- `reconstruir-ciclos.py` também usa as confirmações: 18 notas recuperadas em 05/11. `backfill-csat.py` sincronizou 13 no CSAT nativo.
- CSAT nativo guarda 1 resposta por conversa (a última); o painel conta cada atendimento — o painel é a referência.
- "Finalizados sem início": a Blip mandou a pesquisa numa conversa cujo atendimento a ponte não viu (fluxo da Blip sem o
  webhook). A nota entra na satisfação; o atendimento não entra no volume.
