import { PieceRuntimeError } from "./errors.mjs";
import {
  decodeCredential,
  PIECE_RUNTIME_MAX_ENVELOPE_BYTES,
} from "./protocol.mjs";
import { executeReviewedPiece } from "./runtime.mjs";

const WORKER_KEYS = Object.freeze(["request", "credentialBase64"]);

function exactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return keys.length === allowed.length && keys.every((key, index) => key === allowed[index]);
}

async function readEnvelope() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > PIECE_RUNTIME_MAX_ENVELOPE_BYTES) {
      throw new PieceRuntimeError("PIECE_INVALID_INPUT");
    }
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks);
  try {
    const value = JSON.parse(raw.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || !exactKeys(value, WORKER_KEYS)) {
      throw new PieceRuntimeError("PIECE_INVALID_INPUT");
    }
    return value;
  } catch (error) {
    if (error instanceof PieceRuntimeError) throw error;
    throw new PieceRuntimeError("PIECE_INVALID_INPUT");
  } finally {
    raw.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function main() {
  let requestId = "unknown";
  let credential = null;
  try {
    const envelope = await readEnvelope();
    requestId = typeof envelope.request?.requestId === "string" ? envelope.request.requestId : "unknown";
    credential = decodeCredential(envelope.credentialBase64);
    envelope.credentialBase64 = "";
    const response = await executeReviewedPiece({ request: envelope.request, credential });
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    const normalized = error instanceof PieceRuntimeError
      ? error
      : new PieceRuntimeError("PIECE_RUNTIME_FAILED");
    process.stdout.write(`${JSON.stringify({
      protocolVersion: 1,
      requestId,
      ok: false,
      errorCode: normalized.code,
      retryable: normalized.retryable,
    })}\n`);
  } finally {
    credential?.fill(0);
  }
}

await main();
