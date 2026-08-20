import "@/lib/server-only-runtime";

import { createHash, createHmac } from "node:crypto";

import {
  DELEGATED_ERROR_CATEGORIES,
  type CapabilityExecutionEnvelope,
  type CapabilityExecutionRequest,
  type CapabilityExecutionResult,
  type CapabilityExecutor,
  DelegatedExecutionError,
  type DelegatedErrorCategory,
} from "@/lib/executors/types";
import type { OperationalEvent } from "@/lib/observability";

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
const MIN_SECRET_LENGTH = 32;

type FetchImplementation = typeof fetch;
type TelemetryCapture = (event: OperationalEvent) => Promise<unknown>;

type ActivepiecesExecutorOptions = {
  fetchImplementation?: FetchImplementation;
  captureTelemetry?: TelemetryCapture;
  now?: () => number;
};

function enabled(value: string | undefined): boolean {
  return value === "true";
}

function timeoutMsFromEnvironment(): number {
  const parsed = Number.parseInt(process.env.ACTIVEPIECES_BRIDGE_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, parsed));
}

function bridgeConfiguration(): { url: URL; secret: string; timeoutMs: number } {
  if (
    !enabled(process.env.DELEGATED_EXECUTION_ENABLED) ||
    !enabled(process.env.ACTIVEPIECES_EXECUTOR_ENABLED)
  ) {
    throw new DelegatedExecutionError("DELEGATED_DISABLED", false);
  }

  const configuredUrl = process.env.ACTIVEPIECES_BRIDGE_URL;
  const secret = process.env.ACTIVEPIECES_BRIDGE_SECRET ?? "";
  let url: URL;
  try {
    url = new URL(configuredUrl ?? "");
  } catch {
    throw new DelegatedExecutionError("DELEGATED_DISABLED", false);
  }
  if (url.protocol !== "https:" || url.username || url.password || secret.length < MIN_SECRET_LENGTH) {
    throw new DelegatedExecutionError("DELEGATED_DISABLED", false);
  }
  return { url, secret, timeoutMs: timeoutMsFromEnvironment() };
}

