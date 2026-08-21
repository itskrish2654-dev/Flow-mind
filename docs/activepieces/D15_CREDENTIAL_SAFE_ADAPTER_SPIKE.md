# D1.5 credential-safe adapter spike

## Status

This is a non-production spike against Activepieces Community Edition `0.88.3`
(tag commit `54babcf9b3c6079125042134e2f70c7ce0f97a6a`). It does not register a
capability, modify the executor router, enable a connector, or change protocol v1.

The AES-256-GCM capsule is viable as a confidentiality boundary. A production
delegated connector is still blocked because arbitrary installed-piece invocation
cannot be proven secret-safe through supported Activepieces APIs, and the mandatory
real-worker persistence scan has not been run from this development environment.

## D1 invariants rechecked

`resolveDelegatedCredential` still requires the authenticated user to equal the
workflow owner, loads by both user ID and connection ID, requires a connected
record, derives provider/connector/operation/scopes/credential type from trusted
registries, and reads the latest secret only through `connection-vault.ts`.
Browser connection views do not import the vault. Protocol v1 remains the original
echo-only contract.

## Capsule protocol v2 spike

The spike envelope uses protocol version 2 and the internal-only canary capability
`internal.credential_canary`. That identifier is intentionally absent from the
capability registry and planner. Its capsule contains only:

```text
keyVersion, algorithm, nonce, ciphertext, authTag, expiresAt
```

Encryption is AES-256-GCM with a 12-byte random nonce and a maximum two-minute
lifetime (30 seconds by default). Authenticated additional data binds the capsule
to protocol version, request ID, execution ID, workflow-version ID, step ID,
capability ID, capability version, key version, algorithm, and expiry. Changing
any bound value makes authentication fail.

The dedicated key-ring environment is:

```text
CRAZYLOOPS_DELEGATED_WRAP_KEYS={"1":"<canonical padded Base64 for exactly 32 random bytes>"}
CRAZYLOOPS_DELEGATED_WRAP_ACTIVE_VERSION=1
```

It is separate from the bridge HMAC secret, the CrazyLoops credential master key,
Supabase keys, and OAuth client secrets. D1.5 does not create or install a real
production key. New capsules use only the active version; decryption can temporarily
accept the active and immediately previous versions.

The canary adapter accepts a credential only through a callback-scoped `Buffer`,
claims a non-secret capsule fingerprint before use, and overwrites the buffer in a
`finally` block. Its successful result is an HMAC proof. It never returns the
credential.

## Activepieces execution-path findings

The supported Activepieces piece path is not suitable for arbitrary dynamic auth:

1. `packages/server/engine/src/lib/handler/piece-executor.ts` resolves action input,
   assigns `censoredInput` to `stepOutput.input`, and sends a running-step update
   before calling the piece.
2. The same file passes `resolvedInput` to the internal `pieceRunner.call` API.
3. `packages/server/engine/src/lib/core/piece/piece-runner.ts` serializes that
   resolved input over Node IPC to a child process.
4. `packages/server/engine/src/lib/core/piece/piece-context-builder.ts` places the
   resolved authentication property in `context.auth`.
5. Piece stdout/stderr is forwarded into worker logs. Piece failures can include
   child-process output. There is no supported public API promising that an
   arbitrary piece will not log auth or include it in an exception.

Calling an installed piece directly from an AP code action would bypass the
supported executor and require reconstructing private `ActionContext` internals.
Those APIs are not public or stable, and it would still require per-piece proof
that logs/errors are secret-safe. D1.5 therefore does not implement that bypass.

The canary template uses one code action for decrypt-and-use. Its unresolved and
persisted input is the encrypted webhook event. The action decrypts and computes
the proof in the same child process, returns only the proof, catches failures to a
generic category, and overwrites its local plaintext/key buffers. It is a boundary
test, not a customer connector.

In sandboxed process modes the wrap-key variables must be explicitly allowlisted
through `AP_SANDBOX_PROPAGATED_ENV_VARS`; this behavior is implemented by
`packages/server/sandbox/src/lib/create-sandbox-for-job.ts`. The v2 test flow must
not be used in an environment where untrusted users can create code steps, because
an allowlisted worker environment variable is available to all code running in
that sandbox.

## Replay limitation

The CrazyLoops-side adapter contract requires an atomic `claim(fingerprint,
expiresAt)` operation, and automated tests prove one successful consumption. The
standalone AP code-action template has no supported durable atomic claim primitive.
Filesystem or process-memory claims are not reliable across workers or restarts.
The existing CrazyLoops durable execution/idempotency ledger and no-transport-retry
behavior remain unchanged, but they do not by themselves prove that a captured,
valid signed request cannot be replayed at the AP ingress. This is an additional
reason the v2 template is spike-only.

## Persistence surfaces and mandatory owner test

Local automated tests scan the serialized envelope, simulated AP trigger/run state,
adapter result, normalized errors, simulated worker/app logs, CrazyLoops telemetry,
and returned response for a runtime-generated high-entropy canary. They cannot
inspect the Oracle Activepieces PostgreSQL database, real AP log files, or real AP
cache from this workstation because no Oracle/worker access or D1.5 keys are
configured.

The owner must run the following against an isolated copy of the current worker,
never the accepted v1 production flow:

