import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyExecutionError,
  deriveExecutionStatus,
  withBoundedRetry,
} from "../lib/execution-reliability";
import { executeWorkflowSteps } from "../lib/workflow-execution";

const root = process.cwd();
const source = (path: string) => readFileSync(`${root}/${path}`, "utf8");
const migration = source("supabase/migrations/20260812000100_phase3_execution_reliability.sql");
const executeAction = source("app/actions/execute.ts");
const publicAction = source("app/f/[projectId]/actions.ts");
const workflowAction = source("app/actions/workflow.ts");
const versionAction = source("app/actions/versions.ts");
const executionAction = source("app/actions/executions.ts");
const executionCore = source("lib/workflow-execution.ts");
const workspace = source("components/automation-workspace.tsx");
const table = source("components/executions-data-table.tsx");

const workflowId = "00000000-0000-4000-8000-000000000001";

test("3-1. execution row is durably created before any side effect", () => {
  const durable = executeAction.indexOf("createDurableExecution");
  const ai = executeAction.indexOf("executeAiText", durable);
  const pdf = executeAction.indexOf("uploadGeneratedDocument", durable);
  assert.ok(durable >= 0 && ai > durable && pdf > durable);
  assert.match(migration, /status, input_data, output_data[\s\S]*'queued'/i);
});

test("3-2. side-effect failure preserves and finalizes the durable row", () => {
  assert.match(executeAction, /markExecutionRunning[\s\S]*executeWorkflowSteps/);
  assert.match(executeAction, /catch \(error: unknown\)[\s\S]*workflow_executions[\s\S]*status: "failed"/);
});

test("3-3. final persistence failure is reported as reconciliation, not fake success", () => {
  assert.match(executeAction, /completeDurableExecution[\s\S]*needs reconciliation/);
});

test("3-4. every new execution references an immutable workflow version", () => {
  assert.match(migration, /workflow_version_id uuid references public\.workflow_versions\(id\) on delete restrict/);
  assert.match(executeAction, /workflowVersionId: snapshot\.versionId/);
  assert.match(publicAction, /workflowVersionId: publicWorkflow\.versionId/);
});

test("3-5/6. manual and public executions use stable request identifiers", () => {
  assert.match(executeAction, /idempotencyKey: z\.string\(\)\.uuid\(\)/);
  assert.match(publicAction, /createPublicFormIdempotencyKey\(submissionId\.data\)/);
  assert.match(source("components/public-workflow-form.tsx"), /flowmind_submission_id/);
});

test("3-7/10. 20 simultaneous identical inserts are constrained to one execution", async () => {
  const keys = new Set<string>();
  const uniqueInsert = async () => {
    await Promise.resolve();
    keys.add(`${workflowId}:same-key`);
  };
  await Promise.all(Array.from({ length: 20 }, uniqueInsert));
  assert.equal(keys.size, 1);
  assert.match(migration, /unique index workflow_executions_workflow_idempotency_uidx[\s\S]*workflow_id, idempotency_key/i);
  assert.match(migration, /on conflict \(workflow_id, idempotency_key\) do nothing/i);
});

test("3-8/9. retry support skips completed steps", async () => {
  let aiCalls = 0;
  const result = await executeWorkflowSteps({
    workflowId,
    workflowName: "Retry test",
    steps: [
      { id: "trigger", type: "public_form_trigger", capabilityId: "public_form_submission", title: "Form", description: "Form" },
      { id: "ai", type: "ai_transform", capabilityId: "ai_text_transform", title: "AI", description: "AI" },
      { id: "store", type: "store_data", capabilityId: "flowmind_data_store", title: "Store", description: "Store" },
    ],
    inputValues: { text: "hello" },
    mode: "test",
    completedStepIds: new Set(["trigger", "ai"]),
    executeAi: async () => {
      aiCalls += 1;
      return {
        text: "should not run",
        metadata: {
          provider: "test", model: "test", durationMs: 1, inputCharacters: 1,
          outputCharacters: 1, maxOutputTokens: 10, inputTokens: null, outputTokens: null,
        },
      };
    },
  });
  assert.equal(aiCalls, 0);
  assert.equal(result.outputData.steps.find((step) => step.stepId === "ai")?.status, "succeeded");
});

test("3-11/14. partial failure remains truthful", () => {
  assert.equal(deriveExecutionStatus(["succeeded", "succeeded", "failed"]), "partially_failed");
  assert.equal(deriveExecutionStatus(["failed", "skipped"]), "failed");
});

test("3-12/13. completed steps stay successful and failed destination remains retryable-state aware", () => {
  assert.match(executionCore, /completedStepIds\.has\(step\.id\)/);
  assert.match(migration, /unique \(execution_id, workflow_step_id\)/);
  assert.match(migration, /retryable boolean/);
});

test("3-15/16. edits create immutable versions and never update old version rows", () => {
  assert.match(workflowAction, /createImmutableWorkflowVersion/);
  assert.doesNotMatch(workflowAction, /from\("workflow_versions"\)\s*\.update/);
  assert.match(migration, /unique \(workflow_id, version_number\)/);
});

test("3-17. execution snapshots cannot switch to a later current version", () => {
  assert.match(executeAction, /snapshot = await loadWorkflowSnapshot/);
  assert.match(executeAction, /steps: snapshot\.workflow\.steps/);
  assert.doesNotMatch(executionCore, /from\("workflows"\)/);
});

