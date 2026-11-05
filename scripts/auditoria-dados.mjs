// Auditoria dos dados do Dashboard (roteiro da skill validate-data): consistência interna, qualidade dos dados e
// conferência contra fontes independentes (notas "🔁 Atendimento" das conversas, notas ⭐, CSAT e relatórios nativos).
// Somente leitura. uso: node scripts/auditoria-dados.mjs [AAAA-MM-DD de] [AAAA-MM-DD até]
import { readFileSync } from 'node:fs';
import { calcularKpis, ciclosDaConversa } from '../blip-bridge/painel/kpis.mjs';

const TOK = readFileSync(`${process.env.HOME}/.secrets/chatwoot.token`, 'utf8').trim();
const BASE = 'https://visualchat.wendellcarvalho.com.br';
const B = `${BASE}/api/v1/accounts/1`;
const [de = '2026-10-31', ate = '2026-11-04'] = process.argv.slice(2);
const TZ = 'America/Sao_Paulo';
const dataLocal = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms));
const noPeriodo = (ms) => Number.isFinite(ms) && dataLocal(ms) >= de && dataLocal(ms) <= ate;
const inicioSP = Date.parse(`${de}T00:00:00-03:00`) / 1000;
const fimSP = Date.parse(`${ate}T23:59:59-03:00`) / 1000;

const res = { PASS: 0, WARN: 0, FAIL: 0 };
function check(nivelSeFalhar, ok, nome, det = '') {
  const n = ok ? 'PASS' : nivelSeFalhar;
  res[n]++;
  console.log(`${n.padEnd(4)}  ${nome}${det ? ` — ${det}` : ''}`);
}
const igual = (nome, a, b, tol = 0, nivel = 'FAIL') => check(nivel, Math.abs(a - b) <= tol, nome, `${a} vs ${b}${tol ? ` (tolerância ${tol})` : ''}`);

