import {
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_BYTES = 128 * 1024;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_CAPSULE_TTL_MS = 120_000;
export const CANARY_CAPABILITY = "internal.connector_runner_canary";

const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_CIPHERTEXT_BYTES = MAX_CREDENTIAL_BYTES + 32;
const MIN_TRANSPORT_SECRET_LENGTH = 32;
const ALGORITHM = "aes-256-gcm";
const NOOP_LOGGER = (event) => { void event; };

class RunnerError extends Error {
  constructor(category, retryable = false, status = 400) {
    super("Connector runner request failed.");
    this.name = "RunnerError";
    this.category = category;
    this.retryable = retryable;
    this.status = status;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 160;
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalBase64(value, expectedLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new RunnerError("DELEGATED_CAPSULE_REJECTED");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length === 0 ||
    decoded.toString("base64") !== value ||
    (expectedLength !== undefined && decoded.length !== expectedLength)
  ) {
    decoded.fill(0);
    throw new RunnerError("DELEGATED_CAPSULE_REJECTED");
  }
  return decoded;
}

function safeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function bodyDigest(body) {
  return createHash("sha256").update(body).digest("hex");
}

export function transportSignature({ secret, timestamp, requestId, digest }) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${requestId}.${digest}`)
    .digest("hex");
}

function header(headers, name) {
  if (headers instanceof Headers) return headers.get(name) ?? "";
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = match?.[1];
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

function authenticate({ rawBody, headers, secret, now }) {
  if (typeof secret !== "string" || secret.length < MIN_TRANSPORT_SECRET_LENGTH) {
    throw new RunnerError("DELEGATED_AUTH_FAILED", false, 503);
  }
  const timestamp = header(headers, "x-crazyloops-timestamp");
  const requestId = header(headers, "x-crazyloops-request-id");
  const claimedDigest = header(headers, "x-crazyloops-content-sha256");
  const signatureHeader = header(headers, "x-crazyloops-signature");
  if (!/^\d{13}$/.test(timestamp) || !boundedIdentity(requestId)) {
    throw new RunnerError("DELEGATED_AUTH_FAILED", false, 401);
  }
  const timestampNumber = Number(timestamp);
  if (!Number.isSafeInteger(timestampNumber) || Math.abs(now - timestampNumber) > MAX_CLOCK_SKEW_MS) {
    throw new RunnerError("DELEGATED_AUTH_FAILED", false, 401);
  }
  const calculatedDigest = bodyDigest(rawBody);
  if (!safeHexEqual(claimedDigest, calculatedDigest)) {
    throw new RunnerError("DELEGATED_AUTH_FAILED", false, 401);
  }
  const expected = transportSignature({
    secret,
    timestamp,
    requestId,
    digest: calculatedDigest,
  });
  const supplied = signatureHeader.startsWith("v1=") ? signatureHeader.slice(3) : "";
  if (!safeHexEqual(supplied, expected)) {
    throw new RunnerError("DELEGATED_AUTH_FAILED", false, 401);
  }
  return requestId;
}

function validateCapsule(capsule) {
  if (
    !isRecord(capsule) ||
    !exactKeys(capsule, ["keyVersion", "algorithm", "nonce", "ciphertext", "authTag", "expiresAt"]) ||
    !Number.isSafeInteger(capsule.keyVersion) ||
    capsule.keyVersion < 1 ||
    capsule.algorithm !== ALGORITHM ||
    typeof capsule.nonce !== "string" ||
    typeof capsule.ciphertext !== "string" ||
    typeof capsule.authTag !== "string" ||
    !Number.isSafeInteger(capsule.expiresAt)
  ) throw new RunnerError("DELEGATED_CAPSULE_REJECTED");
}

export function validateEnvelope(value) {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "protocolVersion",
      "requestId",
      "executionId",
      "workflowVersionId",
      "stepId",
      "capabilityId",
      "capabilityVersion",
      "mode",
      "idempotencyKey",
      "input",
      "credentialCapsule",
    ]) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    !boundedIdentity(value.requestId) ||
    !boundedIdentity(value.executionId) ||
    !boundedIdentity(value.workflowVersionId) ||
    !boundedIdentity(value.stepId) ||
    !boundedIdentity(value.capabilityId) ||
    !Number.isSafeInteger(value.capabilityVersion) ||
    value.capabilityVersion < 1 ||
    !new Set(["TEST", "LIVE"]).has(value.mode) ||
    !boundedIdentity(value.idempotencyKey) ||
    !isRecord(value.input)
  ) throw new RunnerError("DELEGATED_EXECUTION_FAILED");
  validateCapsule(value.credentialCapsule);
  return value;
}

function capsuleAad(envelope) {
  return Buffer.from(JSON.stringify({
    namespace: "crazyloops:connector-runner:credential-capsule:v1",
    protocolVersion: envelope.protocolVersion,
    requestId: envelope.requestId,
    executionId: envelope.executionId,
    workflowVersionId: envelope.workflowVersionId,
    stepId: envelope.stepId,
    capabilityId: envelope.capabilityId,
    capabilityVersion: envelope.capabilityVersion,
    keyVersion: envelope.credentialCapsule.keyVersion,
    algorithm: ALGORITHM,
    expiresAt: envelope.credentialCapsule.expiresAt,
  }), "utf8");
}

function validateCapsuleLifetime(envelope, now) {
  const expiresAt = envelope.credentialCapsule.expiresAt;
  if (expiresAt <= now || expiresAt - now > MAX_CAPSULE_TTL_MS) {
    throw new RunnerError("DELEGATED_CAPSULE_REJECTED", false, 400);
  }
}

export function openCredentialCapsule(envelope, keyRing, now) {
  const capsule = envelope.credentialCapsule;
  validateCapsuleLifetime(envelope, now);
  const sourceKey = keyRing.get(capsule.keyVersion);
  if (!Buffer.isBuffer(sourceKey) || sourceKey.length !== 32) {
    throw new RunnerError("DELEGATED_CAPSULE_REJECTED", false, 400);
  }
  const nonce = canonicalBase64(capsule.nonce, 12);
  const authTag = canonicalBase64(capsule.authTag, 16);
  const ciphertext = canonicalBase64(capsule.ciphertext);
  if (ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    ciphertext.fill(0);
    throw new RunnerError("DELEGATED_CAPSULE_REJECTED", false, 400);
  }
  const key = Buffer.from(sourceKey);
  let decryptedChunk = null;
  let finalChunk = null;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAAD(capsuleAad(envelope));
    decipher.setAuthTag(authTag);
    decryptedChunk = decipher.update(ciphertext);
    finalChunk = decipher.final();
    const plaintext = Buffer.concat([decryptedChunk, finalChunk]);
    if (plaintext.length < 1 || plaintext.length > MAX_CREDENTIAL_BYTES) {
      plaintext.fill(0);
      throw new RunnerError("DELEGATED_CAPSULE_REJECTED", false, 400);
    }
    return plaintext;
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError("DELEGATED_CAPSULE_REJECTED", false, 400);
  } finally {
    key.fill(0);
    decryptedChunk?.fill(0);
    finalChunk?.fill(0);
    nonce.fill(0);
    authTag.fill(0);
    ciphertext.fill(0);
  }
}

function capsuleFingerprint(envelope) {
  return createHash("sha256").update(JSON.stringify({
    protocolVersion: envelope.protocolVersion,
    requestId: envelope.requestId,
    executionId: envelope.executionId,
    workflowVersionId: envelope.workflowVersionId,
    stepId: envelope.stepId,
    capabilityId: envelope.capabilityId,
    capabilityVersion: envelope.capabilityVersion,
    credentialCapsule: envelope.credentialCapsule,
  })).digest("hex");
}

function canaryAdapter() {
  return {
    async execute({ credential, input, signal }) {
      switch (input.simulation ?? "success") {
        case "adapter_throw":
          throw new Error("Simulated adapter failure.");
        case "provider_401":
          throw new RunnerError("DELEGATED_AUTH_FAILED", false, 200);
        case "provider_429":
          throw new RunnerError("DELEGATED_RATE_LIMITED", true, 200);
        case "provider_500":
          throw new RunnerError("DELEGATED_UNAVAILABLE", true, 200);
        case "timeout":
          await new Promise((resolve, reject) => {
            const onAbort = () => reject(new RunnerError("DELEGATED_TIMEOUT", true, 200));
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
          throw new RunnerError("DELEGATED_TIMEOUT", true, 200);
        case "success":
          return {
            proof: createHmac("sha256", credential)
              .update("CrazyLoops runner proof")
              .digest("hex"),
          };
        default:
          throw new RunnerError("DELEGATED_EXECUTION_FAILED", false, 200);
      }
    },
  };
}

const ADAPTERS = new Map([[CANARY_CAPABILITY, canaryAdapter()]]);

function safeLog(logger, event, envelope, startedAt, status, category) {
  logger({
    event,
    requestId: envelope?.requestId ?? null,
    executionId: envelope?.executionId ?? null,
    workflowVersionId: envelope?.workflowVersionId ?? null,
    stepId: envelope?.stepId ?? null,
    capabilityId: envelope?.capabilityId ?? null,
    capabilityVersion: envelope?.capabilityVersion ?? null,
    durationMs: Math.max(0, Date.now() - startedAt),
    status,
    errorCategory: category ?? null,
  });
}

function normalizedResponse(requestId, error) {
  return {
    status: error.status,
    body: {
      protocolVersion: PROTOCOL_VERSION,
      requestId: boundedIdentity(requestId) ? requestId : "unknown",
      ok: false,
      errorCategory: error.category,
      retryable: error.retryable,
    },
  };
}

export async function processRunnerRequest({
  rawBody,
  headers,
  transportSecret,
  keyRing,
  replayStore,
  now = Date.now(),
  adapterTimeoutMs = 10_000,
  logger = NOOP_LOGGER,
}) {
  const startedAt = Date.now();
  let requestId = header(headers, "x-crazyloops-request-id");
  let envelope = null;
  try {
    if (Buffer.byteLength(rawBody, "utf8") > MAX_REQUEST_BYTES) {
      throw new RunnerError("DELEGATED_EXECUTION_FAILED", false, 413);
    }
    requestId = authenticate({ rawBody, headers, secret: transportSecret, now });
    try {
      envelope = validateEnvelope(JSON.parse(rawBody));
    } catch (error) {
      if (error instanceof RunnerError) throw error;
      throw new RunnerError("DELEGATED_EXECUTION_FAILED", false, 400);
    }
    if (envelope.requestId !== requestId) {
      throw new RunnerError("DELEGATED_AUTH_FAILED", false, 401);
    }
    if (envelope.capabilityId !== CANARY_CAPABILITY || envelope.capabilityVersion !== 1) {
      throw new RunnerError("DELEGATED_UNSUPPORTED_CAPABILITY", false, 422);
    }
    const adapter = ADAPTERS.get(envelope.capabilityId);
    if (!adapter) throw new RunnerError("DELEGATED_UNSUPPORTED_CAPABILITY", false, 422);

    validateCapsuleLifetime(envelope, now);
    let claimed;
    try {
      claimed = await replayStore.claim({
        fingerprint: capsuleFingerprint(envelope),
        ttlMs: envelope.credentialCapsule.expiresAt - now,
      });
    } catch {
      throw new RunnerError("DELEGATED_REPLAY_UNAVAILABLE", true, 503);
    }
    if (!claimed) throw new RunnerError("DELEGATED_REPLAYED", false, 409);

    const credential = openCredentialCapsule(envelope, keyRing, now);
    try {
      safeLog(logger, "connector_runner_started", envelope, startedAt, "started");
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.max(100, Math.min(30_000, adapterTimeoutMs)),
      );
      try {
        const output = await adapter.execute({
          capabilityId: envelope.capabilityId,
          input: envelope.input,
          credential,
          idempotencyKey: envelope.idempotencyKey,
          signal: controller.signal,
        });
        safeLog(logger, "connector_runner_succeeded", envelope, startedAt, "succeeded");
        return {
          status: 200,
          body: {
            protocolVersion: PROTOCOL_VERSION,
            requestId: envelope.requestId,
            ok: true,
            acknowledged: true,
            output,
          },
        };
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      credential.fill(0);
    }
  } catch (error) {
    const normalized = error instanceof RunnerError
      ? error
      : new RunnerError("DELEGATED_EXECUTION_FAILED", false, 500);
    safeLog(logger, "connector_runner_failed", envelope, startedAt, "failed", normalized.category);
    return normalizedResponse(requestId, normalized);
  }
}

export function parseRunnerKeyRingFromEnvironment(environment = process.env) {
  const activeText = environment.CONNECTOR_RUNNER_WRAP_KEY_ACTIVE_VERSION;
  if (!activeText || !/^[1-9]\d{0,5}$/.test(activeText)) {
    throw new Error("Connector runner wrapping keys are unavailable.");
  }
  const activeVersion = Number(activeText);
  const keys = new Map();
  const entries = Object.entries(environment).filter(([name]) =>
    /^CONNECTOR_RUNNER_WRAP_KEY_V[1-9]\d{0,5}$/.test(name));
  if (entries.length < 1 || entries.length > 8) {
    throw new Error("Connector runner wrapping keys are unavailable.");
  }
  for (const [name, encoded] of entries) {
    const version = Number(name.slice("CONNECTOR_RUNNER_WRAP_KEY_V".length));
    if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
      throw new Error("Connector runner wrapping keys are unavailable.");
    }
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || key.toString("base64") !== encoded) {
      key.fill(0);
      throw new Error("Connector runner wrapping keys are unavailable.");
    }
    keys.set(version, key);
  }
  if (!keys.has(activeVersion)) {
    throw new Error("Connector runner wrapping keys are unavailable.");
  }
  return keys;
}

export function serializeResponse(result) {
  const body = JSON.stringify(result.body);
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    return JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      requestId: result.body.requestId ?? "unknown",
      ok: false,
      errorCategory: "DELEGATED_EXECUTION_FAILED",
      retryable: false,
    });
  }
  return body;
}
