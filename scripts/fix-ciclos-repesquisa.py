"""Remove os ciclos-fantasma criados quando a Blip repetia o pedido de avaliação depois da janela de 30 min
("Vamos tentar novamente... Que tal agora me avaliar?"): ciclo só de IA que começa e termina em segundos.
A nota recebida nesse ciclo volta para o atendimento anterior (o que o cliente estava avaliando).
Corrigido na ponte em 2026-11-05 (REPESQUISA). Idempotente.
uso: python3 scripts/fix-ciclos-repesquisa.py [--gravar]   (sem --gravar só simula)"""
import json, os, sys, urllib.request
from datetime import datetime

B = "https://visualchat.wendellcarvalho.com.br/api/v1/accounts/1"
TOK = open(os.path.expanduser("~/.secrets/chatwoot.token")).read().strip()
GRAVAR = "--gravar" in sys.argv
MAX_SEG = 15
CAMPOS = ["ia_inicio", "transferido_em", "humano_inicio", "primeira_resposta_em", "atendente_blip", "finalizado_em",
          "finalizado_por", "avaliacao", "avaliacao_de", "avaliacao_em"]


def call(path, method="GET", body=None):
    req = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", "api_access_token": TOK})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


ts = lambda iso: datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def fantasma(c):
    return (c.get("ia_inicio") and c.get("finalizado_em") and c.get("finalizado_por") == "IA"
            and not c.get("transferido_em") and not c.get("humano_inicio")
            and 0 <= ts(c["finalizado_em"]) - ts(c["ia_inicio"]) <= MAX_SEG)


convs, page = [], 1
while True:
    b = call(f"/conversations/filter?page={page}", "POST", {"payload": [
        {"attribute_key": "last_activity_at", "filter_operator": "is_greater_than", "values": ["2026-10-29"], "query_operator": None}]})["payload"]
    if not b: break
    convs += b; page += 1

alteradas = removidos = notas = 0
for conv in convs:
    ca = conv.get("custom_attributes") or {}
    ciclos = ca.get("ciclos") or []
    if not any(fantasma(c) for c in ciclos): continue
    ultimo_era_atual = bool(ciclos) and ciclos[-1].get("finalizado_em") == ca.get("finalizado_em")
    novos = []
    for c in ciclos:
        if not fantasma(c):
            novos.append(dict(c)); continue
        removidos += 1
        anterior = novos[-1] if novos else None
        if c.get("avaliacao") is not None and anterior is not None and anterior.get("avaliacao") is None:
            anterior.update(avaliacao=c["avaliacao"], avaliacao_em=c.get("avaliacao_em"),
                            avaliacao_de="IA" if anterior.get("finalizado_por") == "IA" else "Atendente")
            notas += 1
    attrs = {"ciclos": novos}
    if ultimo_era_atual:  # o ciclo atual era o fantasma: passa a ser o último ciclo real
        ref = novos[-1] if novos else {}
        attrs.update({k: ref.get(k) for k in CAMPOS})
    if GRAVAR:
        call(f"/conversations/{conv['id']}/custom_attributes", "POST", {"custom_attributes": attrs, "merge": True})
    alteradas += 1

print(f"{'GRAVADO' if GRAVAR else 'SIMULAÇÃO'}: {len(convs)} conversas lidas, {alteradas} alteradas, "
      f"{removidos} ciclos-fantasma removidos, {notas} notas devolvidas ao atendimento anterior")
