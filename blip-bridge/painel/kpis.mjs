// Cálculo dos KPIs do Dashboard IA a partir dos campos que a ponte grava nas conversas.
// Definições em docs/kpis.md. Regras: unidade = ciclo de atendimento (IA -> fila -> humano -> fim);
// tempos em mediana e p90; taxas com numerador e denominador; datas no fuso America/Sao_Paulo.

const TZ = 'America/Sao_Paulo';
const fmtData = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtHora = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
const DIAS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const t = (iso) => (iso ? Date.parse(iso) : NaN);
const dataLocal = (ms) => fmtData.format(new Date(ms)); // AAAA-MM-DD
function horaLocal(ms) {
  const partes = Object.fromEntries(fmtHora.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { dia: DIAS[partes.weekday], hora: Number(partes.hour) };
}

function quantil(valores, q) {
  if (!valores.length) return null;
  const v = [...valores].sort((a, b) => a - b);
  const pos = (v.length - 1) * q;
  const base = Math.floor(pos);
  return v[base] + (v[base + 1] !== undefined ? (pos - base) * (v[base + 1] - v[base]) : 0);
}
const resumoTempo = (minutos) => ({ n: minutos.length, mediana: quantil(minutos, 0.5), p90: quantil(minutos, 0.9) });
const taxa = (num, den) => ({ num, den, pct: den ? (100 * num) / den : null });

// Ciclos de uma conversa: os já finalizados (lista "ciclos") + o ciclo atual, sem duplicar.
export function ciclosDaConversa(conv) {
  const ca = conv.custom_attributes || {};
  const lista = Array.isArray(ca.ciclos) ? ca.ciclos.map((c) => ({ ...c })) : [];
  const atual = {
    ia_inicio: ca.ia_inicio, transferido_em: ca.transferido_em, humano_inicio: ca.humano_inicio,
    atendente_blip: ca.atendente_blip, finalizado_em: ca.finalizado_em, finalizado_por: ca.finalizado_por,
    avaliacao: ca.avaliacao, avaliacao_de: ca.avaliacao_de, avaliacao_em: ca.avaliacao_em,
    primeira_resposta_em: ca.primeira_resposta_em,
  };
  const temAtual = atual.ia_inicio || atual.transferido_em || atual.humano_inicio;
  const ultimo = lista[lista.length - 1];
  const duplicado = ultimo && ultimo.finalizado_em && ultimo.finalizado_em === atual.finalizado_em;
  if (temAtual && !duplicado) lista.push(atual);
  return lista
    .map((c) => ({ ...c, inicio: t(c.ia_inicio || c.transferido_em || c.humano_inicio), conversa: conv.id }))
    .filter((c) => Number.isFinite(c.inicio));
}

// Faixas do tempo de 1ª resposta (minutos) para o histograma do SLA
const FAIXAS = [[0, 5, 'até 5 min'], [5, 15, '5–15 min'], [15, 30, '15–30 min'], [30, 60, '30–60 min'], [60, 120, '1–2 h'], [120, Infinity, 'mais de 2 h']];

// Ciclos finalizados sem início registrado (a pesquisa chegou numa conversa sem estado): não entram no volume,
// mas a nota do cliente entra na satisfação, pela data do encerramento.
export function avaliadosSemInicio(conv) {
  const ca = conv.custom_attributes || {};
  return [...(Array.isArray(ca.ciclos) ? ca.ciclos : []), ca]
    .filter((c) => c.finalizado_em && c.avaliacao != null && !c.ia_inicio && !c.transferido_em && !c.humano_inicio)
    .filter((c, i, l) => l.findIndex((x) => x.finalizado_em === c.finalizado_em) === i)
    .map((c) => ({ avaliacao: c.avaliacao, avaliacao_de: c.avaliacao_de, inicio: t(c.finalizado_em), conversa: conv.id }));
}

// de / ate: 'AAAA-MM-DD' (inclusive), no fuso de São Paulo. metaMin: meta do SLA de 1ª resposta.
export function calcularKpis(conversas, de, ate, metaMin = 15) {
  const dentro = (ms) => Number.isFinite(ms) && dataLocal(ms) >= de && dataLocal(ms) <= ate;
  const ciclos = conversas.flatMap(ciclosDaConversa).filter((c) => dentro(c.inicio));

  const comIa = ciclos.filter((c) => c.ia_inicio);
  const transferidos = ciclos.filter((c) => c.transferido_em);
  const finalizados = ciclos.filter((c) => c.finalizado_em);
  const finComIa = finalizados.filter((c) => c.ia_inicio);
  const finTransferidos = finalizados.filter((c) => c.transferido_em);

  const minutos = (a, b) => (t(b) - t(a)) / 60000;
  const esperaFila = transferidos.filter((c) => c.humano_inicio && t(c.humano_inicio) >= t(c.transferido_em))
    .map((c) => minutos(c.transferido_em, c.humano_inicio));
  const tmaHumano = finalizados.filter((c) => c.humano_inicio && c.finalizado_por === 'Atendente' && t(c.finalizado_em) >= t(c.humano_inicio))
    .map((c) => minutos(c.humano_inicio, c.finalizado_em));

  // SLA de 1ª resposta: transferência -> 1ª mensagem do atendente no ciclo
  const respondidos = transferidos.filter((c) => c.primeira_resposta_em && t(c.primeira_resposta_em) >= t(c.transferido_em));
  const tResp = (c) => minutos(c.transferido_em, c.primeira_resposta_em);
  const primeiraResposta = respondidos.map(tResp);
  const semResposta = finTransferidos.filter((c) => !respondidos.includes(c));
  const slaMeta = taxa(primeiraResposta.filter((m) => m <= metaMin).length, respondidos.length + semResposta.length);
  const naMeta = (lista) => taxa(lista.filter((c) => tResp(c) <= metaMin).length, lista.length);

  const avaliados = [...ciclos.filter((c) => c.avaliacao != null), ...conversas.flatMap(avaliadosSemInicio).filter((c) => dentro(c.inicio))];
  const csat = (lista) => ({
    n: lista.length,
    media: lista.length ? lista.reduce((s, c) => s + Number(c.avaliacao), 0) / lista.length : null,
    positivas: taxa(lista.filter((c) => Number(c.avaliacao) >= 4).length, lista.length),
    distribuicao: [1, 2, 3, 4, 5].map((n) => lista.filter((c) => Number(c.avaliacao) === n).length),
  });

  // Série diária (por dia de início do ciclo)
  const dias = [];
  for (let d = new Date(`${de}T12:00:00Z`); dataLocal(d.getTime()) <= ate; d = new Date(d.getTime() + 86400000)) dias.push(dataLocal(d.getTime()));
  const serie = dias.map((dia) => {
    const doDia = ciclos.filter((c) => dataLocal(c.inicio) === dia);
    const fin = doDia.filter((c) => c.finalizado_em);
    return {
      dia,
      recebidos: doDia.length,
      transferidos: doDia.filter((c) => c.transferido_em).length,
      finalizados_ia: fin.filter((c) => c.ia_inicio && !c.transferido_em).length,
      finalizados_humano: fin.filter((c) => c.humano_inicio).length,
      so_ia: doDia.filter((c) => c.ia_inicio && !c.transferido_em).length,
      com_humano: doDia.filter((c) => c.transferido_em || c.humano_inicio).length,
      resposta_mediana: quantil(respondidos.filter((c) => dataLocal(t(c.transferido_em)) === dia).map(tResp), 0.5),
      resposta_p90: quantil(respondidos.filter((c) => dataLocal(t(c.transferido_em)) === dia).map(tResp), 0.9),
    };
  });

  // Mapa de calor: dia da semana x hora de início
  const calor = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const c of ciclos) {
    const { dia, hora } = horaLocal(c.inicio);
    calor[dia][hora]++;
  }

  // Transferências por dia da semana x hora (picos de fila)
  const calorFila = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const c of transferidos) {
    const { dia, hora } = horaLocal(t(c.transferido_em));
    calorFila[dia][hora]++;
  }

  // Por atendente
  const porAtendente = new Map();
  for (const c of ciclos.filter((x) => x.atendente_blip && x.humano_inicio)) {
    const a = porAtendente.get(c.atendente_blip) || { atendente: c.atendente_blip, atendimentos: 0, espera: [], tma: [], notas: [], respondidos: [] };
    a.atendimentos++;
    if (respondidos.includes(c)) a.respondidos.push(c);
    if (c.transferido_em && t(c.humano_inicio) >= t(c.transferido_em)) a.espera.push(minutos(c.transferido_em, c.humano_inicio));
    if (c.finalizado_em && c.finalizado_por === 'Atendente') a.tma.push(minutos(c.humano_inicio, c.finalizado_em));
    if (c.avaliacao != null) a.notas.push(Number(c.avaliacao));
    porAtendente.set(c.atendente_blip, a);
  }
  const atendentes = [...porAtendente.values()]
    .map((a) => ({
      atendente: a.atendente,
      atendimentos: a.atendimentos,
      espera_mediana: quantil(a.espera, 0.5),
      resposta_mediana: quantil(a.respondidos.map(tResp), 0.5),
      resposta_na_meta: naMeta(a.respondidos),
      tma_mediana: quantil(a.tma, 0.5),
      csat_media: a.notas.length ? a.notas.reduce((s, n) => s + n, 0) / a.notas.length : null,
      csat_n: a.notas.length,
    }))
    .sort((x, y) => y.atendimentos - x.atendimentos);

  // Visão geral: IA x humano, desfecho e cobertura dos dados coletados
  const soIa = ciclos.filter((c) => c.ia_inicio && !c.transferido_em);
  const comHumano = ciclos.filter((c) => c.transferido_em || c.humano_inicio);
  const por = (q) => finalizados.filter((c) => c.finalizado_por === q);
  const duracao = (lista) => resumoTempo(lista.filter((c) => t(c.finalizado_em) >= c.inicio).map((c) => (t(c.finalizado_em) - c.inicio) / 60000));
  const porConversa = new Map();
  for (const c of ciclos) porConversa.set(c.conversa, (porConversa.get(c.conversa) || 0) + 1);
  const comAtendente = ciclos.filter((c) => c.humano_inicio);
  const geral = {
    clientes: porConversa.size,
    clientes_que_voltaram: [...porConversa.values()].filter((n) => n > 1).length,
    em_andamento: ciclos.length - finalizados.length,
    finalizados: finalizados.length,
    finalizados_por: { IA: por('IA').length, Atendente: por('Atendente').length, Inatividade: por('Inatividade').length },
    so_ia: soIa.length,
    com_humano: comHumano.length,
    finalizados_so_ia: finalizados.filter((c) => !c.transferido_em && !c.humano_inicio).length,
    finalizados_com_humano: finalizados.filter((c) => c.transferido_em || c.humano_inicio).length,
    ia_concluidos: por('IA').filter((c) => !c.transferido_em && !c.humano_inicio).length,
    participacao_ia: taxa(soIa.length, ciclos.length),
    duracao_ia_min: duracao(por('IA').filter((c) => !c.transferido_em)),
    duracao_humano_min: duracao(por('Atendente').filter((c) => c.transferido_em || c.humano_inicio)),
    ia_inatividade: taxa(por('Inatividade').filter((c) => !c.transferido_em).length, finalizados.filter((c) => !c.transferido_em).length),
    cobertura: {
      pesquisa_respondida: taxa(finalizados.filter((c) => c.avaliacao != null && c.finalizado_por !== 'Inatividade').length, finalizados.filter((c) => c.finalizado_por !== 'Inatividade').length),
      encerramento_registrado: taxa(finalizados.length - por('Inatividade').length, finalizados.length),
      atendente_identificado: taxa(comAtendente.filter((c) => c.atendente_blip).length, comAtendente.length),
      primeira_resposta: taxa(comAtendente.filter((c) => c.transferido_em && c.primeira_resposta_em).length, comAtendente.filter((c) => c.transferido_em).length),
    },
  };

  return {
    periodo: { de, ate, fuso: TZ },
    geral,
    recebidos: ciclos.length,
    passaram_pela_ia: comIa.length,
    transferencia: taxa(transferidos.filter((c) => c.ia_inicio).length, comIa.length),
    contencao_ia: taxa(finComIa.filter((c) => !c.transferido_em).length, finComIa.length),
    abandono_fila: taxa(finTransferidos.filter((c) => !c.humano_inicio).length, finTransferidos.length),
    espera_fila_min: resumoTempo(esperaFila),
    sla: {
      meta_min: metaMin,
      primeira_resposta_min: resumoTempo(primeiraResposta),
      na_meta: slaMeta,
      transferidos: transferidos.length,
      respondidos: respondidos.length,
      sem_resposta: semResposta.length,
      aguardando_resposta: transferidos.length - respondidos.length - semResposta.length,
      faixas: FAIXAS.map(([a, b, rotulo]) => ({ rotulo, n: primeiraResposta.filter((m) => (a === 0 || m > a) && m <= b).length })),
    },
    calor_fila: calorFila,
    tma_humano_min: resumoTempo(tmaHumano),
    csat: { geral: csat(avaliados), ia: csat(avaliados.filter((c) => c.avaliacao_de === 'IA')), atendente: csat(avaliados.filter((c) => c.avaliacao_de === 'Atendente')) },
    serie,
    calor,
    atendentes,
  };
}
