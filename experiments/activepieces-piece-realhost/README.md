# Essential 50 Step 4A.2 real-host harness

This directory prepares an owner-run Docker acceptance experiment for the
verified CrazyLoops Linux execution host. It is not production runtime code and
does not enable HubSpot in any registry, planner, UI, Vercel, Supabase,
Connector Runner, or Activepieces path.

Two modes are deliberately separate:

- **Real TLS probe:** an internal-only sandbox reaches `api.hubapi.com:443`
  through the credential-blind gateway. The gateway performs real A/AAAA
  resolution, rejects the entire answer set if any result is unsafe, pins a
  numeric address, and passes raw TLS. The sandbox performs only a verified TLS
  handshake; it sends no Authorization header, request body, or customer data.
- **Mock piece execution:** the pinned
  `@activepieces/piece-hubspot@0.8.10` `get-contact` action uses a fake
  credential against the controlled test-CA mock through the same gateway
  policy shape. Fake credentials never enter real-HubSpot mode.

The operator entry point is
`scripts/e50-step4a-host-acceptance.sh`. It verifies the reviewed branch/commit,
Docker Server 29+, protected service health, exact loopback bindings, Redis
PING, and a clean checkout before creating anything. All created resources use
the `cl-e50-canary-` prefix and `crazyloops.experiment=e50-step4a` label.
Cleanup runs on normal exit, failure, or signal and addresses only that label.

The script never reads `.env`, inspects protected-container environments,
changes host firewall/DNS, attaches to existing networks, publishes ports,
mounts host paths or the Docker socket, restarts services, or uses a real
provider credential. It writes a mode-0600 sanitized JSON report outside the
repository and prints its exact location only after canary scans return zero.

Target-host acceptance remains unproven until the owner runs the script and
returns the sanitized report.
