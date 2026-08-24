import { createPublicKey, verify } from "node:crypto";

import {
  SANDBOX_ACTION_ID,
  SANDBOX_CAPABILITY_ID,
  SANDBOX_CAPABILITY_VERSION,
  SANDBOX_MAX_REQUEST_BYTES,
  SANDBOX_PIECE_ID,
  SANDBOX_PIECE_VERSION,
  SANDBOX_PROBE_MODES,
  SANDBOX_PROTOCOL_VERSION
} from "./manifest.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function unsignedEnvelope(envelope) {
  const unsigned = { ...envelope };
  delete unsigned.signature;
  return unsigned;
}

export function verifyEnvelopeSignature(envelope, publicKeyDer) {
  if (typeof envelope.signature !== "string" || envelope.signature.length > 256) return false;
  try {
    return verify(
      null,
      Buffer.from(canonicalJson(unsignedEnvelope(envelope)), "utf8"),
      createPublicKey({ key: publicKeyDer, format: "der", type: "spki" }),
      Buffer.from(envelope.signature, "base64")
    );
  } catch {
    return false;
  }
}

export function validateEnvelope(envelope) {
  if (!isRecord(envelope)) return "MALFORMED_REQUEST";
  if (envelope.protocolVersion !== SANDBOX_PROTOCOL_VERSION) return "UNSUPPORTED_PROTOCOL";
  if (typeof envelope.requestId !== "string" || !UUID_PATTERN.test(envelope.requestId)) {
    return "INVALID_REQUEST_ID";
  }
  if (envelope.capabilityId !== SANDBOX_CAPABILITY_ID) return "CAPABILITY_NOT_ALLOWED";
  if (envelope.capabilityVersion !== SANDBOX_CAPABILITY_VERSION) return "VERSION_NOT_ALLOWED";
  if (envelope.pieceId !== SANDBOX_PIECE_ID) return "PIECE_NOT_ALLOWED";
  if (envelope.pieceVersion !== SANDBOX_PIECE_VERSION) return "VERSION_NOT_ALLOWED";
  if (envelope.actionId !== SANDBOX_ACTION_ID) return "ACTION_NOT_ALLOWED";
  if (!SANDBOX_PROBE_MODES.includes(envelope.probeMode)) return "PROBE_NOT_ALLOWED";
  if (!isRecord(envelope.input)) return "INVALID_INPUT";
  if (
    typeof envelope.input.contactId !== "string" ||
    envelope.input.contactId.length < 1 ||
    envelope.input.contactId.length > 100 ||
    !/^[A-Za-z0-9_-]+$/.test(envelope.input.contactId)
  ) {
    return "INVALID_INPUT";
  }
  if (
    typeof envelope.credential !== "string" ||
    envelope.credential.length < 1 ||
    envelope.credential.length > 16_384
  ) {
    return "INVALID_CREDENTIAL";
  }
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > SANDBOX_MAX_REQUEST_BYTES) {
    return "REQUEST_TOO_LARGE";
  }
  return null;
}
