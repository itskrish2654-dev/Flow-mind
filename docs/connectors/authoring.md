# Connector authoring

Phase 7A introduces one server-only connector registry in `lib/connectors/registry.ts`. A connector is usable only when its manifest and runtime adapter are registered together and registry validation succeeds.

## Add a connector

1. Define a stable lowercase connector ID and provider family.
2. Declare auth type, exact OAuth scopes, status, limitations, and version.
3. Add versioned trigger/action operations with typed input/output fields.
4. Add a runtime handler for every AVAILABLE, BETA, or INTERNAL operation.
5. Normalize provider payloads into `NormalizedConnectorEvent`; do not leak raw credentials or headers.
6. Add signature, replay, mapping, rate-limit, idempotency, refresh, owner-isolation, and error-classification tests.
7. Change status to AVAILABLE only after production acceptance. COMING_SOON connectors must not compile or appear connected.

Workflow snapshots store connector ID, operation key/version, connection ID, and mappings. They never store OAuth tokens, API keys, signing secrets, or refresh tokens.
