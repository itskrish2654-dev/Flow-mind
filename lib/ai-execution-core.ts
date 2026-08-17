export type AiProviderResult = {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
};

export type AiExecutionMetadata = {
  provider: string;
  model: string;
  durationMs: number;
  inputCharacters: number;
  outputCharacters: number;
  maxOutputTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
};

export type AiExecutionErrorCode =
  | "AI_AUTHENTICATION_FAILED"
  | "AI_PERMISSION_DENIED"
  | "AI_INVALID_REQUEST"
  | "AI_INPUT_TOO_LARGE"
  | "AI_RATE_LIMITED"
  | "AI_CAPACITY_EXCEEDED"
  | "AI_PROVIDER_UNAVAILABLE"
  | "AI_PROVIDER_TIMEOUT"
  | "AI_PROVIDER_FAILED";

export type SafeAiProviderDiagnostics = {
  provider: string;
  model: string;
  category: AiExecutionErrorCode;
  httpStatus: number | null;
  providerErrorType: string | null;
  providerErrorCode: string | null;
  providerMessage: string | null;
  requestId: string | null;
  retryAfterMs: number | null;
  rateLimit: {
    limitRequests: string | null;
    remainingRequests: string | null;
    resetRequests: string | null;
    limitTokens: string | null;
    remainingTokens: string | null;
    resetTokens: string | null;
  };
  durationMs: number;
  inputCharacters: number;
  inputTokenEstimate: number;
  maxOutputTokens: number;
};

export class AiExecutionError extends Error {
  constructor(
    message: string,
    public readonly code: AiExecutionErrorCode,
    public readonly diagnostics?: SafeAiProviderDiagnostics,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AiExecutionError";
  }
}

export type AiTextExecutor = (input: {
  instruction: string;
  content: string;
}) => Promise<{ text: string; metadata: AiExecutionMetadata }>;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function finiteStatus(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

function safeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().slice(0, 100);
  return normalized && /^[a-z0-9_.:/-]+$/i.test(normalized) ? normalized : null;
}

