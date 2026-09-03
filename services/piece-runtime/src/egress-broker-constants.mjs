import { deepFreeze } from "./deep-freeze.mjs";

export const EGRESS_BROKER_PROTOCOL_VERSION = 1;
export const EGRESS_BROKER_CONTAINER_NAME = "crazyloops-piece-egress-broker";
export const EGRESS_BROKER_IMAGE = "crazyloops/piece-egress-broker:step5b1";
export const EGRESS_BROKER_CONTROL_VOLUME = "crazyloops-piece-egress-control";
export const EGRESS_BROKER_SOCKET_DIRECTORY = "/run/crazyloops-egress-control";
export const EGRESS_BROKER_SOCKET_PATH = `${EGRESS_BROKER_SOCKET_DIRECTORY}/broker.sock`;
export const EGRESS_BROKER_SOCKET_MODE = 0o600;
export const EGRESS_BROKER_MAX_CONTROL_BYTES = 16 * 1024;
export const EGRESS_BROKER_MAX_CONTROL_CONNECTIONS = 8;
export const EGRESS_BROKER_MAX_DATA_CONNECTIONS = 32;
export const EGRESS_BROKER_CONTROL_TIMEOUT_MS = 2_000;
export const EGRESS_BROKER_MAX_POLICIES = 64;
export const EGRESS_BROKER_MAX_POLICY_TTL_MS = 15_000;
export const EGRESS_BROKER_POLICY_CLEANUP_MARGIN_MS = 1_000;
export const EGRESS_BROKER_LABELS = deepFreeze({
  "crazyloops.runtime": "piece-egress-broker-v1",
  "crazyloops.resource": "service",
});
export const EGRESS_BROKER_RUNTIME_SPEC = deepFreeze({
  user: "65532:65532",
  networkMode: "bridge",
  publishedPorts: [],
  privileged: false,
  readOnlyRoot: true,
  capDrop: ["ALL"],
  noNewPrivileges: true,
  pidsLimit: 32,
  memoryBytes: 128 * 1024 * 1024,
  memorySwapBytes: 128 * 1024 * 1024,
  cpus: 0.5,
  nofile: "256:256",
  dockerSocket: false,
  credentialAccess: false,
  mounts: [{ source: EGRESS_BROKER_CONTROL_VOLUME, target: EGRESS_BROKER_SOCKET_DIRECTORY, readOnly: false }],
});
