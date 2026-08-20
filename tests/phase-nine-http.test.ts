import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CAPABILITY_REGISTRY } from "../lib/capability-registry";
import { getConnectorOperation } from "../lib/connectors/registry";
import { ConnectorError } from "../lib/connectors/errors";
import { classifyExecutionError } from "../lib/execution-reliability";
import {
  HTTP_LIMITS,
  HTTP_METHODS,
  HTTP_ERROR_CODES,
  HttpRequestError,
  applyHttpAuthentication,
  classifyHttpStatus,
  classifyHttpResolutionFailure,
  classifyHttpTransportFailure,
  parseHttpResponseBody,
  parseJsonBody,
  parseStructuredPairs,
  safeResponseHeaders,
  serializeHttpRequestBody,
  validateHttpRequestPairs,
} from "../lib/http-request";
import { isBlockedOutboundAddress, parseTrustedWebhookUrl } from "../lib/security/outbound-webhook";
import type { CompiledWorkflow } from "../lib/schemas/workflow";
import { compileReadyPlan } from "../lib/workflow-compiler";
import { executeWorkflowSteps } from "../lib/workflow-execution";
import { planWorkflow } from "../lib/workflow-planner";

const httpSteps = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET"): CompiledWorkflow["steps"] => [
  { id: "trigger", type: "webhook_trigger", capabilityId: "generic_webhook_trigger", title: "Incoming webhook", description: "Receives JSON", config: { connector: { connectorId: "flowmind_webhook", operationKind: "trigger", operationKey: "event_received", operationVersion: 1, mappings: [] } } },
  { id: "request", type: "http_request", capabilityId: "http.request", title: `${method} API`, description: "Calls an API", config: { endpoint: "https://example.com/api", method, http: { version: 2, url: "https://example.com/api", method, authType: "none", timeoutMs: 10_000 }, connector: { connectorId: "flowmind_http", operationKind: "action", operationKey: "request", operationVersion: 2, mappings: [] } } },
  { id: "store", type: "store_data", capabilityId: "flowmind_data_store", title: "Store", description: "Store" },
];

test("9C-1. HTTP request is a new versioned capability and legacy POST JSON remains intact", () => {
  assert.equal(CAPABILITY_REGISTRY["http.request"].supported, true);
  assert.equal(CAPABILITY_REGISTRY["http.request"].executionImplementation, "connector:flowmind_http/request@2");
  assert.ok(getConnectorOperation("flowmind_http", "action", "request", 2));
  assert.ok(getConnectorOperation("flowmind_http", "action", "post_json", 1));
  assert.deepEqual(HTTP_METHODS, ["GET", "POST", "PUT", "PATCH", "DELETE"]);
});

test("9C-2. none, Bearer, Basic, header-key, and query-key authentication are deterministic", () => {
  const cases = ["none", "bearer", "basic", "api_key_header", "api_key_query"] as const;
  for (const type of cases) {
    const url = new URL("https://example.com/api");
    const headers: Record<string, string> = {};
    applyHttpAuthentication(url, headers, { type, secret: type === "none" ? undefined : "test-secret", username: "user", name: type === "api_key_query" ? "api_key" : "X-API-Key" });
    if (type === "bearer") assert.equal(headers.Authorization, "Bearer test-secret");
    if (type === "basic") assert.equal(headers.Authorization, `Basic ${Buffer.from("user:test-secret").toString("base64")}`);
    if (type === "api_key_header") assert.equal(headers["X-API-Key"], "test-secret");
    if (type === "api_key_query") assert.equal(url.searchParams.get("api_key"), "test-secret");
  }
  assert.throws(() => applyHttpAuthentication(new URL("https://example.com"), {}, { type: "bearer" }), (error) => error instanceof HttpRequestError && error.code === "HTTP_UNAUTHORIZED");
});

