import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CAPABILITY_REGISTRY } from "../lib/capability-registry";
import {
  buildMyDayData,
  indexCredentialMetadata,
  MY_DAY_LIMITS,
  selectedConnectionIdsFromWorkflows,
  type BuildMyDayInput,
  type MyDayExecutionCandidate,
  type MyDayWorkflowCandidate,
} from "../lib/my-day-model";
import type { CompiledWorkflow } from "../lib/schemas/workflow";

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const workflowA = "00000000-0000-4000-8000-000000000010";
const connectionA = "00000000-0000-4000-8000-000000000020";
const now = "2026-09-09T10:00:00.000Z";

function compiledStep(
  capabilityId = "flowmind_data_store",
  type: CompiledWorkflow["steps"][number]["type"] = "store_data",
  config?: CompiledWorkflow["steps"][number]["config"],
): CompiledWorkflow {
  return {
    workflowName: "Candidate follow-up",
    summary: "A truthful workflow fixture.",
    steps: [{
      id: "step-1",
      type,
      capabilityId,
      title: "Complete the step",
      description: "Completes one supported step.",
      ...(config ? { config } : {}),
    }],
  };
}

function workflow(overrides: Partial<MyDayWorkflowCandidate> = {}): MyDayWorkflowCandidate {
  return {
    id: workflowA,
    userId: userA,
    name: "Candidate follow-up",
    lifecycleState: "disabled",
    updatedAt: now,
    workflow: compiledStep(),
    setupConfig: {},
    configuredCredentialKeys: [],
    credentialMetadataComplete: true,
    ...overrides,
  };
}

function execution(overrides: Partial<MyDayExecutionCandidate> = {}): MyDayExecutionCandidate {
  return {
    id: "00000000-0000-4000-8000-000000000030",
    userId: userA,
    workflowId: workflowA,
    status: "succeeded",
    triggerType: "manual",
    createdAt: now,
    completedAt: now,
    failureCategory: null,
    ...overrides,
  };
}

function input(overrides: Partial<BuildMyDayInput> = {}): BuildMyDayInput {
  return { userId: userA, workflows: [workflow()], executions: [], connections: [], ...overrides };
}

test("Phase 6A authenticates server-side and scopes every data source to the authenticated identity", async () => {
  const server = await readFile("lib/my-day.ts", "utf8");
  const page = await readFile("app/my-day/page.tsx", "utf8");
  const proxy = await readFile("lib/supabase/proxy.ts", "utf8");
  assert.match(server, /getAuthenticatedContext\(\)/);
  assert.ok((server.match(/\.eq\("user_id", userId\)/g) ?? []).length >= 5);
  assert.doesNotMatch(server, /input_data|output_data|ciphertext|nonce|auth_tag/);
  assert.match(page, /redirect\("\/login\?next=\/my-day"\)/);
  assert.match(proxy, /startsWith\("\/my-day"\)/);
});

test("Phase 6A drops cross-user workflows and executions even after the database boundary", () => {
  const otherWorkflow = workflow({ id: "00000000-0000-4000-8000-000000000099", userId: userB, name: "Private B workflow" });
  const otherExecution = execution({ id: "00000000-0000-4000-8000-000000000098", userId: userB });
  const result = buildMyDayData(input({
    workflows: [workflow(), otherWorkflow],
    executions: [execution(), otherExecution],
  }));
  assert.equal(JSON.stringify(result).includes("Private B workflow"), false);
  assert.equal(result.recentActivity.length, 1);
});

test("Phase 6A Needs You reflects real readiness blockers without inventing attention for healthy workflows", () => {
  const blocked = workflow({
    workflow: compiledStep("http.request", "http_request"),
    name: "Call candidate API",
  });
  const blockedResult = buildMyDayData(input({ workflows: [blocked] }));
  assert.ok(blockedResult.needsYou.some((item) => /destination|endpoint/i.test(`${item.title} ${item.description}`)));

  const healthyResult = buildMyDayData(input());
  assert.equal(healthyResult.needsYou.length, 0);
  assert.equal(healthyResult.today[0]?.title, "Ready to test");
});

