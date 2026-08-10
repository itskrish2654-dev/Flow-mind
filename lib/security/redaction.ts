const SENSITIVE_KEY =
  /authorization|cookie|password|secret|token|api[_-]?key|service[_-]?role|refresh[_-]?token|ciphertext|auth[_-]?tag|nonce/i;

const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

export function redactText(value: string): string {
  return value
    .replace(BEARER_VALUE, "Bearer [REDACTED]")
    .replace(JWT_VALUE, "[REDACTED_JWT]")
    .slice(0, 500);
}

export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[TRUNCATED]";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
    };
  }
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactForLog(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, item]) => [
          key,
          SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactForLog(item, depth + 1),
        ]),
    );
  }
  return value;
}

export function securityLog(
  event: string,
  details?: Record<string, unknown>,
): void {
  console.error(`[FlowMind] ${event}`, details ? redactForLog(details) : undefined);
}

export function isSensitiveFieldName(value: string): boolean {
  return SENSITIVE_KEY.test(value);
}
