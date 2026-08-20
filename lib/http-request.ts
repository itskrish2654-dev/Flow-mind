import { request } from "node:https";

import {
  createPinnedWebhookLookup,
  resolveTrustedWebhook,
} from "@/lib/security/outbound-webhook";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const HTTP_AUTH_TYPES = [
  "none",
  "bearer",
  "basic",
  "api_key_header",
  "api_key_query",
] as const;
export type HttpAuthType = (typeof HTTP_AUTH_TYPES)[number];

export const HTTP_ERROR_CODES = [
  "HTTP_INVALID_URL",
  "HTTP_BLOCKED_DESTINATION",
  "HTTP_DNS_FAILED",
  "HTTP_CONNECTION_FAILED",
  "HTTP_TIMEOUT",
  "HTTP_UNAUTHORIZED",
  "HTTP_FORBIDDEN",
  "HTTP_NOT_FOUND",
  "HTTP_CONFLICT",
  "HTTP_RATE_LIMITED",
  "HTTP_CLIENT_ERROR",
  "HTTP_SERVER_ERROR",
  "HTTP_INVALID_JSON",
  "HTTP_RESPONSE_TOO_LARGE",
  "HTTP_PROVIDER_FAILED",
] as const;
export type HttpErrorCode = (typeof HTTP_ERROR_CODES)[number];

export const HTTP_LIMITS = {
  requestBodyBytes: 64 * 1024,
  responseBodyBytes: 64 * 1024,
  headerCount: 20,
  headerBytes: 8 * 1024,
  queryCount: 30,
  queryBytes: 8 * 1024,
  timeoutMinMs: 1_000,
  timeoutMaxMs: 15_000,
  timeoutDefaultMs: 10_000,
} as const;

export type HttpRequestAuth = {
  type: HttpAuthType;
  secret?: string;
  username?: string;
  name?: string;
};

export type HttpRequestInput = {
  url: string;
  method: HttpMethod;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  auth?: HttpRequestAuth;
  idempotencyKey?: string;
  idempotencyHeader?: "Idempotency-Key" | "X-Idempotency-Key";
  allowDeleteBody?: boolean;
};

export type HttpRequestOutput = {
  status: number;
  headers: Record<string, string>;
  body: string;
  json: unknown | null;
  durationMs: number;
  acknowledged: true;
  completed: true;
  requestId?: string;
};

export class HttpRequestError extends Error {
  constructor(
    public readonly code: HttpErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly options: {
      retryAfterMs?: number;
      ambiguous?: boolean;
      status?: number;
    } = {},
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

const BLOCKED_REQUEST_HEADERS = new Set([
  "authorization", "connection", "content-length", "cookie", "forwarded", "host",
  "keep-alive", "proxy-authenticate", "proxy-authorization", "set-cookie", "te",
  "trailer", "transfer-encoding", "upgrade", "via",
]);
const SAFE_RESPONSE_HEADERS = new Set([
  "content-type", "content-length", "date", "etag", "last-modified", "retry-after",
  "x-request-id", "x-correlation-id", "x-ratelimit-limit", "x-ratelimit-remaining",
]);

function validHeaderName(name: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/.test(name);
}

function validQueryName(name: string): boolean {
  return name.length > 0 && name.length <= 120 && !/[\u0000-\u001f\u007f]/.test(name);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function validateHttpRequestPairs(
  pairs: Record<string, string>,
  kind: "header" | "query",
): Array<[string, string]> {
  const entries = Object.entries(pairs);
  const maxCount = kind === "header" ? HTTP_LIMITS.headerCount : HTTP_LIMITS.queryCount;
  const maxBytes = kind === "header" ? HTTP_LIMITS.headerBytes : HTTP_LIMITS.queryBytes;
  if (entries.length > maxCount) {
    throw new HttpRequestError("HTTP_CLIENT_ERROR", `Too many ${kind} values were configured.`, false);
  }
  let total = 0;
  for (const [name, value] of entries) {
    if (kind === "header") {
      const normalized = name.toLowerCase();
      if (!validHeaderName(name) || BLOCKED_REQUEST_HEADERS.has(normalized) || normalized.startsWith("x-forwarded-") || /(?:api[_-]?key|token|secret|password|authorization)/i.test(name)) {
        throw new HttpRequestError("HTTP_CLIENT_ERROR", "A configured request header is not permitted.", false);
      }
      if (/\r|\n/.test(value)) {
        throw new HttpRequestError("HTTP_CLIENT_ERROR", "A configured request header is invalid.", false);
      }
    } else if (!validQueryName(name) || /(?:api[_-]?key|token|secret|password|authorization|auth)/i.test(name)) {
      throw new HttpRequestError("HTTP_CLIENT_ERROR", "A configured query parameter is invalid.", false);
    }
    total += byteLength(name) + byteLength(value);
  }
  if (total > maxBytes) {
    throw new HttpRequestError("HTTP_CLIENT_ERROR", `Configured ${kind} values are too large.`, false);
  }
  return entries;
}

export function parseStructuredPairs(value: unknown): Record<string, string> {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item ?? "")]),
    );
  }
  if (typeof value !== "string") {
    throw new HttpRequestError("HTTP_CLIENT_ERROR", "Structured request values are invalid.", false);
  }
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
      return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item ?? "")]));
    } catch {
      throw new HttpRequestError("HTTP_INVALID_JSON", "Structured request values must be a valid object.", false);
    }
  }
  const result: Record<string, string> = {};
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new HttpRequestError("HTTP_CLIENT_ERROR", "Use one name = value pair per line.", false);
    }
    result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return result;
}

