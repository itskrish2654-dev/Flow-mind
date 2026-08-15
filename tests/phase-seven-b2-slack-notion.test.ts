import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getConnector, getConnectorOperation, validateConnectorRegistry } from "../lib/connectors/registry";
import { assessConnectorPlan } from "../lib/connectors/planning";
import { getSlackUrlVerificationChallenge, normalizeSlackMessage, verifySlackRequest } from "../lib/connectors/slack/events";
import { SLACK_SCOPES, slackScopesForOperation } from "../lib/connectors/slack/scopes";
import { encodeNotionProperty, mapNotionProperties, notionExactMatchFilter } from "../lib/connectors/notion/properties";
import { getInitialNotionVerificationToken, verifyNotionWebhook } from "../lib/connectors/notion/webhooks";
import { compileReadyPlan } from "../lib/workflow-compiler";
import { planWorkflow } from "../lib/workflow-planner";

test("7B2-1. Slack and Notion are truthful beta manifests with only accepted initial operations", () => {
  assert.deepEqual(validateConnectorRegistry(), []);
  const slack = getConnector("slack")!; const notion = getConnector("notion")!;
  assert.equal(slack.manifest.status, "BETA"); assert.equal(notion.manifest.status, "BETA");
  assert.deepEqual(slack.manifest.triggers.map((item) => item.key), ["new_channel_message"]);
  assert.deepEqual(slack.manifest.actions.map((item) => item.key), ["send_channel_message", "reply_in_thread"]);
  assert.deepEqual(notion.manifest.triggers.map((item) => item.key), ["page_created_or_added", "page_updated"]);
  assert.deepEqual(notion.manifest.actions.map((item) => item.key), ["create_page", "create_data_source_item", "find_item", "update_item"]);
});

test("7B2-2. Slack requests only operation-specific least privilege scopes", () => {
  assert.deepEqual(slackScopesForOperation("new_channel_message"), [SLACK_SCOPES.channelsRead, SLACK_SCOPES.channelsHistory]);
  assert.deepEqual(slackScopesForOperation("send_channel_message"), [SLACK_SCOPES.channelsRead, SLACK_SCOPES.chatWrite]);
  assert.ok(!slackScopesForOperation("send_channel_message").some((scope) => /admin|users:read|groups/.test(scope)));
});

