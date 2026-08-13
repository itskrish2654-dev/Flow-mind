import { annotateWorkflowCapabilities } from "@/lib/capability-registry";
import { createPublicFormDefinition } from "@/lib/public-form";
import {
  CompiledWorkflowSchema,
  type CompiledWorkflow,
} from "@/lib/schemas/workflow";
import { createDefaultDataTableDefinition } from "@/lib/workflow-customization";
import type { WorkflowPlan } from "@/lib/workflow-planner";

function titleFromPrompt(prompt: string): string {
  const compact = prompt
    .replace(/\b(please|can you|i want to|i need to|build|create|make|automate)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "");
  const words = compact.split(" ").filter(Boolean).slice(0, 7);
  const title = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
  return title || "FlowMind Automation";
}

function transformationTitle(instruction: string, index: number): string {
  if (/summarize/i.test(instruction)) return "Summarize submission";
  if (/classify/i.test(instruction)) return "Classify submission";
  if (/prioritize/i.test(instruction)) return "Prioritize submission";
  if (/extract/i.test(instruction)) return "Extract key information";
  if (/draft/i.test(instruction)) return "Draft response";
  return `AI transformation ${index + 1}`;
}

function defaultDocumentTemplate(workflowName: string, hasAiStep: boolean): string {
  return `# ${workflowName}\n\nPrepared for {{trigger.name}}\n\n{{trigger.details}}\n\n## Result\n\n${hasAiStep ? "{{ai.result}}" : "{{trigger.details}}"}`;
}

export function compileReadyPlan(prompt: string, plan: WorkflowPlan): CompiledWorkflow {
  if (plan.status !== "READY_TO_COMPILE" || !plan.trigger || !plan.destination) {
    throw new Error("Only READY_TO_COMPILE plans can become workflows.");
  }

  const workflowName = titleFromPrompt(prompt).slice(0, 80);
  const steps: CompiledWorkflow["steps"] = [
    {
      id: "step_1",
      type: plan.trigger.capabilityId === "generic_webhook_trigger" ? "webhook_trigger" : "public_form_trigger",
      capabilityId: plan.trigger.capabilityId,
      title: plan.trigger.capabilityId === "generic_webhook_trigger" ? "Incoming webhook" : "Public form submission",
      description: plan.trigger.capabilityId === "generic_webhook_trigger" ? "Starts from an authenticated FlowMind webhook endpoint." : "Starts when someone submits the hosted FlowMind form.",
      ...(plan.trigger.capabilityId === "generic_webhook_trigger" ? { config: { connector: { connectorId: "flowmind_webhook", operationKind: "trigger" as const, operationKey: "event_received", operationVersion: 1, mappings: [] } } } : {}),
    },
    ...plan.transformations.map((transformation, index) => ({
      id: `step_${index + 2}`,
      type: "ai_transform" as const,
      capabilityId: "ai_text_transform",
      title: transformationTitle(transformation.instruction ?? "", index),
      description: transformation.instruction ?? "Transform the submitted text.",
      config: {
        transformPrompt:
          transformation.instruction ?? "Transform the submitted text accurately.",
      },
    })),
  ];

  const destinationIndex = steps.length + 1;
  if (plan.destination.capabilityId === "generic_http_action") {
    const endpoint = prompt.match(/https:\/\/[^\s)\]]+/i)?.[0];
    steps.push({
      id: `step_${destinationIndex}`,
      type: "http_request",
      capabilityId: "generic_http_action",
      title: "Send HTTP request",
      description: "Posts the workflow result as JSON and waits for acknowledgement.",
      config: {
        ...(endpoint ? { endpoint } : {}),
        method: "POST",
        connector: {
          connectorId: "flowmind_http", operationKind: "action", operationKey: "post_json", operationVersion: 1,
          mappings: [
            { target: "url", source: { kind: "literal", value: endpoint ?? "" } },
            { target: "body", source: { kind: "trigger", path: "" } },
          ],
        },
      },
    });
  } else if (plan.destination.capabilityId === "generate_pdf") {
    steps.push({
      id: `step_${destinationIndex}`,
      type: "generate_pdf",
      capabilityId: "generate_pdf",
      title: "Generate PDF",
      description: "Creates and stores a downloadable PDF document.",
      config: {
        documentTemplate: defaultDocumentTemplate(
          workflowName,
          plan.transformations.length > 0,
        ),
      },
    });
  } else {
    steps.push({
      id: `step_${destinationIndex}`,
      type: "store_data",
      capabilityId: "flowmind_data_store",
      title: "Store inside FlowMind",
      description: "Stores the submission and completed results in Executions & Data.",
    });
  }

  const summaryParts = [
    plan.trigger.capabilityId === "generic_webhook_trigger"
      ? "Receives an authenticated FlowMind webhook event"
      : "Receives a FlowMind hosted form submission",
    ...plan.transformations.map((transformation) =>
      (transformation.instruction ?? "Transforms the submission").replace(/\.$/, ""),
    ),
    plan.destination.capabilityId === "generate_pdf"
      ? "generates a downloadable PDF"
      : "stores the result inside FlowMind",
  ];
  const summary = `${summaryParts.join(", then ")}.`.slice(0, 300);
  const publicForm = plan.trigger.capabilityId === "public_form_submission" ? {
    ...createPublicFormDefinition(prompt, workflowName, summary),
    successMessage:
      plan.destination.capabilityId === "flowmind_data_store"
        ? "Your submission has been stored in FlowMind."
        : "Your PDF has been generated and stored in FlowMind.",
  } : undefined;

  return annotateWorkflowCapabilities(
    CompiledWorkflowSchema.parse({
      workflowName,
      summary,
      steps,
      publicForm,
      dataTable: publicForm ? createDefaultDataTableDefinition(publicForm) : undefined,
    }),
  );
}
