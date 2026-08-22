# D2 Airtable create-record controlled acceptance

This is the owner-only, single-request acceptance procedure for
`airtable.create_record@1`. It is not customer setup. Never use a customer
account, base, table, record, or credential, and never paste any secret into chat.

## 1. Prepare disposable Airtable resources

1. Create a dedicated Airtable test workspace, base, and table.
2. Add one plain-text field named `Acceptance value`.
3. Create a disposable Personal Access Token restricted to that base with only
   `data.records:write`.
4. Record the `app...` base ID and `tbl...` table ID. Do not copy the PAT into a
   source file, SQL statement, environment variable, URL, command argument, or
   persistent shell history.

## 2. Upgrade only the Connector Runner and complete host preflight

Do this on the runner host before enabling Vercel execution or provisioning the
PAT. A Vercel deployment does not rebuild the home-hosted runner image. Do not
continue unless the checkout is the exact reviewed and merged D2.3 commit.

Record the existing container and immutable image details in a protected rollback
directory. Keep the old image; do not overwrite its tag or delete it during D2.

```bash
set -euo pipefail
umask 077
cd /opt/crazyloops/source

EXPECTED_D23_SHA='<full reviewed and merged D2.3 Git SHA>'
CURRENT_SHA="$(git rev-parse HEAD)"
test "$CURRENT_SHA" = "$EXPECTED_D23_SHA"
test -z "$(git status --porcelain)"

ROLLBACK_DIR="$(mktemp -d /tmp/crazyloops-d2-runner-rollback.XXXXXX)"
chmod 700 "$ROLLBACK_DIR"
docker inspect crazyloops-connector-runner > "$ROLLBACK_DIR/old-container.json"
OLD_RUNNER_IMAGE_ID="$(docker inspect crazyloops-connector-runner --format '{{.Image}}')"
OLD_RUNNER_IMAGE_REF="$(docker inspect crazyloops-connector-runner --format '{{.Config.Image}}')"
printf '%s\n' "$OLD_RUNNER_IMAGE_ID" > "$ROLLBACK_DIR/old-image-id.txt"
printf '%s\n' "$OLD_RUNNER_IMAGE_REF" > "$ROLLBACK_DIR/old-image-ref.txt"
docker image inspect "$OLD_RUNNER_IMAGE_ID" > "$ROLLBACK_DIR/old-image.json"

test "$(docker inspect crazyloops-connector-runner --format '{{.HostConfig.RestartPolicy.Name}}')" = 'unless-stopped'
test "$(docker port crazyloops-connector-runner 8788/tcp)" = '127.0.0.1:8788'
docker network inspect crazyloops-private \
  --format '{{range .Containers}}{{println .Name}}{{end}}' | grep -qx crazyloops-connector-runner
docker network inspect crazyloops-private \
  --format '{{range .Containers}}{{println .Name}}{{end}}' | grep -qx redis
test "$(docker inspect redis --format '{{with (index .NetworkSettings.Ports "6379/tcp")}}{{len .}}{{else}}0{{end}}')" = '0'
test "$(docker exec redis redis-cli PING)" = 'PONG'
```

Keep the existing Vercel state at this point:

```text
CONNECTOR_RUNNER_EXECUTION_ENABLED=false
```

Build a release-specific image from the reviewed runner directory. The exact Git
SHA in the tag prevents this build from overwriting the rollback image.

```bash
NEW_RUNNER_IMAGE="crazyloops-connector-runner:d23-${CURRENT_SHA}"
docker build --pull \
  --label "com.crazyloops.git-sha=${CURRENT_SHA}" \
  --tag "$NEW_RUNNER_IMAGE" \
  services/connector-runner

docker run --rm --entrypoint sh "$NEW_RUNNER_IMAGE" -ec '
  test "$(id -un)" = "node"
  test "$(id -u)" = "1000"
  test -r /runner/src/index.mjs
  test -r /runner/src/runner.mjs
  test -x /runner/src/adapters
  test -r /runner/src/adapters/airtable.mjs
'

docker run --rm --entrypoint node "$NEW_RUNNER_IMAGE" --input-type=module --eval '
  const fs = await import("node:fs");
  const airtable = await import("./src/adapters/airtable.mjs");
  const runnerModule = await import("./src/runner.mjs");
  const runnerSource = fs.readFileSync("./src/runner.mjs", "utf8");
  if (airtable.AIRTABLE_CREATE_RECORD_CAPABILITY !== "airtable.create_record" ||
      airtable.AIRTABLE_CREATE_RECORD_VERSION !== 1 ||
      runnerModule.CANARY_CAPABILITY !== "internal.connector_runner_canary" ||
      !runnerSource.includes("[adapterKey(CANARY_CAPABILITY, 1)") ||
      !runnerSource.includes("createAirtableCreateRecordAdapter")) process.exit(1);
'
```

