import { buildInvocationPlan, PieceContainerEngine } from "./container-engine.mjs";
import { PieceRuntimeError } from "./errors.mjs";
import { REVIEWED_MANIFESTS } from "./manifest-registry.mjs";
import {
  SUPERVISOR_DEFAULT_CONCURRENCY,
  SUPERVISOR_MAX_CONCURRENCY,
  SUPERVISOR_PROTOCOL_VERSION,
} from "./supervisor-constants.mjs";
import { SupervisorError } from "./supervisor-errors.mjs";
import { validateSupervisorEnvelope } from "./supervisor-protocol.mjs";

function boundedConcurrency(value) {
  const parsed = Number(value ?? SUPERVISOR_DEFAULT_CONCURRENCY);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > SUPERVISOR_MAX_CONCURRENCY) {
    throw new SupervisorError("SUPERVISOR_UNAVAILABLE", 503);
  }
  return parsed;
}

function linkAbortSignals(...signals) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of signals.filter(Boolean)) {
    if (signal.aborted) controller.abort(); else signal.addEventListener("abort", abort, { once: true });
  }
  return controller;
}

export class PieceSupervisorService {
  /** @param {{engine?: PieceContainerEngine, concurrencyLimit?: number | string, logger?: Function}} options */
  constructor({ engine, concurrencyLimit = SUPERVISOR_DEFAULT_CONCURRENCY, logger = () => undefined } = {}) {
    if (!(engine instanceof PieceContainerEngine)) throw new SupervisorError("SUPERVISOR_UNAVAILABLE", 503);
    this.engine = engine;
    this.concurrencyLimit = boundedConcurrency(concurrencyLimit);
    this.logger = logger;
    this.active = new Map();
    this.ready = false;
    this.shuttingDown = false;
  }

  health() {
    return Object.freeze({
      ok: this.ready && !this.shuttingDown,
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      status: this.ready && !this.shuttingDown ? "ready" : "unavailable",
      activeInvocations: this.active.size,
      concurrencyLimit: this.concurrencyLimit,
    });
  }

  setReady() {
    if (this.shuttingDown) throw new SupervisorError("SUPERVISOR_UNAVAILABLE", 503);
    this.ready = true;
  }

  async execute(envelope, clientSignal) {
    if (!this.ready || this.shuttingDown) throw new SupervisorError("SUPERVISOR_UNAVAILABLE", 503);
    const { request, credential } = validateSupervisorEnvelope(envelope);
    let plan = null;
    let active = null;
    try {
      const manifest = REVIEWED_MANIFESTS.get(request.capabilityId, request.capabilityVersion);
      if (request.mode !== "TEST" || !manifest.modes.includes("TEST") || manifest.operationClassification !== "READ") {
        throw new PieceRuntimeError("PIECE_ACTION_NOT_ALLOWED");
      }
      plan = buildInvocationPlan(request);
      if (this.active.has(plan.invocationId)) throw new SupervisorError("SUPERVISOR_DUPLICATE", 409);
      if (this.active.size >= this.concurrencyLimit) throw new SupervisorError("SUPERVISOR_BUSY", 429);
      const controller = linkAbortSignals(clientSignal);
      active = { controller, plan };
      this.active.set(plan.invocationId, active);
      this.safeLog("piece_supervisor_execution_started", request, null);
      const result = await this.engine.runInvocation({ plan, request, credential, signal: controller.signal });
      this.safeLog("piece_supervisor_execution_finished", request, result?.ok === true ? null : result?.errorCode ?? "PIECE_RUNTIME_FAILED");
      return result;
    } finally {
      credential.fill(0);
      if (plan && active) {
        try {
          await this.engine.cleanupInvocation(plan);
        } catch {
          this.safeLog("piece_supervisor_cleanup_failed", request, "PIECE_RUNTIME_FAILED");
          throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
        } finally {
          this.active.delete(plan.invocationId);
        }
      }
    }
  }

  safeLog(event, request, errorCode) {
    try {
      this.logger(Object.freeze({
        event,
        requestId: request?.requestId ?? null,
        executionId: request?.executionId ?? null,
        capabilityId: request?.capabilityId ?? null,
        capabilityVersion: request?.capabilityVersion ?? null,
        status: errorCode ? "failed" : event.endsWith("finished") ? "finished" : "started",
        errorCode,
      }));
    } catch {
      // Supervisor correctness is independent of telemetry.
    }
  }

  async shutdown(timeoutMs = 8_000) {
    this.ready = false;
    this.shuttingDown = true;
    for (const { controller } of this.active.values()) controller.abort();
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const { plan } of this.active.values()) {
      await this.engine.cleanupInvocation(plan).catch(() => undefined);
    }
    this.active.clear();
  }
}
