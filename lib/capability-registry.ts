import type { CompiledWorkflow } from "@/lib/schemas/workflow";
import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";
import { NOTION_CAPABILITIES } from "@/lib/connectors/notion/constants";
import { SLACK_SCOPES } from "@/lib/connectors/slack/scopes";
import type { ConnectorAuthType, ConnectorOperationKind } from "@/lib/connectors/types";
import type { ExecutorKind } from "@/lib/executors/types";

export type CapabilityCategory = "trigger" | "transformation" | "control" | "destination";
export type ExecutionMode = "test" | "production";
export const CAPABILITY_MATURITY = [
  "DISCOVERED",
  "REVIEWED",
  "TEST_ONLY",
  "AVAILABLE",
  "DISABLED",
] as const;
export type CapabilityMaturity = (typeof CAPABILITY_MATURITY)[number];

export type CapabilityConnectorOperation = {
  connectorId: string;
  providerFamily: string;
  operationKind: ConnectorOperationKind;
  operationKey: string;
  operationVersion: number;
};

export type CapabilityVersionDefinition = {
  version: number;
  executor: ExecutorKind;
  connectorOperation: CapabilityConnectorOperation | null;
};

export type CapabilityOnboarding = {
  available: boolean;
  method: ConnectorAuthType;
};

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
  maturity: CapabilityMaturity;
  versions: readonly CapabilityVersionDefinition[];
  executorVersions: Readonly<Record<number, ExecutorKind>>;
  defaultCapabilityVersion: number;
  connectorOperation: CapabilityConnectorOperation | null;
  providerFamily: string | null;
  requiredScopes: readonly string[];
  connectionRequired: boolean;
  onboarding: CapabilityOnboarding;
  internalOnly: boolean;
  plannerVisible: boolean;
  builderVisible: boolean;
  connectionVisible: boolean;
  customerVisible: boolean;
  intentRecognizable: boolean;
};

type CapabilityDefinitionInput = Omit<
  CapabilityDefinition,
  | "versions"
  | "executorVersions"
  | "defaultCapabilityVersion"
  | "connectorOperation"
  | "providerFamily"
  | "requiredScopes"
  | "connectionRequired"
  | "onboarding"
  | "internalOnly"
  | "plannerVisible"
  | "builderVisible"
  | "connectionVisible"
  | "customerVisible"
  | "intentRecognizable"
> & Partial<Pick<
  CapabilityDefinition,
  | "versions"
  | "executorVersions"
  | "defaultCapabilityVersion"
  | "connectorOperation"
  | "providerFamily"
  | "requiredScopes"
  | "connectionRequired"
  | "onboarding"
  | "internalOnly"
  | "plannerVisible"
  | "builderVisible"
  | "connectionVisible"
  | "customerVisible"
  | "intentRecognizable"
>>;

const defineCapability = (capability: CapabilityDefinitionInput): CapabilityDefinition => {
  const internalOnly = capability.internalOnly ?? false;
  const connectorOperation = capability.connectorOperation ?? null;
  const executorVersions = capability.executorVersions ?? { 1: "native" as const };
  const defaultCapabilityVersion = capability.defaultCapabilityVersion ?? 1;
  const versions = capability.versions ?? Object.entries(executorVersions).map(([version, executor]) => ({
    version: Number(version),
    executor,
    connectorOperation: Number(version) === defaultCapabilityVersion ? connectorOperation : null,
  }));
  const customerUsable = capability.supported && capability.availableInTest && !internalOnly;
  const connectionRequired = capability.connectionRequired ?? false;
  const onboarding = capability.onboarding ?? { available: false, method: "none" as const };
  return {
    ...capability,
    maturity: capability.maturity,
    versions,
    executorVersions,
    defaultCapabilityVersion,
    connectorOperation,
    providerFamily: capability.providerFamily ?? connectorOperation?.providerFamily ?? null,
    requiredScopes: capability.requiredScopes ?? [],
    connectionRequired,
    onboarding,
    internalOnly,
    plannerVisible: capability.plannerVisible ?? customerUsable,
    builderVisible: capability.builderVisible ?? customerUsable,
    connectionVisible: capability.connectionVisible ?? (customerUsable && connectionRequired),
    customerVisible: capability.customerVisible ?? customerUsable,
    intentRecognizable: capability.intentRecognizable ?? capability.aliases.length > 0,
  };
};

type ConnectorCapabilityInput = Omit<
  CapabilityDefinitionInput,
  | "executionImplementation"
  | "connectorOperation"
  | "providerFamily"
  | "requiredScopes"
  | "connectionRequired"
  | "onboarding"
  | "executorVersions"
  | "defaultCapabilityVersion"
  | "versions"
> & {
  connectorOperation: CapabilityConnectorOperation;
  requiredScopes: readonly string[];
  connectionRequired: boolean;
  onboarding: CapabilityOnboarding;
  executor?: ExecutorKind;
  capabilityVersion?: number;
};

