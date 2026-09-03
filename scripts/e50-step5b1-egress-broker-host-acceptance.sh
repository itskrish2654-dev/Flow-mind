#!/usr/bin/env bash
set -euo pipefail

# Owner-only, real Linux production-candidate host acceptance. Codex must not run this.
: "${E50_EXPECTED_COMMIT:?Set E50_EXPECTED_COMMIT to the reviewed branch commit.}"

BROKER_NAME='crazyloops-piece-egress-broker'
BROKER_IMAGE='crazyloops/piece-egress-broker:step5b1'
SUPERVISOR_NAME='cl-piece-step5b1-broker-supervisor'
SUPERVISOR_IMAGE='crazyloops/piece-supervisor:step5b1-broker-acceptance'
SANDBOX_IMAGE='crazyloops/piece-runtime-hubspot:0.8.10-step5a'
CONTROL_VOLUME='crazyloops-piece-egress-control'
SUPERVISOR_CONTROL="$(mktemp -d /tmp/cl-e50-step5b1-supervisor.XXXXXX)"
ARTIFACT_DIR="$(mktemp -d /tmp/cl-e50-step5b1-evidence.XXXXXX)"
chmod 0755 "$ARTIFACT_DIR"
OWNER_LABEL='crazyloops.acceptance=e50-step5b1-egress-broker'
PROTECTED=(crazyloops-connector-runner activepieces-app activepieces-worker redis)
CANARY=''
CANARY_B64=''
EXECUTE_PID=''

fail() { printf 'STEP5B1 BROKER HOST ACCEPTANCE=FAIL: %s\n' "$*" >&2; exit 1; }

snapshot_protected() {
  local output="$1"
  : >"$output"
  for name in "${PROTECTED[@]}"; do
    docker inspect --format '{{.Name}}|{{.State.Running}}|{{.RestartCount}}' "$name" >>"$output" || fail "Protected service missing: $name"
  done
}

cleanup() {
  set +e
  [[ -n "$EXECUTE_PID" ]] && kill "$EXECUTE_PID" >/dev/null 2>&1
  docker rm -f "$SUPERVISOR_NAME" >/dev/null 2>&1
  docker rm -f "$BROKER_NAME" >/dev/null 2>&1
  docker ps -aq --filter "label=$OWNER_LABEL" | xargs -r docker rm -f >/dev/null 2>&1
  docker network ls -q --filter "label=$OWNER_LABEL" | xargs -r docker network rm >/dev/null 2>&1
  docker volume rm "$CONTROL_VOLUME" >/dev/null 2>&1
  docker image rm "$SUPERVISOR_IMAGE" "$BROKER_IMAGE" "$SANDBOX_IMAGE" >/dev/null 2>&1
  rm -rf -- "$SUPERVISOR_CONTROL" "$ARTIFACT_DIR"
  CANARY=''; CANARY_B64=''
}
trap cleanup EXIT INT TERM

[[ "$(git branch --show-current)" == 'codex/e50-egress-broker' ]] || fail 'Wrong branch.'
[[ "$(git rev-parse HEAD)" == "$E50_EXPECTED_COMMIT" ]] || fail 'Wrong commit.'
[[ -z "$(git status --porcelain)" ]] || fail 'Working tree is not clean.'
command -v docker >/dev/null || fail 'Docker is required.'
[[ -S /var/run/docker.sock ]] || fail 'Docker socket unavailable.'

snapshot_protected "$ARTIFACT_DIR/protected-before.txt"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:8788/v1/execute)" == '401' ]] || fail 'Runner unsigned check failed.'
[[ "$(docker exec redis redis-cli PING)" == 'PONG' ]] || fail 'Redis health failed.'

for name in "$BROKER_NAME" "$SUPERVISOR_NAME"; do ! docker inspect "$name" >/dev/null 2>&1 || fail "Reserved acceptance name exists: $name"; done
! docker volume inspect "$CONTROL_VOLUME" >/dev/null 2>&1 || fail 'Broker control volume already exists.'

