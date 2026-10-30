// Ponte Blip -> Chatwoot (espelho).
// Recebe o Webhook da Blip e registra no Chatwoot as mensagens ENVIADAS pela Blip (bot e atendentes),
// na conversa do cliente da caixa de entrada do WhatsApp. As mensagens entram com source_id, então o
// Chatwoot NÃO as reenvia ao cliente: é só histórico.
// Formato do payload da Blip: ver /home/infra/blipdash/src/normalize/classify.ts.
import http from 'node:http';

const env = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`variável ${name} ausente`);
  return v;
};

const CHATWOOT_URL = env('CHATWOOT_URL');
const ACCOUNT_ID = env('CHATWOOT_ACCOUNT_ID');
const INBOX_ID = Number(env('CHATWOOT_INBOX_ID'));
const USER_TOKEN = env('CHATWOOT_USER_TOKEN'); // busca/criação de contato e conversa
const BOT_TOKEN = env('CHATWOOT_BOT_TOKEN'); // mensagens assinadas pelo Agent Bot "Blip"
const PATH_TOKEN = env('BLIP_WEBHOOK_PATH_TOKEN');
const PORT = Number(process.env.PORT || 8080);

const WEBHOOK_PATH = `/blip-webhook/${PATH_TOKEN}`;
const SKIP_TYPES = new Set(['application/vnd.lime.chatstate+json', 'application/vnd.lime.notification+json']);

const log = (...a) => console.log(new Date().toISOString(), ...a);

const bare = (identity) => {
  const i = identity.indexOf('/');
  return (i === -1 ? identity : identity.slice(0, i)).toLowerCase();
};
const domainOf = (identity) => identity.slice(identity.indexOf('@') + 1);

async function api(path, { method = 'GET', token = USER_TOKEN, body } = {}) {
  const res = await fetch(`${CHATWOOT_URL}/api/v1/accounts/${ACCOUNT_ID}${path}`, {
    method,
    headers: { api_access_token: token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function render(type, content) {
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
      return (content.items || []).map((it) => render(content.itemType, it)).filter(Boolean).join('\n\n');
    }
    // Interativos/templates do WhatsApp chegam como application/json
    const text = content.text ?? content.interactive?.body?.text ?? content.template?.name;
    if (text) return typeof text === 'string' ? text : JSON.stringify(text);
  }
  return `[${type}]`;
}

// telefone (somente dígitos, como o wa_id da Meta) -> id da conversa no Chatwoot
const conversationCache = new Map();
const seen = new Set();

// Celular BR: a Meta costuma mandar o wa_id SEM o 9 depois do DDD (12 dígitos) e a Blip COM o 9 (13).
// Devolve as duas formas, a recebida primeiro.
function phoneVariants(digits) {
  const variants = [digits];
  if (digits.startsWith('55') && digits.length === 13 && digits[4] === '9') variants.push(digits.slice(0, 4) + digits.slice(5));
  if (digits.startsWith('55') && digits.length === 12) variants.push(`${digits.slice(0, 4)}9${digits.slice(4)}`);
  return variants;
}

async function findContact(digits) {
  const variants = phoneVariants(digits);
  // busca pelos 8 dígitos finais, comuns às duas formas
  const search = await api(`/contacts/search?q=${digits.slice(-8)}&include_contact_inboxes=true`);
  const matches = (search.payload || []).filter((c) => variants.includes((c.phone_number || '').replace(/\D/g, '')));
  // prefere o contato que já tem conversa nesta caixa (o criado pelas mensagens da Meta)
  return matches.find((c) => c.contact_inboxes?.some((ci) => ci.inbox?.id === INBOX_ID)) || matches[0];
}

async function conversationFor(digits) {
  const cached = conversationCache.get(digits);
  if (cached && cached.expires > Date.now()) return cached.id;

  let contact = await findContact(digits);

  let sourceId = contact?.contact_inboxes?.find((ci) => ci.inbox?.id === INBOX_ID)?.source_id;
  if (!contact) {
    const created = await api('/contacts', { method: 'POST', body: { inbox_id: INBOX_ID, phone_number: `+${digits}`, name: `+${digits}` } });
    contact = created.payload.contact;
    sourceId = created.payload.contact_inbox?.source_id;
    log(`contato criado +${digits} id=${contact.id}`);
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
    log(`conversa criada id=${conv.id} para +${digits}`);
  }

  conversationCache.set(digits, { id: conv.id, expires: Date.now() + 10 * 60 * 1000 });
  return conv.id;
}

async function handle(msg) {
  if (!msg || typeof msg !== 'object' || !('type' in msg) || !msg.id || !msg.from || !msg.to) return;
  if (SKIP_TYPES.has(msg.type)) return;
  if (domainOf(bare(msg.from)) !== 'msging.net') return; // só o que a Blip ENVIOU

  const md = msg.metadata || {};
  const contact = bare(md['#tunnel.originator'] || msg.to);
  if (!contact.endsWith('@wa.gw.msging.net')) return; // só WhatsApp
  const digits = contact.split('@')[0].replace(/\D/g, '');
  if (!digits) return;

  const sourceId = `blip:${msg.id}`;
  if (seen.has(sourceId)) return;

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
  log(`espelhada ${human ? 'atendente' : 'bot'} -> conversa ${conversationId} (+${digits})`);
}

// Fila serial: evita criar a mesma conversa duas vezes quando chegam mensagens em sequência.
let queue = Promise.resolve();
const enqueue = (item) => {
  queue = queue.then(() => handle(item)).catch((e) => log('ERRO', e.message));
};

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return res.end('ok');
    if (req.method !== 'POST' || req.url !== WEBHOOK_PATH) {
      res.statusCode = 404;
      return res.end();
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.end('ok'); // responde já; processa em seguida
      try {
        const body = JSON.parse(raw);
        for (const b of Array.isArray(body) ? body : [body]) {
          const md = b?.metadata || {};
          const botSide = [b?.from, b?.to].map((x) => (x ? bare(x) : '')).find((x) => domainOf(x) === 'msging.net');
          log(
            `recebido type=${b?.type ?? b?.category ?? '?'} from=${b?.from ? domainOf(bare(b.from)) : '?'} ` +
              `bot=${botSide ?? '?'} roteador=${md['#tunnel.owner'] ? bare(md['#tunnel.owner']) : '-'} ` +
              `canal=${domainOf(bare(md['#tunnel.originator'] || (domainOf(bare(b?.from || '')) === 'msging.net' ? b?.to : b?.from) || ''))} emitter=${md['#messageEmitter'] ?? '-'}`,
          );
        }
        (Array.isArray(body) ? body : [body]).forEach(enqueue);
      } catch {
        log('corpo inválido ignorado');
      }
    });
  })
  .listen(PORT, () => log(`ponte Blip -> Chatwoot ouvindo em :${PORT}`));
