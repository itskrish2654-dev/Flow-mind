# Connector production checklist

- [ ] Manifest and operation versions reviewed
- [ ] Least-privilege scopes documented
- [ ] OAuth state, PKCE, user binding, reconnect, revoke, and refresh tested
- [ ] Webhook signature and replay windows tested against raw bytes
- [ ] Poll cursor and subscription renewal are idempotent
- [ ] Input/output schemas and mapping clarification tested
- [ ] Provider 401/403/429/5xx/timeout/ambiguous outcomes classified
- [ ] External idempotency key propagated where supported
- [ ] Owner isolation and service-role authorization negative tests pass
- [ ] Tokens absent from UI, logs, analytics, snapshots, and browser responses
- [ ] Rate, quota, payload, and retention limits accepted
- [ ] Production disposable end-to-end trigger/action run observed
- [ ] Disconnect, workflow archive, and account deletion cleanup observed

Until every item passes, keep the connector INTERNAL, BETA, or COMING_SOON and do not represent it as production-ready.
