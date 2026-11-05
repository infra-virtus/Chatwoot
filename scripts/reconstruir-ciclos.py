"""Reconstrói atendimentos (ciclos) que faltam no campo "ciclos" a partir das notas "🔁 Atendimento: X → Y (motivo)".
Entre 30/10 15h14 (notas de estado) e 03/11 13h28 (lista "ciclos") o atendimento anterior era sobrescrito quando o
cliente voltava. Também devolve ao atendimento certo as notas ⭐ que não estão em nenhum ciclo.
Só insere ciclos finalizados que não existem; não altera os ciclos gravados pela ponte. Idempotente.
Horários = chegada da nota no Chatwoot (a ponte grava em segundos). Atendente e 1ª resposta vêm das mensagens 👤.
uso: python3 scripts/reconstruir-ciclos.py [--gravar]   (sem --gravar só simula)"""
import json, os, re, sys, urllib.request
from datetime import datetime, timezone

B = "https://visualchat.wendellcarvalho.com.br/api/v1/accounts/1"
TOK = open(os.path.expanduser("~/.secrets/chatwoot.token")).read().strip()
GRAVAR = "--gravar" in sys.argv
INICIO_NOTAS = datetime(2026, 10, 30, 18, 0, tzinfo=timezone.utc).timestamp()
INICIO_CICLOS = datetime(2026, 11, 3, 16, 28, tzinfo=timezone.utc).timestamp()
JANELA = 30 * 60
NOTA = re.compile(r"^🔁 Atendimento: (.+?) → (.+?) \((.*)\)$", re.S)
ESTRELA = re.compile(r"^⭐ Avaliação do cliente: ([1-5])/5 \((IA|Atendente)\)")


def call(path, method="GET", body=None):
    req = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "api_access_token": TOK})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


ts = lambda iso: datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() if iso else None
iso = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
inicio = lambda c: ts(c.get("ia_inicio") or c.get("transferido_em") or c.get("humano_inicio"))


def mensagens(cid):
    todas, antes = [], None
    while True:
        lote = call(f"/conversations/{cid}/messages" + (f"?before={antes}" if antes else ""))["payload"]
        todas += lote
        if len(lote) < 20 or min(m["created_at"] for m in lote) < INICIO_NOTAS - 86400: break
        antes = min(m["id"] for m in lote)
    return sorted(todas, key=lambda m: m["created_at"])


def ciclos_das_notas(msgs):
    notas = [(m["created_at"], *NOTA.match(m["content"]).groups()) for m in msgs
             if m.get("private") and NOTA.match(m.get("content") or "")]
    # pares-fantasma: pedido de avaliação repetido virou "Finalizado → IA → Finalizado" em segundos
    fantasma = set()
    for i in range(len(notas) - 1):
        a, b = notas[i], notas[i + 1]
        if a[1] == "Finalizado" and a[2] == "IA" and b[2] == "Finalizado" and b[0] - a[0] <= 15: fantasma |= {i, i + 1}
    ciclos, atual = [], None
    for i, (t, de, para, motivo) in enumerate(notas):
        if i in fantasma: continue
        if de in ("sem estado", "Finalizado") and para != "Finalizado":
            atual = {}
        if atual is None: continue
        if para == "IA": atual.setdefault("ia_inicio", iso(t))
        if para == "Aguardando atendente": atual.update(transferido_em=iso(t), primeira_resposta_em=None)
        if para == "Atendimento humano": atual["humano_inicio"] = iso(t)
        if para == "Finalizado":
            por = ("Inatividade" if "sem atividade" in motivo else
                   "Atendente" if "ticket" in motivo or de in ("Atendimento humano", "Aguardando atendente") else "IA")
            atual.update(finalizado_em=iso(t), finalizado_por=por)
            if inicio(atual): ciclos.append(atual)
            atual = None
    return ciclos


