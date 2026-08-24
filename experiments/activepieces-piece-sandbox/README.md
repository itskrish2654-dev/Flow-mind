# Activepieces disposable piece sandbox proof

This is the non-production Essential 50 Step 2 experiment. It is not imported
by CrazyLoops application code, the capability/connector registries, planner,
UI, deployment configuration, or Connector Runner.

## One-shot boundary

The trusted TypeScript harness generates an ephemeral Ed25519 key pair, builds
the public verification key into an experimental image, validates and signs one
bounded request, and sends it on stdin to a fresh rootless OCI container. The
private key and fake provider credential stay in parent memory. The credential
is not an environment variable, argument, image layer, mount, or file.

Each invocation uses:

- rootless Podman/crun and the default seccomp profile
- UID/GID `65532:65532`
- `--network=none`, read-only root, and a 4 MiB noexec/nosuid/nodev tmpfs
- no mounts, no container socket, no privileges, all capabilities dropped
- no-new-privileges, 16 PIDs, 128 MiB memory, 0.5 CPU, and 64 file descriptors
- parent timeout, 128 KiB response cap, `--log-driver=none`, and forced cleanup

The image can execute only `@activepieces/piece-hubspot@0.8.10` action
`get-contact`. Nock supplies a synthetic response in the same disposable
process. It is test plumbing, not an isolation control. Network denial is
enforced by the OCI network namespace.

## Network conclusion

Network-none proves that unapproved public targets, host loopback, RFC1918,
metadata, DNS, and redirect escape cannot leave the sandbox. It does not allow a
real HubSpot call and therefore does not prove a domain-aware production egress
policy. Before Step 3, CrazyLoops needs a dedicated egress proxy or equivalent
network-policy component as the sandbox's only route. That layer must pin DNS,
reject private/link-local resolutions and redirects, require reviewed HTTPS
destinations, and cap transferred bytes.

## Reproduce locally

Use a rootless Podman runtime with cgroup v2. From the repository root:

```text
node --test --import tsx tests/essential-fifty-step-two.test.ts
npx tsx experiments/activepieces-piece-sandbox/benchmark.ts
```

No real HubSpot credential or operation is permitted in this experiment.
