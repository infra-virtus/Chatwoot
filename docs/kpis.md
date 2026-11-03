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
| Tempo de espera na fila (TME) | `humano_inicio − transferido_em` (mediana e p90) | ⚠️ calculado só por consulta; não existe tela |
| Tempo da 1ª resposta humana (FRT) | 1ª mensagem 👤 − transferência | ✅ nativo desde 2026-11-03 16h14 UTC (respostas em nome do atendente) |
| Conversas por atendente (carga) | conversas com responsável = atendente, abertas | ✅ nativo (responsável atual) |
| Abandono na fila | transferidas e finalizadas sem `humano_inicio` ÷ transferidas | ❌ não existe tela (dado disponível) |
| Volume por hora (pico) | mensagens/conversas do cliente por hora local | ⚠️ nativo por dia; sem mapa de calor |

### Tático — gerente (semana / mês)

| KPI | Fórmula | Situação |
|---|---|---|
| Atendimentos recebidos | conversas criadas no período (ou com `ia_inicio` no período) | ✅ nativo (conversas criadas) |
| Taxa de transferência IA → humano | conversas com `transferido_em` ÷ conversas com `ia_inicio` | ⚠️ nativo conta só a 1ª transferência por conversa |
| Contenção da IA (resolvidas só pela IA) | finalizadas sem `transferido_em` ÷ conversas com `ia_inicio` | ✅ nativo (bot ligado à caixa em 2026-11-03) — vale para conversas novas |
| TMA humano | `finalizado_em − humano_inicio` (só finalizadas por atendente) | ❌ sem tela; nativo mede desde a criação da conversa |
| CSAT (geral, IA, atendente) | média e % de notas 4–5 em `avaliacao` | ✅ nativo (notas da Blip registradas no CSAT do Chatwoot; 26 históricas importadas) |
| Resoluções por atendente | conversas resolvidas com o atendente responsável | ✅ nativo |
| Recontato / reabertura | conversas reabertas em até 7 dias ÷ finalizadas | ❌ não medido |

### Estratégico — head (mês / trimestre)

Recebidos, contenção da IA, taxa de transferência, CSAT, TME p90 e abandono — com tendência mês a mês e meta.

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
