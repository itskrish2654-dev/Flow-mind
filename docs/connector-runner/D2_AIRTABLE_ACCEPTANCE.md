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

## 2. Prepare independent operator secrets and server-owned configuration

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

The post-D1.7 production state has the Connector Runner disabled. Temporarily set:

```text
CONNECTOR_RUNNER_EXECUTION_ENABLED=true
```

Deploy only the reviewed D2.1 commit for this controlled window. Do not modify
Cloudflare, Activepieces, Redis exposure, or the runner-host configuration.

## 3. Provision the disposable PAT exactly once

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

Do not call provisioning twice. Verify the connection metadata and credential row
in Supabase. Only encrypted `ciphertext`, `nonce`, and `auth_tag` may be stored;
there must be no plaintext credential column or plaintext value.

## 4. Execute create-record exactly once

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

## 5. Verify execution, telemetry, and replay behavior

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

## 6. Run the required plaintext persistence scan

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

## 7. Cleanup and restore the accepted production state

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
