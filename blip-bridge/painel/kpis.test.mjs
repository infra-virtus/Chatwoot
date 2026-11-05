import { calcularKpis } from './kpis.mjs';
import assert from 'node:assert/strict';
const c = (id, ca) => ({ id, custom_attributes: ca });
const convs = [
  // 1) só IA, finalizado pela IA, nota 5 (02/11 10h SP = 13h UTC)
  c(1, { ia_inicio: '2026-11-02T13:00:00Z', finalizado_em: '2026-11-02T13:10:00Z', finalizado_por: 'IA', avaliacao: 5, avaliacao_de: 'IA' }),
  // 2) IA -> fila 10 min -> humano 30 min -> fim; nota 4
  c(2, { ia_inicio: '2026-11-02T14:00:00Z', transferido_em: '2026-11-02T14:05:00Z', humano_inicio: '2026-11-02T14:15:00Z', primeira_resposta_em: '2026-11-02T14:17:00Z', atendente_blip: 'ana@grupovirtus.com.br',
         finalizado_em: '2026-11-02T14:45:00Z', finalizado_por: 'Atendente', avaliacao: 4, avaliacao_de: 'Atendente' }),
  // 3) IA -> fila -> finalizado sem humano (abandono)
  c(3, { ia_inicio: '2026-11-03T12:00:00Z', transferido_em: '2026-11-03T12:01:00Z', finalizado_em: '2026-11-03T15:00:00Z', finalizado_por: 'Inatividade' }),
  // 4) conversa reaberta: ciclo antigo em "ciclos" (fora do período) + ciclo atual IA em andamento
  c(4, { ciclos: [{ ia_inicio: '2026-10-20T12:00:00Z', finalizado_em: '2026-10-20T12:30:00Z', finalizado_por: 'IA' }], ia_inicio: '2026-11-03T18:00:00Z' }),
  // 5) 03/11 01h UTC = 02/11 22h em SP (teste de fuso)
  c(5, { ia_inicio: '2026-11-03T01:00:00Z' }),
];
const k = calcularKpis(convs, '2026-11-02', '2026-11-03');
assert.equal(k.recebidos, 5);
assert.deepEqual([k.transferencia.num, k.transferencia.den], [2, 5]);
assert.deepEqual([k.contencao_ia.num, k.contencao_ia.den], [1, 3]);       // finalizados com IA: 1,2,3 -> só o 1 sem transferência
assert.deepEqual([k.abandono_fila.num, k.abandono_fila.den], [1, 2]);     // transferidos finalizados: 2,3 -> 3 sem humano
assert.equal(k.espera_fila_min.mediana, 10);
assert.equal(k.tma_humano_min.mediana, 30);
assert.equal(k.csat.geral.n, 2); assert.equal(k.csat.geral.media, 4.5);
assert.deepEqual(k.serie.map((d) => d.recebidos), [3, 2]);                // conv 5 cai em 02/11 (fuso SP)
assert.equal(k.atendentes[0].atendimentos, 1); assert.equal(k.atendentes[0].espera_mediana, 10);
const so20 = calcularKpis(convs, '2026-10-20', '2026-10-20');
assert.equal(so20.recebidos, 1); assert.equal(so20.contencao_ia.num, 1);  // ciclo antigo contado no seu dia
// SLA: conv 2 respondeu em 12 min (na meta de 15); conv 3 terminou sem resposta (fora da meta)
assert.equal(k.sla.primeira_resposta_min.mediana, 12);
assert.deepEqual([k.sla.na_meta.num, k.sla.na_meta.den], [1, 2]);
assert.deepEqual([k.sla.respondidos, k.sla.sem_resposta, k.sla.aguardando_resposta], [1, 1, 0]);
assert.equal(k.sla.faixas.find((f) => f.rotulo === '5–15 min').n, 1);
assert.equal(k.atendentes[0].resposta_mediana, 12);
assert.equal(calcularKpis(convs, '2026-11-02', '2026-11-03', 10).sla.na_meta.num, 0); // meta de 10 min
assert.equal(k.calor_fila.flat().reduce((s, v) => s + v, 0), 2);
// Geral: 5 ciclos em 5 conversas; só IA = 1,4,5; com humano = 2,3; finalizados 1 (IA), 2 (Atendente), 3 (Inatividade)
const g = k.geral;
assert.deepEqual([g.clientes, g.clientes_que_voltaram, g.so_ia, g.com_humano, g.em_andamento], [5, 0, 3, 2, 2]);
assert.deepEqual(g.finalizados_por, { IA: 1, Atendente: 1, Inatividade: 1 });
assert.equal(g.duracao_ia_min.mediana, 10); assert.equal(g.duracao_humano_min.mediana, 45);
assert.deepEqual([g.cobertura.pesquisa_respondida.num, g.cobertura.pesquisa_respondida.den], [2, 2]);
assert.deepEqual([g.cobertura.encerramento_registrado.num, g.cobertura.encerramento_registrado.den], [2, 3]);
assert.deepEqual([g.cobertura.atendente_identificado.num, g.cobertura.primeira_resposta.num], [1, 1]);
assert.deepEqual([g.ia_inatividade.num, g.ia_inatividade.den], [0, 1]);
assert.deepEqual([g.finalizados_so_ia, g.finalizados_com_humano, g.ia_concluidos], [1, 2, 1]);
assert.deepEqual(k.serie.map((d) => [d.so_ia, d.com_humano]), [[2, 1], [1, 1]]);
// nota em ciclo sem início: entra no CSAT (data do encerramento), não no volume
const comSemInicio = calcularKpis([...convs, c(9, { finalizado_em: '2026-11-03T14:00:00Z', finalizado_por: 'IA', avaliacao: 3, avaliacao_de: 'IA' })], '2026-11-02', '2026-11-03');
assert.equal(comSemInicio.recebidos, 5); assert.equal(comSemInicio.csat.geral.n, 3); assert.equal(comSemInicio.csat.ia.n, 2);
// IA -> atendente sem passar pela fila: conta só em "com atendente" (os grupos somam o total)
const direto = calcularKpis([c(10, { ia_inicio: '2026-11-02T15:00:00Z', humano_inicio: '2026-11-02T15:05:00Z', atendente_blip: 'ana@grupovirtus.com.br' })], '2026-11-02', '2026-11-02');
assert.deepEqual([direto.geral.so_ia, direto.geral.com_humano, direto.recebidos], [0, 1, 1]);
assert.deepEqual([direto.serie[0].so_ia, direto.serie[0].com_humano], [0, 1]);
console.log('KPIs: todos os testes passaram');
