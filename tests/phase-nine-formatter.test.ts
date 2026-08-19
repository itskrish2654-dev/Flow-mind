import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CAPABILITY_REGISTRY } from "../lib/capability-registry";
import { classifyExecutionError } from "../lib/execution-reliability";
import {
  executeFormatter,
  FormatterError,
  type FormatterConfig,
  type FormatterOperation,
} from "../lib/formatter";
import type { CompiledWorkflow } from "../lib/schemas/workflow";
import { compileReadyPlan } from "../lib/workflow-compiler";
import { executeWorkflowSteps } from "../lib/workflow-execution";
import { planWorkflow } from "../lib/workflow-planner";

const base = (operation: FormatterOperation, extra: Partial<FormatterConfig> = {}): FormatterConfig => ({
  version: 1,
  operation,
  source: { kind: "trigger", path: "value" },
  outputKey: "formatted_value",
  ...extra,
});

test("9B-1. formatter is authoritative and Wait / For Each stay unsupported", () => {
  assert.equal(CAPABILITY_REGISTRY["formatter.transform"].supported, true);
  assert.equal(CAPABILITY_REGISTRY["formatter.transform"].availableInTest, true);
  assert.equal(CAPABILITY_REGISTRY["formatter.transform"].availableInProduction, true);
  assert.equal(CAPABILITY_REGISTRY["wait.delay"].supported, false);
  assert.equal(CAPABILITY_REGISTRY.for_each.supported, false);
  assert.equal(planWorkflow("Wait 5 minutes then store the result.").status, "UNSUPPORTED");
  assert.equal(planWorkflow("For each item, store the result.").status, "UNSUPPORTED");
});

test("9B-2. text operations are deterministic", () => {
  assert.equal(executeFormatter(base("trim"), "  hello  "), "hello");
  assert.equal(executeFormatter(base("uppercase"), "Hello"), "HELLO");
  assert.equal(executeFormatter(base("lowercase"), "Hello"), "hello");
  assert.equal(executeFormatter(base("title_case"), "hELLO   wORLD"), "Hello   World");
  assert.equal(executeFormatter(base("replace", { find: "cat", replacement: "dog" }), "cat cat"), "dog dog");
  assert.deepEqual(executeFormatter(base("split", { separator: "," }), "a,b,c"), ["a", "b", "c"]);
  assert.equal(executeFormatter(base("join", { separator: " | " }), ["a", 2, true]), "a | 2 | true");
  assert.equal(executeFormatter(base("prepend", { value: "ID-" }), "42"), "ID-42");
  assert.equal(executeFormatter(base("append", { value: "!" }), "hello"), "hello!");
});

test("9B-3. number parsing and rounding semantics are explicit", () => {
  assert.equal(executeFormatter(base("add", { operand: 2 }), "10.5"), 12.5);
  assert.equal(executeFormatter(base("subtract", { operand: 2 }), 10), 8);
  assert.equal(executeFormatter(base("multiply", { operand: 1.18 }), "100"), 118);
  assert.equal(executeFormatter(base("divide", { operand: 4 }), "10"), 2.5);
  assert.equal(executeFormatter(base("round", { decimalPlaces: 2 }), "1.005"), 1.01);
  assert.throws(() => executeFormatter(base("add", { operand: 1 }), "12px"), (error) => error instanceof FormatterError && error.code === "FORMATTER_INVALID_NUMBER");
  assert.throws(() => executeFormatter(base("divide", { operand: 0 }), 10), (error) => error instanceof FormatterError && error.code === "FORMATTER_DIVISION_BY_ZERO");
});

test("9B-4. date formatting, timezone conversion, and DST use the IANA database", () => {
  assert.equal(executeFormatter(base("format_date", { dateFormat: "DD/MM/YYYY", timezone: "UTC" }), "2026-08-19T14:30:00+05:30"), "19/08/2026");
  assert.equal(executeFormatter(base("convert_timezone", { timezone: "Asia/Kolkata" }), "2026-08-19T09:00:00Z"), "2026-08-19 14:30:00 Asia/Kolkata");
  assert.equal(executeFormatter(base("add_duration", { durationAmount: 1, durationUnit: "hours", timezone: "America/New_York" }), "2026-03-08T06:30:00Z"), "2026-03-08 03:30:00 America/New_York");
  assert.equal(executeFormatter(base("subtract_duration", { durationAmount: 1, durationUnit: "days" }), "2026-08-19T09:00:00Z"), "2026-08-18T09:00:00.000Z");
  assert.throws(() => executeFormatter(base("convert_timezone"), "2026-08-19T09:00:00Z"), (error) => error instanceof FormatterError && error.code === "FORMATTER_TIMEZONE_REQUIRED");
  assert.throws(() => executeFormatter(base("format_date"), "08/19/2026"), (error) => error instanceof FormatterError && error.code === "FORMATTER_INVALID_DATE");
});

