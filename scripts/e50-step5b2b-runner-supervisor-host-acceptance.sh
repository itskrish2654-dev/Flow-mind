#!/usr/bin/env bash
set -euo pipefail
umask 077

# Owner-only acceptance for the reviewed Linux production-candidate host.
# Codex and CI must not execute this harness.
: "${E50_EXPECTED_COMMIT:?Set E50_EXPECTED_COMMIT to the reviewed branch commit.}"

EXPECTED_BRANCH='codex/e50-step5b2b-owner-host-acceptance-v6'
ACCEPTED_PARENT='5b08c5ebad41cd1740df6aa6938bb42778412432'
EXPECTED_ORIGIN_MAIN='20c23d7e85123eaa77a916ce43f4a9ef5ca8a5e7'
OWNER_LABEL='crazyloops.acceptance=e50-step5b2b-owner-host'
PROTECTED=(crazyloops-connector-runner activepieces-app activepieces-worker-1 redis)

BROKER_NAME='crazyloops-piece-egress-broker'
SUPERVISOR_NAME='cl-piece-step5b2b-supervisor'
RUNNER_NAME='cl-piece-step5b2b-runner'
REDIS_NAME='cl-piece-step5b2b-redis'
CLIENT_NAME='cl-piece-step5b2b-request-client'
CROSSOVER_SCAN_NAME='cl-piece-step5b2b-crossover-scan'
CONTROL_INIT_NAME='cl-piece-step5b2b-control-init'
CONTROL_RESTORE_NAME='cl-piece-step5b2b-control-restore'
RUNNER_NETWORK='cl-piece-step5b2b-runner-net'
CONTROL_VOLUME='cl-piece-step5b2b-broker-control'

BROKER_IMAGE='crazyloops/piece-egress-broker:step5b1'
SANDBOX_IMAGE='crazyloops/piece-runtime-hubspot:0.8.10-step5a'
SUPERVISOR_IMAGE='crazyloops/piece-supervisor:step5b2b-acceptance'
RUNNER_IMAGE='crazyloops/connector-runner:step5b2b-acceptance'

HOST_UID="$(id -u)"
HOST_GID="$(id -g)"
CONTROL_DIR="$(mktemp -d /tmp/cl-e50-step5b2b-control.XXXXXX)"
ARTIFACT_DIR="$(mktemp -d /tmp/cl-e50-step5b2b-evidence.XXXXXX)"
SECRET_DIR="$(mktemp -d /tmp/cl-e50-step5b2b-secrets.XXXXXX)"
chmod 0700 "$CONTROL_DIR" "$ARTIFACT_DIR" "$SECRET_DIR"

BROKER_IMAGE_CREATED=0
SANDBOX_IMAGE_CREATED=0
SUPERVISOR_IMAGE_CREATED=0
RUNNER_IMAGE_CREATED=0
BROKER_CREATED=0
SUPERVISOR_CREATED=0
RUNNER_CREATED=0
REDIS_CREATED=0
RUNNER_NETWORK_CREATED=0
CONTROL_VOLUME_CREATED=0
SUPERVISOR_STOPPED=0
ACCEPTANCE_STARTED=0
ACCEPTANCE_COMPLETED=0
STAGE='preflight'
CANARY=''
CANARY_B64=''
CROSSOVER_SECRET_OWNERSHIP_CHANGED=0

fail() {
  printf 'STEP5B2B OWNER-HOST ACCEPTANCE=FAIL: %s\n' "$*" >&2
  exit 1
}

snapshot_protected() {
  local destination="$1"
  : >"$destination"
  for name in "${PROTECTED[@]}"; do
    local state
    state="$(docker inspect --format '{{.Id}}|{{.State.Running}}|{{.RestartCount}}|{{.Image}}' "$name")" \
      || fail "Protected service missing: $name"
    [[ "$state" == *'|true|0|'* ]] || fail "Protected service is unhealthy: $name"
    printf '%s|%s\n' "$name" "$state" >>"$destination"
  done
}

owned_label_is_exact() {
  [[ "$(docker inspect --format '{{index .Config.Labels "crazyloops.acceptance"}}' "$1" 2>/dev/null)" == 'e50-step5b2b-owner-host' ]]
}

remove_owned_container() {
  local name="$1"
  docker inspect "$name" >/dev/null 2>&1 || return 0
  owned_label_is_exact "$name" || return 1
  docker rm -f "$name" >/dev/null 2>&1
}

remove_owned_network() {
  local name="$1"
  docker network inspect "$name" >/dev/null 2>&1 || return 0
  [[ "$(docker network inspect --format '{{index .Labels "crazyloops.acceptance"}}' "$name" 2>/dev/null)" == 'e50-step5b2b-owner-host' ]] || return 1
  docker network rm "$name" >/dev/null 2>&1
}

remove_owned_volume() {
  local name="$1"
  docker volume inspect "$name" >/dev/null 2>&1 || return 0
  [[ "$(docker volume inspect --format '{{index .Labels "crazyloops.acceptance"}}' "$name" 2>/dev/null)" == 'e50-step5b2b-owner-host' ]] || return 1
  docker volume rm "$name" >/dev/null 2>&1
}

remove_owned_image() {
  local image="$1"
  docker image inspect "$image" >/dev/null 2>&1 || return 0
  [[ "$(docker image inspect --format '{{index .Config.Labels "crazyloops.acceptance"}}' "$image" 2>/dev/null)" == 'e50-step5b2b-owner-host' ]] || return 1
  docker image rm "$image" >/dev/null 2>&1
}

remove_invocation_container() {
  local name="$1" invocation="$2"
  docker inspect "$name" >/dev/null 2>&1 || return 0
  local labels
  labels="$(docker inspect --format '{{index .Config.Labels "crazyloops.runtime"}}|{{index .Config.Labels "crazyloops.resource"}}|{{index .Config.Labels "crazyloops.invocation"}}' "$name" 2>/dev/null)" || return 1
  [[ "$labels" == "piece-runtime-supervisor-v1|invocation|$invocation" ]] || return 1
  docker rm -f "$name" >/dev/null 2>&1
}

remove_invocation_network() {
  local name="$1" invocation="$2"
  docker network inspect "$name" >/dev/null 2>&1 || return 0
  local labels
  labels="$(docker network inspect --format '{{index .Labels "crazyloops.runtime"}}|{{index .Labels "crazyloops.resource"}}|{{index .Labels "crazyloops.invocation"}}' "$name" 2>/dev/null)" || return 1
  [[ "$labels" == "piece-runtime-supervisor-v1|invocation|$invocation" ]] || return 1
  if docker inspect "$BROKER_NAME" >/dev/null 2>&1 && docker network inspect --format '{{json .Containers}}' "$name" | grep -Fq "$BROKER_NAME"; then
    owned_label_is_exact "$BROKER_NAME" || return 1
    docker network disconnect -f "$name" "$BROKER_NAME" >/dev/null 2>&1 || return 1
  fi
  docker network rm "$name" >/dev/null 2>&1
}

