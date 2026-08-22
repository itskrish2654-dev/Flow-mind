import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { CAPABILITY_REGISTRY } from "../lib/capability-registry";
import { listCustomerConnectors } from "../lib/connectors/registry";
import {
  AirtableProvisioningError,
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

function dependencyFixture(options: {
  existing?: boolean;
  storeFailure?: boolean;
  cleanupOutcome?: "deleted" | "revoked";
  cleanupFailure?: boolean;
} = {}) {
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
        if (options.cleanupFailure) throw new Error(`cleanup failed ${PAT}`);
        exists = false;
        return options.cleanupOutcome ?? "deleted";
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

test("D2.2 vault failure records successful exact DELETE cleanup and returns no PAT", async () => {
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

test("D2.2 DELETE failure records a verified revoke fallback as cleanup success", async () => {
  const fixture = dependencyFixture({ storeFailure: true, cleanupOutcome: "revoked" });
  await assert.rejects(
    provisionAirtableConnection(Buffer.from(PAT), {
      environment: environment(),
      dependencies: fixture.dependencies,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AirtableProvisioningError);
      assert.equal(error.cleanupOutcome, "revoked");
      assert.doesNotMatch(error.message, new RegExp(PAT));
      return true;
    },
  );
  assert.equal(fixture.calls.cleanups.length, 1);
});

test("D2.2 DELETE and revoke failure is internally reported as failed cleanup", async () => {
  const fixture = dependencyFixture({ storeFailure: true, cleanupFailure: true });
  const captured: unknown[] = [];
  const original = { error: console.error, warn: console.warn, info: console.info, log: console.log };
  console.error = (...values) => { captured.push(values); };
  console.warn = (...values) => { captured.push(values); };
  console.info = (...values) => { captured.push(values); };
  console.log = (...values) => { captured.push(values); };
  try {
    await assert.rejects(
      provisionAirtableConnection(Buffer.from(PAT), {
        environment: environment(),
        dependencies: fixture.dependencies,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AirtableProvisioningError);
        assert.equal(error.cleanupOutcome, "failed");
        assert.doesNotMatch(error.message, new RegExp(PAT));
        return true;
      },
    );
  } finally {
    Object.assign(console, original);
  }
  assert.equal(fixture.calls.cleanups.length, 1);
  assert.doesNotMatch(JSON.stringify(captured), new RegExp(PAT));

  const routeFixture = dependencyFixture({ storeFailure: true, cleanupFailure: true });
  const response = await handleAirtableProvisionPost(request(), {
    environment: environment(),
    dependencies: routeFixture.dependencies,
  });
  assert.equal(response.status, 409);
  const body = await response.text();
  assert.equal(body, JSON.stringify({ ok: false, error: "Provisioning failed" }));
  assert.doesNotMatch(body, new RegExp(PAT));
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

test("D2.3 Dockerfile assigns restrictive copied sources to the node runtime user", () => {
  const dockerfile = readFileSync(
    join(process.cwd(), "services", "connector-runner", "Dockerfile"),
    "utf8",
  );
  const base = dockerfile.indexOf("FROM node:22-alpine");
  const packageCopy = dockerfile.indexOf("COPY --chown=node:node package.json ./package.json");
  const sourceCopy = dockerfile.indexOf("COPY --chown=node:node src ./src");
  const runtimeUser = dockerfile.indexOf("USER node");
  assert.ok(base >= 0 && packageCopy > base && sourceCopy > packageCopy && runtimeUser > sourceCopy);
  assert.doesNotMatch(dockerfile, /^COPY (?:package\.json|src)/m);
  assert.doesNotMatch(dockerfile, /USER root|chmod\s+(?:777|o\+w)/);
});

test("D2.3 runbook verifies runtime readability before execution is enabled", () => {
  const runbook = readFileSync(
    join(process.cwd(), "docs", "connector-runner", "D2_AIRTABLE_ACCEPTANCE.md"),
    "utf8",
  );
  const build = runbook.indexOf("docker build --pull");
  const permissionProbe = runbook.indexOf("test -r /runner/src/index.mjs");
  const importProbe = runbook.indexOf('await import("./src/adapters/airtable.mjs")');
  const replace = runbook.indexOf("docker stop crazyloops-connector-runner");
  const publicUnsigned = runbook.indexOf("https://runner.crazy-loops.com/v1/execute");
  const enabled = runbook.indexOf("CONNECTOR_RUNNER_EXECUTION_ENABLED=true");
  const finalDisabled = runbook.lastIndexOf("CONNECTOR_RUNNER_EXECUTION_ENABLED=false");
  assert.ok(
    build >= 0 &&
    permissionProbe > build &&
    importProbe > permissionProbe &&
    replace > importProbe &&
    publicUnsigned > replace &&
    enabled > publicUnsigned,
  );
  assert.ok(finalDisabled > enabled);
  assert.match(runbook, /crazyloops-connector-runner:d23-\$\{CURRENT_SHA\}/);
  assert.match(runbook, /OLD_RUNNER_IMAGE_ID/);
  assert.match(runbook, /old image; do not overwrite its tag or delete it/i);
  assert.match(runbook, /test "\$\(id -un\)" = "node"/);
  assert.match(runbook, /test -r \/runner\/src\/index\.mjs/);
  assert.match(runbook, /test -r \/runner\/src\/runner\.mjs/);
  assert.match(runbook, /test -x \/runner\/src\/adapters/);
  assert.match(runbook, /test -r \/runner\/src\/adapters\/airtable\.mjs/);
  assert.match(runbook, /runnerModule\.CANARY_CAPABILITY !== "internal\.connector_runner_canary"/);
  assert.match(runbook, /AIRTABLE_CREATE_RECORD_VERSION !== 1/);
  assert.doesNotMatch(runbook, /docker run[^\n]*--user\s+root/);
  assert.match(runbook, /127\.0\.0\.1:8788:8788/);
  assert.match(runbook, /http:\/\/127\.0\.0\.1:8788\/v1\/execute/);
  assert.match(runbook, /public\s+unsigned POST `401`/i);
  assert.match(runbook, /Do not restart Redis or Activepieces/);
  assert.match(runbook, /Do not edit\/restart Cloudflare/);
  assert.doesNotMatch(runbook, /docker restart (?:redis|activepieces)/);
  assert.doesNotMatch(runbook, /systemctl restart cloudflared/);
});

test("D2.2 cleanup implementation constrains DELETE and verifies revoke fallback", () => {
  const source = readFileSync(
    join(process.cwd(), "lib", "operations", "airtable-provision.ts"),
    "utf8",
  );
  const cleanup = source.slice(source.indexOf("async cleanupConnection"), source.indexOf("async function readBoundedPat"));
  assert.match(cleanup, /\.delete\(\)[\s\S]*\.eq\("id", connectionId\)[\s\S]*\.eq\("user_id", userId\)[\s\S]*\.eq\("connector_id", "airtable"\)[\s\S]*\.eq\("external_account_id", externalAccountId\)/);
  assert.match(cleanup, /if \(!deleteError\) return "deleted"/);
  assert.match(cleanup, /status: "revoked", granted_scopes: \[\], updated_at: revokedAt/);
  assert.match(cleanup, /\.select\("id,status,granted_scopes,updated_at"\)[\s\S]*\.maybeSingle\(\)/);
  assert.match(cleanup, /revokeError[\s\S]*data\.status !== "revoked"[\s\S]*data\.granted_scopes\.length !== 0[\s\S]*data\.updated_at !== revokedAt/);
  assert.doesNotMatch(source, /captureOperationalEvent|operational_events|console\./);
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