const defineConnectorCapability = (input: ConnectorCapabilityInput): CapabilityDefinition => {
  const {
    connectorOperation,
    requiredScopes,
    connectionRequired,
    onboarding,
    executor = "native",
    capabilityVersion = 1,
    ...capability
  } = input;
  return defineCapability({
    ...capability,
    executionImplementation: `connector:${connectorOperation.connectorId}/${connectorOperation.operationKey}@${connectorOperation.operationVersion}`,
    connectorOperation,
    providerFamily: connectorOperation.providerFamily,
    requiredScopes,
    connectionRequired,
    onboarding,
    executorVersions: { [capabilityVersion]: executor },
    defaultCapabilityVersion: capabilityVersion,
    versions: [{ version: capabilityVersion, executor, connectorOperation }],
  });
};

/**
 * CrazyLoops' authoritative capability registry.
 *
 * Planning, compilation, existing-workflow validation, and execution all consult
 * this registry. Provider model output is never allowed to declare support.
 */
export const CAPABILITY_REGISTRY = {
  manual_trigger: defineCapability({
    id: "manual_trigger", displayName: "Manual run", category: "trigger", supported: true,
    maturity: "AVAILABLE",
    executionImplementation: "flowmind-test-run", requiredSetupFields: [], credentialsRequired: false,
    availableInTest: true, availableInProduction: true, limitations: ["Starts only when an authenticated owner explicitly runs the workflow."], aliases: ["manual", "manually", "when i run"],
  }),
  public_form_submission: defineCapability({
    id: "public_form_submission",
    displayName: "Public form submission",
    category: "trigger",
    supported: true,
    maturity: "AVAILABLE",
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
  generic_webhook_trigger: defineConnectorCapability({
    id: "generic_webhook_trigger",
    displayName: "Incoming webhook",
    category: "trigger",
    supported: true,
    maturity: "AVAILABLE",
    connectorOperation: { connectorId: "flowmind_webhook", providerFamily: "flowmind", operationKind: "trigger", operationKey: "event_received", operationVersion: 1 },
    requiredScopes: [],
    connectionRequired: false,
    onboarding: { available: false, method: "none" },
    requiredSetupFields: [],
    credentialsRequired: false,
    availableInTest: true,
    availableInProduction: true,
    limitations: ["Accepts authenticated, bounded JSON events on a published workflow endpoint."],
    aliases: ["incoming webhook", "webhook trigger", "when a webhook arrives"],
  }),
  generic_http_action: defineConnectorCapability({
    id: "generic_http_action",
    displayName: "HTTP request",
    category: "destination",
    supported: true,
    maturity: "AVAILABLE",
    connectorOperation: { connectorId: "flowmind_http", providerFamily: "flowmind", operationKind: "action", operationKey: "post_json", operationVersion: 1 },
    requiredScopes: [],
    connectionRequired: false,
    onboarding: { available: false, method: "none" },
    requiredSetupFields: [{ key: "destination_url", label: "Destination URL", type: "url" }],
    credentialsRequired: false,
    availableInTest: true,
    availableInProduction: true,
    limitations: ["HTTPS JSON POST only; private networks and redirects are blocked."],
    aliases: ["http request", "post json", "send to webhook"],
  }),
  "http.request": defineConnectorCapability({
    id: "http.request",
    displayName: "HTTP request",
    category: "transformation",
    supported: true,
    maturity: "AVAILABLE",
    connectorOperation: { connectorId: "flowmind_http", providerFamily: "flowmind", operationKind: "action", operationKey: "request", operationVersion: 2 },
    requiredScopes: [],
    connectionRequired: false,
    onboarding: { available: false, method: "none" },
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
    maturity: "AVAILABLE",
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
    maturity: "AVAILABLE",
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
    maturity: "AVAILABLE",
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
    maturity: "AVAILABLE",
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
    maturity: "TEST_ONLY",
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
    maturity: "AVAILABLE",
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
    maturity: "AVAILABLE",
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
    maturity: "DISCOVERED",
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
    maturity: "DISCOVERED",
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
    maturity: "DISCOVERED",
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
    maturity: "DISCOVERED",
    executionImplementation: null, requiredSetupFields: [], credentialsRequired: true,
    availableInTest: false, availableInProduction: false,
    limitations: ["Calendly is not currently supported."], aliases: ["calendly"],
  }),
  hubspot: defineCapability({
    id: "hubspot", displayName: "HubSpot", category: "destination", supported: false,
    maturity: "DISCOVERED",
    executionImplementation: null, requiredSetupFields: [], credentialsRequired: true,
    availableInTest: false, availableInProduction: false,
    limitations: ["HubSpot is not currently supported."], aliases: ["hubspot", "hub spot"],
  }),
  airtable: defineCapability({
    id: "airtable", displayName: "Airtable", category: "destination", supported: false,
    maturity: "DISCOVERED",
    executionImplementation: null, requiredSetupFields: [], credentialsRequired: true,
    availableInTest: false, availableInProduction: false,
    limitations: ["Airtable is not currently supported."], aliases: ["airtable", "air table"],
  }),
  tiktok: defineCapability({
    id: "tiktok",
    displayName: "TikTok",
    category: "trigger",
    supported: false,
    maturity: "DISCOVERED",
    executionImplementation: null,
    requiredSetupFields: [],
    credentialsRequired: true,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["TikTok events are not currently supported."],
    aliases: ["tiktok", "tik tok"],
  }),
  gmail_new_email: defineConnectorCapability({
    id: "gmail_new_email", displayName: "New Gmail email", category: "trigger", supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "google_gmail", providerFamily: "google", operationKind: "trigger", operationKey: "new_email", operationVersion: 1 }, requiredScopes: [GOOGLE_SCOPES.gmailReadonly], connectionRequired: true, onboarding: { available: false, method: "oauth2" }, requiredSetupFields: [], credentialsRequired: true,
    availableInTest: false, availableInProduction: false,
    limitations: ["Beta until Google OAuth verification and live production acceptance are complete."], aliases: ["gmail message arrives", "new gmail", "gmail email arrives"],
  }),
  gmail_new_email_matching_search: defineConnectorCapability({
    id: "gmail_new_email_matching_search", displayName: "New Gmail email matching search", category: "trigger", supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "google_gmail", providerFamily: "google", operationKind: "trigger", operationKey: "new_email_matching_search", operationVersion: 1 }, requiredScopes: [GOOGLE_SCOPES.gmailReadonly], connectionRequired: true, onboarding: { available: false, method: "oauth2" }, requiredSetupFields: [{ key: "search", label: "Email filter", type: "text" }], credentialsRequired: true,
    availableInTest: false, availableInProduction: false,
    limitations: ["Uses Gmail-compatible search and requires a resolved filter."], aliases: ["gmail contains", "gmail from", "email contains"],
  }),
  gmail_send_email: defineConnectorCapability({
    id: "gmail_send_email", displayName: "Send email through Gmail", category: "destination", supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "google_gmail", providerFamily: "google", operationKind: "action", operationKey: "send_email", operationVersion: 1 }, requiredScopes: [GOOGLE_SCOPES.gmailSend], connectionRequired: true, onboarding: { available: false, method: "oauth2" }, requiredSetupFields: [{ key: "to", label: "To", type: "text" }, { key: "subject", label: "Subject", type: "text" }, { key: "body", label: "Body", type: "text" }], credentialsRequired: true,
    availableInTest: false, availableInProduction: false,
    limitations: ["Requires Gmail acknowledgement; ambiguous sends are never retried automatically."], aliases: ["send through gmail", "gmail send", "email it through gmail"],
  }),
  gmail_reply_to_email: defineConnectorCapability({
    id: "gmail_reply_to_email", displayName: "Reply in Gmail", category: "destination", supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "google_gmail", providerFamily: "google", operationKind: "action", operationKey: "reply_to_email", operationVersion: 1 }, requiredScopes: [GOOGLE_SCOPES.gmailReadonly, GOOGLE_SCOPES.gmailSend], connectionRequired: true, onboarding: { available: false, method: "oauth2" }, requiredSetupFields: [{ key: "messageId", label: "Gmail message", type: "text" }, { key: "threadId", label: "Gmail thread", type: "text" }, { key: "body", label: "Reply", type: "text" }], credentialsRequired: true,
    availableInTest: false, availableInProduction: false,
    limitations: ["Requires a valid Gmail message and thread reference."], aliases: ["reply in gmail", "gmail reply", "reply to email"],
  }),
  google_sheets_add_row: defineConnectorCapability({
    id: "google_sheets_add_row",
    displayName: "Add row to Google Sheets",
    category: "destination",
    supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "google_sheets", providerFamily: "google", operationKind: "action", operationKey: "add_row", operationVersion: 1 },
    requiredScopes: [GOOGLE_SCOPES.driveFile], connectionRequired: true, onboarding: { available: false, method: "oauth2" },
    requiredSetupFields: [{ key: "spreadsheetId", label: "Picker-selected spreadsheet", type: "text" }, { key: "worksheet", label: "Worksheet", type: "text" }],
    credentialsRequired: true,
    availableInTest: false,
    availableInProduction: false,
    limitations: ["Beta until Google OAuth verification and live production acceptance are complete.", "Writes use RAW value semantics."],
    aliases: ["add to google sheets", "add row to google sheet", "save to google sheets", "google sheets", "google sheet"],
  }),
  google_sheets_find_row: defineConnectorCapability({
    id: "google_sheets_find_row", displayName: "Find row in Google Sheets", category: "transformation", supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "google_sheets", providerFamily: "google", operationKind: "action", operationKey: "find_row", operationVersion: 1 }, requiredScopes: [GOOGLE_SCOPES.driveFile], connectionRequired: true, onboarding: { available: false, method: "oauth2" }, requiredSetupFields: [{ key: "spreadsheetId", label: "Picker-selected spreadsheet", type: "text" }, { key: "worksheet", label: "Worksheet", type: "text" }, { key: "matchColumn", label: "Lookup column", type: "text" }], credentialsRequired: true,
    availableInTest: false, availableInProduction: false, limitations: ["Exact matches only; multiple matches fail clearly."], aliases: ["find row in google sheets", "lookup in google sheets"],
  }),
  google_sheets_update_row: defineConnectorCapability({
    id: "google_sheets_update_row", displayName: "Update row in Google Sheets", category: "destination", supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "google_sheets", providerFamily: "google", operationKind: "action", operationKey: "update_row", operationVersion: 1 }, requiredScopes: [GOOGLE_SCOPES.driveFile], connectionRequired: true, onboarding: { available: false, method: "oauth2" }, requiredSetupFields: [{ key: "spreadsheetId", label: "Picker-selected spreadsheet", type: "text" }, { key: "worksheet", label: "Worksheet", type: "text" }], credentialsRequired: true,
    availableInTest: false, availableInProduction: false, limitations: ["Requires an explicit unique row reference."], aliases: ["update row in google sheets"],
  }),
  google_calendar: defineCapability({
    id: "google_calendar", displayName: "Google Calendar", category: "destination", supported: false,
    maturity: "DISCOVERED",
    executionImplementation: null, requiredSetupFields: [], credentialsRequired: true,
    availableInTest: false, availableInProduction: false,
    limitations: ["Google Calendar is not currently supported."], aliases: ["google calendar", "calendar event"],
  }),
  google_drive: defineCapability({
    id: "google_drive", displayName: "Google Drive", category: "destination", supported: false,
    maturity: "DISCOVERED",
    executionImplementation: null, requiredSetupFields: [], credentialsRequired: true,
    availableInTest: false, availableInProduction: false,
    limitations: ["Google Drive is not currently supported."], aliases: ["google drive", "upload to drive", "save to drive"],
  }),
  slack_new_channel_message: defineConnectorCapability({
    id: "slack_new_channel_message", displayName: "New message in Slack channel", category: "trigger", supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "slack", providerFamily: "slack", operationKind: "trigger", operationKey: "new_channel_message", operationVersion: 1 }, requiredScopes: [SLACK_SCOPES.channelsRead, SLACK_SCOPES.channelsHistory], connectionRequired: true, onboarding: { available: false, method: "oauth2" }, requiredSetupFields: [{ key: "channel", label: "Slack channel", type: "text" }], credentialsRequired: true,
    availableInTest: false, availableInProduction: false, limitations: ["Beta until live Slack acceptance is complete.", "Public channels accessible to the installed bot only."], aliases: ["slack message", "message in slack", "posts in slack"],
  }),
  slack_send_channel_message: defineConnectorCapability({
    id: "slack_send_channel_message", displayName: "Send Slack channel message", category: "destination", supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "slack", providerFamily: "slack", operationKind: "action", operationKey: "send_channel_message", operationVersion: 1 }, requiredScopes: [SLACK_SCOPES.channelsRead, SLACK_SCOPES.chatWrite], connectionRequired: true, onboarding: { available: false, method: "oauth2" }, requiredSetupFields: [{ key: "channel", label: "Slack channel", type: "text" }, { key: "text", label: "Message", type: "text" }], credentialsRequired: true,
    availableInTest: false, availableInProduction: false, limitations: ["Beta until live Slack acceptance is complete.", "Requires Slack acknowledgement before delivery is reported."], aliases: ["send to slack", "post to slack", "slack alert"],
  }),
  slack_reply_in_thread: defineConnectorCapability({
    id: "slack_reply_in_thread", displayName: "Reply in Slack thread", category: "destination", supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "slack", providerFamily: "slack", operationKind: "action", operationKey: "reply_in_thread", operationVersion: 1 }, requiredScopes: [SLACK_SCOPES.channelsRead, SLACK_SCOPES.chatWrite], connectionRequired: true, onboarding: { available: false, method: "oauth2" }, requiredSetupFields: [{ key: "channel", label: "Slack channel", type: "text" }, { key: "threadTs", label: "Slack thread", type: "text" }, { key: "text", label: "Reply", type: "text" }], credentialsRequired: true,
    availableInTest: false, availableInProduction: false, limitations: ["Beta until live Slack acceptance is complete.", "Requires an exact Slack thread reference."], aliases: ["reply in slack thread", "slack thread reply"],
  }),
  notion_page_created_or_added: defineConnectorCapability({
    id: "notion_page_created_or_added", displayName: "Notion page created or added", category: "trigger", supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "notion", providerFamily: "notion", operationKind: "trigger", operationKey: "page_created_or_added", operationVersion: 1 }, requiredScopes: [NOTION_CAPABILITIES.readContent], connectionRequired: true, onboarding: { available: false, method: "oauth2" }, requiredSetupFields: [{ key: "resourceId", label: "Notion page or data source", type: "text" }], credentialsRequired: true,
    availableInTest: false, availableInProduction: false, limitations: ["Beta until live Notion acceptance is complete.", "Only explicitly shared resources are visible."], aliases: ["notion page created", "new notion page"],
  }),
  notion_page_updated: defineConnectorCapability({
    id: "notion_page_updated", displayName: "Notion page updated", category: "trigger", supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "notion", providerFamily: "notion", operationKind: "trigger", operationKey: "page_updated", operationVersion: 1 }, requiredScopes: [NOTION_CAPABILITIES.readContent], connectionRequired: true, onboarding: { available: false, method: "oauth2" }, requiredSetupFields: [{ key: "resourceId", label: "Notion page or data source", type: "text" }], credentialsRequired: true,
    availableInTest: false, availableInProduction: false, limitations: ["Beta until live Notion acceptance is complete.", "Fetches current page metadata after a verified webhook event."], aliases: ["notion page updated", "notion update"],
  }),
  notion_create_page: defineConnectorCapability({
    id: "notion_create_page", displayName: "Create Notion page", category: "destination", supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "notion", providerFamily: "notion", operationKind: "action", operationKey: "create_page", operationVersion: 1 }, requiredScopes: [NOTION_CAPABILITIES.readContent, NOTION_CAPABILITIES.insertContent], connectionRequired: true, onboarding: { available: false, method: "oauth2" }, requiredSetupFields: [{ key: "parentPageId", label: "Parent page", type: "text" }, { key: "title", label: "Title", type: "text" }, { key: "content", label: "Content", type: "text" }], credentialsRequired: true,
    availableInTest: false, availableInProduction: false, limitations: ["Beta until live Notion acceptance is complete.", "Parent page must be shared with the Notion connection."], aliases: ["create notion page"],
  }),
  notion_create_data_source_item: defineConnectorCapability({
    id: "notion_create_data_source_item", displayName: "Add item to Notion data source", category: "destination", supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "notion", providerFamily: "notion", operationKind: "action", operationKey: "create_data_source_item", operationVersion: 1 }, requiredScopes: [NOTION_CAPABILITIES.readContent, NOTION_CAPABILITIES.insertContent], connectionRequired: true, onboarding: { available: false, method: "oauth2" }, requiredSetupFields: [{ key: "dataSourceId", label: "Data source", type: "text" }], credentialsRequired: true,
    availableInTest: false, availableInProduction: false, limitations: ["Beta until live Notion acceptance is complete.", "Only existing supported properties are mapped."], aliases: ["add to notion", "save to notion", "notion data source", "notion database"],
  }),
  notion_find_item: defineConnectorCapability({
    id: "notion_find_item", displayName: "Find Notion item", category: "transformation", supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "notion", providerFamily: "notion", operationKind: "action", operationKey: "find_item", operationVersion: 1 }, requiredScopes: [NOTION_CAPABILITIES.readContent], connectionRequired: true, onboarding: { available: false, method: "oauth2" }, requiredSetupFields: [{ key: "dataSourceId", label: "Data source", type: "text" }, { key: "matchProperty", label: "Property", type: "text" }, { key: "matchValue", label: "Exact value", type: "text" }], credentialsRequired: true,
    availableInTest: false, availableInProduction: false, limitations: ["Beta until live Notion acceptance is complete.", "Exact match only; multiple matches fail as ambiguous."], aliases: ["find notion item", "lookup notion item"],
  }),
  notion_update_item: defineConnectorCapability({
    id: "notion_update_item", displayName: "Update Notion item", category: "destination", supported: false,
    maturity: "REVIEWED",
    connectorOperation: { connectorId: "notion", providerFamily: "notion", operationKind: "action", operationKey: "update_item", operationVersion: 1 }, requiredScopes: [NOTION_CAPABILITIES.readContent, NOTION_CAPABILITIES.updateContent], connectionRequired: true, onboarding: { available: false, method: "oauth2" }, requiredSetupFields: [{ key: "dataSourceId", label: "Data source", type: "text" }, { key: "pageId", label: "Page or item", type: "text" }], credentialsRequired: true,
    availableInTest: false, availableInProduction: false, limitations: ["Beta until live Notion acceptance is complete.", "Requires an exact page/item ID or a preceding unambiguous find."], aliases: ["update notion item", "update in notion"],
  }),
  stripe: defineCapability({
    id: "stripe",
    displayName: "Stripe payments",
    category: "destination",
    supported: false,
    maturity: "DISCOVERED",
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
    maturity: "DISCOVERED",
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
    maturity: "DISCOVERED",
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
    maturity: "DISCOVERED",
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
    maturity: "DISCOVERED",
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
    maturity: "DISCOVERED",
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
    maturity: "DISCOVERED",
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
    maturity: "DISABLED",
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
    maturity: "AVAILABLE",
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
    builderVisible: false,
    connectionVisible: false,
    customerVisible: false,
  }),
  "internal.connector_runner_canary": defineCapability({
    id: "internal.connector_runner_canary",
    displayName: "Internal connector runner canary",
    category: "transformation",
    supported: true,
    maturity: "TEST_ONLY",
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
    builderVisible: false,
    connectionVisible: false,
    customerVisible: false,
  }),
  "airtable.create_record": defineConnectorCapability({
    id: "airtable.create_record",
    displayName: "Create Airtable record",
    category: "destination",
    supported: true,
    maturity: "AVAILABLE",
    connectorOperation: { connectorId: "airtable", providerFamily: "airtable", operationKind: "action", operationKey: "create_record", operationVersion: 1 },
    requiredScopes: ["data.records:write"],
    connectionRequired: true,
    onboarding: { available: true, method: "api_key" },
    requiredSetupFields: [
      { key: "baseId", label: "Airtable Base ID", type: "text" },
      { key: "tableId", label: "Airtable Table ID", type: "text" },
      { key: "fields", label: "Airtable field mapping", type: "text" },
    ],
    credentialsRequired: true,
    availableInTest: true,
    availableInProduction: true,
    limitations: [
      "LIVE execution requires an owned customer connection verified by a successful Airtable create-record test.",
      "Airtable create-record has no native idempotency key; ambiguous outcomes require manual verification.",
    ],
    aliases: ["create airtable record", "add to airtable", "save to airtable", "send to airtable"],
    executor: "connector_runner",
    internalOnly: false,
    plannerVisible: true,
  }),
  "hubspot.get_contact": defineConnectorCapability({
    id: "hubspot.get_contact",
    displayName: "Get HubSpot contact",
    category: "transformation",
    supported: true,
    maturity: "TEST_ONLY",
    connectorOperation: { connectorId: "hubspot", providerFamily: "hubspot", operationKind: "action", operationKey: "get_contact", operationVersion: 1 },
    requiredScopes: ["crm.objects.contacts.read"],
    connectionRequired: true,
    onboarding: { available: false, method: "oauth2" },
    requiredSetupFields: [
      { key: "contactId", label: "HubSpot Contact ID", type: "text" },
      { key: "properties", label: "Contact properties", type: "text" },
    ],
    credentialsRequired: true,
    availableInTest: true,
    availableInProduction: false,
    limitations: [
      "TEST mode only; live delegated execution is not enabled.",
      "Retrieves one contact and only explicitly requested properties.",
      "HubSpot connection onboarding is not included in this milestone.",
    ],
    aliases: ["get hubspot contact", "retrieve hubspot contact", "find hubspot contact", "look up hubspot contact"],
    executor: "connector_runner",
    internalOnly: false,
    plannerVisible: true,
    connectionVisible: true,
  }),
  external_integration: defineCapability({
    id: "external_integration",
    displayName: "External app integration",
    category: "destination",
    supported: false,
    maturity: "DISABLED",
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

export type CapabilityConnectorOperationEvidence = {
  connectorId: string;
  providerFamily: string;
  authType: ConnectorAuthType;
  operationKind: ConnectorOperationKind;
  operationKey: string;
  operationVersion: number;
  executor: ExecutorKind;
  requiredScopes: readonly string[];
  connectionRequired: boolean;
  availableInTest: boolean;
  availableInProduction: boolean;
};

export type CapabilityConnectorOperationLookup = (
  operation: CapabilityConnectorOperation,
) => CapabilityConnectorOperationEvidence | null;

export function getCapability(capabilityId: string): CapabilityDefinition | null {
  return CAPABILITY_REGISTRY[capabilityId as CapabilityId] ?? null;
}

export function getCapabilityVersion(
  capabilityId: string,
  capabilityVersion: number,
): CapabilityVersionDefinition | null {
  return getCapability(capabilityId)?.versions.find(
    (version) => version.version === capabilityVersion,
  ) ?? null;
}

export function resolveCapabilityImplementation(
  capabilityId: string,
  capabilityVersion: number,
): {
  capability: CapabilityDefinition;
  version: CapabilityVersionDefinition;
} | null {
  const capability = getCapability(capabilityId);
  const version = getCapabilityVersion(capabilityId, capabilityVersion);
  return capability && version ? { capability, version } : null;
}

export function getPlannerVisibleCapabilities(): CapabilityDefinition[] {
  return Object.values(CAPABILITY_REGISTRY).filter(
    (capability) => capability.plannerVisible && capability.customerVisible && !capability.internalOnly,
  );
}

export function getCustomerVisibleCapabilities(): CapabilityDefinition[] {
  return Object.values(CAPABILITY_REGISTRY).filter(
    (capability) => capability.customerVisible && !capability.internalOnly,
  );
}

export function getConnectorCapability(
  connectorId: string,
  operationKind: ConnectorOperationKind,
  operationKey: string,
  operationVersion: number,
): CapabilityDefinition | null {
  return getConnectorCapabilityVersion(
    connectorId,
    operationKind,
    operationKey,
    operationVersion,
  )?.capability ?? null;
}

export function getConnectorCapabilityVersion(
  connectorId: string,
  operationKind: ConnectorOperationKind,
  operationKey: string,
  operationVersion: number,
  definitions: readonly CapabilityDefinition[] = Object.values(CAPABILITY_REGISTRY),
): {
  capability: CapabilityDefinition;
  version: CapabilityVersionDefinition;
} | null {
  for (const capability of definitions) {
    const version = capability.versions.find((candidate) => {
      const operation = candidate.connectorOperation;
      return operation?.connectorId === connectorId
        && operation.operationKind === operationKind
        && operation.operationKey === operationKey
        && operation.operationVersion === operationVersion;
    });
    if (version) return { capability, version };
  }
  return null;
}

export function getConnectorOnboarding(
  connectorId: string,
  definitions: readonly CapabilityDefinition[] = Object.values(CAPABILITY_REGISTRY),
): CapabilityOnboarding | null {
  const capabilities = definitions.filter(
    (capability) => capability.versions.some(
      (version) => version.connectorOperation?.connectorId === connectorId,
    )
      && capability.connectionRequired
      && !capability.internalOnly,
  );
  if (!capabilities.length) return null;
  const availableCapabilities = capabilities.filter(
    (capability) => capability.onboarding.available,
  );
  const methodSource = availableCapabilities.length ? availableCapabilities : capabilities;
  const methods = [...new Set(methodSource
    .map((capability) => capability.onboarding.method)
    .filter((method) => method !== "none"))].sort();
  return {
    available: availableCapabilities.length > 0,
    method: methods[0] ?? "none",
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && left.every((value) => right.includes(value));
}

function sameConnectorOperation(
  left: CapabilityConnectorOperation | null,
  right: CapabilityConnectorOperation | null,
): boolean {
  if (!left || !right) return left === right;
  return left.connectorId === right.connectorId
    && left.providerFamily === right.providerFamily
    && left.operationKind === right.operationKind
    && left.operationKey === right.operationKey
    && left.operationVersion === right.operationVersion;
}

/** Pure validation for CrazyLoops-owned availability and connector consistency. */
export function validateCapabilityDefinitions(
  definitions: readonly CapabilityDefinition[],
  lookupConnectorOperation: CapabilityConnectorOperationLookup,
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const executors = new Set<ExecutorKind>(["native", "activepieces", "connector_runner"]);
  const connectorMappings = new Map<string, string>();
  const onboardingMethods = new Map<string, Set<ConnectorAuthType>>();

  for (const capability of definitions) {
    if (ids.has(capability.id)) errors.push(`Duplicate capability ID: ${capability.id}`);
    ids.add(capability.id);

    if (capability.maturity === "AVAILABLE" && (
      !capability.supported
      || !capability.availableInTest
      || !capability.availableInProduction
    )) {
      errors.push(`AVAILABLE capability is not enabled in TEST and production: ${capability.id}`);
    }
    if (capability.maturity === "TEST_ONLY" && (
      !capability.supported
      || !capability.availableInTest
      || capability.availableInProduction
    )) {
      errors.push(`TEST_ONLY capability has invalid mode availability: ${capability.id}`);
    }
    if (["DISCOVERED", "REVIEWED", "DISABLED"].includes(capability.maturity)
      && (capability.supported || capability.availableInTest || capability.availableInProduction)) {
      errors.push(`Non-executable maturity exposes an execution mode: ${capability.id}`);
    }
    if (capability.supported && !["TEST_ONLY", "AVAILABLE"].includes(capability.maturity)) {
      errors.push(`Supported capability has a non-executable maturity: ${capability.id}`);
    }
    if (capability.internalOnly && (
      capability.plannerVisible
      || capability.builderVisible
      || capability.connectionVisible
      || capability.customerVisible
    )) {
      errors.push(`Internal capability is customer visible: ${capability.id}`);
    }
    if ((capability.plannerVisible || capability.builderVisible || capability.connectionVisible)
      && !capability.customerVisible) {
      errors.push(`Hidden capability exposes a customer surface: ${capability.id}`);
    }
    if (capability.customerVisible && !capability.availableInTest) {
      errors.push(`Customer-visible capability cannot run in TEST: ${capability.id}`);
    }
    if (capability.connectionVisible && !capability.connectionRequired) {
      errors.push(`Connection-visible capability does not require a connection: ${capability.id}`);
    }
    if (capability.connectionRequired && !capability.credentialsRequired) {
      errors.push(`Connection-required capability does not require credentials: ${capability.id}`);
    }

    const versionIds = new Set<number>();
    for (const version of capability.versions) {
      if (!Number.isSafeInteger(version.version) || version.version < 1) {
        errors.push(`Invalid capability version for ${capability.id}: ${version.version}`);
      }
      if (versionIds.has(version.version)) {
        errors.push(`Duplicate capability version: ${capability.id}@${version.version}`);
      }
      versionIds.add(version.version);
      if (!executors.has(version.executor)) {
        errors.push(`Unsupported executor for ${capability.id}@${version.version}`);
      }
      if (capability.executorVersions[version.version] !== version.executor) {
        errors.push(`Executor map mismatch for ${capability.id}@${version.version}`);
      }

      const connector = version.connectorOperation;
      if (!connector) continue;

      const mappingKey = [
        connector.connectorId,
        connector.operationKind,
        connector.operationKey,
        connector.operationVersion,
      ].join(":");
      const mappingOwner = `${capability.id}@${version.version}`;
      const existingOwner = connectorMappings.get(mappingKey);
      if (existingOwner && existingOwner !== mappingOwner) {
        errors.push(`Duplicate connector operation mapping: ${mappingKey}`);
      } else {
        connectorMappings.set(mappingKey, mappingOwner);
      }

      const evidence = lookupConnectorOperation(connector);
      if (!evidence) {
        errors.push(`Missing connector operation for ${mappingOwner}`);
        continue;
      }
      if (evidence.connectorId !== connector.connectorId
        || evidence.operationKind !== connector.operationKind
        || evidence.operationKey !== connector.operationKey
        || evidence.operationVersion !== connector.operationVersion) {
        errors.push(`Connector operation mismatch for ${mappingOwner}`);
      }
      if (version.executor !== evidence.executor) {
        errors.push(`Executor mismatch for ${mappingOwner}`);
      }
      if (capability.availableInTest && !evidence.availableInTest) {
        errors.push(`TEST availability exceeds connector support for ${mappingOwner}`);
      }
      if (capability.availableInProduction && !evidence.availableInProduction) {
        errors.push(`LIVE availability exceeds connector support for ${mappingOwner}`);
      }
      if (evidence.connectionRequired !== capability.connectionRequired) {
        errors.push(`Connection requirement mismatch for ${mappingOwner}`);
      }
      if (evidence.providerFamily !== capability.providerFamily
        || connector.providerFamily !== capability.providerFamily) {
        errors.push(`Connector provider mismatch for ${mappingOwner}`);
      }
      if (!sameStringSet(evidence.requiredScopes, capability.requiredScopes)) {
        errors.push(`Required scope mismatch for ${mappingOwner}`);
      }
      if (capability.onboarding.method !== "none"
        && capability.onboarding.method !== evidence.authType) {
        errors.push(`Invalid onboarding method for ${mappingOwner}`);
      }
      if (capability.customerVisible && capability.connectionRequired
        && capability.onboarding.method !== "none") {
        const methods = onboardingMethods.get(connector.connectorId) ?? new Set<ConnectorAuthType>();
        methods.add(capability.onboarding.method);
        onboardingMethods.set(connector.connectorId, methods);
      }
    }
    const defaultVersion = getCapabilityVersionFromDefinition(
      capability,
      capability.defaultCapabilityVersion,
    );
    if (!defaultVersion) {
      errors.push(`Default capability version is not registered: ${capability.id}@${capability.defaultCapabilityVersion}`);
    }
    if (Object.keys(capability.executorVersions).length !== capability.versions.length) {
      errors.push(`Executor version count mismatch for ${capability.id}`);
    }
    if (!sameConnectorOperation(
      capability.connectorOperation,
      defaultVersion?.connectorOperation ?? null,
    )) {
      errors.push(`Default connector operation projection mismatch for ${capability.id}`);
    }

    const connector = capability.connectorOperation;
    if (!connector) {
      if (!capability.versions.some((version) => version.connectorOperation)
        && (capability.providerFamily || capability.requiredScopes.length)) {
        errors.push(`Connector metadata exists without an operation: ${capability.id}`);
      }
      if (!capability.versions.some((version) => version.connectorOperation)
        && capability.onboarding.available) {
        errors.push(`Onboarding is available without a connector operation: ${capability.id}`);
      }
      continue;
    }

    const expectedImplementation = `connector:${connector.connectorId}/${connector.operationKey}@${connector.operationVersion}`;
    if (capability.executionImplementation !== expectedImplementation) {
      errors.push(`Execution implementation mismatch for ${capability.id}`);
    }
    if (capability.providerFamily !== connector.providerFamily) {
      errors.push(`Provider family mismatch for ${capability.id}`);
    }
    if (capability.onboarding.available && (
      !capability.connectionRequired
      || capability.onboarding.method === "none"
    )) {
      errors.push(`Invalid onboarding availability for ${capability.id}`);
    }
  }

  for (const [connectorId, methods] of onboardingMethods) {
    if (methods.size > 1) {
      errors.push(`Conflicting onboarding methods for connector: ${connectorId}`);
    }
  }

  return errors;
}

export function getCapabilityVersionFromDefinition(
  capability: CapabilityDefinition,
  version: number,
): CapabilityVersionDefinition | null {
  return capability.versions.find((candidate) => candidate.version === version) ?? null;
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
      capability.intentRecognizable &&
      !capability.supported &&
      capability.aliases.some((alias) => containsAlias(normalized, alias)),
  );
}

function legacyIntegrationCapability(step: CompiledWorkflow["steps"][number]): string | null {
  const context = `${step.title} ${step.description} ${step.config?.endpoint ?? ""}`.toLowerCase();
  for (const capability of Object.values(CAPABILITY_REGISTRY)) {
    if (!capability.intentRecognizable || capability.supported || capability.id === "rss_ingestion") {
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
      "hubspot.get_contact": ["connector_action"],
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

export function assessCapabilityVersion(
  capabilityId: string,
  capabilityVersion: number,
  mode: ExecutionMode,
): CapabilityAssessment {
  const assessment = assessCapability(capabilityId, mode);
  if (!getCapabilityVersion(capabilityId, capabilityVersion)) {
    return {
      ...assessment,
      available: false,
      status: "unsupported",
      message: `Capability version ${capabilityVersion} is not supported.`,
    };
  }
  return assessment;
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
      const capabilityId = resolveStepCapabilityId(step);
      const capability = capabilityId ? getCapability(capabilityId) : null;
      if (!capability) return step;
      if (step.executor) {
        const registered = getCapabilityVersion(capability.id, step.executor.capabilityVersion);
        if (!registered || registered.executor !== step.executor.kind) {
          throw new Error(`Unsupported executor selection for ${capability.id}@${step.executor.capabilityVersion}`);
        }
        return step;
      }
      const version = getCapabilityVersion(capability.id, capability.defaultCapabilityVersion);
      if (!version) throw new Error(`Missing default capability version for ${capability.id}`);
      return {
        ...step,
        executor: {
          kind: version.executor,
          capabilityVersion: version.version,
        },
      };
    }),
  };
}
