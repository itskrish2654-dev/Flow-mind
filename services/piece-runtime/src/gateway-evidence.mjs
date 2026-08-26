export function approvedDestinationForHostname(manifest, hostname) {
  if (typeof hostname !== "string") return null;
  return manifest.destinations.find(
    (candidate) => candidate.hostname === hostname && candidate.protocol === "tls" && candidate.port === 443,
  ) ?? null;
}

export function gatewayConnectionEvidence({
  requestId,
  capabilityId,
  approvedDestination,
  upstreamBytes,
  downstreamBytes,
  outcome,
}) {
  return {
    event: "piece_gateway_connection",
    requestId,
    capabilityId,
    hostname: approvedDestination?.hostname ?? null,
    port: approvedDestination?.port ?? 443,
    upstreamBytes,
    downstreamBytes,
    outcome,
  };
}
