# CrazyLoops reviewed piece runtime architecture v1

## Status and boundary

This is the production-candidate core created by Essential 50 Step 5A. It is
disconnected from the CrazyLoops product and is not deployed. CrazyLoops
remains the system of record. Activepieces packages are used only as reviewed
source libraries; the Activepieces server, database, workers, projects,
connections, and webhooks are not part of this runtime.

Pieces are not generally trusted. Only an exact, human-reviewed tuple of
capability ID/version, package/version/integrity, source commit/path, action,
classification, auth projection, adapters, provider destinations, byte limits,
timeouts, and resource policy can run. Invocation data cannot select any of
those values. Unknown capabilities and versions fail closed.

Step 5A does not enable HubSpot or any other customer connector. Triggers,
webhooks, OAuth product configuration, writes, retries, and a long-lived
production supervisor are outside this step. The existing Connector Runner
must not import pieces and must never receive Docker socket access.

## Data flow

```text
bounded request + in-memory credential
        |
        v
immutable reviewed manifest registry
        |
        +-- exact package/action/classification
        +-- static auth projection
        +-- static input/output adapters
        +-- exact TLS destinations
        +-- fixed byte/time/resource policy
        |
        v
fresh sandbox on an internal-only network
        |
        v
credential-blind TLS gateway
        |
        v
gateway DNS resolution -> validate every answer -> pin one numeric IP
```

The sandbox receives one invocation on stdin, performs one action attempt, and
returns only normalized bounded output or a bounded error code. Credentials are
never command arguments, labels, environment variables, filenames, mounts,
image layers, or logs. Mutable buffers are cleared in `finally`; unavoidable
JavaScript strings exist only inside the disposable process.

## Reviewed manifest

The first production registry entry is `hubspot.get_contact@1`:

- `@activepieces/piece-hubspot@0.8.10`
- npm integrity `sha512-P3svTd/XaaPhYfsOSz6YpgdfNcARRawqAddBGtJUxW/Grbc5InTdsvddlgSdyQtJxH+3UpxrKAR1VjlGJ4hfNA==`
- upstream package source commit `e7e44d4ef9a2a2bcec8cb611eb63af5df2ba019e`
- source `packages/pieces/community/hubspot`, MIT Expat
- action `get-contact`, classification `READ`
- auth projection `oauth2_access_token` -> `{ access_token: credential }`
- exact destination `api.hubapi.com:443` using TLS
- input adapter accepts `contactId` and at most 25 bounded property names
- output adapter returns only bounded contact fields

The runtime deliberately does not copy Activepieces' shared HubSpot OAuth scope
list. OAuth consent and connection configuration remain outside Step 5A.

## Network boundary

The sandbox joins only a per-invocation internal network. Only exact manifest
hostnames are installed as gateway aliases. The gateway receives capability
metadata from the trusted engine plan, never from the invocation body. It
parses a bounded TLS ClientHello, requires exact SNI and port 443, resolves the
manifest hostname itself, rejects the whole A/AAAA set if any address is unsafe,
then pins one numeric address. Raw IPv4/IPv6, loopback, RFC1918, CGNAT,
link-local, metadata, multicast, reserved/bogon, IPv6 ULA/link-local and mapped
unsafe addresses are rejected.

TLS passes through unchanged, keeping the gateway credential-blind. Redirects
to an unapproved host cannot resolve to a reachable peer from the internal-only
sandbox network. Handshake, connect, idle, lifetime, transfer, connection, PID,
memory, CPU, and descriptor limits fail closed.

## Container engine boundary

`PieceContainerEngine` exposes only `runInvocation` and `cleanupInvocation`.
The immutable plan contains validated generated resource names, reviewed image
identities, exact network aliases, and fixed resource controls. It contains no
credential value and accepts no request-controlled CLI flags. A host Docker
supervisor is intentionally not accepted or deployed by Step 5A.

The owner-run script `scripts/e50-step5a-host-acceptance.sh` builds the reviewed
images, checks a hardened one-shot fail-closed sandbox invocation and a
credential-blind gateway container, scans inspect/history/log/output surfaces,
and removes only Step 5A-labelled resources. Passing that preparation harness
does not by itself accept a long-lived production supervisor or provider call.

## Read/write and retry safety

The schema can describe `READ` and `WRITE`, but the runtime rejects every
`WRITE` manifest before action loading. It performs exactly one attempt and no
business retry. This avoids claiming generic write safety or exactly-once
provider behavior. Future writes require a separate reviewed design covering
provider idempotency and ambiguous outcomes.

## Error model

Only the bounded `PIECE_*` vocabulary in `src/errors.mjs` crosses the runtime
boundary. Provider bodies, SDK messages, stack traces, credentials, business
input, and raw output are never logged or returned on failure.

## Evidence limits

Deterministic unit/static tests cover manifest immutability, schema rejection,
genericity through a test-only second piece, auth/input/output adapters,
read-only enforcement, DNS/IP/SNI policy, fixed container plans, cleanup,
concurrency isolation, and canary absence. Actual container/kernel enforcement
is not claimed unless the owner-run Docker harness is executed on the intended
Linux host. Production Vercel, Connector Runner, Activepieces, Redis, Supabase,
and customer credentials are not touched.
