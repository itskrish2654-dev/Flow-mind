import { AiExecutionError } from "@/lib/ai-execution-core";
import { FormatterError } from "@/lib/formatter";
import { ConnectorError } from "@/lib/connectors/errors";
import type { HttpErrorCode } from "@/lib/http-request";

export type ExecutionErrorCategory =
  | "timeout"
  | "provider_rate_limit"
  | "provider_unavailable"
  | "transient_storage"
  | "interrupted"
  | "invalid_workflow"
  | "unsupported_capability"
  | "invalid_credentials"
  | "authorization"
  | "invalid_input"
  | "invalid_destination"
  | "ambiguous_external_result"
  | "AI_AUTHENTICATION_FAILED"
  | "AI_PERMISSION_DENIED"
  | "AI_INVALID_REQUEST"
  | "AI_INPUT_TOO_LARGE"
  | "AI_RATE_LIMITED"
  | "AI_CAPACITY_EXCEEDED"
  | "AI_PROVIDER_UNAVAILABLE"
  | "AI_PROVIDER_TIMEOUT"
  | "AI_PROVIDER_FAILED"
  | "FORMATTER_INVALID_INPUT"
  | "FORMATTER_INVALID_NUMBER"
  | "FORMATTER_DIVISION_BY_ZERO"
  | "FORMATTER_INVALID_DATE"
  | "FORMATTER_TIMEZONE_REQUIRED"
  | "FORMATTER_OUTPUT_TOO_LARGE"
  | HttpErrorCode
  | "unknown";

export type ClassifiedExecutionError = {
  category: ExecutionErrorCategory;
  retryable: boolean;
  safeMessage: string;
  retryAfterMs?: number;
};

export function classifyExecutionError(error: unknown): ClassifiedExecutionError {
  if (error instanceof AiExecutionError) {
    return {
      category: error.code,
      retryable: error.retryable,
      safeMessage: error.message,
      ...(error.diagnostics?.retryAfterMs !== null && error.diagnostics?.retryAfterMs !== undefined
        ? { retryAfterMs: error.diagnostics.retryAfterMs }
        : {}),
    };
  }
  if (error instanceof FormatterError) {
    return {
      category: error.code,
      retryable: false,
      safeMessage: error.message,
    };
  }
  if (error instanceof ConnectorError) {
    return {
      category: error.details.code as ExecutionErrorCategory,
      retryable: error.details.retryable,
      safeMessage: error.details.message,
      ...(error.details.retryAfterMs !== undefined ? { retryAfterMs: error.details.retryAfterMs } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (/ambiguous external result|acknowledgement was not received/.test(normalized)) {
    return { category: "ambiguous_external_result", retryable: false, safeMessage: "The provider result is unknown; automatic retry is unsafe." };
  }

  if (/timed? ?out|aborterror/.test(normalized)) {
    return { category: "timeout", retryable: true, safeMessage: "The provider timed out." };
  }
  if (/429|rate.?limit|too many requests/.test(normalized)) {
    return { category: "provider_rate_limit", retryable: true, safeMessage: "The provider temporarily rate limited the request." };
  }
  if (/\b5\d\d\b|temporar|unavailable|econnreset|enotfound/.test(normalized)) {
    return { category: "provider_unavailable", retryable: true, safeMessage: "The provider is temporarily unavailable." };
  }
  if (/storage|upload failed|database.*not.*commit/.test(normalized)) {
    return { category: "transient_storage", retryable: true, safeMessage: "Storage is temporarily unavailable." };
  }
  if (/credential|api key|unauthenticated/.test(normalized)) {
    return { category: "invalid_credentials", retryable: false, safeMessage: "The provider credentials need attention." };
  }
  if (/unauthorized|forbidden|permission/.test(normalized)) {
    return { category: "authorization", retryable: false, safeMessage: "The operation is not authorized." };
  }
  if (/unsupported|no execution implementation/.test(normalized)) {
    return { category: "unsupported_capability", retryable: false, safeMessage: "This capability is not supported." };
  }
  if (/destination|webhook url|private network/.test(normalized)) {
    return { category: "invalid_destination", retryable: false, safeMessage: "The destination configuration is invalid." };
  }
  if (/invalid|malformed|required/.test(normalized)) {
    return { category: "invalid_input", retryable: false, safeMessage: "The execution input is invalid." };
  }
  return { category: "unknown", retryable: false, safeMessage: "The step failed and needs review." };
}

export async function withBoundedRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    classify?: typeof classifyExecutionError;
  } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 2, 3));
  const baseDelayMs = Math.max(0, Math.min(options.baseDelayMs ?? 150, 2_000));
  const maxDelayMs = Math.max(0, Math.min(options.maxDelayMs ?? 5_000, 10_000));
  const classify = options.classify ?? classifyExecutionError;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const classification = classify(error);
      if (!classification.retryable || attempt === maxAttempts) throw error;
      const delayMs = Math.max(
        baseDelayMs * 2 ** (attempt - 1),
        classification.retryAfterMs ?? 0,
      );
      // A long provider cooldown should be honored by a later durable retry,
      // not by keeping a serverless request open or retrying too soon.
      if (delayMs > maxDelayMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export function deriveExecutionStatus(statuses: string[]):
  | "succeeded"
  | "partially_failed"
  | "failed" {
  const succeeded = statuses.some((status) => status === "succeeded");
  const failed = statuses.some((status) => ["failed", "skipped", "unsupported"].includes(status));
  return failed ? (succeeded ? "partially_failed" : "failed") : "succeeded";
}
