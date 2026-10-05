import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  googleSheetsAcceptanceCapability,
  googleSheetsAcceptanceConnector,
  googleSheetsLiveAcceptanceEnabled,
} from "../lib/google-sheets-live-acceptance";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("Sheets acceptance is enabled only by the exact isolated staging configuration", () => {
  const valid = {
    GOOGLE_SHEETS_LIVE_ACCEPTANCE_ENABLED: "true",
    NEXT_PUBLIC_SITE_URL: "https://staging.crazy-loops.com",
    NEXT_PUBLIC_SUPABASE_URL: "https://gamdxwtgccluifatcrrs.supabase.co",
  };
  assert.equal(googleSheetsLiveAcceptanceEnabled(valid), true);
  assert.equal(googleSheetsLiveAcceptanceEnabled({ ...valid, GOOGLE_SHEETS_LIVE_ACCEPTANCE_ENABLED: "false" }), false);
  assert.equal(googleSheetsLiveAcceptanceEnabled({ ...valid, NEXT_PUBLIC_SITE_URL: "https://www.crazy-loops.com" }), false);
  assert.equal(googleSheetsLiveAcceptanceEnabled({ ...valid, NEXT_PUBLIC_SUPABASE_URL: "https://customer-project.supabase.co" }), false);
  assert.equal(googleSheetsLiveAcceptanceEnabled({ ...valid, NEXT_PUBLIC_SITE_URL: "https://staging.crazy-loops.com.evil.example" }), false);
});

test("the exception is limited to Google Sheets connector and its three reviewed capabilities", () => {
  const before = process.env.GOOGLE_SHEETS_LIVE_ACCEPTANCE_ENABLED;
  const beforeSite = process.env.NEXT_PUBLIC_SITE_URL;
  const beforeDb = process.env.NEXT_PUBLIC_SUPABASE_URL;
  try {
    process.env.GOOGLE_SHEETS_LIVE_ACCEPTANCE_ENABLED = "true";
    process.env.NEXT_PUBLIC_SITE_URL = "https://staging.crazy-loops.com";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://gamdxwtgccluifatcrrs.supabase.co";
    assert.equal(googleSheetsAcceptanceConnector("google_sheets"), true);
    assert.equal(googleSheetsAcceptanceConnector("google_gmail"), false);
    for (const id of ["google_sheets_find_row", "google_sheets_add_row", "google_sheets_update_row"])
      assert.equal(googleSheetsAcceptanceCapability(id), true);
    for (const id of ["gmail_send_email", "slack_send_channel_message", "internal.action_acknowledge"])
      assert.equal(googleSheetsAcceptanceCapability(id), false);
  } finally {
    if (before === undefined) delete process.env.GOOGLE_SHEETS_LIVE_ACCEPTANCE_ENABLED;
    else process.env.GOOGLE_SHEETS_LIVE_ACCEPTANCE_ENABLED = before;
    if (beforeSite === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = beforeSite;
    if (beforeDb === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = beforeDb;
  }
});

test("staging exception is applied at each server boundary without changing static customer availability", () => {
  assert.match(read("app/connections/page.tsx"), /sheetsAcceptanceEnabled=\{googleSheetsLiveAcceptanceEnabled\(\)\}/);
  assert.match(read("app/api/connectors/oauth/[connectorId]/start/route.ts"), /googleSheetsAcceptanceConnector\(connectorId\)/);
  assert.match(read("app/api/connectors/oauth/[connectorId]/callback/route.ts"), /googleSheetsAcceptanceConnector\(connectorId\)/);
  assert.match(read("lib/connectors/oauth.ts"), /googleSheetsAcceptanceConnector\(input\.connectorId\)/);
  for (const file of ["lib/ask.ts", "lib/ask-action-planner.ts", "lib/action-executions.ts"])
    assert.match(read(file), /googleSheetsAcceptanceCapability\(/);
  const registry = read("lib/capability-registry.ts");
  for (const id of ["google_sheets_find_row", "google_sheets_add_row", "google_sheets_update_row"]) {
    const position = registry.indexOf(`${id}: defineConnectorCapability`);
    assert.ok(position >= 0);
    assert.match(registry.slice(position, position + 1100), /availableInProduction: false/);
  }
});
