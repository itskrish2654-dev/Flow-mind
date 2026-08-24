# Docker real-host threat model

The trusted host harness owns immutable capability, image, resolver, network,
and destination policy. Piece code and its inputs are untrusted. The rootful
Docker daemon is accepted only as host infrastructure for this experiment; no
container receives daemon access, privilege, host mounts, or ambient
capabilities.

The sandbox joins exactly one Docker `--internal` network. Only its gateway is
attached there under the approved DNS alias. The gateway is dual-homed to a
separate experimental network: an internal mock network for fake-piece mode or
a non-internal NAT network for the unauthenticated real TLS probe. Neither
experimental component joins `crazyloops-private` or
`activepieces_activepieces`.

The gateway accepts a bounded TLS ClientHello only, requires exact
`api.hubapi.com` SNI and port 443, resolves that immutable hostname itself,
rejects malformed/empty/mixed-unsafe answers, validates every address using
Node's native `net.BlockList`, and connects to one numeric address. TLS is not
terminated. The gateway cannot inspect HTTP or Authorization.

Fake secrets are generated only in parent memory. Only a fake HubSpot value is
sent over sandbox stdin. Parent sentinels are not forwarded. Container
arguments, environments, inspection metadata, logs, image history, temporary
files, and relevant Docker journal output are scanned by exact value and the
values are never printed.

Existing Runner, Activepieces, Redis, networks, ports, listener state and host
firewall state are snapshotted without reading environments. Any ID, restart,
status, port, listener-hash, or firewall-hash change fails acceptance. Cleanup
is label-scoped and must leave protected infrastructure unchanged.