Both probes run as the image's default `node` user. Do not add `--user root` to
either command. They prove the default runtime can read `index.mjs` and
`runner.mjs`, traverse `src/adapters`, read and import `airtable.mjs`, and find
`internal.connector_runner_canary@1` plus `airtable.create_record@1` before the
live runner is replaced.

Replace only `crazyloops-connector-runner`. Reuse the existing protected env
file, private network, Redis attachment, restart policy, and loopback binding.
Do not restart Redis or Activepieces. Do not edit/restart Cloudflare or create a
second runner on another port.

The preflight below requires Redis `PONG`, local unsigned POST `401`, and public
unsigned POST `401` before the execution window may open.

```bash
docker stop crazyloops-connector-runner
docker rm crazyloops-connector-runner
docker run -d \
  --name crazyloops-connector-runner \
  --restart unless-stopped \
  --network crazyloops-private \
  --env-file /opt/crazyloops/secrets/connector-runner.env \
  -p 127.0.0.1:8788:8788 \
  "$NEW_RUNNER_IMAGE"

test "$(docker inspect crazyloops-connector-runner --format '{{.State.Running}}')" = 'true'
test "$(docker inspect crazyloops-connector-runner --format '{{.HostConfig.RestartPolicy.Name}}')" = 'unless-stopped'
test "$(docker port crazyloops-connector-runner 8788/tcp)" = '127.0.0.1:8788'
test "$(docker exec redis redis-cli PING)" = 'PONG'
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST --header 'Content-Type: application/json' --data '{}' \
  http://127.0.0.1:8788/v1/execute)" = '401'
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST --header 'Content-Type: application/json' --data '{}' \
  https://runner.crazy-loops.com/v1/execute)" = '401'

NEW_RUNNER_IMAGE_ID="$(docker inspect crazyloops-connector-runner --format '{{.Image}}')"
test "$NEW_RUNNER_IMAGE_ID" = "$(docker image inspect "$NEW_RUNNER_IMAGE" --format '{{.Id}}')"
printf 'RUNNER_GIT_SHA=%s\nRUNNER_IMAGE=%s\nRUNNER_IMAGE_ID=%s\n' \
  "$CURRENT_SHA" "$NEW_RUNNER_IMAGE" "$NEW_RUNNER_IMAGE_ID" \
  > "$ROLLBACK_DIR/new-release.txt"
```

If any replacement preflight fails, restore the exact previous immutable image;
do not change the env file, network, Redis, Activepieces, or Cloudflare:

```bash
docker stop crazyloops-connector-runner 2>/dev/null || true
docker rm crazyloops-connector-runner 2>/dev/null || true
docker run -d \
  --name crazyloops-connector-runner \
  --restart unless-stopped \
  --network crazyloops-private \
  --env-file /opt/crazyloops/secrets/connector-runner.env \
  -p 127.0.0.1:8788:8788 \
  "$OLD_RUNNER_IMAGE_ID"
test "$(docker inspect crazyloops-connector-runner --format '{{.State.Running}}')" = 'true'
test "$(docker port crazyloops-connector-runner 8788/tcp)" = '127.0.0.1:8788'
test "$(docker exec redis redis-cli PING)" = 'PONG'
```

Stop the acceptance if rollback was required. Retain `ROLLBACK_DIR`, the old
image ID, the release tag, image ID, and Git SHA as non-secret evidence until D2
is complete.

## 3. Prepare operator secrets and open the controlled execution window

Generate two different random secrets of at least 32 characters:

