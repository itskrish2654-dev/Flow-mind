import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { CAPABILITY_REGISTRY } from "../lib/capability-registry";
import { listCustomerConnectors } from "../lib/connectors/registry";
import {
  handleAirtableProvisionPost,
  provisionAirtableConnection,
} from "../lib/operations/airtable-provision";

const USER_A = "10000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "30000000-0000-4000-8000-000000000003";
const PAT = "patD21DisposableCredentialForAutomatedTests123456789";
const PROVISION_SECRET = "d21-provision-operator-secret".padEnd(64, "p");
const ACCEPTANCE_SECRET = "d21-acceptance-operator-secret".padEnd(64, "a");

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    D2_AIRTABLE_PROVISION_ENABLED: "true",
    D2_AIRTABLE_PROVISION_SECRET: PROVISION_SECRET,
    D2_AIRTABLE_ACCEPTANCE_ENABLED: "true",
    D2_AIRTABLE_ACCEPTANCE_SECRET: ACCEPTANCE_SECRET,
    D2_AIRTABLE_ACCEPTANCE_OWNER_ID: USER_A,
    D2_AIRTABLE_ACCEPTANCE_CONNECTION_ID: CONNECTION_ID,
    CONNECTOR_RUNNER_SECRET: "independent-runner-secret".padEnd(64, "r"),
    CONNECTOR_RUNNER_WRAP_KEY_V1: Buffer.alloc(32, 7).toString("base64"),
    CRON_SECRET: "independent-cron-secret".padEnd(64, "c"),
    ...overrides,
  };
}

function request(input: {
  secret?: string;
  body?: string;
  contentType?: string;
  query?: string;
} = {}) {
  return new Request(`https://example.test/api/operations/connector-runner-airtable-provision${input.query ?? ""}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.secret ?? PROVISION_SECRET}`,
      "Content-Type": input.contentType ?? "application/octet-stream",
    },
    body: input.body ?? PAT,
  });
}

function dependencyFixture(options: { existing?: boolean; storeFailure?: boolean } = {}) {
  const calls = {
    finds: [] as string[],
    inserts: [] as Array<Record<string, unknown>>,
    stores: [] as Array<Record<string, unknown>>,
    cleanups: [] as Array<Record<string, unknown>>,
  };
  let exists = options.existing ?? false;
  return {
    calls,
    dependencies: {
      async findConnection(connectionId: string) {
        calls.finds.push(connectionId);
        return exists ? { id: connectionId } : null;
      },
      async insertConnection(metadata: Record<string, unknown>) {
        calls.inserts.push(metadata);
        exists = true;
      },
      async storeSecret(secret: Record<string, unknown>) {
        calls.stores.push(secret);
        if (options.storeFailure) throw new Error(`vault failed ${PAT}`);
      },
      async cleanupConnection(input: Record<string, unknown>) {
        calls.cleanups.push(input);
        exists = false;
      },
    },
  };
}

test("D2.1 provisioner is disabled by default and rejects unauthorized callers before work", async () => {
  const fixture = dependencyFixture();
  const disabled = await handleAirtableProvisionPost(request(), {
    environment: environment({ D2_AIRTABLE_PROVISION_ENABLED: "false" }),
    dependencies: fixture.dependencies,
  });
  assert.equal(disabled.status, 401);
  const unauthorized = await handleAirtableProvisionPost(request({ secret: "wrong".padEnd(64, "x") }), {
    environment: environment(),
    dependencies: fixture.dependencies,
  });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(fixture.calls, { finds: [], inserts: [], stores: [], cleanups: [] });
});

test("D2.1 provision secret must be long, dedicated, and independent", async () => {
  for (const badEnvironment of [
    environment({ D2_AIRTABLE_PROVISION_SECRET: "short" }),
    environment({ D2_AIRTABLE_PROVISION_SECRET: ACCEPTANCE_SECRET }),
    environment({ D2_AIRTABLE_PROVISION_SECRET: "independent-runner-secret".padEnd(64, "r") }),
    environment({ D2_AIRTABLE_PROVISION_SECRET: Buffer.alloc(32, 7).toString("base64") }),
    environment({ D2_AIRTABLE_PROVISION_SECRET: "independent-cron-secret".padEnd(64, "c") }),
  ]) {
    const fixture = dependencyFixture();
    const response = await handleAirtableProvisionPost(request({
      secret: badEnvironment.D2_AIRTABLE_PROVISION_SECRET,
    }), { environment: badEnvironment, dependencies: fixture.dependencies });
    assert.equal(response.status, 401);
    assert.equal(fixture.calls.finds.length, 0);
  }
});

test("D2.1 successful provisioning uses exact server-owned metadata and vault projection", async () => {
  const fixture = dependencyFixture();
  const response = await handleAirtableProvisionPost(request(), {
    environment: environment(),
    dependencies: fixture.dependencies,
  });
  assert.equal(response.status, 200);
  const responseBody = await response.text();
  assert.deepEqual(JSON.parse(responseBody), { ok: true, connectionId: CONNECTION_ID });
  assert.deepEqual(fixture.calls.inserts, [{
    id: CONNECTION_ID,
    user_id: USER_A,
    connector_id: "airtable",
    provider_family: "airtable",
    external_account_id: `d2-airtable:${CONNECTION_ID}`,
    external_account_label: "D2 controlled acceptance",
    auth_type: "api_key",
    status: "connected",
    granted_scopes: ["data.records:write"],
    safe_metadata: { internalAcceptance: "d2" },
  }]);
  assert.deepEqual(fixture.calls.stores, [{
    userId: USER_A,
    connectionId: CONNECTION_ID,
    credentialKey: "api_key",
    credentialType: "api_key",
    plaintext: PAT,
  }]);
  assert.equal(fixture.calls.cleanups.length, 0);
  assert.doesNotMatch(responseBody, new RegExp(PAT));
});