export function parseJsonBody(value: unknown): unknown {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new HttpRequestError("HTTP_INVALID_JSON", "The request body must be valid JSON.", false);
  }
}

export function applyHttpAuthentication(
  destination: URL,
  headers: Record<string, string>,
  auth: HttpRequestAuth | undefined,
): void {
  if (!auth || auth.type === "none") return;
  if (!auth.secret) {
    throw new HttpRequestError("HTTP_UNAUTHORIZED", "HTTP authentication is not configured.", false);
  }
  if (byteLength(auth.secret) > 4_096) {
    throw new HttpRequestError("HTTP_CLIENT_ERROR", "The authentication value is too large.", false);
  }
  if (auth.type === "bearer") {
    headers.Authorization = `Bearer ${auth.secret}`;
    return;
  }
  if (auth.type === "basic") {
    if (!auth.username) throw new HttpRequestError("HTTP_UNAUTHORIZED", "A Basic Auth username is required.", false);
    headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.secret}`, "utf8").toString("base64")}`;
    return;
  }
  if (!auth.name) throw new HttpRequestError("HTTP_UNAUTHORIZED", "An API key name is required.", false);
  if (auth.type === "api_key_header") {
    const normalized = auth.name.toLowerCase();
    if (!validHeaderName(auth.name) || BLOCKED_REQUEST_HEADERS.has(normalized) || normalized.startsWith("x-forwarded-")) {
      throw new HttpRequestError("HTTP_CLIENT_ERROR", "The API key header name is not permitted.", false);
    }
    headers[auth.name] = auth.secret;
    return;
  }
  if (!validQueryName(auth.name)) {
    throw new HttpRequestError("HTTP_CLIENT_ERROR", "The API key query name is invalid.", false);
  }
  destination.searchParams.set(auth.name, auth.secret);
}

function parseRetryAfter(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const seconds = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
  const delay = seconds !== null ? seconds * 1_000 : Date.parse(raw) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 24 * 60 * 60 * 1_000)) : undefined;
}

