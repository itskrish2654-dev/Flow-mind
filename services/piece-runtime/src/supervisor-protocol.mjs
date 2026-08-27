import { PieceRuntimeError } from "./errors.mjs";
import { decodeCredential, validateInvocationRequest } from "./protocol.mjs";
import { SUPERVISOR_PROTOCOL_VERSION } from "./supervisor-constants.mjs";
import { SupervisorError } from "./supervisor-errors.mjs";

const EXECUTE_KEYS = Object.freeze(["protocolVersion", "request", "credentialBase64"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
}

export function validateSupervisorEnvelope(value) {
  const envelope = record(value);
  if (!envelope || !exactKeys(envelope, EXECUTE_KEYS) || envelope.protocolVersion !== SUPERVISOR_PROTOCOL_VERSION) {
    throw new SupervisorError("SUPERVISOR_INVALID_REQUEST", 400);
  }
  let request;
  let credential;
  try {
    request = validateInvocationRequest(envelope.request);
    credential = decodeCredential(envelope.credentialBase64);
    envelope.credentialBase64 = "";
  } catch (error) {
    if (error instanceof PieceRuntimeError) throw error;
    throw new SupervisorError("SUPERVISOR_INVALID_REQUEST", 400);
  }
  return { request, credential };
}

export function supervisorResponse(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new SupervisorError("SUPERVISOR_UNAVAILABLE", 503);
  }
  return serialized;
}