test("9B-5. fallback semantics keep zero and false as real values", () => {
  assert.equal(executeFormatter(base("default_value", { value: "Unknown" }), "  "), "Unknown");
  assert.equal(executeFormatter(base("default_value", { value: "Unknown" }), 0), 0);
  assert.equal(executeFormatter(base("first_non_empty"), "", [null, "  ", false, "later"]), false);
});

test("9B-6. input, collection, and output bounds fail with normalized categories", () => {
  assert.throws(() => executeFormatter(base("trim"), "x".repeat(40_000)), (error) => error instanceof FormatterError && error.code === "FORMATTER_INVALID_INPUT");
  assert.throws(() => executeFormatter(base("append", { value: "x".repeat(40_000) }), "a"), (error) => error instanceof FormatterError && error.code === "FORMATTER_OUTPUT_TOO_LARGE");
  assert.throws(() => executeFormatter(base("split", { separator: "," }), Array.from({ length: 1_001 }, () => "a").join(",")), (error) => error instanceof FormatterError && error.code === "FORMATTER_OUTPUT_TOO_LARGE");
  assert.equal(classifyExecutionError(new FormatterError("FORMATTER_INVALID_DATE", "Bad date")).category, "FORMATTER_INVALID_DATE");
  assert.equal(classifyExecutionError(new FormatterError("FORMATTER_INVALID_DATE", "Bad date")).retryable, false);
});

test("9B-7. planner selects Formatter rather than AI for required deterministic prompts", () => {
  const prompts = [
    ["Trim the customer's email.", "trim"],
    ["Make the name title case.", "title_case"],
    ["Multiply the price by 1.18.", "multiply"],
    ["Round the total to 2 decimal places.", "round"],
    ["Format the date as DD/MM/YYYY.", "format_date"],
    ["Convert the event time to Asia/Kolkata.", "convert_timezone"],
    ["If company is empty, use Unknown.", "default_value"],
    ["If phone is empty, use mobile instead.", "first_non_empty"],
  ] as const;
  for (const [prompt, operation] of prompts) {
    const plan = planWorkflow(prompt);
    assert.equal(plan.transformations[0]?.capabilityId, "formatter.transform", prompt);
    assert.equal(plan.transformations[0]?.formatter?.operation, operation, prompt);
    assert.equal(plan.transformations.some((item) => item.capabilityId === "ai_text_transform"), false, prompt);
  }
  const local = planWorkflow("Convert this to local time.");
  assert.equal(local.status, "NEEDS_CLARIFICATION");
  assert.equal(local.clarificationQuestions[0], "Which timezone should CrazyLoops use?");
  assert.equal(planWorkflow("Use a regular expression to rewrite this field and store it.").status, "UNSUPPORTED");
});

test("9B-8. compiler emits human-readable formatter steps with no manufactured AI", () => {
  const plan = planWorkflow("When an incoming webhook arrives, trim the email, multiply the price by 1.18, round the total to 2 decimal places, format the date as DD/MM/YYYY, and store it in CrazyLoops.");
  assert.equal(plan.status, "READY_TO_COMPILE");
  if (plan.status !== "READY_TO_COMPILE") return;
  const workflow = compileReadyPlan(plan.intent, plan);
  assert.equal(workflow.steps.filter((step) => step.type === "formatter_transform").length, 4);
  assert.equal(workflow.steps.some((step) => step.type === "ai_transform"), false);
  assert.ok(workflow.steps.every((step) => !/^step[_ -]?\d+$/i.test(step.title)));
});

test("9B-8a. sequential operations on one field consume the prior formatter output", () => {
  const plan = planWorkflow("When an incoming webhook arrives, trim the name then make the name title case, and store it in CrazyLoops.");
  assert.equal(plan.status, "READY_TO_COMPILE");
  if (plan.status !== "READY_TO_COMPILE") return;
  const workflow = compileReadyPlan(plan.intent, plan);
  const formatterSteps = workflow.steps.filter((step) => step.type === "formatter_transform");
  assert.equal(formatterSteps.length, 2);
  assert.equal(formatterSteps[1].config?.formatter?.source.kind, "step");
  assert.equal(formatterSteps[1].config?.formatter?.source.stepId, formatterSteps[0].id);
});

