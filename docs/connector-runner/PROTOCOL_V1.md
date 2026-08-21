# Connector Runner protocol v1

This contract is independent from the Activepieces bridge protocol v1. Existing
Activepieces envelopes and `internal.bridge_echo` are unchanged.

## Transport

The only endpoint is `POST /v1/execute`. CrazyLoops sends:

```text
X-CrazyLoops-Timestamp: <13-digit epoch milliseconds>
X-CrazyLoops-Request-Id: <bounded opaque ID>
X-CrazyLoops-Content-SHA256: sha256(raw UTF-8 JSON body)
X-CrazyLoops-Signature: v1=hmac_sha256(
  CONNECTOR_RUNNER_SECRET,
  timestamp + "." + requestId + "." + bodyDigest
)
```

The runner accepts at most 128 KiB, rejects timestamps outside 60 seconds, uses
constant-time digest/signature comparison, and never follows redirects. Responses
are at most 64 KiB.

## Request

```json
{
  "protocolVersion": 1,
  "requestId": "…",
  "executionId": "…",
  "workflowVersionId": "…",
  "stepId": "…",
  "capabilityId": "internal.connector_runner_canary",
  "capabilityVersion": 1,
  "mode": "TEST",
  "idempotencyKey": "…",
  "input": { "simulation": "success" },
  "credentialCapsule": {
    "keyVersion": 1,
    "algorithm": "aes-256-gcm",
    "nonce": "…",
    "ciphertext": "…",
    "authTag": "…",
    "expiresAt": 0
  }
}
```

Unknown or extra top-level and capsule fields are rejected. The request contains
neither a user session nor a connection/vault identifier. The capsule's AAD binds
all execution identifiers, capability/version, key version, algorithm, and expiry.
The runner's security order is fixed: authenticate transport, validate the
bounded envelope and capsule lifetime, atomically claim the Redis replay token,
decrypt the capsule, then execute one allowlisted adapter. A replay or Redis
failure is rejected before credential plaintext exists in runner memory.

## Response

Success requires an explicit acknowledgement:

```json
{
  "protocolVersion": 1,
  "requestId": "…",
  "ok": true,
  "acknowledged": true,
  "output": { "proof": "…" }
}
```

Failure is normalized and contains no provider error or credential material:

```json
{
  "protocolVersion": 1,
  "requestId": "…",
  "ok": false,
  "errorCategory": "DELEGATED_REPLAYED",
  "retryable": false
}
```

CrazyLoops validates the matching protocol and request ID. It owns every business
retry. The runner performs one adapter attempt, with no generic or ambiguous-write
retry.

## Adapter interface

Adapters are statically registered and receive only:

```text
execute({ capabilityId, input, credential, idempotencyKey, signal })
```

There is no dynamic import, eval, arbitrary code, or generic destination URL. D1.6
registers only `internal.connector_runner_canary@1`, which returns an HMAC proof.
