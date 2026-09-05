import http from "node:http";
import { isAbsolute, normalize } from "node:path/posix";

export const PIECE_SUPERVISOR_SOCKET_PATH = "/run/crazyloops-piece/piece-supervisor.sock";
export const PIECE_SUPERVISOR_EXECUTE_PATH = "/v1/execute";
export const PIECE_SUPERVISOR_MAX_REQUEST_BYTES = 96 * 1024;
export const PIECE_SUPERVISOR_MAX_RESPONSE_BYTES = 192 * 1024;

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const PIECE_ERROR_CODES = new Set([
  "PIECE_UNSUPPORTED_CAPABILITY",
  "PIECE_INVALID_CREDENTIAL",
  "PIECE_AUTH_FAILED",
  "PIECE_RATE_LIMITED",
  "PIECE_PROVIDER_UNAVAILABLE",
  "PIECE_TIMEOUT",
  "PIECE_EGRESS_DENIED",
  "PIECE_RESPONSE_INVALID",
  "PIECE_RUNTIME_FAILED",
  "PIECE_INVALID_INPUT",
  "PIECE_ACTION_NOT_ALLOWED",
  "PIECE_OUTPUT_LIMIT",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
}

export function validatePieceSupervisorSocketPath(value) {
  if (
    value !== PIECE_SUPERVISOR_SOCKET_PATH ||
    !isAbsolute(value) ||
    normalize(value) !== value
  ) {
    throw new PieceSupervisorClientError("invalid_configuration");
  }
  return value;
}

export class PieceSupervisorClientError extends Error {
  constructor(kind, pieceErrorCode = null) {
    super("Piece supervisor request failed.");
    this.name = "PieceSupervisorClientError";
    this.kind = kind;
    this.pieceErrorCode = pieceErrorCode;
  }
}

function boundedTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) {
    throw new PieceSupervisorClientError("invalid_configuration");
  }
  return value;
}

function validateSuccess(value, request) {
  if (
    !exactKeys(value, ["protocolVersion", "requestId", "ok", "acknowledged", "output", "meta"]) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    value.requestId !== request.requestId ||
    value.ok !== true ||
    value.acknowledged !== true ||
    !isRecord(value.output) ||
    !isRecord(value.meta) ||
    value.meta.capabilityId !== request.capabilityId ||
    value.meta.capabilityVersion !== request.capabilityVersion ||
    value.meta.classification !== "READ" ||
    value.meta.attempts !== 1
  ) {
    throw new PieceSupervisorClientError("invalid_response");
  }
  return value;
}

function validateFailure(value, request) {
  const withRetryable = exactKeys(value, ["protocolVersion", "requestId", "ok", "errorCode", "retryable"]);
  const supervisorFailure = exactKeys(value, ["protocolVersion", "ok", "errorCode"]);
  if (
    (!withRetryable && !supervisorFailure) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    value.ok !== false ||
    typeof value.errorCode !== "string" ||
    (withRetryable && (value.requestId !== request.requestId || typeof value.retryable !== "boolean"))
  ) {
    throw new PieceSupervisorClientError("invalid_response");
  }
  if (!PIECE_ERROR_CODES.has(value.errorCode)) {
    throw new PieceSupervisorClientError("supervisor_failure");
  }
  throw new PieceSupervisorClientError("piece_failure", value.errorCode);
}

function validateResponse(value, request) {
  if (!isRecord(value)) throw new PieceSupervisorClientError("invalid_response");
  return value.ok === true ? validateSuccess(value, request) : validateFailure(value, request);
}

function parseResponse(buffer, request) {
  try {
    return validateResponse(JSON.parse(buffer.toString("utf8")), request);
  } catch (error) {
    if (error instanceof PieceSupervisorClientError) throw error;
    throw new PieceSupervisorClientError("invalid_response");
  }
}

/**
 * @param {{requestImplementation?: Function, socketPath?: string, timeoutMs?: number}} options
 */
