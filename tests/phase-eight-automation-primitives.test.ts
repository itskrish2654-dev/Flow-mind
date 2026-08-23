import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CAPABILITY_REGISTRY } from "../lib/capability-registry";
import { compileReadyPlan } from "../lib/workflow-compiler";
import { evaluateCondition } from "../lib/workflow-conditions";
import { executeWorkflowSteps } from "../lib/workflow-execution";
import { planWorkflow } from "../lib/workflow-planner";
import { latestDueOccurrence, nextScheduleOccurrence, parseScheduleLanguage } from "../lib/scheduling";
import type { CompiledWorkflow } from "../lib/schemas/workflow";

const migrationPath = "supabase/migrations/20260816000400_phase8_automation_primitives.sql";

test("8A-1. schedule.trigger is a real test and production capability", () => {
  const capability = CAPABILITY_REGISTRY["schedule.trigger"];
  assert.equal(capability.supported, true);
  assert.equal(capability.availableInTest, true);
  assert.equal(capability.availableInProduction, true);
  assert.match(capability.executionImplementation ?? "", /durable/);
});

test("8A-2. a local-time schedule asks for timezone instead of assuming", () => {
  const plan = planWorkflow("Every weekday at 8 AM, summarize new requests and save them.");
  assert.equal(plan.status, "NEEDS_CLARIFICATION");
  assert.match(plan.clarificationQuestions[0] ?? "", /timezone/i);
});

test("8A-3. daily and weekday schedules preserve human time and IANA timezone", () => {
  const daily = parseScheduleLanguage("Every day at 8 AM Asia/Kolkata, save the result.");
  const weekday = parseScheduleLanguage("Every weekday at 9:30 AM America/New_York, save the result.");
  assert.equal(daily?.ok, true);
  assert.equal(weekday?.ok, true);
  if (!daily?.ok || !weekday?.ok) return;
  assert.equal(daily.schedule.kind, "daily");
  assert.equal(daily.schedule.timezone, "Asia/Kolkata");
  assert.equal(weekday.schedule.kind, "weekday");
  assert.match(weekday.schedule.humanLabel, /Every weekday at 9:30 AM/);
});

test("8A-4. one-time future schedule and hourly schedule calculate future occurrences", () => {
  const now = new Date("2026-08-16T00:00:00.000Z");
  const once = parseScheduleLanguage("On August 25 at 3 PM Asia/Kolkata, save the result.", now);
  const hourly = parseScheduleLanguage("Every hour UTC, save the result.", now);
  assert.equal(once?.ok, true);
  assert.equal(hourly?.ok, true);
  if (!once?.ok || !hourly?.ok) return;
  assert.ok(nextScheduleOccurrence(once.schedule, now, now));
  assert.equal(nextScheduleOccurrence(hourly.schedule, now, now)?.toISOString(), "2026-08-16T01:00:00.000Z");
});

test("8A-5. missed-run reconciliation collapses backlog deterministically", () => {
  const schedule = { kind: "hourly", timezone: "UTC", humanLabel: "Every hour" } as const;
  const due = latestDueOccurrence(schedule, new Date("2026-08-16T00:00:00Z"), new Date("2026-08-16T04:05:00Z"), new Date("2026-08-16T00:00:00Z"));
  assert.equal(due.scheduledFor.toISOString(), "2026-08-16T04:00:00.000Z");
  assert.equal(due.nextRunAt?.toISOString(), "2026-08-16T05:00:00.000Z");
  assert.equal(due.skippedEarlier, 4);
});

test("8A-6. scheduler persistence is owner-scoped, version-pinned, idempotent, and service-only", async () => {
  const migration = await readFile(migrationPath, "utf8");
  const dispatcher = await readFile("lib/scheduled-workflows.ts", "utf8");
  assert.match(migration, /unique \(schedule_id, scheduled_for\)/i);
  assert.match(migration, /workflow_version_id uuid not null references public\.workflow_versions/i);
  assert.match(migration, /auth\.uid\(\)[\s\S]*user_id/i);
  assert.match(migration, /revoke all on function public\.claim_schedule_occurrence[\s\S]+from public, anon, authenticated/i);
  assert.match(dispatcher, /schedule:\$\{input\.scheduleId\}:\$\{input\.scheduledFor\.toISOString\(\)\}/);
  assert.match(dispatcher, /mode: "scheduled"/);
});

test("8A-7. schedules remain version-pinned until an atomic publication switch", async () => {
  const workflowAction = await readFile("app/actions/workflow.ts", "utf8");
  const versioning = await readFile("lib/workflow-versioning.ts", "utf8");
  const schedules = await readFile("lib/workflow-schedules.ts", "utf8");
  assert.match(workflowAction, /disableWorkflowSchedule/);
  assert.match(workflowAction, /prepareWorkflowSchedule/);
  assert.match(workflowAction, /publish_workflow_version/);
  assert.doesNotMatch(versioning, /pinFutureScheduleToVersion/);
  assert.match(schedules, /nextScheduleOccurrence/);
  assert.match(schedules, /nextRunAt: nextRunAt\.toISOString/);
});

