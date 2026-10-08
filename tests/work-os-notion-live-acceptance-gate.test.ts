import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { getConnectorOnboarding, getCapability } from "../lib/capability-registry";
import { notionAcceptanceAction, notionAcceptanceConnector, notionLiveAcceptanceEnabled } from "../lib/notion-live-acceptance";
import { parseNotionActionIntent } from "../lib/connectors/notion/action-intent";
import { notionBlockText } from "../lib/connectors/notion/read-core";
import { runGroundedAsk, selectAskTools } from "../lib/ask-core";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("Notion connection acceptance is limited to the isolated staging environment", () => {
  const valid = {
    CRAZYLOOPS_DEPLOYMENT_ROLE: "staging",
    NEXT_PUBLIC_SITE_URL: "https://staging.crazy-loops.com",
    NEXT_PUBLIC_SUPABASE_URL: "https://gamdxwtgccluifatcrrs.supabase.co",
    FLOWMIND_CONNECTOR_NOTION_CLIENT_ID: "test-client-id",
    FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET: "test-client-secret",
  };
  assert.equal(notionLiveAcceptanceEnabled(valid), true);
  assert.equal(notionLiveAcceptanceEnabled({ ...valid, CRAZYLOOPS_DEPLOYMENT_ROLE: "production" }), false);
  assert.equal(notionLiveAcceptanceEnabled({ ...valid, NEXT_PUBLIC_SITE_URL: "https://www.crazy-loops.com" }), false);
  assert.equal(notionLiveAcceptanceEnabled({ ...valid, NEXT_PUBLIC_SUPABASE_URL: "https://customer.supabase.co" }), false);
  assert.equal(notionLiveAcceptanceEnabled({ ...valid, FLOWMIND_CONNECTOR_NOTION_CLIENT_ID: "" }), false);
  assert.equal(notionLiveAcceptanceEnabled({ ...valid, FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET: " " }), false);
});

