import "@/lib/server-only-runtime";

import {
  CONNECTOR_RUNNER_MAX_REQUEST_BYTES,
  CONNECTOR_RUNNER_MAX_RESPONSE_BYTES,
  CONNECTOR_RUNNER_PROTOCOL_VERSION,
  ConnectorRunnerProtocolError,
  createConnectorRunnerBodyDigest,
  createConnectorRunnerCredentialCapsule,
  createConnectorRunnerSignature,
  loadConnectorRunnerActiveWrapKeyFromEnvironment,
  type ConnectorRunnerCapsuleBinding,
  type ConnectorRunnerRequestEnvelope,
} from "@/lib/executors/connector-runner-protocol";
import {
  DelegatedCredentialError,
  resolveDelegatedCredential,
} from "@/lib/executors/delegated-credentials";
import {
  DELEGATED_ERROR_CATEGORIES,
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
const MIN_SECRET_LENGTH = 32;
const CANARY_CAPABILITY = "internal.connector_runner_canary";
const SUPPORTED_CAPABILITY_VERSIONS = new Set([
  `${CANARY_CAPABILITY}@1`,
  "airtable.create_record@1",
]);

type FetchImplementation = typeof fetch;
type TelemetryCapture = (event: OperationalEvent) => Promise<unknown>;
export type ConnectorRunnerCredentialResolver = (
  request: CapabilityExecutionRequest,
) => Promise<Buffer>;

type ConnectorRunnerExecutorOptions = {
  fetchImplementation?: FetchImplementation;
  captureTelemetry?: TelemetryCapture;
  resolveCredential?: ConnectorRunnerCredentialResolver;
  now?: () => number;
};

function enabled(value: string | undefined): boolean {
  return value === "true";
}

function timeoutFromEnvironment(): number {
  const parsed = Number.parseInt(process.env.CONNECTOR_RUNNER_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, parsed));
}

