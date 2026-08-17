import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AiExecutionError,
  createAiTextExecutor,
  normalizeAiProviderError,
  sanitizeAiProviderMessage,
  type AiExecutionErrorCode,
} from "../lib/ai-execution-core";
import { classifyExecutionError, withBoundedRetry } from "../lib/execution-reliability";

const context = {
  provider: "groq",
  model: "openai/gpt-oss-20b",
  durationMs: 321,
  inputCharacters: 120,
  maxOutputTokens: 1_000,
};

function providerError(
  statusCode: number,
  type: string,
  code: string | null,
  message = "Provider rejected the request.",
  responseHeaders: Record<string, string> = {},
) {
  const error = new Error(message) as Error & {
    statusCode: number;
    responseHeaders: Record<string, string>;
    responseBody: string;
    data: { error: { message: string; type: string; code?: string } };
  };
  error.statusCode = statusCode;
  error.responseHeaders = responseHeaders;
  error.responseBody = JSON.stringify({ error: { message, type, ...(code ? { code } : {}) } });
  error.data = { error: { message, type, ...(code ? { code } : {}) } };
  return error;
}

const cases: Array<{
  status: number;
  code: string | null;
  expected: AiExecutionErrorCode;
  retryable: boolean;
  copy: RegExp;
}> = [
  { status: 400, code: "invalid_request", expected: "AI_INVALID_REQUEST", retryable: false, copy: /rejected this step/i },
  { status: 401, code: "invalid_api_key", expected: "AI_AUTHENTICATION_FAILED", retryable: false, copy: /needs attention/i },
  { status: 403, code: "permission_denied", expected: "AI_PERMISSION_DENIED", retryable: false, copy: /needs attention/i },
  { status: 413, code: "request_too_large", expected: "AI_INPUT_TOO_LARGE", retryable: false, copy: /more content/i },
  { status: 422, code: "unprocessable_entity", expected: "AI_INVALID_REQUEST", retryable: false, copy: /rejected this step/i },
  { status: 429, code: "rate_limit_exceeded", expected: "AI_RATE_LIMITED", retryable: true, copy: /temporarily busy/i },
  { status: 498, code: "capacity_exceeded", expected: "AI_CAPACITY_EXCEEDED", retryable: true, copy: /temporarily unavailable/i },
  { status: 500, code: "internal_error", expected: "AI_PROVIDER_UNAVAILABLE", retryable: true, copy: /temporarily unavailable/i },
  { status: 502, code: "bad_gateway", expected: "AI_PROVIDER_UNAVAILABLE", retryable: true, copy: /temporarily unavailable/i },
  { status: 503, code: "unavailable", expected: "AI_PROVIDER_UNAVAILABLE", retryable: true, copy: /temporarily unavailable/i },
  { status: 404, code: "model_not_found", expected: "AI_PERMISSION_DENIED", retryable: false, copy: /needs attention/i },
];

for (const item of cases) {
  test(`8A.1 normalizes Groq HTTP ${item.status} as ${item.expected}`, () => {
    const error = normalizeAiProviderError(
      providerError(item.status, "provider_error", item.code),
      context,
    );
    assert.equal(error.code, item.expected);
    assert.equal(error.retryable, item.retryable);
    assert.match(error.message, item.copy);
    assert.equal(error.diagnostics?.httpStatus, item.status);
    assert.equal(error.diagnostics?.providerErrorCode, item.code);
    assert.equal(error.diagnostics?.provider, "groq");
    assert.equal(error.diagnostics?.model, "openai/gpt-oss-20b");
    assert.equal(classifyExecutionError(error).category, item.expected);
    assert.equal(classifyExecutionError(error).retryable, item.retryable);
  });
}

test("8A.1 timeout and network failures are retryable and distinct", async () => {
  const executor = createAiTextExecutor({
    provider: "groq",
    model: "openai/gpt-oss-20b",
    timeoutMs: 5,
    maxInputCharacters: 1_000,
    maxOutputTokens: 20,
    runModel: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { text: "late" };
    },
  });
  await assert.rejects(
    () => executor({ instruction: "Summarize", content: "Safe test input" }),
    (error: unknown) => error instanceof AiExecutionError
      && error.code === "AI_PROVIDER_TIMEOUT"
      && error.retryable,
  );

  const network = normalizeAiProviderError(new TypeError("fetch failed"), context);
  assert.equal(network.code, "AI_PROVIDER_UNAVAILABLE");
  assert.equal(network.retryable, true);
});

