import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CAPABILITY_REGISTRY } from "../lib/capability-registry";
import {
  AIRTABLE_CREATE_RECORD_SCOPE,
  AirtableProviderVerificationError,
  type AirtableProviderVerificationDependencies,
  type AirtableTestVerificationInput,
  verifyAirtableCustomerTestExecution,
} from "../lib/connectors/airtable/provider-verification";
import type { CapabilityExecutionResult } from "../lib/executors/types";
import { compileReadyPlan } from "../lib/workflow-compiler";
import { executeWorkflowSteps } from "../lib/workflow-execution";
import { planWorkflow } from "../lib/workflow-planner";

const USER_A = "10000000-0000-4000-8000-000000000001";
const USER_B = "20000000-0000-4000-8000-000000000002";
const CONNECTION_ID = "30000000-0000-4000-8000-000000000003";
const WORKFLOW_ID = "40000000-0000-4000-8000-000000000004";
const VERSION_ID = "50000000-0000-4000-8000-000000000005";
const EXECUTION_ID = "60000000-0000-4000-8000-000000000006";
const RECORD_ID = "rec12345678901234";
const BASE_ID = "app12345678901234";
const TABLE_ID = "tbl12345678901234";
const SYNTHETIC_PAT = "patD33SyntheticCredentialNeverPersisted";
const VERIFIED_AT = "2026-08-23T12:00:00.000Z";

function configuredWorkflow() {
  const plan = planWorkflow("When a form is submitted, create a record in Airtable.");
  assert.equal(plan.status, "READY_TO_COMPILE");
  const workflow = compileReadyPlan("When a form is submitted, create a record in Airtable.", plan);
  const step = workflow.steps.find((item) => item.capabilityId === "airtable.create_record");
  assert.ok(step?.config?.connector);
  const steps = workflow.steps.map((item) => item.id === step.id
    ? {
        ...item,
        config: {
          ...item.config,
          connector: { ...item.config!.connector!, connectionId: CONNECTION_ID },
        },
      }
    : item);
  return { workflow, step, steps };
}

async function executeAirtable(result: CapabilityExecutionResult, overrides: {
  baseId?: string;
  onRetryable?: (value: boolean | undefined) => void;
} = {}) {
  const { workflow, step, steps } = configuredWorkflow();
  let calls = 0;
  const execution = await executeWorkflowSteps({
    userId: USER_A,
    workflowOwnerId: USER_A,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    telemetryExecutionId: EXECUTION_ID,
    workflowName: workflow.workflowName,
    steps,
    inputValues: {
      name: "Distinctive D3.3 value",
      [`${step.id}-baseId`]: overrides.baseId ?? BASE_ID,
      [`${step.id}-tableId`]: TABLE_ID,
      [`${step.id}-fields`]: '{"Name":"name"}',
    },
    mode: "test",
    delegatedExecutor: {
      kind: "connector_runner",
      async execute() {
        calls += 1;
        return result;
      },
    },
    stateHooks: {
      async onStepFinish(finishedStep, state) {
        if (finishedStep.id === step.id) overrides.onRetryable?.(state.retryable);
      },
    },
  });
  return { execution, calls, step };
}

function verificationInput(stepId: string): AirtableTestVerificationInput {
  return {
    userId: USER_A,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    executionId: EXECUTION_ID,
    stepId,
    connectionId: CONNECTION_ID,
    capabilityId: "airtable.create_record",
    mode: "TEST",
    acknowledged: true,
    providerReferenceId: RECORD_ID,
  };
}