function runnerConfiguration(): {
  url: URL;
  secret: string;
  timeoutMs: number;
  keyVersion: number;
  wrapKey: Buffer;
} {
  if (
    !enabled(process.env.DELEGATED_EXECUTION_ENABLED) ||
    !enabled(process.env.CONNECTOR_RUNNER_EXECUTION_ENABLED)
  ) {
    throw new DelegatedExecutionError("DELEGATED_DISABLED", false);
  }
  const secret = process.env.CONNECTOR_RUNNER_SECRET ?? "";
  let url: URL;
  try {
    url = new URL(process.env.CONNECTOR_RUNNER_URL ?? "");
  } catch {
    throw new DelegatedExecutionError("DELEGATED_DISABLED", false);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/v1/execute" ||
    url.search ||
    url.hash ||
    secret.length < MIN_SECRET_LENGTH
  ) {
    throw new DelegatedExecutionError("DELEGATED_DISABLED", false);
  }
  try {
    const { keyVersion, key } = loadConnectorRunnerActiveWrapKeyFromEnvironment();
    const encodedWrapKey = key.toString("base64");
    const forbiddenReuse = [
      process.env.ACTIVEPIECES_BRIDGE_SECRET,
      process.env.FLOWMIND_CREDENTIAL_MASTER_KEY,
      process.env.GROQ_API_KEY,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      process.env.FLOWMIND_CONNECTOR_SLACK_CLIENT_SECRET,
      process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET,
    ].filter((value): value is string => Boolean(value));
    if (
      secret === encodedWrapKey ||
      forbiddenReuse.includes(secret) ||
      forbiddenReuse.includes(encodedWrapKey)
    ) {
      key.fill(0);
      throw new DelegatedExecutionError("DELEGATED_DISABLED", false);
    }
    return { url, secret, timeoutMs: timeoutFromEnvironment(), keyVersion, wrapKey: key };
  } catch {
    throw new DelegatedExecutionError("DELEGATED_DISABLED", false);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function delegatedCategory(value: unknown): DelegatedErrorCategory | null {
  return typeof value === "string" &&
    (DELEGATED_ERROR_CATEGORIES as readonly string[]).includes(value)
    ? value as DelegatedErrorCategory
    : null;
}

function validateRunnerResponse(
  value: unknown,
  requestId: string,
): CapabilityExecutionResult {
  if (
    !isRecord(value) ||
    value.protocolVersion !== CONNECTOR_RUNNER_PROTOCOL_VERSION ||
    value.requestId !== requestId
  ) {
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
  if (status === 409) {
    return new DelegatedExecutionError("DELEGATED_REPLAYED", false);
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
    if (size > CONNECTOR_RUNNER_MAX_RESPONSE_BYTES) {
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

async function defaultCredentialResolver(
  request: CapabilityExecutionRequest,
): Promise<Buffer> {
  const reference = request.credentialReference;
  if (!reference) throw new DelegatedExecutionError("DELEGATED_AUTH_FAILED", false);
  const credential = await resolveDelegatedCredential({
    authenticatedUserId: request.authenticatedUserId,
    workflowOwnerId: request.workflowOwnerId,
    connectionId: reference.connectionId,
    connectorId: reference.connectorId,
    capabilityId: request.envelope.capabilityId,
  });
  return Buffer.from(credential.value, "utf8");
}

function telemetryContext(request: CapabilityExecutionRequest) {
  return {
    requestId: request.envelope.requestId,
    userId: request.authenticatedUserId,
    workflowId: null,
    workflowVersionId: request.envelope.workflowVersionId,
    executionId: request.envelope.executionId,
    stepId: request.envelope.stepId,
    capability: request.envelope.capabilityId,
  };
}

export class ConnectorRunnerExecutor implements CapabilityExecutor {
  readonly kind = "connector_runner" as const;
  private readonly fetchImplementation: FetchImplementation;
  private readonly captureTelemetry: TelemetryCapture;
  private readonly resolveCredential: ConnectorRunnerCredentialResolver;
  private readonly now: () => number;

  constructor(options: ConnectorRunnerExecutorOptions = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.captureTelemetry = options.captureTelemetry ?? (async (event) => {
      const { captureOperationalEvent } = await import("@/lib/observability");
      return captureOperationalEvent(event);
    });
    this.resolveCredential = options.resolveCredential ?? defaultCredentialResolver;
    this.now = options.now ?? Date.now;
  }

  private async emitTelemetry(event: OperationalEvent): Promise<void> {
    try {
      await this.captureTelemetry(event);
    } catch {
      // Execution truth does not depend on the telemetry sink.
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
    if (
      !SUPPORTED_CAPABILITY_VERSIONS.has(
        `${request.envelope.capabilityId}@${request.envelope.capabilityVersion}`,
      )
    ) {
      return {
        ok: false,
        errorCategory: "DELEGATED_UNSUPPORTED_CAPABILITY",
        retryable: false,
      };
    }

    let configuration: ReturnType<typeof runnerConfiguration>;
    try {
      configuration = runnerConfiguration();
    } catch (error) {
      const normalized = error instanceof DelegatedExecutionError
        ? error
        : new DelegatedExecutionError("DELEGATED_DISABLED", false);
      return { ok: false, errorCategory: normalized.category, retryable: normalized.retryable };
    }

    let credential: Buffer | null = null;
    const startedAt = this.now();
    const telemetry = telemetryContext(request);
    try {
      credential = await this.resolveCredential(request);
      if (!Buffer.isBuffer(credential) || credential.length === 0) {
        throw new DelegatedExecutionError("DELEGATED_AUTH_FAILED", false);
      }
      const binding: ConnectorRunnerCapsuleBinding = {
        protocolVersion: CONNECTOR_RUNNER_PROTOCOL_VERSION,
        requestId: request.envelope.requestId,
        executionId: request.envelope.executionId,
        workflowVersionId: request.envelope.workflowVersionId,
        stepId: request.envelope.stepId,
        capabilityId: request.envelope.capabilityId,
        capabilityVersion: request.envelope.capabilityVersion,
      };
      const credentialCapsule = createConnectorRunnerCredentialCapsule({
        credential,
        binding,
        keyVersion: configuration.keyVersion,
        wrapKey: configuration.wrapKey,
        now: startedAt,
      });
      const runnerEnvelope: ConnectorRunnerRequestEnvelope = {
        ...binding,
        mode: request.envelope.mode,
        idempotencyKey: request.envelope.idempotencyKey,
        input: request.envelope.input,
        credentialCapsule,
      };
      const body = JSON.stringify(runnerEnvelope);
      if (new TextEncoder().encode(body).byteLength > CONNECTOR_RUNNER_MAX_REQUEST_BYTES) {
        throw new DelegatedExecutionError("DELEGATED_EXECUTION_FAILED", false);
      }
      const bodyDigest = createConnectorRunnerBodyDigest(body);
      const timestamp = String(startedAt);
      const signature = createConnectorRunnerSignature({
        secret: configuration.secret,
        timestamp,
        requestId: request.envelope.requestId,
        bodyDigest,
      });
      await this.emitTelemetry({
        level: "info",
        event: "connector_runner_request_started",
        ...telemetry,
        status: "started",
        metadata: { executor: this.kind, protocolVersion: CONNECTOR_RUNNER_PROTOCOL_VERSION },
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
        const bytes = await readBoundedResponse(response);
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          if (!response.ok) throw statusFailure(response.status);
          throw new DelegatedExecutionError("DELEGATED_BAD_RESPONSE", false);
        }
        let result: CapabilityExecutionResult;
        try {
          result = validateRunnerResponse(parsed, request.envelope.requestId);
        } catch (error) {
          if (!response.ok && error instanceof DelegatedExecutionError) {
            throw statusFailure(response.status);
          }
          throw error;
        }
        const durationMs = Math.max(0, this.now() - startedAt);
        if (!result.ok) {
          await this.emitTelemetry({
            level: "warn",
            event: "connector_runner_request_failed",
            ...telemetry,
            durationMs,
            status: "failed",
            errorCategory: result.errorCategory,
            metadata: {
              executor: this.kind,
              retryable: result.retryable,
              protocolVersion: CONNECTOR_RUNNER_PROTOCOL_VERSION,
            },
          });
          return result;
        }
        await this.emitTelemetry({
          level: "info",
          event: "connector_runner_request_succeeded",
          ...telemetry,
          durationMs,
          status: "succeeded",
          metadata: { executor: this.kind, protocolVersion: CONNECTOR_RUNNER_PROTOCOL_VERSION },
        });
        return result;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      const normalized = error instanceof DelegatedExecutionError
        ? error
        : error instanceof DelegatedCredentialError
          ? new DelegatedExecutionError("DELEGATED_AUTH_FAILED", false)
        : error instanceof ConnectorRunnerProtocolError
          ? new DelegatedExecutionError("DELEGATED_DISABLED", false)
          : error instanceof Error && error.name === "AbortError"
            ? new DelegatedExecutionError("DELEGATED_TIMEOUT", true)
            : new DelegatedExecutionError("DELEGATED_CONNECTION_FAILED", true);
      await this.emitTelemetry({
        level: "warn",
        event: "connector_runner_request_failed",
        ...telemetry,
        durationMs: Math.max(0, this.now() - startedAt),
        status: "failed",
        errorCategory: normalized.category,
        metadata: {
          executor: this.kind,
          retryable: normalized.retryable,
          protocolVersion: CONNECTOR_RUNNER_PROTOCOL_VERSION,
        },
      });
      return { ok: false, errorCategory: normalized.category, retryable: normalized.retryable };
    } finally {
      credential?.fill(0);
      configuration.wrapKey.fill(0);
    }
  }
}
