import { z } from "zod";

import type { AutomationSuggestion } from "@/lib/automate-this";
import { getCapability } from "@/lib/capability-registry";
import { compileReadyPlan } from "@/lib/workflow-compiler";
import type { WorkflowPlan } from "@/lib/workflow-planner";
import type { CompiledWorkflow } from "@/lib/schemas/workflow";

const common = {
  matchTitle: z.string().trim().min(5).max(180),
  sourceType: z.enum(["connector_event", "system", "internal"]),
  instruction: z.string().trim().min(12).max(600),
};
export const AutomationConfigurationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("work_item_ai_result"), ...common }).strict(),
  z.object({ kind: z.literal("gmail_follow_up"), ...common,
    waitDays: z.number().int().min(1).max(30),
    gmailConnectionId: z.uuid(), recipientEmail: z.email().max(300),
    subject: z.string().trim().min(3).max(180),
  }).strict(),
]);
export type AutomationConfiguration = z.infer<typeof AutomationConfigurationSchema>;

/** The stored version has only a Work Item trigger, AI preparation, and an internal result. Never a direct send. */
export function isReviewedAutomateThisWorkflow(workflow: CompiledWorkflow): boolean {
  return !workflow.publicForm && workflow.steps.length === 3
    && workflow.steps[0].type === "connector_trigger" && workflow.steps[0].capabilityId === "work_item_trigger"
    && workflow.steps[1].type === "ai_transform" && workflow.steps[1].capabilityId === "ai_text_transform"
    && workflow.steps[2].type === "store_data" && workflow.steps[2].capabilityId === "flowmind_data_store"
    && workflow.steps.every((step) => !step.config?.connector && !step.config?.http);
}

export function compileAutomationSuggestion(
  suggestion: Pick<AutomationSuggestion, "pattern_kind" | "source_title" | "source_type">,
  configuration: AutomationConfiguration,
): CompiledWorkflow {
  if (configuration.kind !== suggestion.pattern_kind || configuration.matchTitle !== suggestion.source_title
    || configuration.sourceType !== suggestion.source_type) throw new Error("Reviewed pattern and configuration differ.");
  const trigger = getCapability("work_item_trigger");
  const ai = getCapability("ai_text_transform");
  const store = getCapability("flowmind_data_store");
  if (!trigger || !ai || !store) throw new Error("Automation capabilities are unavailable.");
  const plan: WorkflowPlan = {
    status: "READY_TO_COMPILE",
    intent: `Prepare work for matching item ${configuration.matchTitle}`,
    trigger: { capabilityId: "work_item_trigger", displayName: trigger.displayName },
    transformations: [{ capabilityId: "ai_text_transform", displayName: ai.displayName,
      instruction: `${configuration.instruction} Use only the provided Work Item details. Return ONLY compact JSON with exactly title, content, sourceKeys: []. Content is a draft for human review, maximum ${configuration.kind === "gmail_follow_up" ? 450 : 4000} characters. Do not claim to send, approve, access a provider, or complete an external action.` }],
    destination: { capabilityId: "flowmind_data_store", displayName: store.displayName },
    otherwiseDestination: null, condition: null, schedule: null,
    missingRequirements: [], contradictions: [], requestedUnsupportedCapabilities: [],
    message: "Reviewed Work Item preparation only.", clarificationQuestions: [],
  };
  const compiled = compileReadyPlan(`Prepare ${configuration.matchTitle}`, plan, { allowWorkItemTrigger: true });
  if (!isReviewedAutomateThisWorkflow(compiled)) throw new Error("Automation draft is not a safe preparation workflow.");
  return compiled;
}
