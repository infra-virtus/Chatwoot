"""Conversas abertas sem responsável, sem estado e sem nenhuma resposta da Blip espelhada (anteriores à ponte):
etiqueta "sem-historico-blip" e adia até a próxima mensagem (snooze sem data). Voltam sozinhas quando o cliente
escreve ou quando a ponte registra resposta da Blip. Idempotente; não envia nada ao cliente."""
import json, os, urllib.request

B = "https://visualchat.wendellcarvalho.com.br/api/v1/accounts/1"
TOK = {"user": open(os.path.expanduser("~/.secrets/chatwoot.token")).read().strip(),
       "bot": open(os.path.expanduser("~/.secrets/chatwoot-bot-blip.token")).read().strip()}
LABEL = "sem-historico-blip"

def call(path, method="GET", body=None, tok="user"):
    req = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"api_access_token": TOK[tok], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

if LABEL not in [l["title"] for l in call("/labels")["payload"]]:
    call("/labels", "POST", {"title": LABEL, "description": "Conversa anterior à ponte Blip: sem informação de quem atende",
                             "color": "#D6A45E", "show_on_sidebar": True})

convs = []; page = 1
while True:
    batch = call(f"/conversations?inbox_id=1&status=open&assignee_type=unassigned&page={page}")["data"]["payload"]
    if not batch: break
    convs += batch; page += 1

done = 0
for cv in convs:
    if cv.get("custom_attributes", {}).get("atendimento"): continue
    msgs = call(f"/conversations/{cv['id']}/messages")["payload"]
    if any(m["message_type"] == 1 and not m.get("private") for m in msgs): continue  # tem resposta da Blip
    labels = sorted(set(cv.get("labels", []) + [LABEL]))
    call(f"/conversations/{cv['id']}/labels", "POST", {"labels": labels})
    call(f"/conversations/{cv['id']}/messages", "POST", {"private": True, "content":
         "🔁 Sem histórico da Blip (anterior à ponte): adiada até a próxima mensagem. Volta sozinha quando o cliente ou a Blip responder."}, tok="bot")
    call(f"/conversations/{cv['id']}/toggle_status", "POST", {"status": "snoozed"}, tok="bot")
    done += 1
print(f"FIM: adiadas {done}", flush=True)