1. Import `crazyloops-bridge-worker-v2-canary-spike.json` as a separate unpublished
   flow, review it, then publish only that disposable flow.
2. Generate a fake wrapping key without printing it and store it in a mode-600
   temporary environment file:

   ```bash
   umask 077
   D15_WRAP_KEY="$(openssl rand -base64 32)"
   printf 'CRAZYLOOPS_DELEGATED_WRAP_KEYS={"1":"%s"}\nCRAZYLOOPS_DELEGATED_WRAP_ACTIVE_VERSION=1\n' "$D15_WRAP_KEY" > .env.d15
   unset D15_WRAP_KEY
   chmod 600 .env.d15
   ```

3. Add both variable names (not their values) to the AP worker's existing
   `AP_SANDBOX_PROPAGATED_ENV_VARS` comma-separated list, restart the isolated
   worker, and confirm v1 still works.
4. On the trusted operator machine, load the temporary values without echoing them,
   set `D15_CANARY_BRIDGE_URL` to the disposable v2 `/sync` URL, set the existing
   bridge HMAC secret, and run:

   ```bash
   D15_CANARY_CONFIRM=RUN_FAKE_D15_CANARY_ONLY npx tsx scripts/run-d15-canary-spike.ts
   ```

   The script prints a temporary canary-file path, request ID, status, and response
   occurrence count. It never prints the wrapping or bridge key.

5. Use the exact canary from that file and count it in every surface. Discover the
   actual Compose service names first; do not assume them:

   ```bash
   docker compose config --services
   AP_SERVICE=<activepieces-service-from-output>
   DB_SERVICE=<postgres-service-from-output>
   SCAN_DIR="$(mktemp -d)"
   CANARY_FILE=<path-printed-by-the-script>
   CANARY="$(tr -d '\r\n' < "$CANARY_FILE")"

   docker compose logs --no-color "$AP_SERVICE" > "$SCAN_DIR/ap.log"
   docker compose logs --no-color "$DB_SERVICE" > "$SCAN_DIR/postgres.log"
   docker compose exec -T "$DB_SERVICE" sh -lc \
     'pg_dump -U "$AP_POSTGRES_USERNAME" "$AP_POSTGRES_DATABASE"' \
     > "$SCAN_DIR/database.sql"

   AP_CONTAINER="$(docker compose ps -q "$AP_SERVICE")"
   docker cp "$AP_CONTAINER:/usr/src/app/cache" "$SCAN_DIR/cache" 2>/dev/null || true
   docker cp "$AP_CONTAINER:/tmp" "$SCAN_DIR/container-tmp" 2>/dev/null || true

   grep -R -a -F -- "$CANARY" "$SCAN_DIR" | tee "$SCAN_DIR/canary-matches.txt"
   grep -R -a -F -c -- "$CANARY" "$SCAN_DIR" | awk -F: '{total += $2} END {print "PLAINTEXT_CANARY_OCCURRENCES=" total+0}'
   ```

6. In the AP run-detail UI, inspect trigger input, action input/output, and error
   detail. Search exported page text for the exact canary. Inspect any external log
   drain separately. Run the same search after each failure case. Delete the
   disposable flow, remove `.env.d15`, remove the propagated variable names, restart,
   and securely delete the canary/scan files.

Acceptance requires the combined result to be exactly
`PLAINTEXT_CANARY_OCCURRENCES=0`. Ciphertext matches are expected and allowed.

## Error-path expectations

Decryption failure, expiry, binding mismatch, corruption, wrong key/version,
adapter failure, simulated 401/429/500, and timeout return only normalized error
categories and retryability. No error contains the credential, authorization
header, key, decrypted payload, or raw capsule.

## Rotation procedure

1. Add version `N+1` to `CRAZYLOOPS_DELEGATED_WRAP_KEYS` on CrazyLoops and the
   trusted worker while version `N` remains present.
2. Restart both sides and verify both versions decrypt in the isolated canary flow.
3. Change `CRAZYLOOPS_DELEGATED_WRAP_ACTIVE_VERSION` to `N+1` on CrazyLoops so all
   new capsules use the new key.
4. Wait longer than the maximum capsule lifetime plus clock-skew window.
5. Remove version `N` from both key rings and restart.
6. Re-run v1 and v2 canaries. Never reuse a numeric version for different key
   material.

## Admin hardening plan before D2

For the current combined app/worker topology, use path-aware Cloudflare Access or
equivalent reverse-proxy filtering on the existing worker hostname:

- Public, POST only: `/api/v1/webhooks/<exact-v2-flow-id>/sync`.
- Optionally public for origin monitoring only: `/api/v1/health`.
- Private/owner: every other path, including `/`, static editor assets, `/api/v1/*`
  other than the exact webhook, `/api/socket.io`, draft/test/async webhook variants,
  flow/run/connection APIs, and queue/admin pages.

The external worker does not need the editor or Socket.IO paths. In the combined
container, engine callbacks use loopback. If app and worker are later separated,
set `AP_INTERNAL_URL` to a private-network origin and verify worker callbacks before
blocking the public API. Keep port 8080 private at the firewall. Test Access rules
on a staging hostname first; do not change `AP_FRONTEND_URL` or production routing
blindly.
