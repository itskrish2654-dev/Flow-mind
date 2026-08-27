# CrazyLoops Piece Runtime Supervisor v1

## Status

This document describes the Essential 50 Step 5B.1 production-candidate
infrastructure. It is intentionally disconnected from the CrazyLoops web
application, capability registry, connector registry, planner, compiler, OAuth,
and the existing Connector Runner. It is not deployed and does not enable
HubSpot or any generic piece for customers.

Step 5B.1 remains READ-only and TEST-only. The sole reviewed operation is
`hubspot.get_contact@1`. There are no writes, triggers, retries, customer OAuth
credentials, or product-facing APIs.

## Architecture and trust boundary

```text
future trusted caller
        |
        | HTTP v1 over one private Unix-domain socket
        v
Piece Runtime Supervisor (no network)
        |
        | direct Docker Engine API over /var/run/docker.sock
        v
fresh internal network + fresh egress network
        |                         |
        v                         v
fresh sandbox  -- raw TLS --> fresh credential-blind gateway --> provider
```

CrazyLoops remains the system of record. The supervisor accepts only `HEALTH`
and `EXECUTE`. It validates the existing Step 5A invocation schema, resolves the
static reviewed manifest and build registries, and consumes the immutable
`buildInvocationPlan()`. Callers cannot select images, packages, actions,
commands, entrypoints, mounts, networks, provider destinations, resource limits,
or Docker labels.

Mounting `/var/run/docker.sock` gives the supervisor host-equivalent Docker
authority. The supervisor is therefore privileged infrastructure even though
the container itself runs with dropped Linux capabilities and no network. It is
the only CrazyLoops component permitted to receive the Docker socket. The web
application, Connector Runner, sandbox, gateway, Activepieces, and Redis do not
receive it.

The implementation uses a narrow direct Docker Engine HTTP client over the Unix
socket. No Docker client dependency or transitive package tree was introduced.
The client is not exposed as a generic proxy and implements only the operations
needed to create, start, inspect, attach, stop, and remove reviewed invocation
resources.

## Supervisor container

The production-candidate image is built by
`services/piece-runtime/Dockerfile.supervisor` from the same digest-pinned Node
24.8.0 Debian slim base as Step 5A. It copies only required runtime modules and
runs as `65532:65532` where the host Docker socket group permits it.

The owner runtime specification requires:

- network mode `none`; no TCP listener, host networking, exposed port, or
  published port;
- read-only root, cap-drop `ALL`, no-new-privileges, non-privileged mode;
- 32 PIDs, 256 MiB memory/swap ceiling, 0.5 CPU, and 128 file descriptors;
- a 4 MiB `noexec,nosuid,nodev` tmpfs at `/tmp`;
- only `/var/run/docker.sock` and the narrow control directory mounted;
- no repository, home, secret, customer credential, or unrelated host mount.

Image tags remain pinned to reviewed static registry values. Digest-pinning the
locally built sandbox/gateway image IDs in a future deployment manifest remains
hardening work for Step 5B.2; request input can never choose or pull an image.

## Unix control socket

The only listener is HTTP over
`/run/crazyloops-piece/piece-supervisor.sock`. The parent directory is mode
`0750` and the socket is mode `0660`. The path must be absolute, normalized,
have the exact reviewed parent and basename, and cannot traverse elsewhere.
There is no TCP fallback.

An existing responsive socket causes startup to fail. An unresponsive object is
removed only when it is an actual stale Unix socket. The supervisor first owns
the socket, then performs narrow orphan recovery, and only then reports ready.
This socket-ownership sequence prevents a second active supervisor from running
or performing cleanup concurrently. Graceful shutdown stops acceptance, aborts
active work, allows a bounded cleanup window, force-closes remaining control
connections after a second bounded grace period, and unlinks the owned socket in
`finally`. A cleanup that still cannot be verified is reported only as the
bounded unavailable failure; process termination remains possible so the next
startup can apply exact-label orphan recovery.

The future Connector Runner-to-supervisor relationship will use a group-readable
bind mount for this UDS. Step 5B.1 does not modify or mount it into the Runner.

## Protocol and errors

`GET /v1/health` returns only protocol version, readiness, active invocation
count, and concurrency limit. `POST /v1/execute` accepts protocol version 1,
the existing validated Piece request, and one bounded Base64 credential. Request
and response sizes are bounded. Buffered body chunks are zeroed on success,
overflow, malformed JSON, abort, and request error. Headers, body lifetime,
connections, requests per socket, and keep-alive are constrained by trusted
startup constants. Unknown routes, malformed JSON, unsupported versions, extra
metadata, and content-type mismatches fail closed.

Supervisor-level output is limited to:

- `SUPERVISOR_INVALID_REQUEST`
- `SUPERVISOR_BUSY`
- `SUPERVISOR_DUPLICATE`
- `SUPERVISOR_UNAVAILABLE`