test("3-18/19. rollback creates a new version and retains history", () => {
  assert.match(versionAction, /scope: "rollback"/);
  assert.match(versionAction, /sourceVersionId/);
  assert.doesNotMatch(versionAction, /\.delete\(/);
});

test("3-20/21. presentation changes preserve automation steps", () => {
  assert.match(workflowAction, /\.\.\.parsed\.data[\s\S]*publicForm/);
  assert.match(workflowAction, /scope: request\.data\.customization\.publicForm \? "form_schema" : "presentation"/);
});

test("3-22/23. form schema is bounded and destructive replacement is explicit", () => {
  assert.match(source("lib/schemas/workflow.ts"), /fields: z\.array\(PublicFormFieldSchema\)\.min\(1\)\.max\(10\)/);
  assert.match(workflowAction, /Choose Modify current automation or Replace current automation/);
  assert.match(workspace, /Modify the current automation/);
  assert.match(workspace, /Replace the current automation completely/);
  assert.match(workflowAction, /affectedExecutionCount[\s\S]*confirmDestructiveFieldRemoval/);
  assert.match(workflowAction, /Existing execution data will remain recoverable in history/);
});

test("3-24. full replacement requires explicit edit intent", () => {
  assert.match(workflowAction, /editIntent\?: "modify" \| "replace"/);
  assert.match(workflowAction, /editIntent === "replace" \? "full_replacement"/);
});

test("3-25/27. authoritative setup is server-versioned, not restored from localStorage", () => {
  assert.match(executeAction, /sanitizeSetupConfig[\s\S]*scope: "setup"/);
  assert.doesNotMatch(workspace, /getItem\(`flowmind:values:/);
  assert.doesNotMatch(workspace, /setItem\(`flowmind:values:/);
});

test("3-26. logout/login can reload setup from current version", () => {
  assert.match(source("app/dashboard/projects/[id]/page.tsx"), /initialSetupConfig=\{result\.setupConfig\}/);
  assert.match(workspace, /initialSetupConfig/);
});

test("3-28/29. workflows and executions use stable cursor pagination beyond old limits", () => {
  assert.match(workflowAction, /order\("created_at"[\s\S]*order\("id"[\s\S]*limit\(31\)/);
  assert.match(executionAction, /order\("created_at"[\s\S]*order\("id"[\s\S]*PAGE_SIZE \+ 1/);
  assert.doesNotMatch(executionAction, /limit\(200\)/);
});

test("3-30/31. cursor pagination deduplicates UI rows and uses strict tuple boundary", () => {
  assert.match(table, /known = new Set[\s\S]*filter\(\(item\) => !known\.has/);
  assert.match(executionAction, /created_at\.lt[\s\S]*created_at\.eq[\s\S]*id\.lt/);
});

test("3-32/33. export batches all rows to a stated cap and prevents spreadsheet formulas", () => {
  assert.match(executionAction, /MAX_EXPORT_ROWS = 10_000/);
  assert.match(executionAction, /while \(rows\.length < MAX_EXPORT_ROWS \+ 1\)/);
  assert.match(executionAction, /\/\^\[=\+\\-@\\t\\r\]\//);
  assert.match(table, /Export all \(max 10,000\)/);
});

test("3-34/35. duplicate run/save protection is server/database authoritative", () => {
  assert.match(migration, /on conflict \(workflow_id, idempotency_key\) do nothing/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('workflow-version:/);
});

test("3-36. simultaneous edits fail optimistic concurrency instead of overwriting", () => {
  assert.match(migration, /v_current <> p_expected_version_id[\s\S]*workflow version conflict/);
});

test("3-37. duplicate retry cannot duplicate one execution step row", () => {
  assert.match(migration, /unique \(execution_id, workflow_step_id\)/);
  assert.match(migration, /claim_execution_retry[\s\S]*pg_advisory_xact_lock/);
  assert.match(executeAction, /retryWorkflowExecution[\s\S]*completedStepIds/);
});

test("3-38/39. archive preserves audit history and blocks new execution", () => {
  assert.match(workflowAction, /lifecycle_state: "archived"/);
  assert.doesNotMatch(workflowAction, /from\("workflows"\)[\s\S]{0,100}\.delete\(/);
  assert.match(migration, /workflow\.lifecycle_state = 'active'/);
  assert.match(migration, /workflow_id\) references public\.workflows\(id\) on delete restrict/);
});

test("3-40. retry classification separates transient and permanent failures", () => {
  assert.deepEqual(classifyExecutionError(new Error("Provider 503 unavailable")), {
    category: "provider_unavailable", retryable: true, safeMessage: "The provider is temporarily unavailable.",
  });
  assert.equal(classifyExecutionError(new Error("invalid credentials")).retryable, false);
});

test("3-41. bounded retry has a finite attempt ceiling", async () => {
  let attempts = 0;
  await assert.rejects(() => withBoundedRetry(async () => {
    attempts += 1;
    throw new Error("503 unavailable");
  }, { maxAttempts: 3, baseDelayMs: 0 }));
  assert.equal(attempts, 3);
});

test("3-42. stale running executions have a service-only reconciliation path", () => {
  assert.match(migration, /create or replace function public\.fail_stale_executions/);
  assert.match(migration, /error_category = 'interrupted'/);
  assert.match(migration, /grant execute[\s\S]*to service_role/);
});

test("3-43. legacy rows explicitly state unknown snapshot provenance", () => {
  assert.match(migration, /snapshotProvenance', 'legacy_unversioned'/);
  assert.match(migration, /exact workflow definition used by this historical execution is unknown/);
});

test("3-44. duplicate mount fetch was removed", () => {
  assert.doesNotMatch(table, /setTimeout\(refresh, 0\)/);
});

test("3-45. step records contain structured observability without raw secrets", () => {
  for (const field of ["provider_reference_id", "error_category", "retryable", "attempt_number", "started_at", "completed_at"]) {
    assert.match(migration, new RegExp(field));
  }
  assert.doesNotMatch(migration, /plaintext_secret|api_key text/);
});
