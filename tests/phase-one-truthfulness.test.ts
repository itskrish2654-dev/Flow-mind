import assert from "node:assert/strict";
import test from "node:test";

import {
  AiExecutionError,
  createAiTextExecutor,
  type AiTextExecutor,
} from "../lib/ai-execution-core";
import type { CompiledWorkflow } from "../lib/schemas/workflow";
import { compileReadyPlan } from "../lib/workflow-compiler";
import { executeWorkflowSteps } from "../lib/workflow-execution";
import { planWorkflow } from "../lib/workflow-planner";

const workflowId = "00000000-0000-4000-8000-000000000001";

function workflowSteps(
  steps: CompiledWorkflow["steps"],
): CompiledWorkflow["steps"] {
  return steps;
}

const successfulAi: AiTextExecutor = async () => ({
  text: "A real provider result for the submitted data.",
  metadata: {
    provider: "test-provider",
    model: "test-model",
    durationMs: 4,
    inputCharacters: 42,
    outputCharacters: 46,
    maxOutputTokens: 100,
    inputTokens: 12,
    outputTokens: 9,
  },
});

test("1. workflow execution invokes the AI provider path and records provider metadata", async () => {
  let calls = 0;
  const executeAi: AiTextExecutor = async (input) => {
    calls += 1;
    assert.match(input.instruction, /summarize/i);
    assert.match(input.content, /customer feedback/i);
    return successfulAi(input);
  };
  const result = await executeWorkflowSteps({
    workflowId,
    workflowName: "Feedback summary",
    steps: workflowSteps([
      {
        id: "trigger",
        type: "public_form_trigger",
        capabilityId: "public_form_submission",
        title: "Public form",
        description: "Receive feedback.",
      },
      {
        id: "ai",
        type: "ai_transform",
        capabilityId: "ai_text_transform",
        title: "Summarize",
        description: "Summarize feedback.",
        config: { transformPrompt: "Summarize the customer feedback." },
      },
      {
        id: "store",
        type: "store_data",
        capabilityId: "flowmind_data_store",
        title: "Store",
        description: "Store inside FlowMind.",
      },
    ]),
    inputValues: { details: "Useful customer feedback" },
    mode: "test",
    executeAi,
  });

  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.outputData.ai_result, "A real provider result for the submitted data.");
  assert.equal(result.outputData.ai_metadata[0]?.provider, "test-provider");
  assert.equal(result.outputData.ai_metadata[0]?.model, "test-model");
});

