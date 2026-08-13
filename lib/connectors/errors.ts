import type { ConnectorErrorShape } from "@/lib/connectors/types";

export class ConnectorError extends Error {
  constructor(public readonly details: ConnectorErrorShape) {
    super(details.message);
    this.name = "ConnectorError";
  }
}

export function classifyConnectorHttpFailure(status: number, retryAfter?: string | null): ConnectorErrorShape {
  const retryAfterSeconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
  if (status === 401) return { category: "authentication", code: "PROVIDER_UNAUTHENTICATED", message: "The connector must be reconnected.", retryable: false };
  if (status === 403) return { category: "authorization", code: "PROVIDER_FORBIDDEN", message: "The connection does not have permission for this action.", retryable: false };
  if (status === 429) return { category: "rate_limit", code: "PROVIDER_RATE_LIMITED", message: "The provider rate limit was reached.", retryable: true, ...(retryAfterSeconds !== null ? { retryAfterMs: retryAfterSeconds * 1_000 } : {}) };
  if (status >= 500) return { category: "provider_unavailable", code: "PROVIDER_UNAVAILABLE", message: "The provider temporarily rejected the request.", retryable: true };
  return { category: "validation", code: "PROVIDER_REJECTED", message: `The provider rejected the request with status ${status}.`, retryable: false };
}

export function ambiguousAcknowledgement(message = "The provider response was not received; delivery may have happened."): ConnectorErrorShape {
  return { category: "ambiguous_acknowledgement", code: "AMBIGUOUS_ACKNOWLEDGEMENT", message, retryable: false };
}
