#!/bin/sh
# Executa código Ruby (rails runner) no container chatwoot_rails via API do Portainer.
# uso: scripts/rails_runner.sh 'puts User.count'
T=$(cat ~/.secrets/portainer.token); P="http://localhost:9000/api/endpoints/1/docker"; H="X-API-Key: $T"
CID=$(curl -s -H "$H" "$P/containers/json?filters=%7B%22label%22%3A%5B%22com.docker.swarm.service.name%3Dchatwoot_rails%22%5D%7D" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["Id"])')
BODY=$(python3 -c 'import json,sys;print(json.dumps({"AttachStdout":True,"AttachStderr":True,"Cmd":["bundle","exec","rails","runner",sys.argv[1]]}))' "$1")
EID=$(curl -s -H "$H" -H "Content-Type: application/json" -d "$BODY" "$P/containers/$CID/exec" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Id"])')
curl -s -m300 -H "$H" -H "Content-Type: application/json" -d '{"Detach":false,"Tty":false}' "$P/exec/$EID/start" | tr -cd '[:print:]\n'
