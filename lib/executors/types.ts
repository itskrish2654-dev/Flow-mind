export type ExecutorKind = "native" | "activepieces" | "connector_runner";

export const DELEGATED_ERROR_CATEGORIES = [
  "DELEGATED_DISABLED",
  "DELEGATED_AUTH_FAILED",
  "DELEGATED_CONNECTION_FAILED",
  "DELEGATED_TIMEOUT",
  "DELEGATED_BAD_RESPONSE",
  "DELEGATED_RATE_LIMITED",
  "DELEGATED_UNAVAILABLE",
  "DELEGATED_EXECUTION_FAILED",
  "DELEGATED_CAPSULE_REJECTED",
  "DELEGATED_REPLAYED",
  "DELEGATED_REPLAY_UNAVAILABLE",
  "DELEGATED_UNSUPPORTED_CAPABILITY",
] as const;

export type DelegatedErrorCategory = (typeof DELEGATED_ERROR_CATEGORIES)[number];
export type DelegatedExecutionMode = "TEST" | "LIVE";

export type CapabilityExecutorSelection = {
  kind: ExecutorKind;
  capabilityVersion: number;
};

export type CapabilityExecutionEnvelope = {
  protocolVersion: 1;
  requestId: string;
  executionId: string;
  workflowVersionId: string;
  stepId: string;
  capabilityId: string;
  capabilityVersion: number;
  mode: DelegatedExecutionMode;
  idempotencyKey: string;
  input: Record<string, unknown>;
};

/** Ownership context is intentionally not part of the serialized bridge envelope. */
export type CapabilityExecutionRequest = {
  envelope: CapabilityExecutionEnvelope;
  authenticatedUserId: string;
  workflowOwnerId: string;
  /** Server-only lookup context. It is never serialized into an executor envelope. */
  credentialReference?: {
    connectionId: string;
    connectorId: string;
  };
};

export type CapabilityExecutionResult =
  | {
      ok: true;
      acknowledged: true;
      output: Record<string, unknown>;
    }
  | {
      ok: false;
      errorCategory: DelegatedErrorCategory;
      retryable: boolean;
    };

export interface CapabilityExecutor {
  readonly kind: ExecutorKind;
  execute(request: CapabilityExecutionRequest): Promise<CapabilityExecutionResult>;
}

export class DelegatedExecutionError extends Error {
  readonly category: DelegatedErrorCategory;
  readonly retryable: boolean;

  constructor(category: DelegatedErrorCategory, retryable: boolean) {
    super("This app is temporarily unavailable.");
    this.name = "DelegatedExecutionError";
    this.category = category;
    this.retryable = retryable;
  }
}
