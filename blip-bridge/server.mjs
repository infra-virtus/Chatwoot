// Ponte Blip -> Chatwoot.
// Recebe o Webhook da Blip (roteador wendellroteador) e:
//  1. espelha no Chatwoot as mensagens ENVIADAS pela Blip (bot 🤖 e atendentes 👤), com source_id, então o
//     Chatwoot NÃO as reenvia ao cliente;
//  2. mantém o estado operacional da conversa (campo "atendimento"), a partir de evidências da Blip:
//       mensagem do bot ................................. IA
//       ticket da Blip Desk com status Waiting ............ Aguardando atendente (transferência IA -> humano)
//       mensagem com #messageEmitter=Human ................. Atendimento humano (atribuída ao atendente)
//       ticket encerrado / pedido de avaliação ............. Finalizado (conversa resolvida)
//     e reflete no modelo nativo do Chatwoot: IA = pendente com o Agent Bot "Blip" responsável;
//     aguardando = aberta sem responsável (aba "Não atribuídas"); humano = aberta atribuída ao atendente.
// Formato do payload da Blip: ver /home/infra/blipdash/src/normalize/classify.ts.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { calcularKpis } from './painel/kpis.mjs';

const env = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`variável ${name} ausente`);
  return v;
};

const CHATWOOT_URL = env('CHATWOOT_URL');
const ACCOUNT_ID = env('CHATWOOT_ACCOUNT_ID');
const INBOX_ID = Number(env('CHATWOOT_INBOX_ID'));
const USER_TOKEN = env('CHATWOOT_USER_TOKEN'); // busca de contatos, criação de atendentes, atribuições
const BOT_TOKEN = env('CHATWOOT_BOT_TOKEN'); // mensagens e mudanças de status feitas pelo Agent Bot "Blip"
const BOT_ID = Number(env('CHATWOOT_BOT_ID'));
const PATH_TOKEN = env('BLIP_WEBHOOK_PATH_TOKEN');
const PORT = Number(process.env.PORT || 8080);
// Atendentes só são criados automaticamente para e-mails destes domínios (webhook forjado não cria usuário)
const ALLOWED_AGENT_DOMAINS = env('ALLOWED_AGENT_DOMAINS').toLowerCase().split(',').map((d) => d.trim()).filter(Boolean);
const MAX_BODY_BYTES = 1024 * 1024; // itens do webhook da Blip têm poucos KB

const WEBHOOK_PATH = Buffer.from(`/blip-webhook/${PATH_TOKEN}`);
const isWebhookPath = (url) => {
  const got = Buffer.from(String(url));
  return got.length === WEBHOOK_PATH.length && timingSafeEqual(got, WEBHOOK_PATH);
};
const SKIP_TYPES = new Set(['application/vnd.lime.chatstate+json', 'application/vnd.lime.notification+json']);
const TICKET_TYPE = 'application/vnd.iris.ticket+json';
const CLOSED_TICKET = /^Closed/; // ClosedAttendant, ClosedClient, ClosedClientInactivity
// Mensagem do bot pedindo avaliação encerra o atendimento (regra definida com a operação)
const SURVEY = /avalia(r|ção|cao)|nota de [01] a (5|10)|de 1 a 5|satisfa(ção|cao|ito)|como foi (o|seu) atendimento/i;

// Fluxo da Blip: saudação inicia um atendimento; despedida fecha a pesquisa de satisfação
const SAUDACAO = /seja muito bem-vind|como posso te ajudar hoje/i;
const DESPEDIDA = /agradecemos o seu contato/i;
// Mensagens da pesquisa da Blip depois do pedido de avaliação (repetição, resposta à nota, comentário, confirmação):
// continuam o atendimento finalizado, mesmo fora da janela de 30 min
const POS_PESQUISA = /vamos tentar novamente|experiência com a nossa equipe|comentário sobre sua avaliação|salvei aqui a avalia/i;
// Confirmação da Blip com a nota registrada ("Pronto, salvei aqui a avaliação... 🎯 **Nota**: 5"): fonte da nota sem janela de tempo
const CONFIRMA_NOTA = /salvei aqui a avalia[çc][ãa]o[\s\S]*?nota\W*([1-5])/i;

