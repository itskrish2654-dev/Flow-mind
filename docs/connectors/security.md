# Connector security model

- OAuth uses authorization-code flow with PKCE, 256-bit state, ten-minute expiry, single consumption, safe local return paths, and callback binding to the currently authenticated initiating user.
- Provider credentials are AES-256-GCM encrypted with authenticated context containing user, connection, connector, and credential key. Browser APIs expose metadata only.
- Service-role reads and mutations always bind both resource ID and authenticated owner ID. Disconnect deletes tokens before revoking the connection and its subscriptions.
- Token refresh uses a database lease, preventing refresh storms. Revoked refresh credentials place the connection in `expired` and require reconnect.
- Incoming endpoints use a server-HMAC secret, bounded JSON, trusted client-IP rate limits, owner quota, subscription lookup, provider verification, and database uniqueness for replay protection.
- Outbound HTTP uses DNS pinning, HTTPS only, no redirects, reserved/private network denial, request/response bounds, timeouts, and acknowledgement-only delivery status.
- Raw connector payloads have 30-day receipt retention. Safe metadata must exclude authorization headers, tokens, secrets, and sensitive payload values.
