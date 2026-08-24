import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";

import { SANDBOX_ACTION_ID, SANDBOX_MAX_REQUEST_BYTES, SANDBOX_MAX_RESPONSE_BYTES, SANDBOX_PIECE_ID, SANDBOX_PIECE_VERSION, SANDBOX_PROTOCOL_VERSION } from "./manifest.mjs";
import { validateEnvelope, verifyEnvelopeSignature } from "./protocol.mjs";

const FALLBACK_REQUEST_ID = "00000000-0000-4000-8000-000000000000";
const started = performance.now();

class Failure extends Error {
  constructor(category, retryable = false) { super(category); this.category = category; this.retryable = retryable; }
}

async function readRequest() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > SANDBOX_MAX_REQUEST_BYTES) throw new Failure("REQUEST_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Failure("MALFORMED_REQUEST"); }
}

function securityEvidence() {
  const status = readFileSync("/proc/self/status", "utf8");
  const field = (name) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(status)?.[1]?.trim() ?? null;
  let peakMemoryBytes = null;
  try {
    const value = readFileSync("/sys/fs/cgroup/memory.peak", "utf8").trim();
    if (/^\d+$/.test(value)) peakMemoryBytes = Number(value);
  } catch {}
  return { uid: process.getuid?.(), seccomp: field("Seccomp"), capabilities: field("CapEff"), noNewPrivileges: field("NoNewPrivs"), peakMemoryBytes };
}

function safeError(error) {
  if (error instanceof Failure) return error;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code)) return new Failure("EGRESS_TIMEOUT", true);
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return new Failure("EGRESS_DESTINATION_DENIED");
  if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) return new Failure("EGRESS_CONNECTION_FAILED", true);
  return new Failure("EGRESS_CONNECTION_FAILED", true);
}

async function executeAction(action, credential, contactId) {
  return action.run({
    auth: { access_token: credential },
    propsValue: { contactId, additionalPropertiesToRetrieve: ["firstname", "credentialAccepted"] }
  });
}

async function main() {
  let requestId = FALLBACK_REQUEST_ID;
  try {
    const envelope = await readRequest();
    if (typeof envelope.requestId === "string") requestId = envelope.requestId;
    if (!verifyEnvelopeSignature(envelope, readFileSync("/sandbox/public-key.der"))) throw new Failure("INVALID_SIGNATURE");
    const validationError = validateEnvelope(envelope);
    if (validationError) throw new Failure(validationError);
    const loadAt = performance.now();
    const loaded = await import("@activepieces/piece-hubspot");
    const action = loaded.hubspot?.actions?.()[SANDBOX_ACTION_ID];
    const moduleLoadMs = Number((performance.now() - loadAt).toFixed(2));
    if (action?.name !== SANDBOX_ACTION_ID || action?.classification !== "READ" || typeof action.run !== "function") throw new Failure("ACTION_NOT_ALLOWED");
    const executeAt = performance.now();
    let raw;
    if (envelope.input.contactId === "rebind") {
      const first = await executeAction(action, envelope.credential, "first");
      let secondDenied = false;
      try { await executeAction(action, envelope.credential, "second"); } catch { secondDenied = true; }
      raw = { id: first.id, properties: { ...first.properties, rebindSecondDenied: String(secondDenied) }, archived: first.archived };
    } else {
      raw = await executeAction(action, envelope.credential, envelope.input.contactId);
    }
    const output = {
      contactId: raw?.id,
      properties: raw?.properties,
      archived: raw?.archived === true,
      pieceId: SANDBOX_PIECE_ID,
      pieceVersion: SANDBOX_PIECE_VERSION,
      actionId: SANDBOX_ACTION_ID
    };
    const response = {
      protocolVersion: SANDBOX_PROTOCOL_VERSION, requestId, ok: true, acknowledged: true, output,
      meta: { sandboxInstanceId: hostname(), moduleLoadMs, executionMs: Number((performance.now() - executeAt).toFixed(2)), processMs: Number((performance.now() - started).toFixed(2)), peakMemoryBytes: securityEvidence().peakMemoryBytes, security: securityEvidence() }
    };
    const serialized = JSON.stringify(response);
    if (Buffer.byteLength(serialized) > SANDBOX_MAX_RESPONSE_BYTES) throw new Failure("RESPONSE_TOO_LARGE");
    process.stdout.write(`${serialized}\n`);
  } catch (error) {
    const failure = safeError(error);
    process.stdout.write(`${JSON.stringify({ protocolVersion: SANDBOX_PROTOCOL_VERSION, requestId, ok: false, errorCategory: failure.category, retryable: failure.retryable })}\n`);
  }
}

await main();
