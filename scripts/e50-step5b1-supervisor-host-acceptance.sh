#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
ACCEPTED_STEP5A='353b2c4821b1b959aeb7f485beade3a5eaf219fd'
EXPECTED_ORIGIN_MAIN='20c23d7e85123eaa77a916ce43f4a9ef5ca8a5e7'
OWNER_LABEL='crazyloops.runtime=piece-runtime-supervisor-v1'
OWNER_LABEL_VALUE='piece-runtime-supervisor-v1'
RESOURCE_LABEL='crazyloops.resource=invocation'
SUPERVISOR_RESOURCE_LABEL='crazyloops.resource=supervisor'
SUPERVISOR_NAME='cl-piece-step5b1-supervisor'
CONTROL_INIT_HELPER_NAME='cl-piece-step5b1-control-init'
CONTROL_RESTORE_HELPER_NAME='cl-piece-step5b1-control-restore'
UDS_HEALTH_CLIENT_NAME='cl-piece-step5b1-uds-health'
UDS_EXECUTE_CLIENT_NAME='cl-piece-step5b1-uds-execute'
ACCEPTANCE_HELPER_LABEL='crazyloops.acceptance=step5b1-control-helper'
STALE_CONTAINER_NAME='cl-piece-step5b1-stale'
STALE_NETWORK_NAME='cl-piece-step5b1-stale-network'
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
SUPERVISOR_CREATED=0
STALE_CONTAINER_CREATED=0
STALE_NETWORK_CREATED=0
UNRELATED_NETWORK_CREATED=0
SUPERVISOR_IMAGE_BUILT_BY_HARNESS=0
GATEWAY_IMAGE_BUILT_BY_HARNESS=0
SANDBOX_IMAGE_BUILT_BY_HARNESS=0
HOST_INVOCATION_STARTED=0
WORKER_FAILURE_INVOCATION_STARTED=0
CONTROL_DIR_RUNTIME_OWNED=0
UDS_HEALTH_CLIENT_CREATED=0
EXECUTE_PID=''
OBSERVATION_GATEWAY_NAME=''
OBSERVATION_GATEWAY_ID=''
OBSERVATION_INVOCATION_ID=''
OBSERVATION_GATEWAY_PAUSED=0
OBSERVATION_SUPERVISOR_ID=''
OBSERVATION_SUPERVISOR_PAUSED=0
OBSERVATION_WATCHER_PID=''
OBSERVATION_HELD=0
OBSERVATION_RELEASED=0
READY_TRANSITION_TIMEOUT_MS=750
HOST_REQUEST_ID='step5b1-host-invocation'
WORKER_FAILURE_REQUEST_ID='step5b1-negative-worker'
HOST_INVOCATION_ID=''
WORKER_FAILURE_INVOCATION_ID=''
UDS_CLIENT_SOURCE=''

fail() {
  echo "STEP5B1 HOST ACCEPTANCE FAILED: $*" >&2
  exit 1
}

remove_acceptance_supervisor_exact() {
  local name="$1"
  local expected_id="${2:-}"
  local id
  local labels
  docker inspect "$name" >/dev/null 2>&1 || return 0
  id="$(docker inspect --format '{{.Id}}' "$name" 2>/dev/null)" || return 1
  [[ -z "$expected_id" || "$id" == "$expected_id" ]] || return 1
  labels="$(docker inspect --format '{{index .Config.Labels "crazyloops.runtime"}}|{{index .Config.Labels "crazyloops.resource"}}' "$id" 2>/dev/null)" || return 1
  [[ "$labels" == "$OWNER_LABEL_VALUE|supervisor" ]] || return 1
  docker rm -f "$id" >/dev/null 2>&1
}

remove_acceptance_container_exact() {
  local name="$1"
  local expected_invocation="$2"
  local labels
  docker inspect "$name" >/dev/null 2>&1 || return 0
  labels="$(docker inspect --format '{{index .Config.Labels "crazyloops.runtime"}}|{{index .Config.Labels "crazyloops.resource"}}|{{index .Config.Labels "crazyloops.invocation"}}' "$name" 2>/dev/null)" || return 1
  [[ "$labels" == "$OWNER_LABEL_VALUE|invocation|$expected_invocation" ]] || return 1
  docker rm -f "$name" >/dev/null 2>&1
}

remove_acceptance_network_exact() {
  local name="$1"
  local expected_invocation="$2"
  local labels
  docker network inspect "$name" >/dev/null 2>&1 || return 0
  labels="$(docker network inspect --format '{{index .Labels "crazyloops.runtime"}}|{{index .Labels "crazyloops.resource"}}|{{index .Labels "crazyloops.invocation"}}' "$name" 2>/dev/null)" || return 1
  [[ "$labels" == "$OWNER_LABEL_VALUE|invocation|$expected_invocation" ]] || return 1
  docker network rm "$name" >/dev/null 2>&1
}

remove_unrelated_acceptance_network_exact() {
  docker network inspect "$UNRELATED_NETWORK" >/dev/null 2>&1 || return 0
  [[ "$(docker network inspect --format '{{index .Labels "crazyloops.runtime"}}' "$UNRELATED_NETWORK" 2>/dev/null)" == 'unrelated-proof' ]] || return 1
  docker network rm "$UNRELATED_NETWORK" >/dev/null 2>&1
}

remove_acceptance_image_exact() {
  local image="$1"
  docker image inspect "$image" >/dev/null 2>&1 || return 0
  [[ "$(docker image inspect --format '{{index .Config.Labels "crazyloops.runtime"}}' "$image" 2>/dev/null)" == "$OWNER_LABEL_VALUE" ]] || return 1
  docker image rm -f "$image" >/dev/null 2>&1
}

remove_acceptance_helper_exact() {
  local name="$1"
  docker inspect "$name" >/dev/null 2>&1 || return 0
  [[ "$(docker inspect --format '{{index .Config.Labels "crazyloops.acceptance"}}' "$name" 2>/dev/null)" == 'step5b1-control-helper' ]] || return 1
  docker rm -f "$name" >/dev/null 2>&1
}