test("D2.1 caller cannot override owner, connection, connector, provider, scope, or auth", async () => {
  const fixture = dependencyFixture();
  const queryResponse = await handleAirtableProvisionPost(request({
    query: "?ownerId=attacker&connectorId=slack&scope=admin",
  }), { environment: environment(), dependencies: fixture.dependencies });
  assert.equal(queryResponse.status, 400);
  assert.equal(fixture.calls.inserts.length, 0);

  const jsonResponse = await handleAirtableProvisionPost(request({
    contentType: "application/json",
    body: JSON.stringify({ token: PAT, ownerId: "attacker", authType: "oauth2" }),
  }), { environment: environment(), dependencies: fixture.dependencies });
  assert.equal(jsonResponse.status, 400);
  assert.equal(fixture.calls.inserts.length, 0);
});

test("D2.1 existing connection is never overwritten and repeated provisioning fails closed", async () => {
  const existing = dependencyFixture({ existing: true });
  const blocked = await handleAirtableProvisionPost(request(), {
    environment: environment(), dependencies: existing.dependencies,
  });
  assert.equal(blocked.status, 409);
  assert.equal(existing.calls.inserts.length, 0);
  assert.equal(existing.calls.stores.length, 0);

  const once = dependencyFixture();
  const first = await handleAirtableProvisionPost(request(), {
    environment: environment(), dependencies: once.dependencies,
  });
  const second = await handleAirtableProvisionPost(request(), {
    environment: environment(), dependencies: once.dependencies,
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(once.calls.inserts.length, 1);
  assert.equal(once.calls.stores.length, 1);
});

test("D2.1 vault failure cleans up the exact disposable connection and returns no PAT", async () => {
  const fixture = dependencyFixture({ storeFailure: true });
  const captured: unknown[] = [];
  const original = { error: console.error, warn: console.warn, info: console.info, log: console.log };
  console.error = (...values) => { captured.push(values); };
  console.warn = (...values) => { captured.push(values); };
  console.info = (...values) => { captured.push(values); };
  console.log = (...values) => { captured.push(values); };
  try {
    const response = await handleAirtableProvisionPost(request(), {
      environment: environment(), dependencies: fixture.dependencies,
    });
    assert.equal(response.status, 409);
    const body = await response.text();
    assert.equal(body, JSON.stringify({ ok: false, error: "Provisioning failed" }));
    assert.doesNotMatch(body, new RegExp(PAT));
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(fixture.calls.cleanups, [{
    userId: USER_A,
    connectionId: CONNECTION_ID,
    externalAccountId: `d2-airtable:${CONNECTION_ID}`,
  }]);
  assert.doesNotMatch(JSON.stringify(captured), new RegExp(PAT));
});

test("D2.1 mutable PAT buffer is zeroized after the unavoidable transient vault string", async () => {
  const fixture = dependencyFixture();
  const credential = Buffer.from(PAT, "utf8");
  await provisionAirtableConnection(credential, {
    environment: environment(), dependencies: fixture.dependencies,
  });
  assert.equal(credential.every((byte) => byte === 0), true);
});

test("D2.1 runbook explicitly opens and closes the temporary runner window", () => {
  const runbook = readFileSync(
    join(process.cwd(), "docs", "connector-runner", "D2_AIRTABLE_ACCEPTANCE.md"),
    "utf8",
  );
  assert.match(runbook, /CONNECTOR_RUNNER_EXECUTION_ENABLED=true/);
  assert.match(runbook, /CONNECTOR_RUNNER_EXECUTION_ENABLED=false/);
  assert.match(runbook, /DELEGATED_EXECUTION_ENABLED=true/);
  assert.match(runbook, /Do not change that flag during D2/);
  assert.match(runbook, /never paste any secret into chat/i);
  assert.match(runbook, /PLAINTEXT_PAT_PERSISTENCE_OCCURRENCES/);
});

test("D2.1 customer isolation and accepted executor paths remain unchanged", () => {
  assert.equal(CAPABILITY_REGISTRY.airtable.supported, false);
  const capability = CAPABILITY_REGISTRY["airtable.create_record"];
  assert.equal(capability.internalOnly, true);
  assert.equal(capability.plannerVisible, false);
  assert.equal(capability.availableInProduction, false);
  assert.equal(listCustomerConnectors().some(({ id }) => id === "airtable"), false);

  const runner = readFileSync(join(process.cwd(), "services", "connector-runner", "src", "runner.mjs"), "utf8");
  const activepieces = readFileSync(join(process.cwd(), "lib", "executors", "activepieces.ts"), "utf8");
  const router = readFileSync(join(process.cwd(), "lib", "executors", "router.ts"), "utf8");
  assert.match(runner, /internal\.connector_runner_canary/);
  assert.match(activepieces, /class ActivepiecesExecutor/);
  assert.equal(CAPABILITY_REGISTRY["internal.bridge_echo"].executorVersions[1], "activepieces");
  assert.match(router, /selection\.kind === "native"/);
});
