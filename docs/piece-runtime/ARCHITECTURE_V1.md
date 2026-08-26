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
        +-- trusted build ID -> exact package/version/integrity/image
        +-- static action resolver/classification
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

The manifest's `buildId` is resolved by a separate static reviewed build
registry. That registry binds the build ID to the exact package name, package
version, npm integrity, reviewed upstream commit, sandbox image, action ID,
classification, and a literal-import resolver. The runtime never constructs an
import path from invocation data. A future reviewed piece/action is added by
reviewing and registering new static build metadata; the request cannot provide
or override a build ID, package, version, action, image, or resolver.

The synthetic second piece exists only in the Step 5A test fixture. It uses the
same manifest registry, build registry, loader, runtime, and image-selection
abstractions as HubSpot, but it is not present in the production-candidate
registry or any customer/product registry.

The runtime deliberately does not copy Activepieces' shared HubSpot OAuth scope
list. OAuth consent and connection configuration remain outside Step 5A.

## Network boundary

The sandbox joins only a per-invocation internal network. The gateway receives
only a generated internal alias such as `cl-piece-gateway-<invocation>`; it
never receives a provider hostname as a Docker alias or `/etc/hosts` override.
Inside the sandbox namespace only, each exact reviewed provider hostname maps
to the gateway's internal IP. The sandbox therefore connects to the gateway
while still using the canonical provider hostname for TLS SNI and certificate
verification. Inside the gateway namespace, that same canonical hostname is
resolved through real DNS to the provider's public A/AAAA records. This
separation prevents the gateway from resolving the provider hostname back to
itself.

The gateway receives capability metadata from the trusted engine plan, never
from the invocation body. It parses a bounded TLS ClientHello, requires exact
canonical SNI and port 443, resolves the manifest hostname itself, rejects the
whole A/AAAA set if any address is unsafe (including the gateway/private IP),
then pins one numeric public address. Raw IPv4/IPv6, loopback, RFC1918, CGNAT,
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

The owner-run script `scripts/e50-step5a-host-acceptance.sh` is deliberately
gated to the reviewed branch/commit, accepted base, unchanged `origin/main`, and
a clean source tree. On the intended Linux Docker host it builds the pinned
images with `npm ci`, verifies installed HubSpot package/build metadata, proves
sandbox and gateway controls through Docker inspect plus `/proc`/cgroup
evidence, and runs a credential-free TLS-only topology check to real
`api.hubapi.com:443`. That check sends no HTTP request, authentication, or
customer data.

The harness also exercises container/kernel negative cases for schema and
metadata overrides, size ceilings, classification, filesystem, PID, direct
network, SNI/port, unsafe DNS, timeout, crash/OOM/CPU, concurrent fresh
containers, and credential/temp crossover. Synthetic high-entropy credentials
enter workers only over stdin. Their plaintext is scanned across sanitized
outputs, Docker inspect/history, gateway logs, process arguments, and temporary
evidence. Success and failure traps remove only Step 5A-labelled containers,
networks, and images and verify zero remain. Before and after snapshots prove
the existing Connector Runner, Activepieces containers, and Redis were not
changed; the Runner must still reject an unsigned JSON request with HTTP 401
and Redis must still return `PONG`.

This host acceptance is not claimed by repository tests. It remains an owner
run on the accepted CrazyLoops production-candidate host. Passing it does not
deploy or product-enable this runtime, does not make a provider API call, and
does not accept a long-lived production supervisor.

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

Deterministic unit/static tests cover manifest/build immutability and binding,
schema rejection, genericity through a test-only second build using the real
loader abstraction, auth/input/output adapters, read-only enforcement,
DNS/IP/SNI namespace policy, fixed image/container plans, cleanup, concurrency
isolation, and canary absence. Actual container/kernel enforcement is not
claimed unless the owner-run Docker harness is executed on the intended Linux
host. Production Vercel, Connector Runner, Activepieces, Redis, Supabase, and
customer credentials are not touched by repository validation.
