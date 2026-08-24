export const PROVIDER_MANIFEST = Object.freeze({
  capability: "hubspot.get_contact",
  piece: "@activepieces/piece-hubspot",
  pieceVersion: "0.8.10",
  action: "get-contact",
  destinations: Object.freeze([
    Object.freeze({
      hostname: "api.hubapi.com",
      port: 443,
      protocol: "tls"
    })
  ])
});

export const EGRESS_LIMITS = Object.freeze({
  clientHelloBytes: 16 * 1024,
  upstreamBytes: 128 * 1024,
  downstreamBytes: 128 * 1024,
  handshakeMs: 1_500,
  connectMs: 1_500,
  idleMs: 2_000,
  lifetimeMs: 5_000,
  simultaneousConnections: 2
});

export const EGRESS_OUTCOMES = Object.freeze([
  "EGRESS_DESTINATION_DENIED",
  "EGRESS_DNS_DENIED",
  "EGRESS_DNS_FAILED",
  "EGRESS_TLS_POLICY_DENIED",
  "EGRESS_CONNECTION_FAILED",
  "EGRESS_TIMEOUT",
  "EGRESS_TRANSFER_LIMIT",
  "EGRESS_PROTOCOL_INVALID",
  "EGRESS_SUCCEEDED"
]);