secure_delete_directory() {
  local directory="$1"
  [[ -d "$directory" ]] || return 0
  while IFS= read -r -d '' file; do
    shred -u -z -- "$file" 2>/dev/null || { : >"$file"; rm -f -- "$file"; }
  done < <(find "$directory" -type f -print0)
  rm -rf -- "$directory"
}

restore_control_ownership() {
  [[ -d "$CONTROL_DIR" ]] || return 0
  [[ "$(stat -c '%u:%g' "$CONTROL_DIR" 2>/dev/null)" == "$HOST_UID:$HOST_GID" ]] && return 0
  docker rm -f "$CONTROL_RESTORE_NAME" >/dev/null 2>&1 || true
  docker run --rm --name "$CONTROL_RESTORE_NAME" --label "$OWNER_LABEL" \
    --network none --read-only --cap-drop=ALL --cap-add=CHOWN --security-opt=no-new-privileges \
    --pids-limit=8 --memory=33554432 --memory-swap=33554432 --cpus=0.1 --user=0:0 \
    --mount type=bind,src="$CONTROL_DIR",dst=/control \
    --entrypoint /usr/bin/chown "$SUPERVISOR_IMAGE" "$HOST_UID:$HOST_GID" /control >/dev/null
}

capture_failure_evidence() {
  [[ "$ACCEPTANCE_STARTED" == '1' ]] || return 0
  for pair in "$RUNNER_NAME:runner" "$SUPERVISOR_NAME:supervisor" "$BROKER_NAME:broker" "$REDIS_NAME:redis"; do
    local name="${pair%%:*}" label="${pair##*:}"
    if docker inspect "$name" >/dev/null 2>&1; then
      docker logs --tail 500 "$name" >"$ARTIFACT_DIR/$label.log" 2>&1 || true
      docker inspect --format '{{.Name}}|{{.Id}}|{{.State.Running}}|{{.RestartCount}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.Privileged}}' "$name" \
        >"$ARTIFACT_DIR/$label-state.txt" 2>/dev/null || true
    fi
  done
  printf 'stage=%s\n' "$STAGE" >"$ARTIFACT_DIR/failure-summary.txt"
  find "$ARTIFACT_DIR" -type f -exec chmod 0600 {} + 2>/dev/null || true
}

set_crossover_secret_owner() {
  local owner="$1"
  [[ "$owner" == '65532:65532' || "$owner" == "$HOST_UID:$HOST_GID" ]] || return 1
  remove_owned_container "$CONTROL_RESTORE_NAME" || return 1
  # Reuse the existing CHOWN-only helper for exactly two disposable 0600 files.
  # Neither the control directory nor production files are mounted here.
  timeout --kill-after=5s 10s docker run --rm --name "$CONTROL_RESTORE_NAME" --label "$OWNER_LABEL" \
    --network none --read-only --cap-drop=ALL --cap-add=CHOWN --security-opt=no-new-privileges \
    --pids-limit=8 --memory=33554432 --memory-swap=33554432 --cpus=0.1 --user=0:0 \
    --mount type=bind,src="$SECRET_DIR/canary.txt",dst=/secret/canary.txt \
    --mount type=bind,src="$SECRET_DIR/canary-b64.txt",dst=/secret/canary-b64.txt \
    --entrypoint /usr/bin/chown "$SUPERVISOR_IMAGE" "$owner" /secret/canary.txt /secret/canary-b64.txt >/dev/null 2>&1
}

credential_scan_source() {
  cat <<'SCAN_NODE'
const fs = require('node:fs');
const path = require('node:path');
let plaintext;
let encoded;
let scannedBytes = 0;
let entries = 0;
const deadline = Date.now() + 20_000;
const readFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
function checkBudget() {
  if (Date.now() > deadline || scannedBytes > 64 * 1024 * 1024 || entries > 10_000) throw new Error('Scan incomplete.');
}
function openRegular(file, expected) {
  if (!expected.isFile() || expected.nlink !== 1) throw new Error('Unexpected file.');
  const fd = fs.openSync(file, readFlags);
  try {
    const actual = fs.fstatSync(fd);
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('File changed.');
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}
function readComparison(file) {
  const metadata = fs.lstatSync(file);
  if (metadata.size < 1 || metadata.size > 32 * 1024) throw new Error('Comparison unavailable.');
  const fd = openRegular(file, metadata);
  const value = Buffer.alloc(metadata.size);
  try {
    let offset = 0;
    while (offset < value.length) {
      const count = fs.readSync(fd, value, offset, value.length - offset, null);
      if (count === 0) throw new Error('Comparison incomplete.');
      offset += count;
    }
    return value;
  } catch (error) { value.fill(0); throw error; }
  finally { fs.closeSync(fd); }
}
function scanStream(fd) {
  const buffer = Buffer.alloc(64 * 1024);
  const overlap = Math.max(plaintext.length, encoded.length) - 1;
  let tail = Buffer.alloc(0);
  try {
    for (;;) {
      checkBudget();
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      scannedBytes += count;
      checkBudget();
      const window = Buffer.concat([tail, buffer.subarray(0, count)]);
      tail.fill(0);
      try {
        if (window.includes(plaintext) || window.includes(encoded)) throw new Error('Credential crossover.');
        tail = Buffer.from(window.subarray(Math.max(0, window.length - overlap)));
      } finally { window.fill(0); }
    }
  } finally { buffer.fill(0); tail.fill(0); }
}
function scanTree(root, expectedSocket) {
  if (!fs.lstatSync(root).isDirectory()) throw new Error('Scan root unavailable.');
  root = fs.realpathSync(root);
  const rootDevice = fs.lstatSync(root).dev;
  function visit(directory, depth) {
    checkBudget();
    if (depth > 32 || fs.realpathSync(directory) !== directory) throw new Error('Unexpected traversal.');
    const before = fs.lstatSync(directory);
    if (!before.isDirectory() || before.dev !== rootDevice) throw new Error('Unexpected directory.');
    for (const name of fs.readdirSync(directory)) {
      entries++;
      checkBudget();
      if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error('Unexpected entry.');
      const file = path.join(directory, name);
      const metadata = fs.lstatSync(file);
      if (metadata.dev !== rootDevice || metadata.isSymbolicLink()) throw new Error('Unexpected traversal.');
      if (metadata.isDirectory()) visit(file, depth + 1);
      else if (metadata.isFile()) {
        const fd = openRegular(file, metadata);
        try { scanStream(fd); } finally { fs.closeSync(fd); }
      } else if (!(expectedSocket === 'piece-supervisor.sock' && file === path.join(root, expectedSocket) && metadata.isSocket())) {
        throw new Error('Unexpected file type.');
      }
    }
    const after = fs.lstatSync(directory);
    if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino || fs.realpathSync(directory) !== directory) throw new Error('Directory changed.');
  }
  visit(root, 0);
}
try {
  plaintext = readComparison(process.argv[1]);
  encoded = readComparison(process.argv[2]);
  if (encoded.toString('utf8') !== plaintext.toString('base64')) throw new Error('Comparison mismatch.');
  if (process.argv[3] === 'stdin') scanStream(0);
  else if (process.argv[3] === 'tree') scanTree(process.argv[4], process.argv[5]);
  else throw new Error('Unknown scan mode.');
} catch {
  // No paths, file contents, or comparison values leave this scanner.
  process.exitCode = 1;
} finally {
  plaintext?.fill(0);
  encoded?.fill(0);
}
SCAN_NODE
}

