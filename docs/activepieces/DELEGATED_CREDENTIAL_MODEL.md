# CrazyLoops delegated credential model

## Scope and evidence

This decision is based on Activepieces Community Edition `0.88.3`, tag commit
`54babcf9b3c6079125042134e2f70c7ce0f97a6a`. The relevant upstream sources are:

- [`app-connection.controller.ts`](https://github.com/activepieces/activepieces/blob/0.88.3/packages/server/api/src/app/app-connection/app-connection.controller.ts)
- [`app-connection-service.ts`](https://github.com/activepieces/activepieces/blob/0.88.3/packages/server/api/src/app/app-connection/app-connection-service/app-connection-service.ts)
- [`app-connection-worker-controller.ts`](https://github.com/activepieces/activepieces/blob/0.88.3/packages/server/api/src/app/app-connection/app-connection-worker-controller.ts)
- [`connection-resolver.ts`](https://github.com/activepieces/activepieces/blob/0.88.3/packages/server/engine/src/lib/piece-context/connection-resolver.ts)
- [`connection-token.ts`](https://github.com/activepieces/activepieces/blob/0.88.3/packages/server/engine/src/lib/variables/connection-token.ts)
- [`props-resolver.ts`](https://github.com/activepieces/activepieces/blob/0.88.3/packages/server/engine/src/lib/variables/props-resolver.ts)
- [`piece-context-builder.ts`](https://github.com/activepieces/activepieces/blob/0.88.3/packages/server/engine/src/lib/core/piece/piece-context-builder.ts)
- [`piece-executor.ts`](https://github.com/activepieces/activepieces/blob/0.88.3/packages/server/engine/src/lib/handler/piece-executor.ts)
- [`catch-hook.ts`](https://github.com/activepieces/activepieces/blob/0.88.3/packages/pieces/core/webhook/src/lib/triggers/catch-hook.ts)
- [`api-key-module.ts`](https://github.com/activepieces/activepieces/blob/0.88.3/packages/server/api/src/app/ee/api-keys/api-key-module.ts)

The CrazyLoops sources of truth remain `connector_connections` and the encrypted
`connector_connection_credentials` vault. No Activepieces identifier is added to
a workflow, browser DTO, connection view, or customer-visible state.

## Activepieces 0.88.3 findings

1. **Dynamic runtime authentication:** technically yes. A piece action's input is
   resolved before execution and `piece-context-builder.ts` supplies the resolved
   authentication property as `context.auth`.
2. **Credentials directly from a trigger payload:** technically possible, but not
   acceptable for CrazyLoops. The catch-webhook trigger returns the complete
   payload and the flow execution state retains trigger output. Only values
   resolved through `{{connections[...]}}` receive the engine's censored-input
   treatment. A plaintext token in the webhook body can therefore be retained in
   Activepieces run state/history.
3. **Connection management API:** yes. Project-scoped create/upsert, read, list,
   update, revalidate, replace, and delete routes exist under
   `/v1/app-connections`.
4. **Edition restrictions:** project connection storage and execution are core,
   but stable machine-to-machine `sk-*` API-key creation is gated by
   `platform.plan.apiKeysEnabled`. Global/platform connections and richer RBAC are
   also paid-edition features. The Community deployment must not depend on those
   gated features.
5. **Isolation of mirrored connections:** Activepieces checks platform and
   project membership. It does not understand CrazyLoops users inside one private
   bridge project. Per-CrazyLoops-user isolation would therefore remain an
   application responsibility and cannot be delegated to an AP connection ID.
6. **Values retained in runs:** webhook payloads, censored step inputs, and step
   outputs form the persisted execution state/log file. Connection-backed auth is
   represented as redacted input, while arbitrary trigger fields are ordinary
   values.
7. **Passing auth without run-history exposure:** supported when a piece resolves
   an Activepieces connection reference. It is not supported safely by putting a
   plaintext credential in the current webhook payload.
8. **Cleanup and revocation:** deleting an AP connection removes its encrypted
   connection row, but does not rewrite flows; later executions fail when the
   connection cannot resolve. This is useful defense in depth, not a replacement
   for CrazyLoops revocation.
9. **Community project isolation:** project-scoped connections are supported.
   Automated per-execution connection creation with a stable service credential
   is not a Community-safe assumption because API-key provisioning is feature
   gated. A shared AP project also provides no independent CrazyLoops-user
   boundary.

## Architecture decision

The selected source-of-truth model is **Model A: CrazyLoops owns credentials and
resolves the narrow credential projection for one execution**. Model B and Model C
are rejected for the Community deployment because they require an automated AP
connection lifecycle backed by a stable management credential, add a second
credential store, and make cleanup correctness part of every execution.

The implemented server-only resolver:

- requires the authenticated user to equal the workflow owner;
- loads a connection by both `connection_id` and `user_id`;
- requires `connected` status;
- derives connector, provider, operation, credential type, and scopes from the
  CrazyLoops capability and connector registries;
- reads the latest secret only through `connection-vault.ts`;
- returns only `{ kind, value }` to a server-only caller;
- produces generic typed failures with no account or secret content.

The resolver reads the vault on every call. Rotation therefore affects the next
resolution immediately. Revocation deletes the vault row and changes the
connection status, so all later resolutions fail closed. Account deletion already
calls `revokeAllUserConnections` and the connector cleanup RPC.

## Bridge boundary and current blocker

Protocol v1 remains byte-for-byte an echo-only contract. It has no credential
field and must never be extended in place. No D1 code serializes the resolver's
plaintext projection into the v1 envelope.

Before any customer delegated connector can be enabled, the bridge needs a
separately reviewed, versioned credential transport/execution contract that proves
plaintext credentials are not retained in Activepieces trigger payloads, action
inputs, outputs, errors, or execution history. A normal v1 webhook field is not
such a contract. Until that proof exists, the executor router must continue to
allow only `internal.bridge_echo` through Activepieces.

## Secret-safe observability

Allowed telemetry is limited to request, execution, workflow version, step,
capability, connector, executor, duration, and normalized result category. The
credential projection is not an operational-event field. Errors are generic and
do not include provider responses or secret values. Browser-facing connection
views query only non-secret connection metadata and never import the vault.

## Admin/public routing boundary

Before real delegated credentials are introduced, the Activepieces editor must not
be generally internet-accessible. Keep `AP_FRONTEND_URL` aligned with the public
worker origin, but expose only the exact live webhook path (including `/sync`) at
the public reverse proxy. Provide owner access through a private network, an SSH
tunnel, or a separately tested private admin hostname.

Do not put an access challenge over the entire worker hostname: CrazyLoops must be
able to reach the webhook, and Activepieces UI, API, Socket.IO, and absolute URL
behavior can depend on `AP_FRONTEND_URL`. Verify the precise 0.88.3 routes in a
staging copy before applying path rules. The target boundary is:

```text
public worker hostname -> allowlisted published webhook path only
private owner channel  -> editor/API/Socket.IO
Activepieces :8080     -> loopback/private network only
```

No Cloudflare or reverse-proxy change is part of D1.
