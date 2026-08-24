# Controlled provider egress experiment

Essential 50 Step 3 extends the accepted Step 2 disposable piece sandbox with a
credential-blind TLS-pass-through boundary. It is local test code only.

The piece sandbox joins an internal-only network whose sole intentional peer is
the gateway. `api.hubapi.com` resolves there to the gateway. The gateway parses
only the bounded TLS ClientHello, requires exact SNI and the immutable manifest,
validates every synthetic resolver answer, pins one numeric address, and streams
opaque TLS to a controlled mock on a second internal-only network. The sandbox
trusts an ephemeral CA only inside its image; no host or system trust is changed.

The synthetic public address is deliberately routed only inside an isolated
Podman network. No real HubSpot API or credential is used. See `THREAT_MODEL.md`
for guarantees and deferred production-host work.

Run from the repository root with rootless Podman in WSL:

```text
npx tsx --test tests/essential-fifty-step-three.test.ts
npx tsx experiments/activepieces-piece-egress/benchmark.ts
```