export function classifyHttpStatus(status: number, retryAfter?: string | string[]): HttpRequestError | null {
  if (status >= 200 && status < 300) return null;
  const retryAfterMs = parseRetryAfter(retryAfter);
  if (status >= 300 && status < 400) return new HttpRequestError("HTTP_BLOCKED_DESTINATION", "HTTP redirects are disabled for security.", false, { status });
  if (status === 401) return new HttpRequestError("HTTP_UNAUTHORIZED", "The API rejected the configured authentication.", false, { status });
  if (status === 403) return new HttpRequestError("HTTP_FORBIDDEN", "The API denied this request.", false, { status });
  if (status === 404) return new HttpRequestError("HTTP_NOT_FOUND", "The requested API resource was not found.", false, { status });
  if (status === 409) return new HttpRequestError("HTTP_CONFLICT", "The API reported a conflict.", false, { status });
  if (status === 429) return new HttpRequestError("HTTP_RATE_LIMITED", "The API rate limit was reached.", true, { status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  if (status >= 500) return new HttpRequestError("HTTP_SERVER_ERROR", "The API is temporarily unavailable.", true, { status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  if (status >= 400) return new HttpRequestError("HTTP_CLIENT_ERROR", "The API rejected this request.", false, { status });
  return new HttpRequestError("HTTP_PROVIDER_FAILED", "The API returned an unexpected response.", false, { status });
}

export function safeResponseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      SAFE_RESPONSE_HEADERS.has(name.toLowerCase()) && value !== undefined
        ? [[name.toLowerCase(), Array.isArray(value) ? value.join(", ") : value]]
        : [],
    ),
  );
}

export function parseHttpResponseBody(
  body: string,
  contentType = "",
): { body: string; json: unknown | null } {
  if (!body) return { body: "", json: null };
  const claimsJson = /(?:^|[+\/])json(?:;|$)/i.test(contentType);
  const looksJson = /^\s*[\[{]/.test(body);
  if (!claimsJson && !looksJson) return { body, json: null };
  try {
    return { body, json: JSON.parse(body) as unknown };
  } catch {
    if (claimsJson) throw new HttpRequestError("HTTP_INVALID_JSON", "The API returned invalid JSON.", false);
    return { body, json: null };
  }
}

function redactKnownSecrets(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce((result, secret) => secret ? result.split(secret).join("[redacted]") : result, value);
  }
  if (Array.isArray(value)) return value.map((item) => redactKnownSecrets(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactKnownSecrets(item, secrets)]));
  }
  return value;
}

export function methodMayBeAmbiguous(method: HttpMethod): boolean {
  return method === "POST" || method === "PATCH" || method === "DELETE";
}

export function serializeHttpRequestBody(input: HttpRequestInput): Buffer | null {
  if (input.method === "GET") return null;
  if (input.method === "DELETE" && !input.allowDeleteBody) return null;
  if (input.body === undefined) return null;
  const body = Buffer.from(JSON.stringify(input.body), "utf8");
  if (body.byteLength > HTTP_LIMITS.requestBodyBytes) {
    throw new HttpRequestError("HTTP_CLIENT_ERROR", "The HTTP request body is too large.", false);
  }
  return body;
}

export function classifyHttpTransportFailure(
  method: HttpMethod,
  options: { timedOut: boolean; responseStarted: boolean },
): HttpRequestError {
  const ambiguous = options.responseStarted || methodMayBeAmbiguous(method);
  return options.timedOut
    ? new HttpRequestError("HTTP_TIMEOUT", "The API request timed out.", !ambiguous, { ambiguous })
    : new HttpRequestError("HTTP_CONNECTION_FAILED", "The API connection failed.", !ambiguous, { ambiguous });
}

export function classifyHttpResolutionFailure(error: unknown): HttpRequestError {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/invalid/.test(message)) return new HttpRequestError("HTTP_INVALID_URL", "The API URL is invalid.", false);
  if (/blocked|not permitted|private/.test(message)) return new HttpRequestError("HTTP_BLOCKED_DESTINATION", "The API destination is not permitted.", false);
  return new HttpRequestError("HTTP_DNS_FAILED", "The API hostname could not be resolved safely.", true);
}

