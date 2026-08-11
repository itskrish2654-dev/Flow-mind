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
  google_sheets: defineCapability({
    id: "google_sheets",
    displayName: "Google Sheets",
    category: "destination",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: true,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["Google Sheets delivery is not currently supported."],
    aliases: ["google sheets", "google sheet", "sheets"],
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
      ai_text_transform: ["ai_transform"],
      flowmind_data_store: ["store_data"],
      generate_pdf: ["generate_pdf"],
      webhook_post: ["webhook_post", "http_request"],
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
      return "webhook_post";
    case "filter_condition":
      return null;
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
