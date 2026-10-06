import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  assessCapability,
  CAPABILITY_REGISTRY,
  getConnectorOnboarding,
  getCustomerVisibleCapabilities,
} from "../lib/capability-registry";
import { getConnector } from "../lib/connectors/registry";
import { isD2OperatorAuthorized } from "../lib/operations/d2-operator-auth";

const root = resolve(import.meta.dirname, "..");
const source = (file: string) => readFileSync(resolve(root, file), "utf8");

test("pilot exposes Gmail but keeps each unaccepted Sheets action engineering-only", () => {
  for (const id of ["gmail_new_email", "gmail_send_email"]) {
    assert.equal(assessCapability(id, "production").available, true);
  }
  for (const id of ["google_sheets_add_row", "google_sheets_find_row", "google_sheets_update_row"] as const) {
    assert.equal(CAPABILITY_REGISTRY[id].maturity, "TEST_ONLY");
    assert.equal(assessCapability(id, "test").available, true);
    assert.equal(assessCapability(id, "production").available, false);
    assert.equal(CAPABILITY_REGISTRY[id].customerVisible, false);
    assert.equal(CAPABILITY_REGISTRY[id].plannerVisible, false);
    assert.equal(CAPABILITY_REGISTRY[id].builderVisible, false);
    assert.equal(CAPABILITY_REGISTRY[id].connectionVisible, false);
    assert.equal(getCustomerVisibleCapabilities().some((item) => item.id === id), false);
  }
  assert.equal(getConnectorOnboarding("google_gmail")?.available, true);
  assert.equal(getConnectorOnboarding("google_sheets")?.available, false);
  assert.ok(getConnector("google_sheets")?.manifest.actions.every((action) => action.testMode && !action.production));
  assert.equal(getConnectorOnboarding("slack")?.available, true);
  for (const id of ["notion", "hubspot"]) {
    assert.equal(getConnectorOnboarding(id)?.available, false);
  }
});

test("staging-production runtime cannot activate D2 owner-only acceptance even with a valid bearer", () => {
  const secret = "disposable-test-operator-secret-1234567890";
  const authorized = isD2OperatorAuthorized({
    request: new Request("https://staging.crazy-loops.com/api/operations/connector-runner-airtable-canary", {
      method: "POST", headers: { authorization: `Bearer ${secret}` },
    }),
    environment: { NODE_ENV: "production", D2_AIRTABLE_ACCEPTANCE_ENABLED: "true", D2_AIRTABLE_ACCEPTANCE_SECRET: secret },
    enabledName: "D2_AIRTABLE_ACCEPTANCE_ENABLED",
    secretName: "D2_AIRTABLE_ACCEPTANCE_SECRET",
  });
  assert.equal(authorized, false);
  for (const route of [
    "app/api/operations/connector-runner-airtable-canary/route.ts",
    "app/api/operations/connector-runner-airtable-provision/route.ts",
    "app/api/operations/gmail-live-acceptance/oauth/start/route.ts",
  ]) {
    assert.match(source(route), /process\.env\.NODE_ENV === "production"/);
    assert.match(source(route), /status: 404/);
  }
  for (const file of ["lib/action-executions.ts", "lib/ask-action-planner.ts"]) {
    assert.match(source(file), /function acceptanceHarnessEnabled\(\) \{\s*if \(process\.env\.NODE_ENV === "production"\) return false;/);
  }
});

test("Connections labels unaccepted Sheets as deferred and excludes unaccepted connect choices", () => {
  const connections = source("components/connections-list.tsx");
  assert.match(connections, /return provider === "google" \|\| provider === "slack"/);
  assert.match(connections, /providerReadyForPilot\(provider\) && !byProvider\.has\(provider\)/);
  assert.match(connections, /getConnectorOnboarding\("google_sheets"\)\?\.available/);
  assert.match(connections, /Google Sheets is not available in this pilot while live-provider acceptance is pending/);
  assert.match(connections, /Not pilot-ready/);
});