export function createBridgeBodyDigest(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function createBridgeSignature(input: {
  secret: string;
  timestamp: string;
  requestId: string;
  bodyDigest: string;
}): string {
  return createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.requestId}.${input.bodyDigest}`)
    .digest("hex");
}

function delegatedCategory(value: unknown): DelegatedErrorCategory | null {
  return typeof value === "string" &&
    (DELEGATED_ERROR_CATEGORIES as readonly string[]).includes(value)
    ? (value as DelegatedErrorCategory)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateBridgeResponse(
  value: unknown,
  requestId: string,
): CapabilityExecutionResult {
  if (!isRecord(value) || value.protocolVersion !== 1 || value.requestId !== requestId) {
    throw new DelegatedExecutionError("DELEGATED_BAD_RESPONSE", false);
  }
  if (value.ok === true) {
    if (value.acknowledged !== true || !isRecord(value.output)) {
      throw new DelegatedExecutionError("DELEGATED_BAD_RESPONSE", false);
    }
    return { ok: true, acknowledged: true, output: value.output };
  }
  if (value.ok === false) {
    const errorCategory = delegatedCategory(value.errorCategory);
    if (!errorCategory || typeof value.retryable !== "boolean") {
      throw new DelegatedExecutionError("DELEGATED_BAD_RESPONSE", false);
    }
    return { ok: false, errorCategory, retryable: value.retryable };
  }
  throw new DelegatedExecutionError("DELEGATED_BAD_RESPONSE", false);
}

function statusFailure(status: number): DelegatedExecutionError {
  if (status === 401 || status === 403) {
    return new DelegatedExecutionError("DELEGATED_AUTH_FAILED", false);
  }
  if (status === 429) {
    return new DelegatedExecutionError("DELEGATED_RATE_LIMITED", true);
  }
  if ([500, 502, 503].includes(status)) {
    return new DelegatedExecutionError("DELEGATED_UNAVAILABLE", true);
  }
  return new DelegatedExecutionError("DELEGATED_EXECUTION_FAILED", false);
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new DelegatedExecutionError("DELEGATED_BAD_RESPONSE", false);
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function telemetryContext(request: CapabilityExecutionRequest) {
  const envelope = request.envelope;
  return {
    requestId: envelope.requestId,
    userId: request.authenticatedUserId,
    workflowId: null,
    workflowVersionId: envelope.workflowVersionId,
    executionId: envelope.executionId,
    stepId: envelope.stepId,
    capability: envelope.capabilityId,
  };
}

export class ActivepiecesExecutor implements CapabilityExecutor {
  readonly kind = "activepieces" as const;
  private readonly fetchImplementation: FetchImplementation;
  private readonly captureTelemetry: TelemetryCapture;
  private readonly now: () => number;

  constructor(options: ActivepiecesExecutorOptions = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.captureTelemetry = options.captureTelemetry ?? (async (event) => {
      const { captureOperationalEvent } = await import("@/lib/observability");
      return captureOperationalEvent(event);
    });
    this.now = options.now ?? Date.now;
  }

  private async emitTelemetry(event: OperationalEvent): Promise<void> {
    try {
      await this.captureTelemetry(event);
    } catch {
      // Execution truth must not depend on the telemetry sink being available.
    }
  }

  async execute(request: CapabilityExecutionRequest): Promise<CapabilityExecutionResult> {
    if (
      !request.authenticatedUserId ||
      !request.workflowOwnerId ||
      request.authenticatedUserId !== request.workflowOwnerId
    ) {
      return { ok: false, errorCategory: "DELEGATED_AUTH_FAILED", retryable: false };
    }

    let configuration: ReturnType<typeof bridgeConfiguration>;
    try {
      configuration = bridgeConfiguration();
    } catch (error) {
      const normalized = error instanceof DelegatedExecutionError
        ? error
        : new DelegatedExecutionError("DELEGATED_DISABLED", false);
      return { ok: false, errorCategory: normalized.category, retryable: normalized.retryable };
    }

    const startedAt = this.now();
    const body = JSON.stringify(request.envelope satisfies CapabilityExecutionEnvelope);
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
      return { ok: false, errorCategory: "DELEGATED_EXECUTION_FAILED", retryable: false };
    }
    const bodyDigest = createBridgeBodyDigest(body);
    const timestamp = String(startedAt);
    const signature = createBridgeSignature({
      secret: configuration.secret,
      timestamp,
      requestId: request.envelope.requestId,
      bodyDigest,
    });
    const telemetry = telemetryContext(request);
    await this.emitTelemetry({
      level: "info",
      event: "delegated_request_started",
      ...telemetry,
      status: "started",
      metadata: { executor: this.kind, protocolVersion: 1 },
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), configuration.timeoutMs);
    try {
      const response = await this.fetchImplementation(configuration.url, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-CrazyLoops-Timestamp": timestamp,
          "X-CrazyLoops-Request-Id": request.envelope.requestId,
          "X-CrazyLoops-Content-SHA256": bodyDigest,
          "X-CrazyLoops-Signature": `v1=${signature}`,
        },
        body,
      });

      if (response.status >= 300 && response.status < 400) {
        throw new DelegatedExecutionError("DELEGATED_BAD_RESPONSE", false);
      }
      if (!response.ok) throw statusFailure(response.status);

      const bytes = await readBoundedResponse(response);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new DelegatedExecutionError("DELEGATED_BAD_RESPONSE", false);
      }
      const result = validateBridgeResponse(parsed, request.envelope.requestId);
      const durationMs = Math.max(0, this.now() - startedAt);
      if (!result.ok) {
        await this.emitTelemetry({
          level: "warn",
          event: "delegated_request_failed",
          ...telemetry,
          durationMs,
          status: "failed",
          errorCategory: result.errorCategory,
          metadata: { executor: this.kind, retryable: result.retryable, protocolVersion: 1 },
        });
        return result;
      }
      await this.emitTelemetry({
        level: "info",
        event: "delegated_request_succeeded",
        ...telemetry,
        durationMs,
        status: "succeeded",
        metadata: { executor: this.kind, protocolVersion: 1 },
      });
      return result;
    } catch (error) {
      const normalized = error instanceof DelegatedExecutionError
        ? error
        : error instanceof Error && error.name === "AbortError"
          ? new DelegatedExecutionError("DELEGATED_TIMEOUT", true)
          : new DelegatedExecutionError("DELEGATED_CONNECTION_FAILED", true);
      await this.emitTelemetry({
        level: "warn",
        event: "delegated_request_failed",
        ...telemetry,
        durationMs: Math.max(0, this.now() - startedAt),
        status: "failed",
        errorCategory: normalized.category,
        metadata: { executor: this.kind, retryable: normalized.retryable, protocolVersion: 1 },
      });
      return { ok: false, errorCategory: normalized.category, retryable: normalized.retryable };
    } finally {
      clearTimeout(timeout);
    }
  }
}