const ESTADO = {
  IA: 'IA',
  AGUARDANDO: 'Aguardando atendente',
  HUMANO: 'Atendimento humano',
  FIM: 'Finalizado',
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

const bare = (identity) => {
  const i = identity.indexOf('/');
  return (i === -1 ? identity : identity.slice(0, i)).toLowerCase();
};
const domainOf = (identity) => identity.slice(identity.indexOf('@') + 1);
const maskPhone = (digits) => `+${digits.slice(0, 4)}…${digits.slice(-4)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chatwoot reiniciando (deploy, atualização) responde com erro de rede ou 5xx: tenta de novo por ~3 min
// para não perder mensagens da Blip. A fila serial segura as seguintes na ordem.
async function api(path, { method = 'GET', token = USER_TOKEN, body } = {}) {
  for (let tentativa = 1; ; tentativa++) {
    let res;
    try {
      res = await fetch(`${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}${path}`, {
        method,
        headers: { api_access_token: token, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (tentativa >= 12) throw e;
      await sleep(15000);
      continue;
    }
    const text = await res.text();
    if (res.status >= 500 && tentativa < 12) {
      await sleep(15000);
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
}

// A Blip formata com HTML (<b>, <i>, <br>): vira markdown simples e o resto das tags é removido,
// para nenhum HTML de terceiros chegar ao painel.
function sanitize(text) {
  return String(text ?? '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*(b|strong)\s*>(.*?)<\s*\/\s*\1\s*>/gis, '**$2**')
    .replace(/<\s*(i|em)\s*>(.*?)<\s*\/\s*\1\s*>/gis, '_$2_')
    .replace(/<[^>]*>/g, '');
}

function render(type, content) {
  return sanitize(renderRaw(type, content));
}

function renderRaw(type, content) {
  if (type === 'text/plain') return String(content ?? '');
  if (content && typeof content === 'object') {
    if (type === 'application/vnd.lime.media-link+json') {
      return [content.text || content.title, content.uri].filter(Boolean).join('\n');
    }
    if (type === 'application/vnd.lime.select+json') {
      const opts = (content.options || []).map((o, i) => `${i + 1}. ${o.text ?? o.value ?? ''}`);
      return [content.text, ...opts].filter(Boolean).join('\n');
    }
    if (type === 'application/vnd.lime.collection+json') {
      return (content.items || []).map((it) => renderRaw(content.itemType, it)).filter(Boolean).join('\n\n');
    }
    // Interativos/templates do WhatsApp chegam como application/json
    const text = content.text ?? content.interactive?.body?.text ?? content.template?.name;
    if (text) return typeof text === 'string' ? text : JSON.stringify(text);
  }
  return `[${type}]`;
}

// ---------- contato e conversa ----------

// Celular BR: a Meta costuma mandar o wa_id SEM o 9 depois do DDD (12 dígitos) e a Blip COM o 9 (13).
function phoneVariants(digits) {
  const variants = [digits];
  if (digits.startsWith('55') && digits.length === 13 && digits[4] === '9') variants.push(digits.slice(0, 4) + digits.slice(5));
  if (digits.startsWith('55') && digits.length === 12) variants.push(`${digits.slice(0, 4)}9${digits.slice(4)}`);
  return variants;
}

async function findContact(digits) {
  const variants = phoneVariants(digits);
  const search = await api(`/contacts/search?q=${digits.slice(-8)}&include_contact_inboxes=true`);
  const matches = (search.payload || []).filter((c) => variants.includes((c.phone_number || '').replace(/\D/g, '')));
  // prefere o contato que já tem conversa nesta caixa (o criado pelas mensagens da Meta)
  return matches.find((c) => c.contact_inboxes?.some((ci) => ci.inbox?.id === INBOX_ID)) || matches[0];
}

const conversationCache = new Map(); // telefone -> { id, expires }

// Tokens dos atendentes ({"email": "token"}), gerados por scripts/refresh-agent-tokens.sh e montados só leitura.
// Com eles a resposta do atendente entra em nome dele: relatórios nativos de 1ª resposta, tempo de resposta e
// produtividade passam a contar. Sem token (atendente novo), a mensagem entra pelo bot e o log avisa.
const AGENT_TOKENS_FILE = process.env.AGENT_TOKENS_FILE || '/run/secrets/bridge/agent-tokens.json';
let agentTokens = {};
function loadAgentTokens() {
  try {
    agentTokens = JSON.parse(readFileSync(AGENT_TOKENS_FILE, 'utf8'));
  } catch (e) {
    log(`tokens de atendentes indisponíveis: ${e.code || e.message}`);
  }
}
loadAgentTokens();
setInterval(loadAgentTokens, 5 * 60 * 1000).unref();

async function conversationFor(digits) {
  const cached = conversationCache.get(digits);
  if (cached && cached.expires > Date.now()) return cached.id;

  let contact = await findContact(digits);
  let sourceId = contact?.contact_inboxes?.find((ci) => ci.inbox?.id === INBOX_ID)?.source_id;
  if (!contact) {
    const created = await api('/contacts', { method: 'POST', body: { inbox_id: INBOX_ID, phone_number: `+${digits}`, name: `+${digits}` } });
    contact = created.payload.contact;
    sourceId = created.payload.contact_inbox?.source_id;
    log(`contato criado ${maskPhone(digits)} id=${contact.id}`);
  }

  const convs = await api(`/contacts/${contact.id}/conversations`);
  let conv = (convs.payload || [])
    .filter((c) => c.inbox_id === INBOX_ID)
    .sort((a, b) => b.last_activity_at - a.last_activity_at)[0];

  if (!conv) {
    if (!sourceId) {
      const ci = await api(`/contacts/${contact.id}/contact_inboxes`, { method: 'POST', body: { inbox_id: INBOX_ID, source_id: digits } });
      sourceId = ci.source_id;
    }
    conv = await api('/conversations', { method: 'POST', body: { source_id: sourceId, inbox_id: INBOX_ID, contact_id: contact.id } });
    log(`conversa criada id=${conv.id} para ${maskPhone(digits)}`);
  }

  conversationCache.set(digits, { id: conv.id, expires: Date.now() + 10 * 60 * 1000 });
  return conv.id;
}

// ---------- atendentes ----------

// "#message.agentIdentity" da Blip: "<e-mail com @ codificado>@blip.ai", ex.: "maria%40grupovirtus.com.br@blip.ai"
function agentEmail(identity) {
  if (!identity) return null;
  const local = bare(identity).replace(/@blip\.ai$/, '');
  let email;
  try {
    email = decodeURIComponent(local).toLowerCase();
  } catch {
    return null;
  }
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return null;
  if (!ALLOWED_AGENT_DOMAINS.includes(email.split('@')[1])) {
    log(`atendente ignorado: domínio fora da lista permitida (${email.split('@')[1]})`);
    return null;
  }
  return email;
}

const agentCache = new Map(); // e-mail -> id do usuário no Chatwoot

async function agentIdFor(email) {
  if (agentCache.has(email)) return agentCache.get(email);
  const agents = await api('/agents');
  for (const a of agents) agentCache.set(a.email.toLowerCase(), a.id);
  if (!agentCache.has(email)) {
    const name = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const created = await api('/agents', { method: 'POST', body: { name, email, role: 'agent' } });
    await api(`/inbox_members`, { method: 'POST', body: { inbox_id: INBOX_ID, user_ids: [created.id] } });
    agentCache.set(email, created.id);
    log(`atendente criado no Chatwoot id=${created.id} (${email.replace(/^(.).*@/, '$1***@')})`);
  }
  return agentCache.get(email);
}

// ---------- estado operacional ----------

// Horário real do evento na Blip (#envelope.storageDate / storageDate do ticket). A Blip pode atrasar a
// entrega do webhook (já houve 25 min); os tempos de espera e de atendimento usam a hora da Blip, não a de chegada.
// A fila é serial: um item por vez, então uma variável basta.
let eventoEm = Date.now();
const eventoIso = () => new Date(eventoEm).toISOString();

async function setEstado(conversationId, novo, motivo, extra = {}) {
  const conv = await api(`/conversations/${conversationId}`);
  const atual = conv.custom_attributes?.atendimento;
  const agora = eventoIso();
  const attrs = { ...extra };
  if (atual !== novo) {
    attrs.atendimento = novo;
    attrs.atendimento_desde = agora;
    // Saindo de "Finalizado" começa um novo ciclo: o anterior já está guardado em "ciclos"
    if (atual === ESTADO.FIM) Object.assign(attrs, CICLO_VAZIO);
    if (atual === ESTADO.FIM || novo === ESTADO.AGUARDANDO) respondida.delete(conversationId);
    if (novo === ESTADO.IA && (atual === ESTADO.FIM || !conv.custom_attributes?.ia_inicio)) attrs.ia_inicio = agora;
    // Nova transferência: o SLA de 1ª resposta recomeça
    if (novo === ESTADO.AGUARDANDO) Object.assign(attrs, { transferido_em: agora, primeira_resposta_em: null });
    if (novo === ESTADO.HUMANO) attrs.humano_inicio = agora;
  }
  if (Object.keys(attrs).length) {
    await api(`/conversations/${conversationId}/custom_attributes`, { method: 'POST', body: { custom_attributes: attrs, merge: true } });
  }
  if (atual !== novo) {
    // Histórico da mudança, visível só para a equipe
    await api(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      token: BOT_TOKEN,
      body: { content: `🔁 Atendimento: ${atual || 'sem estado'} → ${novo} (${motivo})`, private: true },
    });
    log(`estado conversa ${conversationId}: ${atual || '-'} -> ${novo} (${motivo})`);
  }
  return conv;
}

async function setStatus(conv, status) {
  if (conv.status === status) return;
  // Pelo token do Agent Bot: pendente -> aberta vira "transferência do bot" nos relatórios nativos
  await api(`/conversations/${conv.id}/toggle_status`, { method: 'POST', token: BOT_TOKEN, body: { status } });
}

async function aIA(conversationId, motivo) {
  const conv = await setEstado(conversationId, ESTADO.IA, motivo);
  // Atribuir ao Agent Bot já deixa a conversa "pendente" e fora de "Não atribuídas" (regra nativa)
  if (conv.status !== 'pending' || conv.meta?.assignee_type !== 'AgentBot') {
    await api(`/conversations/${conversationId}/assignments`, { method: 'POST', body: { assignee_id: BOT_ID, assignee_type: 'AgentBot' } });
  }
}

async function aAguardando(conversationId, motivo) {
  const conv = await setEstado(conversationId, ESTADO.AGUARDANDO, motivo);
  // pendente -> aberta pelo token do bot = transferência nativa (limpa o bot e marca o início da espera)
  await setStatus(conv, 'open');
  if (conv.meta?.assignee && conv.meta?.assignee_type !== 'AgentBot') {
    await api(`/conversations/${conversationId}/assignments`, { method: 'POST', body: { assignee_id: null } });
  }
}

async function aHumano(conversationId, email, motivo) {
  const conv = await setEstado(conversationId, ESTADO.HUMANO, motivo, email ? { atendente_blip: email } : {});
  await setStatus(conv, 'open');
  if (email) {
    const userId = await agentIdFor(email);
    if (conv.meta?.assignee?.id !== userId || conv.meta?.assignee_type === 'AgentBot') {
      await api(`/conversations/${conversationId}/assignments`, { method: 'POST', body: { assignee_id: userId } });
    }
  }
}

// Campos do ciclo atual (IA -> fila -> humano -> fim). Ao finalizar, o ciclo é copiado para "ciclos"
// (lista, últimos 30) para o painel contar cada atendimento mesmo quando a conversa é reaberta depois.
const CAMPOS_CICLO = ['ia_inicio', 'transferido_em', 'humano_inicio', 'primeira_resposta_em', 'atendente_blip', 'finalizado_em', 'finalizado_por', 'avaliacao', 'avaliacao_de', 'avaliacao_em'];
const CICLO_VAZIO = Object.fromEntries(CAMPOS_CICLO.map((k) => [k, null]));

// 1ª mensagem do atendente no ciclo (base do SLA de resposta). A memória evita consultar a conversa a cada mensagem.
const respondida = new Set(); // conversationId com primeira_resposta_em já gravada no ciclo atual
async function registrarPrimeiraResposta(conversationId) {
  if (respondida.has(conversationId)) return;
  const conv = await api(`/conversations/${conversationId}`);
  if (!conv.custom_attributes?.primeira_resposta_em) {
    await api(`/conversations/${conversationId}/custom_attributes`, {
      method: 'POST', body: { custom_attributes: { primeira_resposta_em: eventoIso() }, merge: true },
    });
  }
  respondida.add(conversationId);
}

async function aFinalizado(conversationId, por, motivo) {
  const agora = new Date(eventoEm);
  const antes = await api(`/conversations/${conversationId}`);
  if (antes.custom_attributes?.atendimento === ESTADO.FIM) {
    const conv = await setEstado(conversationId, ESTADO.FIM, motivo);
    await setStatus(conv, 'resolved');
    return;
  }
  const ca = antes.custom_attributes || {};
  const ciclo = Object.fromEntries(CAMPOS_CICLO.map((k) => [k, ca[k] ?? null]));
  Object.assign(ciclo, { finalizado_por: por, finalizado_em: agora.toISOString() });
  const ciclos = [...(Array.isArray(ca.ciclos) ? ca.ciclos : []), ciclo].slice(-30);
  const conv = await setEstado(conversationId, ESTADO.FIM, motivo, { finalizado_por: por, finalizado_em: agora.toISOString(), ciclos });
  finalizadoEm.set(conversationId, Date.now()); // janela da pesquisa conta da chegada
  await setStatus(conv, 'resolved');
}

// Último estado conhecido por conversa, para não consultar o Chatwoot a cada mensagem do bot
const estadoCache = new Map(); // conversationId -> estado

// Depois de um reinício a memória está vazia: o estado salvo na conversa é a referência.
async function estadoAtual(conversationId) {
  if (!estadoCache.has(conversationId)) {
    const conv = await api(`/conversations/${conversationId}`);
    const salvo = conv.status === 'resolved' ? ESTADO.FIM : conv.custom_attributes?.atendimento;
    estadoCache.set(conversationId, salvo ?? null);
  }
  return estadoCache.get(conversationId);
}

// Janela após a finalização em que mensagens do bot (pesquisa de satisfação) não reabrem o atendimento
const FECHAMENTO_MS = 30 * 60 * 1000;
const finalizadoEm = new Map(); // conversationId -> timestamp

async function dentroDoFechamento(conversationId) {
  if (!finalizadoEm.has(conversationId)) {
    const conv = await api(`/conversations/${conversationId}`);
    finalizadoEm.set(conversationId, Date.parse(conv.custom_attributes?.finalizado_em || 0) || 0);
  }
  return Date.now() - finalizadoEm.get(conversationId) < FECHAMENTO_MS;
}

async function transition(conversationId, novo, fn) {
  if ((await estadoAtual(conversationId)) === novo && novo !== ESTADO.HUMANO) return;
  await fn();
  estadoCache.set(conversationId, novo);
}

function comNotaNoUltimoCiclo(ca, nota, de) {
  const ciclos = Array.isArray(ca?.ciclos) ? ca.ciclos.map((c) => ({ ...c })) : [];
  if (ciclos.length) Object.assign(ciclos[ciclos.length - 1], { avaliacao: nota, avaliacao_de: de, avaliacao_em: new Date().toISOString() });
  return ciclos;
}

// Nota da pesquisa no atendimento finalizado (vale a primeira): campos do ciclo, nota ⭐ para a equipe e CSAT nativo
async function registrarNota(conversationId, nota) {
  const conv = await api(`/conversations/${conversationId}`);
  if (conv.custom_attributes?.avaliacao != null) return;
  const de = conv.custom_attributes?.finalizado_por === 'IA' ? 'IA' : 'Atendente';
  await api(`/conversations/${conversationId}/custom_attributes`, {
    method: 'POST',
    body: { custom_attributes: { avaliacao: nota, avaliacao_de: de, avaliacao_em: new Date().toISOString(), ciclos: comNotaNoUltimoCiclo(conv.custom_attributes, nota, de) }, merge: true },
  });
  await api(`/conversations/${conversationId}/messages`, {
    method: 'POST', token: BOT_TOKEN, body: { content: `⭐ Avaliação do cliente: ${nota}/5 (${de})`, private: true },
  });
  await registrarCsatNativo(conv, nota);
  log(`avaliação ${nota} (${de}) -> conversa ${conversationId}`);
}

// CSAT nativo do Chatwoot: a nota da pesquisa da Blip vira uma resposta de satisfação (relatório de CSAT,
// atribuída ao responsável atual da conversa). Cria a mensagem de pesquisa com source_id (não é enviada ao
// cliente) e registra a nota pelo endpoint público da pesquisa, o mesmo usado pela página de avaliação.
async function registrarCsatNativo(conv, nota) {
  const msgs = (await api(`/conversations/${conv.id}/messages`)).payload || [];
  if (!msgs.some((m) => m.content_type === 'input_csat')) {
    await api(`/conversations/${conv.id}/messages`, {
      method: 'POST',
      token: BOT_TOKEN,
      body: { content: 'Pesquisa de satisfação (Blip)', content_type: 'input_csat', message_type: 'template', source_id: `blip-csat:${conv.id}` },
    });
  }
  const res = await fetch(`${CHATWOOT_URL}/public/api/v1/csat_survey/${conv.uuid}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { submitted_values: { csat_survey_response: { rating: nota, feedback_message: '' } } } }),
  });
  if (!res.ok) throw new Error(`CSAT nativo conversa ${conv.id} -> HTTP ${res.status}`);
}