docker build --no-cache --label "$OWNER_LABEL" -f services/piece-runtime/Dockerfile.egress-broker -t "$BROKER_IMAGE" services/piece-runtime >/dev/null
docker build --no-cache --label "$OWNER_LABEL" -f services/piece-runtime/Dockerfile.sandbox -t "$SANDBOX_IMAGE" services/piece-runtime >/dev/null
docker build --no-cache --label "$OWNER_LABEL" -f services/piece-runtime/Dockerfile.supervisor -t "$SUPERVISOR_IMAGE" services/piece-runtime >/dev/null
docker volume create --label "$OWNER_LABEL" "$CONTROL_VOLUME" >/dev/null
docker run --rm --user 0:0 --entrypoint sh --mount type=volume,src="$CONTROL_VOLUME",dst=/control "$BROKER_IMAGE" -c 'chown 65532:65532 /control && chmod 0700 /control' >/dev/null

docker run -d --name "$BROKER_NAME" --label 'crazyloops.runtime=piece-egress-broker-v1' --label 'crazyloops.resource=service' --label "$OWNER_LABEL" \
  --network bridge --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=4m --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=32 --memory=134217728 --memory-swap=134217728 --cpus=0.5 --ulimit=nofile=256:256 --user=65532:65532 \
  --mount type=volume,src="$CONTROL_VOLUME",dst=/run/crazyloops-egress-control "$BROKER_IMAGE" >/dev/null
BROKER_ID_BEFORE="$(docker inspect --format '{{.Id}}' "$BROKER_NAME")"

for _ in $(seq 1 100); do
  docker logs "$BROKER_NAME" 2>&1 | grep -Fq '"event":"piece_egress_broker_ready"' && break
  sleep 0.05
done
docker logs "$BROKER_NAME" 2>&1 | grep -Fq '"event":"piece_egress_broker_ready"' || fail 'Broker not ready.'

docker inspect "$BROKER_NAME" >"$ARTIFACT_DIR/broker-before.json"
node - "$ARTIFACT_DIR/broker-before.json" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[0];
const host = value.HostConfig;
if (value.Config.User !== '65532:65532') throw new Error('user');
if (value.Config.Labels?.['crazyloops.runtime'] !== 'piece-egress-broker-v1' || value.Config.Labels?.['crazyloops.resource'] !== 'service') throw new Error('labels');
if (host.NetworkMode !== 'default' && host.NetworkMode !== 'bridge') throw new Error('network');
if (!host.ReadonlyRootfs || host.Privileged || JSON.stringify(host.CapDrop) !== JSON.stringify(['ALL'])) throw new Error('privilege');
if (!(host.SecurityOpt ?? []).includes('no-new-privileges')) throw new Error('nnp');
if (host.PidsLimit !== 32 || host.Memory !== 134217728 || host.MemorySwap !== 134217728 || host.NanoCpus !== 500000000) throw new Error('limits');
if (Object.keys(host.PortBindings ?? {}).length || value.Config.ExposedPorts) throw new Error('published ports');
if ((value.Mounts ?? []).some((m) => m.Destination === '/var/run/docker.sock')) throw new Error('docker socket');
if ((value.Config.Env ?? []).some((v) => /token|secret|credential|password/i.test(v))) throw new Error('secret env');
if (Object.keys(value.NetworkSettings.Networks ?? {}).length !== 1 || !value.NetworkSettings.Networks.bridge) throw new Error('baseline networks');
NODE

DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
chmod 0750 "$SUPERVISOR_CONTROL"
docker run --rm --user 0:0 --entrypoint sh --mount type=bind,src="$SUPERVISOR_CONTROL",dst=/control "$SUPERVISOR_IMAGE" -c 'chown 65532:65532 /control && chmod 0750 /control' >/dev/null
docker run -d --name "$SUPERVISOR_NAME" --label 'crazyloops.runtime=piece-runtime-supervisor-v1' --label 'crazyloops.resource=supervisor' --label "$OWNER_LABEL" \
  --env PIECE_SUPERVISOR_CONTAINER_NAME="$SUPERVISOR_NAME" --env PIECE_EGRESS_BROKER_CONTAINER_NAME="$BROKER_NAME" \
  --env PIECE_EGRESS_BROKER_SOCKET_PATH=/run/crazyloops-egress-control/broker.sock \
  --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=4m --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=32 --memory=268435456 --memory-swap=268435456 --cpus=0.5 --ulimit=nofile=128:128 --user=65532:65532 --group-add "$DOCKER_GID" \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock --mount type=bind,src="$SUPERVISOR_CONTROL",dst=/run/crazyloops-piece \
  --mount type=volume,src="$CONTROL_VOLUME",dst=/run/crazyloops-egress-control "$SUPERVISOR_IMAGE" >/dev/null

for _ in $(seq 1 100); do [[ -S "$SUPERVISOR_CONTROL/piece-supervisor.sock" ]] && break; sleep 0.05; done
[[ -S "$SUPERVISOR_CONTROL/piece-supervisor.sock" ]] || fail 'Supervisor UDS missing.'

CANARY="E50_STEP5B1_BROKER_$(openssl rand -hex 32)"
CANARY_B64="$(printf '%s' "$CANARY" | base64 -w0)"
cat >"$ARTIFACT_DIR/request.json" <<JSON
{"protocolVersion":1,"request":{"protocolVersion":1,"requestId":"step5b1-broker-host","executionId":"step5b1-broker-host-execution","capabilityId":"hubspot.get_contact","capabilityVersion":1,"mode":"TEST","idempotencyKey":"step5b1-broker-host-idempotency","input":{"contactId":"synthetic-contact","properties":["firstname"]}},"credentialBase64":"$CANARY_B64"}
JSON

docker run --rm --name cl-piece-step5b1-broker-client --label "$OWNER_LABEL" --network none --user 65532:65532 \
  --mount type=bind,src="$SUPERVISOR_CONTROL",dst=/control --mount type=bind,src="$ARTIFACT_DIR",dst=/evidence,ro \
  --entrypoint node "$SUPERVISOR_IMAGE" - >"$ARTIFACT_DIR/response.json" 2>"$ARTIFACT_DIR/client.err" <<'NODE' &
const http = require('node:http'); const fs = require('node:fs');
const body = fs.readFileSync('/evidence/request.json', 'utf8');
const req = http.request({ socketPath: '/control/piece-supervisor.sock', path: '/v1/execute', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.pipe(process.stdout));
req.end(body);
NODE
EXECUTE_PID=$!

INVOCATION_ID="$(printf '%s' 'step5b1-broker-host' | sha256sum | cut -c1-16)"
SANDBOX_NAME="cl-piece-sandbox-$INVOCATION_ID"
INTERNAL_NAME="cl-piece-internal-$INVOCATION_ID"
for _ in $(seq 1 200); do docker inspect "$SANDBOX_NAME" >/dev/null 2>&1 && break; sleep 0.025; done
docker inspect "$SANDBOX_NAME" >/dev/null 2>&1 || fail 'Sandbox did not start after registration.'
docker pause "$SANDBOX_NAME" >/dev/null
docker inspect "$SANDBOX_NAME" >"$ARTIFACT_DIR/sandbox-live.json"
docker inspect "$BROKER_NAME" >"$ARTIFACT_DIR/broker-live.json"
node - "$ARTIFACT_DIR/sandbox-live.json" "$ARTIFACT_DIR/broker-live.json" "$INTERNAL_NAME" <<'NODE'
const fs = require('node:fs'); const sandbox = JSON.parse(fs.readFileSync(process.argv[2]))[0]; const broker = JSON.parse(fs.readFileSync(process.argv[3]))[0]; const network = process.argv[4];
const sandboxNetworks = Object.keys(sandbox.NetworkSettings.Networks ?? {}); if (sandboxNetworks.length !== 1 || sandboxNetworks[0] !== network) throw new Error('sandbox topology');
if (!broker.NetworkSettings.Networks?.bridge || !broker.NetworkSettings.Networks?.[network]) throw new Error('broker topology');
const brokerIp = broker.NetworkSettings.Networks[network].IPAddress; if (!sandbox.HostConfig.ExtraHosts.includes(`api.hubapi.com:${brokerIp}`)) throw new Error('host mapping');
NODE
[[ -z "$(docker ps -aq --filter 'name=cl-piece-gateway-')" ]] || fail 'Per-invocation gateway exists.'
[[ -z "$(docker network ls -q --filter 'name=cl-piece-egress-')" ]] || fail 'Per-invocation egress network exists.'
docker unpause "$SANDBOX_NAME" >/dev/null
wait "$EXECUTE_PID" || fail 'Supervisor request failed.'
EXECUTE_PID=''

node - "$ARTIFACT_DIR/response.json" <<'NODE'
const fs = require('node:fs'); const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value.ok !== false || value.errorCode !== 'PIECE_AUTH_FAILED' || value.retryable !== false) throw new Error('provider result');
NODE