- `D2_AIRTABLE_PROVISION_SECRET`
- `D2_AIRTABLE_ACCEPTANCE_SECRET`

They must not equal one another or any runner transport, wrap, vault, cron,
schedule, OAuth, provider, application, or other operator secret.

Generate a disposable CrazyLoops owner and an operator-chosen connection UUID.
Configure these temporary server-only Vercel Production variables:

```text
D2_AIRTABLE_PROVISION_ENABLED=true
D2_AIRTABLE_PROVISION_SECRET=<dedicated provision operator secret>
D2_AIRTABLE_ACCEPTANCE_ENABLED=true
D2_AIRTABLE_ACCEPTANCE_SECRET=<different dedicated execution operator secret>
D2_AIRTABLE_ACCEPTANCE_OWNER_ID=<disposable CrazyLoops auth.users UUID>
D2_AIRTABLE_ACCEPTANCE_CONNECTION_ID=<new operator-generated UUID>
D2_AIRTABLE_ACCEPTANCE_BASE_ID=<dedicated app... ID>
D2_AIRTABLE_ACCEPTANCE_TABLE_ID=<dedicated tbl... ID>
D2_AIRTABLE_ACCEPTANCE_FIELDS_JSON={"Acceptance value":"CRAZYLOOPS_D2_<distinctive non-sensitive value>"}
```

Confirm the accepted delegated foundation already has:

```text
DELEGATED_EXECUTION_ENABLED=true
```

Do not change that flag during D2. If it is not already true, stop and resolve the
unexpected production configuration rather than expanding this procedure.

Only after every runner-host preflight above passes, temporarily set:

```text
CONNECTOR_RUNNER_EXECUTION_ENABLED=true
```

Deploy only the reviewed D2.3 commit for this controlled window. Do not modify
Cloudflare, Activepieces, Redis exposure, or the runner-host configuration.

## 4. Provision the disposable PAT exactly once

Use an isolated Bash session with history disabled. Read the PAT silently into an
unexported shell variable, then stream it as a bounded raw body. It must not be a
URL/query/header/JSON value, environment variable, file, or command argument.

```bash
set +o history
umask 077
IFS= read -r -s -p 'Disposable Airtable PAT: ' D2_PAT
printf '\n'
printf '%s' "$D2_PAT" | curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${D2_AIRTABLE_PROVISION_SECRET}" \
  --header 'Content-Type: application/octet-stream' \
  --data-binary @- \
  https://www.crazy-loops.com/api/operations/connector-runner-airtable-provision \
  > /tmp/crazyloops-d2-provision-response.json
chmod 600 /tmp/crazyloops-d2-provision-response.json
```

The only successful response shape is:

```json
{"ok":true,"connectionId":"<configured UUID>"}
```

The provisioner refuses an existing connection ID, creates only an internal
`airtable` / `api_key` connection with `data.records:write`, and immediately calls
the existing encrypted vault with credential key/type `api_key` / `api_key`. It
accepts no caller configuration. The current vault API requires one unavoidable
transient immutable JavaScript string; complete process-memory zeroization is not
claimed. Mutable request and provisioner buffers are zeroized best-effort.

If provisioning does not return that exact success response, **do not retry**.
First inspect the configured disposable connection ID and confirm that no active
connection or encrypted credential remains. If a fallback revoke was required,
the connection must have `status = revoked` and `granted_scopes = []` before any
manual cleanup. A cleanup failure requires operator intervention; never reuse the
same connection ID.

Do not call provisioning twice. Verify the connection metadata and credential row
in Supabase. Only encrypted `ciphertext`, `nonce`, and `auth_tag` may be stored;
there must be no plaintext credential column or plaintext value.

## 5. Execute create-record exactly once

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${D2_AIRTABLE_ACCEPTANCE_SECRET}" \
  https://www.crazy-loops.com/api/operations/connector-runner-airtable-canary \
  > /tmp/crazyloops-d2-execution-response.json