function verificationFixture(stepId: string, overrides: {
  execution?: Record<string, unknown> | null;
  step?: Record<string, unknown> | null;
  connection?: Record<string, unknown> | null;
  persist?: boolean;
} = {}) {
  const calls = { persist: 0 };
  let persisted: Parameters<AirtableProviderVerificationDependencies["persistConnection"]>[0] | null = null;
  const execution = overrides.execution === null ? null : {
    id: EXECUTION_ID,
    user_id: USER_A,
    workflow_id: WORKFLOW_ID,
    workflow_version_id: VERSION_ID,
    trigger_type: "manual_test",
    status: "succeeded",
    ...(overrides.execution ?? {}),
  };
  const step = overrides.step === null ? null : {
    execution_id: EXECUTION_ID,
    workflow_step_id: stepId,
    status: "succeeded",
    provider_reference_id: RECORD_ID,
    sanitized_output_metadata: {
      capabilityId: "airtable.create_record",
      provider: "airtable",
      operation: "create_record",
      mode: "TEST",
      acknowledged: true,
    },
    ...(overrides.step ?? {}),
  };
  const connection = overrides.connection === null ? null : {
    id: CONNECTION_ID,
    user_id: USER_A,
    connector_id: "airtable",
    provider_family: "airtable",
    auth_type: "api_key",
    status: "connected",
    granted_scopes: [],
    safe_metadata: {
      connectionMode: "customer_api_key",
      providerVerification: "deferred",
    },
    updated_at: "2026-08-23T10:00:00.000Z",
    ...(overrides.connection ?? {}),
  };
  const dependencies: AirtableProviderVerificationDependencies = {
    loadExecution: async () => execution as never,
    loadStep: async () => step as never,
    loadConnection: async () => connection as never,
    async persistConnection(input) {
      calls.persist += 1;
      persisted = input;
      return overrides.persist ?? true;
    },
    now: () => new Date(VERIFIED_AT),
  };
  return { calls, dependencies, persisted: () => persisted };
}

test("D3.3 confirmed mocked TEST acknowledges one record and promotes only the proven write scope", async () => {
  const { execution, calls, step } = await executeAirtable({
    ok: true,
    acknowledged: true,
    output: { recordId: RECORD_ID },
  });
  assert.equal(calls, 1);
  assert.equal(execution.ok, true);
  assert.equal(execution.delivered, true);
  assert.deepEqual(execution.providerAcknowledgements, [{
    stepId: step.id,
    capabilityId: "airtable.create_record",
    connectionId: CONNECTION_ID,
    acknowledged: true,
    providerReferenceId: RECORD_ID,
  }]);

  const fixture = verificationFixture(step.id);
  const verified = await verifyAirtableCustomerTestExecution(
    verificationInput(step.id),
    fixture.dependencies,
  );
  assert.deepEqual(verified, { status: "verified", verifiedAt: VERIFIED_AT });
  assert.equal(fixture.calls.persist, 1);
  const persisted = fixture.persisted();
  assert.ok(persisted);
  assert.deepEqual(persisted.grantedScopes, [AIRTABLE_CREATE_RECORD_SCOPE]);
  assert.equal(persisted.safeMetadata.providerVerification, "operation_verified");
  assert.equal(persisted.safeMetadata.verifiedOperation, "airtable.create_record");
  assert.equal(persisted.safeMetadata.verifiedAt, VERIFIED_AT);
  assert.equal(persisted.safeMetadata.verifiedExecutionId, EXECUTION_ID);
  assert.equal(persisted.safeMetadata.verifiedWorkflowId, WORKFLOW_ID);
  assert.equal(persisted.safeMetadata.verifiedWorkflowVersionId, VERSION_ID);
  assert.equal(persisted.safeMetadata.verifiedStepId, step.id);
  const metadata = JSON.stringify(persisted.safeMetadata);
  for (const forbidden of [SYNTHETIC_PAT, BASE_ID, TABLE_ID, "Distinctive D3.3 value", RECORD_ID]) {
    assert.doesNotMatch(metadata, new RegExp(forbidden));
  }
});

for (const [label, result] of [
  ["401", { ok: false, errorCategory: "DELEGATED_AUTH_FAILED", retryable: false }],
  ["403", { ok: false, errorCategory: "DELEGATED_AUTH_FAILED", retryable: false }],
  ["timeout", { ok: false, errorCategory: "DELEGATED_TIMEOUT", retryable: true }],
  ["5xx", { ok: false, errorCategory: "DELEGATED_UNAVAILABLE", retryable: true }],
] as const) {
  test(`D3.3 failed ${label} TEST does not promote authorization`, async () => {
    let retryable: boolean | undefined;
    const { execution, calls, step } = await executeAirtable(result, {
      onRetryable: (value) => { retryable = value; },
    });
    assert.equal(calls, 1);
    assert.equal(execution.ok, false);
    assert.equal(execution.delivered, false);
    assert.equal(execution.providerAcknowledgements.length, 0);
    assert.equal(retryable, false);
    const fixture = verificationFixture(step.id);
    assert.equal(fixture.calls.persist, 0);
  });
}