test("8B-1. structured string, numeric, missing, and boolean conditions are deterministic", () => {
  assert.equal(evaluateCondition({ sourcePath: "status", operator: "equals", expectedValue: "Approved", humanLabel: "If status is Approved" }, { status: "approved" }).matched, true);
  assert.equal(evaluateCondition({ sourcePath: "amount", operator: "greater_than", expectedValue: 1000, humanLabel: "If amount is greater than 1000" }, { amount: "1001" }).matched, true);
  assert.equal(evaluateCondition({ sourcePath: "email", operator: "not_exists", humanLabel: "If email does not exist" }, {}).matched, true);
  assert.equal(evaluateCondition({ sourcePath: "paid", operator: "is_false", humanLabel: "If paid is false" }, { paid: false }).matched, true);
});

function branchWorkflow(operator: "equals" | "greater_than", expectedValue: string | number): CompiledWorkflow["steps"] {
  return [
    { id: "trigger", type: "public_form_trigger", capabilityId: "public_form_submission", title: "Input", description: "Input" },
    { id: "condition", type: "filter_condition", capabilityId: "condition.if", title: "If priority matches", description: "Condition", config: { condition: { sourcePath: operator === "equals" ? "priority" : "amount", operator, expectedValue, humanLabel: "If the value matches" } } },
    { id: "true", type: "store_data", capabilityId: "flowmind_data_store", title: "True branch", description: "Store", config: { branch: { conditionStepId: "condition", when: "true" } } },
    { id: "false", type: "store_data", capabilityId: "flowmind_data_store", title: "Otherwise branch", description: "Store", config: { branch: { conditionStepId: "condition", when: "false" } } },
  ];
}

test("8B-2. only the true branch runs and the false branch is a neutral skip", async () => {
  const result = await executeWorkflowSteps({ workflowId: "w", workflowName: "Branch", steps: branchWorkflow("equals", "urgent"), inputValues: { priority: "urgent" }, mode: "test" });
  assert.equal(result.ok, true);
  assert.equal(result.outputData.steps.find((step) => step.stepId === "true")?.status, "succeeded");
  assert.equal(result.outputData.steps.find((step) => step.stepId === "false")?.status, "skipped");
  assert.match(result.outputData.steps.find((step) => step.stepId === "false")?.message ?? "", /condition not matched/i);
});

test("8B-3. only the false branch runs", async () => {
  const result = await executeWorkflowSteps({ workflowId: "w", workflowName: "Branch", steps: branchWorkflow("equals", "urgent"), inputValues: { priority: "normal" }, mode: "test" });
  assert.equal(result.ok, true);
  assert.equal(result.outputData.steps.find((step) => step.stepId === "true")?.status, "skipped");
  assert.equal(result.outputData.steps.find((step) => step.stepId === "false")?.status, "succeeded");
});

test("8B-4. numeric branch execution is deterministic", async () => {
  const result = await executeWorkflowSteps({ workflowId: "w", workflowName: "Branch", steps: branchWorkflow("greater_than", 1000), inputValues: { amount: "1001" }, mode: "test" });
  assert.equal(result.outputData.steps.find((step) => step.stepId === "true")?.status, "succeeded");
});

test("8B-5. AI classification compiles before condition and retry can reuse its decision", async () => {
  const plan = planWorkflow("Use a hosted form. If this looks like a sales lead, notify Slack. Otherwise save it.");
  assert.equal(plan.status, "READY_TO_COMPILE");
  if (plan.status !== "READY_TO_COMPILE") return;
  const workflow = compileReadyPlan(plan.intent, plan);
  const aiIndex = workflow.steps.findIndex((step) => step.type === "ai_transform");
  const conditionIndex = workflow.steps.findIndex((step) => step.type === "filter_condition");
  assert.ok(aiIndex >= 0 && conditionIndex > aiIndex);
  const condition = workflow.steps[conditionIndex];
  const compact = [workflow.steps[0], workflow.steps[aiIndex], condition, { id: "store", type: "store_data" as const, capabilityId: "flowmind_data_store", title: "Store", description: "Store", config: { branch: { conditionStepId: condition.id, when: "true" as const } } }];
  const runtime = await executeWorkflowSteps({ workflowId: "w", workflowName: "AI branch", steps: compact, inputValues: { details: "Please contact me about enterprise pricing." }, mode: "test", executeAi: async () => ({ text: "sales lead", metadata: { provider: "test", model: "classifier", durationMs: 1, inputCharacters: 1, outputCharacters: 10, maxOutputTokens: 32, inputTokens: 1, outputTokens: 3 } }) });
  assert.equal(runtime.ok, true);
  const resumed = await executeWorkflowSteps({ workflowId: "w", workflowName: "AI branch", steps: compact, inputValues: { details: "same" }, mode: "test", completedStepIds: new Set([workflow.steps[0].id, workflow.steps[aiIndex].id, condition.id]), resumeState: { aiResult: "sales lead", conditionDecisions: { [condition.id]: true } } });
  assert.equal(resumed.outputData.steps.find((step) => step.stepId === "store")?.status, "succeeded");
});

