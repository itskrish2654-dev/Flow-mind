import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { getConnectorOnboarding, getCapability } from "../lib/capability-registry";
import { notionAcceptanceConnector, notionLiveAcceptanceEnabled } from "../lib/notion-live-acceptance";

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
