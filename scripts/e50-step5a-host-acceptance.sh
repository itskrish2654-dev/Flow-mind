#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_BASE='07b236ca99b5044600fe2c9b3e9ac5966397b2d4'
EXPECTED_ORIGIN_MAIN="${E50_EXPECTED_ORIGIN_MAIN:-20c23d7e85123eaa77a916ce43f4a9ef5ca8a5e7}"
LABEL='crazyloops.runtime=piece-runtime-step5a-acceptance'
PREFIX='cl-piece-step5a-accept-'
SANDBOX_IMAGE='crazyloops/piece-runtime-hubspot:0.8.10-step5a'
GATEWAY_IMAGE='crazyloops/piece-runtime-gateway:step5a'
ACCEPTANCE_IMAGE='crazyloops/piece-runtime-acceptance:step5a'
INTERNAL_NETWORK="${PREFIX}internal"
EGRESS_NETWORK="${PREFIX}egress"
GATEWAY="${PREFIX}gateway"
GATEWAY_INTERNAL_IP='10.253.50.2'
PROTECTED=(crazyloops-connector-runner activepieces-app activepieces-worker-1 redis)
ARTIFACT_DIR="$(mktemp -d)"
SURFACE_FILE="$ARTIFACT_DIR/surfaces.txt"
REPORT_FILE="$ARTIFACT_DIR/report.txt"
PROTECTED_BEFORE="$ARTIFACT_DIR/protected-before.txt"
PROTECTED_AFTER="$ARTIFACT_DIR/protected-after.txt"
CANARY=''
CANARY_TWO=''

fail() {
  echo "STEP5A HOST ACCEPTANCE FAILED: $*" >&2
  exit 1
}