export async function executeTrustedHttpRequest(input: HttpRequestInput): Promise<HttpRequestOutput> {
  if (!HTTP_METHODS.includes(input.method)) {
    throw new HttpRequestError("HTTP_CLIENT_ERROR", "This HTTP method is not supported.", false);
  }
  if (input.url.length > 2_048) {
    throw new HttpRequestError("HTTP_INVALID_URL", "The API URL is too long.", false);
  }
  let resolved: Awaited<ReturnType<typeof resolveTrustedWebhook>>;
  try {
    resolved = await resolveTrustedWebhook(input.url);
  } catch (error) {
    throw classifyHttpResolutionFailure(error);
  }

  const destination = new URL(resolved.destination.toString());
  if (destination.search) {
    throw new HttpRequestError("HTTP_CLIENT_ERROR", "Use structured query parameters instead of adding them to the API URL.", false);
  }
  for (const name of destination.searchParams.keys()) {
    if (/(?:api[_-]?key|token|secret|password|authorization|auth)/i.test(name)) {
      throw new HttpRequestError("HTTP_CLIENT_ERROR", "Sensitive query values must use the encrypted authentication configuration.", false);
    }
  }
  const query = input.query ?? {};
  for (const [name, value] of validateHttpRequestPairs(query, "query")) destination.searchParams.set(name, value);
  const headers = Object.fromEntries(validateHttpRequestPairs(input.headers ?? {}, "header"));
  applyHttpAuthentication(destination, headers, input.auth);
  const responseSecrets = input.auth?.secret
    ? Array.from(new Set([
        input.auth.secret,
        encodeURIComponent(input.auth.secret),
        `Bearer ${input.auth.secret}`,
        input.auth.type === "basic" && input.auth.username
          ? `Basic ${Buffer.from(`${input.auth.username}:${input.auth.secret}`, "utf8").toString("base64")}`
          : "",
      ].filter(Boolean)))
    : [];
  const body = serializeHttpRequestBody(input);
  if (body) {
    if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(body.byteLength);
  }
  headers["User-Agent"] = "CrazyLoops-HTTP/2.0";
  if (input.idempotencyHeader && input.idempotencyKey) headers[input.idempotencyHeader] = input.idempotencyKey;
  const timeoutMs = Math.max(
    HTTP_LIMITS.timeoutMinMs,
    Math.min(input.timeoutMs ?? HTTP_LIMITS.timeoutDefaultMs, HTTP_LIMITS.timeoutMaxMs),
  );
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let responseStarted = false;
    let timedOut = false;
    const outbound = request(destination, {
      method: input.method,
      headers,
      timeout: timeoutMs,
      lookup: createPinnedWebhookLookup(resolved.address, resolved.family),
    }, (response) => {
      responseStarted = true;
      const chunks: Buffer[] = [];
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > HTTP_LIMITS.responseBodyBytes) {
          response.destroy(new HttpRequestError(
            "HTTP_RESPONSE_TOO_LARGE",
            "The API response exceeded the safe size limit.",
            false,
            { ambiguous: methodMayBeAmbiguous(input.method) },
          ));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const status = response.statusCode ?? 0;
          const statusError = classifyHttpStatus(status, response.headers["retry-after"]);
          if (statusError) return reject(statusError);
          const text = Buffer.concat(chunks).toString("utf8");
          const parsed = parseHttpResponseBody(text, response.headers["content-type"]?.toString() ?? "");
          const safeBody = redactKnownSecrets(parsed.body, responseSecrets) as string;
          const safeJson = redactKnownSecrets(parsed.json, responseSecrets);
          const filteredHeaders = safeResponseHeaders(response.headers);
          resolve({
            status,
            headers: filteredHeaders,
            body: safeBody,
            json: safeJson,
            durationMs: Date.now() - startedAt,
            acknowledged: true,
            completed: true,
            ...(filteredHeaders["x-request-id"] ? { requestId: filteredHeaders["x-request-id"] } : {}),
          });
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", reject);
    });
    outbound.on("timeout", () => {
      timedOut = true;
      outbound.destroy();
    });
    outbound.on("error", (error) => {
      if (error instanceof HttpRequestError) return reject(error);
      reject(classifyHttpTransportFailure(input.method, { timedOut, responseStarted }));
    });
    if (body) outbound.end(body);
    else outbound.end();
  });
}
