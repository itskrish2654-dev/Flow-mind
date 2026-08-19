import { annotateWorkflowCapabilities } from "@/lib/capability-registry";
import { createPublicFormDefinition } from "@/lib/public-form";
import { CompiledWorkflowSchema, type CompiledWorkflow } from "@/lib/schemas/workflow";
import { createDefaultDataTableDefinition } from "@/lib/workflow-customization";
import type { PlannedCapability, WorkflowPlan } from "@/lib/workflow-planner";

type Step = CompiledWorkflow["steps"][number];
type Branch = NonNullable<NonNullable<Step["config"]>["branch"]>;

function titleFromPrompt(prompt: string): string {
  const compact = prompt.replace(/\b(please|can you|i want to|i need to|build|create|make|automate)\b/gi, " ").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  return compact.split(" ").filter(Boolean).slice(0, 7).map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ") || "CrazyLoops Automation";
}

function transformationTitle(instruction: string, index: number): string {
  if (/summarize/i.test(instruction)) return "Summarize input";
  if (/classify/i.test(instruction)) return "Classify input";
  if (/prioritize/i.test(instruction)) return "Prioritize input";
  if (/extract/i.test(instruction)) return "Extract key information";
  if (/draft/i.test(instruction)) return "Draft response";
  return `AI transformation ${index + 1}`;
}

function formatterTitle(transformation: PlannedCapability): string {
  const formatter = transformation.formatter;
  if (!formatter) return "Format value";
  const source = formatter.source.path?.replaceAll("_", " ") || "value";
  const label: Record<typeof formatter.operation, string> = {
    trim: "Trim", uppercase: "Make uppercase", lowercase: "Make lowercase", title_case: "Use title case",
    replace: "Replace text in", split: "Split", join: "Join", prepend: "Prepend to", append: "Append to",
    add: "Add to", subtract: "Subtract from", multiply: "Multiply", divide: "Divide", round: "Round",
    format_date: "Format", add_duration: "Add duration to", subtract_duration: "Subtract duration from",
    convert_timezone: "Convert timezone for", default_value: "Use fallback for", first_non_empty: "Choose first available",
  };
  return `${label[formatter.operation]} ${source}`.replace(/\s+/g, " ");
}

function formatterDescription(transformation: PlannedCapability): string {
  const formatter = transformation.formatter;
  if (!formatter) return "Formats a value deterministically.";
  const source = formatter.source.path?.replaceAll("_", " ") || "value";
  return `Reads ${source}, applies ${formatter.operation.replaceAll("_", " ")}, and saves the result as ${formatter.outputKey.replaceAll("_", " ")}.`;
}

function defaultDocumentTemplate(workflowName: string, hasAiStep: boolean): string {
  return `# ${workflowName}\n\nPrepared for {{trigger.name}}\n\n{{trigger.details}}\n\n## Result\n\n${hasAiStep ? "{{ai.result}}" : "{{trigger.details}}"}`;
}

function connectorConfig(connector: NonNullable<NonNullable<Step["config"]>["connector"]>, branch?: Branch): Step["config"] {
  return { connector, ...(branch ? { branch } : {}) };
}