cleanup_resources() {
  mapfile -t container_ids < <(docker ps -aq --filter "label=$LABEL" 2>/dev/null || true)
  if ((${#container_ids[@]})); then docker rm -f "${container_ids[@]}" >/dev/null 2>&1 || true; fi
  mapfile -t network_ids < <(docker network ls -q --filter "label=$LABEL" 2>/dev/null || true)
  if ((${#network_ids[@]})); then docker network rm "${network_ids[@]}" >/dev/null 2>&1 || true; fi
  for image in "$ACCEPTANCE_IMAGE" "$GATEWAY_IMAGE" "$SANDBOX_IMAGE"; do
    docker image rm -f "$image" >/dev/null 2>&1 || true
  done
  mapfile -t image_ids < <(docker image ls -q --filter "label=$LABEL" 2>/dev/null | sort -u || true)
  if ((${#image_ids[@]})); then docker image rm -f "${image_ids[@]}" >/dev/null 2>&1 || true; fi
}

cleanup() {
  cleanup_resources
  rm -rf -- "$ARTIFACT_DIR"
}
trap cleanup EXIT INT TERM

snapshot_protected() {
  local output="$1"
  : >"$output"
  for name in "${PROTECTED[@]}"; do
    docker inspect --format '{{.Name}}|{{.Id}}|{{.RestartCount}}|{{.State.Status}}|{{json .NetworkSettings.Networks}}|{{json .NetworkSettings.Ports}}' "$name" >>"$output"
  done
}

runner_auth_check() {
  local code
  code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --request POST --header 'Content-Type: application/json' --data '{}' \
    http://127.0.0.1:8788/v1/execute)"
  [[ "$code" == '401' ]] || fail "Connector Runner unsigned request returned HTTP $code, expected 401."
}

redis_check() {
  [[ "$(docker exec redis redis-cli PING)" == 'PONG' ]] || fail 'Redis did not return PONG.'
}

sandbox_args() {
  printf '%s\n' \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=4m \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --pids-limit=16 \
    --memory=134217728 \
    --memory-swap=134217728 \
    --cpus=0.5 \
    --ulimit=nofile=64:64 \
    --user=65532:65532 \
    --log-driver=none
}

run_worker_case() {
  local case_name="$1"
  local request_json="$2"
  local expected_code="$3"
  local output="$ARTIFACT_DIR/worker-${case_name}.json"
  local envelope
  envelope="$(printf '{"request":%s,"credentialBase64":"%s"}' "$request_json" "$CANARY_B64")"
  printf '%s' "$envelope" | docker run --rm --interactive \
    --name "${PREFIX}worker-${case_name}" --label "$LABEL" --network none \
    $(sandbox_args) "$SANDBOX_IMAGE" >"$output"
  grep -q "\"errorCode\":\"$expected_code\"" "$output" || fail "Worker case $case_name did not return $expected_code."
  cat "$output" >>"$SURFACE_FILE"
}

run_acceptance_probe() {
  local case_name="$1"
  local mode="$2"
  local expected="$3"
  local output="$ARTIFACT_DIR/probe-${case_name}.json"
  docker run --rm --name "${PREFIX}probe-${case_name}" --label "$LABEL" \
    --network "$INTERNAL_NETWORK" $(sandbox_args) \
    --entrypoint node "$ACCEPTANCE_IMAGE" /acceptance/runtime-probe.mjs "$mode" >"$output"
  grep -q "$expected" "$output" || fail "Acceptance probe $case_name lacked expected evidence."
  cat "$output" >>"$SURFACE_FILE"
}

count_labelled() {
  local kind="$1"
  case "$kind" in
    containers) docker ps -aq --filter "label=$LABEL" | sed '/^$/d' | wc -l ;;
    networks) docker network ls -q --filter "label=$LABEL" | sed '/^$/d' | wc -l ;;
    images) docker image ls -q --filter "label=$LABEL" | sort -u | sed '/^$/d' | wc -l ;;
  esac
}

if [[ "${E50_ACCEPT_STEP5A:-}" != 'YES' ]]; then
  fail 'Set E50_ACCEPT_STEP5A=YES after reviewing this owner-run harness.'
fi
if [[ ! "${E50_EXPECTED_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]]; then
  fail 'E50_EXPECTED_COMMIT must be the reviewed Step 5A correction commit.'
fi
if [[ ! "$EXPECTED_ORIGIN_MAIN" =~ ^[0-9a-f]{40}$ ]]; then
  fail 'E50_EXPECTED_ORIGIN_MAIN must be a reviewed commit SHA.'
fi

cd "$ROOT"
[[ "$(git branch --show-current)" == 'codex/e50-piece-runtime' ]] || fail 'Wrong branch.'
[[ "$(git rev-parse HEAD)" == "$E50_EXPECTED_COMMIT" ]] || fail 'Wrong Step 5A commit.'
[[ -z "$(git status --porcelain)" ]] || fail 'Working tree is not clean.'
git merge-base --is-ancestor "$EXPECTED_BASE" HEAD || fail 'Step 5A branch does not descend from the accepted base.'
[[ "$(git rev-parse origin/main)" == "$EXPECTED_ORIGIN_MAIN" ]] || fail 'origin/main moved from the reviewed value.'
while IFS= read -r changed; do
  case "$changed" in
    services/piece-runtime/*|docs/piece-runtime/*|scripts/e50-step5a-host-acceptance.sh|tests/essential-fifty-step-five-runtime.test.ts|tests/fixtures/essential-fifty-synthetic-piece.mjs) ;;
    *) fail "Product or unrelated file appears in Step 5A history: $changed" ;;
  esac
done < <(git diff --name-only "$EXPECTED_BASE..HEAD")

command -v docker >/dev/null || fail 'Docker is required.'
command -v curl >/dev/null || fail 'curl is required.'
command -v openssl >/dev/null || fail 'openssl is required.'
docker version >/dev/null
snapshot_protected "$PROTECTED_BEFORE"
runner_auth_check
redis_check

grep -Fq 'node:24.8.0-bookworm-slim@sha256:cadbfafeb6baf87eaaffa40b3640209c4b7fd38cebde65059d15bc39cd636b85' services/piece-runtime/Dockerfile.sandbox || fail 'Sandbox base digest changed.'
grep -Fq 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund' services/piece-runtime/Dockerfile.sandbox || fail 'Sandbox image no longer uses npm ci.'

docker build --pull=false --no-cache --label "$LABEL" -t "$SANDBOX_IMAGE" -f services/piece-runtime/Dockerfile.sandbox services/piece-runtime
docker build --pull=false --no-cache --label "$LABEL" -t "$GATEWAY_IMAGE" -f services/piece-runtime/Dockerfile.gateway services/piece-runtime
docker build --pull=false --no-cache --label "$LABEL" -t "$ACCEPTANCE_IMAGE" -f services/piece-runtime/Dockerfile.acceptance services/piece-runtime

docker run --rm --name "${PREFIX}package-evidence" --label "$LABEL" \
  --entrypoint node "$SANDBOX_IMAGE" --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { REVIEWED_PIECE_BUILDS } from "/piece-runtime/src/build-registry.mjs";
  const lock = JSON.parse(readFileSync("/piece-runtime/package-lock.json", "utf8"));
  const build = REVIEWED_PIECE_BUILDS.get("activepieces-hubspot-0_8_10");
  const installed = lock.packages["node_modules/@activepieces/piece-hubspot"];
  if (installed.version !== build.packageVersion || installed.integrity !== build.npmIntegrity) process.exit(1);
  console.log(JSON.stringify({ buildId: build.buildId, packageName: build.packageName, packageVersion: installed.version, integrityMatches: true, image: build.sandboxImage, action: "get-contact" }));
' >"$ARTIFACT_DIR/package-evidence.json"
grep -q '"integrityMatches":true' "$ARTIFACT_DIR/package-evidence.json" || fail 'Installed HubSpot package evidence did not match.'
docker image inspect "$SANDBOX_IMAGE" "$GATEWAY_IMAGE" "$ACCEPTANCE_IMAGE" >"$ARTIFACT_DIR/image-inspect.json"
docker history --no-trunc "$SANDBOX_IMAGE" >"$ARTIFACT_DIR/sandbox-history.txt"
docker history --no-trunc "$GATEWAY_IMAGE" >"$ARTIFACT_DIR/gateway-history.txt"
grep -q 'npm ci' "$ARTIFACT_DIR/sandbox-history.txt" || fail 'Sandbox image history lacks npm ci.'

docker network create --label "$LABEL" "$EGRESS_NETWORK" >/dev/null
docker network create --internal --subnet 10.253.50.0/24 --label "$LABEL" "$INTERNAL_NETWORK" >/dev/null

docker run --detach --name "$GATEWAY" --label "$LABEL" --network "$EGRESS_NETWORK" \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1m \
  --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=16 \
  --memory=67108864 --memory-swap=67108864 --cpus=0.25 --ulimit=nofile=64:64 \
  --user=65532:65532 --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  --log-driver=json-file --log-opt max-size=1m \
  --env PIECE_RUNTIME_CAPABILITY_ID=hubspot.get_contact \
  --env PIECE_RUNTIME_CAPABILITY_VERSION=1 \
  --env PIECE_RUNTIME_REQUEST_ID=host-acceptance \
  "$GATEWAY_IMAGE" >/dev/null
docker network connect --ip "$GATEWAY_INTERNAL_IP" --alias "$GATEWAY" "$INTERNAL_NETWORK" "$GATEWAY"

for _ in $(seq 1 30); do
  if docker logs "$GATEWAY" 2>&1 | grep -q 'piece_gateway_ready'; then break; fi
  sleep 1
done
docker logs "$GATEWAY" 2>&1 | grep -q 'piece_gateway_ready' || fail 'Gateway did not become ready.'
docker exec "$GATEWAY" sh -c '! grep -q "api.hubapi.com" /etc/hosts' || fail 'Gateway namespace self-shadows the provider hostname.'
docker exec "$GATEWAY" node --input-type=module -e '
  import { lookup } from "node:dns/promises";
  import { isSafePublicAddress } from "/piece-gateway/ip-policy.mjs";
  const answers = await lookup("api.hubapi.com", { all: true, verbatim: true });
  if (!answers.length || !answers.every(({ address }) => isSafePublicAddress(address)) || answers.some(({ address }) => address === "10.253.50.2")) process.exit(1);
  console.log(JSON.stringify({ hostname: "api.hubapi.com", answers: answers.map(({ family }) => ({ family, classification: "SAFE" })), selfShadow: false }));
' >"$ARTIFACT_DIR/gateway-real-dns.json"

TLS_NAME="${PREFIX}tls-canonical"
docker run --name "$TLS_NAME" --label "$LABEL" --network "$INTERNAL_NETWORK" \
  --add-host "api.hubapi.com:$GATEWAY_INTERNAL_IP" $(sandbox_args) \
  --entrypoint node "$ACCEPTANCE_IMAGE" /acceptance/tls-probe.mjs canonical >"$ARTIFACT_DIR/tls.json"
grep -q '"authorized":true' "$ARTIFACT_DIR/tls.json" || fail 'Credential-free canonical TLS verification failed.'
grep -q '"applicationBytesSent":0' "$ARTIFACT_DIR/tls.json" || fail 'TLS preflight sent application data.'
docker rm "$TLS_NAME" >/dev/null
docker logs "$GATEWAY" >"$ARTIFACT_DIR/gateway-logs.txt" 2>&1
grep -q '"event":"piece_gateway_dns"' "$ARTIFACT_DIR/gateway-logs.txt" || fail 'Gateway emitted no DNS evidence.'
grep -q '"hostname":"api.hubapi.com"' "$ARTIFACT_DIR/gateway-logs.txt" || fail 'Gateway did not resolve the canonical provider hostname.'
grep -q '"outcome":"SAFE"' "$ARTIFACT_DIR/gateway-logs.txt" || fail 'Gateway DNS was not classified SAFE.'

RUNTIME_NAME="${PREFIX}runtime-evidence"
docker create --name "$RUNTIME_NAME" --label "$LABEL" --network "$INTERNAL_NETWORK" \
  $(sandbox_args) --entrypoint node "$ACCEPTANCE_IMAGE" /acceptance/runtime-probe.mjs runtime >/dev/null
docker start --attach "$RUNTIME_NAME" >"$ARTIFACT_DIR/runtime.json"
docker inspect "$RUNTIME_NAME" >"$ARTIFACT_DIR/sandbox-inspect.json"
node - "$ARTIFACT_DIR/sandbox-inspect.json" "$ARTIFACT_DIR/runtime.json" "$INTERNAL_NETWORK" <<'NODE'
const fs = require('node:fs');
const inspect = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[0];
const runtime = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const expectedNetwork = process.argv[4];
const host = inspect.HostConfig;
if (inspect.Config.User !== '65532:65532') throw new Error('sandbox user');
if (!host.ReadonlyRootfs || host.PidsLimit !== 16 || host.Memory !== 134217728 || host.MemorySwap !== 134217728 || host.NanoCpus !== 500000000) throw new Error('sandbox limits');
if (host.LogConfig.Type !== 'none' || (host.Binds ?? []).length || inspect.Mounts.length) throw new Error('sandbox mounts/logs');
if (!(host.CapDrop ?? []).includes('ALL') || !(host.SecurityOpt ?? []).includes('no-new-privileges')) throw new Error('sandbox privilege');
if (host.NetworkMode !== expectedNetwork || JSON.stringify(Object.keys(inspect.NetworkSettings.Networks)) !== JSON.stringify([expectedNetwork])) throw new Error('sandbox network');
if (host.Tmpfs?.['/tmp'] !== 'rw,noexec,nosuid,nodev,size=4m' || !(host.Ulimits ?? []).some(({ Name, Soft, Hard }) => Name === 'nofile' && Soft === 64 && Hard === 64)) throw new Error('sandbox tmpfs/fd');
if (runtime.uid !== 65532 || runtime.gid !== 65532 || runtime.capabilities !== '0000000000000000' || runtime.noNewPrivileges !== '1' || runtime.seccomp !== '2') throw new Error('sandbox runtime');
if (runtime.pidsMax !== '16' || runtime.memoryMax !== '134217728' || runtime.memorySwapMax !== '0' || !runtime.cpuMax.startsWith('50000 ')) throw new Error('sandbox cgroup');
NODE
docker rm "$RUNTIME_NAME" >/dev/null

docker inspect "$GATEWAY" >"$ARTIFACT_DIR/gateway-inspect.json"
node - "$ARTIFACT_DIR/gateway-inspect.json" "$ARTIFACT_DIR/gateway-logs.txt" "$INTERNAL_NETWORK" "$EGRESS_NETWORK" <<'NODE'
const fs = require('node:fs');
const inspect = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[0];
const logs = fs.readFileSync(process.argv[3], 'utf8');
const expectedNetworks = new Set([process.argv[4], process.argv[5]]);
const host = inspect.HostConfig;
if (inspect.Config.User !== '65532:65532') throw new Error('gateway user');
if (!host.ReadonlyRootfs || host.PidsLimit !== 16 || host.Memory !== 67108864 || host.MemorySwap !== 67108864 || host.NanoCpus !== 250000000) throw new Error('gateway limits');
if ((host.Binds ?? []).length || inspect.Mounts.length || Object.keys(host.PortBindings ?? {}).length) throw new Error('gateway exposure');
if (!(host.CapDrop ?? []).includes('ALL') || !(host.SecurityOpt ?? []).includes('no-new-privileges')) throw new Error('gateway privilege');
if (!(host.Ulimits ?? []).some(({ Name, Soft, Hard }) => Name === 'nofile' && Soft === 64 && Hard === 64)) throw new Error('gateway fd');
if (Object.keys(inspect.NetworkSettings.Networks).length !== 2 || !Object.keys(inspect.NetworkSettings.Networks).every((name) => expectedNetworks.has(name))) throw new Error('gateway networks');
if ((inspect.Config.Env ?? []).some((entry) => /(?:credential|secret|token|authorization)=/i.test(entry))) throw new Error('gateway credential environment');
if (!logs.includes('"uid":65532') || !logs.includes('"seccomp":"2"') || !logs.includes('"capabilities":"0000000000000000"') || !logs.includes('"noNewPrivileges":"1"')) throw new Error('gateway runtime');
NODE

CANARY="E50_STEP5A_HOST_$(openssl rand -hex 32)"
CANARY_TWO="E50_STEP5A_HOST_$(openssl rand -hex 32)"
CANARY_B64="$(printf '%s' "$CANARY" | base64 -w0)"
BASE_REQUEST='{"protocolVersion":1,"requestId":"host-worker","executionId":"host-worker","capabilityId":"hubspot.get_contact","capabilityVersion":1,"mode":"TEST","idempotencyKey":"host-worker","input":{"contactId":"contact"}}'
run_worker_case unsupported '{"protocolVersion":1,"requestId":"host-worker","executionId":"host-worker","capabilityId":"unsupported.fixture","capabilityVersion":1,"mode":"TEST","idempotencyKey":"host-worker","input":{}}' PIECE_UNSUPPORTED_CAPABILITY
run_worker_case wrong-version '{"protocolVersion":1,"requestId":"host-worker","executionId":"host-worker","capabilityId":"hubspot.get_contact","capabilityVersion":2,"mode":"TEST","idempotencyKey":"host-worker","input":{"contactId":"contact"}}' PIECE_UNSUPPORTED_CAPABILITY
for override in buildId piecePackage pieceVersion actionId hostname port authProjection sandboxImage; do
  run_worker_case "override-${override}" "${BASE_REQUEST%?},\"$override\":\"attacker\"}" PIECE_INVALID_INPUT
done

OVERSIZED_REQUEST="$ARTIFACT_DIR/oversized-request.json"
{
  printf '{"request":{"protocolVersion":1,"requestId":"host-large","executionId":"host-large","capabilityId":"hubspot.get_contact","capabilityVersion":1,"mode":"TEST","idempotencyKey":"host-large","input":{"contactId":"contact","padding":"'
  head -c 70000 /dev/zero | tr '\0' x
  printf '"}},"credentialBase64":"%s"}' "$CANARY_B64"
} | docker run --rm --interactive --name "${PREFIX}worker-large" --label "$LABEL" --network none $(sandbox_args) "$SANDBOX_IMAGE" >"$OVERSIZED_REQUEST"
grep -q '"errorCode":"PIECE_INVALID_INPUT"' "$OVERSIZED_REQUEST" || fail 'Oversized request was not rejected.'
{
  printf '{"request":%s,"credentialBase64":"' "$BASE_REQUEST"
  head -c 24000 /dev/zero | tr '\0' A
  printf '"}'
} | docker run --rm --interactive --name "${PREFIX}worker-large-credential" --label "$LABEL" --network none $(sandbox_args) "$SANDBOX_IMAGE" >"$ARTIFACT_DIR/oversized-credential.json"
grep -q '"errorCode":"PIECE_INVALID_CREDENTIAL"' "$ARTIFACT_DIR/oversized-credential.json" || fail 'Oversized credential was not rejected.'

run_acceptance_probe filesystem filesystem '"rootWriteDenied":true'
run_acceptance_probe child child '"startedAtMostPidLimit":true'
run_acceptance_probe network network '"host_lan":true'
run_acceptance_probe temp-first temp-write '"written":true'
run_acceptance_probe temp-second temp-check '"previousTempVisible":false'

docker run --rm --name "${PREFIX}negative-runtime" --label "$LABEL" --network none $(sandbox_args) \
  --entrypoint node "$ACCEPTANCE_IMAGE" /acceptance/negative-probe.mjs >"$ARTIFACT_DIR/negative-runtime.json"
grep -q '"wrongClassification":"PIECE_ACTION_NOT_ALLOWED"' "$ARTIFACT_DIR/negative-runtime.json"
grep -q '"responseCeiling":"PIECE_RESPONSE_INVALID"' "$ARTIFACT_DIR/negative-runtime.json"
grep -q '"timeout":"PIECE_TIMEOUT"' "$ARTIFACT_DIR/negative-runtime.json"
grep -q '"unsafeDnsDenied":true' "$ARTIFACT_DIR/negative-runtime.json"

for scenario in wrong-sni missing-sni wrong-port; do
  docker run --rm --name "${PREFIX}tls-${scenario}" --label "$LABEL" --network "$INTERNAL_NETWORK" \
    --add-host "api.hubapi.com:$GATEWAY_INTERNAL_IP" $(sandbox_args) \
    --entrypoint node "$ACCEPTANCE_IMAGE" /acceptance/tls-probe.mjs "$scenario" >"$ARTIFACT_DIR/tls-${scenario}.json"
  grep -Eq 'connection_rejected|timeout' "$ARTIFACT_DIR/tls-${scenario}.json" || fail "TLS scenario $scenario lacked rejection evidence."
done

if docker run --rm --name "${PREFIX}crash" --label "$LABEL" --network none $(sandbox_args) \
  --entrypoint node "$ACCEPTANCE_IMAGE" /acceptance/runtime-probe.mjs crash >/dev/null 2>&1; then fail 'Crash probe unexpectedly succeeded.'; fi
if timeout 25 docker run --rm --name "${PREFIX}oom" --label "$LABEL" --network none $(sandbox_args) \
  --entrypoint node "$ACCEPTANCE_IMAGE" /acceptance/runtime-probe.mjs oom >/dev/null 2>&1; then fail 'OOM probe unexpectedly succeeded.'; fi
if timeout 5 docker run --rm --name "${PREFIX}cpu" --label "$LABEL" --network none $(sandbox_args) \
  --entrypoint node "$ACCEPTANCE_IMAGE" /acceptance/runtime-probe.mjs cpu >/dev/null 2>&1; then fail 'CPU timeout probe unexpectedly succeeded.'; fi

for suffix in one two; do
  docker run --detach --name "${PREFIX}concurrent-${suffix}" --label "$LABEL" --network none $(sandbox_args) \
    --entrypoint node "$ACCEPTANCE_IMAGE" /acceptance/runtime-probe.mjs sleep >/dev/null
done
ID_ONE="$(docker inspect --format '{{.Id}}' "${PREFIX}concurrent-one")"
ID_TWO="$(docker inspect --format '{{.Id}}' "${PREFIX}concurrent-two")"
[[ "$ID_ONE" != "$ID_TWO" ]] || fail 'Concurrent invocations reused a container.'
docker top "${PREFIX}concurrent-one" -eo pid,args >"$ARTIFACT_DIR/process-args.txt"
docker wait "${PREFIX}concurrent-one" "${PREFIX}concurrent-two" >/dev/null
docker rm "${PREFIX}concurrent-one" "${PREFIX}concurrent-two" >/dev/null

CANARY_TWO_B64="$(printf '%s' "$CANARY_TWO" | base64 -w0)"
printf '{"request":%s,"credentialBase64":"%s"}' "$BASE_REQUEST" "$CANARY_TWO_B64" | docker run --rm --interactive \
  --name "${PREFIX}worker-crossover" --label "$LABEL" --network none $(sandbox_args) "$SANDBOX_IMAGE" >"$ARTIFACT_DIR/crossover.json"
grep -Eq '"errorCode":"PIECE_(RUNTIME_FAILED|EGRESS_DENIED|PROVIDER_UNAVAILABLE)"' "$ARTIFACT_DIR/crossover.json" || fail 'Credential crossover execution did not fail safely without provider access.'

for surface in "$ARTIFACT_DIR"/*.json "$ARTIFACT_DIR"/*.txt; do
  [[ "$surface" == "$SURFACE_FILE" ]] && continue
  cat "$surface" >>"$SURFACE_FILE"
done
docker inspect "$GATEWAY" >>"$SURFACE_FILE"
docker logs "$GATEWAY" >>"$SURFACE_FILE" 2>&1
docker image inspect "$SANDBOX_IMAGE" "$GATEWAY_IMAGE" "$ACCEPTANCE_IMAGE" >>"$SURFACE_FILE"
docker history --no-trunc "$SANDBOX_IMAGE" >>"$SURFACE_FILE"
docker history --no-trunc "$GATEWAY_IMAGE" >>"$SURFACE_FILE"
if grep -Fq "$CANARY" "$SURFACE_FILE" || grep -Fq "$CANARY_TWO" "$SURFACE_FILE"; then
  fail 'Synthetic credential plaintext appeared on an inspected surface.'
fi

snapshot_protected "$PROTECTED_AFTER"
cmp -s "$PROTECTED_BEFORE" "$PROTECTED_AFTER" || fail 'A protected production service changed during acceptance.'
runner_auth_check
redis_check

{
  echo 'SOURCE_GATE=PASS'
  echo 'IMAGE_BUILD=PASS'
  echo 'SANDBOX_HARDENING=PASS'
  echo 'GATEWAY_HARDENING=PASS'
  echo 'CREDENTIAL_FREE_TLS_TOPOLOGY=PASS'
  echo 'NEGATIVE_MATRIX=PASS'
  echo 'CONCURRENCY_ISOLATION=PASS'
  echo 'TEMP_STORAGE_CROSSOVER=0'
  echo 'CREDENTIAL_CROSSOVER=0'
  echo 'TOKEN/CREDENTIAL PLAINTEXT OCCURRENCES=0'
  echo 'PROTECTED_SERVICES_UNCHANGED=PASS'
  echo 'RUNNER_UNSIGNED_HTTP=401'
  echo 'REDIS=PONG'
  echo 'PRODUCT_DEPLOYMENT=NOT_PERFORMED_BY_HARNESS'
} >"$REPORT_FILE"

cleanup_resources
STEP5A_CONTAINERS="$(count_labelled containers)"
STEP5A_NETWORKS="$(count_labelled networks)"
STEP5A_IMAGES="$(count_labelled images)"
[[ "$STEP5A_CONTAINERS" == '0' && "$STEP5A_NETWORKS" == '0' && "$STEP5A_IMAGES" == '0' ]] || fail 'Disposable Step 5A resources remain after cleanup.'
cat "$REPORT_FILE"
echo "STEP5A_CONTAINERS=$STEP5A_CONTAINERS"
echo "STEP5A_NETWORKS=$STEP5A_NETWORKS"
echo "STEP5A_IMAGES=$STEP5A_IMAGES"
echo 'STEP5A HOST ACCEPTANCE=PASS'
rm -rf -- "$ARTIFACT_DIR"
