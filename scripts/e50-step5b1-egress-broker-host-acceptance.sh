#!/usr/bin/env bash
set -euo pipefail
umask 077

# Owner-only, real Linux production-candidate host acceptance. Codex must not run this.
: "${E50_EXPECTED_COMMIT:?Set E50_EXPECTED_COMMIT to the reviewed branch commit.}"

EXPECTED_ORIGIN_MAIN='20c23d7e85123eaa77a916ce43f4a9ef5ca8a5e7'
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
BROKER_NAME='crazyloops-piece-egress-broker'
BROKER_IMAGE='crazyloops/piece-egress-broker:step5b1'
SUPERVISOR_NAME='cl-piece-step5b1-broker-supervisor'
SUPERVISOR_IMAGE='crazyloops/piece-supervisor:step5b1-broker-acceptance'
SUPERVISOR_HEALTH_NAME='cl-piece-step5b1-broker-health'
CONTROL_RESTORE_NAME='cl-piece-step5b1-broker-control-restore'
SANDBOX_IMAGE='crazyloops/piece-runtime-hubspot:0.8.10-step5a'
CONTROL_VOLUME='crazyloops-piece-egress-control'
SUPERVISOR_CONTROL="$(mktemp -d /tmp/cl-e50-step5b1-supervisor.XXXXXX)"
ARTIFACT_DIR="$(mktemp -d /tmp/cl-e50-step5b1-evidence.XXXXXX)"
chmod 0755 "$ARTIFACT_DIR"
OWNER_LABEL='crazyloops.acceptance=e50-step5b1-egress-broker'
PROTECTED=(crazyloops-connector-runner activepieces-app activepieces-worker-1 redis)
CANARY=''
CANARY_B64=''
EXECUTE_PID=''
REQUEST_ID='step5b1-broker-host'
INVOCATION_ID=''
SANDBOX_NAME=''
INTERNAL_NAME=''

fail() { printf 'STEP5B1 BROKER HOST ACCEPTANCE=FAIL: %s\n' "$*" >&2; exit 1; }

snapshot_protected() {
  local output="$1"
  : >"$output"
  for name in "${PROTECTED[@]}"; do
    docker inspect --format '{{.Name}}|{{.State.Running}}|{{.RestartCount}}' "$name" >>"$output" || fail "Protected service missing: $name"
  done
}

