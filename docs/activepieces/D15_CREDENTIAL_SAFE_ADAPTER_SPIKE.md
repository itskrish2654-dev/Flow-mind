# D1.5 credential-safe Activepieces experiment

## SUPERSEDED / BLOCKED EXPERIMENT

This document is retained only as architecture and research history. D1.5 did
not produce production execution code, a customer capability, or a supported
credential path. Its executable capsule prototype, standalone canary, worker
template, dedicated tests, and environment configuration were removed after the
D1.6 real-host acceptance.

**NOT PRODUCTION EXECUTION CODE**

**FINAL CREDENTIAL PATH = CONNECTOR RUNNER**

## Finding retained from the experiment

Activepieces Community Edition `0.88.3` could not provide a supported,
provably secret-safe boundary for arbitrary credentialed piece execution. Piece
inputs pass through engine, worker, IPC, run-state, log, and error surfaces that
could not all be bounded and inspected through a stable public contract.
Reconstructing private piece-runner internals inside a code action would have
been unsupported and would not have resolved the persistence and replay risks.

Activepieces therefore remains available only through its accepted protocol-v1
executor for suitable delegated or credentialless work. It is not the
credential execution boundary.

## Final architecture

CrazyLoops routes an immutable, registry-approved capability to exactly one of:

1. the native executor;
2. the Activepieces protocol-v1 executor for suitable delegated work; or
3. the CrazyLoops-owned Connector Runner for credentialed delegated work.

D1 remains the credential source of truth: ownership, connection state,
provider, operation, scopes, and credential type are validated before the latest
narrow credential projection is read from the encrypted connection vault.

The Connector Runner authenticates and validates a bounded request, atomically
claims its Redis replay token, decrypts a short-lived AES-256-GCM capsule, runs
one statically allowlisted adapter, and then zeroes the plaintext buffer.

## Truthful acceptance status

| Surface | Status |
| --- | --- |
| D0.1 Activepieces bridge | PASS |
| D1 CrazyLoops-owned credential model | PASS |
| D1.5 Activepieces credential-safe piece invocation | BLOCKED / SUPERSEDED |
| D1.6 Connector Runner foundation | PASS |
| D1.6 real runner-host acceptance | PASS |
| Runner-host plaintext canary occurrences | `0` |
| Production Vercel-originated Connector Runner execution | NOT YET ACCEPTED |
| Real provider adapter | NOT YET IMPLEMENTED |

The accepted host canary used a generated fake credential. It proved the
loopback-only runner, HTTPS ingress, authentication rejection, Redis atomic
replay claim, encrypted execution, inspected runner-host persistence surfaces,
and zero plaintext canary occurrences. It did not change Vercel, Cloudflare,
Activepieces, or any real provider credential.

No Airtable, HubSpot, Shopify, or other real provider support is implied by this
historical experiment or by the internal Connector Runner canary.
