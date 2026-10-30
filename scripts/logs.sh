#!/bin/sh
# uso: cw_logs.sh <servico: rails|sidekiq|postgres|redis> [linhas]  (somente leitura)
T=$(cat ~/.secrets/portainer.token)
curl -s -H "X-API-Key: $T" "http://localhost:9000/api/endpoints/1/docker/services/chatwoot_$1/logs?stdout=1&stderr=1&tail=${2:-40}" | python3 -c '
import sys
b=sys.stdin.buffer.read();o=[];i=0
while i+8<=len(b):
  n=int.from_bytes(b[i+4:i+8],"big");o.append(b[i+8:i+8+n]);i+=8+n
sys.stdout.write(b"".join(o).decode("utf-8","replace") if o else b.decode("utf-8","replace"))'
