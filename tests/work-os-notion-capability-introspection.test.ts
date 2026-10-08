import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { NOTION_CAPABILITIES } from "../lib/connectors/notion/constants";
import {
  addNotionAuthorizationParameters,
  exchangeNotionAuthorizationCode,
  introspectNotionAccessToken,
  NotionVerificationError,
  parseNotionIntrospectedContentScopes,
  verifyNotionTokenBotIdentity,
} from "../lib/connectors/notion/oauth-provider";
import { getConnector } from "../lib/connectors/registry";

const expected = [NOTION_CAPABILITIES.readContent, NOTION_CAPABILITIES.insertContent, NOTION_CAPABILITIES.updateContent];

test("generic Connections-page Notion intent is limited to its content contract, with no OAuth scope parameter", () => {
  const manifest = getConnector("notion")!.manifest;
  assert.deepEqual(manifest.auth.defaultScopes, expected);
  const url = new URL("https://api.notion.com/v1/oauth/authorize?scope=content%3Aread&state=test-state");
  addNotionAuthorizationParameters(url);
  assert.equal(url.searchParams.has("scope"), false);
  assert.equal(url.searchParams.get("state"), "test-state");
  assert.equal(url.searchParams.get("owner"), "user");
});

test("Notion introspection maps only provider-confirmed content capabilities", () => {
  assert.deepEqual(parseNotionIntrospectedContentScopes("read_content insert_content update_content"), expected);
  assert.deepEqual(parseNotionIntrospectedContentScopes("read_content"), [NOTION_CAPABILITIES.readContent]);
  assert.deepEqual(parseNotionIntrospectedContentScopes("read_user_without_email read_content insert_content update_content read_comments"), expected);
  assert.deepEqual(parseNotionIntrospectedContentScopes("read_content unknown_provider_scope"), [NOTION_CAPABILITIES.readContent]);
  assert.throws(() => parseNotionIntrospectedContentScopes("insert_content update_content"), /read capability/);
  assert.throws(() => parseNotionIntrospectedContentScopes("read_comments read_user_without_email"), /read capability/);
  assert.throws(() => parseNotionIntrospectedContentScopes(null), /could not be verified/);
  for (const [value, failurePoint] of [
    [null, "capabilities_missing"],
    ["insert_content update_content", "read_capability_missing"],
  ] as const) {
    assert.throws(() => parseNotionIntrospectedContentScopes(value), (error) =>
      error instanceof NotionVerificationError && error.failurePoint === failurePoint);
  }
});

test("Notion OAuth persists introspected capabilities, not generic requested values", async () => {
  const previousFetch = globalThis.fetch;
  const previousId = process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_ID;
  const previousSecret = process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET;
  process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_ID = "test-client";
  process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET = "test-secret";
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.method, "POST");
    assert.match(String((init?.headers as Record<string, string>).authorization), /^Basic /);
    if (calls.length === 1) {
      return Response.json({ access_token: "fake-access-token", workspace_id: "test-workspace", bot_id: "a0d4f0c6-6914-4d17-916a-c722cd9c24b6" });
    }
    assert.deepEqual(JSON.parse(String(init?.body)), { token: "fake-access-token" });
    return Response.json({ active: true, scope: "read_user_without_email read_content insert_content update_content" });
  };
  try {
    const result = await exchangeNotionAuthorizationCode({ code: "test-code", redirectUri: "https://staging.crazy-loops.com/callback" });
    assert.equal(calls.length, 2);
    assert.match(calls[0], /oauth\/token$/);
    assert.match(calls[1], /oauth\/introspect$/);
    assert.deepEqual(result.scopes, expected);
    assert.equal(result.scopesConfirmedByProvider, true);
    assert.equal(result.safeMetadata.capabilityVerification, "notion_token_introspection_v1");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousId === undefined) delete process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_ID;
    else process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET;
    else process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET = previousSecret;
  }
});

test("inactive or unverified Notion introspection cannot claim grants", async () => {
  const previousFetch = globalThis.fetch;
  const previousId = process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_ID;
  const previousSecret = process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET;
  process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_ID = "test-client";
  process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET = "test-secret";
  try {
    for (const body of [{ active: false, scope: "read_content insert_content update_content" }, { active: true }, { active: true, scope: "read_comments" }]) {
      globalThis.fetch = async () => Response.json(body);
      await assert.rejects(introspectNotionAccessToken("fake-access-token"));
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousId === undefined) delete process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_ID;
    else process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET;
    else process.env.FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET = previousSecret;
  }
});

test("Notion callback logs only bounded staging failure categories, never provider responses", () => {
  const callback = readFileSync("app/api/connectors/oauth/[connectorId]/callback/route.ts", "utf8");
  assert.match(callback, /notionAcceptanceConnector\(connectorId\)/);
  assert.match(callback, /failurePoint: error instanceof NotionVerificationError \? error\.failurePoint : callbackStage/);
  assert.doesNotMatch(callback, /error\.message|JSON\.stringify\(error\)/);
});

test("existing token reuse requires the originally recorded Notion bot identity", async () => {
  const previousFetch = globalThis.fetch;
  const botId = "a0d4f0c6-6914-4d17-916a-c722cd9c24b6";
  try {
    globalThis.fetch = async () => Response.json({ id: botId });
    await verifyNotionTokenBotIdentity("fake-access-token", botId);
    await assert.rejects(verifyNotionTokenBotIdentity("fake-access-token", "b603ffb6-409e-478d-b782-5624488b5bc1"), /does not match/);
    await assert.rejects(verifyNotionTokenBotIdentity("fake-access-token", ""), /unavailable/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("Notion reconnect replaces stale grants and existing-token check stays staging-only and owner-bound", () => {
  const callback = readFileSync("app/api/connectors/oauth/[connectorId]/callback/route.ts", "utf8");
  const action = readFileSync("app/actions/connections.ts", "utf8");
  const ui = readFileSync("components/connections-list.tsx", "utf8");
  assert.match(callback, /providerFamily === "slack" \|\| connector\.manifest\.providerFamily === "notion"\s*\? tokens\.scopes/);
  assert.match(action, /verifyNotionConnectionCapabilities\(connectionId: string\)/);
  assert.match(action, /notionLiveAcceptanceEnabled\(\)/);
  assert.match(action, /\.eq\("user_id", auth\.user\.id\)\.eq\("workspace_id", auth\.workspace\.id\)/);
  assert.match(action, /verifyNotionTokenBotIdentity\(accessToken, botId\)/);
  assert.match(action, /introspectNotionAccessToken\(accessToken\)/);
  assert.match(ui, /Verify Notion permissions/);
  assert.match(ui, /notionAcceptanceEnabled && managed\.status === "connected"/);
});
