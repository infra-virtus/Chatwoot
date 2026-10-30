"""Corrige estados que ficaram errados durante a ativação da máquina de estados (30/10):
1. IA reaberta pelo vaivém da pesquisa: conversa em IA cujo histórico tem "→ Finalizado (pedido de avaliação)"
   seguido de "Finalizado → IA" em até 30 min, sem mensagem de cliente depois  -> Finalizado (IA).
2. Abertas sem estado cuja última resposta espelhada é do bot (🤖) -> IA (responsável = bot "Blip").
Idempotente; não envia nada ao cliente."""
import datetime, json, os, urllib.request

B = "https://visualchat.wendellcarvalho.com.br/api/v1/accounts/1"
TOK = {"user": open(os.path.expanduser("~/.secrets/chatwoot.token")).read().strip(),
       "bot": open(os.path.expanduser("~/.secrets/chatwoot-bot-blip.token")).read().strip()}
BOT_ID = 1

def call(path, method="GET", body=None, tok="user"):
    req = urllib.request.Request(B + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"api_access_token": TOK[tok], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)

def note(cid, text):
    call(f"/conversations/{cid}/messages", "POST", {"content": text, "private": True}, tok="bot")

convs = []
for status in ("open", "pending"):
    page = 1
    while True:
        batch = call(f"/conversations?inbox_id=1&status={status}&assignee_type=all&page={page}")["data"]["payload"]
        if not batch: break
        convs += batch; page += 1

fin = ia = 0
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
for cv in convs:
    estado = cv.get("custom_attributes", {}).get("atendimento")
    msgs = call(f"/conversations/{cv['id']}/messages")["payload"]
    if estado == "IA":
        notes = [m for m in msgs if m.get("private") and (m.get("content") or "").startswith("🔁")]
        pedido = [m for m in notes if "→ Finalizado (pedido de avaliação)" in m["content"]]
        volta = [m for m in notes if m["content"].startswith("🔁 Atendimento: Finalizado → IA")]
        if pedido and volta and 0 <= volta[-1]["created_at"] - pedido[-1]["created_at"] <= 1800:
            cliente_depois = any(m["message_type"] == 0 and m["created_at"] > volta[-1]["created_at"] for m in msgs)
            if not cliente_depois:
                call(f"/conversations/{cv['id']}/custom_attributes", "POST", {"custom_attributes": {
                    "atendimento": "Finalizado", "finalizado_por": "IA", "finalizado_em": now, "atendimento_desde": now}, "merge": True})
                note(cv["id"], "🔁 Atendimento: IA → Finalizado (correção: reaberta pela pesquisa de satisfação)")
                call(f"/conversations/{cv['id']}/toggle_status", "POST", {"status": "resolved"}, tok="bot")
                fin += 1; print(f"#{cv['id']} IA -> Finalizado", flush=True)
    elif not estado:
        out = [m for m in msgs if m["message_type"] == 1 and not m.get("private")]
        if out and (out[-1].get("content") or "").startswith("🤖"):
            call(f"/conversations/{cv['id']}/custom_attributes", "POST", {"custom_attributes": {
                "atendimento": "IA", "ia_inicio": now, "atendimento_desde": now}, "merge": True})
            note(cv["id"], "🔁 Atendimento: sem estado → IA (correção: bot respondeu antes da ativação dos estados)")
            call(f"/conversations/{cv['id']}/assignments", "POST", {"assignee_id": BOT_ID, "assignee_type": "AgentBot"})
            ia += 1; print(f"#{cv['id']} sem estado -> IA", flush=True)
print(f"FIM: finalizadas {fin}, marcadas IA {ia}", flush=True)