Piece/runtime failures must be exact members of the reviewed `PIECE_ERROR_CODES`
vocabulary. Successful worker metadata must have the exact reviewed keys and
match capability, version, provider, piece, action, READ classification, and one
attempt. Unknown error strings, spoofed metadata, extra metadata, array output,
and any malformed result become `PIECE_RESPONSE_INVALID`. Docker daemon
messages, image errors, provider bodies, SDK text, stack traces, worker stderr,
raw requests, and environment values never cross the control response or
structured metadata logs.

## Credential path

The control body is bounded before JSON parsing. Base64 is canonicalized and
decoded into a mutable Buffer with the existing 16 KiB ceiling. The request
cannot place credentials in environment variables, arguments, labels, mounts,
filenames, images, or Docker configuration. The supervisor creates one bounded
worker envelope in memory, sends it once over sandbox stdin, closes stdin, and
clears mutable buffers in `finally`. Sandbox stderr is drained and discarded;
stdout is multiplex-decoded with an explicit ceiling and must contain exactly
one normalized result.

Unavoidable JavaScript string lifetime is transient and is never persisted or
logged. The gateway remains credential-blind because it forwards raw TLS only.

## Invocation topology and lifecycle

Every accepted invocation receives unique sandbox/gateway container names and
unique internal/egress networks derived from the validated request ID. The
internal network is Docker `Internal=true`. The gateway starts on egress and is
then attached to internal using only its generated gateway alias. It never
receives `api.hubapi.com` as an alias or host override.

The supervisor inspects the gateway after attachment and discovers its actual
address in that invocation's internal network. The sandbox joins only the
internal network and receives the exact reviewed provider hostname mapped to
that discovered address. There is no global hardcoded gateway address. The
gateway independently resolves real provider DNS, rejects the complete answer
set if any address is unsafe, pins one validated numeric address, and enforces
canonical SNI.

Lifecycle order is internal network, egress network, gateway create/attach,
dynamic address discovery, sandbox create, gateway readiness, sandbox attach,
one stdin write, one action attempt, bounded result, and finally sandbox,
gateway, internal network, egress network removal. Timeout, disconnect, crash,
malformed output, Docker failure, provider failure, shutdown, and internal
exception all enter the same idempotent cleanup boundary. Absence is verified
before an invocation slot is released. If cleanup or the absence check fails,
the engine retains its resource record, the service retains the active slot,
health becomes unavailable, and all new execution requests fail before Docker
work. Shutdown retries retained cleanup state; only a verified retry releases
the slot and resource record. Startup orphan cleanup is the final exact-label
recovery path after an unrecoverable process shutdown.

## Concurrency, duplicates, and orphan recovery

The default concurrency limit is two and trusted startup configuration may set
only a bounded value from one through four. There is no queue. A third active
request returns `SUPERVISOR_BUSY` before Docker resources exist. The supervisor
tracks the bounded invocation hash and rejects the same active invocation with
`SUPERVISOR_DUPLICATE`.

Invocation resources carry both:

- `crazyloops.runtime=piece-runtime-supervisor-v1`
- `crazyloops.resource=invocation`

and a bounded invocation label. Startup orphan recovery filters by the exact
owner label and removes only resources that also carry the exact invocation
resource label, containers before networks. It never removes by broad name
prefix, never deletes images, never touches Step 5A acceptance resources, and
never touches Connector Runner, Activepieces, Redis, or unrelated Docker
workloads.

## Acceptance and remaining work

Deterministic repository tests use a fake Docker client to prove immutable
configuration, dynamic address use, topology separation, bounded protocol,
credential zeroing, cleanup failures, concurrency, duplicate rejection, orphan
scope, UDS-only transport, and product disconnection. They do not claim kernel
or Docker enforcement.

`scripts/e50-step5b1-supervisor-host-acceptance.sh` is owner-run only on the
accepted Linux Docker host. It is commit/branch/base gated, snapshots protected
services, builds reviewed images, inspects the hardened supervisor, calls health
and execute over UDS, proves exact socket/directory modes and cgroup/runtime
limits, captures both real invocation networks and the gateway's credential-free
DNS/connection evidence, requires real-provider `PIECE_AUTH_FAILED` for its fake
token, exercises the bounded negative matrix, scans plaintext and Base64 canary
forms across runtime/persistence surfaces, proves Docker-socket isolation and
narrow orphan cleanup, verifies bounded graceful shutdown and zero owned
resources, and confirms Connector Runner HTTP 401 plus Redis PONG. Codex must
not execute it. Duplicate and concurrency saturation remain deterministic
repository proofs in Step 5B.1; the owner harness deliberately emits no host
PASS marker for them because staging the race without a production test hook is
not deterministic enough for acceptance.

Step 5B.2 must still design and review the Connector Runner-to-UDS integration,
production service ownership/group setup, deployment/rollback, stronger image
identity pinning, production monitoring, real host restart/shutdown behavior,
and customer credential/OAuth enablement. None of those are accepted here.