test("7B2-3. provider OAuth URL behavior preserves state and follows provider requirements", async () => {
  const exchange = await readFile("lib/connectors/oauth-exchange.ts", "utf8"); const notion = await readFile("lib/connectors/notion/oauth-provider.ts", "utf8"); const slack = await readFile("lib/connectors/slack/oauth-provider.ts", "utf8");
  assert.match(exchange, /url\.searchParams\.set\("state", input\.state\)/); assert.match(exchange, /auth\.pkceRequired/); assert.match(exchange, /providerFamily === "slack" \? "," : " "/);
  assert.match(slack, /oauth\.v2\.access/); assert.match(slack, /code_verifier/); assert.match(notion, /owner", "user"/); assert.match(notion, /searchParams\.delete\("scope"\)/); assert.match(notion, /Authorization|authorization/);
});

test("7B2-4. Slack raw-body signature validates and replayed timestamps fail", () => {
  const previous = process.env.FLOWMIND_CONNECTOR_SLACK_SIGNING_SECRET; process.env.FLOWMIND_CONNECTOR_SLACK_SIGNING_SECRET = "test-signing-secret";
  try {
    const raw = Buffer.from('{"type":"event_callback"}'); const now = 1_800_000_000; const timestamp = String(now - 60);
    const signature = `v0=${createHmac("sha256", "test-signing-secret").update(`v0:${timestamp}:`).update(raw).digest("hex")}`;
    const request = new Request("https://example.com", { headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature } });
    assert.equal(verifySlackRequest(request, raw, now), true); assert.equal(verifySlackRequest(request, raw, now + 601), false);
    assert.equal(verifySlackRequest(new Request("https://example.com", { headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": "v0=" + "0".repeat(64) } }), raw, now), false);
  } finally { if (previous === undefined) delete process.env.FLOWMIND_CONNECTOR_SLACK_SIGNING_SECRET; else process.env.FLOWMIND_CONNECTOR_SLACK_SIGNING_SECRET = previous; }
});

test("7B2-4b. Slack URL verification echoes only a bounded challenge", async () => {
  assert.equal(getSlackUrlVerificationChallenge({ type: "url_verification", challenge: "slack-challenge" }), "slack-challenge");
  assert.equal(getSlackUrlVerificationChallenge({ type: "event_callback", challenge: "not-a-challenge" }), null);
  assert.equal(getSlackUrlVerificationChallenge({ type: "url_verification", challenge: "" }), null);
  const route = await readFile("app/api/connectors/events/[provider]/route.ts", "utf8");
  assert.match(route, /verifySlackRequest\(request, raw\)/);
  assert.match(route, /new Response\(challenge, \{ status: 200, headers: \{ "Content-Type": "text\/plain; charset=utf-8" \} \}\)/);
});

test("7B2-5. Slack normalization rejects own bot/system events and bounds content", () => {
  const base = { type: "event_callback", event_id: "Ev1", team_id: "T1", event_time: 1_800_000_000, event: { type: "message", channel: "C12345678", user: "U1", text: "hello", ts: "1800000000.1" } };
  assert.equal(normalizeSlackMessage({ ...base, event: { ...base.event, bot_id: "B1" } }), null);
  assert.equal(normalizeSlackMessage({ ...base, event: { ...base.event, subtype: "message_changed" } }), null);
  assert.equal(normalizeSlackMessage(base)?.text, "hello");
  assert.equal(normalizeSlackMessage({ ...base, event: { ...base.event, text: "x".repeat(50_000) } })?.text.length, 40_000);
});

test("7B2-6. Slack actions require provider acknowledgement and preserve exact thread", async () => {
  const source = await readFile("lib/connectors/slack/messages.ts", "utf8");
  assert.match(source, /body\.channel/); assert.match(source, /thread_ts: threadTs/); assert.match(source, /returnedThread !== threadTs/); assert.match(source, /externallyDelivered: true/); assert.match(source, /unfurl_links: false/);
});

test("7B2-7. Slack rate limit and reconnect states use normalized taxonomy", async () => {
  const source = await readFile("lib/connectors/slack/api.ts", "utf8");
  assert.match(source, /response\.status === 429/); assert.match(source, /retry-after/); assert.match(source, /SLACK_RECONNECT_REQUIRED/); assert.match(source, /status: "expired"/);
});

test("7B2-8. multiple provider connections require an exact connection selection", () => {
  const slack = getConnector("slack")!; const operation = slack.manifest.actions[0];
  const connections = [{ id: "one", connectorId: "slack", providerFamily: "slack", status: "connected" as const, grantedScopes: [...operation.requiredScopes] }, { id: "two", connectorId: "slack", providerFamily: "slack", status: "connected" as const, grantedScopes: [...operation.requiredScopes] }];
  assert.equal(assessConnectorPlan(slack.manifest, operation, connections, "production").status, "CONNECTION_REQUIRED");
  assert.equal(assessConnectorPlan(slack.manifest, operation, connections, "production", "two").status, "SUPPORTED");
});

test("7B2-9. Notion webhook HMAC validates the untouched raw body", () => {
  const previous = process.env.FLOWMIND_CONNECTOR_NOTION_WEBHOOK_VERIFICATION_TOKEN; process.env.FLOWMIND_CONNECTOR_NOTION_WEBHOOK_VERIFICATION_TOKEN = "notion-verification-token";
  try {
    const raw = Buffer.from('{"id":"event"}'); const signature = `sha256=${createHmac("sha256", "notion-verification-token").update(raw).digest("hex")}`;
    assert.equal(verifyNotionWebhook(new Request("https://example.com", { headers: { "x-notion-signature": signature } }), raw), true);
    assert.equal(verifyNotionWebhook(new Request("https://example.com", { headers: { "x-notion-signature": "sha256=" + "0".repeat(64) } }), raw), false);
  } finally { if (previous === undefined) delete process.env.FLOWMIND_CONNECTOR_NOTION_WEBHOOK_VERIFICATION_TOKEN; else process.env.FLOWMIND_CONNECTOR_NOTION_WEBHOOK_VERIFICATION_TOKEN = previous; }
});

test("7B2-9b. initial Notion verification is isolated from normal signed events", async () => {
  const capture = await readFile("lib/connectors/notion/verification-capture.ts", "utf8");
  const route = await readFile("app/api/connectors/events/[provider]/route.ts", "utf8");
  assert.equal(getInitialNotionVerificationToken({ verification_token: "secret_one-time-token" }), "secret_one-time-token");
  assert.equal(getInitialNotionVerificationToken({ verification_token: "" }), null);
  assert.equal(getInitialNotionVerificationToken({ verification_token: 123 }), null);
  assert.equal(getInitialNotionVerificationToken(["secret_not-an-object"]), null);
  assert.equal(getInitialNotionVerificationToken({ verification_token: " secret_whitespace" }), null);
  assert.match(capture, /encryptCredential\(token, CAPTURE_CONTEXT\)/);
  assert.match(capture, /timingSafeEqual/);
  assert.ok(route.indexOf("getInitialNotionVerificationToken(payload)") < route.indexOf("queueNotionEvent(request, raw, notionPayload)"));
  assert.match(route, /verification: capture/);
  assert.match(route, /status: 200/);
  assert.match(route, /consumeCapturedNotionVerificationToken/);
  assert.match(route, /"Cache-Control": "no-store"/);
});

test("7B2-9c. ordinary Notion events still require raw-body HMAC verification", async () => {
  const inbound = await readFile("lib/connectors/notion/inbound.ts", "utf8");
  const capture = await readFile("lib/connectors/notion/verification-capture.ts", "utf8");
  assert.match(inbound, /if \(!verifyNotionWebhook\(request, raw\)\) throw new Error\("NOTION_SIGNATURE_INVALID"\)/);
  assert.match(capture, /delete\(\)\.eq\("provider", PROVIDER\)[\s\S]*\.select\("ciphertext,nonce,auth_tag,algorithm,encryption_version"\)/);
  assert.doesNotMatch(capture, /console\.|captureOperationalEvent/);
});

test("7B2-10. Notion property mapping supports the initial safe type surface and never invents fields", () => {
  const schema = [{ id: "title", name: "Name", type: "title" }, { id: "email", name: "Email", type: "email" }, { id: "done", name: "Done", type: "checkbox" }];
  assert.deepEqual(mapNotionProperties(schema, { Name: "Alice", Email: "alice@example.com", Done: true, Ignored: "not in schema" }), { Name: encodeNotionProperty(schema[0], "Alice"), Email: { email: "alice@example.com" }, Done: { checkbox: true } });
  assert.throws(() => encodeNotionProperty({ id: "files", name: "Files", type: "files" }, []), /unsupported/);
});

test("7B2-11. Notion exact match supports deterministic types", () => {
  assert.deepEqual(notionExactMatchFilter({ id: "name", name: "Name", type: "title" }, "Alice"), { property: "Name", title: { equals: "Alice" } });
  assert.deepEqual(notionExactMatchFilter({ id: "number", name: "Score", type: "number" }, 3), { property: "Score", number: { equals: 3 } });
  assert.deepEqual(notionExactMatchFilter({ id: "email", name: "Email", type: "email" }, "alice@example.com"), { property: "Email", email: { equals: "alice@example.com" } });
  assert.throws(() => notionExactMatchFilter({ id: "people", name: "Owner", type: "people" }, "x"), /cannot be used/);
});

test("7B2-12. Notion find distinguishes 0/1/multiple and update requires exact IDs", async () => {
  const source = await readFile("lib/connectors/notion/actions.ts", "utf8");
  assert.match(source, /page_size: 2/); assert.match(source, /matches\.length > 1/); assert.match(source, /found: false/); assert.match(source, /pageId = uuid/); assert.match(source, /dataSourceId = uuid/);
});

test("7B2-13. webhook ingress persists durable deduplicated receipts before dispatch", async () => {
  const route = await readFile("app/api/connectors/events/[provider]/route.ts", "utf8"); const slack = await readFile("lib/connectors/slack/inbound.ts", "utf8"); const notion = await readFile("lib/connectors/notion/inbound.ts", "utf8");
  assert.match(route, /after\(\(\) => Promise\.allSettled/); assert.ok(slack.indexOf("connector_event_receipts") < route.indexOf("dispatchConnectorReceipt") || route.includes("queueSlackEvent"));
  for (const source of [slack, notion]) { assert.match(source, /provider_event_key/); assert.match(source, /23505/); assert.match(source, /connection_id/); }
});

test("7B2-14. planner composes Slack to AI to Notion and other required connector paths", () => {
  const cases = [
    ["When someone posts in #sales, summarize it and save it to Notion.", ["slack_new_channel_message", "ai_text_transform", "notion_create_data_source_item"]],
    ["When a Notion page is updated, send a message to Slack.", ["notion_page_updated", "slack_send_channel_message"]],
    ["When a public form is submitted, add it to Notion.", ["public_form_submission", "notion_create_data_source_item"]],
    ["When an incoming webhook arrives, summarize it and send to Slack.", ["generic_webhook_trigger", "ai_text_transform", "slack_send_channel_message"]],
    ["When I run this manually, send a message to Slack.", ["manual_trigger", "slack_send_channel_message"]],
    ["When I run this manually, find a Notion item and update it.", ["manual_trigger", "notion_find_item", "notion_update_item"]],
  ] as const;
  for (const [prompt, expected] of cases) { const plan = planWorkflow(prompt); assert.equal(plan.status, "READY_TO_COMPILE", prompt); if (plan.status === "READY_TO_COMPILE") assert.deepEqual(compileReadyPlan(prompt, plan).steps.map((step) => step.capabilityId), expected); }
});

test("7B2-15. exact connection ownership and secret boundaries are enforced server-side", async () => {
  const actions = await readFile("app/actions/connections.ts", "utf8"); const subscriptions = await readFile("lib/connectors/subscriptions.ts", "utf8"); const vault = await readFile("lib/connectors/connection-vault.ts", "utf8");
  assert.match(actions, /\.eq\("id", request\.data\.connectionId\)\.eq\("user_id", user\.id\)/); assert.match(subscriptions, /\.eq\("id", config\.connectionId\)\.eq\("user_id", input\.userId\)/); assert.match(vault, /\.eq\("connection_id", connectionId\)\.eq\("user_id", userId\)/);
});

test("7B2-16. tokens and content are absent from browser modules and telemetry metadata", async () => {
  const client = await readFile("components/automation-workspace.tsx", "utf8"); const connections = await readFile("components/connections-list.tsx", "utf8"); const telemetry = [await readFile("lib/connectors/slack/messages.ts", "utf8"), await readFile("lib/connectors/slack/inbound.ts", "utf8"), await readFile("lib/connectors/notion/actions.ts", "utf8"), await readFile("lib/connectors/notion/inbound.ts", "utf8")].join("\n");
  assert.doesNotMatch(client + connections, /access_token|refresh_token|client_secret|signing_secret|verification_token/i);
  assert.doesNotMatch(telemetry, /metadata:\s*\{[^}]*message\.text|metadata:\s*\{[^}]*page\.properties/);
});

test("7B2-17. disconnect removes vault material, Slack revokes remotely, and subscriptions stop", async () => {
  const source = await readFile("lib/connectors/connection-vault.ts", "utf8");
  assert.match(source, /revokeSlackToken/); assert.match(source, /connector_connection_credentials"\)\.delete/); assert.match(source, /connector_subscriptions"\)\.update\(\{ status: "revoked"/);
});

test("7B2-18. provider operations are revalidated through the authoritative server registry", () => {
  assert.ok(getConnectorOperation("slack", "action", "send_channel_message", 1)); assert.ok(getConnectorOperation("notion", "action", "create_data_source_item", 1));
  assert.equal(getConnectorOperation("slack", "action", "send_direct_message", 1), null); assert.equal(getConnectorOperation("notion", "action", "arbitrary_property_blob", 1), null);
});