sanitize_failure_evidence() {
  if [[ -z "$CANARY" && -f "$SECRET_DIR/canary.txt" ]]; then CANARY="$(<"$SECRET_DIR/canary.txt")"; fi
  if [[ -z "$CANARY_B64" && -f "$SECRET_DIR/canary-b64.txt" ]]; then CANARY_B64="$(<"$SECRET_DIR/canary-b64.txt")"; fi
  local surface
  while IFS= read -r -d '' surface; do
    if { [[ -n "$CANARY" ]] && grep -Fq -- "$CANARY" "$surface"; } || \
       { [[ -n "$CANARY_B64" ]] && grep -Fq -- "$CANARY_B64" "$surface"; }; then
      rm -f -- "$surface"
    fi
  done < <(find "$ARTIFACT_DIR" -type f -print0)
  CANARY=''
  CANARY_B64=''
}

read_invocation_meta() {
  local field="$1"
  node -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const result=value[process.argv[2]];if(typeof result!=="string"||!result)process.exit(1);process.stdout.write(result)' "$SECRET_DIR/request-meta.json" "$field"
}

cleanup_invocation_resources() {
  [[ -f "$SECRET_DIR/request-meta.json" ]] || return 0
  local kind invocation sandbox network
  for kind in primary live badSignature unavailable; do
    invocation="$(read_invocation_meta "${kind}InvocationId" 2>/dev/null || true)"
    [[ -n "$invocation" ]] || continue
    sandbox="cl-piece-sandbox-$invocation"
    network="cl-piece-internal-$invocation"
    remove_invocation_container "$sandbox" "$invocation" || return 1
    remove_invocation_network "$network" "$invocation" || return 1
  done
}

cleanup() {
  local status="$1"
  trap - EXIT INT TERM
  set +e
  if (( status != 0 )); then capture_failure_evidence; fi

  remove_owned_container "$CLIENT_NAME" || status=1
  remove_owned_container "$CROSSOVER_SCAN_NAME" || status=1
  remove_owned_container "$RUNNER_NAME" || status=1
  remove_owned_container "$REDIS_NAME" || status=1
  if docker inspect "$SUPERVISOR_NAME" >/dev/null 2>&1 && owned_label_is_exact "$SUPERVISOR_NAME"; then
    docker stop --time 20 "$SUPERVISOR_NAME" >/dev/null 2>&1 || true
  fi
  cleanup_invocation_resources || status=1
  remove_owned_container "$SUPERVISOR_NAME" || status=1
  remove_owned_container "$BROKER_NAME" || status=1
  remove_owned_container "$CONTROL_INIT_NAME" || status=1
  remove_owned_container "$CONTROL_RESTORE_NAME" || status=1
  remove_owned_network "$RUNNER_NETWORK" || status=1
  remove_owned_volume "$CONTROL_VOLUME" || status=1

  if [[ "$CROSSOVER_SECRET_OWNERSHIP_CHANGED" == '1' ]]; then
    set_crossover_secret_owner "$HOST_UID:$HOST_GID" || status=1
  fi
  restore_control_ownership || status=1
  rm -rf -- "$CONTROL_DIR"
  sanitize_failure_evidence
  secure_delete_directory "$SECRET_DIR"

  (( RUNNER_IMAGE_CREATED == 0 )) || remove_owned_image "$RUNNER_IMAGE" || status=1
  (( SUPERVISOR_IMAGE_CREATED == 0 )) || remove_owned_image "$SUPERVISOR_IMAGE" || status=1
  (( SANDBOX_IMAGE_CREATED == 0 )) || remove_owned_image "$SANDBOX_IMAGE" || status=1
  (( BROKER_IMAGE_CREATED == 0 )) || remove_owned_image "$BROKER_IMAGE" || status=1

  local remaining_containers=0 remaining_networks=0 remaining_volumes=0 remaining_images=0
  for name in "$CLIENT_NAME" "$CROSSOVER_SCAN_NAME" "$RUNNER_NAME" "$REDIS_NAME" "$SUPERVISOR_NAME" "$BROKER_NAME" "$CONTROL_INIT_NAME" "$CONTROL_RESTORE_NAME"; do
    docker inspect "$name" >/dev/null 2>&1 && remaining_containers=$((remaining_containers + 1))
  done
  docker network inspect "$RUNNER_NETWORK" >/dev/null 2>&1 && remaining_networks=1
  docker volume inspect "$CONTROL_VOLUME" >/dev/null 2>&1 && remaining_volumes=1
  (( RUNNER_IMAGE_CREATED == 0 )) || { docker image inspect "$RUNNER_IMAGE" >/dev/null 2>&1 && remaining_images=$((remaining_images + 1)); }
  (( SUPERVISOR_IMAGE_CREATED == 0 )) || { docker image inspect "$SUPERVISOR_IMAGE" >/dev/null 2>&1 && remaining_images=$((remaining_images + 1)); }
  (( SANDBOX_IMAGE_CREATED == 0 )) || { docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1 && remaining_images=$((remaining_images + 1)); }
  (( BROKER_IMAGE_CREATED == 0 )) || { docker image inspect "$BROKER_IMAGE" >/dev/null 2>&1 && remaining_images=$((remaining_images + 1)); }
  if (( remaining_containers != 0 || remaining_networks != 0 || remaining_volumes != 0 || remaining_images != 0 )); then status=1; fi

  if (( status == 0 && ACCEPTANCE_COMPLETED == 1 )); then
    rm -rf -- "$ARTIFACT_DIR"
    printf '%s\n' \
      "STEP5B2B_CONTAINERS=$remaining_containers" \
      "STEP5B2B_NETWORKS=$remaining_networks" \
      "STEP5B2B_VOLUMES=$remaining_volumes" \
      "STEP5B2B_IMAGES=$remaining_images" \
      'STEP5B2B_CLEANUP=PASS' \
      'STEP5B2B HOST ACCEPTANCE=PASS'
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
  secure_delete_directory "$SECRET_DIR"
  rm -rf -- "$CONTROL_DIR" "$ARTIFACT_DIR"
  exit "$status"
}

bounded_fetch() {
  local attempt
  for attempt in 1 2 3; do
    if timeout 30 git fetch --no-tags origin \
      "refs/heads/main:refs/remotes/origin/main" \
      "refs/heads/$EXPECTED_BRANCH:refs/remotes/origin/$EXPECTED_BRANCH"; then return 0; fi
    sleep "$attempt"
  done
  return 1
}