test("8A.1 safe diagnostics retain identifiers and limits without prompt or secret leakage", () => {
  const privatePrompt = "PRIVATE_FORM_TEXT_SHOULD_NEVER_APPEAR";
  const secret = "gsk_abcdefghijklmnopqrstuvwxyz123456";
  const error = normalizeAiProviderError(
    providerError(
      429,
      "rate_limit_error",
      "rate_limit_exceeded",
      `Request for user@example.com with Bearer ${secret} and prompt \"${privatePrompt}\" was rejected.`,
      {
        "x-request-id": "req_safe_123",
        "retry-after": "0.001",
        "x-ratelimit-remaining-requests": "0",
        "x-ratelimit-remaining-tokens": "125",
      },
    ),
    context,
  );
  const serialized = JSON.stringify(error.diagnostics);
  assert.equal(error.diagnostics?.requestId, "req_safe_123");
  assert.equal(error.diagnostics?.retryAfterMs, 1);
  assert.equal(error.diagnostics?.rateLimit.remainingRequests, "0");
  assert.equal(error.diagnostics?.inputTokenEstimate, 30);
  assert.doesNotMatch(serialized, /PRIVATE_FORM_TEXT_SHOULD_NEVER_APPEAR/);
  assert.doesNotMatch(serialized, /user@example\.com/);
  assert.doesNotMatch(serialized, /gsk_/);
  assert.doesNotMatch(serialized, /authorization|instruction|content/i);
});

test("8A.1 bounded retry honors a short Retry-After and never retries indefinitely", async () => {
  let attempts = 0;
  const result = await withBoundedRetry(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw normalizeAiProviderError(
        providerError(429, "rate_limit_error", "rate_limit_exceeded", "Busy", { "retry-after": "0.001" }),
        context,
      );
    }
    return "ok";
  }, { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 20 });
  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("8A.1 a long Retry-After is deferred to durable retry instead of hammered inline", async () => {
  let attempts = 0;
  await assert.rejects(() => withBoundedRetry(async () => {
    attempts += 1;
    throw normalizeAiProviderError(
      providerError(429, "rate_limit_error", "rate_limit_exceeded", "Busy", { "retry-after": "60" }),
      context,
    );
  }, { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10 }));
  assert.equal(attempts, 1);
});

test("8A.1 sanitizer removes common secrets, private values, emails, and URLs", () => {
  const value = sanitizeAiProviderMessage(
    "Bearer secret-token user@example.com https://private.example/path 'PRIVATE_FORM_CONTENT_1234567890'",
  );
  assert.doesNotMatch(value ?? "", /secret-token|user@example|private\.example|PRIVATE_FORM_CONTENT/);
});

test("8A.1 TEST and LIVE share one provider executor and the retired model is gone", async () => {
  const [ai, testAction, publicAction, schedule, connector, customize, envExample] = await Promise.all([
    readFile("lib/ai-execution.ts", "utf8"),
    readFile("app/actions/execute.ts", "utf8"),
    readFile("app/f/[projectId]/actions.ts", "utf8"),
    readFile("lib/scheduled-workflows.ts", "utf8"),
    readFile("lib/connectors/webhook-dispatch.ts", "utf8"),
    readFile("app/actions/customize.ts", "utf8"),
    readFile(".env.example", "utf8"),
  ]);
  assert.match(ai, /openai\/gpt-oss-20b/);
  for (const source of [testAction, publicAction, schedule, connector]) {
    assert.match(source, /executeAiText\(/);
  }
  assert.match(customize, /AI_EXECUTION_MODEL/);
  assert.match(envExample, /FLOWMIND_AI_EXECUTION_MODEL=openai\/gpt-oss-20b/);
  assert.doesNotMatch([ai, customize, envExample].join("\n"), /llama-3\.3-70b-versatile/);
});

test("8A.1 retry persists safe diagnostics and preserves completed steps", async () => {
  const [state, action] = await Promise.all([
    readFile("lib/execution-state.ts", "utf8"),
    readFile("app/actions/execute.ts", "utf8"),
  ]);
  assert.match(state, /aiProvider: aiDiagnostics/);
  assert.match(state, /provider_reference_id: result\.providerReferenceId \?\? aiDiagnostics\?\.requestId/);
  assert.match(action, /completedStepIds/);
  assert.match(action, /retryNotBefore/);
  assert.match(action, /existing\.trigger_type === "manual_test"/);
});
