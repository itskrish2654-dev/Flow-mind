# Essential 50 Step 3 threat model

This experiment is local-only and is not imported by CrazyLoops production
code. It uses a fake HubSpot credential and a controlled HTTPS provider. It
must never call real HubSpot.

## Trust boundaries

The TypeScript harness and the build-time provider manifest are trusted. The
piece process is untrusted. The TLS-pass-through gateway is trusted only to
enforce destination and resource policy; it is deliberately not a credential
authority and receives no provider or parent credentials.

The sandbox has one internal-only network interface. Its only intentional peer
is a reduced-privilege gateway addressed as `api.hubapi.com:443`. The gateway
is dual-homed onto a second internal-only test network containing one HTTPS
mock. Neither network has an external route. The mock occupies the synthetic
globally-routable address `93.184.216.34` inside that isolated namespace so the
gateway's public-address policy can be exercised without reaching the internet.

## Attacker model

Assume the piece attempts arbitrary public DNS/IP access, localhost and host
service access, RFC1918/link-local/metadata/IPv6-local access, IP-literal and
port bypasses, malformed or missing TLS SNI, redirect escape, DNS rebinding,
oversized transfers, idle/long-lived connections, socket exhaustion, and
arbitrary tunnelling. Application monkey-patching is not a control.

## Enforced policy

- The OCI network topology denies direct internet access independently of the
  piece. The sandbox joins only the internal network.
- The gateway accepts TLS ClientHello records only on port 443 and requires the
  exact SNI `api.hubapi.com`. It exposes no `connect(host, port)` API.
- The gateway derives the upstream from the immutable provider manifest,
  resolves it itself, validates every A/AAAA result with Node's native
  `net.BlockList` CIDR parser,
  and connects to one validated IP directly. It never reconnects by hostname.
- Loopback, unspecified, private, link-local, CGNAT, multicast, reserved/bogon,
  metadata, IPv6 ULA/link-local, and IPv4-mapped unsafe addresses are denied.
- TLS is passed through byte-for-byte. The sandbox verifies the mock's
  `api.hubapi.com` certificate using an ephemeral test CA trusted only in the
  disposable sandbox. The gateway cannot inspect HTTP or Authorization.
- Independent handshake, connect, idle, total-life, transfer-byte, concurrent
  connection, file-descriptor, PID, memory, and CPU limits fail closed.
- Redirects are opaque to the gateway, but a redirect to another hostname
  cannot resolve/reach a peer because the sandbox has no direct route and only
  the approved hostname maps to the gateway.

## DNS rebinding and test resolver

The production algorithm is resolve, validate every answer, select one answer,
and pin that numeric address for the connection. This local proof uses a
trusted synthetic resolver so private and rebind outcomes are deterministic.
In the rebind scenario the first connection pins the safe test address; a new
connection receives a private address and is denied. This proves the algorithm,
not production DNS resolver hardening, resolver provenance, or host firewall
configuration.

## Residual risk and deferred host work

The local WSL/rootless Podman kernel and default seccomp profile are not the
production Connector Runner host. Before a real provider canary, repeat the
controls on the intended Linux host; review the exact default seccomp profile,
host firewall/forwarding/DNS behavior, image provenance and patching, gateway
availability, per-tenant connection accounting, telemetry retention, and
operational cleanup. Multi-domain providers require additional exact manifest
entries; wildcards remain forbidden. OAuth and webhook ingress are separate
boundaries.