function destinationStep(
  destination: PlannedCapability,
  id: string,
  prompt: string,
  previousSteps: Step[],
  workflowName: string,
  branch?: Branch,
): Step {
  const capabilityId = destination.capabilityId;
  if (capabilityId.startsWith("google_sheets_")) {
    const operationKey = capabilityId.replace("google_sheets_", "");
    const operationInputs = operationKey === "find_row"
      ? [{ key: "matchColumn", label: "Exact-match column", type: "text" as const }, { key: "matchValue", label: "Value to find", type: "text" as const }]
      : operationKey === "update_row" ? [{ key: "rowNumber", label: "Exact row number", type: "text" as const }] : [];
    return { id, type: "connector_action", capabilityId, title: destination.displayName, description: "Uses a Google spreadsheet explicitly selected through Google Picker.", inputsRequired: [{ key: "spreadsheetId", label: "Google spreadsheet", type: "text", helpText: "Choose a spreadsheet through Google Picker." }, { key: "worksheet", label: "Worksheet name", type: "text" }, ...operationInputs], config: connectorConfig({ connectorId: "google_sheets", operationKind: "action", operationKey, operationVersion: 1, mappings: [{ target: "spreadsheetId", source: { kind: "literal", value: "" } }, { target: "worksheet", source: { kind: "literal", value: "" } }, ...(["add_row", "update_row"].includes(operationKey) ? [{ target: "values", source: { kind: "trigger" as const, path: "" } }] : [])] }, branch) };
  }
  if (capabilityId === "gmail_send_email" || capabilityId === "gmail_reply_to_email") {
    const reply = capabilityId === "gmail_reply_to_email";
    const aiStep = [...previousSteps].reverse().find((step) => step.type === "ai_transform");
    return { id, type: "connector_action", capabilityId, title: destination.displayName, description: reply ? "Replies in the validated Gmail thread after acknowledgement." : "Sends through the selected Gmail account after acknowledgement.", inputsRequired: [...(!reply ? [{ key: "to", label: "Recipient", type: "text" as const }, { key: "subject", label: "Subject", type: "text" as const }] : []), { key: "body", label: reply ? "Reply" : "Email body", type: "text" as const }], config: connectorConfig({ connectorId: "google_gmail", operationKind: "action", operationKey: reply ? "reply_to_email" : "send_email", operationVersion: 1, mappings: [...(reply ? [{ target: "messageId", source: { kind: "trigger" as const, path: "message.id" } }, { target: "threadId", source: { kind: "trigger" as const, path: "message.threadId" } }] : []), ...(aiStep ? [{ target: "body", source: { kind: "ai" as const, stepId: aiStep.id } }] : [])] }, branch) };
  }
  if (capabilityId === "slack_send_channel_message" || capabilityId === "slack_reply_in_thread") {
    const reply = capabilityId === "slack_reply_in_thread";
    const aiStep = [...previousSteps].reverse().find((step) => step.type === "ai_transform");
    const triggerPath = previousSteps[0]?.type === "public_form_trigger" ? "details" : "message.text";
    return { id, type: "connector_action", capabilityId, title: destination.displayName, description: reply ? "Replies in the selected Slack thread after provider acknowledgement." : "Sends to the selected Slack channel after provider acknowledgement.", inputsRequired: [{ key: "channel", label: "Slack channel", type: "text" }, ...(reply ? [{ key: "threadTs", label: "Slack thread", type: "text" as const }] : []), { key: "text", label: reply ? "Reply" : "Message", type: "text" }], config: connectorConfig({ connectorId: "slack", operationKind: "action", operationKey: reply ? "reply_in_thread" : "send_channel_message", operationVersion: 1, mappings: [...(reply ? [{ target: "threadTs", source: { kind: "trigger" as const, path: "message.threadTs" } }] : []), ...(aiStep ? [{ target: "text", source: { kind: "ai" as const, stepId: aiStep.id } }] : [{ target: "text", source: { kind: "trigger" as const, path: triggerPath } }])] }, branch) };
  }
  if (capabilityId.startsWith("notion_")) {
    const operationKey = capabilityId.replace("notion_", "");
    const aiStep = [...previousSteps].reverse().find((step) => step.type === "ai_transform");
    const findStep = [...previousSteps].reverse().find((step) => step.capabilityId === "notion_find_item");
    const inputsRequired = operationKey === "create_page"
      ? [{ key: "parentPageId", label: "Notion parent page", type: "text" as const }, { key: "title", label: "Page title", type: "text" as const }, { key: "content", label: "Page content", type: "text" as const }]
      : operationKey === "create_data_source_item" ? [{ key: "dataSourceId", label: "Notion data source", type: "text" as const }]
      : [{ key: "dataSourceId", label: "Notion data source", type: "text" as const }, { key: "pageId", label: "Exact Notion item", type: "text" as const }];
    return { id, type: "connector_action", capabilityId, title: destination.displayName, description: operationKey === "create_page" ? "Creates a page under the selected shared Notion page." : operationKey === "create_data_source_item" ? "Adds one item using the selected Notion data source." : "Updates one exact Notion item.", inputsRequired, config: connectorConfig({ connectorId: "notion", operationKind: "action", operationKey, operationVersion: 1, mappings: [...(operationKey === "create_data_source_item" ? [{ target: "values", source: { kind: "trigger" as const, path: "" } }] : []), ...(operationKey === "update_item" && findStep ? [{ target: "pageId", source: { kind: "step" as const, stepId: findStep.id, path: "page.id" } }] : []), ...(operationKey === "create_page" && aiStep ? [{ target: "content", source: { kind: "ai" as const, stepId: aiStep.id } }] : [])] }, branch) };
  }
  if (capabilityId === "generic_http_action") {
    const endpoint = prompt.match(/https:\/\/[^\s)\]]+/i)?.[0];
    return { id, type: "http_request", capabilityId, title: "Send HTTP request", description: "Posts the workflow result as JSON and waits for acknowledgement.", config: { ...(endpoint ? { endpoint } : {}), method: "POST", ...(branch ? { branch } : {}), connector: { connectorId: "flowmind_http", operationKind: "action", operationKey: "post_json", operationVersion: 1, mappings: [{ target: "url", source: { kind: "literal", value: endpoint ?? "" } }, { target: "body", source: { kind: "trigger", path: "" } }] } } };
  }
  if (capabilityId === "generate_pdf") {
    return { id, type: "generate_pdf", capabilityId, title: "Generate PDF", description: "Creates and stores a downloadable PDF document.", config: { documentTemplate: defaultDocumentTemplate(workflowName, previousSteps.some((step) => step.type === "ai_transform")), ...(branch ? { branch } : {}) } };
  }
  return { id, type: "store_data", capabilityId: "flowmind_data_store", title: "Store inside CrazyLoops", description: "Stores the submission and completed results in Executions & Data.", ...(branch ? { config: { branch } } : {}) };
}