export function sanitizeAiProviderMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sanitized = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:gsk|sk|sb_secret)_[A-Za-z0-9_-]+\b/gi, "[REDACTED_SECRET]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/https?:\/\/\S+/gi, "[REDACTED_URL]")
    .replace(/(["'`])([^"'`]{24,})\1/g, "$1[REDACTED_VALUE]$1")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 240);
  return sanitized || null;
}

function parseResponseBody(value: unknown): UnknownRecord | null {
  if (typeof value !== "string" || value.length > 20_000) return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function normalizedHeaders(value: unknown): Record<string, string> {
  const source = record(value);
  if (!source) return {};
  return Object.fromEntries(
    Object.entries(source).flatMap(([key, item]) =>
      typeof item === "string" ? [[key.toLowerCase(), item] as const] : []),
  );
}

function retryAfterMs(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function providerPayload(error: UnknownRecord): UnknownRecord | null {
  const body = parseResponseBody(error.responseBody);
  const bodyError = record(body?.error);
  if (bodyError) return bodyError;
  const data = record(error.data);
  return record(data?.error) ?? data;
}

function categoryForProviderFailure(
  status: number | null,
  providerCode: string | null,
  error: unknown,
): { code: AiExecutionErrorCode; retryable: boolean; message: string } {
  const source = record(error);
  const name = typeof source?.name === "string" ? source.name.toLowerCase() : "";
  const message = typeof source?.message === "string" ? source.message.toLowerCase() : "";
  if (name === "aborterror" || /timed?\s*out|timeout/.test(message)) {
    return {
      code: "AI_PROVIDER_TIMEOUT",
      retryable: true,
      message: "The AI service did not respond in time. Your completed steps have been preserved.",
    };
  }
  if (status === 401) {
    return {
      code: "AI_AUTHENTICATION_FAILED",
      retryable: false,
      message: "The AI service needs attention from CrazyLoops. Your workflow has been stopped safely.",
    };
  }
  if (status === 403 || (status === 404 && providerCode === "model_not_found")) {
    return {
      code: "AI_PERMISSION_DENIED",
      retryable: false,
      message: "The AI service needs attention from CrazyLoops. Your workflow has been stopped safely.",
    };
  }
  if (status === 413) {
    return {
      code: "AI_INPUT_TOO_LARGE",
      retryable: false,
      message: "This step contains more content than the AI service can process.",
    };
  }
  if (status === 400 || status === 404 || status === 422) {
    return {
      code: "AI_INVALID_REQUEST",
      retryable: false,
      message: "The AI service rejected this step. Your workflow has been stopped safely.",
    };
  }
  if (status === 429) {
    return {
      code: "AI_RATE_LIMITED",
      retryable: true,
      message: "AI is temporarily busy. CrazyLoops can retry this step.",
    };
  }
  if (status === 498) {
    return {
      code: "AI_CAPACITY_EXCEEDED",
      retryable: true,
      message: "The AI service is temporarily unavailable. Your completed steps have been preserved.",
    };
  }
  if (status === 500 || status === 502 || status === 503) {
    return {
      code: "AI_PROVIDER_UNAVAILABLE",
      retryable: true,
      message: "The AI service is temporarily unavailable. Your completed steps have been preserved.",
    };
  }
  if (status === null && (name === "typeerror" || /fetch|network|econn|enotfound|socket/.test(message))) {
    return {
      code: "AI_PROVIDER_UNAVAILABLE",
      retryable: true,
      message: "The AI service is temporarily unavailable. Your completed steps have been preserved.",
    };
  }
  return {
    code: "AI_PROVIDER_FAILED",
    retryable: false,
    message: "The AI provider could not complete this step.",
  };
}

export function normalizeAiProviderError(
  error: unknown,
  context: {
    provider: string;
    model: string;
    durationMs: number;
    inputCharacters: number;
    maxOutputTokens: number;
  },
): AiExecutionError {
  if (error instanceof AiExecutionError) return error;
  const source = record(error) ?? {};
  const payload = providerPayload(source);
  const status = finiteStatus(source.statusCode ?? source.status);
  const providerType = safeIdentifier(payload?.type ?? source.type);
  const providerCode = safeIdentifier(payload?.code ?? source.code);
  const classification = categoryForProviderFailure(status, providerCode, error);
  const headers = normalizedHeaders(source.responseHeaders ?? source.headers);
  const diagnostics: SafeAiProviderDiagnostics = {
    provider: context.provider,
    model: context.model,
    category: classification.code,
    httpStatus: status,
    providerErrorType: providerType,
    providerErrorCode: providerCode,
    providerMessage: sanitizeAiProviderMessage(payload?.message ?? source.message),
    requestId: safeIdentifier(headers["x-request-id"] ?? headers["request-id"] ?? headers["cf-ray"]),
    retryAfterMs: retryAfterMs(headers["retry-after"]),
    rateLimit: {
      limitRequests: safeIdentifier(headers["x-ratelimit-limit-requests"]),
      remainingRequests: safeIdentifier(headers["x-ratelimit-remaining-requests"]),
      resetRequests: safeIdentifier(headers["x-ratelimit-reset-requests"]),
      limitTokens: safeIdentifier(headers["x-ratelimit-limit-tokens"]),
      remainingTokens: safeIdentifier(headers["x-ratelimit-remaining-tokens"]),
      resetTokens: safeIdentifier(headers["x-ratelimit-reset-tokens"]),
    },
    durationMs: context.durationMs,
    inputCharacters: context.inputCharacters,
    inputTokenEstimate: Math.max(1, Math.ceil(context.inputCharacters / 4)),
    maxOutputTokens: context.maxOutputTokens,
  };
  return new AiExecutionError(
    classification.message,
    classification.code,
    diagnostics,
    classification.retryable,
  );
}

export function getSafeAiProviderDiagnostics(error: unknown): SafeAiProviderDiagnostics | null {
  return error instanceof AiExecutionError ? error.diagnostics ?? null : null;
}

export function createAiTextExecutor({
  provider,
  model,
  timeoutMs,
  maxInputCharacters,
  maxOutputTokens,
  runModel,
}: {
  provider: string;
  model: string;
  timeoutMs: number;
  maxInputCharacters: number;
  maxOutputTokens: number;
  runModel: (input: {
    instruction: string;
    content: string;
    signal: AbortSignal;
    maxOutputTokens: number;
  }) => Promise<AiProviderResult>;
}): AiTextExecutor {
  return async ({ instruction, content }) => {
    const combinedLength = instruction.length + content.length;
    if (combinedLength > maxInputCharacters) {
      throw new AiExecutionError(
        `This step contains more than ${maxInputCharacters.toLocaleString()} characters, which exceeds the AI input limit.`,
        "AI_INPUT_TOO_LARGE",
        {
          provider,
          model,
          category: "AI_INPUT_TOO_LARGE",
          httpStatus: null,
          providerErrorType: null,
          providerErrorCode: null,
          providerMessage: null,
          requestId: null,
          retryAfterMs: null,
          rateLimit: {
            limitRequests: null,
            remainingRequests: null,
            resetRequests: null,
            limitTokens: null,
            remainingTokens: null,
            resetTokens: null,
          },
          durationMs: 0,
          inputCharacters: combinedLength,
          inputTokenEstimate: Math.max(1, Math.ceil(combinedLength / 4)),
          maxOutputTokens,
        },
        false,
      );
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("AI provider request timed out."));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        runModel({ instruction, content, signal: controller.signal, maxOutputTokens }),
        timeoutPromise,
      ]);
      const text = result.text.trim();
      if (!text) {
        throw new AiExecutionError(
          "The AI provider could not complete this step.",
          "AI_PROVIDER_FAILED",
          {
            provider,
            model,
            category: "AI_PROVIDER_FAILED",
            httpStatus: null,
            providerErrorType: "empty_output",
            providerErrorCode: null,
            providerMessage: null,
            requestId: null,
            retryAfterMs: null,
            rateLimit: {
              limitRequests: null,
              remainingRequests: null,
              resetRequests: null,
              limitTokens: null,
              remainingTokens: null,
              resetTokens: null,
            },
            durationMs: Date.now() - startedAt,
            inputCharacters: combinedLength,
            inputTokenEstimate: Math.max(1, Math.ceil(combinedLength / 4)),
            maxOutputTokens,
          },
          false,
        );
      }
      return {
        text,
        metadata: {
          provider,
          model,
          durationMs: Date.now() - startedAt,
          inputCharacters: combinedLength,
          outputCharacters: text.length,
          maxOutputTokens,
          inputTokens: result.inputTokens ?? null,
          outputTokens: result.outputTokens ?? null,
        },
      };
    } catch (error: unknown) {
      if (error instanceof AiExecutionError) throw error;
      const normalized = normalizeAiProviderError(
        timedOut ? new DOMException("AI provider request timed out.", "AbortError") : error,
        {
          provider,
          model,
          durationMs: Date.now() - startedAt,
          inputCharacters: combinedLength,
          maxOutputTokens,
        },
      );
      throw normalized;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}
