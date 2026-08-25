import { REVIEWED_ADAPTERS } from "./adapter-registry.mjs";
import { normalizePieceFailure, PieceRuntimeError } from "./errors.mjs";
import { REVIEWED_MANIFESTS } from "./manifest-registry.mjs";
import { loadReviewedAction } from "./piece-loader.mjs";
import { validateInvocationRequest } from "./protocol.mjs";

const NOOP_LOGGER = () => undefined;

function boundedJson(value, maximumBytes, code = "PIECE_RESPONSE_INVALID") {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new PieceRuntimeError(code);
  }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) throw new PieceRuntimeError(code);
  return serialized;
}

function validCredentialBuffer(value) {
  return Buffer.isBuffer(value) && value.length > 0 && value.length <= 16 * 1024 && !value.includes(0);
}

function safeEvent(logger, event, request, manifest, error) {
  try {
    logger(Object.freeze({
      event,
      requestId: request?.requestId ?? null,
      executionId: request?.executionId ?? null,
      capabilityId: manifest?.capabilityId ?? request?.capabilityId ?? null,
      capabilityVersion: manifest?.capabilityVersion ?? request?.capabilityVersion ?? null,
      status: error ? "failed" : event.endsWith("succeeded") ? "succeeded" : "started",
      errorCode: error?.code ?? null,
      retryable: error?.retryable ?? null,
    }));
  } catch {
    // Execution truth is independent of its bounded telemetry sink.
  }
}

export async function executeReviewedPiece(
  invocation,
  dependencies = {},
) {
  const manifests = dependencies.manifests ?? REVIEWED_MANIFESTS;
  const adapters = dependencies.adapters ?? REVIEWED_ADAPTERS;
  const loadAction = dependencies.loadAction ?? loadReviewedAction;
  const logger = dependencies.logger ?? NOOP_LOGGER;
  let request = null;
  let manifest = null;
  let credentialText = "";
  let auth = null;
  let timer;
  try {
    request = validateInvocationRequest(invocation?.request);
    manifest = manifests.get(request.capabilityId, request.capabilityVersion);
    boundedJson(request, manifest.maximumRequestBytes, "PIECE_INVALID_INPUT");
    if (!manifest.modes.includes(request.mode)) throw new PieceRuntimeError("PIECE_ACTION_NOT_ALLOWED");
    if (
      manifest.operationClassification !== "READ" ||
      manifest.expectedClassification !== "READ"
    ) {
      throw new PieceRuntimeError("PIECE_ACTION_NOT_ALLOWED");
    }
    if (!validCredentialBuffer(invocation?.credential)) {
      throw new PieceRuntimeError("PIECE_INVALID_CREDENTIAL");
    }
    try {
      credentialText = new TextDecoder("utf-8", { fatal: true }).decode(invocation.credential);
    } catch {
      throw new PieceRuntimeError("PIECE_INVALID_CREDENTIAL");
    }
    if (!credentialText.trim()) throw new PieceRuntimeError("PIECE_INVALID_CREDENTIAL");

    const propsValue = adapters.mapInput(manifest.inputMapper, request.input);
    auth = adapters.projectAuth(manifest.authProjection, credentialText);
    const action = await loadAction(manifest);
    if (
      action?.name !== manifest.actionId ||
      action?.classification !== manifest.expectedClassification ||
      typeof action.run !== "function"
    ) {
      throw new PieceRuntimeError("PIECE_ACTION_NOT_ALLOWED");
    }

    safeEvent(logger, "piece_runtime_started", request, manifest);
    const timeoutMs = manifest.resourceLimits.executionTimeoutMs;
    const raw = await Promise.race([
      action.run({ auth, propsValue }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new PieceRuntimeError("PIECE_TIMEOUT", true)),
          timeoutMs,
        );
      }),
    ]);
    boundedJson(raw, manifest.maximumProviderDownstreamBytes);
    const output = adapters.normalizeOutput(manifest.outputNormalizer, raw);
    boundedJson(output, manifest.maximumResponseBytes);
    const response = Object.freeze({
      protocolVersion: 1,
      requestId: request.requestId,
      ok: true,
      acknowledged: true,
      output,
      meta: Object.freeze({
        capabilityId: manifest.capabilityId,
        capabilityVersion: manifest.capabilityVersion,
        providerId: manifest.providerId,
        pieceVersion: manifest.pieceVersion,
        actionId: manifest.actionId,
        classification: manifest.operationClassification,
        attempts: 1,
      }),
    });
    safeEvent(logger, "piece_runtime_succeeded", request, manifest);
    return response;
  } catch (error) {
    const normalized = normalizePieceFailure(error);
    safeEvent(logger, "piece_runtime_failed", request, manifest, normalized);
    return Object.freeze({
      protocolVersion: 1,
      requestId: request?.requestId ?? "unknown",
      ok: false,
      errorCode: normalized.code,
      retryable: normalized.retryable,
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (Buffer.isBuffer(invocation?.credential)) invocation.credential.fill(0);
    credentialText = "";
    auth = null;
  }
}
