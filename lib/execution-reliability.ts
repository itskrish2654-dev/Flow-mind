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
  | "unknown";

export type ClassifiedExecutionError = {
  category: ExecutionErrorCategory;
  retryable: boolean;
  safeMessage: string;
};

export function classifyExecutionError(error: unknown): ClassifiedExecutionError {
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
  options: { maxAttempts?: number; baseDelayMs?: number; classify?: typeof classifyExecutionError } = {},
): Promise<T> {
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 2, 3));
  const baseDelayMs = Math.max(0, Math.min(options.baseDelayMs ?? 150, 2_000));
  const classify = options.classify ?? classifyExecutionError;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!classify(error).retryable || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
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
