"""Preenche primeira_resposta_em (1ª mensagem 👤 do atendente após a transferência) nos ciclos já gravados.
Base do SLA de resposta do Dashboard. Idempotente: só preenche ciclos transferidos que ainda não têm o campo.
Hora da resposta = chegada da mensagem espelhada no Chatwoot (a ponte espelha em segundos).
uso: python3 scripts/backfill-primeira-resposta.py [--gravar]   (sem --gravar só simula)"""
import json, os, sys, urllib.request
from datetime import datetime, timezone

B = "https://visualchat.wendellcarvalho.com.br/api/v1/accounts/1"
TOK = open(os.path.expanduser("~/.secrets/chatwoot.token")).read().strip()
GRAVAR = "--gravar" in sys.argv
DESDE = "2026-10-30"


def call(path, method="GET", body=None):
    req = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "api_access_token": TOK})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


ts = lambda iso: datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() if iso else None
iso = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def respostas_do_atendente(cid):
    """Horários das mensagens 👤 da conversa (todas as páginas)."""
    horas, antes = [], None
    while True:
        lote = call(f"/conversations/{cid}/messages" + (f"?before={antes}" if antes else ""))["payload"]
        horas += [m["created_at"] for m in lote if m["message_type"] == 1 and (m.get("content") or "").startswith("👤")]
        if len(lote) < 20: return sorted(horas)
        antes = min(m["id"] for m in lote)


def preencher(ciclo, horas):
    if not ciclo.get("transferido_em") or ciclo.get("primeira_resposta_em"): return False
    ini, fim = ts(ciclo["transferido_em"]), ts(ciclo.get("finalizado_em"))
    r = next((h for h in horas if h >= ini - 5 and (fim is None or h <= fim + 60)), None)
    if r is None: return False
    ciclo["primeira_resposta_em"] = iso(max(r, ini))
    return True


convs, page = [], 1
while True:
    b = call(f"/conversations/filter?page={page}", "POST", {"payload": [
        {"attribute_key": "last_activity_at", "filter_operator": "is_greater_than", "values": [DESDE], "query_operator": None}]})["payload"]
    if not b: break
    convs += b; page += 1

alterados, preenchidos, difs = 0, 0, []
for c in convs:
    ca = c.get("custom_attributes") or {}
    ciclos = [dict(x) for x in ca.get("ciclos") or []]
    atual = {k: ca.get(k) for k in ("transferido_em", "humano_inicio", "finalizado_em", "primeira_resposta_em")}
    pendentes = [x for x in ciclos + [atual] if x.get("transferido_em") and not x.get("primeira_resposta_em")]
    if not pendentes: continue
    horas = respostas_do_atendente(c["id"])
    n = sum(preencher(x, horas) for x in ciclos + [atual])
    if not n: continue
    for x in ciclos + [atual]:
        if x.get("primeira_resposta_em") and x.get("humano_inicio"):
            difs.append((ts(x["primeira_resposta_em"]) - ts(x["humano_inicio"])) / 60)
    attrs = {"ciclos": ciclos} if ciclos else {}
    if atual.get("primeira_resposta_em") and not ca.get("primeira_resposta_em"):
        attrs["primeira_resposta_em"] = atual["primeira_resposta_em"]
    # o ciclo atual repetido como último de "ciclos" (conversa finalizada) recebe o mesmo valor
    if ciclos and ciclos[-1].get("finalizado_em") and ciclos[-1].get("finalizado_em") == ca.get("finalizado_em") and ciclos[-1].get("primeira_resposta_em") and not ca.get("primeira_resposta_em"):
        attrs["primeira_resposta_em"] = ciclos[-1]["primeira_resposta_em"]
    if GRAVAR:
        call(f"/conversations/{c['id']}/custom_attributes", "POST", {"custom_attributes": attrs, "merge": True})
    alterados += 1; preenchidos += n

difs.sort()
med = difs[len(difs) // 2] if difs else None
print(f"{'GRAVADO' if GRAVAR else 'SIMULAÇÃO'}: {len(convs)} conversas lidas, {alterados} alteradas, {preenchidos} ciclos com 1ª resposta")
if difs:
    print(f"1ª resposta - assumiu o ticket: mediana {med:.1f} min, p90 {difs[int(len(difs) * .9)]:.1f} min, n={len(difs)}")