chmod 600 /tmp/crazyloops-d2-execution-response.json
```

Do not automatically retry a timeout, network failure, 5xx, or lost response.
Airtable create-record has no native idempotency key. First inspect Airtable for
the distinctive value; a second invocation creates a new capsule and may create a
duplicate record.

Acceptance requires exactly one acceptance HTTP invocation, one runner invocation,
one Airtable API attempt, exactly one matching Airtable record, and a sanitized
response whose `recordId` equals the created Airtable record ID.

## 6. Verify execution, telemetry, and replay behavior

Confirm:

1. the Vercel invocation succeeded;
2. operational telemetry has one started/succeeded pair for
   `airtable.create_record` with no input/output body;
3. runner logs have one started/succeeded pair;
4. the Redis replay claim was established before capsule decryption;
5. Airtable has exactly one matching record and the returned record ID matches;
6. the returned response contains no provider response body or credential data.

Do not resend the production request to test replay. Exact duplicate-envelope
rejection is covered by the D2 automated test. A new signed envelope is a new
provider operation and is not provider exactly-once.

## 7. Run the required plaintext persistence scan

Keep `D2_PAT` unexported until scanning is complete. Export the relevant Vercel
runtime logs, `operational_events`, serialized execution outputs, and operator
response files into a mode-0700 evidence directory. On the runner host collect:

```bash
EVIDENCE_DIR="$(mktemp -d /tmp/crazyloops-d2-evidence.XXXXXX)"
chmod 700 "$EVIDENCE_DIR"
docker logs crazyloops-connector-runner > "$EVIDENCE_DIR/runner.log" 2>&1
docker inspect crazyloops-connector-runner > "$EVIDENCE_DIR/runner-inspect.json"
docker export crazyloops-connector-runner -o "$EVIDENCE_DIR/runner-filesystem.tar"
journalctl -u cloudflared --since '30 minutes ago' > "$EVIDENCE_DIR/cloudflared.log"
docker exec redis redis-cli --scan --pattern 'crazyloops:connector-runner:v1:*' \
  > "$EVIDENCE_DIR/redis-keys.txt"
while IFS= read -r key; do
  printf '%s\t' "$key"
  docker exec redis redis-cli --raw GET "$key"
done < "$EVIDENCE_DIR/redis-keys.txt" > "$EVIDENCE_DIR/redis-values.txt"
```

Extract text-readable runner filesystem evidence into the protected directory.
Scan without placing the PAT in a command argument or pattern file:

```bash
grep -aRFl -f <(printf '%s' "$D2_PAT") "$EVIDENCE_DIR" \
  > "$EVIDENCE_DIR/plaintext-matches.txt" || true
MATCH_COUNT="$(wc -l < "$EVIDENCE_DIR/plaintext-matches.txt" | tr -d ' ')"
printf 'PLAINTEXT_PAT_PERSISTENCE_OCCURRENCES=%s\n' "$MATCH_COUNT"
test "$MATCH_COUNT" = '0'
```

Required count: **0** across Vercel runtime logs, operational telemetry,
serialized execution outputs, runner Docker logs, Cloudflared journal, Redis
keys/values, Docker inspect, exported runner filesystem, relevant temporary
files, shell history, and both operator response files. Do not print matching
content. Encrypted capsule/vault ciphertext is allowed; plaintext is not.

## 8. Cleanup and restore the accepted production state

1. Revoke/delete the disposable PAT in Airtable.
2. Delete the disposable `connector_connections` row by the exact configured
   connection ID and owner ID, additionally requiring `connector_id = 'airtable'`.
   The foreign key cascade removes its encrypted credential. Verify both rows are
   gone. No PAT is used in SQL.
3. Set both temporary route flags to false, then remove every D2 provision and
   acceptance variable:

```text
D2_AIRTABLE_PROVISION_ENABLED=false
D2_AIRTABLE_ACCEPTANCE_ENABLED=false
```

4. Restore the post-D1.7 runner flag exactly:

```text
CONNECTOR_RUNNER_EXECUTION_ENABLED=false
```

5. Redeploy, confirm `GET /api/health` returns HTTP 200 with application/database
   OK, and verify both D2 routes now reject requests.
6. Unset the unexported PAT variable and remove response/evidence files after
   retaining only non-secret counts and IDs:

```bash
unset D2_PAT
rm -f /tmp/crazyloops-d2-provision-response.json \
  /tmp/crazyloops-d2-execution-response.json
rm -rf -- "$EVIDENCE_DIR"
```
