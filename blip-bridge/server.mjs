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
import { timingSafeEqual } from 'node:crypto';

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

async function setEstado(conversationId, novo, motivo, extra = {}) {
  const conv = await api(`/conversations/${conversationId}`);
  const atual = conv.custom_attributes?.atendimento;
  const agora = new Date().toISOString();
  const attrs = { ...extra };
  if (atual !== novo) {
    attrs.atendimento = novo;
    attrs.atendimento_desde = agora;
    if (novo === ESTADO.IA && !conv.custom_attributes?.ia_inicio) attrs.ia_inicio = agora;
    if (novo === ESTADO.AGUARDANDO) attrs.transferido_em = agora;
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

async function aFinalizado(conversationId, por, motivo) {
  const agora = new Date();
  const conv = await setEstado(conversationId, ESTADO.FIM, motivo, { finalizado_por: por, finalizado_em: agora.toISOString() });
  finalizadoEm.set(conversationId, agora.getTime());
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
    const conv = await api(`/conversations/${conversationId}`);
    if (conv.custom_attributes?.avaliacao != null) return; // vale a primeira nota
    const de = conv.custom_attributes?.finalizado_por === 'IA' ? 'IA' : 'Atendente';
    await api(`/conversations/${conversationId}/custom_attributes`, {
      method: 'POST',
      body: { custom_attributes: { avaliacao: Number(nota[1]), avaliacao_de: de, avaliacao_em: new Date().toISOString() }, merge: true },
    });
    await api(`/conversations/${conversationId}/messages`, {
      method: 'POST', token: BOT_TOKEN, body: { content: `⭐ Avaliação do cliente: ${nota[1]}/5 (${de})`, private: true },
    });
    log(`avaliação ${nota[1]} (${de}) -> conversa ${conversationId}`);
    return;
  }

  const sourceId = `blip:${msg.id}`;
  if (seen.has(sourceId)) return;

  const md = msg.metadata || {};
  const human = md['#messageEmitter'] === 'Human';
  const text = render(msg.type, msg.content);
  if (!text.trim()) return;

  const conversationId = await conversationFor(digits);
  await api(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    token: BOT_TOKEN,
    body: { content: `${human ? '👤' : '🤖'} ${text}`, message_type: 'outgoing', source_id: sourceId },
  });
  seen.add(sourceId);
  if (seen.size > 5000) seen.delete(seen.values().next().value);
  log(`espelhada ${human ? 'atendente' : 'bot'} -> conversa ${conversationId} (${maskPhone(digits)})`);

  // Estado a partir da mensagem
  if (human) {
    const email = agentEmail(md['#message.agentIdentity']);
    const ticket = md['#message.ticketId'] ? ' do ticket' : '';
    await transition(conversationId, ESTADO.HUMANO, () => aHumano(conversationId, email, `mensagem do atendente${ticket}`));
    return;
  }
  const atual = await estadoAtual(conversationId);
  // A pesquisa de satisfação continua depois do pedido de avaliação (respostas, comentário, agradecimento):
  // nesse intervalo a conversa segue finalizada e, se a resposta do cliente a reabriu, é encerrada de novo.
  // Uma saudação do bot é o começo de um novo atendimento e encerra a janela; a mensagem de despedida
  // da pesquisa encerra a janela depois de manter a conversa finalizada.
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

// Resumo periódico (só contagens) para monitorar se a Blip continua enviando
setInterval(() => {
  log(`resumo 5min: requisições=${stats.requisicoes} itens=${stats.itens} erros=${stats.erros}`);
  stats.requisicoes = stats.itens = stats.erros = 0;
}, 5 * 60 * 1000).unref();

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return res.end('ok');
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
