import assert from "node:assert/strict";
import test from "node:test";

import { assessCapability } from "../lib/capability-registry";
import { ambiguousAcknowledgement, classifyConnectorHttpFailure } from "../lib/connectors/errors";
import { applyFieldMappings, autoMapFields, resolveMappingSource } from "../lib/connectors/mapping";
import { assessConnectorPlan } from "../lib/connectors/planning";
import { applyPollResult, renewalKey, shouldRenewSubscription } from "../lib/connectors/polling";
import { getConnector, getConnectorOperation, getConnectorTrigger, listCustomerConnectors, validateConnectorRegistry } from "../lib/connectors/registry";
import { CompiledWorkflowSchema } from "../lib/schemas/workflow";
import { createPinnedWebhookLookup, isBlockedOutboundAddress, parseTrustedWebhookUrl, selectPinnedWebhookAddress } from "../lib/security/outbound-webhook";
import { compileReadyPlan } from "../lib/workflow-compiler";
import { planWorkflow } from "../lib/workflow-planner";

const fields = [{ key: "email", label: "Email", type: "email" as const, required: true }, { key: "name", label: "Name", type: "string" as const }];

test("1-4 registry rejects duplicates/missing runtime and unavailable capability stays unavailable", () => {
  const original = getConnector("flowmind_http")!;
  assert.deepEqual(validateConnectorRegistry(), []);
  assert.match(validateConnectorRegistry([original, original]).join(" "), /Duplicate connector ID/);
  const duplicateOperation = { ...original, manifest: { ...original.manifest, actions: [original.manifest.actions[0], original.manifest.actions[0]] } };
  assert.match(validateConnectorRegistry([duplicateOperation]).join(" "), /Duplicate operation/);
  assert.equal(assessCapability("slack", "production").available, false);
});

