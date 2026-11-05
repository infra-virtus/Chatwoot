// Dashboard de Atendimento — front-end sem dependências. Dados de /painel-ia/api/* (sessão do Chatwoot).
// Abas: IA (bot da Blip) e Humano (fila, SLA de 1ª resposta, atendentes). Cada número tem um "i" com a conta usada.
(() => {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);
  document.documentElement.dataset.tema = ['dark', 'virtus', 'light'].includes(params.get('tema')) ? params.get('tema') : 'dark';

  const TZ = 'America/Sao_Paulo';
  const hojeSP = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const somaDias = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
  const num = (v) => (v == null ? '—' : nf.format(v));
  const pct = (t) => (t?.pct == null ? '—' : `${nf.format(t.pct)}%`);
  const frac = (t) => (t?.den ? `${t.num} de ${t.den}` : 'sem dados');
  const minutos = (m) => {
    if (m == null) return '—';
    if (m < 1) return `${Math.round(m * 60)} s`;
    if (m < 90) return `${nf.format(m)} min`;
    return `${nf.format(m / 60)} h`;
  };
  const diaCurto = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const nomeAtendente = (email) => email.split('@')[0].replace(/[._]/g, ' ');

  async function pegar(caminho) {
    const r = await fetch(caminho, { credentials: 'same-origin', cache: 'no-store' });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(corpo.erro || `Erro ${r.status}`), { status: r.status });
    return corpo;
  }

  // ---------- "i": o que é, a conta (com os números do período) e a fonte ----------
  let k = null; // KPIs do período
  let a = null; // agora
  const taxaConta = (t, num, den) => (t?.den ? `${num} (${t.num}) ÷ ${den} (${t.den}) = ${pct(t)}` : `${num} ÷ ${den} — sem dados no período`);
  const tempoConta = (r, desc) => (r?.n ? `${desc}. Mediana de ${r.n} = ${minutos(r.mediana)}; 90% em até ${minutos(r.p90)}` : `${desc} — sem dados no período`);
  const csatConta = (c) => (c?.n ? `soma das notas ÷ ${c.n} avaliações = ${nf.format(c.media)}. Notas 4–5: ${frac(c.positivas)} (${pct(c.positivas)})` : 'sem avaliações no período');
  const FONTE_ESTADO = 'Campo "atendimento" que a ponte grava a cada mensagem e ticket da Blip.';
  const FONTE_CICLO = 'Marcos gravados pela ponte em cada atendimento (ciclo IA → fila → atendente → fim), no horário da Blip.';
  const FONTE_CSAT = 'Pesquisa de satisfação da Blip: resposta de 1 a 5 enviada pelo cliente até 30 min depois do pedido de avaliação.';

  const INFO = {
    ia_ao_vivo: () => ({ t: 'Ao vivo IA', o: 'Conversas em que o bot da Blip está atendendo agora.',
      c: `conversas com estado "IA" e não resolvidas = ${num(a?.ia)}`, f: FONTE_ESTADO }),
    aguardando: () => ({ t: 'Aguardando atendente', o: 'Clientes que a IA transferiu e que nenhum atendente respondeu ainda.',
      c: `conversas com estado "Aguardando atendente" e não resolvidas = ${num(a?.aguardando)}`, f: 'Ticket da Blip na fila (status Waiting/Transferred).' }),
    maior_espera: () => ({ t: 'Maior espera na fila', o: 'Há quanto tempo o cliente mais antigo da fila está esperando.',
      c: `agora − hora da transferência do cliente mais antigo = ${minutos(a?.maior_espera_min)}`, f: FONTE_CICLO }),
    fora_meta_agora: () => ({ t: 'Na fila acima da meta', o: `Clientes esperando há mais de ${a?.meta_min} min (meta do SLA) sem resposta. Prioridade de atendimento.`,
      c: `clientes na fila com (agora − transferência) > ${a?.meta_min} min = ${num(a?.fora_da_meta)} de ${num(a?.aguardando)}`, f: FONTE_CICLO }),
    humano_ao_vivo: () => ({ t: 'Ao vivo humano', o: 'Conversas com um atendente responsável agora.',
      c: `conversas com estado "Atendimento humano" e não resolvidas = ${num(a?.humano)}`, f: FONTE_ESTADO }),
    atendentes_ativos: () => ({ t: 'Atendentes em atendimento', o: 'Quantos atendentes diferentes têm pelo menos uma conversa humana aberta agora. Ajuda a ler a carga por pessoa.',
      c: `responsáveis distintos entre as ${num(a?.humano)} conversas ao vivo humano = ${num(a?.atendentes_ativos)}; ${a?.atendentes_ativos ? `${nf.format(a.humano / a.atendentes_ativos)} conversas por atendente` : ''}`, f: 'Responsável da conversa no Chatwoot (definido pela mensagem do atendente na Blip).' }),
    recebidos: () => ({ t: 'Atendimentos recebidos', o: 'Atendimentos iniciados no período. Cada ciclo IA → fila → atendente → fim conta 1; se o cliente volta depois de finalizado, conta um novo atendimento.',
      c: `ciclos com início (entrada na IA, transferência ou atendente) no período = ${num(k?.recebidos)}; ${num(k?.passaram_pela_ia)} passaram pela IA`, f: FONTE_CICLO }),
    transferencia: () => ({ t: 'Transferidos para humano', o: 'Quanto do que passou pela IA precisou de um atendente.',
      c: taxaConta(k?.transferencia, 'atendimentos com IA que foram transferidos', 'atendimentos com IA'), f: FONTE_CICLO }),
    contencao: () => ({ t: 'Resolvidos só pela IA', o: 'Quanto a IA resolveu sozinha, sem transferir. Só entram atendimentos já finalizados; inclui os que terminaram por inatividade (ver "Saíram sem concluir").',
      c: taxaConta(k?.contencao_ia, 'finalizados com IA e sem transferência', 'finalizados que passaram pela IA'), f: `${FONTE_CICLO} Finalizado = pedido de avaliação da Blip, ticket encerrado ou 24h sem atividade.` }),
    ia_inatividade: () => ({ t: 'IA: cliente saiu sem concluir', o: 'Atendimentos só da IA que terminaram porque o cliente parou de responder (24h sem atividade), e não com a pesquisa de avaliação. Esses casos entram em "Resolvidos só pela IA", mas não dá para saber se o cliente foi atendido.',
      c: taxaConta(k?.geral?.ia_inatividade, 'finalizados só pela IA por inatividade', 'finalizados só pela IA'), f: FONTE_CICLO }),
    duracao_ia: () => ({ t: 'Duração do atendimento da IA', o: 'Quanto tempo a IA leva para concluir um atendimento sozinha (até o pedido de avaliação).',
      c: tempoConta(k?.geral?.duracao_ia_min, 'encerramento − início, atendimentos finalizados pela IA sem transferência'), f: FONTE_CICLO }),
    ge_ao_vivo: () => ({ t: 'Em atendimento agora', o: 'Todos os clientes sendo atendidos neste momento, pela IA, na fila ou por atendente.',
      c: `ao vivo IA (${num(a?.ia)}) + aguardando (${num(a?.aguardando)}) + ao vivo humano (${num(a?.humano)}) = ${num(a ? a.ia + a.aguardando + a.humano : null)}`, f: FONTE_ESTADO }),
    clientes: () => ({ t: 'Clientes atendidos', o: 'Pessoas diferentes que tiveram pelo menos um atendimento no período (cada cliente tem uma conversa única no Chatwoot).',
      c: `conversas distintas com atendimento iniciado no período = ${num(k?.geral?.clientes)}; ${num(k?.geral?.clientes_que_voltaram)} voltaram com mais de um atendimento`, f: FONTE_CICLO }),
    finalizados: () => ({ t: 'Finalizados', o: 'Atendimentos do período que já terminaram, e quantos ainda estão em andamento.',
      c: `iniciados no período (${num(k?.recebidos)}) = finalizados (${num(k?.geral?.finalizados)}) + em andamento (${num(k?.geral?.em_andamento)})`, f: FONTE_CICLO }),
    participacao_ia: () => ({ t: 'Atendidos só pela IA', o: 'Parte do total de atendimentos que ficou só com a IA, sem transferência (inclui os que ainda estão com a IA).',
      c: taxaConta(k?.geral?.participacao_ia, 'atendimentos sem transferência', 'atendimentos recebidos'), f: FONTE_CICLO }),
    comparativo: () => ({ t: 'IA × Humano', o: 'Os mesmos atendimentos do período separados em dois grupos: os que ficaram só com a IA e os que passaram por um atendente. Cada atendimento está em um grupo só.',
      c: `só IA = sem transferência (${num(k?.geral?.so_ia)}); com atendente = transferidos ou com atendente (${num(k?.geral?.com_humano)}); total = ${num(k?.recebidos)}. Durações em mediana, do início do atendimento ao encerramento.`, f: FONTE_CICLO }),
    g_composicao: () => ({ t: 'Atendimentos por dia: só IA × com atendente', o: 'Como o volume de cada dia se divide entre a IA e os atendentes.',
      c: 'por dia de início: só IA = atendimentos sem transferência; com atendente = transferidos ou atendidos por humano. Soma = recebidos do dia.', f: FONTE_CICLO }),
    g_desfecho: () => ({ t: 'Como os atendimentos terminaram', o: 'Quem encerrou cada atendimento finalizado no período.',
      c: `IA = pedido de avaliação após atendimento da IA (${num(k?.geral?.finalizados_por?.IA)}); atendente = pedido de avaliação ou ticket fechado após atendente (${num(k?.geral?.finalizados_por?.Atendente)}); inatividade = 24h sem resposta (${num(k?.geral?.finalizados_por?.Inatividade)})`, f: FONTE_CICLO }),
    g_desfecho_ia: () => ({ t: 'Desfecho dos atendimentos da IA', o: 'O que aconteceu com os atendimentos finalizados que passaram pela IA.',
      c: 'concluídos pela IA = encerrados com pedido de avaliação sem transferência; saíram sem concluir = 24h sem resposta sem transferência; transferidos = foram para um atendente', f: FONTE_CICLO }),
    cob_pesquisa: () => ({ t: 'Pesquisa de satisfação respondida', o: 'De cada atendimento encerrado com pesquisa, quantos clientes responderam com uma nota. Quanto maior, mais confiável a satisfação. Para aumentar: pedir a nota de forma direta ("responda de 1 a 5") e lembrar o cliente na despedida.',
      c: taxaConta(k?.geral?.cobertura?.pesquisa_respondida, 'finalizados com nota', 'finalizados pela IA ou atendente (sem inatividade)'), f: FONTE_CSAT }),
    cob_encerramento: () => ({ t: 'Encerramento registrado', o: 'Atendimentos que terminaram com um encerramento claro (pesquisa ou ticket fechado), e não por 24h de silêncio. Para aumentar: atendentes encerrarem o ticket na Blip ao concluir, e a IA sempre finalizar com a pesquisa.',
      c: taxaConta(k?.geral?.cobertura?.encerramento_registrado, 'finalizados por IA ou atendente', 'todos os finalizados'), f: FONTE_CICLO }),
    cob_atendente: () => ({ t: 'Atendente identificado', o: 'Atendimentos humanos em que a Blip informou quem respondeu. Sem isso, o atendimento não entra na tabela por atendente.',
      c: taxaConta(k?.geral?.cobertura?.atendente_identificado, 'atendimentos humanos com e-mail do atendente', 'atendimentos humanos'), f: 'E-mail do atendente enviado pela Blip em cada mensagem (domínio grupovirtus.com.br).' }),
    cob_resposta: () => ({ t: '1ª resposta registrada', o: 'Atendimentos transferidos e atendidos em que a hora da 1ª mensagem do atendente foi gravada. É a base do SLA.',
      c: taxaConta(k?.geral?.cobertura?.primeira_resposta, 'transferidos atendidos com 1ª resposta', 'transferidos atendidos'), f: `${FONTE_CICLO} Gravado desde 03/11; histórico desde 30/10 recuperado das mensagens.` }),
    chamados: () => ({ t: 'Chamados para atendente', o: 'Transferências da IA para humano no período e a situação de cada uma.',
      c: `transferidos = ${num(k?.sla?.transferidos)}: respondidos ${num(k?.sla?.respondidos)}, encerrados sem resposta ${num(k?.sla?.sem_resposta)}, ainda aguardando ${num(k?.sla?.aguardando_resposta)}`, f: FONTE_CICLO }),
    sla_resposta: () => ({ t: 'Tempo de 1ª resposta (SLA)', o: 'Quanto tempo o cliente espera, depois de transferido, até o atendente mandar a primeira mensagem. É o tempo que o cliente sente de verdade.',
      c: tempoConta(k?.sla?.primeira_resposta_min, '1ª mensagem do atendente − hora da transferência'),
      f: `${FONTE_CICLO} Transferência = ticket entrando na fila da Blip; 1ª resposta = primeira mensagem 👤 do atendente no ciclo. Inclui transferências fora do horário de atendimento. Mediana: metade dos clientes esperou menos que isso.` }),
    sla_meta: () => ({ t: `Respondidos em até ${k?.sla?.meta_min} min`, o: `Percentual de chamados respondidos dentro da meta de ${k?.sla?.meta_min} min. Quem desistiu sem resposta conta como fora da meta.`,
      c: `${taxaConta(k?.sla?.na_meta, `respondidos em até ${k?.sla?.meta_min} min`, '(respondidos + encerrados sem resposta)')}. Ainda na fila: ${num(k?.sla?.aguardando_resposta)} (entram quando terminarem).`,
      f: 'Meta configurável (SLA_RESPOSTA_MIN no deploy da ponte).' }),
    abandono: () => ({ t: 'Abandono na fila', o: 'Clientes transferidos que terminaram sem nenhum atendente responder.',
      c: taxaConta(k?.abandono_fila, 'transferidos finalizados sem atendente', 'transferidos finalizados'), f: FONTE_CICLO }),
    tma: () => ({ t: 'Tempo de atendimento humano', o: 'Duração do atendimento do atendente, do início até o encerramento.',
      c: tempoConta(k?.tma_humano_min, 'encerramento − início do atendente, só atendimentos finalizados pelo atendente'), f: `${FONTE_CICLO} Encerramento = pedido de avaliação ou ticket fechado na Blip.` }),
    csat_hu: () => ({ t: 'Satisfação com o atendente', o: 'Nota média dos clientes em atendimentos encerrados por um atendente (escala 1 a 5).',
      c: csatConta(k?.csat?.atendente), f: FONTE_CSAT }),
    g_volume: () => ({ t: 'Recebidos e transferidos por dia', o: 'Volume diário de atendimentos e quantos foram para um atendente.',
      c: 'por dia de início do atendimento: recebidos = ciclos iniciados; transferidos = ciclos com transferência', f: FONTE_CICLO }),
    g_finalizados: () => ({ t: 'Finalizados: só IA × com atendente', o: 'Como os atendimentos terminaram, por dia de início.',
      c: 'só IA = finalizados que passaram pela IA sem transferência; com atendente = finalizados que tiveram atendente', f: FONTE_CICLO }),
    g_calor: () => ({ t: 'Picos de entrada', o: 'Em que dia da semana e hora os atendimentos começam. Use para planejar a escala.',
      c: 'contagem de atendimentos iniciados por dia da semana × hora (horário de Brasília)', f: FONTE_CICLO }),
    g_resposta_dia: () => ({ t: 'Tempo de 1ª resposta por dia', o: 'Evolução do SLA: mediana e p90 (90% dos clientes foram respondidos até esse tempo).',
      c: 'por dia da transferência: mediana e p90 de (1ª mensagem do atendente − transferência). Dias sem resposta ficam em branco.', f: FONTE_CICLO }),
    g_faixas: () => ({ t: 'Distribuição da 1ª resposta', o: 'Quantos chamados foram respondidos em cada faixa de tempo.',
      c: `contagem dos ${num(k?.sla?.respondidos)} chamados respondidos por faixa de (1ª resposta − transferência)`, f: FONTE_CICLO }),
    g_calor_fila: () => ({ t: 'Picos de transferência', o: 'Quando os clientes chegam na fila de atendentes. Compare com a escala da equipe.',
      c: 'contagem de transferências por dia da semana × hora (horário de Brasília)', f: FONTE_CICLO }),
    g_csat_hu: () => ({ t: 'Notas dos atendentes', o: 'Quantas avaliações de cada nota os atendentes receberam.', c: csatConta(k?.csat?.atendente), f: FONTE_CSAT }),
    tabela_atendentes: () => ({ t: 'Por atendente', o: 'Atendimentos humanos no período por atendente (quem respondeu na Blip).',
      c: `atendimentos = ciclos com o atendente; 1ª resposta = mediana de (1ª mensagem − transferência); na meta = respondidos em até ${k?.sla?.meta_min ?? '—'} min ÷ respondidos; tempo de atendimento = mediana de (encerramento − início); CSAT = média das notas`,
      f: 'E-mail do atendente informado pela Blip em cada mensagem.' }),
  };

  const botaoInfo = (chave) => `<button type="button" class="info" data-info="${chave}" aria-label="Como é calculado" aria-expanded="false">i</button>`;
  const pop = $('#pop');
  let aberto = null;
  function fecharInfo() {
    pop.hidden = true;
    aberto?.setAttribute('aria-expanded', 'false');
    aberto = null;
  }
  function abrirInfo(btn) {
    const i = INFO[btn.dataset.info]?.();
    if (!i) return;
    pop.innerHTML = `<b>${esc(i.t)}</b><p>${esc(i.o)}</p><p class="conta"><b>Conta:</b> ${esc(i.c)}</p><p class="fonte">Fonte: ${esc(i.f)}</p>`;
    pop.hidden = false;
    aberto = btn;
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    const x = Math.min(Math.max(12, r.left - 12), window.innerWidth - pop.offsetWidth - 12);
    const abaixo = r.bottom + 8 + pop.offsetHeight < window.innerHeight;
    pop.style.left = `${x}px`;
    pop.style.top = `${abaixo ? r.bottom + 8 : Math.max(12, r.top - pop.offsetHeight - 8)}px`;
  }
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.info');
    if (btn) {
      ev.stopPropagation();
      if (aberto === btn) fecharInfo(); else { fecharInfo(); abrirInfo(btn); }
    } else if (!pop.contains(ev.target)) fecharInfo();
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && aberto) { const b = aberto; fecharInfo(); b.focus(); } });
  window.addEventListener('scroll', fecharInfo, true);

  function tile(rotulo, valor, detalhe, info, extra = '') {
    return `<div class="tile ${extra}"><span class="rot">${esc(rotulo)}${info ? botaoInfo(info) : ''}</span><span class="val">${esc(valor)}</span>${detalhe ? `<span class="det">${esc(detalhe)}</span>` : ''}</div>`;
  }

  // ---------- gráficos (SVG) ----------
  const W = 560;
  const H = 220;
  const M = { t: 12, r: 12, b: 26, l: 48 };
  const css = (v) => `var(${v})`;
  const cabecalho = (titulo, sub, info) => `<div><h3>${esc(titulo)}${info ? botaoInfo(info) : ''}</h3><div class="sub">${esc(sub)}</div></div>`;

  function escala(max) {
    const passo = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : max <= 100 ? 20 : Math.ceil(max / 5 / 50) * 50;
    const topo = Math.max(passo, Math.ceil(max / passo) * passo);
    const ticks = [];
    for (let v = 0; v <= topo; v += passo) ticks.push(v);
    return { topo, ticks };
  }

  function eixos(svgPartes, ticks, topo, rotulosX, fmtTick = (v) => v) {
    const y = (v) => M.t + (H - M.t - M.b) * (1 - v / topo);
    for (const v of ticks) {
      svgPartes.push(`<line x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}" stroke="${css('--grid')}" stroke-width="1"/>`);
      svgPartes.push(`<text x="${M.l - 6}" y="${y(v) + 4}" text-anchor="end">${esc(fmtTick(v))}</text>`);
    }
    for (const { x, texto } of rotulosX) svgPartes.push(`<text x="${x}" y="${H - 8}" text-anchor="middle">${esc(texto)}</text>`);
    return y;
  }

  function rotulosEspacados(n, xDe, rotulo) {
    const cada = Math.max(1, Math.ceil(n / 8));
    const lista = [];
    for (let i = 0; i < n; i += cada) lista.push({ x: xDe(i), texto: rotulo(i) });
    return lista;
  }

  function montarTooltip(cartao, svg, alvos) {
    const tip = document.createElement('div');
    tip.className = 'tip';
    cartao.appendChild(tip);
    svg.querySelectorAll('[data-tip]').forEach((el) => {
      const mostrar = (ev) => {
        tip.innerHTML = el.dataset.tip;
        tip.style.display = 'block';
        const caixa = cartao.getBoundingClientRect();
        const x = (ev.clientX ?? caixa.left + caixa.width / 2) - caixa.left;
        const y = (ev.clientY ?? caixa.top + 40) - caixa.top;
        tip.style.left = `${Math.min(Math.max(8, x + 12), caixa.width - tip.offsetWidth - 8)}px`;
        tip.style.top = `${Math.max(8, y - tip.offsetHeight - 10)}px`;
        alvos?.(el, true);
      };
      const esconder = () => { tip.style.display = 'none'; alvos?.(el, false); };
      el.addEventListener('mousemove', mostrar);
      el.addEventListener('focus', mostrar);
      el.addEventListener('mouseleave', esconder);
      el.addEventListener('blur', esconder);
    });
  }

  function tabelaDados(cab, linhas) {
    return `<details><summary>Ver números</summary><div class="rolagem"><table><thead><tr>${cab.map((c, i) => `<th class="${i ? 'n' : ''}">${esc(c)}</th>`).join('')}</tr></thead><tbody>${
      linhas.map((l) => `<tr>${l.map((c, i) => `<td class="${i ? 'n' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
  }

  // Linhas por dia (crosshair com todas as séries). Valores nulos interrompem a linha. fmt formata o valor na dica/tabela.
  function graficoLinhas(cartao, titulo, sub, serie, chaves, info, fmt = (v) => v) {
    const n = serie.length;
    const { topo, ticks } = escala(Math.max(1, ...serie.flatMap((d) => chaves.map((c) => d[c.campo] ?? 0))));
    const xDe = (i) => (n === 1 ? (M.l + W - M.r) / 2 : M.l + ((W - M.l - M.r) * i) / (n - 1));
    const partes = [];
    const y = eixos(partes, ticks, topo, rotulosEspacados(n, xDe, (i) => diaCurto(serie[i].dia)), fmt);
    chaves.forEach((c) => {
      let trecho = [];
      const fechar = () => {
        if (trecho.length > 1) partes.push(`<polyline points="${trecho.join(' ')}" fill="none" stroke="${css(c.cor)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
        trecho = [];
      };
      serie.forEach((d, i) => {
        if (d[c.campo] == null) { fechar(); return; }
        trecho.push(`${xDe(i)},${y(d[c.campo])}`);
        partes.push(`<circle cx="${xDe(i)}" cy="${y(d[c.campo])}" r="${n > 31 ? 0 : 4}" fill="${css(c.cor)}" stroke="${css('--surface')}" stroke-width="2"/>`);
      });
      fechar();
    });
    const larg = n === 1 ? W - M.l - M.r : (W - M.l - M.r) / (n - 1);
    serie.forEach((d, i) => {
      const dica = `<b>${diaCurto(d.dia)}</b><br>${chaves.map((c) => `${esc(c.nome)}: ${esc(fmt(d[c.campo]))}`).join('<br>')}`;
      partes.push(`<rect data-tip="${esc(dica)}" data-i="${i}" tabindex="0" x="${xDe(i) - larg / 2}" y="${M.t}" width="${larg}" height="${H - M.t - M.b}" fill="transparent"/>`);
    });
    partes.push(`<line class="mira" x1="0" x2="0" y1="${M.t}" y2="${H - M.b}" stroke="${css('--muted')}" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>`);
    cartao.innerHTML = `${cabecalho(titulo, sub, info)}
      <div class="legenda">${chaves.map((c) => `<span><i style="background:${css(c.cor)}"></i>${esc(c.nome)}</span>`).join('')}</div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(titulo)}">${partes.join('')}</svg>
      ${tabelaDados(['Dia', ...chaves.map((c) => c.nome)], serie.map((d) => [diaCurto(d.dia), ...chaves.map((c) => fmt(d[c.campo]))]))}`;
    const svg = cartao.querySelector('svg');
    const mira = svg.querySelector('.mira');
    montarTooltip(cartao, svg, (el, ativo) => {
      const i = Number(el.dataset.i);
      mira.setAttribute('visibility', ativo ? 'visible' : 'hidden');
      mira.setAttribute('x1', xDe(i)); mira.setAttribute('x2', xDe(i));
    });
  }

  // Barras agrupadas, pontas arredondadas, 2px de espaço entre barras
  function graficoBarras(cartao, titulo, sub, rotulos, grupos, chaves, rotuloTabela, info) {
    const n = rotulos.length;
    const { topo, ticks } = escala(Math.max(1, ...grupos.flat()));
    const faixa = (W - M.l - M.r) / n;
    const largBarra = Math.min(28, (faixa * 0.7 - 2 * (chaves.length - 1)) / chaves.length);
    const xDe = (i) => M.l + faixa * i + faixa / 2;
    const partes = [];
    const y = eixos(partes, ticks, topo, rotulosEspacados(n, xDe, (i) => rotulos[i]));
    const base = y(0);
    grupos.forEach((valores, i) => {
      const total = largBarra * chaves.length + 2 * (chaves.length - 1);
      valores.forEach((v, s) => {
        const x = xDe(i) - total / 2 + s * (largBarra + 2);
        const alt = base - y(v);
        if (alt > 0) {
          const r = Math.min(4, alt, largBarra / 2);
          partes.push(`<path d="M${x},${base} V${base - alt + r} Q${x},${base - alt} ${x + r},${base - alt} H${x + largBarra - r} Q${x + largBarra},${base - alt} ${x + largBarra},${base - alt + r} V${base} Z" fill="${css(chaves[s].cor)}"/>`);
        }
      });
      const dica = `<b>${esc(rotulos[i])}</b><br>${chaves.map((c, s) => `${esc(c.nome)}: ${valores[s]}`).join('<br>')}`;
      partes.push(`<rect data-tip="${esc(dica)}" tabindex="0" x="${xDe(i) - faixa / 2}" y="${M.t}" width="${faixa}" height="${H - M.t - M.b}" fill="transparent"/>`);
    });
    const legenda = chaves.length > 1 ? `<div class="legenda">${chaves.map((c) => `<span><i style="background:${css(c.cor)}"></i>${esc(c.nome)}</span>`).join('')}</div>` : '';
    cartao.innerHTML = `${cabecalho(titulo, sub, info)}${legenda}
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(titulo)}">${partes.join('')}</svg>
      ${tabelaDados([rotuloTabela, ...chaves.map((c) => c.nome)], rotulos.map((r, i) => [r, ...grupos[i]]))}`;
    montarTooltip(cartao, cartao.querySelector('svg'));
  }

  // Mapa de calor: dia da semana x hora (rampa sequencial de um tom)
  function graficoCalor(cartao, calor, titulo, sub, unidade, info) {
    const dias = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const max = Math.max(1, ...calor.flat());
    const passos = ['--seq-0', '--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6'];
    const cor = (v) => css(v === 0 ? passos[0] : passos[Math.min(6, 1 + Math.floor((v / max) * 5.999))]);
    const l = 34;
    const cel = (W - l - 8) / 24;
    const alt = 22;
    const partes = [];
    for (let h = 0; h < 24; h += 3) partes.push(`<text x="${l + cel * h + cel / 2}" y="12" text-anchor="middle">${h}h</text>`);
    calor.forEach((linha, d) => {
      partes.push(`<text x="${l - 6}" y="${20 + d * (alt + 2) + alt / 2 + 4}" text-anchor="end">${dias[d]}</text>`);
      linha.forEach((v, h) => {
        partes.push(`<rect data-tip="${esc(`<b>${dias[d]} ${h}h–${h + 1}h</b><br>${v} ${unidade}`)}" tabindex="0" x="${l + h * cel + 1}" y="${20 + d * (alt + 2)}" width="${cel - 2}" height="${alt}" rx="3" fill="${cor(v)}"/>`);
      });
    });
    const altura = 20 + 7 * (alt + 2) + 4;
    cartao.innerHTML = `${cabecalho(titulo, `${sub} · mais escuro = mais ${unidade} (máx. ${max})`, info)}
      <svg viewBox="0 0 ${W} ${altura}" width="100%" role="img" aria-label="${esc(titulo)}">${partes.join('')}</svg>
      ${tabelaDados(['Dia', ...Array.from({ length: 24 }, (_, h) => `${h}h`)], calor.map((linha, d) => [dias[d], ...linha]))}`;
    montarTooltip(cartao, cartao.querySelector('svg'));
  }

  const notasCsat = (c, titulo, info) => [titulo, `${c.n} avaliações · média ${num(c.media)} (1 = muito insatisfeito, 5 = muito satisfeito)`,
    ['1', '2', '3', '4', '5'], c.distribuicao.map((v) => [v]), [{ nome: 'Avaliações', cor: '--series-1' }], 'Nota', info];

  // ---------- telas ----------
  let periodo = { de: somaDias(hojeSP(), -6), ate: hojeSP() };

  async function carregarAgora() {
    try {
      a = await pegar('/painel-ia/api/agora');
      $('#ge-agora').innerHTML = [
        tile('Em atendimento agora', num(a.ia + a.aguardando + a.humano), 'IA + fila + atendentes', 'ge_ao_vivo'),
        tile('Ao vivo IA', num(a.ia), 'bot da Blip atendendo', 'ia_ao_vivo'),
        tile('Aguardando atendente', num(a.aguardando), `${num(a.fora_da_meta)} acima de ${a.meta_min} min`, 'aguardando'),
        tile('Ao vivo humano', num(a.humano), `${num(a.atendentes_ativos)} atendentes`, 'humano_ao_vivo'),
      ].join('');
      $('#ia-agora').innerHTML = [
        tile('Ao vivo IA', num(a.ia), 'bot da Blip atendendo agora', 'ia_ao_vivo'),
        tile('Aguardando atendente', num(a.aguardando), 'transferidos pela IA, sem resposta', 'aguardando'),
      ].join('');
      $('#hu-agora').innerHTML = [
        tile('Aguardando atendente', num(a.aguardando), 'transferidos, sem resposta', 'aguardando'),
        tile('Maior espera na fila', minutos(a.maior_espera_min), 'cliente mais antigo da fila', 'maior_espera'),
        tile(`Na fila acima de ${a.meta_min} min`, num(a.fora_da_meta), 'já passaram da meta do SLA', 'fora_meta_agora'),
        tile('Ao vivo humano', num(a.humano), 'atendente responsável agora', 'humano_ao_vivo'),
        tile('Atendentes em atendimento', num(a.atendentes_ativos), a.atendentes_ativos ? `${nf.format(a.humano / a.atendentes_ativos)} conversas por atendente` : '', 'atendentes_ativos'),
      ].join('');
      const hora = new Date(a.atualizado_em).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
      document.querySelectorAll('.agora-hora').forEach((el) => { el.textContent = `· atualiza a cada 30 s · ${hora}`; });
    } catch (e) {
      tratarErro(e);
    }
  }

  function telaIA() {
    $('#ia-kpis').innerHTML = [
      tile('Atendimentos recebidos', num(k.recebidos), `${num(k.passaram_pela_ia)} passaram pela IA`, 'recebidos'),
      tile('Transferidos para humano', pct(k.transferencia), frac(k.transferencia), 'transferencia'),
      tile('Resolvidos só pela IA', pct(k.contencao_ia), frac(k.contencao_ia), 'contencao'),
      tile('Saíram sem concluir', pct(k.geral.ia_inatividade), `${frac(k.geral.ia_inatividade)} finalizados só pela IA`, 'ia_inatividade'),
      tile('Duração do atendimento da IA', minutos(k.geral.duracao_ia_min.mediana), `mediana · 90% até ${minutos(k.geral.duracao_ia_min.p90)}`, 'duracao_ia'),
    ].join('');
    graficoLinhas($('#g-volume'), 'Recebidos e transferidos por dia', 'Atendimentos iniciados e quantos foram para um atendente', k.serie,
      [{ campo: 'recebidos', nome: 'Recebidos', cor: '--series-1' }, { campo: 'transferidos', nome: 'Transferidos', cor: '--series-2' }], 'g_volume');
    graficoBarras($('#g-finalizados'), 'Finalizados: só IA × com atendente', 'Por dia de início do atendimento', k.serie.map((d) => diaCurto(d.dia)),
      k.serie.map((d) => [d.finalizados_ia, d.finalizados_humano]), [{ nome: 'Só IA', cor: '--series-1' }, { nome: 'Com atendente', cor: '--series-2' }], 'Dia', 'g_finalizados');
    const g = k.geral;
    const transferidosFin = k.abandono_fila.den;
    graficoBarras($('#g-desfecho-ia'), 'Desfecho dos atendimentos da IA', 'Atendimentos finalizados que passaram pela IA',
      ['Concluídos pela IA', 'Saíram sem concluir', 'Transferidos'],
      [[g.ia_concluidos], [g.ia_inatividade.num], [transferidosFin]], [{ nome: 'Atendimentos', cor: '--series-1' }], 'Desfecho', 'g_desfecho_ia');
    graficoCalor($('#g-calor'), k.calor, 'Picos de entrada', 'Atendimentos iniciados por dia da semana e hora (Brasília)', 'atendimentos', 'g_calor');
  }

  const linhaComp = (rotulo, info, ia, hu, total) => `<tr><td><span class="rot-linha">${esc(rotulo)}${info ? botaoInfo(info) : ''}</span></td><td class="n">${esc(ia)}</td><td class="n">${esc(hu)}</td><td class="n">${esc(total)}</td></tr>`;
  const medidor = (t) => (t?.pct == null ? '' : `<span class="medidor" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, t.pct))}%"></i></span>`);
  const tileTaxa = (rotulo, t, info, dica) => `<div class="tile"><span class="rot">${esc(rotulo)}${botaoInfo(info)}</span><span class="val">${esc(pct(t))}</span>
    <span class="det">${esc(frac(t))}</span>${medidor(t)}${dica ? `<span class="dica">${esc(dica)}</span>` : ''}</div>`;

  function telaGeral() {
    const g = k.geral;
    const parte = (n) => (k.recebidos ? `${nf.format((100 * n) / k.recebidos)}%` : '—');
    $('#ge-kpis').innerHTML = [
      tile('Atendimentos recebidos', num(k.recebidos), `${num(g.so_ia)} só IA · ${num(g.com_humano)} com atendente`, 'recebidos'),
      tile('Clientes atendidos', num(g.clientes), `${num(g.clientes_que_voltaram)} voltaram mais de uma vez`, 'clientes'),
      tile('Finalizados', num(g.finalizados), `${num(g.em_andamento)} em andamento`, 'finalizados'),
      tile('Atendidos só pela IA', pct(g.participacao_ia), frac(g.participacao_ia), 'participacao_ia'),
    ].join('');
    $('#comparativo').innerHTML = `<thead><tr><th></th><th class="n">Só IA</th><th class="n">Com atendente</th><th class="n">Total</th></tr></thead><tbody>
      ${linhaComp('Atendimentos', 'comparativo', num(g.so_ia), num(g.com_humano), num(k.recebidos))}
      ${linhaComp('Participação', null, parte(g.so_ia), parte(g.com_humano), '100%')}
      ${linhaComp('Finalizados', 'g_desfecho', num(g.finalizados_so_ia), num(g.finalizados_com_humano), num(g.finalizados))}
      ${linhaComp('Duração do atendimento (mediana)', 'duracao_ia', minutos(g.duracao_ia_min.mediana), minutos(g.duracao_humano_min.mediana), '—')}
      ${linhaComp('Saíram sem concluir', 'ia_inatividade', pct(g.ia_inatividade), pct(k.abandono_fila), '—')}
      ${linhaComp('Tempo de 1ª resposta (mediana)', 'sla_resposta', '—', minutos(k.sla.primeira_resposta_min.mediana), '—')}
      ${linhaComp('Satisfação (média)', 'csat_hu', '—', k.csat.atendente.media == null ? '—' : `${nf.format(k.csat.atendente.media)} / 5`, '—')}</tbody>`;
    graficoBarras($('#g-composicao'), 'Atendimentos por dia: só IA × com atendente', 'Por dia de início do atendimento', k.serie.map((d) => diaCurto(d.dia)),
      k.serie.map((d) => [d.so_ia, d.com_humano]), [{ nome: 'Só IA', cor: '--series-1' }, { nome: 'Com atendente', cor: '--series-2' }], 'Dia', 'g_composicao');
    graficoBarras($('#g-desfecho'), 'Como os atendimentos terminaram', `${num(g.finalizados)} finalizados no período`, ['IA', 'Atendente', 'Inatividade (24h)'],
      [[g.finalizados_por.IA], [g.finalizados_por.Atendente], [g.finalizados_por.Inatividade]], [{ nome: 'Atendimentos', cor: '--series-1' }], 'Encerrado por', 'g_desfecho');
    const c = g.cobertura;
    $('#ge-cobertura').innerHTML = [
      tileTaxa('Pesquisa de satisfação respondida', c.pesquisa_respondida, 'cob_pesquisa', 'meta sugerida: 40% ou mais'),
      tileTaxa('Encerramento registrado', c.encerramento_registrado, 'cob_encerramento', 'o resto terminou por 24h de silêncio'),
      tileTaxa('Atendente identificado', c.atendente_identificado, 'cob_atendente'),
      tileTaxa('1ª resposta registrada', c.primeira_resposta, 'cob_resposta'),
    ].join('');
  }

  function telaHumano() {
    const s = k.sla;
    const pctMeta = s.na_meta.pct;
    $('#hu-kpis').innerHTML = [
      tile('Tempo de 1ª resposta (SLA)', minutos(s.primeira_resposta_min.mediana),
        `mediana · 90% respondidos em até ${minutos(s.primeira_resposta_min.p90)} · ${s.respondidos} chamados`, 'sla_resposta', 'destaque'),
      `<div class="tile"><span class="rot">Respondidos em até ${s.meta_min} min${botaoInfo('sla_meta')}</span><span class="val">${esc(pct(s.na_meta))}</span>
        <span class="det">${esc(frac(s.na_meta))}</span>${pctMeta == null ? '' : `<span class="medidor" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, pctMeta))}%"></i></span>`}</div>`,
      tile('Chamados para atendente', num(s.transferidos), `${s.respondidos} respondidos · ${s.aguardando_resposta} aguardando`, 'chamados'),
      tile('Abandono na fila', pct(k.abandono_fila), frac(k.abandono_fila), 'abandono'),
      tile('Tempo de atendimento humano', minutos(k.tma_humano_min.mediana), `mediana · 90% até ${minutos(k.tma_humano_min.p90)}`, 'tma'),
      tile('Satisfação com o atendente', k.csat.atendente.media == null ? '—' : `${nf.format(k.csat.atendente.media)} / 5`,
        k.csat.atendente.n ? `${pct(k.csat.atendente.positivas)} notas 4–5 · ${k.csat.atendente.n} avaliações` : 'sem avaliações', 'csat_hu'),
    ].join('');
    graficoLinhas($('#g-resposta-dia'), 'Tempo de 1ª resposta por dia', 'Minutos entre a transferência e a 1ª mensagem do atendente', k.serie,
      [{ campo: 'resposta_mediana', nome: 'Mediana', cor: '--series-1' }, { campo: 'resposta_p90', nome: '90% até', cor: '--series-2' }], 'g_resposta_dia', minutos);
    graficoBarras($('#g-faixas'), 'Distribuição da 1ª resposta', `${s.respondidos} chamados respondidos · meta ${s.meta_min} min`, s.faixas.map((f) => f.rotulo),
      s.faixas.map((f) => [f.n]), [{ nome: 'Chamados', cor: '--series-1' }], 'Faixa', 'g_faixas');
    graficoCalor($('#g-calor-fila'), k.calor_fila, 'Picos de transferência', 'Chegadas na fila de atendentes por dia da semana e hora (Brasília)', 'transferências', 'g_calor_fila');
    graficoBarras($('#g-csat-hu'), ...notasCsat(k.csat.atendente, 'Notas dos atendentes', 'g_csat_hu'));
    const linhas = k.atendentes.map((x) => `<tr><td>${esc(nomeAtendente(x.atendente))}</td><td class="n">${x.atendimentos}</td><td class="n">${minutos(x.resposta_mediana)}</td>
      <td class="n">${x.resposta_na_meta?.den ? `${pct(x.resposta_na_meta)} (${x.resposta_na_meta.num}/${x.resposta_na_meta.den})` : '—'}</td><td class="n">${minutos(x.tma_mediana)}</td>
      <td class="n">${x.csat_n ? `${nf.format(x.csat_media)} (${x.csat_n})` : '—'}</td></tr>`).join('');
    $('#atendentes').innerHTML = `<thead><tr><th>Atendente</th><th class="n">Atendimentos</th><th class="n">1ª resposta (mediana)</th><th class="n">Na meta de ${s.meta_min} min</th>
      <th class="n">Tempo de atendimento (mediana)</th><th class="n">CSAT (avaliações)</th></tr></thead><tbody>${linhas || '<tr><td colspan="6">Nenhum atendimento humano no período.</td></tr>'}</tbody>`;
  }

  async function carregarPeriodo() {
    $('#app').classList.add('carregando');
    document.querySelectorAll('.periodo-txt').forEach((el) => { el.textContent = `· ${diaCurto(periodo.de)} a ${diaCurto(periodo.ate)} · carregando… (logo após uma atualização da ponte pode levar até 2 min)`; });
    try {
      k = await pegar(`/painel-ia/api/kpis?de=${periodo.de}&ate=${periodo.ate}`);
      telaGeral();
      telaIA();
      telaHumano();
      document.querySelectorAll('.periodo-txt').forEach((el) => { el.textContent = `· ${diaCurto(periodo.de)} a ${diaCurto(periodo.ate)} · ${k.conversas_lidas} conversas lidas`; });
      $('#notas').innerHTML = `<span>Clique no ⓘ de cada número para ver o que ele mede e a conta usada. Unidade: atendimento (IA → fila → atendente → fim); uma conversa reaberta conta um novo atendimento. Tempos em mediana e p90. Horário de Brasília.</span>
        <span>Dados de estado desde 30/10/2026; compare períodos completos a partir de 31/10. Definições: docs/kpis.md. Dados lidos às ${new Date(k.calculado_em).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })} (atualiza a cada 5 min).</span>`;
    } catch (e) {
      tratarErro(e);
    } finally {
      $('#app').classList.remove('carregando');
    }
  }

  function tratarErro(e) {
    if (e.status === 401 || e.status === 403) {
      $('#app').innerHTML = `<div class="aviso"><h3>Sem acesso</h3><p>${esc(e.message)}</p></div>`;
    } else {
      $('#notas').innerHTML = `<span>⚠ ${esc(e.message)}</span>`;
    }
  }

  // ---------- abas ----------
  const abas = [...document.querySelectorAll('[role="tab"]')];
  function mostrarAba(id, foco) {
    abas.forEach((t) => {
      const ativa = t.id === `tab-${id}`;
      t.setAttribute('aria-selected', String(ativa));
      t.tabIndex = ativa ? 0 : -1;
      $(`#${t.getAttribute('aria-controls')}`).hidden = !ativa;
      if (ativa && foco) t.focus();
    });
    fecharInfo();
    history.replaceState(null, '', `${location.pathname}${location.search}#${id}`);
  }
  abas.forEach((t, i) => {
    t.addEventListener('click', () => mostrarAba(t.id.slice(4)));
    t.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
      const prox = abas[(i + (ev.key === 'ArrowRight' ? 1 : abas.length - 1)) % abas.length];
      mostrarAba(prox.id.slice(4), true);
    });
  });
  mostrarAba(['#ia', '#humano'].includes(location.hash) ? location.hash.slice(1) : 'geral');

  // ---------- filtros ----------
  const botoes = [...document.querySelectorAll('.filtros button')];
  const deInput = $('#de');
  const ateInput = $('#ate');
  function aplicar() {
    deInput.value = periodo.de; ateInput.value = periodo.ate;
    deInput.min = ateInput.min = '2026-10-30';
    deInput.max = ateInput.max = hojeSP();
    carregarPeriodo();
  }
  botoes.forEach((b) => b.addEventListener('click', () => {
    botoes.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    periodo = { de: somaDias(hojeSP(), -Number(b.dataset.dias)), ate: hojeSP() };
    aplicar();
  }));
  [deInput, ateInput].forEach((inp) => inp.addEventListener('change', () => {
    if (!deInput.value || !ateInput.value || deInput.value > ateInput.value) return;
    botoes.forEach((x) => x.setAttribute('aria-pressed', 'false'));
    periodo = { de: deInput.value, ate: ateInput.value };
    carregarPeriodo();
  }));

  pegar('/painel-ia/api/me').then((me) => {
    $('#quem').textContent = `Atendimento WhatsApp 48 9126-5138 · ${me.nome}`;
    aplicar();
    carregarAgora();
    setInterval(carregarAgora, 30000);
  }).catch(tratarErro);
})();