run_control_ownership_helper() {
  local name="$1"
  local owner="$2"
  docker run --rm --name "$name" --label "$ACCEPTANCE_HELPER_LABEL" \
    --network none --read-only --cap-drop=ALL --cap-add=CHOWN \
    --security-opt=no-new-privileges --pids-limit=8 \
    --memory=33554432 --memory-swap=33554432 --cpus=0.1 --user=0:0 \
    --mount type=bind,src="$CONTROL_DIR",dst=/control \
    --entrypoint /usr/bin/chown "$SUPERVISOR_IMAGE" "$owner" /control >/dev/null
}

restore_control_dir_ownership() {
  [[ "$CONTROL_DIR_RUNTIME_OWNED" == '1' && -d "$CONTROL_DIR" ]] || return 0
  remove_acceptance_helper_exact "$CONTROL_RESTORE_HELPER_NAME" || return 1
  run_control_ownership_helper "$CONTROL_RESTORE_HELPER_NAME" "$HOST_UID:$HOST_GID" || return 1
  [[ "$(stat -c '%u:%g' "$CONTROL_DIR")" == "$HOST_UID:$HOST_GID" ]] || return 1
  CONTROL_DIR_RUNTIME_OWNED=0
}

acceptance_invocation_container_id_is_exact() {
  local id="$1"
  local name="$2"
  local invocation="$3"
  local identity
  identity="$(docker inspect --format '{{.Name}}|{{index .Config.Labels "crazyloops.runtime"}}|{{index .Config.Labels "crazyloops.resource"}}|{{index .Config.Labels "crazyloops.invocation"}}' "$id" 2>/dev/null)" || return 1
  [[ "$identity" == "/$name|$OWNER_LABEL_VALUE|invocation|$invocation" ]]
}

acceptance_invocation_container_id_exact() {
  local name="$1"
  local invocation="$2"
  local id
  id="$(docker inspect --format '{{.Id}}' "$name" 2>/dev/null)" || return 1
  acceptance_invocation_container_id_is_exact "$id" "$name" "$invocation" || return 1
  printf '%s\n' "$id"
}

acceptance_supervisor_id_is_exact() {
  local id="$1"
  local name="$2"
  local identity
  identity="$(docker inspect --format '{{.Name}}|{{index .Config.Labels "crazyloops.runtime"}}|{{index .Config.Labels "crazyloops.resource"}}' "$id" 2>/dev/null)" || return 1
  [[ "$identity" == "/$name|$OWNER_LABEL_VALUE|supervisor" ]]
}

pause_acceptance_gateway_exact() {
  local id="$1"
  local name="$2"
  local invocation="$3"
  acceptance_invocation_container_id_is_exact "$id" "$name" "$invocation" || return 1
  [[ "$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}' "$id" 2>/dev/null)" == 'true|false' ]] || return 1
  docker pause "$id" >/dev/null || return 1
  acceptance_invocation_container_id_is_exact "$id" "$name" "$invocation" || return 1
  [[ "$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}' "$id" 2>/dev/null)" == 'true|true' ]]
}

unpause_acceptance_gateway_exact() {
  local id="$1"
  local name="$2"
  local invocation="$3"
  docker inspect "$id" >/dev/null 2>&1 || return 0
  acceptance_invocation_container_id_is_exact "$id" "$name" "$invocation" || return 1
  if [[ "$(docker inspect --format '{{.State.Paused}}' "$id" 2>/dev/null)" == 'true' ]]; then
    docker unpause "$id" >/dev/null || return 1
  fi
  docker inspect "$id" >/dev/null 2>&1 || return 0
  acceptance_invocation_container_id_is_exact "$id" "$name" "$invocation" || return 1
  [[ "$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}' "$id" 2>/dev/null)" == 'true|false' ]]
}

pause_acceptance_supervisor_exact() {
  local id="$1"
  local name="$2"
  acceptance_supervisor_id_is_exact "$id" "$name" || return 1
  [[ "$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}' "$id" 2>/dev/null)" == 'true|false' ]] || return 1
  docker pause "$id" >/dev/null || return 1
  acceptance_supervisor_id_is_exact "$id" "$name" || return 1
  [[ "$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}' "$id" 2>/dev/null)" == 'true|true' ]]
}

unpause_acceptance_supervisor_exact() {
  local id="$1"
  local name="$2"
  docker inspect "$id" >/dev/null 2>&1 || return 0
  acceptance_supervisor_id_is_exact "$id" "$name" || return 1
  if [[ "$(docker inspect --format '{{.State.Paused}}' "$id" 2>/dev/null)" == 'true' ]]; then
    docker unpause "$id" >/dev/null || return 1
  fi
  docker inspect "$id" >/dev/null 2>&1 || return 0
  acceptance_supervisor_id_is_exact "$id" "$name" || return 1
  [[ "$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}' "$id" 2>/dev/null)" == 'true|false' ]]
}

remove_acceptance_invocation_container_id_exact() {
  local id="$1"
  local name="$2"
  local invocation="$3"
  docker inspect "$id" >/dev/null 2>&1 || return 0
  acceptance_invocation_container_id_is_exact "$id" "$name" "$invocation" || return 1
  docker rm -f "$id" >/dev/null 2>&1
}

stop_observation_watcher() {
  [[ -n "$OBSERVATION_WATCHER_PID" ]] || return 0
  if kill -0 "$OBSERVATION_WATCHER_PID" >/dev/null 2>&1; then
    kill "$OBSERVATION_WATCHER_PID" >/dev/null 2>&1 || true
  fi
  wait "$OBSERVATION_WATCHER_PID" >/dev/null 2>&1 || true
  OBSERVATION_WATCHER_PID=''
}

