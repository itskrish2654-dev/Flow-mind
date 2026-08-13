import type { z } from "zod";

export const CONNECTOR_STATUSES = ["AVAILABLE", "BETA", "INTERNAL", "COMING_SOON"] as const;
export const AUTH_TYPES = ["none", "api_key", "oauth2"] as const;
export const OPERATION_KINDS = ["trigger", "action"] as const;

export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];
export type ConnectorAuthType = (typeof AUTH_TYPES)[number];
export type ConnectorOperationKind = (typeof OPERATION_KINDS)[number];

export type CommonValueType =
  | "string"
  | "number"
  | "boolean"
  | "email"
  | "url"
  | "datetime"
  | "object"
  | "array"
  | "binary";

export type ConnectorField = {
  key: string;
  label: string;
  type: CommonValueType;
  required?: boolean;
  description?: string;
  sensitive?: boolean;
};

export type ConnectorAuthDefinition = {
  type: ConnectorAuthType;
  authorizationUrl?: string;
  tokenUrl?: string;
  defaultScopes: string[];
  pkceRequired: boolean;
};

export type ConnectorOperation = {
  key: string;
  version: number;
  kind: ConnectorOperationKind;
  displayName: string;
  description: string;
  input: ConnectorField[];
  output: ConnectorField[];
  requiredScopes: string[];
  connectionRequired: boolean;
  testMode: boolean;
  production: boolean;
  deliverySemantics?: "internal" | "acknowledged_external" | "trigger";
};

export type ConnectorManifest = {
  id: string;
  providerFamily: string;
  displayName: string;
  description: string;
  status: ConnectorStatus;
  version: number;
  auth: ConnectorAuthDefinition;
  triggers: ConnectorOperation[];
  actions: ConnectorOperation[];
  limitations: string[];
  documentationUrl?: string;
};

export type NormalizedConnectorEvent = {
  eventId: string;
  connectorId: string;
  operationKey: string;
  operationVersion: number;
  occurredAt: string;
  receivedAt: string;
  accountId?: string;
  data: Record<string, unknown>;
  metadata: Record<string, string | number | boolean | null>;
};

export type ConnectorActionContext = {
  userId: string;
  workflowId: string;
  executionId: string;
  stepId: string;
  connectionId?: string;
  idempotencyKey: string;
  signal?: AbortSignal;
};

export type ConnectorActionResult = {
  status: "succeeded" | "failed" | "ambiguous";
  acknowledged: boolean;
  externallyDelivered: boolean;
  providerReferenceId?: string;
  output: Record<string, unknown>;
  metadata: Record<string, string | number | boolean | null>;
  error?: ConnectorErrorShape;
};

export type ConnectorActionHandler = (
  input: Record<string, unknown>,
  context: ConnectorActionContext,
) => Promise<ConnectorActionResult>;

export type ConnectorTriggerAdapter = {
  verify: (request: Request, rawBody: Uint8Array, secret?: string) => Promise<boolean>;
  normalize: (
    request: Request,
    payload: unknown,
    operation: ConnectorOperation,
  ) => Promise<NormalizedConnectorEvent>;
};

export type ConnectorRuntime = {
  actionHandlers: Record<string, ConnectorActionHandler>;
  triggerHandlers: Record<string, ConnectorTriggerAdapter>;
};

export type RegisteredConnector = {
  manifest: ConnectorManifest;
  runtime: ConnectorRuntime;
};

export type ConnectorErrorCategory =
  | "authentication"
  | "authorization"
  | "validation"
  | "rate_limit"
  | "timeout"
  | "provider_unavailable"
  | "ambiguous_acknowledgement"
  | "unsupported"
  | "internal";

export type ConnectorErrorShape = {
  category: ConnectorErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
};

export type SchemaValidator = z.ZodType<Record<string, unknown>>;