export function compileReadyPlan(prompt: string, plan: WorkflowPlan): CompiledWorkflow {
  if (plan.status !== "READY_TO_COMPILE" || !plan.trigger || !plan.destination) throw new Error("Only READY_TO_COMPILE plans can become workflows.");
  const workflowName = titleFromPrompt(prompt).slice(0, 80);
  const trigger: Step = plan.trigger.capabilityId === "schedule.trigger"
    ? { id: "step_1", type: "scheduled_trigger", capabilityId: "schedule.trigger", title: plan.schedule?.humanLabel ?? "Scheduled run", description: `Runs ${plan.schedule?.humanLabel.toLowerCase() ?? "on the configured schedule"} in ${plan.schedule?.timezone ?? "the selected timezone"}.`, config: { schedule: plan.schedule ?? undefined } }
    : { id: "step_1", type: plan.trigger.capabilityId.startsWith("gmail_") || plan.trigger.capabilityId.startsWith("slack_") || plan.trigger.capabilityId.startsWith("notion_page_") || plan.trigger.capabilityId === "manual_trigger" ? "connector_trigger" : plan.trigger.capabilityId === "generic_webhook_trigger" ? "webhook_trigger" : "public_form_trigger", capabilityId: plan.trigger.capabilityId, title: plan.trigger.displayName, description: plan.trigger.capabilityId.startsWith("gmail_") ? "Starts from a new message resolved through Gmail history." : plan.trigger.capabilityId === "slack_new_channel_message" ? `Starts from a new message in ${plan.trigger.instruction ?? "the selected Slack channel"}.` : plan.trigger.capabilityId.startsWith("notion_page_") ? "Starts from a verified Notion event." : plan.trigger.capabilityId === "manual_trigger" ? "Starts when you explicitly run this workflow." : plan.trigger.capabilityId === "generic_webhook_trigger" ? "Starts from an authenticated CrazyLoops webhook endpoint." : "Starts when someone submits the hosted CrazyLoops form.", ...(plan.trigger.capabilityId === "slack_new_channel_message" ? { inputsRequired: [{ key: "channel", label: "Slack channel", type: "text" as const }] } : plan.trigger.capabilityId.startsWith("notion_page_") ? { inputsRequired: [{ key: "resourceId", label: "Notion page or data source", type: "text" as const }] } : {}), ...(plan.trigger.capabilityId.startsWith("gmail_") ? { config: { connector: { connectorId: "google_gmail", operationKind: "trigger" as const, operationKey: plan.trigger.capabilityId === "gmail_new_email_matching_search" ? "new_email_matching_search" : "new_email", operationVersion: 1, mappings: [], ...(plan.trigger.instruction ? { settings: { search: plan.trigger.instruction } } : {}) } } } : plan.trigger.capabilityId === "slack_new_channel_message" ? { config: { connector: { connectorId: "slack", operationKind: "trigger" as const, operationKey: "new_channel_message", operationVersion: 1, mappings: [], settings: { ...(plan.trigger.instruction ? { channelNameHint: plan.trigger.instruction } : {}) } } } } : plan.trigger.capabilityId.startsWith("notion_page_") ? { config: { connector: { connectorId: "notion", operationKind: "trigger" as const, operationKey: plan.trigger.capabilityId === "notion_page_created_or_added" ? "page_created_or_added" : "page_updated", operationVersion: 1, mappings: [], settings: {} } } } : plan.trigger.capabilityId === "generic_webhook_trigger" ? { config: { connector: { connectorId: "flowmind_webhook", operationKind: "trigger" as const, operationKey: "event_received", operationVersion: 1, mappings: [] } } } : {}) };

  const steps: Step[] = [trigger];
  const latestFormatterStepByTriggerPath = new Map<string, string>();
  for (const transformation of plan.transformations) {
    const id = `step_${steps.length + 1}`;
    const formatter = transformation.formatter
      ? {
          ...transformation.formatter,
          source: transformation.formatter.source.kind === "trigger" && transformation.formatter.source.path && latestFormatterStepByTriggerPath.has(transformation.formatter.source.path)
            ? { kind: "step" as const, stepId: latestFormatterStepByTriggerPath.get(transformation.formatter.source.path), path: "value" }
            : transformation.formatter.source,
        }
      : null;
    steps.push(transformation.capabilityId === "formatter.transform" && formatter
      ? { id, type: "formatter_transform", capabilityId: "formatter.transform", title: formatterTitle(transformation), description: formatterDescription(transformation), config: { formatter } }
      : transformation.capabilityId === "notion_find_item"
      ? { id, type: "connector_action", capabilityId: "notion_find_item", title: transformation.displayName, description: "Finds exactly one item in the selected Notion data source.", inputsRequired: [{ key: "dataSourceId", label: "Notion data source", type: "text" }, { key: "matchProperty", label: "Exact-match property", type: "text" }, { key: "matchValue", label: "Value to find", type: "text" }], config: { connector: { connectorId: "notion", operationKind: "action", operationKey: "find_item", operationVersion: 1, mappings: [] } } }
      : { id, type: "ai_transform", capabilityId: "ai_text_transform", title: transformationTitle(transformation.instruction ?? "", steps.length - 1), description: transformation.instruction ?? "Transform the input.", config: { transformPrompt: transformation.instruction ?? "Transform the input accurately." } });
    if (transformation.formatter?.source.kind === "trigger" && transformation.formatter.source.path) {
      latestFormatterStepByTriggerPath.set(transformation.formatter.source.path, id);
    }
  }

  if (plan.condition) {
    const conditionId = `step_${steps.length + 1}`;
    steps.push({ id: conditionId, type: "filter_condition", capabilityId: "condition.if", title: plan.condition.humanLabel, description: `${plan.condition.humanLabel}. Only the matching branch will run.`, config: { condition: { sourcePath: plan.condition.sourcePath, operator: plan.condition.operator, ...(plan.condition.expectedValue !== undefined ? { expectedValue: plan.condition.expectedValue } : {}), humanLabel: plan.condition.humanLabel } } });
    steps.push(destinationStep(plan.destination, `step_${steps.length + 1}`, prompt, steps, workflowName, { conditionStepId: conditionId, when: "true" }));
    if (plan.otherwiseDestination) steps.push(destinationStep(plan.otherwiseDestination, `step_${steps.length + 1}`, prompt, steps, workflowName, { conditionStepId: conditionId, when: "false" }));
  } else {
    steps.push(destinationStep(plan.destination, `step_${steps.length + 1}`, prompt, steps, workflowName));
  }

  const triggerSummary = plan.schedule?.humanLabel
    ?? (plan.trigger.capabilityId === "generic_webhook_trigger" ? "Receives an authenticated CrazyLoops webhook event" : plan.trigger.displayName);
  const describeDestination = (destination: typeof plan.destination) => destination.capabilityId === "generic_http_action"
    ? "posts the result as JSON"
    : destination.displayName;
  const summary = [triggerSummary, ...plan.transformations.map((item) => item.displayName), ...(plan.condition ? [plan.condition.humanLabel, `${describeDestination(plan.destination)}${plan.otherwiseDestination ? `; otherwise ${describeDestination(plan.otherwiseDestination)}` : ""}`] : [describeDestination(plan.destination)])].join(" → ").slice(0, 300);
  const basePublicForm = plan.trigger.capabilityId === "public_form_submission" ? createPublicFormDefinition(prompt, workflowName, summary) : undefined;
  const formatterFields = plan.transformations.flatMap((transformation) => transformation.formatter
    ? [transformation.formatter.source, ...(transformation.formatter.sources ?? [])]
        .filter((source) => source.kind === "trigger" && source.path)
        .map((source) => ({ key: source.path as string, label: (source.path as string).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()), type: "text" as const, required: false }))
    : []);
  const publicForm = basePublicForm ? {
    ...basePublicForm,
    fields: [...basePublicForm.fields,
      ...(plan.condition && plan.condition.sourcePath !== "ai_result" && !basePublicForm.fields.some((field) => field.key === plan.condition?.sourcePath) && basePublicForm.fields.length < 10
        ? [{ key: plan.condition.sourcePath, label: plan.condition.sourcePath.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()), type: typeof plan.condition.expectedValue === "number" ? "number" as const : "text" as const, required: true }]
        : []),
      ...formatterFields.filter((candidate, index, fields) =>
        !basePublicForm.fields.some((field) => field.key === candidate.key)
        && fields.findIndex((field) => field.key === candidate.key) === index),
    ].slice(0, 10),
    successMessage: "Your submission was processed by the configured CrazyLoops loop.",
  } : undefined;
  return annotateWorkflowCapabilities(CompiledWorkflowSchema.parse({ workflowName, summary, steps, publicForm, dataTable: publicForm ? createDefaultDataTableDefinition(publicForm) : undefined }));
}