release_observation_gateway_for_cleanup() {
  if [[ -z "$OBSERVATION_GATEWAY_ID" && -s "$ARTIFACT_DIR/observation-gateway-id.txt" ]]; then
    OBSERVATION_GATEWAY_ID="$(<"$ARTIFACT_DIR/observation-gateway-id.txt")"
  fi
  [[ -n "$OBSERVATION_GATEWAY_ID" && -n "$OBSERVATION_GATEWAY_NAME" && -n "$OBSERVATION_INVOCATION_ID" ]] || return 0
  if docker inspect "$OBSERVATION_GATEWAY_ID" >/dev/null 2>&1; then
    acceptance_invocation_container_id_is_exact "$OBSERVATION_GATEWAY_ID" "$OBSERVATION_GATEWAY_NAME" "$OBSERVATION_INVOCATION_ID" || return 1
    unpause_acceptance_gateway_exact "$OBSERVATION_GATEWAY_ID" "$OBSERVATION_GATEWAY_NAME" "$OBSERVATION_INVOCATION_ID" || return 1
  fi
  OBSERVATION_GATEWAY_PAUSED=0
}

release_observation_supervisor_for_cleanup() {
  [[ -n "$OBSERVATION_SUPERVISOR_ID" ]] || return 0
  if docker inspect "$OBSERVATION_SUPERVISOR_ID" >/dev/null 2>&1; then
    acceptance_supervisor_id_is_exact "$OBSERVATION_SUPERVISOR_ID" "$SUPERVISOR_NAME" || return 1
    unpause_acceptance_supervisor_exact "$OBSERVATION_SUPERVISOR_ID" "$SUPERVISOR_NAME" || return 1
  fi
  OBSERVATION_SUPERVISOR_PAUSED=0
}

stop_execute_process() {
  [[ -n "$EXECUTE_PID" ]] || return 0
  if kill -0 "$EXECUTE_PID" >/dev/null 2>&1; then
    kill "$EXECUTE_PID" >/dev/null 2>&1 || true
  fi
  wait "$EXECUTE_PID" >/dev/null 2>&1 || true
  EXECUTE_PID=''
}

remove_invocation_topology_exact() {
  local invocation="$1"
  local expected_gateway_id="${2:-}"
  [[ -n "$invocation" ]] || return 0
  remove_acceptance_container_exact "cl-piece-sandbox-$invocation" "$invocation" || true
  if [[ -n "$expected_gateway_id" ]]; then
    remove_acceptance_invocation_container_id_exact "$expected_gateway_id" "cl-piece-gateway-$invocation" "$invocation" || true
  else
    remove_acceptance_container_exact "cl-piece-gateway-$invocation" "$invocation" || true
  fi
  remove_acceptance_network_exact "cl-piece-internal-$invocation" "$invocation" || true
  remove_acceptance_network_exact "cl-piece-egress-$invocation" "$invocation" || true
}

cleanup() {
  stop_observation_watcher || true
  release_observation_gateway_for_cleanup || true
  release_observation_supervisor_for_cleanup || true
  stop_execute_process || true
  if [[ "$HOST_INVOCATION_STARTED" == '1' ]]; then remove_invocation_topology_exact "$HOST_INVOCATION_ID" "$OBSERVATION_GATEWAY_ID"; fi
  if [[ "$WORKER_FAILURE_INVOCATION_STARTED" == '1' ]]; then remove_invocation_topology_exact "$WORKER_FAILURE_INVOCATION_ID"; fi
  if [[ "$SUPERVISOR_CREATED" == '1' ]]; then remove_acceptance_supervisor_exact "$SUPERVISOR_NAME" "$OBSERVATION_SUPERVISOR_ID" || true; fi
  if [[ "$STALE_CONTAINER_CREATED" == '1' ]]; then remove_acceptance_container_exact "$STALE_CONTAINER_NAME" 'stale-proof' || true; fi
  if [[ "$STALE_NETWORK_CREATED" == '1' ]]; then remove_acceptance_network_exact "$STALE_NETWORK_NAME" 'stale-proof' || true; fi
  if [[ "$UNRELATED_NETWORK_CREATED" == '1' ]]; then remove_unrelated_acceptance_network_exact || true; fi
  remove_acceptance_helper_exact "$UDS_HEALTH_CLIENT_NAME" || true
  remove_acceptance_helper_exact "$UDS_EXECUTE_CLIENT_NAME" || true
  remove_acceptance_helper_exact "$CONTROL_INIT_HELPER_NAME" || true
  remove_acceptance_helper_exact "$CONTROL_RESTORE_HELPER_NAME" || true
  if [[ -d "$CONTROL_DIR" && "$(stat -c '%u:%g' "$CONTROL_DIR" 2>/dev/null || true)" == '65532:65532' ]]; then
    CONTROL_DIR_RUNTIME_OWNED=1
  fi
  restore_control_dir_ownership || true
  rm -rf -- "$CONTROL_DIR" "$ARTIFACT_DIR" || true
  if [[ "$SUPERVISOR_IMAGE_BUILT_BY_HARNESS" == '1' ]]; then remove_acceptance_image_exact "$SUPERVISOR_IMAGE" || true; fi
  if [[ "$GATEWAY_IMAGE_BUILT_BY_HARNESS" == '1' ]]; then remove_acceptance_image_exact "$GATEWAY_IMAGE" || true; fi
  if [[ "$SANDBOX_IMAGE_BUILT_BY_HARNESS" == '1' ]]; then remove_acceptance_image_exact "$SANDBOX_IMAGE" || true; fi
}
trap cleanup EXIT INT TERM

UDS_CLIENT_SOURCE="$(cat <<'NODE'
const http = require('node:http');

const MAX_INPUT_BYTES = 96 * 1024;
const MAX_OUTPUT_BYTES = 192 * 1024;
const method = process.argv[1];
const timeoutMs = Number(process.argv[2]);