trap 'preflight_cleanup $?' EXIT
trap 'exit 130' INT TERM

[[ "$E50_EXPECTED_COMMIT" =~ ^[a-f0-9]{40}$ ]] || fail 'Expected commit must be a full SHA.'
bounded_fetch || fail 'Bounded source fetch failed.'
[[ "$(git branch --show-current)" == "$EXPECTED_BRANCH" ]] || fail 'Wrong branch.'
[[ "$(git rev-parse HEAD)" == "$E50_EXPECTED_COMMIT" ]] || fail 'Wrong local commit.'
[[ "$(git rev-parse "origin/$EXPECTED_BRANCH")" == "$E50_EXPECTED_COMMIT" ]] || fail 'Remote feature branch differs.'
[[ "$(git rev-parse origin/main)" == "$EXPECTED_ORIGIN_MAIN" ]] || fail 'origin/main changed.'
[[ "$(git rev-parse HEAD^)" == "$ACCEPTED_PARENT" ]] || fail 'Harness commit is not directly based on the accepted parent.'
[[ -z "$(git status --porcelain)" ]] || fail 'Working tree is not clean.'
mapfile -t SOURCE_FILES < <(git diff --name-only "$ACCEPTED_PARENT"..HEAD)
[[ "${#SOURCE_FILES[@]}" == '2' ]] || fail 'Unexpected source scope.'
[[ "${SOURCE_FILES[0]}" == 'scripts/e50-step5b2b-runner-supervisor-host-acceptance.sh' ]] || fail 'Unexpected source scope.'
[[ "${SOURCE_FILES[1]}" == 'tests/essential-fifty-step-five-b2b-owner-host-acceptance.test.ts' ]] || fail 'Unexpected source scope.'
git diff --quiet "$ACCEPTED_PARENT"..HEAD -- services/piece-runtime services/connector-runner/src app lib supabase || fail 'Runtime or product source changed.'

command -v docker >/dev/null || fail 'Docker is required.'
command -v node >/dev/null || fail 'Node.js is required.'
command -v openssl >/dev/null || fail 'OpenSSL is required.'
command -v shred >/dev/null || fail 'shred is required.'
[[ -S /var/run/docker.sock ]] || fail 'Docker socket unavailable.'

for name in "$BROKER_NAME" "$SUPERVISOR_NAME" "$RUNNER_NAME" "$REDIS_NAME" "$CLIENT_NAME" "$CROSSOVER_SCAN_NAME" "$CONTROL_INIT_NAME" "$CONTROL_RESTORE_NAME"; do
  ! docker inspect "$name" >/dev/null 2>&1 || fail "Reserved acceptance container exists: $name"
done
! docker network inspect "$RUNNER_NETWORK" >/dev/null 2>&1 || fail 'Reserved acceptance network exists.'
! docker volume inspect "$CONTROL_VOLUME" >/dev/null 2>&1 || fail 'Reserved acceptance volume exists.'
! docker image inspect "$SUPERVISOR_IMAGE" >/dev/null 2>&1 || fail 'Reserved Supervisor image exists.'
! docker image inspect "$RUNNER_IMAGE" >/dev/null 2>&1 || fail 'Reserved Runner image exists.'
[[ -z "$(docker ps -q --filter 'label=crazyloops.runtime=piece-runtime-supervisor-v1' --filter 'label=crazyloops.resource=supervisor')" ]] || fail 'Another Piece Supervisor is running.'

snapshot_protected "$ARTIFACT_DIR/protected-before.txt"
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:8788/v1/execute)" == '401' ]] || fail 'Protected Runner unsigned check failed.'
[[ "$(docker exec redis redis-cli PING)" == 'PONG' ]] || fail 'Protected Redis health failed.'
PROTECTED_REDIS_IMAGE="$(docker inspect --format '{{.Image}}' redis)"
REDIS_PROCESS_IDENTITY="$(docker exec redis sh -c '
redis_uid=
redis_gid=
while read -r key first _; do
  case "$key" in
    Uid:) redis_uid="$first" ;;
    Gid:) redis_gid="$first" ;;
  esac
done </proc/1/status
[ -n "$redis_uid" ] && [ -n "$redis_gid" ] || exit 1
printf "%s:%s\n" "$redis_uid" "$redis_gid"
')" || fail 'Protected Redis process identity unavailable.'
[[ "$REDIS_PROCESS_IDENTITY" =~ ^[0-9]+:[0-9]+$ ]] || fail 'Protected Redis process identity is not numeric.'
REDIS_UID="${REDIS_PROCESS_IDENTITY%%:*}"
REDIS_GID="${REDIS_PROCESS_IDENTITY##*:}"
[[ "$REDIS_UID" != '0' && "$REDIS_GID" != '0' ]] || fail 'Protected Redis process identity must be non-root.'

trap - EXIT
trap 'cleanup $?' EXIT
ACCEPTANCE_STARTED=1

STAGE='build-images'
if ! docker image inspect "$BROKER_IMAGE" >/dev/null 2>&1; then
  docker build --no-cache --label "$OWNER_LABEL" -f services/piece-runtime/Dockerfile.egress-broker -t "$BROKER_IMAGE" services/piece-runtime >/dev/null
  BROKER_IMAGE_CREATED=1
fi
if ! docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then
  docker build --no-cache --label "$OWNER_LABEL" -f services/piece-runtime/Dockerfile.sandbox -t "$SANDBOX_IMAGE" services/piece-runtime >/dev/null
  SANDBOX_IMAGE_CREATED=1
fi
docker build --no-cache --label "$OWNER_LABEL" -f services/piece-runtime/Dockerfile.supervisor -t "$SUPERVISOR_IMAGE" services/piece-runtime >/dev/null
SUPERVISOR_IMAGE_CREATED=1
docker build --no-cache --label "$OWNER_LABEL" -f services/connector-runner/Dockerfile -t "$RUNNER_IMAGE" services/connector-runner >/dev/null
RUNNER_IMAGE_CREATED=1

STAGE='start-broker'
docker volume create --label "$OWNER_LABEL" "$CONTROL_VOLUME" >/dev/null
CONTROL_VOLUME_CREATED=1
docker run --rm --name "$CONTROL_INIT_NAME" --label "$OWNER_LABEL" --network none --user=0:0 \
  --mount type=volume,src="$CONTROL_VOLUME",dst=/control --entrypoint sh "$BROKER_IMAGE" \
  -c 'chown 65532:65532 /control && chmod 0700 /control' >/dev/null
