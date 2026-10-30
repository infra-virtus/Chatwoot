"""Marca como Finalizado (Inatividade) e resolve conversas abertas da caixa do WhatsApp
sem estado de atendimento e sem atividade há mais de 24h. Idempotente: pula as já classificadas.
Não envia nada aos clientes (CSAT, saudação e automações estão desligados)."""
import datetime, json, os, time, urllib.request

B = "https://visualchat.wendellcarvalho.com.br/api/v1/accounts/1"
TOKENS = {"user": open(os.path.expanduser("~/.secrets/chatwoot.token")).read().strip(),
          "bot": open(os.path.expanduser("~/.secrets/chatwoot-bot-blip.token")).read().strip()}

def call(path, method="GET", body=None, tok="user"):
    req = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"api_access_token": TOKENS[tok], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

ok = err = 0
while True:
    # sempre a página 1: as finalizadas saem da lista de abertas
    batch = call("/conversations?inbox_id=1&status=open&assignee_type=all&page=1")["data"]["payload"]
    stale = [c for c in batch if not c.get("custom_attributes", {}).get("atendimento")
             and time.time() - c["last_activity_at"] > 24 * 3600]
    if not stale:
        page, more = 2, True
        while more and not stale:  # procura nas páginas seguintes
            batch = call(f"/conversations?inbox_id=1&status=open&assignee_type=all&page={page}")["data"]["payload"]
            more = bool(batch); page += 1
            stale = [c for c in batch if not c.get("custom_attributes", {}).get("atendimento")
                     and time.time() - c["last_activity_at"] > 24 * 3600]
        if not stale:
            break
    for c in stale:
        try:
            ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
            call(f"/conversations/{c['id']}/custom_attributes", "POST",
                 {"custom_attributes": {"atendimento": "Finalizado", "finalizado_por": "Inatividade",
                                        "finalizado_em": ts, "atendimento_desde": ts}, "merge": True})
            call(f"/conversations/{c['id']}/toggle_status", "POST", {"status": "resolved"}, tok="bot")
            ok += 1
        except Exception as e:  # segue com as demais
            err += 1
            print("erro conversa", c["id"], str(e)[:120], flush=True)
    print(f"finalizadas até agora: {ok} (erros {err})", flush=True)
print(f"FIM: finalizadas {ok}, erros {err}", flush=True)