test("2. AI provider failure fails the workflow without fabricated output", async () => {
  const result = await executeWorkflowSteps({
    workflowId,
    workflowName: "AI failure",
    steps: workflowSteps([
      {
        id: "ai",
        type: "ai_transform",
        capabilityId: "ai_text_transform",
        title: "Analyze",
        description: "Analyze the submission.",
      },
    ]),
    inputValues: { details: "Customer text" },
    mode: "test",
    executeAi: async () => {
      throw new AiExecutionError("Provider unavailable.", "AI_PROVIDER_FAILED");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.outputData.ai_result, null);
  assert.equal(result.outputData.steps[0]?.status, "failed");
  assert.doesNotMatch(JSON.stringify(result.outputData), /processed the submission/i);
});

test("3. AI execution enforces a timeout", async () => {
  const executor = createAiTextExecutor({
    provider: "slow-provider",
    model: "slow-model",
    timeoutMs: 10,
    maxInputCharacters: 1_000,
    maxOutputTokens: 50,
    runModel: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { text: "too late" };
    },
  });

  await assert.rejects(
    () => executor({ instruction: "Summarize", content: "Input" }),
    (error: unknown) =>
      error instanceof AiExecutionError && error.code === "AI_TIMEOUT",
  );
});

test("4. named unsupported connectors never compile as generic steps", () => {
  const prompts = [
    ["Connect to Salesforce.", "salesforce"],
    ["Send this to Google Sheets.", "google_sheets"],
    ["Post it to Slack.", "slack"],
    ["Charge the customer with Stripe.", "stripe"],
    ["Send to WhatsApp.", "whatsapp"],
    ["Connect QuickBooks.", "quickbooks"],
  ] as const;

  for (const [prompt, capabilityId] of prompts) {
    const plan = planWorkflow(prompt);
    assert.equal(plan.status, "UNSUPPORTED", prompt);
    assert.ok(
      plan.requestedUnsupportedCapabilities.some(
        (capability) => capability.capabilityId === capabilityId,
      ),
      prompt,
    );
  }
});

test("5. vague prompts request clarification instead of inventing a flow", () => {
  const plan = planWorkflow("Automate my leads.");
  assert.equal(plan.status, "NEEDS_CLARIFICATION");
  assert.ok(plan.missingRequirements.length > 0);
  assert.ok(plan.clarificationQuestions.length > 0);
});

test("6. contradictory prompts return CONFLICTING_REQUIREMENTS", () => {
  const plan = planWorkflow(
    "Send automatically but always ask me before sending.",
  );
  assert.equal(plan.status, "CONFLICTING_REQUIREMENTS");
  assert.ok(plan.contradictions.length > 0);
});

test("7. a skipped destination is never marked delivered", async () => {
  const result = await executeWorkflowSteps({
    workflowId,
    workflowName: "Missing destination",
    steps: workflowSteps([
      {
        id: "destination",
        type: "webhook_post",
        capabilityId: "webhook_post",
        title: "Test webhook",
        description: "Send test data.",
      },
    ]),
    inputValues: {},
    mode: "test",
  });

  assert.equal(result.delivered, false);
  assert.equal(result.outputData.steps[0]?.status, "skipped");
  assert.equal(result.ok, false);
});

test("8. an acknowledged destination is marked succeeded and delivered", async () => {
  let requestBody: unknown;
  let contentType: string | null = null;
  const result = await executeWorkflowSteps({
    workflowId,
    workflowName: "Acknowledged destination",
    steps: workflowSteps([
      {
        id: "destination",
        type: "webhook_post",
        capabilityId: "webhook_post",
        title: "Test webhook",
        description: "Send test data.",
        config: { endpoint: "https://1.1.1.1/test", method: "POST" },
      },
    ]),
    inputValues: { name: "Alex" },
    mode: "test",
    executeWebhook: async (_endpoint, payload) => {
      contentType = "application/json";
      requestBody = payload;
      return { status: 202 };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.delivered, true);
  assert.equal(result.outputData.steps[0]?.status, "succeeded");
  assert.equal(contentType, "application/json");
  assert.deepEqual((requestBody as { input_data: unknown }).input_data, {
    name: "Alex",
  });
});

test("9. schedule requests are explicitly unsupported", () => {
  const plan = planWorkflow(
    "Every weekday, summarize form submissions and store them in FlowMind.",
  );
  assert.equal(plan.status, "UNSUPPORTED");
  assert.ok(
    plan.requestedUnsupportedCapabilities.some(
      (capability) => capability.capabilityId === "schedule_trigger",
    ),
  );
});

test("10. an existing legacy workflow with an unsupported connector fails before side effects", async () => {
  let fetchCalls = 0;
  const result = await executeWorkflowSteps({
    workflowId,
    workflowName: "Legacy Slack workflow",
    steps: workflowSteps([
      {
        id: "legacy-trigger",
        type: "webhook_trigger",
        title: "Form submission",
        description: "Receive a form.",
      },
      {
        id: "legacy-slack",
        type: "http_request",
        title: "Send to Slack",
        description: "Post a message to Slack.",
        config: { endpoint: "https://1.1.1.1/test", method: "POST" },
      },
    ]),
    inputValues: { details: "Do not send" },
    mode: "test",
    executeWebhook: async () => {
      fetchCalls += 1;
      return { status: 200 };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(fetchCalls, 0);
  assert.equal(result.outputData.steps[1]?.status, "unsupported");
  assert.equal(result.delivered, false);
});

test("11. supported workflows can compile with no AI step", () => {
  const prompt = "Collect customer feedback in a form and store it in FlowMind.";
  const plan = planWorkflow(prompt);
  assert.equal(plan.status, "READY_TO_COMPILE");
  const workflow = compileReadyPlan(prompt, plan);
  assert.equal(workflow.steps.length, 2);
  assert.equal(workflow.steps.some((step) => step.type === "ai_transform"), false);
});

test("12. supported workflows can contain more than three necessary steps", () => {
  const prompt =
    "Use a form to collect feedback, summarize it, classify sentiment, draft a response, and store everything in FlowMind.";
  const plan = planWorkflow(prompt);
  assert.equal(plan.status, "READY_TO_COMPILE");
  const workflow = compileReadyPlan(prompt, plan);
  assert.equal(workflow.steps.length, 5);
  assert.equal(
    workflow.steps.filter((step) => step.type === "ai_transform").length,
    3,
  );
});