test("8B-6. a webhook trigger does not turn an internal otherwise branch into HTTP delivery", () => {
  const plan = planWorkflow("When an incoming webhook arrives, if priority equals urgent store it as urgent, otherwise store it as normal in CrazyLoops.");
  assert.equal(plan.status, "READY_TO_COMPILE");
  if (plan.status !== "READY_TO_COMPILE") return;
  const workflow = compileReadyPlan(plan.intent, plan);
  assert.deepEqual(
    workflow.steps.map((step) => step.capabilityId),
    ["generic_webhook_trigger", "condition.if", "flowmind_data_store", "flowmind_data_store"],
  );
});

test("8C-1. Preview has no execution path and Live Test is durable and marked TEST", async () => {
  const demo = await readFile("app/actions/homepage-demo.ts", "utf8");
  const action = await readFile("app/actions/execute.ts", "utf8");
  const history = await readFile("components/executions-data-table.tsx", "utf8");
  assert.doesNotMatch(demo, /executeWorkflowSteps|createDurableExecution/);
  assert.match(action, /triggerType: "manual_test"/);
  assert.match(action, /mode: "test"/);
  assert.match(history, /triggerType === "manual_test"/);
  assert.match(history, /"Test run"/);
});

test("8C-2. Live Test warns about side effects, reports outcomes, and offers activation", async () => {
  const [ui, journey] = await Promise.all([
    readFile("components/automation-workspace.tsx", "utf8"),
    readFile("components/workflow-journey-panel.tsx", "utf8"),
  ]);
  assert.match(ui, /This live test will run/);
  assert.match(ui, /Continue with the live test/);
  assert.match(journey, /Test successful/);
  assert.match(journey, /Turn on workflow/);
  assert.match(journey, /aria-live="polite"/);
});

test("8C-3. failed-step retry preserves condition decisions and completed AI", async () => {
  const action = await readFile("app/actions/execute.ts", "utf8");
  assert.match(action, /sanitized_output_metadata/);
  assert.match(action, /conditionMatched/);
  assert.match(action, /conditionDecisions/);
  assert.match(action, /completedStepIds/);
});

test("8D-1. unsupported providers produce distinct requestable capabilities", () => {
  const plan = planWorkflow("When Calendly gets a booking, update Salesforce.");
  assert.equal(plan.status, "UNSUPPORTED");
  assert.deepEqual(plan.requestedUnsupportedCapabilities.map((item) => item.capabilityId).sort(), ["calendly", "salesforce"]);
});

test("8D-2. demand persistence separates unique requesters and totals without prompts", async () => {
  const migration = await readFile(migrationPath, "utf8");
  const action = await readFile("app/actions/connector-requests.ts", "utf8");
  assert.match(migration, /requester_hash/);
  assert.match(migration, /unique_requesters/);
  assert.match(migration, /total_requests/);
  assert.match(migration, /request_count = least/i);
  assert.doesNotMatch(migration, /full_prompt|raw_prompt/i);
  assert.doesNotMatch(action, /prompt:/i);
});

test("8D-3. demand tables/report are service-only and account IDs are server-derived", async () => {
  const migration = await readFile(migrationPath, "utf8");
  const action = await readFile("app/actions/connector-requests.ts", "utf8");
  assert.match(migration, /revoke all on table public\.connector_capability_requests from public, anon, authenticated/i);
  assert.match(migration, /revoke all on table public\.connector_request_demand_report from public, anon, authenticated/i);
  assert.match(action, /p_user_id: auth\?\.user\.id/);
  assert.match(action, /createHmac\("sha256"/);
});

test("8UI-1. workflow is vertical/mobile-safe and branch/test controls are accessible", async () => {
  const ui = await readFile("components/automation-workspace.tsx", "utf8");
  assert.match(ui, /flex-col items-stretch/);
  assert.match(ui, /Otherwise/);
  assert.match(ui, /role="status"/);
  assert.match(ui, /min-h-10/);
});

test("8E-1. approval is deliberately deferred and remains truthful", () => {
  assert.equal(CAPABILITY_REGISTRY.human_approval.supported, false);
  assert.equal(CAPABILITY_REGISTRY.human_approval.executionImplementation, null);
});
