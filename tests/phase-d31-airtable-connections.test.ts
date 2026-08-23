import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CAPABILITY_REGISTRY } from "../lib/capability-registry";
import {
  connectCustomerAirtable,
  type AirtableCustomerConnectionDependencies,
} from "../lib/connectors/airtable/customer-connection";
import { planWorkflow } from "../lib/workflow-planner";

const USER_A = "10000000-0000-4000-8000-000000000001";
const SYNTHETIC_PAT = "patSyntheticD31CredentialOnlyForAutomatedTests";

function fixture(input: {
  userId?: string | null;
  existing?: boolean;
  insertResult?: "inserted" | "conflict";
  insertFailure?: boolean;
  vaultFailure?: boolean;
} = {}) {
  const calls: string[] = [];
  let connectionMetadata: Parameters<AirtableCustomerConnectionDependencies["insertConnection"]>[0] | null = null;
  let vaultInput: Parameters<AirtableCustomerConnectionDependencies["storeSecret"]>[0] | null = null;
  const dependencies: AirtableCustomerConnectionDependencies = {
    async getAuthenticatedUserId() {
      calls.push("authenticate");
      return input.userId === undefined ? USER_A : input.userId;
    },
    async findActiveConnection(userId) {
      calls.push(`find:${userId}`);
      return input.existing ? { id: "existing" } : null;
    },
    async insertConnection(metadata) {
      calls.push(`insert:${metadata.user_id}`);
      connectionMetadata = metadata;
      if (input.insertFailure) throw new Error("synthetic ambiguous insert failure");
      return input.insertResult ?? "inserted";
    },
    async storeSecret(secret) {
      calls.push(`vault:${secret.userId}`);
      vaultInput = secret;
      if (input.vaultFailure) throw new Error("synthetic vault failure");
    },
    async cleanupConnection({ userId, connectionId }) {
      calls.push(`cleanup:${userId}:${connectionId}`);
    },
  };
  return {
    dependencies,
    calls,
    metadata: () => connectionMetadata,
    vault: () => vaultInput,
  };
}

test("D3.1 rejects unauthenticated connect before validation, database, or vault access", async () => {
  const setup = fixture({ userId: null });
  const result = await connectCustomerAirtable(SYNTHETIC_PAT, setup.dependencies);
  assert.deepEqual(result, { ok: false, error: "Unauthorized" });
  assert.deepEqual(setup.calls, ["authenticate"]);
});

test("D3.1 rejects malformed, short, and oversized PATs before connection storage", async () => {
  for (const token of ["not-a-token", "patshort", `pat${"a".repeat(510)}`]) {
    const setup = fixture();
    const result = await connectCustomerAirtable(token, setup.dependencies);
    assert.equal(result.ok, false);
    assert.deepEqual(setup.calls, ["authenticate"]);
  }
});

