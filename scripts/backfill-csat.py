"""Leva as notas da pesquisa da Blip já gravadas (campo avaliacao) para o CSAT nativo do Chatwoot.
Idempotente: pula conversas que já têm resposta de CSAT. Nada é enviado ao cliente (source_id)."""
import json, os, urllib.request

BASE = "https://visualchat.wendellcarvalho.com.br"
B = BASE + "/api/v1/accounts/1"
TOK = {"user": open(os.path.expanduser("~/.secrets/chatwoot.token")).read().strip(),
       "bot": open(os.path.expanduser("~/.secrets/chatwoot-bot-blip.token")).read().strip()}

def call(url, method="GET", body=None, tok="user"):
    h = {"Content-Type": "application/json"}
    if tok: h["api_access_token"] = TOK[tok]
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

convs = []; page = 1
while True:
    b = call(f"{B}/conversations/filter?page={page}", "POST", {"payload": [
        {"attribute_key": "avaliacao", "filter_operator": "is_present", "values": [], "query_operator": None}]})["payload"]
    if not b: break
    convs += b; page += 1
done = skip = 0
for c in convs:
    nota = int(c["custom_attributes"]["avaliacao"])
    msgs = call(f"{B}/conversations/{c['id']}/messages")["payload"]
    csat = [m for m in msgs if m.get("content_type") == "input_csat"]
    if csat and (csat[0].get("content_attributes") or {}).get("submitted_values"):
        skip += 1; continue
    if not csat:
        call(f"{B}/conversations/{c['id']}/messages", "POST", {"content": "Pesquisa de satisfação (Blip)", "content_type": "input_csat",
             "message_type": "template", "source_id": f"blip-csat:{c['id']}"}, tok="bot")
    call(f"{BASE}/public/api/v1/csat_survey/{c['uuid']}", "PUT",
         {"message": {"submitted_values": {"csat_survey_response": {"rating": nota, "feedback_message": ""}}}}, tok=None)
    done += 1
print(f"CSAT nativo: registradas {done}, já existentes {skip}, total com nota {len(convs)}")
