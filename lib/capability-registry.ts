import type { CompiledWorkflow } from "@/lib/schemas/workflow";

export type CapabilityCategory = "trigger" | "transformation" | "destination";
export type ExecutionMode = "test" | "production";

export type CapabilityDefinition = {
  id: string;
  displayName: string;
  category: CapabilityCategory;
  supported: boolean;
  executionImplementation: string | null;
  requiredSetupFields: Array<{
    key: string;
    label: string;
    type: "text" | "url" | "secret";
  }>;
  credentialsRequired: boolean;
  availableInTest: boolean;
  availableInProduction: boolean;
  limitations: string[];
  aliases: string[];
};

const defineCapability = <T extends CapabilityDefinition>(capability: T) => capability;

/**
 * FlowMind's authoritative capability registry.
 *
 * Planning, compilation, existing-workflow validation, and execution all consult
 * this registry. Provider model output is never allowed to declare support.
 */
export const CAPABILITY_REGISTRY = {
  manual_trigger: defineCapability({
    id: "manual_trigger", displayName: "Manual run", category: "trigger", supported: true,
    executionImplementation: "flowmind-test-run", requiredSetupFields: [], credentialsRequired: false,
    availableInTest: true, availableInProduction: true, limitations: ["Starts only when an authenticated owner explicitly runs the workflow."], aliases: ["manual", "manually", "when i run"],
  }),
  public_form_submission: defineCapability({
    id: "public_form_submission",
    displayName: "Public form submission",
    category: "trigger",
    supported: true,
    executionImplementation: "flowmind-public-form-route",
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: true,
    availableInProduction: true,
    limitations: [
      "Starts only when a FlowMind hosted form is submitted or a test event is run.",
    ],
    aliases: ["form", "form submission", "survey", "intake", "feedback"],
  }),
  generic_webhook_trigger: defineCapability({
    id: "generic_webhook_trigger",
    displayName: "Incoming webhook",
    category: "trigger",
    supported: true,
    executionImplementation: "connector:flowmind_webhook/event_received@1",
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: true,
    availableInProduction: true,
    limitations: ["Accepts authenticated, bounded JSON events on a published workflow endpoint."],
    aliases: ["incoming webhook", "webhook trigger", "when a webhook arrives"],
  }),
  generic_http_action: defineCapability({
    id: "generic_http_action",
    displayName: "HTTP request",
    category: "destination",
    supported: true,
    executionImplementation: "connector:flowmind_http/post_json@1",
    requiredSetupFields: [{ key: "destination_url", label: "Destination URL", type: "url" }],
    credentialsRequired: false,
    availableInTest: true,
    availableInProduction: true,
    limitations: ["HTTPS JSON POST only; private networks and redirects are blocked."],
    aliases: ["http request", "post json", "send to webhook"],
  }),
  ai_text_transform: defineCapability({
    id: "ai_text_transform",
    displayName: "AI text transformation",
    category: "transformation",
    supported: true,
    executionImplementation: "groq-text-generation",
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: true,
    availableInProduction: true,
    limitations: [
      "Text-only transformation with bounded input, output, and execution time.",
      "Requires the server-side GROQ_API_KEY setting.",
    ],
    aliases: ["ai", "summarize", "classify", "sentiment", "analyze", "draft"],
  }),
  flowmind_data_store: defineCapability({
    id: "flowmind_data_store",
    displayName: "Store inside FlowMind",
    category: "destination",
    supported: true,
    executionImplementation: "workflow-executions-table",
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: true,
    availableInProduction: true,
    limitations: ["Stores submission and result data only inside FlowMind."],
    aliases: ["flowmind", "internal table", "data table", "store", "save"],
  }),
  generate_pdf: defineCapability({
    id: "generate_pdf",
    displayName: "Generate PDF",
    category: "destination",
    supported: true,
    executionImplementation: "pdf-lib-and-supabase-storage",
    requiredSetupFields: [
      { key: "document_template", label: "Document template", type: "text" },
    ],
    credentialsRequired: false,
    availableInTest: true,
    availableInProduction: true,
    limitations: ["Generates text-based PDF documents from a FlowMind template."],
    aliases: ["pdf", "invoice", "proposal", "document", "report"],
  }),
  webhook_post: defineCapability({
    id: "webhook_post",
    displayName: "Send to a webhook",
    category: "destination",
    supported: true,
    executionImplementation: "outbound-json-post",
    requiredSetupFields: [
      { key: "destination_url", label: "Destination URL", type: "url" },
    ],
    credentialsRequired: false,
    availableInTest: true,
    availableInProduction: false,
    limitations: [
      "Available for acknowledged test deliveries only; public-form production delivery is not enabled.",
    ],
    aliases: ["webhook", "webhook.site"],
  }),
  schedule_trigger: defineCapability({
    id: "schedule_trigger",
    displayName: "Scheduled trigger",
    category: "trigger",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["Scheduling is coming soon and is not currently executed by FlowMind."],
    aliases: [
      "schedule",
      "scheduled",
      "daily",
      "weekly",
      "monthly",
      "every day",
      "every week",
      "every weekday",
      "every morning",
      "every evening",
    ],
  }),
  rss_ingestion: defineCapability({
    id: "rss_ingestion",
    displayName: "RSS or source ingestion",
    category: "trigger",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["FlowMind does not currently run a source polling worker."],
    aliases: [
      "rss",
      "feed",
      "news feed",
      "trending topics",
      "monitor website",
      "watch website",
      "scrape website",
      "poll website",
      "fetch from website",
    ],
  }),
  email_ingestion: defineCapability({
    id: "email_ingestion",
    displayName: "Incoming email trigger",
    category: "trigger",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: true,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["FlowMind does not currently ingest incoming email events."],
    aliases: ["incoming email", "email arrives", "new email", "customer emails"],
  }),
  salesforce: defineCapability({
    id: "salesforce",
    displayName: "Salesforce",
    category: "destination",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: true,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["Salesforce is not currently supported."],
    aliases: ["salesforce"],
  }),
  gmail_new_email: defineCapability({
    id: "gmail_new_email", displayName: "New Gmail email", category: "trigger", supported: true,
    executionImplementation: "connector:google_gmail/new_email@1", requiredSetupFields: [], credentialsRequired: true,
    availableInTest: true, availableInProduction: true,
    limitations: ["Beta until Google OAuth verification and live production acceptance are complete."], aliases: ["gmail message arrives", "new gmail", "gmail email arrives"],
  }),
  gmail_new_email_matching_search: defineCapability({
    id: "gmail_new_email_matching_search", displayName: "New Gmail email matching search", category: "trigger", supported: true,
    executionImplementation: "connector:google_gmail/new_email_matching_search@1", requiredSetupFields: [{ key: "search", label: "Email filter", type: "text" }], credentialsRequired: true,
    availableInTest: true, availableInProduction: true,
    limitations: ["Uses Gmail-compatible search and requires a resolved filter."], aliases: ["gmail contains", "gmail from", "email contains"],
  }),
  gmail_send_email: defineCapability({
    id: "gmail_send_email", displayName: "Send email through Gmail", category: "destination", supported: true,
    executionImplementation: "connector:google_gmail/send_email@1", requiredSetupFields: [{ key: "to", label: "To", type: "text" }, { key: "subject", label: "Subject", type: "text" }, { key: "body", label: "Body", type: "text" }], credentialsRequired: true,
    availableInTest: true, availableInProduction: true,
    limitations: ["Requires Gmail acknowledgement; ambiguous sends are never retried automatically."], aliases: ["send through gmail", "gmail send", "email it through gmail"],
  }),
  gmail_reply_to_email: defineCapability({
    id: "gmail_reply_to_email", displayName: "Reply in Gmail", category: "destination", supported: true,
    executionImplementation: "connector:google_gmail/reply_to_email@1", requiredSetupFields: [{ key: "messageId", label: "Gmail message", type: "text" }, { key: "threadId", label: "Gmail thread", type: "text" }, { key: "body", label: "Reply", type: "text" }], credentialsRequired: true,
    availableInTest: true, availableInProduction: true,
    limitations: ["Requires a valid Gmail message and thread reference."], aliases: ["reply in gmail", "gmail reply", "reply to email"],
  }),
  google_sheets_add_row: defineCapability({
    id: "google_sheets_add_row",
    displayName: "Add row to Google Sheets",
    category: "destination",
    supported: true,
    executionImplementation: "connector:google_sheets/add_row@1",
    requiredSetupFields: [{ key: "spreadsheetId", label: "Spreadsheet", type: "text" }, { key: "worksheet", label: "Worksheet", type: "text" }],
    credentialsRequired: true,
    availableInTest: true,
    availableInProduction: true,
    limitations: ["Beta until Google OAuth verification and live production acceptance are complete.", "Writes use RAW value semantics."],
    aliases: ["add to google sheets", "add row to google sheet", "save to google sheets", "google sheets", "google sheet"],
  }),
  google_sheets_find_row: defineCapability({
    id: "google_sheets_find_row", displayName: "Find row in Google Sheets", category: "transformation", supported: true,
    executionImplementation: "connector:google_sheets/find_row@1", requiredSetupFields: [{ key: "spreadsheetId", label: "Spreadsheet", type: "text" }, { key: "worksheet", label: "Worksheet", type: "text" }, { key: "matchColumn", label: "Lookup column", type: "text" }], credentialsRequired: true,
    availableInTest: true, availableInProduction: true, limitations: ["Exact matches only; multiple matches fail clearly."], aliases: ["find row in google sheets", "lookup in google sheets"],
  }),
  google_sheets_update_row: defineCapability({
    id: "google_sheets_update_row", displayName: "Update row in Google Sheets", category: "destination", supported: true,
    executionImplementation: "connector:google_sheets/update_row@1", requiredSetupFields: [{ key: "spreadsheetId", label: "Spreadsheet", type: "text" }, { key: "worksheet", label: "Worksheet", type: "text" }], credentialsRequired: true,
    availableInTest: true, availableInProduction: true, limitations: ["Requires an explicit unique row reference."], aliases: ["update row in google sheets"],
  }),
  google_calendar: defineCapability({
    id: "google_calendar", displayName: "Google Calendar", category: "destination", supported: false,
    executionImplementation: null, requiredSetupFields: [], credentialsRequired: true,
    availableInTest: false, availableInProduction: false,
    limitations: ["Google Calendar is not currently supported."], aliases: ["google calendar", "calendar event"],
  }),
  google_drive: defineCapability({
    id: "google_drive", displayName: "Google Drive", category: "destination", supported: false,
    executionImplementation: null, requiredSetupFields: [], credentialsRequired: true,
    availableInTest: false, availableInProduction: false,
    limitations: ["Google Drive is not currently supported."], aliases: ["google drive", "upload to drive", "save to drive"],
  }),
  slack: defineCapability({
    id: "slack",
    displayName: "Slack",
    category: "destination",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: true,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["Slack delivery is not currently supported."],
    aliases: ["slack"],
  }),
  stripe: defineCapability({
    id: "stripe",
    displayName: "Stripe payments",
    category: "destination",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: true,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["Stripe charging is not currently supported."],
    aliases: ["stripe", "charge the customer", "take payment", "collect payment"],
  }),
  whatsapp: defineCapability({
    id: "whatsapp",
    displayName: "WhatsApp",
    category: "destination",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: true,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["WhatsApp delivery is not currently supported."],
    aliases: ["whatsapp"],
  }),
  quickbooks: defineCapability({
    id: "quickbooks",
    displayName: "QuickBooks",
    category: "destination",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: true,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["QuickBooks is not currently supported."],
    aliases: ["quickbooks", "quick books"],
  }),
  email_delivery: defineCapability({
    id: "email_delivery",
    displayName: "Email delivery",
    category: "destination",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: true,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["Outbound email delivery is not currently supported."],
    aliases: ["send email", "email alert", "email notification", "email it"],
  }),
  human_approval: defineCapability({
    id: "human_approval",
    displayName: "Human approval",
    category: "transformation",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["Approval gates are not currently supported."],
    aliases: ["ask me before", "approval", "approve before", "review before"],
  }),
  external_integration: defineCapability({
    id: "external_integration",
    displayName: "External app integration",
    category: "destination",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: true,
    availableInTest: false,
    availableInProduction: false,
    limitations: [
      "Unlisted external app integrations are not currently supported.",
    ],
    aliases: [],
  }),
} as const satisfies Record<string, CapabilityDefinition>;