docker run -d --name "$BROKER_NAME" --label 'crazyloops.runtime=piece-egress-broker-v1' \
  --label 'crazyloops.resource=service' --label "$OWNER_LABEL" --network bridge --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=4m --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=32 --memory=134217728 --memory-swap=134217728 --cpus=0.5 --ulimit=nofile=256:256 \
  --user=65532:65532 --mount type=volume,src="$CONTROL_VOLUME",dst=/run/crazyloops-egress-control \
  "$BROKER_IMAGE" >/dev/null
BROKER_CREATED=1
for _ in $(seq 1 100); do
  docker logs "$BROKER_NAME" 2>&1 | grep -Fq '"event":"piece_egress_broker_ready"' && break
  sleep 0.05
done
docker logs "$BROKER_NAME" 2>&1 | grep -Fq '"event":"piece_egress_broker_ready"' || fail 'Broker did not become ready.'

STAGE='start-supervisor'
DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
docker run --rm --name "$CONTROL_INIT_NAME" --label "$OWNER_LABEL" --network none --user=0:0 \
  --mount type=bind,src="$CONTROL_DIR",dst=/control --entrypoint sh "$SUPERVISOR_IMAGE" \
  -c 'chown 65532:65532 /control && chmod 0750 /control' >/dev/null
docker run -d --name "$SUPERVISOR_NAME" --label 'crazyloops.runtime=piece-runtime-supervisor-v1' \
  --label 'crazyloops.resource=supervisor' --label "$OWNER_LABEL" \
  --env PIECE_SUPERVISOR_CONTAINER_NAME="$SUPERVISOR_NAME" \
  --env PIECE_EGRESS_BROKER_CONTAINER_NAME="$BROKER_NAME" \
  --env PIECE_EGRESS_BROKER_SOCKET_PATH=/run/crazyloops-egress-control/broker.sock \
  --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=4m --cap-drop=ALL \
  --security-opt=no-new-privileges --pids-limit=32 --memory=268435456 --memory-swap=268435456 \
  --cpus=0.5 --ulimit=nofile=128:128 --user=65532:65532 --group-add "$DOCKER_GID" \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --mount type=bind,src="$CONTROL_DIR",dst=/run/crazyloops-piece \
  --mount type=volume,src="$CONTROL_VOLUME",dst=/run/crazyloops-egress-control \
  "$SUPERVISOR_IMAGE" >/dev/null
SUPERVISOR_CREATED=1
for _ in $(seq 1 200); do
  docker exec "$SUPERVISOR_NAME" node -e 'const fs=require("node:fs");const p="/run/crazyloops-piece/piece-supervisor.sock";if(!fs.lstatSync(p).isSocket())process.exit(1)' >/dev/null 2>&1 && break
  sleep 0.05
done
docker exec "$SUPERVISOR_NAME" node -e '
const fs = require("node:fs");
const metadata = fs.lstatSync("/run/crazyloops-piece/piece-supervisor.sock");
if (!metadata.isSocket()) process.exit(1);
if ((metadata.mode & 0o777) !== 0o660) process.exit(1);
if (metadata.uid !== 65532 || metadata.gid !== 65532) process.exit(1);
' >/dev/null || fail 'Supervisor UDS metadata changed.'
[[ "$(stat -c '%a' "$CONTROL_DIR")" == '750' ]] || fail 'Supervisor control directory mode changed.'

STAGE='start-runner-boundary'
docker network create --internal --label "$OWNER_LABEL" "$RUNNER_NETWORK" >/dev/null
RUNNER_NETWORK_CREATED=1
docker run -d --name "$REDIS_NAME" --label "$OWNER_LABEL" --network "$RUNNER_NETWORK" --network-alias replay-redis \
  --read-only --tmpfs "/data:rw,noexec,nosuid,nodev,size=16m,uid=$REDIS_UID,gid=$REDIS_GID,mode=0700" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=4m \
  --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=32 --memory=67108864 --memory-swap=67108864 \
  --cpus=0.25 --user="$REDIS_UID:$REDIS_GID" "$PROTECTED_REDIS_IMAGE" redis-server --save '' --appendonly no >/dev/null
REDIS_CREATED=1
for _ in $(seq 1 100); do
  docker exec "$REDIS_NAME" redis-cli PING 2>/dev/null | grep -Fxq PONG && break
  sleep 0.05
done
[[ "$(docker exec "$REDIS_NAME" redis-cli PING)" == 'PONG' ]] || fail 'Disposable Redis did not become ready.'

STAGE='generate-signed-requests'
node - "$SECRET_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { createCipheriv, createHash, createHmac, randomBytes } = require('node:crypto');
const directory = process.argv[2];
const transportBytes = randomBytes(48);
const transportSecret = transportBytes.toString('base64url');
const wrapping = randomBytes(32);
const credential = Buffer.from(`pat-na1-${randomBytes(32).toString('hex')}`, 'utf8');
const credentialBase64 = credential.toString('base64');
const now = Date.now();
const expiresAt = now + 90_000;
const metadata = {};
function capsuleFor(envelope) {
  const nonce = randomBytes(12);
  const aad = Buffer.from(JSON.stringify({
    namespace: 'crazyloops:connector-runner:credential-capsule:v1',
    protocolVersion: envelope.protocolVersion,
    requestId: envelope.requestId,
    executionId: envelope.executionId,
    workflowVersionId: envelope.workflowVersionId,
    stepId: envelope.stepId,
    capabilityId: envelope.capabilityId,
    capabilityVersion: envelope.capabilityVersion,
    keyVersion: 1,
    algorithm: 'aes-256-gcm',
    expiresAt,
  }), 'utf8');
  try {
    const cipher = createCipheriv('aes-256-gcm', wrapping, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(credential), cipher.final()]);
    const authTag = cipher.getAuthTag();
    try {
      return { keyVersion: 1, algorithm: 'aes-256-gcm', nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), authTag: authTag.toString('base64'), expiresAt };
    } finally { ciphertext.fill(0); authTag.fill(0); }
  } finally { nonce.fill(0); aad.fill(0); }
}
function writeBundle(kind, mode, invalidSignature = false) {
  const requestId = `step5b2b-${kind}-${randomBytes(8).toString('hex')}`;
  const envelope = {
    protocolVersion: 1,
    requestId,
    executionId: `execution-${requestId}`,
    workflowVersionId: `workflow-version-${requestId}`,
    stepId: `step-${requestId}`,
    capabilityId: 'hubspot.get_contact',
    capabilityVersion: 1,
    mode,
    idempotencyKey: `idempotency-${requestId}`,
    input: { contactId: 'synthetic-contact', properties: ['firstname'] },
    credentialCapsule: null,
  };
  envelope.credentialCapsule = capsuleFor(envelope);
  const body = JSON.stringify(envelope);
  const timestamp = String(now);
  const digest = createHash('sha256').update(body).digest('hex');
  const signature = invalidSignature ? '0'.repeat(64) : createHmac('sha256', transportSecret).update(`${timestamp}.${requestId}.${digest}`).digest('hex');
  fs.writeFileSync(path.join(directory, `${kind}.json`), JSON.stringify({
    body,
    headers: {
      'content-type': 'application/json',
      'x-crazyloops-timestamp': timestamp,
      'x-crazyloops-request-id': requestId,
      'x-crazyloops-content-sha256': digest,
      'x-crazyloops-signature': `v1=${signature}`,
    },
  }), { mode: 0o600 });
  metadata[`${kind}RequestId`] = requestId;
  metadata[`${kind}InvocationId`] = createHash('sha256').update(requestId).digest('hex').slice(0, 16);
}
try {
  writeBundle('primary', 'TEST');
  writeBundle('live', 'LIVE');
  writeBundle('badSignature', 'TEST', true);
  writeBundle('unavailable', 'TEST');
  fs.writeFileSync(path.join(directory, 'runner.env'), [
    'CONNECTOR_RUNNER_HOST=0.0.0.0',
    'CONNECTOR_RUNNER_PORT=8788',
    'CONNECTOR_RUNNER_ADAPTER_TIMEOUT_MS=10000',
    'CONNECTOR_RUNNER_REDIS_URL=redis://replay-redis:6379/0',
    `CONNECTOR_RUNNER_SECRET=${transportSecret}`,
    'CONNECTOR_RUNNER_WRAP_KEY_ACTIVE_VERSION=1',
    `CONNECTOR_RUNNER_WRAP_KEY_V1=${wrapping.toString('base64')}`,
  ].join('\n') + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'request-meta.json'), JSON.stringify(metadata), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'canary.txt'), credential, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'canary-b64.txt'), credentialBase64, { mode: 0o600 });
} finally {
  transportBytes.fill(0); wrapping.fill(0); credential.fill(0);
}
NODE
while IFS= read -r -d '' secret_file; do
  [[ "$(stat -c '%a' "$secret_file")" == '600' ]] || fail 'Secret-bearing file mode is not 0600.'
  [[ "$(stat -c '%u:%g' "$secret_file")" == "$HOST_UID:$HOST_GID" ]] || fail 'Secret-bearing file owner is not the host owner.'
