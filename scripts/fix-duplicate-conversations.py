"""Conversas duplicadas criadas antes de ligar "reabrir conversa anterior" (inclui respostas soltas à
pesquisa de satisfação): encerra a duplicada apontando para a conversa acompanhada pela ponte e, se a
primeira mensagem for uma nota 1-5, grava a avaliação na original. Só mexe em conversas abertas, sem
responsável, sem nenhuma resposta da Blip. Idempotente."""
import datetime, json, os, re, time, urllib.request

B = "https://visualchat.wendellcarvalho.com.br/api/v1/accounts/1"
TOK = {"user": open(os.path.expanduser("~/.secrets/chatwoot.token")).read().strip(),
       "bot": open(os.path.expanduser("~/.secrets/chatwoot-bot-blip.token")).read().strip()}

def call(path, method="GET", body=None, tok="user"):
    req = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"api_access_token": TOK[tok], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

opened = []; page = 1
while True:
    batch = call(f"/conversations?inbox_id=1&status=open&assignee_type=unassigned&page={page}")["data"]["payload"]
    if not batch: break
    opened += batch; page += 1

fixed = notas = 0
for cv in opened:
    if cv.get("custom_attributes", {}).get("atendimento"): continue
    msgs = call(f"/conversations/{cv['id']}/messages")["payload"]
    if any(m["message_type"] == 1 for m in msgs): continue          # teve resposta da Blip: não é solta
    incoming = [m for m in msgs if m["message_type"] == 0]
    contact = cv["meta"]["sender"]["id"]
    # outra conversa do mesmo cliente já acompanhada pela ponte (tem estado de atendimento)
    others = [c for c in call(f"/contacts/{contact}/conversations")["payload"]
              if c["id"] != cv["id"] and c["inbox_id"] == 1 and c.get("custom_attributes", {}).get("atendimento")]
    if not others: continue
    orig = max(others, key=lambda c: c["last_activity_at"])
    first = (incoming[0].get("content") or "").strip() if incoming else ""
    nota = re.match(r"^([1-5])\b", first)
    if nota and orig["status"] == "resolved" and orig.get("custom_attributes", {}).get("avaliacao") is None:
        de = "IA" if orig["custom_attributes"].get("finalizado_por") == "IA" else "Atendente"
        call(f"/conversations/{orig['id']}/custom_attributes", "POST",
             {"custom_attributes": {"avaliacao": int(nota[1]), "avaliacao_de": de}, "merge": True})
        call(f"/conversations/{orig['id']}/messages", "POST",
             {"content": f"⭐ Avaliação do cliente: {nota[1]}/5 ({de}) — veio na conversa #{cv['id']}", "private": True}, tok="bot")
        notas += 1
    ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
    call(f"/conversations/{cv['id']}/custom_attributes", "POST",
         {"custom_attributes": {"atendimento": "Finalizado", "finalizado_por": orig["custom_attributes"].get("finalizado_por", "IA"),
                                "finalizado_em": ts, "atendimento_desde": ts}, "merge": True})
    call(f"/conversations/{cv['id']}/messages", "POST",
         {"content": f"🔁 Conversa duplicada: o atendimento deste cliente segue na conversa #{orig['id']} — encerrada automaticamente", "private": True}, tok="bot")
    call(f"/conversations/{cv['id']}/toggle_status", "POST", {"status": "resolved"}, tok="bot")
    fixed += 1
    print(f"solta #{cv['id']} -> original #{orig['id']}" + (f" nota {nota[1]}" if nota else ""), flush=True)
print(f"FIM: soltas encerradas {fixed}, notas gravadas {notas}", flush=True)
