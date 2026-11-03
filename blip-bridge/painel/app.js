// Dashboard IA — front-end sem dependências. Dados de /painel-ia/api/* (sessão do Chatwoot).
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

  async function pegar(caminho) {
    const r = await fetch(caminho, { credentials: 'same-origin', cache: 'no-store' });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(corpo.erro || `Erro ${r.status}`), { status: r.status });
    return corpo;
  }

  function tile(rotulo, valor, detalhe, titulo) {
    return `<div class="tile" ${titulo ? `title="${esc(titulo)}"` : ''}><span class="rot">${esc(rotulo)}</span><span class="val">${esc(valor)}</span>${detalhe ? `<span class="det">${esc(detalhe)}</span>` : ''}</div>`;
  }

  // ---------- gráficos (SVG) ----------
  const W = 560;
  const H = 220;
  const M = { t: 12, r: 12, b: 26, l: 34 };
  const css = (v) => `var(${v})`;

  function escala(max) {
    const passo = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : max <= 100 ? 20 : Math.ceil(max / 5 / 50) * 50;
    const topo = Math.max(passo, Math.ceil(max / passo) * passo);
    const ticks = [];
    for (let v = 0; v <= topo; v += passo) ticks.push(v);
    return { topo, ticks };
  }

  function eixos(svgPartes, ticks, topo, rotulosX) {
    const y = (v) => M.t + (H - M.t - M.b) * (1 - v / topo);
    for (const v of ticks) {
      svgPartes.push(`<line x1="${M.l}" x2="${W - M.r}" y1="${y(v)}" y2="${y(v)}" stroke="${css('--grid')}" stroke-width="1"/>`);
      svgPartes.push(`<text x="${M.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
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

  function tabelaDados(cabecalho, linhas) {
    return `<details><summary>Ver números</summary><div class="rolagem"><table><thead><tr>${cabecalho.map((c, i) => `<th class="${i ? 'n' : ''}">${esc(c)}</th>`).join('')}</tr></thead><tbody>${
      linhas.map((l) => `<tr>${l.map((c, i) => `<td class="${i ? 'n' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
  }

  // Linhas: recebidos x transferidos por dia (crosshair com as duas séries)
  function graficoLinhas(cartao, titulo, sub, serie, chaves) {
    const n = serie.length;
    const { topo, ticks } = escala(Math.max(1, ...serie.flatMap((d) => chaves.map((k) => d[k.campo]))));
    const xDe = (i) => (n === 1 ? (M.l + W - M.r) / 2 : M.l + ((W - M.l - M.r) * i) / (n - 1));
    const partes = [];
    const y = eixos(partes, ticks, topo, rotulosEspacados(n, xDe, (i) => diaCurto(serie[i].dia)));
    chaves.forEach((k) => {
      const pontos = serie.map((d, i) => `${xDe(i)},${y(d[k.campo])}`).join(' ');
      if (n > 1) partes.push(`<polyline points="${pontos}" fill="none" stroke="${css(k.cor)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      serie.forEach((d, i) => partes.push(`<circle class="pt" data-i="${i}" cx="${xDe(i)}" cy="${y(d[k.campo])}" r="${n > 31 ? 0 : 4}" fill="${css(k.cor)}" stroke="${css('--surface')}" stroke-width="2"/>`));
    });
    const larg = n === 1 ? W - M.l - M.r : (W - M.l - M.r) / (n - 1);
    serie.forEach((d, i) => {
      const dica = `<b>${diaCurto(d.dia)}</b><br>${chaves.map((k) => `${esc(k.nome)}: ${d[k.campo]}`).join('<br>')}`;
      partes.push(`<rect data-tip="${esc(dica)}" data-i="${i}" tabindex="0" x="${xDe(i) - larg / 2}" y="${M.t}" width="${larg}" height="${H - M.t - M.b}" fill="transparent"/>`);
    });
    partes.push(`<line class="mira" x1="0" x2="0" y1="${M.t}" y2="${H - M.b}" stroke="${css('--muted')}" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>`);
    cartao.innerHTML = `<div><h3>${esc(titulo)}</h3><div class="sub">${esc(sub)}</div></div>
      <div class="legenda">${chaves.map((k) => `<span><i style="background:${css(k.cor)}"></i>${esc(k.nome)}</span>`).join('')}</div>
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(titulo)}">${partes.join('')}</svg>
      ${tabelaDados(['Dia', ...chaves.map((k) => k.nome)], serie.map((d) => [diaCurto(d.dia), ...chaves.map((k) => d[k.campo])]))}`;
    const svg = cartao.querySelector('svg');
    const mira = svg.querySelector('.mira');
    montarTooltip(cartao, svg, (el, ativo) => {
      const i = Number(el.dataset.i);
      mira.setAttribute('visibility', ativo ? 'visible' : 'hidden');
      mira.setAttribute('x1', xDe(i)); mira.setAttribute('x2', xDe(i));
    });
  }

  // Barras agrupadas por dia (2 séries), pontas arredondadas, 2px de espaço entre barras
  function graficoBarras(cartao, titulo, sub, rotulos, grupos, chaves, rotuloTabela) {
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
      const dica = `<b>${esc(rotulos[i])}</b><br>${chaves.map((k, s) => `${esc(k.nome)}: ${valores[s]}`).join('<br>')}`;
      partes.push(`<rect data-tip="${esc(dica)}" tabindex="0" x="${xDe(i) - faixa / 2}" y="${M.t}" width="${faixa}" height="${H - M.t - M.b}" fill="transparent"/>`);
    });
    const legenda = chaves.length > 1 ? `<div class="legenda">${chaves.map((k) => `<span><i style="background:${css(k.cor)}"></i>${esc(k.nome)}</span>`).join('')}</div>` : '';
    cartao.innerHTML = `<div><h3>${esc(titulo)}</h3><div class="sub">${esc(sub)}</div></div>${legenda}
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(titulo)}">${partes.join('')}</svg>
      ${tabelaDados([rotuloTabela, ...chaves.map((k) => k.nome)], rotulos.map((r, i) => [r, ...grupos[i]]))}`;
    montarTooltip(cartao, cartao.querySelector('svg'));
  }

  // Mapa de calor: dia da semana x hora (rampa sequencial de um tom)
  function graficoCalor(cartao, calor) {
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
        partes.push(`<rect data-tip="${esc(`<b>${dias[d]} ${h}h–${h + 1}h</b><br>${v} atendimento(s)`)}" tabindex="0" x="${l + h * cel + 1}" y="${20 + d * (alt + 2)}" width="${cel - 2}" height="${alt}" rx="3" fill="${cor(v)}"/>`);
      });
    });
    const altura = 20 + 7 * (alt + 2) + 4;
    cartao.innerHTML = `<div><h3>Picos de entrada</h3><div class="sub">Atendimentos iniciados por dia da semana e hora (horário de Brasília) · mais escuro = mais atendimentos (máx. ${max})</div></div>
      <svg viewBox="0 0 ${W} ${altura}" width="100%" role="img" aria-label="Mapa de calor de atendimentos por dia e hora">${partes.join('')}</svg>
      ${tabelaDados(['Dia', ...Array.from({ length: 24 }, (_, h) => `${h}h`)], calor.map((linha, d) => [dias[d], ...linha]))}`;
    montarTooltip(cartao, cartao.querySelector('svg'));
  }

  // ---------- telas ----------
  let periodo = { de: somaDias(hojeSP(), -6), ate: hojeSP() };

  async function carregarAgora() {
    try {
      const a = await pegar('/painel-ia/api/agora');
      $('#agora').innerHTML = [
        tile('Ao vivo IA', num(a.ia), 'bot da Blip atendendo agora'),
        tile('Aguardando atendente', num(a.aguardando), 'transferidas, ninguém assumiu'),
        tile('Ao vivo humano', num(a.humano), 'atendente responsável agora'),
        tile('Maior espera na fila', minutos(a.maior_espera_min), 'desde a transferência'),
      ].join('');
      $('#agora-hora').textContent = `· atualiza a cada 30 s · ${new Date(a.atualizado_em).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })}`;
    } catch (e) {
      tratarErro(e);
    }
  }

  async function carregarPeriodo() {
    $('#app').classList.add('carregando');
    $('#periodo-txt').textContent = `· ${diaCurto(periodo.de)} a ${diaCurto(periodo.ate)} · calculando…`;
    try {
      const k = await pegar(`/painel-ia/api/kpis?de=${periodo.de}&ate=${periodo.ate}`);
      const cs = k.csat.geral;
      $('#kpis').innerHTML = [
        tile('Atendimentos recebidos', num(k.recebidos), `${num(k.passaram_pela_ia)} passaram pela IA`),
        tile('Transferidos para humano', pct(k.transferencia), frac(k.transferencia), 'Atendimentos que passaram pela IA e foram transferidos ÷ atendimentos que passaram pela IA'),
        tile('Resolvidos só pela IA', pct(k.contencao_ia), frac(k.contencao_ia), 'Finalizados sem transferência ÷ finalizados que passaram pela IA'),
        tile('Abandono na fila', pct(k.abandono_fila), frac(k.abandono_fila), 'Transferidos que terminaram sem nenhum atendente ÷ transferidos finalizados'),
        tile('Espera na fila (mediana)', minutos(k.espera_fila_min.mediana), `90% em até ${minutos(k.espera_fila_min.p90)} · ${k.espera_fila_min.n} atend.`, 'Da transferência até a 1ª mensagem do atendente'),
        tile('Tempo de atendimento humano', minutos(k.tma_humano_min.mediana), `mediana · 90% até ${minutos(k.tma_humano_min.p90)}`, 'Da 1ª mensagem do atendente até o encerramento (finalizados pelo atendente)'),
        tile('Satisfação (CSAT)', cs.media == null ? '—' : `${nf.format(cs.media)} / 5`, cs.n ? `${pct(cs.positivas)} notas 4–5 · ${cs.n} avaliações` : 'sem avaliações', 'Nota da pesquisa da Blip (1 a 5)'),
      ].join('');
      graficoLinhas($('#g-volume'), 'Recebidos e transferidos por dia', 'Atendimentos iniciados e quantos foram para um atendente', k.serie,
        [{ campo: 'recebidos', nome: 'Recebidos', cor: '--series-1' }, { campo: 'transferidos', nome: 'Transferidos', cor: '--series-2' }]);
      graficoBarras($('#g-finalizados'), 'Finalizados: só IA × com atendente', 'Por dia de início do atendimento', k.serie.map((d) => diaCurto(d.dia)),
        k.serie.map((d) => [d.finalizados_ia, d.finalizados_humano]), [{ nome: 'Só IA', cor: '--series-1' }, { nome: 'Com atendente', cor: '--series-2' }], 'Dia');
      graficoBarras($('#g-csat'), `Notas da pesquisa · IA ${num(k.csat.ia.media)} · Atendente ${num(k.csat.atendente.media)}`,
        `${cs.n} avaliações no período (1 = muito insatisfeito, 5 = muito satisfeito)`, ['1', '2', '3', '4', '5'],
        cs.distribuicao.map((v) => [v]), [{ nome: 'Avaliações', cor: '--series-1' }], 'Nota');
      graficoCalor($('#g-calor'), k.calor);
      const linhas = k.atendentes.map((a) => `<tr><td>${esc(a.atendente.split('@')[0].replace(/[._]/g, ' '))}</td><td class="n">${a.atendimentos}</td><td class="n">${minutos(a.espera_mediana)}</td><td class="n">${minutos(a.tma_mediana)}</td><td class="n">${a.csat_n ? `${nf.format(a.csat_media)} (${a.csat_n})` : '—'}</td></tr>`).join('');
      $('#atendentes').innerHTML = `<thead><tr><th>Atendente</th><th class="n">Atendimentos</th><th class="n">Espera na fila (mediana)</th><th class="n">Tempo de atendimento (mediana)</th><th class="n">CSAT (avaliações)</th></tr></thead><tbody>${linhas || '<tr><td colspan="5">Nenhum atendimento humano no período.</td></tr>'}</tbody>`;
      $('#periodo-txt').textContent = `· ${diaCurto(periodo.de)} a ${diaCurto(periodo.ate)} · ${k.conversas_lidas} conversas lidas`;
      $('#notas').innerHTML = `<span>Unidade: atendimento (IA → fila → atendente → fim); uma conversa reaberta conta um novo atendimento. Tempos em mediana e p90. Horário de Brasília.</span>
        <span>Dados de estado desde 30/10/2026; compare períodos completos a partir de 31/10. Definições: docs/kpis.md. Calculado às ${new Date(k.calculado_em).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })} (cache de 5 min).</span>`;
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