def completar(c, msgs):
    """Atendente e 1ª resposta a partir das mensagens 👤 dentro do ciclo."""
    fim = ts(c["finalizado_em"]) + 60
    respostas = [m for m in msgs if m["message_type"] == 1 and (m.get("content") or "").startswith("👤")
                 and inicio(c) - 5 <= m["created_at"] <= fim]
    if c.get("transferido_em"):
        r = next((m for m in respostas if m["created_at"] >= ts(c["transferido_em"]) - 5), None)
        if r: c["primeira_resposta_em"] = iso(max(r["created_at"], ts(c["transferido_em"])))
    email = next(((m.get("sender") or {}).get("email") for m in respostas if (m.get("sender") or {}).get("type") == "user"), None)
    if email: c["atendente_blip"] = email.lower()


convs, page = [], 1
while True:
    b = call(f"/conversations/filter?page={page}", "POST", {"payload": [
        {"attribute_key": "last_activity_at", "filter_operator": "is_greater_than", "values": ["2026-10-30"], "query_operator": None}]})["payload"]
    if not b: break
    convs += b; page += 1

alteradas = inseridos = notas_dev = 0
for conv in convs:
    ca = conv.get("custom_attributes") or {}
    msgs = mensagens(conv["id"])
    guardados = [dict(x) for x in ca.get("ciclos") or []]
    atual_dup = bool(guardados) and guardados[-1].get("finalizado_em") == ca.get("finalizado_em")
    existentes = guardados + ([] if atual_dup or not inicio(ca) else [{k: ca.get(k) for k in ("ia_inicio", "transferido_em", "humano_inicio", "finalizado_em")}])

    def existe(c):
        return any((inicio(e) and abs(inicio(e) - inicio(c)) < JANELA) or
                   (e.get("finalizado_em") and abs(ts(e["finalizado_em"]) - ts(c["finalizado_em"])) < JANELA) for e in existentes)

    novos = [c for c in ciclos_das_notas(msgs) if inicio(c) < INICIO_CICLOS and not existe(c)]
    for c in novos: completar(c, msgs)
    lista = sorted(guardados + novos, key=lambda c: inicio(c) or ts(c.get("finalizado_em")) or 0)
    # notas ⭐ que não estão em nenhum ciclo vão para o último ciclo finalizado antes delas (sem nota)
    mudou_atual = {}
    nota_nesta = 0
    for m in msgs:
        e = ESTRELA.match(m.get("content") or "") if m.get("private") else None
        if not e: continue
        t = m["created_at"]
        candidatos = lista + ([] if atual_dup else [ca])
        if any(x.get("avaliacao") is not None and x.get("avaliacao_em") and abs(ts(x["avaliacao_em"]) - t) < 600 for x in candidatos): continue
        alvo = next((x for x in reversed(lista) if x.get("finalizado_em") and ts(x["finalizado_em"]) <= t + 5), None)
        if alvo is None or alvo.get("avaliacao") is not None: continue
        alvo.update(avaliacao=int(e.group(1)), avaliacao_de=e.group(2), avaliacao_em=iso(t))
        notas_dev += 1
        nota_nesta += 1
        if atual_dup and alvo is lista[-1] and ca.get("avaliacao") is None:
            mudou_atual = {k: alvo[k] for k in ("avaliacao", "avaliacao_de", "avaliacao_em")}
    if not novos and not nota_nesta: continue
    attrs = {"ciclos": lista[-30:], **mudou_atual}
    if GRAVAR:
        call(f"/conversations/{conv['id']}/custom_attributes", "POST", {"custom_attributes": attrs, "merge": True})
    alteradas += 1; inseridos += len(novos)

print(f"{'GRAVADO' if GRAVAR else 'SIMULAÇÃO'}: {len(convs)} conversas lidas, {alteradas} alteradas, "
      f"{inseridos} atendimentos reconstruídos, {notas_dev} notas ⭐ devolvidas")