async function readBoundedInput() {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const value of process.stdin) {
      const chunk = Buffer.from(value);
      if (bytes + chunk.length > MAX_INPUT_BYTES) {
        chunk.fill(0);
        throw new Error('input_limit');
      }
      bytes += chunk.length;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function send(body) {
  return new Promise((resolve, reject) => {
    const responseChunks = [];
    let responseBytes = 0;
    let settled = false;
    const zeroResponse = () => {
      for (const chunk of responseChunks) chunk.fill(0);
      responseChunks.length = 0;
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      zeroResponse();
      if (error) reject(error); else resolve();
    };
    const headers = { Connection: 'close' };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(body.length);
    }
    const request = http.request({
      socketPath: '/control/piece-supervisor.sock',
      path: method === 'GET' ? '/v1/health' : '/v1/execute',
      method,
      headers,
    }, (response) => {
      response.on('data', (value) => {
        const chunk = Buffer.from(value);
        if (responseBytes + chunk.length > MAX_OUTPUT_BYTES) {
          chunk.fill(0);
          response.destroy();
          finish(new Error('output_limit'));
          return;
        }
        responseBytes += chunk.length;
        responseChunks.push(chunk);
      });
      response.once('aborted', () => finish(new Error('response_aborted')));
      response.once('error', () => finish(new Error('response_error')));
      response.once('end', () => {
        if (settled) return;
        const output = Buffer.concat(responseChunks, responseBytes);
        zeroResponse();
        process.stdout.write(output, (error) => {
          output.fill(0);
          finish(error || null);
        });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
    request.once('error', () => finish(new Error('request_error')));
    if (method === 'POST') request.end(body); else request.end();
  });
}

async function main() {
  if (!['GET', 'POST'].includes(method) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) {
    process.exitCode = 1;
    return;
  }
  let body = Buffer.alloc(0);
  try {
    if (method === 'POST') body = await readBoundedInput();
    await send(body);
  } catch {
    process.exitCode = 1;
  } finally {
    body.fill(0);
  }
}

void main();
NODE
)"

snapshot_protected() {
  local output="$1"
  : >"$output"
  for name in "${PROTECTED[@]}"; do
    docker inspect --format '{{.Name}}|{{.Id}}|{{.RestartCount}}|{{.State.Status}}|{{json .NetworkSettings.Networks}}|{{json .NetworkSettings.Ports}}|{{json .Mounts}}' "$name" >>"$output"
  done
}

validate_uds_client_inspect() {
  local inspect_file="$1"
  node - "$inspect_file" "$CONTROL_DIR" <<'NODE'
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))[0];
const host = value.HostConfig;
if (value.Config.User !== '65532:65532') throw new Error('client user');
if (value.Config.Labels?.['crazyloops.acceptance'] !== 'step5b1-control-helper') throw new Error('client label');
if (host.NetworkMode !== 'none' || Object.keys(host.PortBindings ?? {}).length || value.Config.ExposedPorts) throw new Error('client network');
if (!host.ReadonlyRootfs || host.Privileged || JSON.stringify(host.CapDrop) !== JSON.stringify(['ALL']) || (host.CapAdd ?? []).length) throw new Error('client privileges');
if (!(host.SecurityOpt ?? []).some((value) => value.startsWith('no-new-privileges'))) throw new Error('client no-new-privileges');
if (host.PidsLimit !== 16 || host.Memory !== 67108864 || host.MemorySwap !== 67108864 || host.NanoCpus !== 250000000) throw new Error('client limits');
if (host.AutoRemove !== true) throw new Error('client auto-remove');
if ((value.Config.Env ?? []).some((entry) => /(?:secret|token|credential)/i.test(entry))) throw new Error('client environment');
if (value.Mounts.length !== 1) throw new Error('client mounts');
const mount = value.Mounts[0];
if (mount.Source !== process.argv[3] || mount.Destination !== '/control' || mount.RW !== false) throw new Error('client control mount');
if (JSON.stringify(value).includes('/var/run/docker.sock')) throw new Error('client docker socket');
NODE
}

create_health_client() {
  docker create --rm --name "$UDS_HEALTH_CLIENT_NAME" --label "$ACCEPTANCE_HELPER_LABEL" \
    --network none --read-only --cap-drop=ALL --security-opt=no-new-privileges \
    --pids-limit=16 --memory=67108864 --memory-swap=67108864 --cpus=0.25 \
    --user=65532:65532 \
    --mount type=bind,src="$CONTROL_DIR",dst=/control,readonly \
    --entrypoint node "$SUPERVISOR_IMAGE" -e "$UDS_CLIENT_SOURCE" GET 3000 >/dev/null
  UDS_HEALTH_CLIENT_CREATED=1
  docker inspect "$UDS_HEALTH_CLIENT_NAME" >"$ARTIFACT_DIR/uds-client-inspect.json"
  validate_uds_client_inspect "$ARTIFACT_DIR/uds-client-inspect.json"
}

create_execute_client() {
  local inspect_file="$1"
  docker create --rm --interactive --name "$UDS_EXECUTE_CLIENT_NAME" --label "$ACCEPTANCE_HELPER_LABEL" \
    --network none --read-only --cap-drop=ALL --security-opt=no-new-privileges \
    --pids-limit=16 --memory=67108864 --memory-swap=67108864 --cpus=0.25 \
    --user=65532:65532 \
    --mount type=bind,src="$CONTROL_DIR",dst=/control,readonly \
    --entrypoint node "$SUPERVISOR_IMAGE" -e "$UDS_CLIENT_SOURCE" POST 15000 >/dev/null
  docker inspect "$UDS_EXECUTE_CLIENT_NAME" >"$inspect_file"
  validate_uds_client_inspect "$inspect_file"
}

start_execute_client() {
  local input="$1"
  local output="$2"
  docker start --attach --interactive "$UDS_EXECUTE_CLIENT_NAME" <"$input" >"$output"
}

health() {
  create_health_client
  docker start --attach "$UDS_HEALTH_CLIENT_NAME"
  UDS_HEALTH_CLIENT_CREATED=0
}

execute_file() {
  local input="$1"
  local output="$2"
  create_execute_client "$ARTIFACT_DIR/uds-execute-client-latest-inspect.json"
  start_execute_client "$input" "$output"
}

gateway_ready_event_is_exact() {
  local log_file="$1"
  local request_id="$2"
  node - "$log_file" "$request_id" <<'NODE'
const fs = require('node:fs');
const events = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const ready = events.find((event) => event.event === 'piece_gateway_ready');
if (!ready || ready.requestId !== process.argv[3] || ready.capabilityId !== 'hubspot.get_contact') process.exit(1);
if (!Array.isArray(ready.destinations) || ready.destinations.length !== 1) process.exit(1);
const [destination] = ready.destinations;
if (destination.hostname !== 'api.hubapi.com' || destination.port !== 443 || destination.protocol !== 'tls') process.exit(1);
NODE
}

wait_for_gateway_start_and_pause() {
  local name="$1"
  local invocation="$2"
  local id_output="$3"
  local id
  local deadline=$((SECONDS + 5))
  while (( SECONDS < deadline )); do
    if docker inspect "$name" >/dev/null 2>&1; then
      id="$(acceptance_invocation_container_id_exact "$name" "$invocation")" || return 1
      if [[ "$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}' "$id" 2>/dev/null)" == 'true|false' ]]; then
        pause_acceptance_gateway_exact "$id" "$name" "$invocation" || return 1
        printf '%s\n' "$id" >"$id_output"
        return 0
      fi
    fi
    sleep 0.01
  done
  return 1
}

start_gateway_log_watcher() {
  local id="$1"
  local output="$2"
  timeout --signal=TERM --kill-after=2s 25s docker logs --follow "$id" >"$output" 2>&1 &
  OBSERVATION_WATCHER_PID=$!
  kill -0 "$OBSERVATION_WATCHER_PID" >/dev/null 2>&1 || return 1
  ps -o pid=,args= -p "$OBSERVATION_WATCHER_PID" >"$ARTIFACT_DIR/observation-watcher-process.txt"
}

hold_gateway_after_ready() {
  local gateway_id="$1"
  local gateway_name="$2"
  local invocation="$3"
  local supervisor_id="$4"
  local supervisor_name="$5"
  local request_id="$6"
  local log_file="$7"
  local ready=0
  local started_ms
  local now_ms
  local deadline_ms

  acceptance_invocation_container_id_is_exact "$gateway_id" "$gateway_name" "$invocation" || return 1
  acceptance_supervisor_id_is_exact "$supervisor_id" "$supervisor_name" || return 1
  [[ "$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}' "$gateway_id" 2>/dev/null)" == 'true|true' ]] || return 1
  [[ "$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}' "$supervisor_id" 2>/dev/null)" == 'true|true' ]] || return 1
  ! grep -Fq '"event":"piece_gateway_ready"' "$log_file" 2>/dev/null || return 1

  unpause_acceptance_gateway_exact "$gateway_id" "$gateway_name" "$invocation" || return 1
  OBSERVATION_GATEWAY_PAUSED=0
  started_ms="$(date +%s%3N)"
  deadline_ms=$((started_ms + READY_TRANSITION_TIMEOUT_MS))
  while :; do
    if grep -Fq '"event":"piece_gateway_ready"' "$log_file" 2>/dev/null; then
      gateway_ready_event_is_exact "$log_file" "$request_id" || return 1
      ready=1
      break
    fi
    kill -0 "$OBSERVATION_WATCHER_PID" >/dev/null 2>&1 || return 1
    now_ms="$(date +%s%3N)"
    (( now_ms < deadline_ms )) || break
    sleep 0.005
  done

  [[ "$ready" == '1' ]] || return 1
  pause_acceptance_gateway_exact "$gateway_id" "$gateway_name" "$invocation" || return 1
  OBSERVATION_GATEWAY_PAUSED=1
  acceptance_invocation_container_id_is_exact "$gateway_id" "$gateway_name" "$invocation" || return 1
  acceptance_supervisor_id_is_exact "$supervisor_id" "$supervisor_name" || return 1
  [[ "$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}' "$gateway_id" 2>/dev/null)" == 'true|true' ]] || return 1
  [[ "$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}' "$supervisor_id" 2>/dev/null)" == 'true|true' ]] || return 1
  printf 'OBSERVATION_HELD\n' >"$ARTIFACT_DIR/observation-held.txt"
  OBSERVATION_HELD=1
}

wait_for_sandbox_running_exact() {
  local name="$1"
  local invocation="$2"
  local deadline=$((SECONDS + 5))
  while (( SECONDS < deadline )); do
    if docker inspect "$name" >/dev/null 2>&1; then
      acceptance_invocation_container_id_exact "$name" "$invocation" >/dev/null || return 1
      [[ "$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null)" == 'true' ]] && return 0
    fi
    sleep 0.01
  done
  return 1
}

wait_for_execute_client_running() {
  local deadline=$((SECONDS + 5))
  while (( SECONDS < deadline )); do
    if docker inspect "$UDS_EXECUTE_CLIENT_NAME" >/dev/null 2>&1; then
      [[ "$(docker inspect --format '{{index .Config.Labels "crazyloops.acceptance"}}|{{.State.Running}}' "$UDS_EXECUTE_CLIENT_NAME" 2>/dev/null)" == 'step5b1-control-helper|true' ]] && return 0
    fi
    sleep 0.01
  done
  return 1
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
[[ "$(git rev-parse origin/main)" == "$EXPECTED_ORIGIN_MAIN" ]] || fail 'origin/main changed from the reviewed production baseline.'
while IFS= read -r file; do
  [[ "$file" =~ ^(services/piece-runtime/(Dockerfile\.supervisor|src/(docker-client|docker-piece-container-engine|supervisor-constants|supervisor-errors|supervisor-protocol|supervisor-service|supervisor-server|supervisor)\.mjs)|scripts/e50-step5b1-supervisor-host-acceptance\.sh|docs/piece-runtime/SUPERVISOR_V1\.md|tests/essential-fifty-step-five-b-supervisor\.test\.ts)$ ]] || fail "Out-of-scope file: $file"
done < <(git diff --name-only "$ACCEPTED_STEP5A..HEAD")

command -v docker >/dev/null || fail 'Docker is required.'
command -v curl >/dev/null || fail 'curl is required.'
command -v sha256sum >/dev/null || fail 'sha256sum is required.'
[[ -S /var/run/docker.sock ]] || fail 'Docker Engine socket is unavailable.'
[[ "$(count_active_supervisors)" == '0' ]] || fail 'No already-running Step 5B.1 supervisor may exist before acceptance.'
for helper_name in "$CONTROL_INIT_HELPER_NAME" "$CONTROL_RESTORE_HELPER_NAME" "$UDS_HEALTH_CLIENT_NAME" "$UDS_EXECUTE_CLIENT_NAME"; do
  if docker inspect "$helper_name" >/dev/null 2>&1; then
    remove_acceptance_helper_exact "$helper_name" || fail "Unexpected same-named container is outside harness cleanup authority: $helper_name"
  fi
  ! docker inspect "$helper_name" >/dev/null 2>&1 || fail "Acceptance helper name is unavailable: $helper_name"
done
HOST_INVOCATION_ID="$(printf '%s' "$HOST_REQUEST_ID" | sha256sum | cut -c1-16)"
WORKER_FAILURE_INVOCATION_ID="$(printf '%s' "$WORKER_FAILURE_REQUEST_ID" | sha256sum | cut -c1-16)"
for acceptance_image in "$SUPERVISOR_IMAGE" "$GATEWAY_IMAGE" "$SANDBOX_IMAGE"; do
  ! docker image inspect "$acceptance_image" >/dev/null 2>&1 || fail "Pre-existing acceptance image tag is outside harness cleanup authority: $acceptance_image"
done
snapshot_protected "$PROTECTED_BEFORE"
for protected_name in "${PROTECTED[@]}"; do assert_no_docker_socket_mount "$protected_name"; done
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --request POST --header 'Content-Type: application/json' --data '{}' http://127.0.0.1:8788/v1/execute)" == '401' ]] || fail 'Connector Runner unsigned JSON check did not return 401.'
[[ "$(docker exec redis redis-cli PING)" == 'PONG' ]] || fail 'Redis did not return PONG.'

docker build --no-cache --label "$OWNER_LABEL" -f services/piece-runtime/Dockerfile.sandbox -t "$SANDBOX_IMAGE" services/piece-runtime >/dev/null
SANDBOX_IMAGE_BUILT_BY_HARNESS=1
docker build --no-cache --label "$OWNER_LABEL" -f services/piece-runtime/Dockerfile.gateway -t "$GATEWAY_IMAGE" services/piece-runtime >/dev/null
GATEWAY_IMAGE_BUILT_BY_HARNESS=1
docker build --no-cache --label "$OWNER_LABEL" -f services/piece-runtime/Dockerfile.supervisor -t "$SUPERVISOR_IMAGE" services/piece-runtime >/dev/null
SUPERVISOR_IMAGE_BUILT_BY_HARNESS=1
docker run --rm --entrypoint node "$SANDBOX_IMAGE" -e 'const p=require("/piece-runtime/node_modules/@activepieces/piece-hubspot/package.json");if(p.version!=="0.8.10")process.exit(1)' || fail 'Reviewed HubSpot package version mismatch.'

docker create --name "$STALE_CONTAINER_NAME" --label "$OWNER_LABEL" --label "$RESOURCE_LABEL" --label 'crazyloops.invocation=stale-proof' --network none "$GATEWAY_IMAGE" >/dev/null
STALE_CONTAINER_CREATED=1
docker network create --label "$OWNER_LABEL" --label "$RESOURCE_LABEL" --label 'crazyloops.invocation=stale-proof' "$STALE_NETWORK_NAME" >/dev/null
STALE_NETWORK_CREATED=1
docker network create --label 'crazyloops.runtime=unrelated-proof' "$UNRELATED_NETWORK" >/dev/null
UNRELATED_NETWORK_CREATED=1

DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
chmod 0750 "$CONTROL_DIR"
run_control_ownership_helper "$CONTROL_INIT_HELPER_NAME" '65532:65532' || fail 'Control directory ownership init helper failed.'
[[ "$(stat -c '%u:%g:%a' "$CONTROL_DIR")" == '65532:65532:750' ]] || fail 'Control directory runtime ownership or mode is invalid.'
CONTROL_DIR_RUNTIME_OWNED=1
docker run --detach --name "$SUPERVISOR_NAME" --label "$OWNER_LABEL" --label "$SUPERVISOR_RESOURCE_LABEL" \
  --env PIECE_SUPERVISOR_CONTAINER_NAME="$SUPERVISOR_NAME" \
  --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=4m \
  --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=32 \
  --memory=268435456 --memory-swap=268435456 --cpus=0.5 --ulimit=nofile=128:128 \
  --user=65532:65532 --group-add "$DOCKER_GID" --log-driver=json-file --log-opt max-size=1m \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount type=bind,src="$CONTROL_DIR",dst=/run/crazyloops-piece \
  "$SUPERVISOR_IMAGE" >/dev/null
SUPERVISOR_CREATED=1

mapfile -t active_supervisors < <(active_supervisor_ids)
[[ "${#active_supervisors[@]}" == '1' ]] || fail 'Exactly one active Step 5B.1 supervisor was not proven.'
SUPERVISOR_DOCKER_ID="$(docker inspect --format '{{.Id}}' "$SUPERVISOR_NAME")"
[[ "${active_supervisors[0]}" == "$SUPERVISOR_DOCKER_ID" ]] || fail 'Active supervisor does not match its inspected self Docker identity.'
OBSERVATION_SUPERVISOR_ID="$SUPERVISOR_DOCKER_ID"
acceptance_supervisor_id_is_exact "$OBSERVATION_SUPERVISOR_ID" "$SUPERVISOR_NAME" || fail 'Acceptance supervisor identity or labels are invalid.'

SOCKET_READY=0
for _ in $(seq 1 100); do
  if docker exec "$SUPERVISOR_NAME" node -e 'const fs=require("node:fs");const s=fs.statSync("/run/crazyloops-piece/piece-supervisor.sock");if(!s.isSocket())process.exit(1)' >/dev/null 2>&1; then
    SOCKET_READY=1
    break
  fi
  sleep 0.05
done
[[ "$SOCKET_READY" == '1' ]] || fail 'Supervisor UDS was not created.'
SOCKET_AND_DIR_MODES="$(docker exec "$SUPERVISOR_NAME" node -e 'const fs=require("node:fs");const mode=(path)=>(fs.statSync(path).mode&0o777).toString(8);process.stdout.write(`${mode("/run/crazyloops-piece/piece-supervisor.sock")}:${mode("/run/crazyloops-piece")}`)')"
[[ "$SOCKET_AND_DIR_MODES" == '660:750' ]] || fail 'Supervisor socket or control directory mode is invalid.'
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
[[ -z "$(docker ps -aq --filter "name=$STALE_CONTAINER_NAME")" ]] || fail 'Owned stale container survived startup cleanup.'
[[ -z "$(docker network ls -q --filter "name=$STALE_NETWORK_NAME")" ]] || fail 'Owned stale network survived startup cleanup.'
STALE_CONTAINER_CREATED=0
STALE_NETWORK_CREATED=0
[[ -n "$(docker network ls -q --filter "name=$UNRELATED_NETWORK")" ]] || fail 'Unrelated network was removed.'

CANARY="E50_STEP5B1_$(openssl rand -hex 32)"
CANARY_B64="$(printf '%s' "$CANARY" | base64 -w0)"
REQUEST_ID="$HOST_REQUEST_ID"
INVOCATION_ID="$HOST_INVOCATION_ID"
SANDBOX_NAME="cl-piece-sandbox-$INVOCATION_ID"
GATEWAY_NAME="cl-piece-gateway-$INVOCATION_ID"
INTERNAL_NAME="cl-piece-internal-$INVOCATION_ID"
EGRESS_NAME="cl-piece-egress-$INVOCATION_ID"
cat >"$ARTIFACT_DIR/request.json" <<JSON
{"protocolVersion":1,"request":{"protocolVersion":1,"requestId":"$REQUEST_ID","executionId":"step5b1-host-execution","capabilityId":"hubspot.get_contact","capabilityVersion":1,"mode":"TEST","idempotencyKey":"step5b1-host-idempotency","input":{"contactId":"synthetic-contact","properties":["firstname"]}},"credentialBase64":"$CANARY_B64"}
JSON
HOST_INVOCATION_STARTED=1
OBSERVATION_GATEWAY_NAME="$GATEWAY_NAME"
OBSERVATION_INVOCATION_ID="$INVOCATION_ID"
create_execute_client "$ARTIFACT_DIR/uds-execute-client-inspect.json"
wait_for_gateway_start_and_pause "$GATEWAY_NAME" "$INVOCATION_ID" "$ARTIFACT_DIR/observation-gateway-id.txt" &
OBSERVATION_WATCHER_PID=$!
ps -o pid=,args= -p "$OBSERVATION_WATCHER_PID" >"$ARTIFACT_DIR/observation-start-watcher-process.txt"
start_execute_client "$ARTIFACT_DIR/request.json" "$ARTIFACT_DIR/response.json" &
EXECUTE_PID=$!
if ! wait "$OBSERVATION_WATCHER_PID"; then
  OBSERVATION_WATCHER_PID=''
  fail 'Exact acceptance gateway could not be held at startup.'
fi
OBSERVATION_WATCHER_PID=''
OBSERVATION_GATEWAY_ID="$(<"$ARTIFACT_DIR/observation-gateway-id.txt")"
acceptance_invocation_container_id_is_exact "$OBSERVATION_GATEWAY_ID" "$GATEWAY_NAME" "$INVOCATION_ID" || fail 'Startup-held gateway identity changed.'
[[ "$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}' "$OBSERVATION_GATEWAY_ID" 2>/dev/null)" == 'true|true' ]] || fail 'Startup gateway hold was not proven.'
OBSERVATION_GATEWAY_PAUSED=1
printf 'STARTUP_GATEWAY_HELD\n' >"$ARTIFACT_DIR/observation-start-held.txt"
start_gateway_log_watcher "$OBSERVATION_GATEWAY_ID" "$ARTIFACT_DIR/live-gateway-logs.txt" || fail 'Bounded gateway log watcher could not attach.'
docker logs "$OBSERVATION_GATEWAY_ID" >"$ARTIFACT_DIR/pre-transition-gateway-logs.txt" 2>&1
! grep -Fq '"event":"piece_gateway_ready"' "$ARTIFACT_DIR/pre-transition-gateway-logs.txt" || fail 'Gateway became ready before the supervisor freeze was established.'
pause_acceptance_supervisor_exact "$OBSERVATION_SUPERVISOR_ID" "$SUPERVISOR_NAME" || fail 'Exact disposable acceptance supervisor could not be frozen.'
OBSERVATION_SUPERVISOR_PAUSED=1
printf 'OBSERVATION_SUPERVISOR_PAUSED\n' >"$ARTIFACT_DIR/observation-supervisor-paused.txt"
hold_gateway_after_ready "$OBSERVATION_GATEWAY_ID" "$GATEWAY_NAME" "$INVOCATION_ID" "$OBSERVATION_SUPERVISOR_ID" "$SUPERVISOR_NAME" "$REQUEST_ID" "$ARTIFACT_DIR/live-gateway-logs.txt" || fail 'Gateway readiness observation barrier was not established.'
[[ "$OBSERVATION_HELD" == '1' && "$OBSERVATION_GATEWAY_PAUSED" == '1' && "$OBSERVATION_SUPERVISOR_PAUSED" == '1' && "$OBSERVATION_RELEASED" == '0' ]] || fail 'Observation held state is invalid.'
unpause_acceptance_supervisor_exact "$OBSERVATION_SUPERVISOR_ID" "$SUPERVISOR_NAME" || fail 'Exact disposable acceptance supervisor could not resume.'
OBSERVATION_SUPERVISOR_PAUSED=0
printf 'OBSERVATION_SUPERVISOR_RESUMED\n' >"$ARTIFACT_DIR/observation-supervisor-resumed.txt"
wait_for_sandbox_running_exact "$SANDBOX_NAME" "$INVOCATION_ID" || fail 'Exact acceptance sandbox did not reach the held topology.'
wait_for_execute_client_running || fail 'UDS execute client did not remain inspectable during the held topology.'

docker inspect "$SANDBOX_NAME" "$GATEWAY_NAME" >"$ARTIFACT_DIR/invocation-inspect.json"
docker network inspect "$INTERNAL_NAME" "$EGRESS_NAME" >"$ARTIFACT_DIR/invocation-networks.json"
docker inspect "$UDS_EXECUTE_CLIENT_NAME" >"$ARTIFACT_DIR/uds-execute-client-inspect.json"
validate_uds_client_inspect "$ARTIFACT_DIR/uds-execute-client-inspect.json"
docker top "$SANDBOX_NAME" -eo pid,args >"$ARTIFACT_DIR/sandbox-processes.txt"
docker top "$GATEWAY_NAME" -eo pid,args >"$ARTIFACT_DIR/gateway-processes.txt"
docker top "$UDS_EXECUTE_CLIENT_NAME" -eo pid,args >"$ARTIFACT_DIR/uds-client-processes.txt"
docker cp "$OBSERVATION_GATEWAY_ID:/etc/hosts" "$ARTIFACT_DIR/gateway-etc-hosts"
! grep -q 'api.hubapi.com' "$ARTIFACT_DIR/gateway-etc-hosts" || fail 'Gateway canonical hostname is shadowed.'
printf 'SAFE\n' >"$ARTIFACT_DIR/gateway-self-shadow.txt"
TOPOLOGY_CAPTURED=1

unpause_acceptance_gateway_exact "$OBSERVATION_GATEWAY_ID" "$GATEWAY_NAME" "$INVOCATION_ID" || fail 'Exact acceptance gateway could not be released.'
[[ "$(docker inspect --format '{{.State.Running}}|{{.State.Paused}}' "$OBSERVATION_GATEWAY_ID" 2>/dev/null)" == 'true|false' ]] || fail 'Exact acceptance gateway release was not proven.'
OBSERVATION_GATEWAY_PAUSED=0
OBSERVATION_RELEASED=1
printf 'OBSERVATION_RELEASED\n' >"$ARTIFACT_DIR/observation-released.txt"
wait "$EXECUTE_PID"
EXECUTE_PID=''
wait "$OBSERVATION_WATCHER_PID" >/dev/null 2>&1 || true
OBSERVATION_WATCHER_PID=''
[[ "$TOPOLOGY_CAPTURED" == '1' && "$OBSERVATION_RELEASED" == '1' ]] || fail 'Topology capture did not complete before gateway release.'
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
WORKER_FAILURE_INVOCATION_STARTED=1
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
  "$ARTIFACT_DIR/uds-client-inspect.json"
  "$ARTIFACT_DIR/uds-execute-client-inspect.json"
  "$ARTIFACT_DIR/uds-execute-client-latest-inspect.json"
  "$ARTIFACT_DIR/invocation-inspect.json"
  "$ARTIFACT_DIR/invocation-networks.json"
  "$ARTIFACT_DIR/live-gateway-logs.txt"
  "$ARTIFACT_DIR/pre-transition-gateway-logs.txt"
  "$ARTIFACT_DIR/observation-gateway-id.txt"
  "$ARTIFACT_DIR/observation-start-watcher-process.txt"
  "$ARTIFACT_DIR/observation-start-held.txt"
  "$ARTIFACT_DIR/observation-watcher-process.txt"
  "$ARTIFACT_DIR/observation-supervisor-paused.txt"
  "$ARTIFACT_DIR/observation-supervisor-resumed.txt"
  "$ARTIFACT_DIR/observation-held.txt"
  "$ARTIFACT_DIR/observation-released.txt"
  "$ARTIFACT_DIR/gateway-etc-hosts"
  "$ARTIFACT_DIR/gateway-self-shadow.txt"
  "$ARTIFACT_DIR/supervisor-processes.txt"
  "$ARTIFACT_DIR/sandbox-processes.txt"
  "$ARTIFACT_DIR/gateway-processes.txt"
  "$ARTIFACT_DIR/uds-client-processes.txt"
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
remove_acceptance_supervisor_exact "$SUPERVISOR_NAME" "$OBSERVATION_SUPERVISOR_ID" || fail 'Exact labelled acceptance supervisor could not be removed.'
SUPERVISOR_CREATED=0
remove_unrelated_acceptance_network_exact || fail 'Exact unrelated acceptance network could not be removed.'
UNRELATED_NETWORK_CREATED=0
! docker inspect "$UDS_HEALTH_CLIENT_NAME" >/dev/null 2>&1 || fail 'UDS health client survived.'
! docker inspect "$UDS_EXECUTE_CLIENT_NAME" >/dev/null 2>&1 || fail 'UDS execute client survived.'
restore_control_dir_ownership || fail 'Control directory ownership restore helper failed.'
[[ ! -e "$SOCKET" ]] || fail 'Supervisor socket survived graceful shutdown.'
rm -rf -- "$CONTROL_DIR" "$ARTIFACT_DIR"
remove_acceptance_image_exact "$SUPERVISOR_IMAGE" || fail 'Harness-built supervisor image could not be removed safely.'
SUPERVISOR_IMAGE_BUILT_BY_HARNESS=0
remove_acceptance_image_exact "$GATEWAY_IMAGE" || fail 'Harness-built gateway image could not be removed safely.'
GATEWAY_IMAGE_BUILT_BY_HARNESS=0
remove_acceptance_image_exact "$SANDBOX_IMAGE" || fail 'Harness-built sandbox image could not be removed safely.'
SANDBOX_IMAGE_BUILT_BY_HARNESS=0
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
DETERMINISTIC_OBSERVATION_BARRIER=PASS
READY_TRANSITION_FREEZE=PASS
OBSERVATION_GATEWAY_RELEASE=PASS
CONCRETE_ENGINE_TOPOLOGY=PASS
DYNAMIC_GATEWAY_IP=PASS
SANDBOX_INTERNAL_ONLY=PASS
GATEWAY_CONTROLLED_EGRESS=PASS
BOUNDED_PROVIDER_FAILURE=PASS
NEGATIVE_MATRIX=PASS
ORPHAN_CLEANUP_SCOPE=PASS
CREDENTIAL_PLAINTEXT_OCCURRENCES=0
CREDENTIAL_BASE64_OCCURRENCES=0
CONTROL_DIR_UID=65532
CONTROL_DIR_GID=65532
CONTROL_DIR_MODE=750
SOCKET_MODE=660
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
trap - EXIT INT TERM