test("9B-8b. fallback language remains a formatter and the requested internal destination", () => {
  const prompt = "When an incoming webhook arrives, trim the name then make the name title case, round the amount to 2 decimal places, format the date as DD/MM/YYYY, if company is empty, use Unknown, and store it in CrazyLoops.";
  const plan = planWorkflow(prompt);
  assert.equal(plan.status, "READY_TO_COMPILE");
  if (plan.status !== "READY_TO_COMPILE") return;
  assert.equal(plan.condition, null);
  assert.equal(plan.destination?.capabilityId, "flowmind_data_store");
  assert.equal(plan.transformations.filter((item) => item.capabilityId === "formatter.transform").length, 5);
  const workflow = compileReadyPlan(prompt, plan);
  assert.deepEqual(
    workflow.steps.map((step) => step.capabilityId),
    ["generic_webhook_trigger", "formatter.transform", "formatter.transform", "formatter.transform", "formatter.transform", "formatter.transform", "flowmind_data_store"],
  );
  assert.equal(workflow.steps[4]?.title, "Format date");
});

function runtimeSteps(): CompiledWorkflow["steps"] {
  return [
    { id: "trigger", type: "webhook_trigger", capabilityId: "generic_webhook_trigger", title: "Incoming webhook", description: "Receives JSON", config: { connector: { connectorId: "flowmind_webhook", operationKind: "trigger", operationKey: "event_received", operationVersion: 1, mappings: [] } } },
    { id: "format", type: "formatter_transform", capabilityId: "formatter.transform", title: "Trim email", description: "Trim email", config: { formatter: { version: 1, operation: "trim", source: { kind: "trigger", path: "email" }, outputKey: "clean_email" } } },
    { id: "store", type: "store_data", capabilityId: "flowmind_data_store", title: "Store", description: "Store" },
  ];
}

test("9B-9. Test Loop and production modes share the same formatter runtime", async () => {
  const inputValues = { email: "  USER@EXAMPLE.COM  " };
  const testResult = await executeWorkflowSteps({ workflowId: "w", workflowName: "Formatter", steps: runtimeSteps(), inputValues, mode: "test" });
  const liveResult = await executeWorkflowSteps({ workflowId: "w", workflowName: "Formatter", steps: runtimeSteps(), inputValues, mode: "public-form" });
  assert.equal(testResult.ok, true);
  assert.equal(liveResult.ok, true);
  assert.deepEqual(testResult.outputData.formatter_results, liveResult.outputData.formatter_results);
  assert.equal(testResult.outputData.formatter_results.format.value, "USER@EXAMPLE.COM");
});

test("9B-10. completed formatter output is restored on retry instead of recomputed", async () => {
  const resumed = await executeWorkflowSteps({
    workflowId: "w",
    workflowName: "Formatter retry",
    steps: runtimeSteps(),
    inputValues: { email: "different" },
    mode: "test",
    completedStepIds: new Set(["trigger", "format"]),
    resumeState: { stepOutputs: { format: { value: "USER@EXAMPLE.COM", clean_email: "USER@EXAMPLE.COM" } } },
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.outputData.formatter_results.format.value, "USER@EXAMPLE.COM");
  assert.match(resumed.outputData.steps.find((step) => step.stepId === "format")?.message ?? "", /not repeated/i);
});

test("9B-11. runtime rejects malformed formatter configuration before fake success", async () => {
  const steps = runtimeSteps();
  steps[1] = { ...steps[1], config: undefined };
  const result = await executeWorkflowSteps({ workflowId: "w", workflowName: "Invalid", steps, inputValues: { email: "x" }, mode: "test" });
  assert.equal(result.ok, false);
  assert.equal(result.outputData.steps.find((step) => step.stepId === "format")?.status, "failed");
});

test("9B-12. formatter telemetry is privacy-safe and retry restoration is owner-scoped", async () => {
  const state = await readFile("lib/execution-state.ts", "utf8");
  const observability = await readFile("lib/observability.ts", "utf8");
  const retry = await readFile("app/actions/execute.ts", "utf8");
  assert.match(state, /formatter_execution_succeeded/);
  assert.match(state, /formatter_execution_failed/);
  assert.match(state, /formatterOperation/);
  assert.doesNotMatch(state, /properties:\s*\{[\s\S]*?formatterOutput/);
  assert.match(observability, /PRIVATE_METADATA_KEY[\s\S]*input\|output/);
  assert.match(retry, /\.eq\("id", existing\.workflow_id\)\.eq\("user_id", auth\.user\.id\)/);
  assert.match(retry, /formatterStepOutputs/);
});