export type CapabilityId = keyof typeof CAPABILITY_REGISTRY;
type WorkflowStepType = CompiledWorkflow["steps"][number]["type"];

export type CapabilityAssessment = {
  capabilityId: string;
  displayName: string;
  supported: boolean;
  available: boolean;
  status: "supported" | "test_only" | "unsupported";
  message: string | null;
};

export function getCapability(capabilityId: string): CapabilityDefinition | null {
  return CAPABILITY_REGISTRY[capabilityId as CapabilityId] ?? null;
}

function containsAlias(text: string, alias: string): boolean {
  const escaped = alias
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

export function findRequestedUnsupportedCapabilities(prompt: string): CapabilityDefinition[] {
  const normalized = prompt.toLowerCase();
  return Object.values(CAPABILITY_REGISTRY).filter(
    (capability) =>
      !capability.supported &&
      capability.aliases.some((alias) => containsAlias(normalized, alias)),
  );
}

function legacyIntegrationCapability(step: CompiledWorkflow["steps"][number]): string | null {
  const context = `${step.title} ${step.description} ${step.config?.endpoint ?? ""}`.toLowerCase();
  for (const capability of Object.values(CAPABILITY_REGISTRY)) {
    if (capability.supported || capability.id === "schedule_trigger" || capability.id === "rss_ingestion") {
      continue;
    }
    if (capability.aliases.some((alias) => containsAlias(context, alias))) {
      return capability.id;
    }
  }
  if (/schedule|every day|daily|weekly|monthly/.test(context)) return "schedule_trigger";
  if (/\brss\b|\bfeed\b|\btrending topics\b|\bpoll(?:ing)?\b/.test(context)) return "rss_ingestion";
  return null;
}

export function resolveStepCapabilityId(
  step: CompiledWorkflow["steps"][number],
): string | null {
  if (step.capabilityId) {
    const compatibleTypes: Partial<Record<CapabilityId, WorkflowStepType[]>> = {
      public_form_submission: ["public_form_trigger", "webhook_trigger"],
      manual_trigger: ["connector_trigger"],
      generic_webhook_trigger: ["webhook_trigger"],
      ai_text_transform: ["ai_transform"],
      flowmind_data_store: ["store_data"],
      generate_pdf: ["generate_pdf"],
      webhook_post: ["webhook_post", "http_request"],
      generic_http_action: ["webhook_post", "http_request"],
      gmail_new_email: ["connector_trigger"],
      gmail_new_email_matching_search: ["connector_trigger"],
      gmail_send_email: ["connector_action"],
      gmail_reply_to_email: ["connector_action"],
      google_sheets_add_row: ["connector_action"],
      google_sheets_find_row: ["connector_action"],
      google_sheets_update_row: ["connector_action"],
    };
    const compatible = compatibleTypes[step.capabilityId as CapabilityId];
    return compatible?.includes(step.type) ? step.capabilityId : null;
  }

  const unsupportedLegacyCapability = legacyIntegrationCapability(step);
  if (unsupportedLegacyCapability) return unsupportedLegacyCapability;

  switch (step.type) {
    case "public_form_trigger":
      return "public_form_submission";
    case "webhook_trigger": {
      const context = `${step.title} ${step.description}`;
      return /\b(form|submission|survey|intake|feedback)\b/i.test(context)
        ? "public_form_submission"
        : step.config?.connector?.connectorId === "flowmind_webhook"
          ? "generic_webhook_trigger"
          : null;
    }
    case "ai_transform":
      return "ai_text_transform";
    case "store_data":
      return "flowmind_data_store";
    case "generate_pdf":
      return "generate_pdf";
    case "webhook_post":
    case "http_request":
      return step.config?.connector?.connectorId === "flowmind_http"
        ? "generic_http_action"
        : "webhook_post";
    case "filter_condition":
      return null;
    case "connector_trigger":
    case "connector_action":
      return step.capabilityId ?? null;
  }
}

export function assessCapability(
  capabilityId: string | null,
  mode: ExecutionMode,
): CapabilityAssessment {
  const capability = capabilityId ? getCapability(capabilityId) : null;
  if (!capability) {
    return {
      capabilityId: capabilityId ?? "unknown",
      displayName: "Unknown capability",
      supported: false,
      available: false,
      status: "unsupported",
      message: "This workflow step is not recognized by the current FlowMind runtime.",
    };
  }

  const available =
    capability.supported &&
    (mode === "test" ? capability.availableInTest : capability.availableInProduction);
  const testOnly =
    capability.supported && capability.availableInTest && !capability.availableInProduction;
  return {
    capabilityId: capability.id,
    displayName: capability.displayName,
    supported: capability.supported,
    available,
    status: available ? "supported" : testOnly ? "test_only" : "unsupported",
    message: available
      ? null
      : capability.limitations[0] ?? `${capability.displayName} is not currently supported.`,
  };
}

export function assessWorkflowCapabilities(
  steps: CompiledWorkflow["steps"],
  mode: ExecutionMode,
) {
  return steps.map((step) => ({
    step,
    assessment: assessCapability(resolveStepCapabilityId(step), mode),
  }));
}

const COSTLY_PUBLIC_CAPABILITIES = new Set<CapabilityId>([
  "ai_text_transform",
  "generate_pdf",
]);

/** Costly public workflows must pass a bot challenge before consuming quota. */
export function requiresPublicFormTurnstile(
  steps: CompiledWorkflow["steps"],
): boolean {
  return steps.some((step) => {
    const capabilityId = resolveStepCapabilityId(step);
    return capabilityId !== null && COSTLY_PUBLIC_CAPABILITIES.has(capabilityId as CapabilityId);
  });
}

export function annotateWorkflowCapabilities(
  workflow: CompiledWorkflow,
  mode: ExecutionMode = "production",
): CompiledWorkflow {
  return {
    ...workflow,
    steps: workflow.steps.map((step) => {
      const assessment = assessCapability(resolveStepCapabilityId(step), mode);
      return {
        ...step,
        capabilityId: assessment.capabilityId,
        capabilityStatus: assessment.status,
        ...(assessment.message ? { capabilityMessage: assessment.message } : {}),
      };
    }),
  };
}
