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
docker network create crazyloops-private 2>/dev/null || true
docker run -d \
  --name crazyloops-connector-runner \
  --restart unless-stopped \
  --network crazyloops-private \
  --env-file /opt/crazyloops/secrets/connector-runner.env \
  -p 127.0.0.1:8788:8788 \
  crazyloops-connector-runner:d16
```

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

## Mandatory persistence scan

Create an isolated evidence directory and copy/capture each surface without
printing the canary into the terminal or shell history:

```bash
EVIDENCE_DIR="$(mktemp -d /tmp/crazyloops-d16-evidence.XXXXXX)"
chmod 700 "$EVIDENCE_DIR"

docker logs crazyloops-connector-runner > "$EVIDENCE_DIR/runner-docker.log" 2>&1
docker inspect crazyloops-connector-runner > "$EVIDENCE_DIR/runner-inspect.json"
docker diff crazyloops-connector-runner > "$EVIDENCE_DIR/runner-diff.txt"
docker export crazyloops-connector-runner -o "$EVIDENCE_DIR/runner-filesystem.tar"

redis-cli --scan --pattern 'crazyloops:connector-runner:v1:*' \
  > "$EVIDENCE_DIR/redis-keys.txt"
while IFS= read -r key; do
  printf '%s\t' "$key"
  redis-cli --raw GET "$key"
done < "$EVIDENCE_DIR/redis-keys.txt" > "$EVIDENCE_DIR/redis-values.txt"

# Use the production log export mechanism already approved for CrazyLoops.
# Save stdout/stderr, structured logs, and operational telemetry exports here:
#   $EVIDENCE_DIR/crazyloops-runtime.log
#   $EVIDENCE_DIR/crazyloops-telemetry.json
#   $EVIDENCE_DIR/crazyloops-execution-export.json

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

1. runner stdout and stderr;
2. Docker logs;
3. Redis values and keys;
4. runner filesystem and temporary files;
5. any request/response capture;
6. CrazyLoops runtime logs;
7. CrazyLoops operational telemetry;
8. serialized workflow/execution output;
9. shell history created by the procedure;
10. Docker inspect/config metadata.

After preserving non-secret evidence, remove the control and evidence files:

```bash
rm -f -- "$CONTROL_FILE" /tmp/d16-canary-result.json
rm -rf -- "$EVIDENCE_DIR"
unset CONTROL_FILE EVIDENCE_DIR MATCH_COUNT D16_CANARY_CONFIRM
set -o history
```

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
