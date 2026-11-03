#!/bin/sh
# Checkup rápido de produção (somente leitura). Rodar depois de cada deploy.
# uso: scripts/smoke-test.sh
D=https://visualchat.wendellcarvalho.com.br
DIR=$(dirname "$0")/..
F=0
check() { # nome esperado obtido
  if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (esperado $2, veio $3)"; F=$((F + 1)); fi
}
code() { curl -s -o /dev/null -m20 -w '%{http_code}' "$@"; }

check "app saudável (/api)" ok "$(curl -s -m15 $D/api | python3 -c 'import sys,json;d=json.load(sys.stdin);print("ok" if d["queue_services"]=="ok" and d["data_services"]=="ok" else d)')"
check "http redireciona para https" 301 "$(code http://visualchat.wendellcarvalho.com.br/)"
check "login abre" 200 "$(code $D/app/login)"
check "título Atendimento Wendell" 1 "$(curl -s -m15 $D/app/login | grep -A1 '<title>' | grep -c 'Atendimento Wendell')"
check "HSTS ativo" 1 "$(curl -sI -m15 $D/app/login | grep -ci '^strict-transport-security')"
check "painel sem login bloqueado" 401 "$(code $D/painel-ia/api/me)"
check "painel KPIs sem login bloqueado" 401 "$(code $D/painel-ia/api/kpis)"
check "webhook Blip com token errado" 404 "$(code -X POST $D/blip-webhook/token-errado)"
check "webhook Meta sem assinatura" 401 "$(code $D/webhooks/whatsapp/+554891265138)"
check "rotas internas fechadas" 404 "$(code $D/rails/info)"
TOKEN=$(grep ^BLIP_WEBHOOK_PATH_TOKEN "$DIR/.env" | cut -d= -f2)
check "corpo > 1 MB recusado" 413 "$(head -c 1100000 /dev/zero | curl -s -o /dev/null -m20 -w '%{http_code}' -X POST --data-binary @- $D/blip-webhook/$TOKEN)"
DIAS=$(echo | openssl s_client -servername visualchat.wendellcarvalho.com.br -connect visualchat.wendellcarvalho.com.br:443 2>/dev/null \
  | openssl x509 -noout -enddate | cut -d= -f2 | xargs -I{} python3 -c 'import sys,datetime as d;print((d.datetime.strptime(sys.argv[1],"%b %d %H:%M:%S %Y %Z")-d.datetime.utcnow()).days)' {})
check "certificado TLS com mais de 14 dias" 1 "$([ "$DIAS" -gt 14 ] && echo 1 || echo "$DIAS dias")"
check "testes dos KPIs" 0 "$(cd "$DIR/blip-bridge/painel" && node kpis.test.mjs >/dev/null 2>&1; echo $?)"
ERROS=$(sh "$DIR/scripts/logs.sh" blip_bridge 400 | grep -c ERRO)
check "ponte sem ERRO nas últimas 400 linhas" 0 "$ERROS"

[ $F -eq 0 ] && echo "Tudo certo." || { echo "$F verificação(ões) falharam."; exit 1; }