test("D3.3 validation failure dispatches nothing and promotes nothing", async () => {
  const { execution, calls, step } = await executeAirtable({
    ok: true,
    acknowledged: true,
    output: { recordId: RECORD_ID },
  }, { baseId: "invalid" });
  assert.equal(execution.ok, false);
  assert.equal(execution.delivered, false);
  assert.equal(calls, 0);
  assert.equal(execution.providerAcknowledgements.length, 0);
  assert.equal(verificationFixture(step.id).calls.persist, 0);
});

test("D3.3 malformed runner success is rejected before delivery or promotion", async () => {
  const { execution, calls, step } = await executeAirtable({
    ok: true,
    acknowledged: true,
    output: { recordId: "not-a-record" },
  });
  assert.equal(calls, 1);
  assert.equal(execution.ok, false);
  assert.equal(execution.delivered, false);
  assert.equal(execution.providerAcknowledgements.length, 0);
  assert.equal(verificationFixture(step.id).calls.persist, 0);
});

for (const [label, connection] of [
  ["wrong owner", { user_id: USER_B }],
  ["revoked", { status: "revoked" }],
  ["non-Airtable connector", { connector_id: "slack", provider_family: "slack", auth_type: "oauth2" }],
] as const) {
  test(`D3.3 ${label} connection cannot be provider-verified`, async () => {
    const { step } = configuredWorkflow();
    const fixture = verificationFixture(step.id, { connection });
    await assert.rejects(
      verifyAirtableCustomerTestExecution(verificationInput(step.id), fixture.dependencies),
      AirtableProviderVerificationError,
    );
    assert.equal(fixture.calls.persist, 0);
  });
}

test("D3.3 verification requires durable owned TEST execution and exact acknowledged step evidence", async () => {
  const { step } = configuredWorkflow();
  for (const overrides of [
    { execution: { user_id: USER_B } },
    { execution: { status: "failed" } },
    { execution: { trigger_type: "public_form" } },
    { step: { status: "failed" } },
    { step: { provider_reference_id: "rec99999999999999" } },
    { step: { sanitized_output_metadata: { capabilityId: "airtable.create_record", acknowledged: false } } },
  ]) {
    const fixture = verificationFixture(step.id, overrides);
    await assert.rejects(
      verifyAirtableCustomerTestExecution(verificationInput(step.id), fixture.dependencies),
      AirtableProviderVerificationError,
    );
    assert.equal(fixture.calls.persist, 0);
  }
});

test("D3.3 connection verification persistence failure never repeats an acknowledged create", async () => {
  const { execution, calls, step } = await executeAirtable({
    ok: true,
    acknowledged: true,
    output: { recordId: RECORD_ID },
  });
  assert.equal(execution.ok, true);
  assert.equal(execution.delivered, true);
  const fixture = verificationFixture(step.id, { persist: false });
  await assert.rejects(
    verifyAirtableCustomerTestExecution(verificationInput(step.id), fixture.dependencies),
    AirtableProviderVerificationError,
  );
  assert.equal(fixture.calls.persist, 1);
  assert.equal(calls, 1);
  assert.equal(execution.ok, true);
});

test("D3.3 already-proven operation is idempotent and does not rewrite metadata", async () => {
  const { step } = configuredWorkflow();
  const fixture = verificationFixture(step.id, {
    connection: {
      granted_scopes: [AIRTABLE_CREATE_RECORD_SCOPE],
      safe_metadata: {
        connectionMode: "customer_api_key",
        providerVerification: "operation_verified",
        verifiedOperation: "airtable.create_record",
        verifiedAt: VERIFIED_AT,
      },
    },
  });
  const result = await verifyAirtableCustomerTestExecution(
    verificationInput(step.id),
    fixture.dependencies,
  );
  assert.deepEqual(result, { status: "already_verified", verifiedAt: VERIFIED_AT });
  assert.equal(fixture.calls.persist, 0);
});