// ---------- processamento de cada item do Webhook ----------

const seen = new Set();

function customerDigits(msg) {
  const md = msg.metadata || {};
  const fromBot = domainOf(bare(msg.from)) === 'msging.net';
  const contact = bare(md['#tunnel.originator'] || (fromBot ? msg.to : msg.from));
  if (!contact.endsWith('@wa.gw.msging.net')) return null; // só WhatsApp
  return contact.split('@')[0].replace(/\D/g, '') || null;
}

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || !('type' in msg) || !msg.id || !msg.from || !msg.to) return;
  if (SKIP_TYPES.has(msg.type)) return;
  const quando = Date.parse(msg.metadata?.['#envelope.storageDate'] || msg.content?.storageDate || '');
  eventoEm = Number.isFinite(quando) && quando <= Date.now() + 60_000 ? quando : Date.now();
  const digits = customerDigits(msg);
  if (!digits) return;

  // Ticket da Blip Desk: transferência para humano ou encerramento
  if (msg.type === TICKET_TYPE) {
    const t = msg.content || {};
    const conversationId = await conversationFor(digits);
    if (t.status === 'Waiting' || t.status === 'Transferred') {
      await transition(conversationId, ESTADO.AGUARDANDO, () => aAguardando(conversationId, `ticket #${t.sequentialId} ${t.status} na Blip`));
    } else if (t.status === 'Open' && t.agentIdentity) {
      await transition(conversationId, ESTADO.HUMANO, () => aHumano(conversationId, agentEmail(t.agentIdentity), `ticket #${t.sequentialId} assumido`));
    } else if (CLOSED_TICKET.test(t.status || '')) {
      await transition(conversationId, ESTADO.FIM, () => aFinalizado(conversationId, 'Atendente', `ticket #${t.sequentialId} ${t.status}`));
    }
    log(`ticket #${t.sequentialId} ${t.status} -> conversa ${conversationId}`);
    return;
  }

  // Mensagem do cliente: só interessa como nota da pesquisa de satisfação (1 a 5) logo após o pedido
  if (domainOf(bare(msg.from)) !== 'msging.net') {
    const nota = String(msg.type === 'text/plain' ? msg.content : msg.content?.text ?? '').trim().match(/^([1-5])\b/);
    if (!nota) return;
    const conversationId = await conversationFor(digits);
    if ((await estadoAtual(conversationId)) !== ESTADO.FIM || !(await dentroDoFechamento(conversationId))) return;
    await registrarNota(conversationId, Number(nota[1]));
    return;
  }

  const sourceId = `blip:${msg.id}`;
  if (seen.has(sourceId)) return;

  const md = msg.metadata || {};
  const human = md['#messageEmitter'] === 'Human';
  const text = render(msg.type, msg.content);
  if (!text.trim()) return;

  const conversationId = await conversationFor(digits);
  const email = human ? agentEmail(md['#message.agentIdentity']) : null;
  const senderToken = (email && agentTokens[email]) || BOT_TOKEN;
  if (human && senderToken === BOT_TOKEN) log(`resposta de atendente sem token (${email ? 'rodar refresh-agent-tokens' : 'sem e-mail'}): entra pelo bot`);
  await api(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    token: senderToken,
    body: { content: `${human ? '👤' : '🤖'} ${text}`, message_type: 'outgoing', source_id: sourceId },
  });
  seen.add(sourceId);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  log(`espelhada ${human ? 'atendente' : 'bot'} -> conversa ${conversationId} (${maskPhone(digits)})`);

  // Estado a partir da mensagem
  if (human) {
    const ticket = md['#message.ticketId'] ? ' do ticket' : '';
    await transition(conversationId, ESTADO.HUMANO, () => aHumano(conversationId, email, `mensagem do atendente${ticket}`));
    await registrarPrimeiraResposta(conversationId);
    return;
  }
  const atual = await estadoAtual(conversationId);
  // A pesquisa de satisfação continua depois do pedido de avaliação (respostas, comentário, agradecimento):
  // nesse intervalo a conversa segue finalizada e, se a resposta do cliente a reabriu, é encerrada de novo.
  // Uma saudação do bot é o começo de um novo atendimento e encerra a janela; a mensagem de despedida
  // da pesquisa encerra a janela depois de manter a conversa finalizada.
  // Pedido de avaliação repetido depois da janela: não abre um atendimento novo, reabre a janela para receber a nota
  if (atual === ESTADO.FIM && (SURVEY.test(text) || POS_PESQUISA.test(text)) && !SAUDACAO.test(text)) {
    const confirmada = CONFIRMA_NOTA.exec(text);
    if (confirmada) await registrarNota(conversationId, Number(confirmada[1]));
    finalizadoEm.set(conversationId, Date.now());
    await setStatus(await api(`/conversations/${conversationId}`), 'resolved');
    return;
  }
  if (atual === ESTADO.FIM && !SAUDACAO.test(text) && (await dentroDoFechamento(conversationId))) {
    const conv = await api(`/conversations/${conversationId}`);
    await setStatus(conv, 'resolved');
    if (DESPEDIDA.test(text)) finalizadoEm.set(conversationId, 0);
    return;
  }
  if (SURVEY.test(text)) {
    const por = atual === ESTADO.HUMANO || atual === ESTADO.AGUARDANDO ? 'Atendente' : 'IA';
    await transition(conversationId, ESTADO.FIM, () => aFinalizado(conversationId, por, 'pedido de avaliação'));
    return;
  }
  // Na fila da Blip o bot ainda manda avisos ("aguarde..."): continua aguardando atendente.
  if (atual === ESTADO.AGUARDANDO) return;
  await transition(conversationId, ESTADO.IA, () =>
    aIA(conversationId, atual === ESTADO.HUMANO ? 'bot voltou a responder após o atendente' : 'mensagem do bot'));
}