done < <(find "$SECRET_DIR" -type f -print0)
CANARY="$(<"$SECRET_DIR/canary.txt")"
CANARY_B64="$(<"$SECRET_DIR/canary-b64.txt")"

docker run -d --name "$RUNNER_NAME" --label "$OWNER_LABEL" --network "$RUNNER_NETWORK" --network-alias acceptance-runner \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=4m --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=64 --memory=134217728 --memory-swap=134217728 --cpus=0.5 --user=node --group-add 65532 \
  --env-file "$SECRET_DIR/runner.env" \
  --mount type=bind,src="$CONTROL_DIR",dst=/run/crazyloops-piece,readonly \
  "$RUNNER_IMAGE" >/dev/null
RUNNER_CREATED=1
for _ in $(seq 1 100); do
  docker logs "$RUNNER_NAME" 2>&1 | grep -Fq '"event":"connector_runner_listening"' && break
  sleep 0.05
done
docker logs "$RUNNER_NAME" 2>&1 | grep -Fq '"event":"connector_runner_listening"' || fail 'Disposable Runner did not become ready.'

docker inspect "$RUNNER_NAME" | node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(0, "utf8"))[0];
const network = process.argv[1];
const host = value.HostConfig;
if (host.NetworkMode !== network || !value.NetworkSettings.Networks?.[network]) throw new Error("runner network");
if (host.Privileged || !host.ReadonlyRootfs || JSON.stringify(host.CapDrop) !== JSON.stringify(["ALL"])) throw new Error("runner hardening");
if (!(host.SecurityOpt ?? []).includes("no-new-privileges")) throw new Error("runner no-new-privileges");
if (!(host.GroupAdd ?? []).map(String).includes("65532")) throw new Error("runner supplemental group");
if (Object.keys(host.PortBindings ?? {}).length || value.Config.ExposedPorts) throw new Error("runner public ports");
const mounts = value.Mounts ?? [];
if (mounts.length !== 1 || mounts[0].Destination !== "/run/crazyloops-piece" || mounts[0].RW !== false) throw new Error("runner mounts");
if (JSON.stringify(mounts).includes("/var/run/docker.sock") || JSON.stringify(mounts).includes("crazyloops-egress-control")) throw new Error("runner authority");
' "$RUNNER_NETWORK"
[[ "$(docker exec "$RUNNER_NAME" id -u)" != '0' ]] || fail 'Runner is root.'
docker exec "$RUNNER_NAME" id -G | tr ' ' '\n' | grep -Fxq 65532 || fail 'Runner supplemental group missing.'
docker exec "$RUNNER_NAME" node -e 'const fs=require("node:fs");if(!fs.lstatSync("/run/crazyloops-piece/piece-supervisor.sock").isSocket())process.exit(1)' || fail 'Runner cannot see the Supervisor UDS.'
docker network inspect "$RUNNER_NETWORK" | node -e '
const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(0,"utf8"))[0];
if(value.Internal!==true)throw new Error("network not internal");
const names=Object.values(value.Containers??{}).map((entry)=>entry.Name).sort();
if(JSON.stringify(names)!==JSON.stringify(["cl-piece-step5b2b-redis","cl-piece-step5b2b-runner"]))throw new Error("network members");
'
docker inspect "$REDIS_NAME" | node -e '
const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(0,"utf8"))[0];
if(Object.keys(value.HostConfig.PortBindings??{}).length||value.HostConfig.PublishAllPorts===true)throw new Error("redis ports");
'
printf '%s\n' \
  'RUNNER_NON_ROOT=PASS' \
  'RUNNER_SUPPLEMENTAL_GID_65532=PASS' \
  'RUNNER_SUPERVISOR_MOUNT_READONLY=PASS' \
  'SUPERVISOR_DIRECTORY_MODE_0750=PASS' \
  'SUPERVISOR_SOCKET_MODE_0660=PASS' \
  'SUPERVISOR_SOCKET_OWNER_65532_65532=PASS' \
  'RUNNER_NETWORK_INTERNAL=PASS' \
  'RUNNER_PUBLIC_PORTS=0' \
  'RUNNER_DOCKER_SOCKET=0' \
  'RUNNER_BROKER_SOCKET=0'