test("D3.1 uses the authenticated owner and a server-generated connection ID", async () => {
  const setup = fixture();
  const result = await connectCustomerAirtable(SYNTHETIC_PAT, setup.dependencies);
  assert.equal(result.ok, true);
  const metadata = setup.metadata();
  assert.ok(metadata);
  assert.equal(metadata.user_id, USER_A);
  assert.match(metadata.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(metadata.external_account_id, `customer-airtable:${metadata.id}`);
});

test("D3.1 stores no unverified Airtable grants and keeps verification deferred", async () => {
  const setup = fixture();
  await connectCustomerAirtable(SYNTHETIC_PAT, setup.dependencies);
  assert.deepEqual(setup.metadata(), {
    id: setup.metadata()?.id,
    user_id: USER_A,
    connector_id: "airtable",
    provider_family: "airtable",
    external_account_id: `customer-airtable:${setup.metadata()?.id}`,
    external_account_label: "Airtable connection",
    auth_type: "api_key",
    status: "connected",
    granted_scopes: [],
    safe_metadata: {
      connectionMode: "customer_api_key",
      providerVerification: "deferred",
    },
  });
  assert.doesNotMatch(JSON.stringify(setup.metadata()), new RegExp(SYNTHETIC_PAT));
  assert.equal(setup.metadata()?.safe_metadata.providerVerification, "deferred");
});

test("D3.1 connect never promotes the required Airtable scope into granted_scopes", async () => {
  const source = await readFile("lib/connectors/airtable/customer-connection.ts", "utf8");
  assert.doesNotMatch(source, /granted_scopes:\s*\[\s*["']data\.records:write["']/);
  assert.match(source, /granted_scopes:\s*\[\]/);
});

test("D3.1 sends the PAT only through the existing api_key vault projection", async () => {
  const setup = fixture();
  await connectCustomerAirtable(SYNTHETIC_PAT, setup.dependencies);
  const vault = setup.vault();
  assert.ok(vault);
  assert.deepEqual(vault, {
    userId: USER_A,
    connectionId: setup.metadata()?.id,
    credentialKey: "api_key",
    credentialType: "api_key",
    plaintext: SYNTHETIC_PAT,
  });
  const { plaintext: omitted, ...credentialMetadata } = vault;
  assert.equal(omitted, SYNTHETIC_PAT);
  assert.doesNotMatch(JSON.stringify(credentialMetadata), new RegExp(SYNTHETIC_PAT));
});

test("D3.1 returns only safe metadata and never echoes the PAT", async () => {
  const setup = fixture();
  const result = await connectCustomerAirtable(SYNTHETIC_PAT, setup.dependencies);
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SYNTHETIC_PAT));
  if (result.ok) {
    assert.deepEqual(result.connection, {
      id: setup.metadata()?.id,
      provider: "airtable",
      accountLabel: "Airtable connection",
      verification: "locally_configured",
    });
  }
});

test("D3.1 rejects both pre-existing and racing duplicate active connections", async () => {
  const existing = fixture({ existing: true });
  const first = await connectCustomerAirtable(SYNTHETIC_PAT, existing.dependencies);
  assert.equal(first.ok, false);
  assert.equal(existing.calls.some((call) => call.startsWith("insert:")), false);

  const racing = fixture({ insertResult: "conflict" });
  const second = await connectCustomerAirtable(SYNTHETIC_PAT, racing.dependencies);
  assert.equal(second.ok, false);
  assert.equal(racing.calls.some((call) => call.startsWith("vault:")), false);
});

test("D3.1 vault failure cleans up the exact newly-created connection", async () => {
  const setup = fixture({ vaultFailure: true });
  const result = await connectCustomerAirtable(SYNTHETIC_PAT, setup.dependencies);
  assert.deepEqual(result, { ok: false, error: "Airtable could not be connected. Please try again." });
  assert.deepEqual(setup.calls, [
    "authenticate",
    `find:${USER_A}`,
    `insert:${USER_A}`,
    `vault:${USER_A}`,
    `cleanup:${USER_A}:${setup.metadata()?.id}`,
  ]);
});

test("D3.1 an ambiguous connection insert failure triggers exact cleanup", async () => {
  const setup = fixture({ insertFailure: true });
  const result = await connectCustomerAirtable(SYNTHETIC_PAT, setup.dependencies);
  assert.deepEqual(result, { ok: false, error: "Airtable could not be connected. Please try again." });
  assert.deepEqual(setup.calls, [
    "authenticate",
    `find:${USER_A}`,
    `insert:${USER_A}`,
    `cleanup:${USER_A}:${setup.metadata()?.id}`,
  ]);
});

test("D3.1 authenticated Server Action is bounded and has no credential route/query/header API", async () => {
  const [action, customerConnection] = await Promise.all([
    readFile("app/actions/airtable-connections.ts", "utf8"),
    readFile("lib/connectors/airtable/customer-connection.ts", "utf8"),
  ]);
  assert.match(action, /^"use server"/);
  assert.match(customerConnection, /MAX_AIRTABLE_PAT_BYTES = 512/);
  assert.match(customerConnection, /getAuthenticatedUserId\(\)/);
  assert.doesNotMatch(action, /Request|headers|searchParams|URLSearchParams/);
  assert.doesNotMatch(customerConnection, /request\.json|request\.text|headers|get\("authorization"\)/i);
});

test("D3.1 connect boundary does not log, analyze, or serialize credential material", async () => {
  const sources = await Promise.all([
    readFile("app/actions/airtable-connections.ts", "utf8"),
    readFile("lib/connectors/airtable/customer-connection.ts", "utf8"),
    readFile("components/connections-list.tsx", "utf8"),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /console\.|logger\(|analytics|trackEvent|captureEvent|localStorage|sessionStorage/);
  }
  assert.doesNotMatch(sources[1], /safe_metadata:[\s\S]{0,180}(?:plaintext|personalAccessToken|credential)/);
});

test("D3.1 disconnect remains authenticated, owner-scoped, and destroys vault access", async () => {
  const [action, vault] = await Promise.all([
    readFile("app/actions/connections.ts", "utf8"),
    readFile("lib/connectors/connection-vault.ts", "utf8"),
  ]);
  assert.match(action, /if \(!user\) return \{ ok: false as const, error: "Unauthorized" \}/);
  assert.match(action, /revokeConnection\(user\.id, parsed\.data\)/);
  assert.match(vault, /assertOwnedConnection\(userId, connectionId\)/);
  assert.match(vault, /\.eq\("id", connectionId\)\.eq\("user_id", userId\)/);
  assert.match(vault, /connector_connection_credentials"\)\.delete\(\)\.eq\("connection_id", connectionId\)\.eq\("user_id", userId\)/);
  assert.match(vault, /status: "revoked", granted_scopes: \[\]/);
});

test("D3.1 connection view includes safe Airtable state and preserves existing providers", async () => {
  const view = await readFile("lib/connectors/connection-view.ts", "utf8");
  assert.match(view, /"airtable" \| "google" \| "slack" \| "notion"/);
  assert.match(view, /fallbackLabel: "Airtable connection"/);
  assert.match(view, /verification: provider === "airtable" \? "locally_configured" : "provider_verified"/);
  assert.match(view, /if \(provider === "airtable"\) return details\.fallbackLabel/);
  for (const provider of ["google", "slack", "notion"]) {
    assert.match(view, new RegExp(`${provider}: \\{`));
  }
  assert.doesNotMatch(view, /ciphertext|nonce|auth_tag|credential_key|credential_type/);
});

test("D3.1 Connections UI uses a password field, clears it, and states local verification truthfully", async () => {
  const [component, dashboard] = await Promise.all([
    readFile("components/connections-list.tsx", "utf8"),
    readFile("components/automation-workspace.tsx", "utf8"),
  ]);
  assert.match(component, /type="password"/);
  assert.match(component, /autoComplete="off"/);
  assert.match(component, /maxLength=\{512\}/);
  assert.match(component, /setAirtablePat\(""\)/);
  assert.match(component, /locally configured until its first action runs/);
  assert.doesNotMatch(component, /token suffix|token prefix|last four/i);
  assert.match(dashboard, /connection\.verification === "locally_configured"/);
  assert.match(dashboard, /● Configured/);
});

test("D3.1 database boundary enforces one active Airtable connection per owner", async () => {
  const migration = await readFile("supabase/migrations/20260822000100_d31_customer_airtable_connections.sql", "utf8");
  assert.match(migration, /unique index/);
  assert.match(migration, /on public\.connector_connections \(user_id\)/);
  assert.match(migration, /connector_id = 'airtable'/);
  assert.match(migration, /provider_family = 'airtable'/);
  assert.match(migration, /status <> 'revoked'/);
});

test("D3.1 connection safety remains intact after D3.2 test-only planner exposure", () => {
  assert.equal(CAPABILITY_REGISTRY.airtable.supported, false);
  const capability = CAPABILITY_REGISTRY["airtable.create_record"];
  assert.equal(capability.supported, true);
  assert.deepEqual(capability.executorVersions, { 1: "connector_runner" });
  assert.equal(capability.internalOnly, false);
  assert.equal(capability.plannerVisible, true);
  assert.equal(capability.availableInTest, true);
  assert.equal(capability.availableInProduction, false);
  const plan = planWorkflow("When an incoming webhook arrives, create a record in Airtable.");
  assert.equal(plan.status, "READY_TO_COMPILE");
  assert.equal(plan.destination?.capabilityId, "airtable.create_record");
});