// ---------- Dashboard IA (/painel-ia) ----------
// Página aberta de dentro do Chatwoot (mesmo endereço). Acesso pelo login do próprio Chatwoot: o navegador envia o
// cookie de sessão "cw_d_session_info"; a ponte confere a sessão em /api/v1/profile e libera só os e-mails da lista.
const PAINEL_EMAILS = (process.env.DASHBOARD_ALLOWED_EMAILS || '').toLowerCase().split(',').map((e) => e.trim()).filter(Boolean);
const PAINEL_DIR = new URL('./painel/', import.meta.url);
const sessoes = new Map(); // hash da sessão -> { usuario, expira }

function cookie(req, nome) {
  for (const parte of String(req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

async function usuarioDaSessao(req) {
  let s;
  try {
    s = JSON.parse(cookie(req, 'cw_d_session_info') || 'null');
  } catch {
    return null;
  }
  if (!s?.['access-token'] || !s.client || !s.uid) return null;
  const chave = createHash('sha256').update(`${s['access-token']}|${s.client}|${s.uid}`).digest('hex');
  const cache = sessoes.get(chave);
  if (cache && cache.expira > Date.now()) return cache.usuario;
  const res = await fetch(`${CHATWOOT_URL}/api/v1/profile`, {
    headers: { 'access-token': s['access-token'], client: s.client, uid: s.uid, 'token-type': 'Bearer' },
  });
  const usuario = res.ok ? await res.json() : null;
  sessoes.set(chave, { usuario, expira: Date.now() + 5 * 60 * 1000 });
  if (sessoes.size > 500) sessoes.delete(sessoes.keys().next().value);
  return usuario;
}


async function conversasDesde(dataIso) {
  const lista = [];
  for (let page = 1; page <= 400; page++) {
    const r = await api(`/conversations/filter?page=${page}`, {
      method: 'POST',
      body: { payload: [{ attribute_key: 'last_activity_at', filter_operator: 'is_greater_than', values: [dataIso], query_operator: null }] },
    });
    const b = r.payload || [];
    if (!b.length) break;
    for (const c of b) lista.push({ id: c.id, status: c.status, custom_attributes: c.custom_attributes || {} });
  }
  return lista;
}

async function agoraAoVivo() {
  // Todas as páginas (25 por página): a maior espera e os atendentes ativos precisam da lista completa
  const contar = async (valor) => {
    const lista = [];
    for (let page = 1; page <= 10; page++) {
      const r = await api(`/conversations/filter?page=${page}`, {
        method: 'POST',
        body: { payload: [
          { attribute_key: 'atendimento', filter_operator: 'equal_to', values: [valor], query_operator: 'and' },
          { attribute_key: 'status', filter_operator: 'not_equal_to', values: ['resolved'], query_operator: null },
        ] },
      });
      lista.push(...(r.payload || []));
      if ((r.payload || []).length < 25) break;
    }
    return { total: lista.length, amostra: lista };
  };
  const [ia, fila, humano] = await Promise.all([contar(ESTADO.IA), contar(ESTADO.AGUARDANDO), contar(ESTADO.HUMANO)]);
  const esperas = fila.amostra.map((c) => (Date.now() - Date.parse(c.custom_attributes?.transferido_em || '')) / 60000).filter(Number.isFinite);
  const atendentes = new Set(humano.amostra.map((c) => c.meta?.assignee?.id).filter(Boolean));
  return {
    ia: ia.total,
    aguardando: fila.total,
    humano: humano.total,
    maior_espera_min: esperas.length ? Math.max(...esperas) : null,
    fora_da_meta: esperas.filter((m) => m > SLA_RESPOSTA_MIN).length,
    meta_min: SLA_RESPOSTA_MIN,
    atendentes_ativos: atendentes.size,
    atualizado_em: new Date().toISOString(),
  };
}

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLA_RESPOSTA_MIN = Number(process.env.SLA_RESPOSTA_MIN || 15);

// Leitura das conversas para o painel: uma "foto" dos últimos 30 dias renovada a cada 5 min em segundo plano
// (a leitura leva mais de 1 min). Os períodos dentro dela são calculados da memória em milissegundos; enquanto a foto
// nova é lida, vale a anterior. Pedidos ao mesmo tempo compartilham a mesma leitura.
const FOTO_DIAS = 30;
const hojeSP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const diasAtras = (n) => new Date(Date.parse(`${hojeSP()}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
let foto = null; // { desde, conversas, lida_em }
let lendoFoto = null;
function atualizarFoto() {
  lendoFoto ||= conversasDesde(diasAtras(FOTO_DIAS))
    .then((conversas) => (foto = { desde: diasAtras(FOTO_DIAS), conversas, lida_em: new Date().toISOString() }))
    .finally(() => { lendoFoto = null; });
  return lendoFoto;
}

// Períodos que começam antes da foto (até 92 dias): leitura própria, guardada por 6 min
const avulsas = new Map(); // desde -> { promessa, expira }
async function conversasPara(de) {
  if (foto && foto.desde <= de) return foto;
  if (diasAtras(FOTO_DIAS) <= de) return atualizarFoto();
  const desde = new Date(Date.parse(`${de}T00:00:00-03:00`) - 86400000).toISOString().slice(0, 10);
  const guardada = avulsas.get(desde);
  if (guardada && guardada.expira > Date.now()) return guardada.promessa;
  const promessa = conversasDesde(desde).then((conversas) => ({ desde, conversas, lida_em: new Date().toISOString() }));
  avulsas.set(desde, { promessa, expira: Date.now() + 6 * 60 * 1000 });
  promessa.catch(() => avulsas.delete(desde));
  if (avulsas.size > 20) avulsas.delete(avulsas.keys().next().value);
  return promessa;
}

async function kpisDoPeriodo(de, ate) {
  const base = await conversasPara(de);
  return { ...calcularKpis(base.conversas, de, ate, SLA_RESPOSTA_MIN), conversas_lidas: base.conversas.length, calculado_em: base.lida_em, dados_desde: '2026-10-30' };
}

if (PAINEL_EMAILS.length) {
  setTimeout(() => atualizarFoto().catch((e) => log('ERRO painel (leitura)', e.message)), 20000).unref();
  setInterval(() => atualizarFoto().catch((e) => log('ERRO painel (leitura)', e.message)), 5 * 60 * 1000).unref();
}

async function rotaPainel(req, res) {
  const url = new URL(req.url, 'http://local');
  const enviar = (status, corpo, tipo = 'application/json; charset=utf-8') => {
    res.writeHead(status, {
      'Content-Type': tipo,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
    });
    res.end(typeof corpo === 'string' || Buffer.isBuffer(corpo) ? corpo : JSON.stringify(corpo));
  };
  if (req.method !== 'GET') return enviar(405, { erro: 'método não permitido' });

  if (url.pathname === '/painel-ia' || url.pathname === '/painel-ia/') return enviar(200, readFileSync(new URL('index.html', PAINEL_DIR)), 'text/html; charset=utf-8');
  if (url.pathname === '/painel-ia/app.js') return enviar(200, readFileSync(new URL('app.js', PAINEL_DIR)), 'text/javascript; charset=utf-8');

  const usuario = await usuarioDaSessao(req);
  if (!usuario) return enviar(401, { erro: 'Entre no Atendimento Wendell para ver o painel.' });
  const email = String(usuario.email || '').toLowerCase();
  if (!PAINEL_EMAILS.includes(email)) {
    log(`painel: acesso negado (${email.replace(/^(.).*@/, '$1***@')})`);
    return enviar(403, { erro: 'Seu usuário ainda não tem acesso ao Dashboard IA.' });
  }

  if (url.pathname === '/painel-ia/api/me') return enviar(200, { nome: usuario.name, email });
  if (url.pathname === '/painel-ia/api/agora') return enviar(200, await agoraAoVivo());
  if (url.pathname === '/painel-ia/api/kpis') {
    const de = url.searchParams.get('de');
    const ate = url.searchParams.get('ate');
    if (!DATA_RE.test(de || '') || !DATA_RE.test(ate || '') || de > ate) return enviar(422, { erro: 'Período inválido (use AAAA-MM-DD).' });
    if ((Date.parse(ate) - Date.parse(de)) / 86400000 > 92) return enviar(422, { erro: 'Período máximo: 92 dias.' });
    return enviar(200, await kpisDoPeriodo(de, ate));
  }
  return enviar(404, { erro: 'não encontrado' });
}

// Fila serial: evita criar a mesma conversa duas vezes e aplica as transições na ordem de chegada.
let queue = Promise.resolve();
const stats = { requisicoes: 0, itens: 0, erros: 0 };
const enqueue = (item) => {
  stats.itens++;
  queue = queue.then(() => handle(item)).catch((e) => {
    stats.erros++;
    log('ERRO', e.message);
  });
};

// Varredura a cada 10 min (entra na mesma fila serial):
//  - conversas da IA (pendentes) sem atividade há 24h: o encerramento automático do Chatwoot só pega as abertas;
//  - conversas resolvidas pelo encerramento automático com estado desatualizado: grava "Finalizado (Inatividade)".
async function varredura() {
  const limite = Date.now() / 1000 - 24 * 3600;
  let finalizadas = 0;
  let sincronizadas = 0;
  for (let page = 1; page <= 20; page++) {
    const batch = (await api(`/conversations?inbox_id=${INBOX_ID}&status=pending&assignee_type=all&page=${page}`)).data.payload;
    if (!batch.length) break;
    for (const c of batch.filter((c) => c.last_activity_at < limite)) {
      eventoEm = Date.now();
      await aFinalizado(c.id, 'Inatividade', '24h sem atividade');
      estadoCache.set(c.id, ESTADO.FIM);
      finalizadas++;
    }
  }
  const ativos = [ESTADO.IA, ESTADO.AGUARDANDO, ESTADO.HUMANO];
  const res = await api('/conversations/filter?page=1', {
    method: 'POST',
    body: { payload: [
      { attribute_key: 'atendimento', filter_operator: 'equal_to', values: ativos, query_operator: 'and' },
      { attribute_key: 'status', filter_operator: 'equal_to', values: ['resolved'], query_operator: null },
    ] },
  });
  for (const c of res.payload || []) {
    const ts = new Date((c.last_activity_at || Date.now() / 1000) * 1000).toISOString();
    await api(`/conversations/${c.id}/custom_attributes`, {
      method: 'POST',
      body: { custom_attributes: { atendimento: ESTADO.FIM, finalizado_por: 'Inatividade', finalizado_em: ts, atendimento_desde: ts }, merge: true },
    });
    estadoCache.set(c.id, ESTADO.FIM);
    sincronizadas++;
  }
  // Finalizadas que reabriram (cliente respondeu depois da pesquisa) e ninguém retomou: volta a resolver
  const reabertas = await api('/conversations/filter?page=1', {
    method: 'POST',
    body: { payload: [
      { attribute_key: 'atendimento', filter_operator: 'equal_to', values: [ESTADO.FIM], query_operator: 'and' },
      { attribute_key: 'status', filter_operator: 'equal_to', values: ['open', 'pending'], query_operator: null },
    ] },
  });
  for (const c of (reabertas.payload || []).filter((c) => c.last_activity_at < Date.now() / 1000 - FECHAMENTO_MS / 1000)) {
    await setStatus(c, 'resolved');
    sincronizadas++;
  }
  if (finalizadas || sincronizadas) log(`varredura: IA inativas finalizadas=${finalizadas} estados sincronizados=${sincronizadas}`);
}
setInterval(() => {
  queue = queue.then(varredura).catch((e) => log('ERRO varredura', e.message));
}, 10 * 60 * 1000).unref();

// Resumo periódico (só contagens) para monitorar se a Blip continua enviando
setInterval(() => {
  log(`resumo 5min: requisições=${stats.requisicoes} itens=${stats.itens} erros=${stats.erros}`);
  stats.requisicoes = stats.itens = stats.erros = 0;
}, 5 * 60 * 1000).unref();

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return res.end('ok');
    if (req.url.startsWith('/painel-ia')) {
      rotaPainel(req, res).catch((e) => {
        log('ERRO painel', e.message);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ erro: 'Falha ao calcular o painel. Tente de novo em instantes.' }));
      });
      return;
    }
    if (req.method !== 'POST' || !isWebhookPath(req.url)) {
      res.statusCode = 404;
      return res.end();
    }
    stats.requisicoes++;
    let raw = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        res.statusCode = 413;
        res.end();
        req.destroy();
        return;
      }
      raw += c;
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      res.end('ok'); // responde já; processa em seguida
      try {
        const body = JSON.parse(raw);
        (Array.isArray(body) ? body : [body]).forEach(enqueue);
      } catch {
        log('corpo inválido ignorado');
      }
    });
  })
  .listen(PORT, () => log(`ponte Blip -> Chatwoot ouvindo em :${PORT}`));
