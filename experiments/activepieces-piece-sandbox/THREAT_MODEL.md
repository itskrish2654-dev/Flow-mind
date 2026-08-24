# Essential 50 Step 2 threat model

This directory is a local, non-production proof. The Activepieces package is
untrusted execution code even though its source is open. It is never imported
by the CrazyLoops application or Connector Runner.

## Protected assets

- Connector Runner memory, environment, transport keys, and wrapping keys
- Supabase credentials and unrelated customer credentials
- host files, the repository, the developer home directory, and container socket
- unrestricted network access, private services, and cloud metadata endpoints
- availability of the parent process and developer machine
- data from earlier or concurrent workflow executions

## Assumed hostile behavior

A piece may read `process.env`, `/proc`, or arbitrary paths; load Node built-ins;
spawn children; allocate CPU, memory, output, or temporary storage; open arbitrary
connections; follow redirects; target loopback, RFC1918, link-local, or metadata
addresses; retain credentials; or leave background work running.

## Boundary

The trusted harness validates a fixed protocol and static manifest, signs one
bounded request, and starts a new rootless OCI container. The credential travels
only on the container's stdin. The container has no network interface beyond its
own isolated loopback, no mounts, a read-only root, a bounded tmpfs, a non-root
UID, no capabilities, no-new-privileges, and cgroup/PID/time/output limits. It
processes one request and is forcibly removed after success or failure.

The image contains exactly one pinned piece and one hardcoded read action. The
piece cannot select a package, action, version, retry policy, or destination.
Mock provider responses are process-local test plumbing. `--network=none` is the
actual network security boundary; Nock is not treated as a security control.

## Explicit limitations

Network-none proves denial, including redirect escape, but it cannot prove a
future real-provider domain allowlist. A real provider canary needs a dedicated
egress proxy or equivalent network-policy layer that is the sandbox's only route,
validates DNS results, permits reviewed HTTPS destinations, rejects redirects,
and caps transferred bytes. Rootless Podman under WSL2 proves Linux namespaces,
seccomp, and cgroup controls locally; it does not prove the final production host
kernel, image scanner, firewall, or orchestration configuration.