capture_failure_diagnostics() {
  docker logs "$BROKER_NAME" >"$ARTIFACT_DIR/broker.log" 2>/dev/null || true
  docker inspect --format '{{.State.Running}}|{{.RestartCount}}' "$BROKER_NAME" >"$ARTIFACT_DIR/failure-broker-state.txt" 2>/dev/null || printf 'ABSENT\n' >"$ARTIFACT_DIR/failure-broker-state.txt"
  docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$BROKER_NAME" >"$ARTIFACT_DIR/failure-broker-networks.txt" 2>/dev/null || printf 'ABSENT\n' >"$ARTIFACT_DIR/failure-broker-networks.txt"
  if [[ -n "$SANDBOX_NAME" ]] && docker inspect "$SANDBOX_NAME" >/dev/null 2>&1; then printf 'YES\n' >"$ARTIFACT_DIR/failure-sandbox-present.txt"; else printf 'NO\n' >"$ARTIFACT_DIR/failure-sandbox-present.txt"; fi
  if [[ -n "$INTERNAL_NAME" ]] && docker network inspect "$INTERNAL_NAME" >/dev/null 2>&1; then printf 'YES\n' >"$ARTIFACT_DIR/failure-network-present.txt"; else printf 'NO\n' >"$ARTIFACT_DIR/failure-network-present.txt"; fi
  node - "$ARTIFACT_DIR" "$INVOCATION_ID" "$REQUEST_ID" >"$ARTIFACT_DIR/failure-summary.txt" 2>/dev/null <<'NODE' || true
const fs = require('node:fs'); const path = require('node:path');
const directory = process.argv[2]; const invocationId = process.argv[3]; const requestId = process.argv[4];
const read = (name, fallback) => { try { return fs.readFileSync(path.join(directory, name), 'utf8').trim() || fallback; } catch { return fallback; } };
const lines = read('broker.log', '').split(/\r?\n/).filter(Boolean); const events = [];
for (const line of lines.slice(-500)) { try { const value = JSON.parse(line); if (value && typeof value === 'object' && !Array.isArray(value)) events.push(value); } catch {} }
const exact = (event) => event.invocationId === invocationId && event.requestId === requestId && event.capabilityId === 'hubspot.get_contact';
const registrations = events.filter((event) => event.event === 'piece_egress_broker_policy_registered' && exact(event));
const safeRegistrations = registrations.filter((event) => Array.isArray(event.destinations) && event.destinations.some((destination) =>
  destination?.hostname === 'api.hubapi.com' && destination?.port === 443 && Array.isArray(destination.evidence) && destination.evidence.length > 0 &&
  destination.evidence.every((item) => item?.classification === 'SAFE' && (item.family === 4 || item.family === 6) && Number.isInteger(item.ttl))));
const connections = events.filter((event) => event.event === 'piece_egress_broker_connection' && exact(event) && event.hostname === 'api.hubapi.com' && event.port === 443);
const outcomes = ['PIECE_BROKER_SUCCEEDED', 'PIECE_EGRESS_DENIED', 'PIECE_PROVIDER_UNAVAILABLE', 'PIECE_RESPONSE_INVALID', 'PIECE_TIMEOUT'];
const allowedErrors = new Set(['PIECE_AUTH_FAILED', 'PIECE_RATE_LIMITED', 'PIECE_PROVIDER_UNAVAILABLE', 'PIECE_TIMEOUT', 'PIECE_EGRESS_DENIED', 'PIECE_RESPONSE_INVALID', 'PIECE_RUNTIME_FAILED', 'PIECE_INVALID_INPUT', 'PIECE_OUTPUT_LIMIT']);
let providerError = 'UNAVAILABLE';
try { const response = JSON.parse(read('response.json', '{}')); providerError = allowedErrors.has(response?.errorCode) ? response.errorCode : 'UNKNOWN'; } catch { providerError = 'INVALID'; }
console.log(`BROKER_RUNNING_RESTART=${read('failure-broker-state.txt', 'UNKNOWN')}`);
console.log(`BROKER_NETWORKS=${read('failure-broker-networks.txt', 'UNKNOWN')}`);
console.log(`SANDBOX_PRESENT=${read('failure-sandbox-present.txt', 'UNKNOWN')}`);
console.log(`INTERNAL_NETWORK_PRESENT=${read('failure-network-present.txt', 'UNKNOWN')}`);
console.log(`REGISTRATION_EVENT_COUNT=${registrations.length}`);
console.log(`SAFE_REGISTRATION_COUNT=${safeRegistrations.length}`);
console.log(`CONNECTION_EVENT_COUNT=${connections.length}`);
for (const outcome of outcomes) console.log(`CONNECTION_${outcome}=${connections.filter((event) => event.outcome === outcome).length}`);
console.log(`PROVIDER_RESPONSE_ERROR_CODE=${providerError}`);
NODE
}

sanitize_failure_evidence() {
  if [[ -f "$ARTIFACT_DIR/request.json" ]]; then
    shred -u -z -- "$ARTIFACT_DIR/request.json" 2>/dev/null || { : >"$ARTIFACT_DIR/request.json"; rm -f -- "$ARTIFACT_DIR/request.json"; }
  fi
  local surface
  while IFS= read -r -d '' surface; do
    if { [[ -n "$CANARY" ]] && grep -Fq -- "$CANARY" "$surface"; } || { [[ -n "$CANARY_B64" ]] && grep -Fq -- "$CANARY_B64" "$surface"; }; then
      rm -f -- "$surface"
    fi
  done < <(find "$ARTIFACT_DIR" -type f -print0)
  CANARY=''
  CANARY_B64=''
}

restore_supervisor_control_ownership() {
  [[ -d "$SUPERVISOR_CONTROL" ]] || return 0
  [[ "$(stat -c '%u:%g' "$SUPERVISOR_CONTROL" 2>/dev/null)" == "$HOST_UID:$HOST_GID" ]] && return 0
  docker rm -f "$CONTROL_RESTORE_NAME" >/dev/null 2>&1 || true
  if ! timeout 15 docker run --rm --name "$CONTROL_RESTORE_NAME" --label "$OWNER_LABEL" \
    --network none --read-only --cap-drop=ALL --cap-add=CHOWN --security-opt=no-new-privileges \
    --pids-limit=8 --memory=33554432 --memory-swap=33554432 --cpus=0.1 --user=0:0 \
    --mount type=bind,src="$SUPERVISOR_CONTROL",dst=/control \
    --entrypoint /usr/bin/chown "$SUPERVISOR_IMAGE" "$HOST_UID:$HOST_GID" /control >/dev/null; then
    return 1
  fi
  [[ "$(stat -c '%u:%g' "$SUPERVISOR_CONTROL" 2>/dev/null)" == "$HOST_UID:$HOST_GID" ]]
}

