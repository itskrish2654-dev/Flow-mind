import { deepFreeze } from "./deep-freeze.mjs";
import { EGRESS_BROKER_CONTROL_VOLUME, EGRESS_BROKER_SOCKET_DIRECTORY } from "./egress-broker-constants.mjs";

export const SUPERVISOR_PROTOCOL_VERSION = 1;
export const SUPERVISOR_SOCKET_PATH = "/run/crazyloops-piece/piece-supervisor.sock";
export const SUPERVISOR_SOCKET_DIRECTORY = "/run/crazyloops-piece";
export const SUPERVISOR_SOCKET_DIRECTORY_MODE = 0o750;
export const SUPERVISOR_SOCKET_MODE = 0o660;
export const SUPERVISOR_DEFAULT_CONCURRENCY = 2;
export const SUPERVISOR_MAX_CONCURRENCY = 4;
export const SUPERVISOR_MAX_REQUEST_BYTES = 96 * 1024;
export const SUPERVISOR_MAX_RESPONSE_BYTES = 192 * 1024;
export const SUPERVISOR_MAX_CONTROL_CONNECTIONS = 8;
export const SUPERVISOR_HEADERS_TIMEOUT_MS = 5_000;
export const SUPERVISOR_BODY_TIMEOUT_MS = 10_000;
export const SUPERVISOR_KEEP_ALIVE_TIMEOUT_MS = 1;
export const SUPERVISOR_SHUTDOWN_GRACE_MS = 8_000;
export const SUPERVISOR_FORCE_CLOSE_MS = 2_000;
export const SUPERVISOR_OWNER_LABEL = deepFreeze({
  key: "crazyloops.runtime",
  value: "piece-runtime-supervisor-v1",
});
export const SUPERVISOR_INVOCATION_RESOURCE_LABEL = deepFreeze({
  key: "crazyloops.resource",
  value: "invocation",
});
export const SUPERVISOR_SERVICE_RESOURCE_LABEL = deepFreeze({
  key: "crazyloops.resource",
  value: "supervisor",
});

export const SUPERVISOR_RUNTIME_SPEC = deepFreeze({
  networkMode: "none",
  publishedPorts: [],
  privileged: false,
  readOnlyRoot: true,
  capDrop: ["ALL"],
  noNewPrivileges: true,
  pidsLimit: 32,
  memoryBytes: 256 * 1024 * 1024,
  memorySwapBytes: 256 * 1024 * 1024,
  cpus: 0.5,
  nofile: "128:128",
  user: "65532:65532",
  tmpfs: "/tmp:rw,noexec,nosuid,nodev,size=4m",
  mounts: [
    { source: "/var/run/docker.sock", target: "/var/run/docker.sock", readOnly: false },
    { source: "trusted_control_directory", target: SUPERVISOR_SOCKET_DIRECTORY, readOnly: false },
    { source: EGRESS_BROKER_CONTROL_VOLUME, target: EGRESS_BROKER_SOCKET_DIRECTORY, readOnly: false },
  ],
});
