# D1.7 Vercel-origin Connector Runner canary

## Status and scope

This is temporary operator-only acceptance infrastructure. It proves the
production Vercel runtime can invoke the accepted Connector Runner through:

```text
POST /api/operations/connector-runner-canary
  -> ConnectorRunnerExecutor
  -> https://runner.crazy-loops.com/v1/execute
  -> Redis replay claim
  -> internal canary adapter
```

The harness does not add a product capability, provider adapter, form action,
planner option, workflow step, or public UI. Automated and local tests do not
constitute Vercel-origin acceptance.

## Production configuration

Configure these server-only values in Vercel Production without printing or
copying them into browser-visible variables:

```text
DELEGATED_EXECUTION_ENABLED=true
CONNECTOR_RUNNER_EXECUTION_ENABLED=true
CONNECTOR_RUNNER_URL=https://runner.crazy-loops.com/v1/execute
CONNECTOR_RUNNER_SECRET=<existing dedicated runner transport secret>
CONNECTOR_RUNNER_WRAP_KEY_ACTIVE_VERSION=<accepted active version>
CONNECTOR_RUNNER_WRAP_KEY_V1=<accepted wrapping key for version 1>
D17_CONNECTOR_RUNNER_CANARY_ENABLED=true
CONNECTOR_RUNNER_CANARY_SECRET=<new independent operator secret>
```

The operator secret must be independently generated and must not equal any
cron, schedule, runner transport, Activepieces bridge, credential-master, or
OAuth secret. Never use a `NEXT_PUBLIC_` prefix. Do not change the stable
runner, Redis, Activepieces, or Cloudflare configuration for this test.

## One-request procedure

Load the operator secret into a history-disabled trusted shell without echoing
it, then invoke exactly once:

```bash
set +o history
curl --fail-with-body --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${CANARY_OPERATOR_SECRET}" \
  --header "Content-Type: application/json" \
  --data '{}' \
  https://www.crazy-loops.com/api/operations/connector-runner-canary
unset CANARY_OPERATOR_SECRET
set -o history
```

The successful response contains only `ok`, `requestId`, `executionId`, and
`proofVerified`. Save these safe identifiers for correlation. Do not repeat the
request unless the first attempt has a conclusively failed pre-execution check.

## Persistence acceptance

Using the safe request and execution IDs, export the Vercel runtime logs and
CrazyLoops operational telemetry created by that invocation. Inspect the runner
Docker logs, Redis replay keys and values, ingress metadata, and any approved
host request capture. Search every captured text surface for:

```text
CRAZYLOOPS_D17_CANARY_
```

The acceptance record must state exactly:

```text
VERCEL_PLAINTEXT_CANARY_OCCURRENCES=0
RUNNER_PLAINTEXT_CANARY_OCCURRENCES=0
```

Encrypted capsule bytes and the non-secret proof may exist. The plaintext fake
credential prefix may not exist in logs, telemetry, responses, Redis, request
capture, or runner persistence surfaces.

After evidence is preserved, set
`D17_CONNECTOR_RUNNER_CANARY_ENABLED=false` or remove it and remove
`CONNECTOR_RUNNER_CANARY_SECRET`. Restore the general execution flags to their
approved operational values. Retain no plaintext secret in shell history or
acceptance notes.

Do not mark production Vercel-origin acceptance complete until a real request
handled by the Production Vercel deployment satisfies both zero-occurrence
checks.