run_runner_request() {
  local bundle="$1" response="$2"
  ! docker inspect "$CLIENT_NAME" >/dev/null 2>&1 || fail 'Request client name is occupied.'
  timeout 20 docker run --rm --name "$CLIENT_NAME" --label "$OWNER_LABEL" --network "$RUNNER_NETWORK" \
    --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=2m --cap-drop=ALL --security-opt=no-new-privileges \
    --pids-limit=16 --memory=67108864 --memory-swap=67108864 --cpus=0.25 --user=node \
    --mount type=bind,src="$bundle",dst=/request/bundle.json,readonly \
    --entrypoint node "$RUNNER_IMAGE" -e '
const fs=require("node:fs"),http=require("node:http");
const bundle=JSON.parse(fs.readFileSync("/request/bundle.json","utf8"));let bytes=0;const chunks=[];
const request=http.request({host:"acceptance-runner",port:8788,path:"/v1/execute",method:"POST",headers:{...bundle.headers,"content-length":Buffer.byteLength(bundle.body)}},(response)=>{
 response.on("data",(chunk)=>{bytes+=chunk.length;if(bytes>65536){response.destroy();process.exitCode=1;return;}chunks.push(Buffer.from(chunk));});
 response.once("end",()=>{const media=String(response.headers["content-type"]??"").split(";",1)[0].trim();if(media!=="application/json"){process.exitCode=1;return;}let body;try{body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{process.exitCode=1;return;}process.stdout.write(JSON.stringify({status:response.statusCode,body}));});
});
request.setTimeout(15000,()=>request.destroy(new Error("timeout")));request.once("error",()=>{process.exitCode=1;});request.end(bundle.body);' >"$response"
  chmod 0600 "$response"
}

expect_runner_error() {
  local file="$1" status="$2" category="$3" retryable="$4"
  node -e 'const fs=require("node:fs");const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const body=value.body;const keys=Object.keys(body??{}).sort().join(",");if(Object.keys(value).sort().join(",")!=="body,status"||keys!=="errorCategory,ok,protocolVersion,requestId,retryable"||value.status!==Number(process.argv[2])||body.protocolVersion!==1||body.ok!==false||body.errorCategory!==process.argv[3]||body.retryable!==(process.argv[4]==="true"))process.exit(1)' "$file" "$status" "$category" "$retryable"
}

count_supervisor_starts() {
  local request_id="$1"
  docker logs "$SUPERVISOR_NAME" 2>&1 | node -e 'const id=process.argv[1];let count=0;process.stdin.setEncoding("utf8");let text="";process.stdin.on("data",c=>text+=c);process.stdin.on("end",()=>{for(const line of text.split(/\r?\n/)){try{const e=JSON.parse(line);if(e.event==="piece_supervisor_execution_started"&&e.requestId===id&&e.capabilityId==="hubspot.get_contact"&&e.capabilityVersion===1)count++;}catch{}}process.stdout.write(String(count));});' "$request_id"
}

count_broker_connections() {
  local request_id="$1"
  docker logs "$BROKER_NAME" 2>&1 | node -e 'const id=process.argv[1];let count=0;process.stdin.setEncoding("utf8");let text="";process.stdin.on("data",c=>text+=c);process.stdin.on("end",()=>{for(const line of text.split(/\r?\n/)){try{const e=JSON.parse(line);if(e.event==="piece_egress_broker_connection"&&e.requestId===id&&e.capabilityId==="hubspot.get_contact"&&e.hostname==="api.hubapi.com"&&e.port===443&&e.upstreamConnections===1&&e.outcome==="PIECE_BROKER_SUCCEEDED")count++;}catch{}}process.stdout.write(String(count));});' "$request_id"
}

count_broker_registrations() {
  local request_id="$1"
  docker logs "$BROKER_NAME" 2>&1 | node -e 'const id=process.argv[1];let count=0;process.stdin.setEncoding("utf8");let text="";process.stdin.on("data",c=>text+=c);process.stdin.on("end",()=>{for(const line of text.split(/\r?\n/)){try{const e=JSON.parse(line);if(e.event==="piece_egress_broker_policy_registered"&&e.requestId===id&&e.capabilityId==="hubspot.get_contact")count++;}catch{}}process.stdout.write(String(count));});' "$request_id"
}

PRIMARY_REQUEST_ID="$(read_invocation_meta primaryRequestId)"
LIVE_REQUEST_ID="$(read_invocation_meta liveRequestId)"
BAD_SIGNATURE_REQUEST_ID="$(read_invocation_meta badSignatureRequestId)"
UNAVAILABLE_REQUEST_ID="$(read_invocation_meta unavailableRequestId)"
PRIMARY_INVOCATION_ID="$(read_invocation_meta primaryInvocationId)"
LIVE_INVOCATION_ID="$(read_invocation_meta liveInvocationId)"
BAD_SIGNATURE_INVOCATION_ID="$(read_invocation_meta badSignatureInvocationId)"
UNAVAILABLE_INVOCATION_ID="$(read_invocation_meta unavailableInvocationId)"
EVENTS_SINCE="$(date +%s)"

STAGE='primary-real-provider-401'
run_runner_request "$SECRET_DIR/primary.json" "$ARTIFACT_DIR/primary-response.json"
expect_runner_error "$ARTIFACT_DIR/primary-response.json" 200 DELEGATED_AUTH_FAILED false || fail 'Primary Runner response was not the normalized provider authentication failure.'
[[ "$(count_supervisor_starts "$PRIMARY_REQUEST_ID")" == '1' ]] || fail 'Primary Supervisor invocation count is not one.'
[[ "$(count_broker_registrations "$PRIMARY_REQUEST_ID")" == '1' ]] || fail 'Primary broker registration count is not one.'
[[ "$(count_broker_connections "$PRIMARY_REQUEST_ID")" == '1' ]] || fail 'Primary provider connection count is not one.'
printf '%s\n' \
  'RUNNER_TO_SUPERVISOR_REAL_PROVIDER_401=PASS' \
  'ONE_RUNNER_TO_SUPERVISOR_REQUEST=PASS' \
  'ONE_SUPERVISOR_INVOCATION=PASS' \
  'ONE_PROVIDER_CONNECTION=PASS' \
  'NO_AUTOMATIC_RETRY=PASS'

STAGE='replay-live-signature-matrix'
run_runner_request "$SECRET_DIR/primary.json" "$ARTIFACT_DIR/replay-response.json"
expect_runner_error "$ARTIFACT_DIR/replay-response.json" 409 DELEGATED_REPLAYED false || fail 'Replay was not rejected.'
run_runner_request "$SECRET_DIR/live.json" "$ARTIFACT_DIR/live-response.json"
expect_runner_error "$ARTIFACT_DIR/live-response.json" 200 DELEGATED_UNSUPPORTED_CAPABILITY false || fail 'LIVE request was not rejected.'
run_runner_request "$SECRET_DIR/badSignature.json" "$ARTIFACT_DIR/bad-signature-response.json"
expect_runner_error "$ARTIFACT_DIR/bad-signature-response.json" 401 DELEGATED_AUTH_FAILED false || fail 'Bad signature was not rejected.'
[[ "$(count_supervisor_starts "$PRIMARY_REQUEST_ID")" == '1' ]] || fail 'Replay reached Supervisor.'
[[ "$(count_supervisor_starts "$LIVE_REQUEST_ID")" == '0' ]] || fail 'LIVE request reached Supervisor.'
[[ "$(count_supervisor_starts "$BAD_SIGNATURE_REQUEST_ID")" == '0' ]] || fail 'Bad signature reached Supervisor.'
[[ "$(count_broker_connections "$PRIMARY_REQUEST_ID")" == '1' ]] || fail 'Replay caused another provider connection.'
[[ "$(count_broker_connections "$LIVE_REQUEST_ID")" == '0' ]] || fail 'LIVE request caused a provider connection.'
[[ "$(count_broker_connections "$BAD_SIGNATURE_REQUEST_ID")" == '0' ]] || fail 'Bad signature caused a provider connection.'
printf '%s\n' \
  'RUNNER_REPLAY_BLOCKED_BEFORE_SUPERVISOR=PASS' \
  'RUNNER_LIVE_BLOCKED_BEFORE_SUPERVISOR=PASS' \
  'RUNNER_BAD_SIGNATURE_BLOCKED=PASS'

STAGE='supervisor-unavailable'
docker stop --time 20 "$SUPERVISOR_NAME" >/dev/null
SUPERVISOR_STOPPED=1
run_runner_request "$SECRET_DIR/unavailable.json" "$ARTIFACT_DIR/unavailable-response.json"
expect_runner_error "$ARTIFACT_DIR/unavailable-response.json" 200 DELEGATED_UNAVAILABLE true || fail 'Supervisor unavailability did not fail closed.'
[[ "$(count_broker_connections "$UNAVAILABLE_REQUEST_ID")" == '0' ]] || fail 'Unavailable Supervisor request caused a provider connection.'
printf 'RUNNER_SUPERVISOR_UNAVAILABLE_FAIL_CLOSED=PASS\n'

STAGE='event-and-crossover-proof'
sleep 1
EVENTS_UNTIL="$(date +%s)"
docker events --since "$EVENTS_SINCE" --until "$EVENTS_UNTIL" --filter type=container --filter event=create \
  --filter 'label=crazyloops.resource=invocation' --format '{{json .}}' >"$ARTIFACT_DIR/invocation-create-events.jsonl"
node - "$ARTIFACT_DIR/invocation-create-events.jsonl" "$PRIMARY_INVOCATION_ID" "$LIVE_INVOCATION_ID" "$BAD_SIGNATURE_INVOCATION_ID" "$UNAVAILABLE_INVOCATION_ID" <<'NODE'
const fs=require('node:fs');const events=fs.readFileSync(process.argv[2],'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const counts=new Map(process.argv.slice(3).map((id)=>[id,0]));
for(const event of events){const id=event.Actor?.Attributes?.['crazyloops.invocation'];if(counts.has(id))counts.set(id,counts.get(id)+1);}
const ids=process.argv.slice(3);if(counts.get(ids[0])!==1||counts.get(ids[1])!==0||counts.get(ids[2])!==0||counts.get(ids[3])!==0)process.exit(1);
NODE

docker logs "$RUNNER_NAME" >"$ARTIFACT_DIR/runner.log" 2>&1
docker logs "$SUPERVISOR_NAME" >"$ARTIFACT_DIR/supervisor.log" 2>&1
docker logs "$BROKER_NAME" >"$ARTIFACT_DIR/broker.log" 2>&1
CROSSOVER_SCAN_SOURCE="$(credential_scan_source)"
docker inspect "$RUNNER_NAME" "$SUPERVISOR_NAME" "$BROKER_NAME" "$REDIS_NAME" | \
  timeout --kill-after=5s 30s node -e "$CROSSOVER_SCAN_SOURCE" "$SECRET_DIR/canary.txt" "$SECRET_DIR/canary-b64.txt" stdin \
  || fail 'Docker metadata credential scan failed or was incomplete.'
docker exec "$REDIS_NAME" redis-cli --scan >"$ARTIFACT_DIR/redis-keys.txt"
: >"$ARTIFACT_DIR/redis-values.txt"
while IFS= read -r key; do
  [[ -n "$key" ]] || continue
  docker exec "$REDIS_NAME" redis-cli --raw GET "$key" >>"$ARTIFACT_DIR/redis-values.txt"
done <"$ARTIFACT_DIR/redis-keys.txt"
timeout --kill-after=5s 30s node -e "$CROSSOVER_SCAN_SOURCE" "$SECRET_DIR/canary.txt" "$SECRET_DIR/canary-b64.txt" tree "$ARTIFACT_DIR" \
  || fail 'Artifact credential scan failed or was incomplete.'

STAGE='control-directory-crossover-proof'
CROSSOVER_SECRET_OWNERSHIP_CHANGED=1
set_crossover_secret_owner '65532:65532' || fail 'Scanner comparison files unavailable.'
timeout --kill-after=5s 30s docker run --rm --name "$CROSSOVER_SCAN_NAME" --label "$OWNER_LABEL" \
  --user=65532:65532 --network none --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=32 --memory=134217728 --memory-swap=134217728 --cpus=0.25 \
  --mount type=bind,src="$CONTROL_DIR",dst=/control,readonly \
  --mount type=bind,src="$SECRET_DIR/canary.txt",dst=/secret/canary.txt,readonly \
  --mount type=bind,src="$SECRET_DIR/canary-b64.txt",dst=/secret/canary-b64.txt,readonly \
  --entrypoint node "$SUPERVISOR_IMAGE" -e "$CROSSOVER_SCAN_SOURCE" /secret/canary.txt /secret/canary-b64.txt tree /control piece-supervisor.sock \
  >/dev/null 2>&1 || fail 'Control directory credential scan failed or was incomplete.'
set_crossover_secret_owner "$HOST_UID:$HOST_GID" || fail 'Scanner comparison ownership restoration failed.'
CROSSOVER_SECRET_OWNERSHIP_CHANGED=0
printf 'CREDENTIAL_CROSSOVER=0\n'

STAGE='protected-service-proof'
snapshot_protected "$ARTIFACT_DIR/protected-after.txt"
cmp -s "$ARTIFACT_DIR/protected-before.txt" "$ARTIFACT_DIR/protected-after.txt" || fail 'Protected services changed.'
[[ "$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:8788/v1/execute)" == '401' ]] || fail 'Protected Runner changed.'
[[ "$(docker exec redis redis-cli PING)" == 'PONG' ]] || fail 'Protected Redis changed.'
printf 'PROTECTED_SERVICES_UNCHANGED=PASS\n'

STAGE='success'
ACCEPTANCE_COMPLETED=1
cat <<'REPORT'
DISPOSABLE_REDIS=PASS
RUNNER_INTERNAL_NETWORK=PASS
PRIMARY_REAL_PROVIDER_401_PROOF=PASS
REPLAY_PROOF=PASS
LIVE_FAIL_CLOSED_PROOF=PASS
BAD_SIGNATURE_PROOF=PASS
SUPERVISOR_UNAVAILABLE_PROOF=PASS
CREDENTIAL_CROSSOVER_PROOF=PASS
ONE_PROVIDER_CONNECTION_PROOF=PASS
PROTECTED_SERVICES_PROOF=PASS
PRODUCT_DEPLOYMENT=NOT_PERFORMED_BY_HARNESS
REPORT

exit 0
