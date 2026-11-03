#!/bin/sh
# Grava em ~/.secrets/bridge/agent-tokens.json o token de API de cada atendente da conta 1 ({"email": "token"}),
# para a ponte registrar as respostas da Blip em nome do atendente (relatórios nativos de 1ª resposta,
# tempo de resposta e produtividade). Autorizado pelo responsável em 2026-11-03. Nunca imprime tokens.
# Rodar após novos atendentes surgirem; a ponte relê o arquivo a cada 5 min.
set -e
OUT="$HOME/.secrets/bridge/agent-tokens.json"  # pasta montada somente leitura na ponte
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
"$(dirname "$0")/rails_runner.sh" 'puts "TOKENS_JSON=" + Account.find(1).users.where.not(email: "infra@grupovirtus.com.br").to_h { |u| [u.email.downcase, u.access_token.token] }.to_json' \
  | grep '^TOKENS_JSON=' | sed 's/^TOKENS_JSON=//' > "$TMP"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d,dict); print(f"{len(d)} atendentes")' "$TMP"
umask 077
install -m 600 "$TMP" "$OUT"