test("Phase 6A keeps HubSpot TEST_ONLY testable while activation remains visibly blocked", () => {
  const hubspot = workflow({
    name: "Look up contact",
    workflow: compiledStep("hubspot.get_contact", "connector_action", {
      connector: {
        connectorId: "hubspot",
        operationKind: "action",
        operationKey: "get_contact",
        operationVersion: 1,
        connectionId: connectionA,
        mappings: [],
      },
    }),
    setupConfig: { "step-1-contactId": "123", "step-1-properties": "email,firstname" },
  });
  const result = buildMyDayData(input({
    workflows: [hubspot],
    connections: [{ id: connectionA, userId: userA, provider: "hubspot", status: "connected" }],
  }));
  assert.equal(result.today[0]?.title, "Ready to test");
  assert.ok(result.needsYou.some((item) => /test-only/i.test(item.title)));
});

test("Phase 6A retains an older selected connection beyond the recent connection cutoff", async () => {
  const hubspot = workflow({
    name: "Look up contact",
    workflow: compiledStep("hubspot.get_contact", "connector_action", {
      connector: {
        connectorId: "hubspot",
        operationKind: "action",
        operationKey: "get_contact",
        operationVersion: 1,
        connectionId: connectionA,
        mappings: [],
      },
    }),
    setupConfig: { "step-1-contactId": "123", "step-1-properties": "email" },
  });
  const newerConnections = Array.from({ length: MY_DAY_LIMITS.connections + 1 }, (_, index) => ({
    id: `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
    userId: userA,
    provider: "hubspot" as const,
    status: "connected" as const,
  }));
  const result = buildMyDayData(input({
    workflows: [hubspot],
    connections: [...newerConnections, { id: connectionA, userId: userA, provider: "hubspot", status: "connected" }],
  }));
  assert.equal(result.needsYou.some((item) => item.id.endsWith(":connection")), false);
  assert.deepEqual(selectedConnectionIdsFromWorkflows([hubspot.workflow]), [connectionA]);

  const server = await readFile("lib/my-day.ts", "utf8");
  assert.match(server, /\.in\("id", selectedConnectionIds\)/);
  assert.match(server, /\.limit\(MY_DAY_LIMITS\.selectedConnections\)/);
});

test("Phase 6A never lets another user's connection satisfy an exact workflow binding", () => {
  const alternativeConnection = "00000000-0000-4000-8000-000000000021";
  const hubspot = workflow({
    workflow: compiledStep("hubspot.get_contact", "connector_action", {
      connector: {
        connectorId: "hubspot",
        operationKind: "action",
        operationKey: "get_contact",
        operationVersion: 1,
        connectionId: connectionA,
        mappings: [],
      },
    }),
    setupConfig: { "step-1-contactId": "123", "step-1-properties": "email" },
  });
  const result = buildMyDayData(input({
    workflows: [hubspot],
    connections: [
      { id: connectionA, userId: userB, provider: "hubspot", status: "connected" },
      { id: alternativeConnection, userId: userA, provider: "hubspot", status: "connected" },
    ],
  }));
  assert.ok(result.needsYou.some((item) => item.id.endsWith(":connection")));
});

test("Phase 6A scopes credential metadata to displayed workflows and rejects foreign metadata", async () => {
  const unrelated = Array.from({ length: MY_DAY_LIMITS.credentials + 25 }, (_, index) => ({
    userId: userA,
    workflowId: `unrelated-${index}`,
    connectorId: "http.request",
    credentialKey: `key-${index}`,
  }));
  const indexed = indexCredentialMetadata({
    userId: userA,
    workflowIds: new Set([workflowA]),
    credentials: [
      ...unrelated,
      { userId: userA, workflowId: workflowA, connectorId: "http.request", credentialKey: "apiKey" },
      { userId: userB, workflowId: workflowA, connectorId: "http.request", credentialKey: "foreignKey" },
    ],
  });
  assert.deepEqual(indexed.get(workflowA), ["http.request:apiKey"]);
  assert.equal(indexed.size, 1);

  const server = await readFile("lib/my-day.ts", "utf8");
  assert.match(server, /\.from\("workflow_credentials"\)[\s\S]*?\.eq\("user_id", userId\)[\s\S]*?\.in\("workflow_id", workflowIds\)/);
  assert.match(server, /MY_DAY_LIMITS\.credentialPages/);
  assert.match(server, /complete: overflow\.length === 0/);
  assert.doesNotMatch(server, /select\("[^"]*(?:ciphertext|nonce|auth_tag|plaintext|access_token|refresh_token)/i);
});

test("Phase 6A fails closed without falsely claiming a credential is missing when metadata is incomplete", () => {
  const secured = compiledStep("http.request", "http_request", {
    http: {
      version: 2,
      url: "https://example.com/callback",
      method: "POST",
      authType: "api_key_header",
      authName: "X-API-Key",
    },
  });
  secured.steps[0].inputsRequired = [{
    key: "apiKey",
    label: "Private key",
    type: "secret",
    required: true,
  }];
  const result = buildMyDayData(input({
    workflows: [workflow({ workflow: secured, credentialMetadataComplete: false })],
  }));
  assert.ok(result.needsYou.some((item) => item.title === "Confirm saved security setup"));
  assert.equal(result.needsYou.some((item) => /add private key/i.test(item.title)), false);
  assert.equal(result.summary.readyToTestCount, 0);
});

test("Phase 6A never presents REVIEWED connectors as usable or connectable", () => {
  const reviewedCapabilities = [
    "gmail_send_email",
    "google_sheets_add_row",
    "slack_send_channel_message",
    "notion_create_page",
  ] as const;
  for (const capabilityId of reviewedCapabilities) {
    const capability = CAPABILITY_REGISTRY[capabilityId];
    const connector = capability.connectorOperation;
    assert.ok(connector);
    const candidate = workflow({
      workflow: compiledStep(capabilityId, "connector_action", {
        connector: {
          connectorId: connector.connectorId,
          operationKind: "action",
          operationKey: connector.operationKey,
          operationVersion: connector.operationVersion,
          mappings: [],
        },
      }),
    });
    const result = buildMyDayData(input({ workflows: [candidate] }));
    assert.equal(result.today.some((item) => item.title === "Ready to test"), false, capabilityId);
    assert.ok(result.needsYou.some((item) => /not available/i.test(item.title)), capabilityId);
    assert.equal(result.needsYou.some((item) => /^Connect /i.test(item.cta.label)), false, capabilityId);
  }
});

test("Phase 6A excludes unsupported workflows from ready work", () => {
  const unsupported = workflow({ workflow: compiledStep("rss_ingestion", "connector_trigger") });
  const result = buildMyDayData(input({ workflows: [unsupported] }));
  assert.equal(result.today.length, 0);
  assert.ok(result.needsYou.some((item) => /not available/i.test(item.title)));
});

test("Phase 6A Waiting On uses only real durable queued executions", () => {
  const empty = buildMyDayData(input({ executions: [execution({ status: "running" })] }));
  assert.equal(empty.waitingOn.length, 0);

  const queued = buildMyDayData(input({ executions: [execution({ status: "queued", completedAt: null })] }));
  assert.equal(queued.waitingOn.length, 1);
  assert.match(queued.waitingOn[0]?.description ?? "", /durably queued/i);
});

test("Phase 6A presents cancelled executions as cancelled rather than failed", () => {
  const result = buildMyDayData(input({ executions: [execution({ status: "cancelled" })] }));
  assert.equal(result.recentActivity[0]?.status, "cancelled");
  assert.equal(result.recentActivity[0]?.title, "Run cancelled");
});

test("Phase 6A counts all relevant attention before applying the display limit", () => {
  const workflows = Array.from({ length: MY_DAY_LIMITS.needsYou + 4 }, (_, index) => workflow({
    id: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
    name: `HTTP workflow ${index}`,
    workflow: compiledStep("http.request", "http_request"),
  }));
  const result = buildMyDayData(input({ workflows }));
  assert.equal(result.needsYou.length, MY_DAY_LIMITS.needsYou);
  assert.equal(result.summary.attentionCount, workflows.length);
  assert.match(result.summary.sentence, new RegExp(`${workflows.length} things need you`));
});

test("Phase 6A activity is bounded, newest first, and cannot surface raw secret payloads", () => {
  const executions = Array.from({ length: 14 }, (_, index) => ({
    ...execution({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      createdAt: `2026-09-09T${String(index).padStart(2, "0")}:00:00.000Z`,
      completedAt: `2026-09-09T${String(index).padStart(2, "0")}:01:00.000Z`,
    }),
    rawProviderPayload: { access_token: "should-never-appear" },
  }));
  const result = buildMyDayData(input({ executions }));
  assert.equal(result.recentActivity.length, MY_DAY_LIMITS.recentActivity);
  assert.equal(result.recentActivity[0]?.timestamp, "2026-09-09T13:01:00.000Z");
  assert.equal(JSON.stringify(result).includes("should-never-appear"), false);
  assert.equal(JSON.stringify(result).includes("access_token"), false);
});

test("Phase 6A capability truth preserves Step 5D maturity", () => {
  assert.equal(CAPABILITY_REGISTRY.gmail_new_email.maturity, "REVIEWED");
  assert.equal(CAPABILITY_REGISTRY.google_sheets_add_row.maturity, "REVIEWED");
  assert.equal(CAPABILITY_REGISTRY.slack_new_channel_message.maturity, "REVIEWED");
  assert.equal(CAPABILITY_REGISTRY.notion_page_created_or_added.maturity, "REVIEWED");
  assert.equal(CAPABILITY_REGISTRY["hubspot.get_contact"].maturity, "TEST_ONLY");
  assert.equal(CAPABILITY_REGISTRY["airtable.create_record"].maturity, "AVAILABLE");
});

test("Phase 6A UI exposes the required calm workday sections, navigation, and real destinations", async () => {
  const [view, start, dashboardNav, settingsNav] = await Promise.all([
    readFile("components/my-day/my-day-view.tsx", "utf8"),
    readFile("components/my-day/start-my-day.tsx", "utf8"),
    readFile("app/dashboard/layout.tsx", "utf8"),
    readFile("components/settings-shell.tsx", "utf8"),
  ]);
  for (const label of ["Needs You", "Today", "Waiting On", "Recent Activity", "Automate This"]) {
    assert.match(view, new RegExp(label));
  }
  assert.match(start, /Start My Day/);
  assert.match(view, /href="\/dashboard"/);
  assert.match(dashboardNav, /href="\/my-day"/);
  assert.match(settingsNav, /href="\/my-day"/);
  assert.doesNotMatch(`${view}\n${start}`, /fake workflow|sample activity|mock data/i);
});

test("Phase 6A query bounds are explicit and aggregation avoids per-workflow query loops", async () => {
  const server = await readFile("lib/my-day.ts", "utf8");
  assert.match(server, /Promise\.all\(\[/);
  assert.ok((server.match(/\.limit\(MY_DAY_LIMITS\./g) ?? []).length >= 5);
  assert.match(server, /\.in\("id", versionIds\)/);
  assert.match(server, /\.in\("id", selectedConnectionIds\)/);
  assert.match(server, /\.in\("workflow_id", workflowIds\)/);
  assert.doesNotMatch(server, /for \([^)]*workflow[^)]*\)[\s\S]{0,240}\.from\(/);
});
