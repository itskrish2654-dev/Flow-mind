#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL='crazyloops.runtime=piece-runtime-step5a-acceptance'
PREFIX='cl-piece-step5a-accept-'
SANDBOX_IMAGE='crazyloops/piece-runtime-hubspot:0.8.10-step5a'
GATEWAY_IMAGE='crazyloops/piece-runtime-gateway:step5a'
NETWORK="${PREFIX}internal"
SANDBOX="${PREFIX}sandbox"
GATEWAY="${PREFIX}gateway"
OUTPUT_FILE="$(mktemp)"
SURFACE_FILE="$(mktemp)"
CANARY=''

cleanup() {
  docker rm -f "$SANDBOX" "$GATEWAY" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -f "$OUTPUT_FILE" "$SURFACE_FILE"
}
trap cleanup EXIT INT TERM

if [[ "${E50_ACCEPT_STEP5A:-}" != 'YES' ]]; then
  echo 'Set E50_ACCEPT_STEP5A=YES after reviewing this script.' >&2
  exit 2
fi
if [[ ! "${E50_EXPECTED_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'E50_EXPECTED_COMMIT must be the reviewed Step 5A commit.' >&2
  exit 2
fi
cd "$ROOT"
[[ "$(git branch --show-current)" == 'codex/e50-piece-runtime' ]]
[[ "$(git rev-parse HEAD)" == "$E50_EXPECTED_COMMIT" ]]
[[ -z "$(git status --porcelain)" ]]
git merge-base --is-ancestor 07b236ca99b5044600fe2c9b3e9ac5966397b2d4 HEAD
docker version >/dev/null

docker build --pull=false --label "$LABEL" -t "$SANDBOX_IMAGE" -f services/piece-runtime/Dockerfile.sandbox services/piece-runtime
docker build --pull=false --label "$LABEL" -t "$GATEWAY_IMAGE" -f services/piece-runtime/Dockerfile.gateway services/piece-runtime
docker network create --internal --label "$LABEL" "$NETWORK" >/dev/null

docker run -d --name "$GATEWAY" --label "$LABEL" --network "$NETWORK" \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1m \
  --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=16 \
  --memory=67108864 --memory-swap=67108864 --cpus=0.25 --ulimit nofile=64:64 \
  --user=65532:65532 --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  -e PIECE_RUNTIME_CAPABILITY_ID=hubspot.get_contact \
  -e PIECE_RUNTIME_CAPABILITY_VERSION=1 \
  -e PIECE_RUNTIME_REQUEST_ID=host-acceptance \
  "$GATEWAY_IMAGE" >/dev/null

docker create -i --name "$SANDBOX" --label "$LABEL" --network "$NETWORK" \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=4m \
  --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=16 \
  --memory=134217728 --memory-swap=134217728 --cpus=0.5 --ulimit nofile=64:64 \
  --user=65532:65532 --log-driver=none "$SANDBOX_IMAGE" >/dev/null

CANARY="E50_STEP5A_HOST_$(openssl rand -hex 32)"
CREDENTIAL_B64="$(printf '%s' "$CANARY" | base64 -w0)"
BODY="$(printf '{"request":{"protocolVersion":1,"requestId":"host-acceptance","executionId":"host-acceptance","capabilityId":"unsupported.fixture","capabilityVersion":1,"mode":"TEST","idempotencyKey":"host-acceptance","input":{}},"credentialBase64":"%s"}' "$CREDENTIAL_B64")"
printf '%s' "$BODY" | docker start -a -i "$SANDBOX" >"$OUTPUT_FILE"
grep -q '"errorCode":"PIECE_UNSUPPORTED_CAPABILITY"' "$OUTPUT_FILE"

docker inspect "$SANDBOX" "$GATEWAY" >"$SURFACE_FILE"
docker image inspect "$SANDBOX_IMAGE" "$GATEWAY_IMAGE" >>"$SURFACE_FILE"
docker history --no-trunc "$SANDBOX_IMAGE" >>"$SURFACE_FILE"
docker history --no-trunc "$GATEWAY_IMAGE" >>"$SURFACE_FILE"
docker logs "$GATEWAY" >>"$SURFACE_FILE" 2>&1 || true
cat "$OUTPUT_FILE" >>"$SURFACE_FILE"
if grep -Fq "$CANARY" "$SURFACE_FILE"; then
  echo 'Credential canary found on an inspected surface.' >&2
  exit 1
fi

node - "$SURFACE_FILE" <<'NODE'
const fs = require('node:fs');
const text = fs.readFileSync(process.argv[2], 'utf8');
for (const required of ['"ReadonlyRootfs": true', '"PidsLimit": 16', 'no-new-privileges', '"User": "65532:65532"']) {
  if (!text.includes(required)) throw new Error(`Missing control: ${required}`);
}
if (/docker\.sock|"Privileged": true/.test(text)) throw new Error('Unsafe container configuration detected.');
NODE

echo 'STEP 5A HOST PREPARATION: PASS'
echo 'PROVIDER EXECUTION: NOT PERFORMED'
echo 'LONG-LIVED SUPERVISOR: NOT ACCEPTED'
