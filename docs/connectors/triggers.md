# Trigger lifecycle

Publishing creates subscriptions pinned to the immutable current workflow version. Unpublish, archive, disconnect, or account deletion revokes them.

The generic webhook gateway verifies its secret endpoint, applies limits, normalizes the event, inserts a unique durable receipt, acknowledges with HTTP 202, and dispatches after the response. Duplicate provider event keys reuse the durable idempotency boundary.

Polling adapters use a stored cursor and provider event keys. A cursor advances only with the accepted poll result. Renewal uses `(subscription ID, current expiry)` as the idempotency key. The Phase 7A internal connector proves this contract; no third-party polling connector is presented as available.