test("9C-3. structured query/header input and JSON bodies are bounded parsable structures", () => {
  assert.deepEqual(parseStructuredPairs("start_date = 2026-08-18\nstatus = paid"), { start_date: "2026-08-18", status: "paid" });
  assert.deepEqual(parseStructuredPairs('{"Accept":"application/json"}'), { Accept: "application/json" });
  assert.deepEqual(parseJsonBody('{"name":"Krish"}'), { name: "Krish" });
  assert.throws(() => parseJsonBody("not json"), (error) => error instanceof HttpRequestError && error.code === "HTTP_INVALID_JSON");
  assert.equal(HTTP_LIMITS.requestBodyBytes, 65_536);
  assert.equal(HTTP_LIMITS.responseBodyBytes, 65_536);
  assert.equal(HTTP_LIMITS.headerCount, 20);
  assert.equal(HTTP_LIMITS.timeoutMaxMs, 15_000);
  assert.equal(serializeHttpRequestBody({ method: "GET", url: "https://example.com", body: { ignored: true } }), null);
  assert.equal(serializeHttpRequestBody({ method: "DELETE", url: "https://example.com", body: { ignored: true } }), null);
  assert.throws(() => serializeHttpRequestBody({ method: "POST", url: "https://example.com", body: "x".repeat(HTTP_LIMITS.requestBodyBytes + 1) }), (error) => error instanceof HttpRequestError && error.code === "HTTP_CLIENT_ERROR");
  assert.throws(() => validateHttpRequestPairs({ Authorization: "secret" }, "header"), (error) => error instanceof HttpRequestError && error.code === "HTTP_CLIENT_ERROR");
  assert.throws(() => validateHttpRequestPairs({ "X-API-Key": "secret" }, "header"), (error) => error instanceof HttpRequestError && error.code === "HTTP_CLIENT_ERROR");
});

test("9C-4. JSON, text, empty responses, and safe response headers normalize truthfully", () => {
  assert.deepEqual(parseHttpResponseBody('{"orders":[{"id":"123","amount":500}]}', "application/json").json, { orders: [{ id: "123", amount: 500 }] });
  assert.deepEqual(parseHttpResponseBody("plain text", "text/plain"), { body: "plain text", json: null });
  assert.deepEqual(parseHttpResponseBody("", "application/json"), { body: "", json: null });
  assert.deepEqual(safeResponseHeaders({ "content-type": "application/json", "x-request-id": "r1", "set-cookie": "secret", authorization: "hidden", "x-provider-secret": "hidden" }), { "content-type": "application/json", "x-request-id": "r1" });
  assert.throws(() => parseHttpResponseBody("not-json", "application/json"), (error) => error instanceof HttpRequestError && error.code === "HTTP_INVALID_JSON");
});

test("9C-5. status taxonomy and Retry-After are exact and safely retryable", () => {
  const expected = new Map([[401, "HTTP_UNAUTHORIZED"], [403, "HTTP_FORBIDDEN"], [404, "HTTP_NOT_FOUND"], [409, "HTTP_CONFLICT"], [429, "HTTP_RATE_LIMITED"], [500, "HTTP_SERVER_ERROR"], [502, "HTTP_SERVER_ERROR"], [503, "HTTP_SERVER_ERROR"], [504, "HTTP_SERVER_ERROR"]]);
  for (const [status, code] of expected) assert.equal(classifyHttpStatus(status)?.code, code);
  const limited = classifyHttpStatus(429, "7");
  assert.equal(limited?.retryable, true);
  assert.equal(limited?.options.retryAfterMs, 7_000);
  assert.equal(classifyHttpStatus(400)?.retryable, false);
  assert.equal(classifyHttpStatus(302)?.code, "HTTP_BLOCKED_DESTINATION");
});

test("9C-6. execution error classification preserves normalized HTTP codes", () => {
  const error = new ConnectorError({ category: "rate_limit", code: "HTTP_RATE_LIMITED", message: "Rate limited.", retryable: true, retryAfterMs: 2_000 });
  assert.deepEqual(classifyExecutionError(error), { category: "HTTP_RATE_LIMITED", retryable: true, safeMessage: "Rate limited.", retryAfterMs: 2_000 });
});

test("9C-6a. URL, DNS, connection, timeout, and ambiguous mutation failures remain distinct", () => {
  assert.equal(HTTP_ERROR_CODES.length, 15);
  assert.equal(classifyHttpResolutionFailure(new Error("Webhook URL is invalid.")).code, "HTTP_INVALID_URL");
  assert.equal(classifyHttpResolutionFailure(new Error("destination resolves to a blocked network")).code, "HTTP_BLOCKED_DESTINATION");
  assert.equal(classifyHttpResolutionFailure(new Error("ENOTFOUND")).code, "HTTP_DNS_FAILED");
  const timeout = classifyHttpTransportFailure("GET", { timedOut: true, responseStarted: false });
  assert.equal(timeout.code, "HTTP_TIMEOUT");
  assert.equal(timeout.retryable, true);
  const connection = classifyHttpTransportFailure("GET", { timedOut: false, responseStarted: false });
  assert.equal(connection.code, "HTTP_CONNECTION_FAILED");
  assert.equal(connection.retryable, true);
  const ambiguous = classifyHttpTransportFailure("POST", { timedOut: true, responseStarted: false });
  assert.equal(ambiguous.options.ambiguous, true);
  assert.equal(ambiguous.retryable, false);
});

