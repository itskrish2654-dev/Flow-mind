# CrazyLoops Connector Runner D1.6 owner procedure

## Status and boundary

D1.6 adds a separate CrazyLoops-owned executor. It does not modify Activepieces
protocol v1 and it does not register a customer-visible integration. The only
runner capability is `internal.connector_runner_canary@1`.

The runner receives a bounded, HMAC-authenticated protocol-v1 envelope containing
an AES-256-GCM credential capsule. It has no Supabase key, CrazyLoops credential
master key, user session, workflow definition, or Activepieces database access.
Its only durable state is a Redis replay claim in the namespace:

```text
crazyloops:connector-runner:v1:replay:<sha256 fingerprint>
```

The claim is established with `SET key 1 NX PX <capsule lifetime>`. Redis failure
is a closed failure. A duplicate returns `DELEGATED_REPLAYED`; it is not retried by
the runner. CrazyLoops remains the only owner of business retry policy.

## Secrets and rotation

Generate independent transport and wrapping secrets. Do not reuse the
Activepieces bridge secret, the CrazyLoops credential master key, or an OAuth
provider secret.

```bash
umask 077
openssl rand -base64 48 > connector-runner-transport-secret
openssl rand -base64 32 > connector-runner-wrap-key-v1
```

Configure the same `CONNECTOR_RUNNER_SECRET` and active wrapping-key version on
CrazyLoops and the runner. Configure Redis only on the runner host. A rotation
adds `CONNECTOR_RUNNER_WRAP_KEY_V2`, changes the active version to `2`, and keeps
V1 on the runner only until every V1 capsule's maximum 120-second lifetime has
expired. Then remove V1 and restart the runner.

No D1.6 variable may use a `NEXT_PUBLIC_` prefix.

## Build and private deployment

Run these only after the D1.6 code commit is accepted. They are intentionally not
performed by the implementation phase.

```bash
cd /opt/crazyloops/source/services/connector-runner
docker build --pull -t crazyloops-connector-runner:d16 .
docker network inspect crazyloops-private >/dev/null 2>&1 || \
  docker network create crazyloops-private

# Attach the existing Redis container without changing its current networks.
if ! docker network inspect crazyloops-private \
  --format '{{range .Containers}}{{println .Name}}{{end}}' | grep -qx redis; then
  docker network connect crazyloops-private redis
fi

# Redis must have no host-published port. Stop if 6379 has a HostPort mapping.
docker inspect redis --format '{{json .NetworkSettings.Ports}}'
docker exec redis redis-cli PING

docker run -d \
  --name crazyloops-connector-runner \
  --restart unless-stopped \
  --network crazyloops-private \
  --env-file /opt/crazyloops/secrets/connector-runner.env \
  -p 127.0.0.1:8788:8788 \
  crazyloops-connector-runner:d16
```

The runner environment file must contain:

```text
CONNECTOR_RUNNER_REDIS_URL=redis://redis:6379/0
```

Never publish Redis with `-p 6379:6379` or any equivalent host mapping. Redis is
reachable by the runner only through `crazyloops-private`. The runner joins only
that network and publishes only `127.0.0.1:8788:8788`. Do not edit the existing
Activepieces compose configuration, restart the BHISMULDSRVACDC VM, or restart
unrelated services for this procedure.

The container listens on `0.0.0.0:8788` internally only because Docker publishes
it to host loopback. Do not publish `0.0.0.0:8788` on the host. Route exactly one
Cloudflare Tunnel or reverse-proxy path to it:

```text
POST /v1/execute -> http://127.0.0.1:8788/v1/execute
```

Reject every other method and path. Do not expose a Docker management port,
Redis, or the runner directly to the LAN/internet. The public/provider-facing
origin must use HTTPS. Keep both execution flags false during initial deployment:

```text
DELEGATED_EXECUTION_ENABLED=false
CONNECTOR_RUNNER_EXECUTION_ENABLED=false
```

## Real fake-credential canary

Run the canary from a trusted CrazyLoops checkout with an isolated shell whose
history is disabled. The script generates the high-entropy fake credential and
writes it only to a mode-0600 control file. It never prints the plaintext.

```bash
set +o history
umask 077
export D16_CANARY_CONFIRM=RUN_FAKE_D16_CANARY_ONLY
export DELEGATED_EXECUTION_ENABLED=true
export CONNECTOR_RUNNER_EXECUTION_ENABLED=true
npx tsx scripts/run-d16-canary.ts | tee /tmp/d16-canary-result.json
CONTROL_FILE="$(node -e 'const fs=require("fs");const x=JSON.parse(fs.readFileSync("/tmp/d16-canary-result.json","utf8"));process.stdout.write(x.controlFile)')"
test -f "$CONTROL_FILE"
```