cleanup() {
  local status="$1"
  local control_restored=1
  trap - EXIT INT TERM
  set +e
  if (( status != 0 )); then capture_failure_diagnostics; fi
  [[ -n "$EXECUTE_PID" ]] && kill "$EXECUTE_PID" >/dev/null 2>&1
  docker rm -f "$SUPERVISOR_NAME" >/dev/null 2>&1
  docker rm -f "$BROKER_NAME" >/dev/null 2>&1
  docker ps -aq --filter "label=$OWNER_LABEL" | xargs -r docker rm -f >/dev/null 2>&1
  docker network ls -q --filter "label=$OWNER_LABEL" | xargs -r docker network rm >/dev/null 2>&1
  docker volume rm "$CONTROL_VOLUME" >/dev/null 2>&1
  if ! restore_supervisor_control_ownership; then
    control_restored=0
    status=1
    printf 'STEP5B1 cleanup could not restore supervisor control directory ownership.\n' >&2
  fi
  if (( control_restored == 1 )); then rm -rf -- "$SUPERVISOR_CONTROL"; fi
  docker image rm "$SUPERVISOR_IMAGE" "$BROKER_IMAGE" "$SANDBOX_IMAGE" >/dev/null 2>&1
  sanitize_failure_evidence
  if (( status == 0 )); then
    rm -rf -- "$ARTIFACT_DIR"
  else
    chmod 0700 "$ARTIFACT_DIR"
    [[ -f "$ARTIFACT_DIR/failure-summary.txt" ]] && cat "$ARTIFACT_DIR/failure-summary.txt" >&2
    printf 'EVIDENCE_DIR=%s\n' "$ARTIFACT_DIR" >&2
  fi
  exit "$status"
}

preflight_cleanup() {
  local status="$1"
  trap - EXIT INT TERM
  rm -rf -- "$SUPERVISOR_CONTROL" "$ARTIFACT_DIR"
  exit "$status"
}

trap 'preflight_cleanup $?' EXIT
trap 'exit 130' INT TERM

git fetch origin main codex/e50-egress-broker
[[ "$(git rev-parse origin/main)" == "$EXPECTED_ORIGIN_MAIN" ]] || fail 'origin/main changed.'
[[ "$(git rev-parse origin/codex/e50-egress-broker)" == "$E50_EXPECTED_COMMIT" ]] || fail 'Remote acceptance branch differs.'
[[ "$(git branch --show-current)" == 'codex/e50-egress-broker' ]] || fail 'Wrong branch.'
[[ "$(git rev-parse HEAD)" == "$E50_EXPECTED_COMMIT" ]] || fail 'Wrong commit.'
[[ -z "$(git status --porcelain)" ]] || fail 'Working tree is not clean.'
command -v docker >/dev/null || fail 'Docker is required.'
[[ -S /var/run/docker.sock ]] || fail 'Docker socket unavailable.'

snapshot_protected "$ARTIFACT_DIR/protected-before.txt"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:8788/v1/execute)" == '401' ]] || fail 'Runner unsigned check failed.'
[[ "$(docker exec redis redis-cli PING)" == 'PONG' ]] || fail 'Redis health failed.'

for name in "$BROKER_NAME" "$SUPERVISOR_NAME" "$SUPERVISOR_HEALTH_NAME" "$CONTROL_RESTORE_NAME"; do ! docker inspect "$name" >/dev/null 2>&1 || fail "Reserved acceptance name exists: $name"; done
! docker volume inspect "$CONTROL_VOLUME" >/dev/null 2>&1 || fail 'Broker control volume already exists.'

trap - EXIT
trap 'cleanup $?' EXIT

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

SUPERVISOR_ID_BEFORE="$(docker inspect --format '{{.Id}}' "$SUPERVISOR_NAME")"
SUPERVISOR_SOCKET_READY=0
for _ in $(seq 1 100); do
  if docker exec "$SUPERVISOR_NAME" node -e 'const fs=require("node:fs");if(!fs.lstatSync("/run/crazyloops-piece/piece-supervisor.sock").isSocket())process.exit(1)' >/dev/null 2>&1; then
    SUPERVISOR_SOCKET_READY=1
    break
  fi
  sleep 0.05
done
[[ "$SUPERVISOR_SOCKET_READY" == '1' ]] || fail 'Supervisor UDS missing internally.'
[[ "$(docker inspect --format '{{.Id}}' "$SUPERVISOR_NAME")" == "$SUPERVISOR_ID_BEFORE" ]] || fail 'Supervisor identity changed during startup.'
[[ "$(docker inspect --format '{{.State.Running}}|{{.RestartCount}}' "$SUPERVISOR_NAME")" == 'true|0' ]] || fail 'Supervisor startup state invalid.'
printf 'SUPERVISOR_UDS_INTERNAL=PASS\n'

