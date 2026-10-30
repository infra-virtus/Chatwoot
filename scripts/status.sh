#!/bin/sh
# status das tasks do stack chatwoot (somente leitura)
T=$(cat ~/.secrets/portainer.token)
curl -s -H "X-API-Key: $T" 'http://localhost:9000/api/endpoints/1/docker/tasks?filters=%7B%22label%22%3A%5B%22com.docker.stack.namespace%3Dchatwoot%22%5D%7D' | python3 -c '
import sys,json
for t in sorted(json.load(sys.stdin),key=lambda t:t["CreatedAt"])[-12:]:
  print(t["Spec"]["ContainerSpec"]["Image"].split("@")[0][:32].ljust(32),t["Status"]["State"].ljust(10),t["DesiredState"].ljust(8),t["Status"].get("Err",""),t["Status"].get("Message",""))'
