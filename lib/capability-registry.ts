import type { CompiledWorkflow } from "@/lib/schemas/workflow";
import type { ExecutorKind } from "@/lib/executors/types";

export type CapabilityCategory = "trigger" | "transformation" | "control" | "destination";
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
  executorVersions: Readonly<Record<number, ExecutorKind>>;
  defaultCapabilityVersion: number;
  internalOnly: boolean;
  plannerVisible: boolean;
};

type CapabilityDefinitionInput = Omit<
  CapabilityDefinition,
  "executorVersions" | "defaultCapabilityVersion" | "internalOnly" | "plannerVisible"
> & Partial<Pick<CapabilityDefinition, "executorVersions" | "defaultCapabilityVersion" | "internalOnly" | "plannerVisible">>;

const defineCapability = <T extends CapabilityDefinitionInput>(capability: T): CapabilityDefinition & T => ({
  executorVersions: { 1: "native" },
  defaultCapabilityVersion: 1,
  internalOnly: false,
  plannerVisible: true,
  ...capability,
});

/**
 * CrazyLoops' authoritative capability registry.
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
      "Starts only when a CrazyLoops hosted form is submitted or a test event is run.",
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
  "http.request": defineCapability({
    id: "http.request",
    displayName: "HTTP request",
    category: "transformation",
    supported: true,
    executionImplementation: "connector:flowmind_http/request@2",
    requiredSetupFields: [{ key: "destination_url", label: "API endpoint", type: "url" }],
    credentialsRequired: false,
    availableInTest: true,
    availableInProduction: true,
    limitations: [
      "Supports GET, POST, PUT, PATCH, and DELETE to public HTTPS endpoints only.",
      "Private, local, metadata, redirect, oversized, and DNS-rebinding destinations are blocked.",
      "Bearer tokens, Basic Auth passwords, and API keys are stored only in the encrypted workflow vault.",
    ],
    aliases: ["api request", "http get", "http post", "http put", "http patch", "http delete", "call an api", "fetch api"],
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
  "formatter.transform": defineCapability({
    id: "formatter.transform",
    displayName: "Formatter",
    category: "transformation",
    supported: true,
    executionImplementation: "deterministic-formatter-v1",
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: true,
    availableInProduction: true,
    limitations: [
      "Supports only the documented bounded text, number, date/time, and fallback operations.",
      "Date/time inputs must be ISO dates or timestamps with an explicit offset; unqualified formatting uses UTC.",
    ],
    aliases: ["trim", "uppercase", "lowercase", "title case", "replace text", "split", "join", "prepend", "append", "multiply", "divide", "round", "format date", "timezone", "default value", "first non-empty"],
  }),
  flowmind_data_store: defineCapability({
    id: "flowmind_data_store",
    displayName: "Store inside CrazyLoops",
    category: "destination",
    supported: true,
    executionImplementation: "workflow-executions-table",
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: true,
    availableInProduction: true,
    limitations: ["Stores submission and result data only inside CrazyLoops."],
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
    limitations: ["Generates text-based PDF documents from a CrazyLoops template."],
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
  "schedule.trigger": defineCapability({
    id: "schedule.trigger",
    displayName: "Scheduled trigger",
    category: "trigger",
    supported: true,
    executionImplementation: "durable-schedule-dispatch",
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: true,
    availableInProduction: true,
    limitations: [
      "Uses an explicit IANA timezone.",
      "After an outage, only the most recent occurrence within the 15-minute recovery window runs; older occurrences are recorded as missed.",
    ],
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
  "condition.if": defineCapability({
    id: "condition.if",
    displayName: "If / Otherwise",
    category: "control",
    supported: true,
    executionImplementation: "structured-condition-runtime",
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: true,
    availableInProduction: true,
    limitations: ["Supports one human-readable branch with structured comparisons; complex nested branches are not supported."],
    aliases: ["if", "otherwise", "only when", "unless"],
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
    limitations: ["CrazyLoops does not currently run a source polling worker."],
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
    limitations: ["CrazyLoops does not currently ingest incoming email events."],
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
  calendly: defineCapability({
    id: "calendly", displayName: "Calendly", category: "trigger", supported: false,
    executionImplementation: null, requiredSetupFields: [], credentialsRequired: true,
    availableInTest: false, availableInProduction: false,
    limitations: ["Calendly is not currently supported."], aliases: ["calendly"],
  }),
  hubspot: defineCapability({
    id: "hubspot", displayName: "HubSpot", category: "destination", supported: false,
    executionImplementation: null, requiredSetupFields: [], credentialsRequired: true,
    availableInTest: false, availableInProduction: false,
    limitations: ["HubSpot is not currently supported."], aliases: ["hubspot", "hub spot"],
  }),
  airtable: defineCapability({
    id: "airtable", displayName: "Airtable", category: "destination", supported: false,
    executionImplementation: null, requiredSetupFields: [], credentialsRequired: true,
    availableInTest: false, availableInProduction: false,
    limitations: ["Airtable is not currently supported."], aliases: ["airtable", "air table"],
  }),
  tiktok: defineCapability({
    id: "tiktok",
    displayName: "TikTok",
    category: "trigger",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: true,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["TikTok events are not currently supported."],
    aliases: ["tiktok", "tik tok"],
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
    requiredSetupFields: [{ key: "spreadsheetId", label: "Picker-selected spreadsheet", type: "text" }, { key: "worksheet", label: "Worksheet", type: "text" }],
    credentialsRequired: true,
    availableInTest: true,
    availableInProduction: true,
    limitations: ["Beta until Google OAuth verification and live production acceptance are complete.", "Writes use RAW value semantics."],
    aliases: ["add to google sheets", "add row to google sheet", "save to google sheets", "google sheets", "google sheet"],
  }),
  google_sheets_find_row: defineCapability({
    id: "google_sheets_find_row", displayName: "Find row in Google Sheets", category: "transformation", supported: true,
    executionImplementation: "connector:google_sheets/find_row@1", requiredSetupFields: [{ key: "spreadsheetId", label: "Picker-selected spreadsheet", type: "text" }, { key: "worksheet", label: "Worksheet", type: "text" }, { key: "matchColumn", label: "Lookup column", type: "text" }], credentialsRequired: true,
    availableInTest: true, availableInProduction: true, limitations: ["Exact matches only; multiple matches fail clearly."], aliases: ["find row in google sheets", "lookup in google sheets"],
  }),
  google_sheets_update_row: defineCapability({
    id: "google_sheets_update_row", displayName: "Update row in Google Sheets", category: "destination", supported: true,
    executionImplementation: "connector:google_sheets/update_row@1", requiredSetupFields: [{ key: "spreadsheetId", label: "Picker-selected spreadsheet", type: "text" }, { key: "worksheet", label: "Worksheet", type: "text" }], credentialsRequired: true,
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
  slack_new_channel_message: defineCapability({
    id: "slack_new_channel_message", displayName: "New message in Slack channel", category: "trigger", supported: true,
    executionImplementation: "connector:slack/new_channel_message@1", requiredSetupFields: [{ key: "channel", label: "Slack channel", type: "text" }], credentialsRequired: true,
    availableInTest: true, availableInProduction: true, limitations: ["Beta until live Slack acceptance is complete.", "Public channels accessible to the installed bot only."], aliases: ["slack message", "message in slack", "posts in slack"],
  }),
  slack_send_channel_message: defineCapability({
    id: "slack_send_channel_message", displayName: "Send Slack channel message", category: "destination", supported: true,
    executionImplementation: "connector:slack/send_channel_message@1", requiredSetupFields: [{ key: "channel", label: "Slack channel", type: "text" }, { key: "text", label: "Message", type: "text" }], credentialsRequired: true,
    availableInTest: true, availableInProduction: true, limitations: ["Requires Slack acknowledgement before delivery is reported."], aliases: ["send to slack", "post to slack", "slack alert"],
  }),
  slack_reply_in_thread: defineCapability({
    id: "slack_reply_in_thread", displayName: "Reply in Slack thread", category: "destination", supported: true,
    executionImplementation: "connector:slack/reply_in_thread@1", requiredSetupFields: [{ key: "channel", label: "Slack channel", type: "text" }, { key: "threadTs", label: "Slack thread", type: "text" }, { key: "text", label: "Reply", type: "text" }], credentialsRequired: true,
    availableInTest: true, availableInProduction: true, limitations: ["Requires an exact Slack thread reference."], aliases: ["reply in slack thread", "slack thread reply"],
  }),
  notion_page_created_or_added: defineCapability({
    id: "notion_page_created_or_added", displayName: "Notion page created or added", category: "trigger", supported: true,
    executionImplementation: "connector:notion/page_created_or_added@1", requiredSetupFields: [{ key: "resourceId", label: "Notion page or data source", type: "text" }], credentialsRequired: true,
    availableInTest: true, availableInProduction: true, limitations: ["Beta until live Notion acceptance is complete.", "Only explicitly shared resources are visible."], aliases: ["notion page created", "new notion page"],
  }),
  notion_page_updated: defineCapability({
    id: "notion_page_updated", displayName: "Notion page updated", category: "trigger", supported: true,
    executionImplementation: "connector:notion/page_updated@1", requiredSetupFields: [{ key: "resourceId", label: "Notion page or data source", type: "text" }], credentialsRequired: true,
    availableInTest: true, availableInProduction: true, limitations: ["Fetches current page metadata after a verified webhook event."], aliases: ["notion page updated", "notion update"],
  }),
  notion_create_page: defineCapability({
    id: "notion_create_page", displayName: "Create Notion page", category: "destination", supported: true,
    executionImplementation: "connector:notion/create_page@1", requiredSetupFields: [{ key: "parentPageId", label: "Parent page", type: "text" }, { key: "title", label: "Title", type: "text" }, { key: "content", label: "Content", type: "text" }], credentialsRequired: true,
    availableInTest: true, availableInProduction: true, limitations: ["Parent page must be shared with the Notion connection."], aliases: ["create notion page"],
  }),
  notion_create_data_source_item: defineCapability({
    id: "notion_create_data_source_item", displayName: "Add item to Notion data source", category: "destination", supported: true,
    executionImplementation: "connector:notion/create_data_source_item@1", requiredSetupFields: [{ key: "dataSourceId", label: "Data source", type: "text" }], credentialsRequired: true,
    availableInTest: true, availableInProduction: true, limitations: ["Only existing supported properties are mapped."], aliases: ["add to notion", "save to notion", "notion data source", "notion database"],
  }),
  notion_find_item: defineCapability({
    id: "notion_find_item", displayName: "Find Notion item", category: "transformation", supported: true,
    executionImplementation: "connector:notion/find_item@1", requiredSetupFields: [{ key: "dataSourceId", label: "Data source", type: "text" }, { key: "matchProperty", label: "Property", type: "text" }, { key: "matchValue", label: "Exact value", type: "text" }], credentialsRequired: true,
    availableInTest: true, availableInProduction: true, limitations: ["Exact match only; multiple matches fail as ambiguous."], aliases: ["find notion item", "lookup notion item"],
  }),
  notion_update_item: defineCapability({
    id: "notion_update_item", displayName: "Update Notion item", category: "destination", supported: true,
    executionImplementation: "connector:notion/update_item@1", requiredSetupFields: [{ key: "dataSourceId", label: "Data source", type: "text" }, { key: "pageId", label: "Page or item", type: "text" }], credentialsRequired: true,
    availableInTest: true, availableInProduction: true, limitations: ["Requires an exact page/item ID or a preceding unambiguous find."], aliases: ["update notion item", "update in notion"],
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
  "wait.delay": defineCapability({
    id: "wait.delay",
    displayName: "Wait / Delay",
    category: "control",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["Wait / Delay is not currently supported."],
    aliases: ["wait", "delay", "pause for", "sleep for"],
  }),
  "for_each": defineCapability({
    id: "for_each",
    displayName: "For Each",
    category: "control",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["For Each is not currently supported."],
    aliases: ["for each", "every item", "each item", "loop over"],
  }),
  "formatter.scripting": defineCapability({
    id: "formatter.scripting",
    displayName: "Custom formatter scripts",
    category: "transformation",
    supported: false,
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["Custom code, formulas, and regular expressions are not supported by Formatter."],
    aliases: ["regular expression", "regex", "javascript formatter", "custom script", "arbitrary formula"],
  }),
  "internal.bridge_echo": defineCapability({
    id: "internal.bridge_echo",
    displayName: "Internal bridge echo",
    category: "transformation",
    supported: true,
    executionImplementation: "delegated:activepieces/internal.bridge_echo@1",
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: true,
    availableInProduction: true,
    limitations: ["Internal infrastructure verification only."],
    aliases: [],
    executorVersions: { 1: "activepieces" },
    defaultCapabilityVersion: 1,
    internalOnly: true,
    plannerVisible: false,
  }),
  "internal.connector_runner_canary": defineCapability({
    id: "internal.connector_runner_canary",
    displayName: "Internal connector runner canary",
    category: "transformation",
    supported: true,
    executionImplementation: "delegated:connector_runner/internal.connector_runner_canary@1",
    requiredSetupFields: [],
    credentialsRequired: true,
    availableInTest: true,
    availableInProduction: false,
    limitations: ["Internal credential-safety verification only."],
    aliases: [],
    executorVersions: { 1: "connector_runner" },
    defaultCapabilityVersion: 1,
    internalOnly: true,
    plannerVisible: false,
  }),
  "airtable.create_record": defineCapability({
    id: "airtable.create_record",
    displayName: "Create Airtable record",
    category: "destination",
    supported: true,
    executionImplementation: "connector:airtable/create_record@1",
    requiredSetupFields: [
      { key: "baseId", label: "Airtable Base ID", type: "text" },
      { key: "tableId", label: "Airtable Table ID", type: "text" },
      { key: "fields", label: "Airtable field mapping", type: "text" },
    ],
    credentialsRequired: true,
    availableInTest: true,
    availableInProduction: false,
    limitations: [
      "Early-access TEST execution only; production publication remains disabled.",
      "Airtable create-record has no native idempotency key; ambiguous outcomes require manual verification.",
    ],
    aliases: ["create airtable record", "add to airtable", "save to airtable", "send to airtable"],
    executorVersions: { 1: "connector_runner" },
    defaultCapabilityVersion: 1,
    internalOnly: false,
    plannerVisible: true,
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
      capability.plannerVisible &&
      !capability.supported &&
      capability.aliases.some((alias) => containsAlias(normalized, alias)),
  );
}

function legacyIntegrationCapability(step: CompiledWorkflow["steps"][number]): string | null {
  const context = `${step.title} ${step.description} ${step.config?.endpoint ?? ""}`.toLowerCase();
  for (const capability of Object.values(CAPABILITY_REGISTRY)) {
    if (!capability.plannerVisible || capability.supported || capability.id === "rss_ingestion") {
      continue;
    }
    if (capability.aliases.some((alias) => containsAlias(context, alias))) {
      return capability.id;
    }
  }
  if (/schedule|every day|daily|weekly|monthly/.test(context)) return "schedule.trigger";
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
      "schedule.trigger": ["scheduled_trigger"],
      "condition.if": ["filter_condition"],
      ai_text_transform: ["ai_transform"],
      "formatter.transform": ["formatter_transform"],
      flowmind_data_store: ["store_data"],
      generate_pdf: ["generate_pdf"],
      webhook_post: ["webhook_post", "http_request"],
      generic_http_action: ["webhook_post", "http_request"],
      "http.request": ["http_request"],
      gmail_new_email: ["connector_trigger"],
      gmail_new_email_matching_search: ["connector_trigger"],
      gmail_send_email: ["connector_action"],
      gmail_reply_to_email: ["connector_action"],
      google_sheets_add_row: ["connector_action"],
      google_sheets_find_row: ["connector_action"],
      google_sheets_update_row: ["connector_action"],
      slack_new_channel_message: ["connector_trigger"],
      slack_send_channel_message: ["connector_action"],
      slack_reply_in_thread: ["connector_action"],
      notion_page_created_or_added: ["connector_trigger"],
      notion_page_updated: ["connector_trigger"],
      notion_create_page: ["connector_action"],
      notion_create_data_source_item: ["connector_action"],
      notion_find_item: ["connector_action"],
      notion_update_item: ["connector_action"],
      "internal.bridge_echo": ["connector_action"],
      "internal.connector_runner_canary": ["connector_action"],
      "airtable.create_record": ["connector_action"],
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
    case "scheduled_trigger":
      return "schedule.trigger";
    case "ai_transform":
      return "ai_text_transform";
    case "formatter_transform":
      return "formatter.transform";
    case "store_data":
      return "flowmind_data_store";
    case "generate_pdf":
      return "generate_pdf";
    case "webhook_post":
    case "http_request":
      return step.config?.connector?.connectorId === "flowmind_http"
        ? step.config.connector.operationKey === "request" && step.config.connector.operationVersion === 2
          ? "http.request"
          : "generic_http_action"
        : "webhook_post";
    case "filter_condition":
      return "condition.if";
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
      message: "This workflow step is not recognized by the current CrazyLoops runtime.",
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

/** Pins executor semantics into a newly compiled immutable workflow version. */
export function pinWorkflowExecutorSelections(workflow: CompiledWorkflow): CompiledWorkflow {
  return {
    ...workflow,
    steps: workflow.steps.map((step) => {
      if (step.executor) return step;
      const capabilityId = resolveStepCapabilityId(step);
      const capability = capabilityId ? getCapability(capabilityId) : null;
      if (!capability) return step;
      const kind = capability.executorVersions[capability.defaultCapabilityVersion];
      if (!kind) return step;
      return {
        ...step,
        executor: {
          kind,
          capabilityVersion: capability.defaultCapabilityVersion,
        },
      };
    }),
  };
}