test("9C-7. SSRF, metadata, IPv4/IPv6 local ranges, redirects, and DNS pinning remain fail-closed", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fc00::1", "fe80::1"]) assert.equal(isBlockedOutboundAddress(address), true, address);
  assert.throws(() => parseTrustedWebhookUrl("https://localhost/api"));
  assert.throws(() => parseTrustedWebhookUrl("http://example.com/api"));
  const source = await readFile("lib/http-request.ts", "utf8");
  assert.match(source, /createPinnedWebhookLookup/);
  assert.match(source, /HTTP redirects are disabled for security/);
  assert.doesNotMatch(source, /maxRedirects|redirect:\s*["']follow/);
});

test("9C-8. planner infers only the five safe methods and clarifies dangerous ambiguity", () => {
  const prompts = new Map([
    ["GET", "When an incoming webhook arrives, GET https://example.com/orders and store it in CrazyLoops."],
    ["POST", "When an incoming webhook arrives, POST to our API endpoint https://example.com/orders."],
    ["PUT", "When an incoming webhook arrives, PUT this record to API https://example.com/orders/1."],
    ["PATCH", "When an incoming webhook arrives, PATCH this record using API https://example.com/orders/1."],
    ["DELETE", "When an incoming webhook arrives, DELETE this record using API https://example.com/orders/1."],
  ]);
  for (const [method, prompt] of prompts) {
    const plan = planWorkflow(prompt);
    assert.equal(plan.status, "READY_TO_COMPILE", method);
    const request = [...plan.transformations, ...(plan.destination ? [plan.destination] : [])].find((item) => item.capabilityId === "http.request");
    assert.equal(request?.http?.method, method);
  }
  const ambiguous = planWorkflow("Update this customer using https://example.com/customer/1.");
  assert.equal(ambiguous.status, "NEEDS_CLARIFICATION");
  assert.equal(ambiguous.clarificationQuestions[0], "Should CrazyLoops update this record with PATCH or replace it completely with PUT?");
  assert.equal(planWorkflow("Get yesterday's orders from this API.").clarificationQuestions[0], "What API endpoint should CrazyLoops call?");
  assert.equal(planWorkflow("GET https://example.com/orders with authentication and store it.").clarificationQuestions[0], "How should CrazyLoops authenticate with this API?");
});

test("9C-9. HTTP composes with Formatter and Condition without manufacturing AI", () => {
  const formattedPlan = planWorkflow("When an incoming webhook arrives, GET https://example.com/customer, make the response name title case, and store it in CrazyLoops.");
  assert.equal(formattedPlan.status, "READY_TO_COMPILE");
  if (formattedPlan.status !== "READY_TO_COMPILE") return;
  const formatted = compileReadyPlan(formattedPlan.intent, formattedPlan);
  assert.deepEqual(formatted.steps.map((step) => step.capabilityId), ["generic_webhook_trigger", "http.request", "formatter.transform", "flowmind_data_store"]);
  assert.equal(formatted.steps.some((step) => step.type === "ai_transform"), false);
  assert.equal(formatted.steps[2].config?.formatter?.source.kind, "step");
  const conditionalPlan = planWorkflow("When an incoming webhook arrives, GET https://example.com/customer, if response status equals 200 then store it in CrazyLoops.");
  assert.equal(conditionalPlan.status, "READY_TO_COMPILE");
  if (conditionalPlan.status !== "READY_TO_COMPILE") return;
  const conditional = compileReadyPlan(conditionalPlan.intent, conditionalPlan);
  assert.equal(conditional.steps.find((step) => step.type === "filter_condition")?.config?.condition?.sourcePath, "step_2.status");
});

test("9C-10. Wait and For Each stay explicitly unsupported", () => {
  assert.equal(planWorkflow("Call GET https://example.com, then wait two hours and store it.").status, "UNSUPPORTED");
  assert.equal(planWorkflow("GET https://example.com/items, then for each item store it.").status, "UNSUPPORTED");
  assert.equal(CAPABILITY_REGISTRY["wait.delay"].supported, false);
  assert.equal(CAPABILITY_REGISTRY.for_each.supported, false);
});

test("9C-11. runtime exposes structured GET output without claiming external delivery", async () => {
  const result = await executeWorkflowSteps({
    userId: "owner-a", workflowId: "workflow-a", workflowName: "Get orders", steps: httpSteps("GET"), inputValues: {}, mode: "test", idempotencyKey: "execution-1",
    executeHttpRequest: async () => ({ status: "succeeded", acknowledged: true, externallyDelivered: false, output: { orders: [{ id: "123", amount: 500 }], status: 200, headers: { "content-type": "application/json" }, body: "{...}", json: { orders: [{ id: "123", amount: 500 }] }, durationMs: 20, completed: true }, metadata: { method: "GET", httpStatus: 200, retryable: false } }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.delivered, false);
  assert.deepEqual(result.outputData.http_results.request.orders, [{ id: "123", amount: 500 }]);
  assert.match(result.logs.find((log) => log.stepId === "request")?.message ?? "", /200/);
});

test("9C-12. mutation acknowledgement, stable idempotency, and ambiguous safety are truthful", async () => {
  const keys: string[] = [];
  const run = () => executeWorkflowSteps({
    userId: "owner-a", workflowId: "workflow-a", workflowName: "Create record", steps: httpSteps("POST"), inputValues: { name: "Krish" }, mode: "test", idempotencyKey: "execution-stable",
    executeHttpRequest: async (input, context) => { keys.push(context.idempotencyKey); assert.deepEqual(input.body, { name: "Krish" }); return { status: "succeeded", acknowledged: true, externallyDelivered: true, output: { status: 201, headers: {}, body: "", json: null, durationMs: 10, completed: true }, metadata: { method: "POST", httpStatus: 201, retryable: false } }; },
  });
  assert.equal((await run()).delivered, true);
  assert.equal((await run()).delivered, true);
  assert.deepEqual(keys, ["execution-stable:request", "execution-stable:request"]);
  const ambiguous = await executeWorkflowSteps({
    userId: "owner-a", workflowId: "workflow-a", workflowName: "Create record", steps: httpSteps("POST"), inputValues: {}, mode: "test",
    executeHttpRequest: async () => ({ status: "ambiguous", acknowledged: false, externallyDelivered: false, output: {}, metadata: { retryable: false }, error: { category: "ambiguous_acknowledgement", code: "HTTP_TIMEOUT", message: "The request may have reached the provider.", retryable: false } }),
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.delivered, false);
  assert.equal(ambiguous.outputData.steps.find((step) => step.stepId === "request")?.status, "failed");
});

test("9C-13. Test Loop warnings distinguish GET from side-effecting methods", async () => {
  const ui = await readFile("components/automation-workspace.tsx", "utf8");
  assert.match(ui, /This test will make a real request to this API\./);
  assert.match(ui, /This test will make a real external request and may change data\./);
  assert.match(ui, /window\.confirm/);
});

test("9C-14. credentials, telemetry, A\/B ownership, retry, and account deletion remain server-scoped", async () => {
  const [runtime, vault, credentials, retry, accountCleanup, observability] = await Promise.all([
    readFile("lib/http-request-runtime.ts", "utf8"), readFile("lib/security/credential-vault.ts", "utf8"), readFile("app/actions/credentials.ts", "utf8"), readFile("app/actions/execute.ts", "utf8"), readFile("supabase/migrations/20260812000200_phase4_account_lifecycle.sql", "utf8"), readFile("lib/observability.ts", "utf8"),
  ]);
  assert.match(runtime, /connectorId:\s*"http\.request"[\s\S]*credentialKey:\s*"auth_secret"/);
  assert.match(vault, /userId[\s\S]*workflowId[\s\S]*connectorId[\s\S]*credentialKey/);
  assert.match(credentials, /\.eq\("id", workflowId\)[\s\S]*\.eq\("user_id", userId\)/);
  assert.match(retry, /\.eq\("id", parsedId\.data\)[\s\S]*\.eq\("user_id", auth\.user\.id\)/);
  assert.match(accountCleanup, /delete from public\.workflow_credentials where user_id = p_user_id/);
  assert.match(runtime, /http_request_started/);
  assert.match(runtime, /http_request_succeeded/);
  assert.match(runtime, /http_request_failed/);
  assert.doesNotMatch(runtime, /metadata:\s*\{[^}]*\b(?:url|body|query|headers|secret)\b/);
  assert.match(observability, /PRIVATE_METADATA_KEY/);
});