SUPERVISOR_HEALTH="$(
  timeout 10 docker run --rm -i --name "$SUPERVISOR_HEALTH_NAME" --label "$OWNER_LABEL" \
    --network none --read-only --cap-drop=ALL --security-opt=no-new-privileges \
    --pids-limit=16 --memory=67108864 --memory-swap=67108864 --cpus=0.25 --user=65532:65532 \
    --mount type=bind,src="$SUPERVISOR_CONTROL",dst=/control,readonly \
    --entrypoint node "$SUPERVISOR_IMAGE" - <<'NODE'
const http = require('node:http');
const chunks = [];
let bytes = 0;
let settled = false;
const finish = (error) => {
  if (settled) return;
  settled = true;
  if (error) process.exitCode = 1;
};
const request = http.request({ socketPath: '/control/piece-supervisor.sock', path: '/v1/health', method: 'GET', headers: { connection: 'close' } }, (response) => {
  if (response.statusCode !== 200) { response.resume(); finish(new Error('status')); return; }
  response.on('data', (value) => {
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    if (bytes > 4096) { response.destroy(); finish(new Error('output_limit')); return; }
    chunks.push(chunk);
  });
  response.once('error', () => finish(new Error('response')));
  response.once('end', () => {
    if (settled) return;
    process.stdout.write(Buffer.concat(chunks, bytes));
    finish();
  });
});
request.setTimeout(3000, () => request.destroy(new Error('timeout')));
request.once('error', () => finish(new Error('request')));
request.end();
NODE
)" || fail 'Supervisor UDS health client failed.'
node -e 'const value=JSON.parse(process.argv[1]);const keys=Object.keys(value).sort().join(",");if(keys!=="activeInvocations,concurrencyLimit,ok,protocolVersion,status"||value.ok!==true||value.protocolVersion!==1||value.status!=="ready"||value.activeInvocations!==0||value.concurrencyLimit!==2)process.exit(1)' "$SUPERVISOR_HEALTH" || fail 'Supervisor UDS health response invalid.'
printf 'SUPERVISOR_UDS_HEALTH=PASS\n'

CANARY="E50_STEP5B1_BROKER_$(openssl rand -hex 32)"
CANARY_B64="$(printf '%s' "$CANARY" | base64 -w0)"
cat >"$ARTIFACT_DIR/request.json" <<JSON
{"protocolVersion":1,"request":{"protocolVersion":1,"requestId":"step5b1-broker-host","executionId":"step5b1-broker-host-execution","capabilityId":"hubspot.get_contact","capabilityVersion":1,"mode":"TEST","idempotencyKey":"step5b1-broker-host-idempotency","input":{"contactId":"synthetic-contact","properties":["firstname"]}},"credentialBase64":"$CANARY_B64"}
JSON
chmod 0600 "$ARTIFACT_DIR/request.json"
[[ "$(stat -c '%a' "$ARTIFACT_DIR/request.json")" == '600' ]] || fail 'Request file mode invalid.'
[[ "$(stat -c '%u:%g' "$ARTIFACT_DIR/request.json")" == "$HOST_UID:$HOST_GID" ]] || fail 'Request file owner invalid.'
printf '%s\n' 'REQUEST_FILE_MODE=0600' 'REQUEST_FILE_OWNER=HOST'

docker run --rm -i --name cl-piece-step5b1-broker-client --label "$OWNER_LABEL" --network none --user 65532:65532 \
  --mount type=bind,src="$SUPERVISOR_CONTROL",dst=/control \
  --entrypoint node "$SUPERVISOR_IMAGE" \
  -e 'const http=require("node:http");const req=http.request({socketPath:"/control/piece-supervisor.sock",path:"/v1/execute",method:"POST",headers:{"content-type":"application/json"}},(res)=>res.pipe(process.stdout));req.once("error",()=>process.exit(1));process.stdin.pipe(req);' \
  <"$ARTIFACT_DIR/request.json" >"$ARTIFACT_DIR/response.json" 2>"$ARTIFACT_DIR/client.err" &
EXECUTE_PID=$!

