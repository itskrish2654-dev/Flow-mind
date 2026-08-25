import { PieceRuntimeError } from "./errors.mjs";

export const PIECE_RUNTIME_PROTOCOL_VERSION = 1;
export const PIECE_RUNTIME_MAX_ENVELOPE_BYTES = 64 * 1024;
export const PIECE_RUNTIME_MAX_CREDENTIAL_BYTES = 16 * 1024;

const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const REQUEST_KEYS = Object.freeze([
  "protocolVersion",
  "requestId",
  "executionId",
  "capabilityId",
  "capabilityVersion",
  "mode",
  "idempotencyKey",
  "input",
]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
}

export function validateInvocationRequest(value) {
  const request = record(value);
  if (
    !request ||
    !exactKeys(request, REQUEST_KEYS) ||
    request.protocolVersion !== PIECE_RUNTIME_PROTOCOL_VERSION ||
    !IDENTITY.test(request.requestId) ||
    !IDENTITY.test(request.executionId) ||
    !IDENTITY.test(request.capabilityId) ||
    !Number.isSafeInteger(request.capabilityVersion) ||
    request.capabilityVersion < 1 ||
    !new Set(["TEST", "LIVE"]).has(request.mode) ||
    !IDENTITY.test(request.idempotencyKey) ||
    !record(request.input)
  ) {
    throw new PieceRuntimeError("PIECE_INVALID_INPUT");
  }
  let serialized;
  try {
    serialized = JSON.stringify(request);
  } catch {
    throw new PieceRuntimeError("PIECE_INVALID_INPUT");
  }
  if (Buffer.byteLength(serialized, "utf8") > PIECE_RUNTIME_MAX_ENVELOPE_BYTES) {
    throw new PieceRuntimeError("PIECE_INVALID_INPUT");
  }
  return request;
}

export function decodeCredential(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new PieceRuntimeError("PIECE_INVALID_CREDENTIAL");
  }
  const credential = Buffer.from(value, "base64");
  if (
    credential.length < 1 ||
    credential.length > PIECE_RUNTIME_MAX_CREDENTIAL_BYTES ||
    credential.toString("base64") !== value ||
    credential.includes(0)
  ) {
    credential.fill(0);
    throw new PieceRuntimeError("PIECE_INVALID_CREDENTIAL");
  }
  return credential;
}