export function createPieceSupervisorClient({
  requestImplementation = http.request,
  socketPath = PIECE_SUPERVISOR_SOCKET_PATH,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const reviewedSocketPath = validatePieceSupervisorSocketPath(socketPath);
  const reviewedTimeoutMs = boundedTimeout(timeoutMs);
  if (typeof requestImplementation !== "function") {
    throw new PieceSupervisorClientError("invalid_configuration");
  }

  return Object.freeze({
    async execute({ request, credential, signal }) {
      if (!Buffer.isBuffer(credential) || credential.length < 1) {
        throw new PieceSupervisorClientError("invalid_configuration");
      }
      if (signal?.aborted) throw new PieceSupervisorClientError("aborted");

      let credentialBase64 = credential.toString("base64");
      let body = null;
      try {
        body = Buffer.from(JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          request,
          credentialBase64,
        }), "utf8");
        credentialBase64 = "";
        if (body.length > PIECE_SUPERVISOR_MAX_REQUEST_BYTES) {
          throw new PieceSupervisorClientError("request_too_large");
        }

        return await new Promise((resolve, reject) => {
          let settled = false;
          let clientRequest;
          let response = null;
          const chunks = [];
          let responseBytes = 0;
          const zeroChunks = () => {
            for (const chunk of chunks) chunk.fill(0);
            chunks.length = 0;
          };
          const cleanup = () => {
            signal?.removeEventListener("abort", onAbort);
            response?.removeAllListeners("data");
            response?.removeAllListeners("end");
            response?.removeAllListeners("aborted");
            response?.removeAllListeners("error");
            zeroChunks();
          };
          const finish = (error, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error); else resolve(value);
          };
          const onAbort = () => {
            clientRequest?.destroy();
            finish(new PieceSupervisorClientError("aborted"));
          };

          try {
            clientRequest = requestImplementation({
              socketPath: reviewedSocketPath,
              path: PIECE_SUPERVISOR_EXECUTE_PATH,
              method: "POST",
              agent: false,
              headers: {
                "Content-Type": "application/json",
                "Content-Length": body.length,
                "Connection": "close",
              },
            }, (incoming) => {
              response = incoming;
              incoming.on("data", (chunk) => {
                const copy = Buffer.from(chunk);
                if (settled) {
                  copy.fill(0);
                  return;
                }
                responseBytes += copy.length;
                if (responseBytes > PIECE_SUPERVISOR_MAX_RESPONSE_BYTES) {
                  copy.fill(0);
                  incoming.destroy?.();
                  clientRequest.destroy();
                  finish(new PieceSupervisorClientError("response_too_large"));
                  return;
                }
                chunks.push(copy);
              });
              incoming.once("end", () => {
                if (settled) return;
                const raw = Buffer.concat(chunks, responseBytes);
                try {
                  if (!Number.isSafeInteger(incoming.statusCode) || incoming.statusCode < 200 || incoming.statusCode > 599) {
                    throw new PieceSupervisorClientError("invalid_response");
                  }
                  finish(null, parseResponse(raw, request));
                } catch (error) {
                  finish(error instanceof PieceSupervisorClientError ? error : new PieceSupervisorClientError("invalid_response"));
                } finally {
                  raw.fill(0);
                }
              });
              incoming.once("aborted", () => finish(new PieceSupervisorClientError("disconnected")));
              incoming.once("error", () => finish(new PieceSupervisorClientError("disconnected")));
            });
            clientRequest.once("error", () => finish(new PieceSupervisorClientError("unavailable")));
            clientRequest.setTimeout(reviewedTimeoutMs, () => {
              clientRequest.destroy();
              finish(new PieceSupervisorClientError("timeout"));
            });
            signal?.addEventListener("abort", onAbort, { once: true });
            clientRequest.end(body);
          } catch {
            clientRequest?.destroy();
            finish(new PieceSupervisorClientError("unavailable"));
          }
        });
      } finally {
        credentialBase64 = "";
        body?.fill(0);
      }
    },
  });
}
