# D2 Airtable create-record controlled acceptance

This is an owner-only, one-request production acceptance procedure for
`airtable.create_record@1`. It is not customer setup and must not be linked from
the product. Do not use a customer account, base, table, or credential.

## Prepare the disposable provider resource

1. Create a dedicated Airtable test workspace, base, and table.
2. Add a plain text field dedicated to the test, for example `Acceptance value`.
3. Create a Personal Access Token restricted to that one base with only
   `data.records:write`. Airtable account/base permissions still apply.
4. Create an owner-scoped `connector_connections` record with connector and
   provider family `airtable`, auth type `api_key`, connected status, and granted
   scope `data.records:write`.
5. From trusted server-only setup code, call the existing
   `storeConnectionSecret` vault function with credential key `api_key` and
   credential type `api_key`. Never put the PAT in SQL, source, a Vercel command
   argument, an environment variable, or the runner environment.

The only intentional plaintext copies are Airtable's token display and the
trusted vault setup process memory. The stored credential must be ciphertext in
CrazyLoops. Confirm browser APIs and connection views return no credential data.

## Configure the temporary Vercel acceptance surface

Generate a new dedicated operator secret. It must not equal any other application
secret. Configure these server-only values for the controlled deployment:

```text
D2_AIRTABLE_ACCEPTANCE_ENABLED=true
D2_AIRTABLE_ACCEPTANCE_SECRET=<new dedicated random value, at least 32 characters>
D2_AIRTABLE_ACCEPTANCE_OWNER_ID=<disposable CrazyLoops owner UUID>
D2_AIRTABLE_ACCEPTANCE_CONNECTION_ID=<owned Airtable connection UUID>
D2_AIRTABLE_ACCEPTANCE_BASE_ID=<dedicated app... ID>
D2_AIRTABLE_ACCEPTANCE_TABLE_ID=<dedicated tbl... ID>
D2_AIRTABLE_ACCEPTANCE_FIELDS_JSON={"Acceptance value":"CRAZYLOOPS_D2_<distinctive non-sensitive value>"}
```

Keep the established connector-runner transport, wrap-key, URL, and execution
flags unchanged. The acceptance route reads no request body, and its caller
cannot provide a base, table, fields, connection, token, URL, method, or header.

## Execute exactly once

Disable shell history and load the operator secret without printing it. Then make
one request only:

```bash
set +o history
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${D2_AIRTABLE_ACCEPTANCE_SECRET}" \
  https://www.crazy-loops.com/api/operations/connector-runner-airtable-canary \
  > /tmp/crazyloops-d2-result.json
chmod 600 /tmp/crazyloops-d2-result.json
```

Do not automatically retry a timeout, network failure, 5xx, or lost response.
Airtable create-record has no native idempotency key. First inspect the test table
for the distinctive value; retrying an ambiguous create may create a duplicate.

Acceptance requires one HTTP invocation, one runner invocation, one Airtable API
attempt, exactly one new Airtable record, and a response containing only the
matching `recordId` plus CrazyLoops request/execution identifiers.

## Verify the execution and replay boundary

Confirm the Vercel runtime execution and operational telemetry contain succeeded
events for `airtable.create_record`, the runner contains one started/succeeded
pair, and Airtable contains exactly one matching record whose ID equals the
sanitized response. Confirm the runner performed Redis `SET ... NX PX` before
capsule decryption. Do not send a second acceptance request: a new request creates
a new capsule and is a new provider operation. Duplicate delivery of the exact
same signed envelope/capsule must return `DELEGATED_REPLAYED`; this invariant is
covered by the D2 automated test and may be verified only with a captured
non-secret test envelope in a controlled runner test.

## Plaintext persistence scan

Prepare a mode-0600 pattern file containing the PAT without placing the PAT in a
command argument or shell history. Exclude that intentional pattern file from
the count. Capture and scan all of these surfaces:

1. Vercel runtime logs created for the acceptance request;
2. CrazyLoops operational telemetry and serialized execution output;
3. connector-runner Docker logs;
4. Cloudflared journal and any ingress capture (request bodies must be disabled);
5. Redis replay keys and values;
6. Docker inspect/config metadata;
7. exported runner filesystem, runner temporary files, and host temporary files;
8. returned response and the isolated shell history.

Runner-host collection must use the containerized Redis CLI; Redis remains on the
private Docker network and port 6379 must not be host-published:

```bash
EVIDENCE_DIR="$(mktemp -d /tmp/crazyloops-d2-evidence.XXXXXX)"
chmod 700 "$EVIDENCE_DIR"
docker logs crazyloops-connector-runner > "$EVIDENCE_DIR/runner.log" 2>&1
docker inspect crazyloops-connector-runner > "$EVIDENCE_DIR/runner-inspect.json"
docker export crazyloops-connector-runner -o "$EVIDENCE_DIR/runner-filesystem.tar"
journalctl -u cloudflared --since "10 minutes ago" > "$EVIDENCE_DIR/cloudflared.log"
docker exec redis redis-cli --scan --pattern 'crazyloops:connector-runner:v1:*' \
  > "$EVIDENCE_DIR/redis-keys.txt"
while IFS= read -r key; do
  printf '%s\t' "$key"
  docker exec redis redis-cli --raw GET "$key"
done < "$EVIDENCE_DIR/redis-keys.txt" > "$EVIDENCE_DIR/redis-values.txt"
```

Export the Vercel and telemetry evidence into the same protected directory, then
scan extracted text and binary surfaces with `grep -aFl -f <PATTERN_FILE>`. The
required plaintext occurrence count outside the intentional pattern file is
zero. Do not print matching content. Encrypted capsule ciphertext is allowed;
plaintext is not.

## Cleanup

Immediately set `D2_AIRTABLE_ACCEPTANCE_ENABLED=false`, remove all temporary D2
acceptance variables, and redeploy. Revoke/delete the disposable PAT in Airtable,
call the existing owner-scoped connection revocation flow so the encrypted vault
row is deleted, and remove the disposable Airtable base/workspace if desired.
Delete protected result, pattern, and evidence files after retaining only
non-secret acceptance counts and identifiers.