test("D3.3 credential and reconciliation boundaries remain server-only and sanitized", async () => {
  const [verification, executionAction, workflowRuntime, runner, credentialResolver] = await Promise.all([
    readFile("lib/connectors/airtable/provider-verification.ts", "utf8"),
    readFile("app/actions/execute.ts", "utf8"),
    readFile("lib/workflow-execution.ts", "utf8"),
    readFile("lib/executors/connector-runner.ts", "utf8"),
    readFile("lib/executors/delegated-credentials.ts", "utf8"),
  ]);
  assert.match(verification, /server-only-runtime/);
  assert.match(executionAction, /completeDurableExecution[\s\S]*verifyAirtableCustomerTestExecution/);
  assert.match(executionAction, /verification needs reconciliation/);
  assert.match(credentialResolver, /connection-vault/);
  assert.match(runner, /createConnectorRunnerCredentialCapsule/);
  assert.match(runner, /credential\?\.fill\(0\)/);
  assert.match(workflowRuntime, /isValidAirtableRecordId/);
  assert.doesNotMatch(verification, /baseId|tableId|fields|personalAccessToken|plaintext|authorization/i);
  assert.doesNotMatch(executionAction, /metadata:\s*\{[^}]*providerReferenceId/);
});

test("D3.3 workflow and setup evidence contain no credential and tests use no real Airtable network", async () => {
  const { workflow, step, steps } = configuredWorkflow();
  const setup = {
    [`${step.id}-baseId`]: BASE_ID,
    [`${step.id}-tableId`]: TABLE_ID,
    [`${step.id}-fields`]: '{"Name":"name"}',
  };
  assert.doesNotMatch(JSON.stringify(workflow), new RegExp(SYNTHETIC_PAT));
  assert.doesNotMatch(JSON.stringify(steps), new RegExp(SYNTHETIC_PAT));
  assert.doesNotMatch(JSON.stringify(setup), new RegExp(SYNTHETIC_PAT));
  const source = await readFile("tests/phase-d33-airtable-customer-acceptance.test.ts", "utf8");
  assert.doesNotMatch(source, /fetch\(|api\.airtable\.com/);
});

test("D3.3 Airtable acceptance evidence remains compatible with D3.4 LIVE enablement", async () => {
  const capability = CAPABILITY_REGISTRY["airtable.create_record"];
  assert.equal(capability.supported, true);
  assert.equal(capability.internalOnly, false);
  assert.equal(capability.plannerVisible, true);
  assert.equal(capability.availableInTest, true);
  assert.equal(capability.availableInProduction, true);
  assert.deepEqual(capability.executorVersions, { 1: "connector_runner" });
  assert.equal(CAPABILITY_REGISTRY.airtable.supported, false);

  const { workflow, step, steps } = configuredWorkflow();
  let calls = 0;
  const execution = await executeWorkflowSteps({
    userId: USER_A,
    workflowOwnerId: USER_A,
    workflowId: WORKFLOW_ID,
    workflowVersionId: VERSION_ID,
    telemetryExecutionId: EXECUTION_ID,
    workflowName: workflow.workflowName,
    steps,
    inputValues: {
      name: "Distinctive D3.3 value",
      [`${step.id}-baseId`]: BASE_ID,
      [`${step.id}-tableId`]: TABLE_ID,
      [`${step.id}-fields`]: '{"Name":"name"}',
    },
    mode: "public-form",
    delegatedExecutor: {
      kind: "connector_runner",
      async execute() {
        calls += 1;
        return { ok: true, acknowledged: true, output: { recordId: RECORD_ID } };
      },
    },
  });
  assert.equal(execution.ok, true);
  assert.equal(execution.delivered, true);
  assert.equal(calls, 1);
});

test("D3.3 controlled TEST runner gates are explicit and remain environment-owned", async () => {
  const [runner, protocol] = await Promise.all([
    readFile("lib/executors/connector-runner.ts", "utf8"),
    readFile("lib/executors/connector-runner-protocol.ts", "utf8"),
  ]);
  assert.match(runner, /DELEGATED_EXECUTION_ENABLED/);
  assert.match(runner, /CONNECTOR_RUNNER_EXECUTION_ENABLED/);
  assert.match(runner, /CONNECTOR_RUNNER_URL/);
  assert.match(runner, /CONNECTOR_RUNNER_SECRET/);
  assert.match(protocol, /CONNECTOR_RUNNER_WRAP_KEY_ACTIVE_VERSION/);
  assert.match(protocol, /CONNECTOR_RUNNER_WRAP_KEY_V/);
  assert.doesNotMatch(`${runner}\n${protocol}`, /process\.env\.[A-Z0-9_]+\s*=/);
});