for _ in $(seq 1 200); do ! docker inspect "$SANDBOX_NAME" >/dev/null 2>&1 && ! docker network inspect "$INTERNAL_NAME" >/dev/null 2>&1 && break; sleep 0.025; done
! docker inspect "$SANDBOX_NAME" >/dev/null 2>&1 || fail 'Sandbox remained.'
! docker network inspect "$INTERNAL_NAME" >/dev/null 2>&1 || fail 'Internal network remained.'
[[ "$(docker inspect --format '{{.Id}}' "$BROKER_NAME")" == "$BROKER_ID_BEFORE" ]] || fail 'Broker identity changed.'
[[ "$(docker inspect --format '{{.State.Running}}|{{.RestartCount}}' "$BROKER_NAME")" == 'true|0' ]] || fail 'Broker not healthy after invocation.'
[[ "$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$BROKER_NAME")" != *"$INTERNAL_NAME"* ]] || fail 'Broker remained attached.'

docker logs "$BROKER_NAME" >"$ARTIFACT_DIR/broker.log" 2>&1
grep -Fq '"event":"piece_egress_broker_policy_registered"' "$ARTIFACT_DIR/broker.log" || fail 'Registration evidence missing.'
grep -Fq '"classification":"SAFE"' "$ARTIFACT_DIR/broker.log" || fail 'Safe DNS evidence missing.'
grep -Fq '"event":"piece_egress_broker_policy_revoked"' "$ARTIFACT_DIR/broker.log" || fail 'Revocation evidence missing.'
grep -Fq '"event":"piece_egress_broker_connection"' "$ARTIFACT_DIR/broker.log" || fail 'Broker connection evidence missing.'
grep -Fq '"hostname":"api.hubapi.com"' "$ARTIFACT_DIR/broker.log" || fail 'Exact SNI evidence missing.'
grep -Fq '"upstreamConnections":1' "$ARTIFACT_DIR/broker.log" || fail 'Exactly one provider connection not proven.'
for surface in "$ARTIFACT_DIR"/*; do
  grep -Fq "$CANARY" "$surface" && fail 'Credential plaintext leaked.'
  grep -Fq "$CANARY_B64" "$surface" && [[ "$surface" != *request.json ]] && fail 'Credential encoding leaked.'
  grep -Fq '"pinnedAddress"' "$surface" && fail 'Pinned provider address leaked.'
done

snapshot_protected "$ARTIFACT_DIR/protected-after.txt"
cmp -s "$ARTIFACT_DIR/protected-before.txt" "$ARTIFACT_DIR/protected-after.txt" || fail 'Protected services changed.'
printf '%s\n' \
  'SOURCE_GATE=PASS' 'BROKER_HARDENING=PASS' 'BROKER_PERSISTENCE=PASS' 'REGISTER_BEFORE_SANDBOX=PASS' \
  'TOPOLOGY=PASS' 'PROVIDER_NUMERIC_401=PASS' 'CREDENTIAL_CROSSOVER=0' 'PROTECTED_SERVICES_UNCHANGED=PASS' \
  'STEP5B1 LONG-LIVED EGRESS BROKER HOST ACCEPTANCE=PASS'