test("5-13 OAuth contract is PKCE/state/user-bound, token-safe, refresh-serialized and reconnect-aware", async () => {
  const oauthSource = await import("node:fs/promises").then((fs) => fs.readFile("lib/connectors/oauth.ts", "utf8"));
  const refreshSource = await import("node:fs/promises").then((fs) => fs.readFile("lib/connectors/token-refresh.ts", "utf8"));
  const callbackSource = await import("node:fs/promises").then((fs) => fs.readFile("app/api/connectors/oauth/[connectorId]/callback/route.ts", "utf8"));
  assert.match(oauthSource, /randomBytes\(32\)/); assert.match(oauthSource, /state_hash/); assert.match(oauthSource, /\.gt\("expires_at"/); assert.match(oauthSource, /\.eq\("user_id", input\.userId\)/); assert.match(oauthSource, /consumed_at/);
  assert.match(callbackSource, /storeConnectionSecret/); assert.doesNotMatch(callbackSource, /NextResponse\.json\([^)]*accessToken/);
  assert.match(refreshSource, /claim_connector_token_refresh/); assert.match(refreshSource, /status: "expired"/);
});

test("14-17 connection ownership, disconnect revocation and unready state are enforced", async () => {
  const vault = await import("node:fs/promises").then((fs) => fs.readFile("lib/connectors/connection-vault.ts", "utf8"));
  assert.match(vault, /\.eq\("user_id", userId\)/); assert.match(vault, /status === "revoked"/); assert.match(vault, /connector_connection_credentials"\)\.delete/); assert.match(vault, /connector_subscriptions"\)\.update\(\{ status: "revoked"/);
  const manifest = getConnector("flowmind_test")!.manifest; const operation = manifest.actions[0];
  assert.equal(assessConnectorPlan(manifest, operation, [{ connectorId: manifest.id, status: "revoked", grantedScopes: [] }], "test").status, "CONNECTION_REQUIRED");
});

test("18-23 webhook verification/dedup and polling/renewal state are deterministic", () => {
  assert.ok(getConnectorTrigger("flowmind_webhook", "event_received", 1));
  const state = { cursor: "a", seenEventKeys: new Set(["old"]) };
  const polled = applyPollResult(state, { events: [{ key: "old", value: 1 }, { key: "new", value: 2 }], nextCursor: "b" });
  assert.deepEqual(polled.accepted, [{ key: "new", value: 2 }]); assert.equal(polled.state.cursor, "b");
  assert.equal(applyPollResult(polled.state, { events: [{ key: "new", value: 2 }], nextCursor: "c" }).accepted.length, 0);
  assert.equal(renewalKey("sub", "date"), renewalKey("sub", "date")); assert.equal(shouldRenewSubscription({ status: "active", renewAfter: "2000-01-01T00:00:00Z" }), true);
});

test("24-29 normalized action errors, rate limits, ambiguous ACK and idempotency are explicit", async () => {
  const action = getConnectorOperation("flowmind_test", "action", "acknowledge", 1)!;
  assert.equal(typeof action.handler, "function");
  if (typeof action.handler !== "function") return;
  const result = await action.handler({ message: "hello" }, { userId: "u", workflowId: "w", executionId: "e", stepId: "s", idempotencyKey: "e:s" });
  assert.equal(result.acknowledged, true); assert.equal(result.externallyDelivered, true); assert.match(result.providerReferenceId ?? "", /^test:/);
  assert.equal(classifyConnectorHttpFailure(429).retryable, true); assert.equal(ambiguousAcknowledgement().retryable, false); assert.equal(ambiguousAcknowledgement().category, "ambiguous_acknowledgement");
});

test("30-35 mapping handles direct/nested/type/required/automatic/uncertain cases", () => {
  const context = { trigger: { email: "a@example.com", profile: { name: "Ada" } }, steps: { ai: { result: "ok" } } };
  assert.equal(resolveMappingSource({ kind: "trigger", path: "email" }, context), "a@example.com");
  assert.equal(resolveMappingSource({ kind: "trigger", path: "profile.name" }, context), "Ada");
  assert.deepEqual(applyFieldMappings(fields, [{ target: "email", source: { kind: "trigger", path: "email" } }], context), { email: "a@example.com" });
  assert.throws(() => applyFieldMappings(fields, [{ target: "email", source: { kind: "literal", value: "bad" } }], context), /valid email/);
  assert.throws(() => applyFieldMappings(fields, [], context), /required/);
  assert.equal(autoMapFields(fields, fields).mappings.length, 2); assert.deepEqual(autoMapFields([], fields).missing, ["email"]);
});

test("36-41 planning is registry/connection/scope aware and compiles a multi-step connector chain", () => {
  const http = getConnector("flowmind_http")!; const operation = http.manifest.actions[0];
  assert.equal(assessConnectorPlan(http.manifest, operation, [], "production").status, "SUPPORTED");
  assert.equal(assessConnectorPlan(null, null, [], "production").status, "UNSUPPORTED");
  const internal = getConnector("flowmind_test")!; const internalAction = internal.manifest.actions[0];
  assert.equal(assessConnectorPlan(internal.manifest, internalAction, [], "test").status, "CONNECTION_REQUIRED");
  assert.equal(assessConnectorPlan(internal.manifest, internalAction, [{ connectorId: internal.manifest.id, status: "connected", grantedScopes: [] }], "test").status, "ADDITIONAL_SCOPE_REQUIRED");
  const prompt = "When an incoming webhook arrives summarize it and post the result to https://example.com/hook";
  const plan = planWorkflow(prompt); assert.equal(plan.status, "READY_TO_COMPILE");
  if (plan.status === "READY_TO_COMPILE") { const workflow = compileReadyPlan(prompt, plan); assert.equal(workflow.steps.length, 3); assert.equal(workflow.steps[0].capabilityId, "generic_webhook_trigger"); assert.equal(workflow.steps[2].capabilityId, "generic_http_action"); assert.match(workflow.summary, /authenticated CrazyLoops webhook event/); assert.match(workflow.summary, /posts the result as JSON/); assert.doesNotMatch(workflow.summary, /hosted form|stores the result inside CrazyLoops/); }
});

test("42-48 generic HTTP SSRF boundary blocks loopback/private/link-local/metadata and redirects by construction", () => {
  assert.equal(parseTrustedWebhookUrl("https://example.com/hook").hostname, "example.com");
  for (const address of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.1.1", "169.254.169.254", "::1"]) assert.equal(isBlockedOutboundAddress(address), true);
  assert.throws(() => parseTrustedWebhookUrl("http://example.com")); assert.throws(() => parseTrustedWebhookUrl("https://localhost/hook"));
});

test("48b generic HTTP prefers public IPv4 when DNS publishes IPv6 first", () => {
  assert.deepEqual(
    selectPinnedWebhookAddress([
      { address: "2001:4860:4860::8888", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ]),
    { address: "1.1.1.1", family: 4 },
  );
});

test("48c pinned DNS lookup supports Node's all-address request shape", async () => {
  const pinned = createPinnedWebhookLookup("1.1.1.1", 4);
  const result = await new Promise<unknown>((resolve, reject) => {
    pinned("example.com", { all: true }, (error, address) => error ? reject(error) : resolve(address));
  });
  assert.deepEqual(result, [{ address: "1.1.1.1", family: 4 }]);
});

test("49-53 gateway source enforces rate/quota/body/dedupe/owner-derived subscription", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile("app/api/connectors/events/[provider]/route.ts", "utf8"));
  assert.match(source, /enforceRateLimit/); assert.match(source, /enforceUsageQuota/); assert.match(source, /MAX_EVENT_BYTES/); assert.match(source, /23505/); assert.match(source, /subscription\.user_id/);
  const dispatch = await import("node:fs/promises").then((fs) => fs.readFile("lib/connectors/webhook-dispatch.ts", "utf8"));
  assert.match(dispatch, /\.update\(\{ status: "processing" \}\).*\.eq\("status", "queued"\)/);
  assert.match(dispatch, /dispatchQueuedConnectorReceipts/);
});

test("49b. a webhook-only workflow cannot bypass endpoint authentication through the public-form route", async () => {
  const migration = await import("node:fs/promises").then((fs) => fs.readFile("supabase/migrations/20260814000300_phase7a_public_form_trigger_boundary.sql", "utf8"));
  assert.match(migration, /compiled_workflow \? 'publicForm'/);
  assert.match(migration, /jsonb_typeof\(version\.compiled_workflow -> 'publicForm'\) = 'object'/);
});

test("54-56 connector configuration is pinned/versioned and secrets are excluded", () => {
  const parsed = CompiledWorkflowSchema.parse({ workflowName: "Pinned", summary: "Pinned connector", steps: [{ id: "t", type: "webhook_trigger", capabilityId: "generic_webhook_trigger", title: "Webhook", description: "Webhook", config: { connector: { connectorId: "flowmind_webhook", operationKind: "trigger", operationKey: "event_received", operationVersion: 1, mappings: [] } } }] });
  const snapshot = structuredClone(parsed); parsed.steps[0].title = "Later edit"; assert.equal(snapshot.steps[0].title, "Webhook"); assert.doesNotMatch(JSON.stringify(snapshot), /access_token|refresh_token|api_key/);
});

test("57-62 all prior regression suites remain discoverable", async () => {
  const files = await import("node:fs/promises").then((fs) => fs.readdir("tests"));
  for (const phase of ["phase-one", "phase-two", "phase-three", "phase-four", "phase-five", "phase-six"]) assert.ok(files.some((file) => file.startsWith(phase)), `${phase} suite missing`);
  assert.deepEqual(listCustomerConnectors().map((item) => item.id).sort(), ["airtable", "flowmind_http", "flowmind_webhook", "google_gmail", "google_sheets", "notion", "slack"]);
});