INVOCATION_ID="$(printf '%s' 'step5b1-broker-host' | sha256sum | cut -c1-16)"
SANDBOX_NAME="cl-piece-sandbox-$INVOCATION_ID"
INTERNAL_NAME="cl-piece-internal-$INVOCATION_ID"
SANDBOX_STARTED=0
for _ in $(seq 1 200); do
  if docker inspect "$SANDBOX_NAME" >/dev/null 2>&1; then
    SANDBOX_STARTED=1
    break
  fi
  if ! kill -0 "$EXECUTE_PID" >/dev/null 2>&1; then
    wait "$EXECUTE_PID" >/dev/null 2>&1 || true
    EXECUTE_PID=''
    fail 'Supervisor execute client exited before sandbox creation.'
  fi
  sleep 0.025
done
if [[ "$SANDBOX_STARTED" != '1' ]]; then
  if ! kill -0 "$EXECUTE_PID" >/dev/null 2>&1; then
    wait "$EXECUTE_PID" >/dev/null 2>&1 || true
    EXECUTE_PID=''
    fail 'Supervisor execute client exited before sandbox creation.'
  fi
  fail 'Sandbox did not start within bounded wait.'
fi
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
docker logs "$BROKER_NAME" >"$ARTIFACT_DIR/broker-before-sandbox-unpause.log" 2>&1
node - "$ARTIFACT_DIR/broker-before-sandbox-unpause.log" "$INVOCATION_ID" "$REQUEST_ID" <<'NODE'
const fs = require('node:fs'); const [path, invocationId, requestId] = process.argv.slice(2);
const events = [];
for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) { try { const value = JSON.parse(line); if (value && typeof value === 'object' && !Array.isArray(value)) events.push(value); } catch {} }
const matches = events.filter((event) => event.event === 'piece_egress_broker_policy_registered' && event.invocationId === invocationId &&
  event.requestId === requestId && event.capabilityId === 'hubspot.get_contact');
if (matches.length !== 1) throw new Error('exact registration event');
const destinations = matches[0].destinations;
if (!Array.isArray(destinations) || destinations.length !== 1) throw new Error('destinations');
const destination = destinations[0];
if (destination?.hostname !== 'api.hubapi.com' || destination?.port !== 443 || !Array.isArray(destination.evidence) || destination.evidence.length < 1) throw new Error('reviewed destination');
if (!destination.evidence.every((item) => item?.classification === 'SAFE' && (item.family === 4 || item.family === 6) && Number.isInteger(item.ttl))) throw new Error('safe evidence');
if (JSON.stringify(matches[0]).includes('pinnedAddress')) throw new Error('pinned provider address exposed');
NODE
printf 'REGISTER_BEFORE_SANDBOX=PASS\n'
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
node - "$ARTIFACT_DIR/broker.log" "$INVOCATION_ID" "$REQUEST_ID" <<'NODE'
const fs = require('node:fs'); const [path, invocationId, requestId] = process.argv.slice(2); const events = [];
for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) { try { const value = JSON.parse(line); if (value && typeof value === 'object' && !Array.isArray(value)) events.push(value); } catch {} }
const exact = (event) => event.invocationId === invocationId && event.requestId === requestId && event.capabilityId === 'hubspot.get_contact';
const connections = events.filter((event) => event.event === 'piece_egress_broker_connection' && exact(event) &&
  event.hostname === 'api.hubapi.com' && event.port === 443 && event.upstreamConnections === 1 && event.outcome === 'PIECE_BROKER_SUCCEEDED');
if (connections.length !== 1) throw new Error('exact broker connection evidence');
if (events.filter((event) => event.event === 'piece_egress_broker_policy_revoked' && exact(event)).length !== 1) throw new Error('exact revocation evidence');
NODE
printf 'CONNECTION_EVENT_JSON_PROOF=PASS\n'
for surface in "$ARTIFACT_DIR"/*; do
  grep -Fq "$CANARY" "$surface" && fail 'Credential plaintext leaked.'
  grep -Fq "$CANARY_B64" "$surface" && [[ "$surface" != *request.json ]] && fail 'Credential encoding leaked.'
  grep -Fq '"pinnedAddress"' "$surface" && fail 'Pinned provider address leaked.'
done

snapshot_protected "$ARTIFACT_DIR/protected-after.txt"
cmp -s "$ARTIFACT_DIR/protected-before.txt" "$ARTIFACT_DIR/protected-after.txt" || fail 'Protected services changed.'
printf '%s\n' \
  'SOURCE_GATE=PASS' 'BROKER_HARDENING=PASS' 'BROKER_PERSISTENCE=PASS' \
  'TOPOLOGY=PASS' 'PROVIDER_NUMERIC_401=PASS' 'CREDENTIAL_CROSSOVER=0' 'PROTECTED_SERVICES_UNCHANGED=PASS' \
  'STEP5B1 LONG-LIVED EGRESS BROKER HOST ACCEPTANCE=PASS'