The control file is the intentional test input and is excluded from the leak
count. Every other surface below must be inspected after the request. If a
surface cannot be inspected, D1.6 cannot receive the READY verdict.

## Mandatory runner-host surfaces and persistence scan

Create an isolated evidence directory and copy/capture each surface without
printing the canary into the terminal or shell history:

```bash
EVIDENCE_DIR="$(mktemp -d /tmp/crazyloops-d16-evidence.XXXXXX)"
chmod 700 "$EVIDENCE_DIR"

docker logs crazyloops-connector-runner > "$EVIDENCE_DIR/runner-docker.log" 2>&1
docker inspect crazyloops-connector-runner > "$EVIDENCE_DIR/runner-inspect.json"
docker diff crazyloops-connector-runner > "$EVIDENCE_DIR/runner-diff.txt"
docker export crazyloops-connector-runner -o "$EVIDENCE_DIR/runner-filesystem.tar"

docker exec redis redis-cli --scan --pattern 'crazyloops:connector-runner:v1:*' \
  > "$EVIDENCE_DIR/redis-keys.txt"
while IFS= read -r key; do
  printf '%s\t' "$key"
  docker exec redis redis-cli --raw GET "$key"
done < "$EVIDENCE_DIR/redis-keys.txt" > "$EVIDENCE_DIR/redis-values.txt"

find /tmp -type f ! -samefile "$CONTROL_FILE" -maxdepth 3 -print0 2>/dev/null \
  | xargs -0 -r grep -aFl -f "$CONTROL_FILE" \
  > "$EVIDENCE_DIR/host-temp-matches.txt" || true

history > "$EVIDENCE_DIR/shell-history.txt" 2>/dev/null || true
grep -aRFl -f "$CONTROL_FILE" "$EVIDENCE_DIR" \
  > "$EVIDENCE_DIR/plaintext-matches.txt" || true

MATCH_COUNT="$(wc -l < "$EVIDENCE_DIR/plaintext-matches.txt" | tr -d ' ')"
printf 'PLAINTEXT_CANARY_OCCURRENCES=%s\n' "$MATCH_COUNT"
test "$MATCH_COUNT" = "0"
```

Also inspect any Cloudflare/reverse-proxy request capture if body capture was
enabled. The normal configuration must not capture request bodies. Encrypted
ciphertext may exist; plaintext may not.

Required surfaces:

1. runner stdout, stderr, and Docker logs;
2. runner filesystem and temporary files;
3. Docker inspect/config metadata;
4. Redis keys and values;
5. ingress or reverse-proxy request capture, when enabled;
6. the returned response;
7. host temporary files and shell history created by the procedure.

These runner-host surfaces are mandatory for the real host canary. The control
file is the only intentional plaintext copy and is excluded from the match count.

## CrazyLoops-side surfaces and truthful claims

The automated tests cover CrazyLoops telemetry and log serialization without
persisting credential plaintext. Running the canary script from a trusted local
checkout proves the client/runner exchange and the inspected runner-host
surfaces; it does **not** prove that production Vercel runtime logs, telemetry,
or execution persistence were scanned.

Only claim production Vercel runtime verification after a real invocation has
originated in the Vercel runtime and its runtime logs, operational telemetry,
and serialized execution output have been exported and scanned. This D1.6
pre-host fix does not add a public diagnostic route.

After preserving non-secret evidence, remove the control and evidence files:

```bash
rm -f -- "$CONTROL_FILE" /tmp/d16-canary-result.json
rm -rf -- "$EVIDENCE_DIR"
unset CONTROL_FILE EVIDENCE_DIR MATCH_COUNT D16_CANARY_CONFIRM
set -o history
```

If the canary is abandoned or the runner is removed, clean up without touching
Redis's existing networks or restarting it:

```bash
docker stop crazyloops-connector-runner 2>/dev/null || true
docker rm crazyloops-connector-runner 2>/dev/null || true
docker network disconnect crazyloops-private redis 2>/dev/null || true
docker network rm crazyloops-private 2>/dev/null || true
```

Disconnect Redis only after the runner has been removed and the added private
network is no longer needed. Never disconnect Redis from its pre-existing
Activepieces network.

## Failure-path canaries

Repeat with fresh canaries and unique request IDs for invalid HMAC, stale
timestamp, digest mismatch, wrong wrap key, corrupt/expired capsule, duplicate,
Redis unavailable, unsupported capability, adapter exception, simulated provider
401/429/500, and timeout. Restore Redis immediately after its isolated failure
test. Run the complete scan after every batch. No test may use a real provider
credential.

## Activation rule

Do not enable the Vercel runner flag or advertise a connector until all required
real surfaces have been inspected and the recorded result is exactly:

```text
PLAINTEXT_CANARY_OCCURRENCES=0
```
