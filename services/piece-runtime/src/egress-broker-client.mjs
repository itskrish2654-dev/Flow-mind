import net from "node:net";
import { basename, dirname, isAbsolute, normalize } from "node:path/posix";

import {
  EGRESS_BROKER_CONTROL_TIMEOUT_MS,
  EGRESS_BROKER_MAX_CONTROL_BYTES,
  EGRESS_BROKER_PROTOCOL_VERSION,
  EGRESS_BROKER_SOCKET_DIRECTORY,
  EGRESS_BROKER_SOCKET_PATH,
} from "./egress-broker-constants.mjs";
import { PieceRuntimeError } from "./errors.mjs";

function failure() {
  return new PieceRuntimeError("PIECE_RUNTIME_FAILED");
}

function validateSocketPath(value) {
  if (
    typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value ||
    dirname(value) !== EGRESS_BROKER_SOCKET_DIRECTORY || basename(value) !== basename(EGRESS_BROKER_SOCKET_PATH)
  ) throw failure();
  return value;
}

function responseRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.ok !== true || value.protocolVersion !== 1) throw failure();
  return value;
}

export class EgressBrokerClient {
  constructor({ socketPath = EGRESS_BROKER_SOCKET_PATH, timeoutMs = EGRESS_BROKER_CONTROL_TIMEOUT_MS, request = null } = {}) {
    this.socketPath = validateSocketPath(socketPath);
    this.timeoutMs = timeoutMs;
    this.requestImplementation = request;
  }

  async request(message) {
    if (this.requestImplementation) return responseRecord(await this.requestImplementation(message));
    const payload = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (payload.length > EGRESS_BROKER_MAX_CONTROL_BYTES) {
      payload.fill(0);
      throw failure();
    }
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(this.socketPath);
        const chunks = [];
        let bytes = 0;
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          for (const chunk of chunks) chunk.fill(0);
          if (error) reject(error); else resolve(value);
        };
        const timer = setTimeout(() => finish(failure()), this.timeoutMs);
        socket.once("connect", () => socket.write(payload));
        socket.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > EGRESS_BROKER_MAX_CONTROL_BYTES) return finish(failure());
          chunks.push(Buffer.from(chunk));
        });
        socket.once("end", () => {
          try {
            const raw = Buffer.concat(chunks, bytes).toString("utf8");
            if (!raw.endsWith("\n") || raw.indexOf("\n") !== raw.length - 1) throw failure();
            finish(null, responseRecord(JSON.parse(raw.slice(0, -1))));
          } catch { finish(failure()); }
        });
        socket.once("error", () => finish(failure()));
      });
    } finally {
      payload.fill(0);
    }
  }

  health() {
    return this.request({ protocolVersion: EGRESS_BROKER_PROTOCOL_VERSION, operation: "health" });
  }

  register({ plan, request, brokerLocalAddress }) {
    return this.request({
      protocolVersion: EGRESS_BROKER_PROTOCOL_VERSION,
      operation: "register",
      invocationId: plan.invocationId,
      requestId: request.requestId,
      capabilityId: request.capabilityId,
      capabilityVersion: request.capabilityVersion,
      mode: request.mode,
      brokerLocalAddress,
    });
  }

  revoke({ plan, brokerLocalAddress }) {
    return this.request({
      protocolVersion: EGRESS_BROKER_PROTOCOL_VERSION,
      operation: "revoke",
      invocationId: plan.invocationId,
      brokerLocalAddress,
    });
  }
}