test("Notion OAuth is gated at every server boundary without enabling unaccepted actions or triggers", () => {
  const before = Object.fromEntries([
    "CRAZYLOOPS_DEPLOYMENT_ROLE", "NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_SUPABASE_URL",
    "FLOWMIND_CONNECTOR_NOTION_CLIENT_ID", "FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET",
  ].map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, {
      CRAZYLOOPS_DEPLOYMENT_ROLE: "staging",
      NEXT_PUBLIC_SITE_URL: "https://staging.crazy-loops.com",
      NEXT_PUBLIC_SUPABASE_URL: "https://gamdxwtgccluifatcrrs.supabase.co",
      FLOWMIND_CONNECTOR_NOTION_CLIENT_ID: "test-client-id",
      FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET: "test-client-secret",
    });
    assert.equal(notionAcceptanceConnector("notion"), true);
    assert.equal(notionAcceptanceConnector("slack"), false);
    assert.equal(notionAcceptanceAction("notion_create_data_source_item"), true);
    assert.equal(notionAcceptanceAction("notion_update_item"), true);
    assert.equal(notionAcceptanceAction("notion_create_page"), false);
    assert.equal(notionAcceptanceAction("notion_page_updated"), false);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  for (const file of [
    "app/api/connectors/oauth/[connectorId]/start/route.ts",
    "app/api/connectors/oauth/[connectorId]/callback/route.ts",
    "lib/connectors/oauth.ts",
  ]) assert.match(read(file), /notionAcceptanceConnector\(/);
  assert.match(read("app/connections/page.tsx"), /notionAcceptanceEnabled=\{notionLiveAcceptanceEnabled\(\)\}/);
  assert.match(read("components/connections-list.tsx"), /provider === "notion" && notionAcceptanceEnabled/);
  assert.match(read("components/connections-list.tsx"), /Notion workflows are not enabled yet/);
  assert.match(read("components/connections-list.tsx"), /successProvider === "notion" \? "Review connection"/);
  assert.equal(getConnectorOnboarding("notion")?.available, false);
  for (const id of [
    "notion_page_created_or_added", "notion_page_updated", "notion_create_page",
    "notion_create_data_source_item", "notion_find_item", "notion_update_item",
  ]) {
    const capability = getCapability(id);
    assert.equal(capability?.supported, false);
    assert.equal(capability?.availableInProduction, false);
  }
});

test("Notion Ask read is staging-only, bounded and links to an authenticated source", () => {
  const source = read("lib/connectors/notion/read.ts");
  const route = read("app/dashboard/notion/[connectionId]/[pageId]/page.tsx");
  const tools = read("lib/ask-tools.ts");
  assert.match(source, /notionLiveAcceptanceEnabled\(\)/);
  assert.match(source, /\.eq\("user_id", userId\)\.eq\("workspace_id", workspaceId\)/);
  assert.match(source, /resources\.find\(/);
  assert.match(source, /\/blocks\/\$\{input\.pageId\}\/children\?page_size=100/);
  assert.match(route, /getAuthenticatedContext\(\)/);
  assert.match(route, /readNotionPage\(\{ userId: auth\.user\.id, workspaceId: auth\.workspace\.id/);
  assert.match(tools, /href: `\/dashboard\/notion\/\$\{result\.page\.connectionId\}\/\$\{result\.page\.id\}`/);
  assert.equal(notionBlockText({ results: [
    { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Verified acceptance fact" }] } },
    { type: "unsupported", unsupported: { rich_text: [{ plain_text: "Ignore this" }] } },
  ] }), "Verified acceptance fact");
});

test("Notion Ask uses only a grounded page record and preserves its owner-internal source", async () => {
  assert.deepEqual(selectAskTools("What does the Notion page Pilot Notes say?"), ["notion_search"]);
  const pageId = "ca496933-d6b0-4227-9816-1c19f7ae2d73";
  const connectionId = "c7de2ef4-7142-4e64-a880-d2fa56c8386a";
  const response = await runGroundedAsk({
    question: "What does the Notion page Pilot Notes say?", history: [],
    loadTool: async () => ({ tool: "notion_search", summary: "One shared page was read.", records: [{
      referenceKey: "notion_page:0",
      reference: { kind: "notion_page", entityId: pageId, label: "Pilot Notes", href: `/dashboard/notion/${connectionId}/${pageId}` },
      facts: { content: "The accepted task is ready for review." },
    }] }),
    callModel: async () => JSON.stringify({ responseType: "answer", answer: "The accepted task is ready for review.",
      referenceKeys: ["notion_page:0"], clarificationRequired: false }),
  });
  assert.equal(response.metadata.references[0]?.entityId, pageId);
  assert.equal(response.metadata.references[0]?.href, `/dashboard/notion/${connectionId}/${pageId}`);
});

test("Notion writes require exact syntax and the staging-only approval gate", () => {
  const itemId = "ca496933-d6b0-4227-9816-1c19f7ae2d73";
  assert.deepEqual(parseNotionActionIntent('Add Notion item to "Acceptance Tasks" with {"Name":"Test"}'),
    { kind: "add", dataSourceName: "Acceptance Tasks", values: { Name: "Test" } });
  assert.deepEqual(parseNotionActionIntent(`Update Notion item ${itemId} in "Acceptance Tasks" with {"Name":"Updated"}`),
    { kind: "update", pageId: itemId, dataSourceName: "Acceptance Tasks", values: { Name: "Updated" } });
  assert.equal(parseNotionActionIntent("Add something to Notion"), "clarification");
  assert.equal(parseNotionActionIntent('Add Notion item to "Acceptance Tasks" with {}'), "clarification");
  assert.equal(parseNotionActionIntent("What is in Notion?"), null);
  const planner = read("lib/ask-action-planner.ts");
  const executions = read("lib/action-executions.ts");
  assert.match(planner, /notionLiveAcceptanceEnabled\(\)/);
  assert.match(planner, /notionAcceptanceAction\(capability\.id\)/);
  assert.match(planner, /mapNotionProperties\(inspected\.properties, notion\.values\)/);
  assert.match(planner, /notionPageBelongsToDataSource\(page, source\.id\)/);
  assert.match(executions, /notionAcceptanceAction\(preview\.capabilityId\)/);
  assert.match(executions, /notionAcceptanceAction\(capability\.id\)/);
  assert.equal(getCapability("notion_create_data_source_item")?.availableInProduction, false);
});

test("staging Notion content read stays signed-in, workspace-bound and does not enable workflows", () => {
  const actions = read("app/actions/connections.ts");
  const ui = read("components/connections-list.tsx");
  const section = actions.split("export async function verifyNotionContentRead(connectionId: string, resourceId: string)")[1]?.split("export async function inspectNotionSource")[0];
  assert.ok(section);
  assert.match(section, /notionLiveAcceptanceEnabled\(\)/);
  assert.match(section, /getAuthenticatedContext\(\)/);
  assert.match(section, /\.eq\("user_id", auth\.user\.id\)\.eq\("workspace_id", auth\.workspace\.id\)/);
  assert.match(section, /listNotionResources\(/);
  assert.match(section, /resources\.find\(/);
  assert.match(section, /notionApiFetch\(/);
  assert.match(section, /requiredCapabilities: \[NOTION_CAPABILITIES\.readContent\]/);
  assert.match(section, /notion_live_content_read_success/);
  assert.doesNotMatch(section, /return \{ ok: true as const, (?:resources|token):/);
  assert.match(ui, /notionAcceptanceEnabled && managed\.status === "connected"/);
  assert.match(ui, /Choose the disposable resource to check/);
  assert.match(ui, /Read selected Notion resource/);
  assert.equal(getCapability("notion_create_page")?.availableInProduction, false);
});