async function api(path, opts = {}) {
  const r = await fetch(path.startsWith('http') ? path : B + path, {
    method: opts.method || 'GET',
    headers: { api_access_token: TOK, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

// ---------- dados ----------
const desde = new Date((inicioSP - 86400) * 1000).toISOString().slice(0, 10);
const convs = [];
for (let p = 1; ; p++) {
  const b = (await api(`/conversations/filter?page=${p}`, { method: 'POST', body: { payload: [
    { attribute_key: 'last_activity_at', filter_operator: 'is_greater_than', values: [desde], query_operator: null }] } })).payload;
  if (!b.length) break;
  convs.push(...b);
}
const k = calcularKpis(convs, de, ate, 15);
const ciclos = convs.flatMap(ciclosDaConversa).filter((c) => noPeriodo(c.inicio));
console.log(`Período ${de} a ${ate} (Brasília) · ${convs.length} conversas lidas · ${ciclos.length} ciclos no período\n`);

// ---------- 1. consistência interna (partes somam o todo) ----------
console.log('1. Consistência interna');
const g = k.geral;
igual('só IA + com atendente = recebidos', g.so_ia + g.com_humano, k.recebidos);
igual('finalizados + em andamento = recebidos', g.finalizados + g.em_andamento, k.recebidos);
igual('finalizados por IA + atendente + inatividade = finalizados', g.finalizados_por.IA + g.finalizados_por.Atendente + g.finalizados_por.Inatividade, g.finalizados);
igual('finalizados só IA + com atendente = finalizados', g.finalizados_so_ia + g.finalizados_com_humano, g.finalizados);
igual('respondidos + sem resposta + aguardando = transferidos', k.sla.respondidos + k.sla.sem_resposta + k.sla.aguardando_resposta, k.sla.transferidos);
igual('faixas da 1ª resposta somam os respondidos', k.sla.faixas.reduce((s, f) => s + f.n, 0), k.sla.respondidos);
igual('série diária soma os recebidos', k.serie.reduce((s, d) => s + d.recebidos, 0), k.recebidos);
igual('série diária só IA + com atendente = recebidos', k.serie.reduce((s, d) => s + d.so_ia + d.com_humano, 0), k.recebidos);
igual('mapa de calor soma os recebidos', k.calor.flat().reduce((s, v) => s + v, 0), k.recebidos);
igual('mapa de transferências soma os transferidos', k.calor_fila.flat().reduce((s, v) => s + v, 0), k.sla.transferidos);
igual('distribuição do CSAT soma as avaliações', k.csat.geral.distribuicao.reduce((s, v) => s + v, 0), k.csat.geral.n);
igual('CSAT IA + atendente = CSAT geral', k.csat.ia.n + k.csat.atendente.n, k.csat.geral.n);
igual('sem resposta = abandono na fila', k.sla.sem_resposta, k.abandono_fila.num);
check('FAIL', k.atendentes.reduce((s, a) => s + a.atendimentos, 0) <= ciclos.filter((c) => c.humano_inicio).length, 'atendimentos por atendente ≤ atendimentos humanos');
const taxas = [k.transferencia, k.contencao_ia, k.abandono_fila, k.sla.na_meta, g.participacao_ia, g.ia_inatividade, ...Object.values(g.cobertura)];
check('FAIL', taxas.every((t) => t.pct == null || (t.pct >= 0 && t.pct <= 100 && t.num <= t.den)), 'todas as taxas entre 0% e 100% com numerador ≤ denominador');
const tempos = [k.espera_fila_min, k.tma_humano_min, k.sla.primeira_resposta_min, g.duracao_ia_min, g.duracao_humano_min];
check('FAIL', tempos.every((r) => r.mediana == null || (r.mediana >= 0 && r.p90 >= r.mediana)), 'tempos não negativos e p90 ≥ mediana');

// ---------- 2. qualidade dos dados ----------
console.log('\n2. Qualidade dos dados (ciclos do período)');
const T = (iso) => (iso ? Date.parse(iso) : NaN);
const ruins = (nome, f, nivel = 'FAIL') => { const l = ciclos.filter(f); check(nivel, !l.length, nome, l.length ? `${l.length} casos, ex.: conversas ${[...new Set(l.map((c) => c.conversa))].slice(0, 5).join(', ')}` : ''); };
ruins('encerramento antes do início', (c) => c.finalizado_em && T(c.finalizado_em) < c.inicio - 1000);
ruins('atendente antes da transferência', (c) => c.humano_inicio && c.transferido_em && T(c.humano_inicio) < T(c.transferido_em) - 1000, 'WARN');
ruins('1ª resposta antes da transferência', (c) => c.primeira_resposta_em && c.transferido_em && T(c.primeira_resposta_em) < T(c.transferido_em) - 1000, 'WARN');
ruins('nota fora de 1 a 5', (c) => c.avaliacao != null && !(Number(c.avaliacao) >= 1 && Number(c.avaliacao) <= 5));
ruins('finalizado sem "finalizado por" válido', (c) => c.finalizado_em && !['IA', 'Atendente', 'Inatividade'].includes(c.finalizado_por));
ruins('atendente fora do domínio permitido', (c) => c.atendente_blip && !/@grupovirtus\.com\.br$/i.test(c.atendente_blip));
ruins('ciclo-fantasma (IA de até 15 s com pesquisa)', (c) => c.finalizado_por === 'IA' && !c.transferido_em && !c.humano_inicio && T(c.finalizado_em) - c.inicio <= 15000, 'WARN');
ruins('atendimento humano sem atendente identificado', (c) => c.humano_inicio && !c.atendente_blip, 'WARN');
ruins('tempo de 1ª resposta acima de 24h', (c) => c.primeira_resposta_em && c.transferido_em && T(c.primeira_resposta_em) - T(c.transferido_em) > 86400000, 'WARN');
const semInicio = convs.flatMap((c) => [...(c.custom_attributes.ciclos || []), c.custom_attributes].map((x) => ({ ...x, conversa: c.id })))
  .filter((x) => x.finalizado_em && !x.ia_inicio && !x.transferido_em && !x.humano_inicio && noPeriodo(T(x.finalizado_em)));
check('WARN', !semInicio.length, 'finalizados sem início registrado (ficam fora do painel)',
  semInicio.length ? `${semInicio.length} casos, ${semInicio.filter((x) => x.avaliacao != null).length} com nota; ex.: ${[...new Set(semInicio.map((x) => x.conversa))].slice(0, 5).join(', ')}` : '');
const dup = convs.filter((c) => { const f = (c.custom_attributes.ciclos || []).map((x) => x.finalizado_em).filter(Boolean); return new Set(f).size !== f.length; });
check('FAIL', !dup.length, 'ciclos duplicados na mesma conversa', dup.length ? `conversas ${dup.slice(0, 5).map((c) => c.id).join(', ')}` : '');
const cheias = convs.filter((c) => (c.custom_attributes.ciclos || []).length >= 30);
check('WARN', !cheias.length, 'conversas no limite de 30 ciclos guardados', cheias.map((c) => c.id).join(', '));
const ativosResolvidos = convs.filter((c) => c.status === 'resolved' && ['IA', 'Aguardando atendente', 'Atendimento humano'].includes(c.custom_attributes.atendimento));
check('WARN', !ativosResolvidos.length, 'resolvidas com estado ativo (a varredura corrige em 10 min)', ativosResolvidos.map((c) => c.id).slice(0, 8).join(', '));
const finalizadasAbertas = convs.filter((c) => c.status !== 'resolved' && c.custom_attributes.atendimento === 'Finalizado' && Date.now() / 1000 - c.last_activity_at > 1800);
check('WARN', !finalizadasAbertas.length, 'finalizadas ainda abertas há mais de 30 min', finalizadasAbertas.map((c) => c.id).slice(0, 8).join(', '));

// ---------- 3. fonte independente: notas "🔁 Atendimento: X → Y" ----------
console.log('\n3. Recontagem pelas notas de mudança de estado (fonte independente)');
const comCiclo = [...new Set(ciclos.map((c) => c.conversa))];
const alvo = convs.filter((c) => comCiclo.includes(c.id) || (c.last_activity_at >= inicioSP));
const trans = [];
const estrelas = [];
for (const c of alvo) {
  for (let antes = null; ;) {
    const lote = (await api(`/conversations/${c.id}/messages${antes ? `?before=${antes}` : ''}`)).payload;
    for (const m of lote) {
      const t = m.created_at * 1000;
      const mm = /^🔁 Atendimento: (.+?) → (.+?) \((.*)\)$/s.exec(m.content || '');
      if (m.private && mm) trans.push({ conversa: c.id, t, de: mm[1], para: mm[2], motivo: mm[3] });
      if (m.private && /^⭐ Avaliação do cliente: ([1-5])\/5/.test(m.content || '')) estrelas.push({ conversa: c.id, t, nota: Number(/([1-5])\/5/.exec(m.content)[1]) });
    }
    if (lote.length < 20 || Math.min(...lote.map((m) => m.created_at)) < inicioSP - 2 * 86400) break;
    antes = Math.min(...lote.map((m) => m.id));
  }
}
trans.sort((a, b) => a.t - b.t);
// ciclos-fantasma nas notas: Finalizado → IA seguido de IA → Finalizado (pedido de avaliação) em até 15 s
const fantasmas = new Set();
for (let i = 0; i < trans.length - 1; i++) {
  const a = trans[i]; const b = trans[i + 1];
  if (a.conversa === b.conversa && a.de === 'Finalizado' && a.para === 'IA' && b.para === 'Finalizado' && b.t - a.t <= 15000) { fantasmas.add(a); fantasmas.add(b); }
}
const valida = trans.filter((x) => !fantasmas.has(x) && noPeriodo(x.t));
const novosCiclos = valida.filter((x) => ['sem estado', 'Finalizado'].includes(x.de) && x.para !== 'Finalizado').length;
const transferencias = valida.filter((x) => x.para === 'Aguardando atendente').length;
const fins = valida.filter((x) => x.para === 'Finalizado');
const finInat = fins.filter((x) => /sem atividade/.test(x.motivo)).length;
console.log(`      notas lidas: ${trans.length} mudanças de estado, ${fantasmas.size / 2} pares-fantasma descontados`);
// Notas usam a hora de chegada no Chatwoot e o painel a hora da Blip: diferenças pequenas na virada do dia são esperadas
const tol = (n) => Math.max(2, Math.round(n * 0.03));
igual('atendimentos iniciados: notas × painel', novosCiclos, k.recebidos, tol(k.recebidos), 'WARN');
igual('transferências: notas × painel', transferencias, k.sla.transferidos, tol(k.sla.transferidos), 'WARN');
// finalizações comparadas pela data do encerramento (as notas não sabem quando o atendimento começou)
const finEvento = convs.flatMap(ciclosDaConversa).filter((c) => c.finalizado_em && noPeriodo(T(c.finalizado_em)));
igual('finalizações (data do encerramento): notas × painel + sem início', fins.length, finEvento.length + semInicio.length, tol(fins.length), 'WARN');
igual('finalizações por inatividade: notas × painel', finInat, finEvento.filter((c) => c.finalizado_por === 'Inatividade').length + semInicio.filter((x) => x.finalizado_por === 'Inatividade').length, tol(finInat), 'WARN');

// ---------- 4. CSAT: notas ⭐ × campo avaliacao × CSAT nativo ----------
console.log('\n4. Satisfação (três registros da mesma nota)');
const estrelasPeriodo = estrelas.filter((e) => noPeriodo(e.t));
const avaliadosPeriodo = convs.flatMap(ciclosDaConversa).filter((c) => c.avaliacao != null && noPeriodo(T(c.avaliacao_em)));
igual('notas ⭐ × avaliações gravadas nos ciclos (pela data da nota)', estrelasPeriodo.length, avaliadosPeriodo.length, 1, 'WARN');
const nativas = [];
for (let p = 1; ; p++) {
  const l = await api(`/csat_survey_responses?page=${p}&since=${inicioSP}&until=${fimSP}`);
  if (!l.length) break;
  nativas.push(...l);
  if (l.length < 25) break;
}
const importadas = nativas.filter((n) => !estrelas.some((e) => e.conversa === n.conversation_id && noPeriodo(e.t)));
console.log(`      CSAT nativo: ${nativas.length} respostas, ${importadas.length} sem nota ⭐ no período (importação das notas históricas em 03/11 grava a data da importação)`);
igual('CSAT nativo (sem a importação) × notas ⭐', nativas.length - importadas.length, new Set(estrelasPeriodo.map((e) => e.conversa)).size, 1, 'WARN');
const media = (l) => (l.length ? l.reduce((s, x) => s + x, 0) / l.length : 0);
igual('média CSAT nativo × média das notas ⭐', Number(media(nativas.map((n) => n.rating)).toFixed(2)), Number(media(estrelasPeriodo.map((e) => e.nota)).toFixed(2)), 0.05, 'WARN');

// ---------- 5. relatórios nativos do Chatwoot ----------
console.log('\n5. Relatórios nativos do Chatwoot (definições diferentes: só comparação de ordem de grandeza)');
const sumario = await api(`${BASE}/api/v2/accounts/1/reports/summary?type=account&since=${inicioSP}&until=${fimSP}`);
console.log(`      nativo: conversas criadas ${sumario.conversations_count}, resoluções ${sumario.resolutions_count}, 1ª resposta média ${(sumario.avg_first_response_time / 60).toFixed(1)} min, resolução média ${(sumario.avg_resolution_time / 3600).toFixed(1)} h`);
console.log(`      painel: atendimentos ${k.recebidos} (${g.clientes} clientes), finalizados ${g.finalizados}, 1ª resposta mediana ${k.sla.primeira_resposta_min.mediana?.toFixed(1)} min`);
check('WARN', sumario.conversations_count <= g.clientes, 'conversas novas (nativo) ≤ clientes atendidos (painel)', 'o nativo conta só conversas criadas; o painel conta também clientes que voltaram');
check('WARN', sumario.resolutions_count >= g.finalizados * 0.8, 'resoluções nativas na mesma ordem dos finalizados', `${sumario.resolutions_count} × ${g.finalizados}`);

console.log(`\nResultado: ${res.PASS} ok · ${res.WARN} avisos · ${res.FAIL} falhas`);
process.exitCode = res.FAIL ? 1 : 0;
