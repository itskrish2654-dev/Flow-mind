import "server-only";

import { captureOperationalEvent } from "@/lib/observability";
import { readCredential } from "@/lib/security/credential-vault";
import {
  SECURITY_LIMITS,
  SecurityGateError,
  enforceRateLimit,
} from "@/lib/security/limits";
import {
  HTTP_AUTH_TYPES,
  HTTP_METHODS,
  HttpRequestError,
  executeTrustedHttpRequest,
  parseJsonBody,
  parseStructuredPairs,
  type HttpAuthType,
  type HttpMethod,
} from "@/lib/http-request";
import type {
  ConnectorActionContext,
  ConnectorActionResult,
} from "@/lib/connectors/types";

function errorCategory(error: HttpRequestError) {
  if (error.options.ambiguous) return "ambiguous_acknowledgement" as const;
  if (error.code === "HTTP_UNAUTHORIZED") return "authentication" as const;
  if (error.code === "HTTP_FORBIDDEN") return "authorization" as const;
  if (error.code === "HTTP_RATE_LIMITED") return "rate_limit" as const;
  if (error.code === "HTTP_TIMEOUT") return "timeout" as const;
  if (["HTTP_CONNECTION_FAILED", "HTTP_DNS_FAILED", "HTTP_SERVER_ERROR", "HTTP_PROVIDER_FAILED"].includes(error.code)) return "provider_unavailable" as const;
  return "validation" as const;
}

function statusCategory(status: number): string {
  return status >= 500 ? "5xx" : status >= 400 ? "4xx" : status >= 300 ? "3xx" : "2xx";
}

export async function executeHttpConnectorRequest(
  input: Record<string, unknown>,
  context: ConnectorActionContext,
): Promise<ConnectorActionResult> {
  const method = String(input.method ?? "").toUpperCase() as HttpMethod;
  const authType = String(input.authType ?? "none") as HttpAuthType;
  const startedAt = Date.now();
  if (!HTTP_METHODS.includes(method) || !HTTP_AUTH_TYPES.includes(authType)) {
    return {
      status: "failed", acknowledged: false, externallyDelivered: false, output: {}, metadata: {},
      error: { category: "validation", code: "HTTP_CLIENT_ERROR", message: "The HTTP request configuration is invalid.", retryable: false },
    };
  }
  try {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(String(input.url ?? ""));
    } catch {
      throw new HttpRequestError("HTTP_INVALID_URL", "The API URL is invalid.", false);
    }
    await enforceRateLimit("http-request-user", [context.userId], SECURITY_LIMITS.webhookUser);
    await enforceRateLimit("http-request-destination", [parsedUrl.hostname.toLowerCase()], SECURITY_LIMITS.webhookDestination);
    let secret: string | undefined;
    if (authType !== "none") {
      try {
        secret = await readCredential({
          userId: context.userId,
          workflowId: context.workflowId,
          connectorId: "http.request",
          credentialKey: "auth_secret",
        });
      } catch {
        throw new HttpRequestError("HTTP_UNAUTHORIZED", "HTTP authentication is not configured.", false);
      }
    }
    await captureOperationalEvent({
      level: "info",
      event: "http_request_started",
      userId: context.userId,
      workflowId: context.workflowId,
      executionId: context.executionId,
      stepId: context.stepId,
      capability: "http.request",
      status: "running",
      metadata: { method },
    });
    const response = await executeTrustedHttpRequest({
      url: parsedUrl.toString(),
      method,
      query: parseStructuredPairs(input.query),
      headers: parseStructuredPairs(input.headers),
      body: parseJsonBody(input.body),
      timeoutMs: Number(input.timeoutMs) || undefined,
      auth: {
        type: authType,
        ...(secret ? { secret } : {}),
        ...(typeof input.authUsername === "string" ? { username: input.authUsername } : {}),
        ...(typeof input.authName === "string" ? { name: input.authName } : {}),
      },
      idempotencyKey: context.idempotencyKey,
      ...(input.idempotencyHeader === "Idempotency-Key" || input.idempotencyHeader === "X-Idempotency-Key"
        ? { idempotencyHeader: input.idempotencyHeader }
        : {}),
      allowDeleteBody: input.allowDeleteBody === true || input.allowDeleteBody === "true",
    });
    const jsonFields = response.json && typeof response.json === "object" && !Array.isArray(response.json)
      ? response.json as Record<string, unknown>
      : {};
    await captureOperationalEvent({
      level: "info",
      event: "http_request_succeeded",
      userId: context.userId,
      workflowId: context.workflowId,
      executionId: context.executionId,
      stepId: context.stepId,
      capability: "http.request",
      durationMs: response.durationMs,
      status: "succeeded",
      metadata: { method, statusCategory: statusCategory(response.status), retryable: false },
    });
    return {
      status: "succeeded",
      acknowledged: true,
      externallyDelivered: method !== "GET",
      providerReferenceId: response.requestId,
      output: { ...jsonFields, method, ...response },
      metadata: {
        method,
        durationMs: response.durationMs,
        httpStatus: response.status,
        statusCategory: statusCategory(response.status),
        retryable: false,
      },
    };
  } catch (unknownError) {
    const error = unknownError instanceof HttpRequestError
      ? unknownError
      : unknownError instanceof SecurityGateError && unknownError.code === "RATE_LIMITED"
        ? new HttpRequestError("HTTP_RATE_LIMITED", "CrazyLoops temporarily limited requests to this API.", true)
      : unknownError instanceof SecurityGateError
        ? new HttpRequestError("HTTP_PROVIDER_FAILED", "The HTTP security gate is temporarily unavailable.", true)
      : new HttpRequestError("HTTP_CONNECTION_FAILED", "The API connection failed.", false);
    await captureOperationalEvent({
      level: "error",
      event: "http_request_failed",
      userId: context.userId,
      workflowId: context.workflowId,
      executionId: context.executionId,
      stepId: context.stepId,
      capability: "http.request",
      durationMs: Date.now() - startedAt,
      status: error.options.ambiguous ? "ambiguous" : "failed",
      errorCategory: error.code,
      metadata: { method, retryable: error.retryable },
    });
    return {
      status: error.options.ambiguous ? "ambiguous" : "failed",
      acknowledged: false,
      externallyDelivered: false,
      output: error.options.status ? { status: error.options.status } : {},
      metadata: {
        method,
        retryable: error.retryable,
        ...(error.options.status ? { httpStatus: error.options.status } : {}),
        ...(error.options.retryAfterMs !== undefined ? { retryAfterMs: error.options.retryAfterMs } : {}),
      },
      error: {
        category: errorCategory(error),
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.options.retryAfterMs !== undefined ? { retryAfterMs: error.options.retryAfterMs } : {}),
      },
    };
  }
}
