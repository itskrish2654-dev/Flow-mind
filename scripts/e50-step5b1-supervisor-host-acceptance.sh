#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACCEPTED_STEP5A='353b2c4821b1b959aeb7f485beade3a5eaf219fd'
EXPECTED_ORIGIN_MAIN='20c23d7e85123eaa77a916ce43f4a9ef5ca8a5e7'
OWNER_LABEL='crazyloops.runtime=piece-runtime-supervisor-v1'
RESOURCE_LABEL='crazyloops.resource=invocation'
SUPERVISOR_RESOURCE_LABEL='crazyloops.resource=supervisor'
SUPERVISOR_NAME='cl-piece-step5b1-supervisor'
SUPERVISOR_IMAGE='crazyloops/piece-runtime-supervisor:step5b1'
SANDBOX_IMAGE='crazyloops/piece-runtime-hubspot:0.8.10-step5a'
GATEWAY_IMAGE='crazyloops/piece-runtime-gateway:step5a'
CONTROL_DIR="$(mktemp -d)"
ARTIFACT_DIR="$(mktemp -d)"
SOCKET="$CONTROL_DIR/piece-supervisor.sock"
PROTECTED=(crazyloops-connector-runner activepieces-app activepieces-worker-1 redis)
PROTECTED_BEFORE="$ARTIFACT_DIR/protected-before.txt"
PROTECTED_AFTER="$ARTIFACT_DIR/protected-after.txt"
UNRELATED_NETWORK='cl-piece-step5b1-unrelated'
CANARY=''
CANARY_B64=''

fail() {
  echo "STEP5B1 HOST ACCEPTANCE FAILED: $*" >&2
  exit 1
}

cleanup() {
  docker rm -f "$SUPERVISOR_NAME" >/dev/null 2>&1 || true
  mapfile -t owned_containers < <(docker ps -aq --filter "label=$OWNER_LABEL" --filter "label=$RESOURCE_LABEL" 2>/dev/null || true)
  if ((${#owned_containers[@]})); then docker rm -f "${owned_containers[@]}" >/dev/null 2>&1 || true; fi
  mapfile -t owned_networks < <(docker network ls -q --filter "label=$OWNER_LABEL" --filter "label=$RESOURCE_LABEL" 2>/dev/null || true)
  if ((${#owned_networks[@]})); then docker network rm "${owned_networks[@]}" >/dev/null 2>&1 || true; fi
  docker network rm "$UNRELATED_NETWORK" >/dev/null 2>&1 || true
  docker image rm -f "$SUPERVISOR_IMAGE" "$GATEWAY_IMAGE" "$SANDBOX_IMAGE" >/dev/null 2>&1 || true
  rm -rf -- "$CONTROL_DIR" "$ARTIFACT_DIR"
}
trap cleanup EXIT INT TERM

snapshot_protected() {
  local output="$1"
  : >"$output"
  for name in "${PROTECTED[@]}"; do
    docker inspect --format '{{.Name}}|{{.Id}}|{{.RestartCount}}|{{.State.Status}}|{{json .NetworkSettings.Networks}}|{{json .NetworkSettings.Ports}}|{{json .Mounts}}' "$name" >>"$output"
  done
}

health() {
  curl --silent --show-error --max-time 3 --unix-socket "$SOCKET" http://localhost/v1/health
}

execute_file() {
  local input="$1"
  local output="$2"
  curl --silent --show-error --max-time 15 --unix-socket "$SOCKET" \
    --request POST --header 'Content-Type: application/json' --data-binary "@$input" \
    http://localhost/v1/execute >"$output"
}

count_invocation_containers() {
  docker ps -aq --filter "label=$OWNER_LABEL" --filter "label=$RESOURCE_LABEL" | sed '/^$/d' | wc -l
}

count_invocation_networks() {
  docker network ls -q --filter "label=$OWNER_LABEL" --filter "label=$RESOURCE_LABEL" | sed '/^$/d' | wc -l
}

active_supervisor_ids() {
  docker ps --no-trunc --quiet --filter "label=$OWNER_LABEL" --filter "label=$SUPERVISOR_RESOURCE_LABEL"
}

count_active_supervisors() {
  active_supervisor_ids | sed '/^$/d' | wc -l
}

assert_zero_invocation_resources() {
  [[ "$(count_invocation_containers)" == '0' && "$(count_invocation_networks)" == '0' ]] || fail "$1"
}

expect_error() {
  local response="$1"
  local expected="$2"
  node - "$response" "$expected" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (value.protocolVersion !== 1 || value.ok !== false || value.errorCode !== process.argv[3]) process.exit(1);
if (JSON.stringify(value).length > 2048) process.exit(1);
NODE
}

assert_no_docker_socket_mount() {
  local container="$1"
  docker inspect --format '{{range .Mounts}}{{println .Destination}}{{end}}' "$container" | grep -qx '/var/run/docker.sock' && \
    fail "$container unexpectedly has the Docker socket mounted."
  return 0
}

[[ "${E50_ACCEPT_STEP5B1:-}" == 'YES' ]] || fail 'Set E50_ACCEPT_STEP5B1=YES after reviewing this owner-run harness.'
[[ "${E50_EXPECTED_STEP5B1_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || fail 'E50_EXPECTED_STEP5B1_COMMIT must be an exact reviewed commit.'
cd "$ROOT"
[[ "$(git branch --show-current)" == 'codex/e50-piece-supervisor' ]] || fail 'Wrong branch.'
[[ "$(git rev-parse HEAD)" == "$E50_EXPECTED_STEP5B1_COMMIT" ]] || fail 'HEAD does not match the reviewed Step 5B.1 commit.'
[[ -z "$(git status --porcelain)" ]] || fail 'Working tree is not clean.'
git merge-base --is-ancestor "$ACCEPTED_STEP5A" HEAD || fail 'Accepted Step 5A base is not an ancestor.'
[[ "$(git merge-base HEAD "$ACCEPTED_STEP5A")" == "$ACCEPTED_STEP5A" ]] || fail 'Branch is not based on accepted Step 5A.'
git fetch origin main --quiet
[[ "$(git rev-parse origin/main)" == "$EXPECTED_ORIGIN_MAIN" ]] || fail 'origin/main changed from the reviewed production baseline.'
while IFS= read -r file; do
  [[ "$file" =~ ^(services/piece-runtime/(Dockerfile\.supervisor|src/(docker-client|docker-piece-container-engine|supervisor-constants|supervisor-errors|supervisor-protocol|supervisor-service|supervisor-server|supervisor)\.mjs)|scripts/e50-step5b1-supervisor-host-acceptance\.sh|docs/piece-runtime/SUPERVISOR_V1\.md|tests/essential-fifty-step-five-b-supervisor\.test\.ts)$ ]] || fail "Out-of-scope file: $file"
done < <(git diff --name-only "$ACCEPTED_STEP5A..HEAD")

command -v docker >/dev/null || fail 'Docker is required.'
command -v curl >/dev/null || fail 'curl is required.'
[[ -S /var/run/docker.sock ]] || fail 'Docker Engine socket is unavailable.'
[[ "$(count_active_supervisors)" == '0' ]] || fail 'No already-running Step 5B.1 supervisor may exist before acceptance.'
snapshot_protected "$PROTECTED_BEFORE"
for protected_name in "${PROTECTED[@]}"; do assert_no_docker_socket_mount "$protected_name"; done
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --request POST --header 'Content-Type: application/json' --data '{}' http://127.0.0.1:8788/v1/execute)" == '401' ]] || fail 'Connector Runner unsigned JSON check did not return 401.'
[[ "$(docker exec redis redis-cli PING)" == 'PONG' ]] || fail 'Redis did not return PONG.'

docker build --no-cache --label "$OWNER_LABEL" -f services/piece-runtime/Dockerfile.sandbox -t "$SANDBOX_IMAGE" services/piece-runtime >/dev/null
docker build --no-cache --label "$OWNER_LABEL" -f services/piece-runtime/Dockerfile.gateway -t "$GATEWAY_IMAGE" services/piece-runtime >/dev/null
docker build --no-cache --label "$OWNER_LABEL" -f services/piece-runtime/Dockerfile.supervisor -t "$SUPERVISOR_IMAGE" services/piece-runtime >/dev/null
docker run --rm --entrypoint node "$SANDBOX_IMAGE" -e 'const p=require("/piece-runtime/node_modules/@activepieces/piece-hubspot/package.json");if(p.version!=="0.8.10")process.exit(1)' || fail 'Reviewed HubSpot package version mismatch.'

docker create --name cl-piece-step5b1-stale --label "$OWNER_LABEL" --label "$RESOURCE_LABEL" --label 'crazyloops.invocation=stale-proof' --network none "$GATEWAY_IMAGE" >/dev/null
docker network create --label "$OWNER_LABEL" --label "$RESOURCE_LABEL" --label 'crazyloops.invocation=stale-proof' cl-piece-step5b1-stale-network >/dev/null
docker network create --label 'crazyloops.runtime=unrelated-proof' "$UNRELATED_NETWORK" >/dev/null

DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
chown 65532:65532 "$CONTROL_DIR"
chmod 0750 "$CONTROL_DIR"
docker run --detach --name "$SUPERVISOR_NAME" --label "$OWNER_LABEL" --label "$SUPERVISOR_RESOURCE_LABEL" \
  --env PIECE_SUPERVISOR_CONTAINER_NAME="$SUPERVISOR_NAME" \
  --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=4m \
  --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=32 \
  --memory=268435456 --memory-swap=268435456 --cpus=0.5 --ulimit=nofile=128:128 \
  --user=65532:65532 --group-add "$DOCKER_GID" --log-driver=json-file --log-opt max-size=1m \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount type=bind,src="$CONTROL_DIR",dst=/run/crazyloops-piece \
  "$SUPERVISOR_IMAGE" >/dev/null

mapfile -t active_supervisors < <(active_supervisor_ids)
[[ "${#active_supervisors[@]}" == '1' ]] || fail 'Exactly one active Step 5B.1 supervisor was not proven.'
SUPERVISOR_DOCKER_ID="$(docker inspect --format '{{.Id}}' "$SUPERVISOR_NAME")"
[[ "${active_supervisors[0]}" == "$SUPERVISOR_DOCKER_ID" ]] || fail 'Active supervisor does not match its inspected self Docker identity.'

for _ in $(seq 1 100); do [[ -S "$SOCKET" ]] && break; sleep 0.05; done
[[ -S "$SOCKET" ]] || fail 'Supervisor UDS was not created.'
[[ "$(stat -c '%a' "$SOCKET")" == '660' ]] || fail 'Supervisor socket mode is not exactly 660.'
[[ "$(stat -c '%a' "$CONTROL_DIR")" == '750' ]] || fail 'Supervisor control directory mode is not exactly 750.'
HEALTH="$(health)"
node -e 'const h=JSON.parse(process.argv[1]);if(!h.ok||h.protocolVersion!==1||h.status!=="ready"||h.activeInvocations!==0||h.concurrencyLimit!==2)process.exit(1)' "$HEALTH" || fail 'Supervisor health response is invalid.'

docker inspect "$SUPERVISOR_NAME" >"$ARTIFACT_DIR/supervisor-inspect.json"
node - "$ARTIFACT_DIR/supervisor-inspect.json" "$CONTROL_DIR" "$DOCKER_GID" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[0];
const host = value.HostConfig;
if (value.Config.Labels?.['crazyloops.runtime'] !== 'piece-runtime-supervisor-v1' || value.Config.Labels?.['crazyloops.resource'] !== 'supervisor') throw new Error('supervisor labels');
if (value.Config.User !== '65532:65532') throw new Error('user');
if (host.NetworkMode !== 'none' || Object.keys(host.PortBindings ?? {}).length || value.Config.ExposedPorts) throw new Error('network');
if (!host.ReadonlyRootfs || host.Privileged || JSON.stringify(host.CapDrop) !== JSON.stringify(['ALL']) || (host.CapAdd ?? []).length || !(host.SecurityOpt ?? []).includes('no-new-privileges')) throw new Error('privilege');
if (host.PidsLimit !== 32 || host.Memory !== 268435456 || host.MemorySwap !== 268435456 || host.NanoCpus !== 500000000) throw new Error('limits');
const nofile = (host.Ulimits ?? []).find(({ Name }) => Name === 'nofile');
if (!nofile || nofile.Soft !== 128 || nofile.Hard !== 128) throw new Error('nofile');
if (host.Tmpfs?.['/tmp'] !== 'rw,noexec,nosuid,nodev,size=4m') throw new Error('tmpfs');
if (!(host.GroupAdd ?? []).map(String).includes(String(process.argv[4]))) throw new Error('docker gid');
const mounts = value.Mounts.map(({ Source, Destination }) => `${Source}:${Destination}`).sort();
const expected = [`/var/run/docker.sock:/var/run/docker.sock`, `${process.argv[3]}:/run/crazyloops-piece`].sort();
if (JSON.stringify(mounts) !== JSON.stringify(expected)) throw new Error('mounts');
NODE
docker exec "$SUPERVISOR_NAME" node - "$DOCKER_GID" <<'NODE'
const fs = require('node:fs');
const status = Object.fromEntries(fs.readFileSync('/proc/self/status', 'utf8').trim().split(/\n/).map((line) => {
  const index = line.indexOf(':');
  return [line.slice(0, index), line.slice(index + 1).trim()];
}));
if (!status.Uid.split(/\s+/).every((value) => value === '65532')) throw new Error('uid');
if (!status.Gid.split(/\s+/).every((value) => value === '65532')) throw new Error('gid');
if (!status.Groups.split(/\s+/).includes(process.argv[2])) throw new Error('supplementary gid');
if (status.CapEff !== '0000000000000000' || status.NoNewPrivs !== '1' || status.Seccomp !== '2') throw new Error('kernel privilege');
if (fs.readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim() !== '32') throw new Error('pids cgroup');
if (fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim() !== '268435456') throw new Error('memory cgroup');
if (fs.readFileSync('/sys/fs/cgroup/memory.swap.max', 'utf8').trim() !== '0') throw new Error('swap cgroup');
const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/).map(Number);
if (!Number.isFinite(quota) || !Number.isFinite(period) || quota / period !== 0.5) throw new Error('cpu cgroup');
NODE
docker exec "$SUPERVISOR_NAME" node -e '
  const fs = require("node:fs");
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const listening = fs.readFileSync(path, "utf8").trim().split(/\n/).slice(1)
      .some((line) => line.trim().split(/\s+/)[3] === "0A");
    if (listening) process.exit(1);
  }
' || fail 'Supervisor has a TCP listener.'
[[ -z "$(docker ps -aq --filter 'name=cl-piece-step5b1-stale')" ]] || fail 'Owned stale container survived startup cleanup.'
[[ -z "$(docker network ls -q --filter 'name=cl-piece-step5b1-stale-network')" ]] || fail 'Owned stale network survived startup cleanup.'
[[ -n "$(docker network ls -q --filter "name=$UNRELATED_NETWORK")" ]] || fail 'Unrelated network was removed.'

CANARY="E50_STEP5B1_$(openssl rand -hex 32)"
CANARY_B64="$(printf '%s' "$CANARY" | base64 -w0)"
REQUEST_ID='step5b1-host-invocation'
INVOCATION_ID="$(printf '%s' "$REQUEST_ID" | sha256sum | cut -c1-16)"
SANDBOX_NAME="cl-piece-sandbox-$INVOCATION_ID"
GATEWAY_NAME="cl-piece-gateway-$INVOCATION_ID"
INTERNAL_NAME="cl-piece-internal-$INVOCATION_ID"
EGRESS_NAME="cl-piece-egress-$INVOCATION_ID"
cat >"$ARTIFACT_DIR/request.json" <<JSON
{"protocolVersion":1,"request":{"protocolVersion":1,"requestId":"$REQUEST_ID","executionId":"step5b1-host-execution","capabilityId":"hubspot.get_contact","capabilityVersion":1,"mode":"TEST","idempotencyKey":"step5b1-host-idempotency","input":{"contactId":"synthetic-contact","properties":["firstname"]}},"credentialBase64":"$CANARY_B64"}
JSON
execute_file "$ARTIFACT_DIR/request.json" "$ARTIFACT_DIR/response.json" &
EXECUTE_PID=$!
GATEWAY_WATCHER_PID=''
for _ in $(seq 1 500); do
  if docker inspect "$GATEWAY_NAME" >/dev/null 2>&1; then
    timeout 20 docker logs --follow "$GATEWAY_NAME" >"$ARTIFACT_DIR/live-gateway-logs.txt" 2>&1 &
    GATEWAY_WATCHER_PID=$!
    break
  fi
  sleep 0.01
done
[[ -n "$GATEWAY_WATCHER_PID" ]] || fail 'Live gateway log watcher could not attach.'
TOPOLOGY_CAPTURED=0
for _ in $(seq 1 500); do
  if docker inspect "$SANDBOX_NAME" "$GATEWAY_NAME" >"$ARTIFACT_DIR/invocation-inspect.json" 2>/dev/null && \
    docker network inspect "$INTERNAL_NAME" "$EGRESS_NAME" >"$ARTIFACT_DIR/invocation-networks.json" 2>/dev/null && \
    docker top "$SANDBOX_NAME" -eo pid,args >"$ARTIFACT_DIR/sandbox-processes.txt" 2>/dev/null && \
    docker top "$GATEWAY_NAME" -eo pid,args >"$ARTIFACT_DIR/gateway-processes.txt" 2>/dev/null && \
    docker exec "$GATEWAY_NAME" sh -c '! grep -q "api.hubapi.com" /etc/hosts'; then
    printf 'SAFE\n' >"$ARTIFACT_DIR/gateway-self-shadow.txt"
    TOPOLOGY_CAPTURED=1
    break
  fi
  sleep 0.01
done
wait "$EXECUTE_PID"
wait "$GATEWAY_WATCHER_PID" || true
[[ "$TOPOLOGY_CAPTURED" == '1' ]] || fail 'Invocation topology was not captured.'
node - "$ARTIFACT_DIR/invocation-inspect.json" "$ARTIFACT_DIR/invocation-networks.json" "$INVOCATION_ID" "$INTERNAL_NAME" "$EGRESS_NAME" <<'NODE'
const fs = require('node:fs');
const [sandbox, gateway] = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const networks = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const invocation = process.argv[4];
const internalName = process.argv[5];
const egressName = process.argv[6];
const labelsAreExact = (labels) => labels?.['crazyloops.runtime'] === 'piece-runtime-supervisor-v1' && labels?.['crazyloops.resource'] === 'invocation' && labels?.['crazyloops.invocation'] === invocation;
const internal = networks.find(({ Name }) => Name === internalName);
const egress = networks.find(({ Name }) => Name === egressName);
if (!internal || internal.Internal !== true || !labelsAreExact(internal.Labels)) throw new Error('internal network');
if (!egress || egress.Internal !== false || !labelsAreExact(egress.Labels)) throw new Error('egress network');
const sandboxNetworks = Object.keys(sandbox.NetworkSettings.Networks);
const gatewayNetworks = Object.keys(gateway.NetworkSettings.Networks);
if (JSON.stringify(sandboxNetworks) !== JSON.stringify([internalName])) throw new Error('sandbox topology');
if (gatewayNetworks.length !== 2 || !gatewayNetworks.includes(internalName) || !gatewayNetworks.includes(egressName)) throw new Error('gateway topology');
if (!labelsAreExact(sandbox.Config.Labels) || !labelsAreExact(gateway.Config.Labels)) throw new Error('container labels');
if (sandbox.Mounts.length || gateway.Mounts.length || sandbox.HostConfig.Privileged || gateway.HostConfig.Privileged) throw new Error('boundary');
if (JSON.stringify({ sandbox, gateway }).includes('/var/run/docker.sock')) throw new Error('docker socket');
const gatewayIp = gateway.NetworkSettings.Networks[internalName]?.IPAddress;
if (!gatewayIp || !(sandbox.HostConfig.ExtraHosts ?? []).includes(`api.hubapi.com:${gatewayIp}`)) throw new Error('dynamic gateway IP');
const aliases = gateway.NetworkSettings.Networks[internalName]?.Aliases ?? [];
if (!aliases.includes(`cl-piece-gateway-${invocation}`) || aliases.includes('api.hubapi.com')) throw new Error('gateway aliases');
NODE
node - "$ARTIFACT_DIR/live-gateway-logs.txt" <<'NODE'
const fs = require('node:fs');
const events = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const dns = events.find((event) => event.event === 'piece_gateway_dns' && event.hostname === 'api.hubapi.com' && event.port === 443 && event.outcome === 'SAFE');
const connection = events.find((event) => event.event === 'piece_gateway_connection' && event.hostname === 'api.hubapi.com' && event.port === 443 && event.outcome === 'PIECE_GATEWAY_SUCCEEDED');
if (!dns || !connection) process.exit(1);
NODE
expect_error "$ARTIFACT_DIR/response.json" 'PIECE_AUTH_FAILED' || fail 'Real provider canary did not return PIECE_AUTH_FAILED.'
assert_zero_invocation_resources 'Invocation resources survived request completion.'

printf '{' >"$ARTIFACT_DIR/malformed.json"
execute_file "$ARTIFACT_DIR/malformed.json" "$ARTIFACT_DIR/malformed-response.json" || true
expect_error "$ARTIFACT_DIR/malformed-response.json" 'SUPERVISOR_INVALID_REQUEST' || fail 'Malformed request was not bounded.'
assert_zero_invocation_resources 'Malformed request created resources.'

node - "$ARTIFACT_DIR/override.json" <<'NODE'
const fs = require('node:fs');
const requestId = 'step5b1-negative-override';
const value = { protocolVersion: 1, request: { protocolVersion: 1, requestId, executionId: 'negative-execution', capabilityId: 'hubspot.get_contact', capabilityVersion: 1, mode: 'TEST', idempotencyKey: requestId, input: { contactId: 'synthetic-contact' } }, credentialBase64: Buffer.from('negative-token').toString('base64') };
value.request.sandboxImage = 'attacker/image';
fs.writeFileSync(process.argv[2], JSON.stringify(value));
NODE
execute_file "$ARTIFACT_DIR/override.json" "$ARTIFACT_DIR/override-response.json" || true
expect_error "$ARTIFACT_DIR/override-response.json" 'PIECE_INVALID_INPUT' || fail 'Metadata override was not rejected.'
assert_zero_invocation_resources 'Metadata override created resources.'

node - "$ARTIFACT_DIR/unsupported.json" <<'NODE'
const fs = require('node:fs');
const requestId = 'step5b1-negative-unsupported';
fs.writeFileSync(process.argv[2], JSON.stringify({ protocolVersion: 1, request: { protocolVersion: 1, requestId, executionId: 'negative-execution', capabilityId: 'hubspot.get_contact', capabilityVersion: 999, mode: 'TEST', idempotencyKey: requestId, input: { contactId: 'synthetic-contact' } }, credentialBase64: Buffer.from('negative-token').toString('base64') }));
NODE
execute_file "$ARTIFACT_DIR/unsupported.json" "$ARTIFACT_DIR/unsupported-response.json" || true
expect_error "$ARTIFACT_DIR/unsupported-response.json" 'PIECE_UNSUPPORTED_CAPABILITY' || fail 'Unsupported capability/version was not bounded.'
assert_zero_invocation_resources 'Unsupported capability/version created resources.'

node - "$ARTIFACT_DIR/malformed-credential.json" <<'NODE'
const fs = require('node:fs');
const requestId = 'step5b1-negative-credential';
fs.writeFileSync(process.argv[2], JSON.stringify({ protocolVersion: 1, request: { protocolVersion: 1, requestId, executionId: 'negative-execution', capabilityId: 'hubspot.get_contact', capabilityVersion: 1, mode: 'TEST', idempotencyKey: requestId, input: { contactId: 'synthetic-contact' } }, credentialBase64: 'Zg' }));
NODE
execute_file "$ARTIFACT_DIR/malformed-credential.json" "$ARTIFACT_DIR/malformed-credential-response.json" || true
expect_error "$ARTIFACT_DIR/malformed-credential-response.json" 'PIECE_INVALID_CREDENTIAL' || fail 'Malformed credential was not bounded.'
assert_zero_invocation_resources 'Malformed credential created resources.'

node - "$ARTIFACT_DIR/worker-failure.json" <<'NODE'
const fs = require('node:fs');
const requestId = 'step5b1-negative-worker';
fs.writeFileSync(process.argv[2], JSON.stringify({ protocolVersion: 1, request: { protocolVersion: 1, requestId, executionId: 'negative-execution', capabilityId: 'hubspot.get_contact', capabilityVersion: 1, mode: 'TEST', idempotencyKey: requestId, input: { contactId: 'invalid/contact' } }, credentialBase64: Buffer.from('negative-token').toString('base64') }));
NODE
execute_file "$ARTIFACT_DIR/worker-failure.json" "$ARTIFACT_DIR/worker-failure-response.json" || true
expect_error "$ARTIFACT_DIR/worker-failure-response.json" 'PIECE_INVALID_INPUT' || fail 'Controlled worker failure was not bounded.'
assert_zero_invocation_resources 'Controlled worker failure left resources.'

docker top "$SUPERVISOR_NAME" -eo pid,args >"$ARTIFACT_DIR/supervisor-processes.txt"
docker logs "$SUPERVISOR_NAME" >"$ARTIFACT_DIR/supervisor-logs.txt" 2>&1
docker image inspect "$SUPERVISOR_IMAGE" "$GATEWAY_IMAGE" "$SANDBOX_IMAGE" >"$ARTIFACT_DIR/images.json"
docker history --no-trunc "$SUPERVISOR_IMAGE" >"$ARTIFACT_DIR/supervisor-history.txt"
docker history --no-trunc "$GATEWAY_IMAGE" >"$ARTIFACT_DIR/gateway-history.txt"
docker history --no-trunc "$SANDBOX_IMAGE" >"$ARTIFACT_DIR/sandbox-history.txt"
snapshot_protected "$PROTECTED_AFTER"
cmp -s "$PROTECTED_BEFORE" "$PROTECTED_AFTER" || fail 'Protected services changed.'
for protected_name in "${PROTECTED[@]}"; do assert_no_docker_socket_mount "$protected_name"; done

RUNTIME_SURFACES=(
  "$ARTIFACT_DIR/supervisor-logs.txt"
  "$ARTIFACT_DIR/supervisor-inspect.json"
  "$ARTIFACT_DIR/invocation-inspect.json"
  "$ARTIFACT_DIR/invocation-networks.json"
  "$ARTIFACT_DIR/live-gateway-logs.txt"
  "$ARTIFACT_DIR/supervisor-processes.txt"
  "$ARTIFACT_DIR/sandbox-processes.txt"
  "$ARTIFACT_DIR/gateway-processes.txt"
  "$ARTIFACT_DIR/images.json"
  "$ARTIFACT_DIR/supervisor-history.txt"
  "$ARTIFACT_DIR/gateway-history.txt"
  "$ARTIFACT_DIR/sandbox-history.txt"
  "$ARTIFACT_DIR/response.json"
  "$ARTIFACT_DIR/malformed-response.json"
  "$ARTIFACT_DIR/override-response.json"
  "$ARTIFACT_DIR/unsupported-response.json"
  "$ARTIFACT_DIR/malformed-credential-response.json"
  "$ARTIFACT_DIR/worker-failure-response.json"
  "$PROTECTED_BEFORE"
  "$PROTECTED_AFTER"
)
for surface in "${RUNTIME_SURFACES[@]}"; do
  [[ -f "$surface" ]] || fail "Missing credential scan surface: $(basename "$surface")"
  grep -Fq "$CANARY" "$surface" && fail "Credential plaintext appeared in $(basename "$surface")."
  grep -Fq "$CANARY_B64" "$surface" && fail "Credential Base64 appeared in $(basename "$surface")."
done
while IFS= read -r -d '' surface; do
  grep -Fq "$CANARY" "$surface" && fail "Credential plaintext appeared in control file $(basename "$surface")."
  grep -Fq "$CANARY_B64" "$surface" && fail "Credential Base64 appeared in control file $(basename "$surface")."
done < <(find "$CONTROL_DIR" -maxdepth 1 -type f -print0)

docker stop --time 20 "$SUPERVISOR_NAME" >/dev/null
[[ "$(count_active_supervisors)" == '0' ]] || fail 'Running Step 5B.1 supervisor count did not return to zero after graceful shutdown.'
node -e 'const value=JSON.parse(process.argv[1])[0];if(value.State.Running||value.State.OOMKilled||value.State.ExitCode!==0)process.exit(1)' "$(docker inspect "$SUPERVISOR_NAME")" || fail 'Supervisor did not complete its bounded SIGTERM shutdown.'
docker rm "$SUPERVISOR_NAME" >/dev/null
[[ ! -e "$SOCKET" ]] || fail 'Supervisor socket survived graceful shutdown.'

docker network rm "$UNRELATED_NETWORK" >/dev/null
docker image rm -f "$SUPERVISOR_IMAGE" "$GATEWAY_IMAGE" "$SANDBOX_IMAGE" >/dev/null
STEP5B1_SUPERVISOR_CONTAINERS="$(docker ps -aq --filter "name=$SUPERVISOR_NAME" | sed '/^$/d' | wc -l)"
STEP5B1_INVOCATION_CONTAINERS="$(count_invocation_containers)"
STEP5B1_INVOCATION_NETWORKS="$(count_invocation_networks)"
STEP5B1_TEMP_IMAGES="$(docker image ls -q --filter "label=$OWNER_LABEL" | sort -u | sed '/^$/d' | wc -l)"
[[ "$STEP5B1_SUPERVISOR_CONTAINERS" == '0' && "$STEP5B1_INVOCATION_CONTAINERS" == '0' && "$STEP5B1_INVOCATION_NETWORKS" == '0' && "$STEP5B1_TEMP_IMAGES" == '0' ]] || fail 'Step 5B.1 resources remain.'

cat <<REPORT
SOURCE_GATE=PASS
SUPERVISOR_IMAGE_BUILD=PASS
SUPERVISOR_HARDENING=PASS
UDS_ONLY_CONTROL_PLANE=PASS
DOCKER_SOCKET_SUPERVISOR_ONLY=PASS
HEALTH_OVER_UDS=PASS
CONCRETE_ENGINE_TOPOLOGY=PASS
DYNAMIC_GATEWAY_IP=PASS
SANDBOX_INTERNAL_ONLY=PASS
GATEWAY_CONTROLLED_EGRESS=PASS
BOUNDED_PROVIDER_FAILURE=PASS
NEGATIVE_MATRIX=PASS
ORPHAN_CLEANUP_SCOPE=PASS
CREDENTIAL_PLAINTEXT_OCCURRENCES=0
CREDENTIAL_BASE64_OCCURRENCES=0
PROTECTED_SERVICES_UNCHANGED=PASS
RUNNER_UNSIGNED_HTTP=401
REDIS=PONG
PRODUCT_DEPLOYMENT=NOT_PERFORMED_BY_HARNESS
STEP5B1_SUPERVISOR_CONTAINERS=$STEP5B1_SUPERVISOR_CONTAINERS
STEP5B1_INVOCATION_CONTAINERS=$STEP5B1_INVOCATION_CONTAINERS
STEP5B1_INVOCATION_NETWORKS=$STEP5B1_INVOCATION_NETWORKS
STEP5B1_TEMP_IMAGES=$STEP5B1_TEMP_IMAGES
STEP5B1 HOST ACCEPTANCE=PASS
REPORT

CANARY=''
CANARY_B64=''
rm -rf -- "$ARTIFACT_DIR" "$CONTROL_DIR"
trap - EXIT INT TERM
