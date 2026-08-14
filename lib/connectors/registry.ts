import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { ambiguousAcknowledgement, classifyConnectorHttpFailure } from "@/lib/connectors/errors";
import { GOOGLE_AUTHORIZATION_URL, GOOGLE_TOKEN_URL } from "@/lib/connectors/google/oauth-provider";
import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";
import type {
  ConnectorActionHandler,
  ConnectorManifest,
  ConnectorOperation,
  RegisteredConnector,
} from "@/lib/connectors/types";
import { postTrustedWebhook } from "@/lib/security/outbound-webhook";

const genericWebhookManifest: ConnectorManifest = {
  id: "flowmind_webhook",
  providerFamily: "flowmind",
  displayName: "Incoming webhook",
  description: "Starts a published workflow from an authenticated HTTPS webhook event.",
  status: "AVAILABLE",
  version: 1,
  auth: { type: "none", defaultScopes: [], pkceRequired: false },
  triggers: [{
    key: "event_received",
    version: 1,
    kind: "trigger",
    displayName: "Webhook received",
    description: "Receives a bounded JSON payload through a secret endpoint.",
    input: [],
    output: [{ key: "payload", label: "Payload", type: "object", required: true }],
    requiredScopes: [],
    connectionRequired: false,
    testMode: true,
    production: true,
    deliverySemantics: "trigger",
  }],
  actions: [],
  limitations: ["JSON requests only.", "Private-network callbacks and oversized bodies are rejected."],
};

const genericHttpManifest: ConnectorManifest = {
  id: "flowmind_http",
  providerFamily: "flowmind",
  displayName: "HTTP request",
  description: "Sends a bounded JSON POST request to a public HTTPS endpoint.",
  status: "BETA",
  version: 1,
  auth: { type: "none", defaultScopes: [], pkceRequired: false },
  triggers: [],
  actions: [{
    key: "post_json",
    version: 1,
    kind: "action",
    displayName: "POST JSON",
    description: "Posts JSON and succeeds only after a 2xx acknowledgement.",
    input: [
      { key: "url", label: "Destination URL", type: "url", required: true },
      { key: "body", label: "JSON body", type: "object", required: true },
    ],
    output: [
      { key: "status", label: "HTTP status", type: "number", required: true },
      { key: "referenceId", label: "Provider reference", type: "string" },
    ],
    requiredScopes: [],
    connectionRequired: false,
    testMode: true,
    production: true,
    deliverySemantics: "acknowledged_external",
  }],
  limitations: ["HTTPS only.", "Redirects and private or reserved networks are blocked.", "Ambiguous responses are never reported as delivered."],
};

const internalTestManifest: ConnectorManifest = {
  id: "flowmind_test",
  providerFamily: "flowmind_test",
  displayName: "CrazyLoops test connector",
  description: "Internal connector used to prove OAuth, refresh, triggers, and actions.",
  status: "INTERNAL",
  version: 1,
  auth: {
    type: "oauth2",
    authorizationUrl: "https://example.invalid/oauth/authorize",
    tokenUrl: "https://example.invalid/oauth/token",
    defaultScopes: ["events:read", "actions:write"],
    pkceRequired: true,
  },
  triggers: [{
    key: "test_event", version: 1, kind: "trigger", displayName: "Test event", description: "Normalizes a signed internal test event.",
    input: [], output: [{ key: "message", label: "Message", type: "string", required: true }], requiredScopes: ["events:read"], connectionRequired: true, testMode: true, production: false, deliverySemantics: "trigger",
  }],
  actions: [{
    key: "acknowledge", version: 1, kind: "action", displayName: "Acknowledge", description: "Returns a deterministic acknowledgement for tests.",
    input: [{ key: "message", label: "Message", type: "string", required: true }], output: [{ key: "accepted", label: "Accepted", type: "boolean", required: true }], requiredScopes: ["actions:write"], connectionRequired: true, testMode: true, production: false, deliverySemantics: "acknowledged_external",
  }],
  limitations: ["Never available in production or customer-facing connector lists."],
};

const googleGmailManifest: ConnectorManifest = {
  id: "google_gmail",
  providerFamily: "google",
  displayName: "Gmail",
  description: "Receives new Gmail messages and sends acknowledged email or threaded replies.",
  status: "BETA",
  version: 1,
  auth: { type: "oauth2", authorizationUrl: GOOGLE_AUTHORIZATION_URL, tokenUrl: GOOGLE_TOKEN_URL, defaultScopes: ["openid", "email"], pkceRequired: true },
  triggers: [
    { key: "new_email", version: 1, kind: "trigger", displayName: "New Gmail email", description: "Starts from a new message resolved through Gmail history.", input: [], output: [{ key: "message", label: "Message", type: "object", required: true }], requiredScopes: [GOOGLE_SCOPES.gmailReadonly], connectionRequired: true, testMode: true, production: true, deliverySemantics: "trigger" },
    { key: "new_email_matching_search", version: 1, kind: "trigger", displayName: "New Gmail email matching search", description: "Starts when a newly resolved Gmail message matches the configured Gmail filter.", input: [{ key: "search", label: "Email filter", type: "string", required: true }], output: [{ key: "message", label: "Message", type: "object", required: true }], requiredScopes: [GOOGLE_SCOPES.gmailReadonly], connectionRequired: true, testMode: true, production: true, deliverySemantics: "trigger" },
  ],
  actions: [
    { key: "send_email", version: 1, kind: "action", displayName: "Send Gmail email", description: "Sends an email and succeeds only after Gmail returns a message ID.", input: [{ key: "to", label: "To", type: "string", required: true }, { key: "cc", label: "Cc", type: "string" }, { key: "bcc", label: "Bcc", type: "string" }, { key: "subject", label: "Subject", type: "string", required: true }, { key: "body", label: "Body", type: "string", required: true }], output: [{ key: "messageId", label: "Message ID", type: "string", required: true }, { key: "threadId", label: "Thread ID", type: "string" }], requiredScopes: [GOOGLE_SCOPES.gmailSend], connectionRequired: true, testMode: true, production: true, deliverySemantics: "acknowledged_external" },
    { key: "reply_to_email", version: 1, kind: "action", displayName: "Reply in Gmail", description: "Replies to a validated Gmail message in its existing thread.", input: [{ key: "messageId", label: "Message ID", type: "string", required: true }, { key: "threadId", label: "Thread ID", type: "string", required: true }, { key: "to", label: "To", type: "string" }, { key: "subject", label: "Subject", type: "string" }, { key: "body", label: "Reply", type: "string", required: true }], output: [{ key: "messageId", label: "Reply message ID", type: "string", required: true }, { key: "threadId", label: "Thread ID", type: "string", required: true }], requiredScopes: [GOOGLE_SCOPES.gmailReadonly, GOOGLE_SCOPES.gmailSend], connectionRequired: true, testMode: true, production: true, deliverySemantics: "acknowledged_external" },
  ],
  limitations: ["Google production verification is required before broad public availability.", "Attachments are exposed as metadata only and are never downloaded automatically."],
  documentationUrl: "https://developers.google.com/gmail/api",
};

const googleSheetsManifest: ConnectorManifest = {
  id: "google_sheets",
  providerFamily: "google",
  displayName: "Google Sheets",
  description: "Finds, appends, and deterministically updates rows in a selected worksheet.",
  status: "BETA",
  version: 1,
  auth: { type: "oauth2", authorizationUrl: GOOGLE_AUTHORIZATION_URL, tokenUrl: GOOGLE_TOKEN_URL, defaultScopes: ["openid", "email"], pkceRequired: true },
  triggers: [],
  actions: [
    { key: "add_row", version: 1, kind: "action", displayName: "Add row to Google Sheets", description: "Adds one safely encoded row using the worksheet's real headers.", input: [{ key: "spreadsheetId", label: "Spreadsheet", type: "string", required: true }, { key: "worksheet", label: "Worksheet", type: "string", required: true }, { key: "values", label: "Column values", type: "object", required: true }], output: [{ key: "updatedRange", label: "Added row", type: "string", required: true }], requiredScopes: [GOOGLE_SCOPES.sheets], connectionRequired: true, testMode: true, production: true, deliverySemantics: "acknowledged_external" },
    { key: "find_row", version: 1, kind: "action", displayName: "Find row in Google Sheets", description: "Finds an exact unique value and reports zero or ambiguous matches truthfully.", input: [{ key: "spreadsheetId", label: "Spreadsheet", type: "string", required: true }, { key: "worksheet", label: "Worksheet", type: "string", required: true }, { key: "matchColumn", label: "Lookup column", type: "string", required: true }, { key: "matchValue", label: "Lookup value", type: "string", required: true }], output: [{ key: "found", label: "Found", type: "boolean", required: true }, { key: "rowNumber", label: "Row number", type: "number" }, { key: "values", label: "Column values", type: "object" }], requiredScopes: [GOOGLE_SCOPES.sheets], connectionRequired: true, testMode: true, production: true, deliverySemantics: "internal" },
    { key: "update_row", version: 1, kind: "action", displayName: "Update row in Google Sheets", description: "Updates exactly one explicitly identified row.", input: [{ key: "spreadsheetId", label: "Spreadsheet", type: "string", required: true }, { key: "worksheet", label: "Worksheet", type: "string", required: true }, { key: "rowNumber", label: "Row number", type: "number", required: true }, { key: "values", label: "Column values", type: "object", required: true }], output: [{ key: "updatedRange", label: "Updated row", type: "string", required: true }], requiredScopes: [GOOGLE_SCOPES.sheets], connectionRequired: true, testMode: true, production: true, deliverySemantics: "acknowledged_external" },
  ],
  limitations: ["Google production verification is required before broad public availability.", "Values use RAW input semantics; formulas are not executed."],
  documentationUrl: "https://developers.google.com/sheets/api",
};

const googleTriggerAdapter = {
  verify: async () => false,
  normalize: async () => { throw new Error("Gmail push events must use the authenticated Google Pub/Sub route."); },
};

// Keep the authoritative registry importable by the planner and tests without
// eagerly loading server-only credential modules. The implementation is still
// resolved exclusively on the server when the action actually executes.
const gmailSendHandler: ConnectorActionHandler = async (input, context) =>
  (await import("@/lib/connectors/google/gmail")).gmailSendEmail(input, context);
const gmailReplyHandler: ConnectorActionHandler = async (input, context) =>
  (await import("@/lib/connectors/google/gmail")).gmailReplyToEmail(input, context);
const sheetsAddHandler: ConnectorActionHandler = async (input, context) =>
  (await import("@/lib/connectors/google/sheets")).sheetsAddRow(input, context);
const sheetsFindHandler: ConnectorActionHandler = async (input, context) =>
  (await import("@/lib/connectors/google/sheets")).sheetsFindRow(input, context);
const sheetsUpdateHandler: ConnectorActionHandler = async (input, context) =>
  (await import("@/lib/connectors/google/sheets")).sheetsUpdateRow(input, context);

const httpPostHandler: ConnectorActionHandler = async (input, context) => {
  try {
    const response = await postTrustedWebhook(String(input.url ?? ""), input.body, context.idempotencyKey);
    return {
      status: "succeeded",
      acknowledged: true,
      externallyDelivered: true,
      providerReferenceId: response.referenceId,
      output: { status: response.status, ...(response.referenceId ? { referenceId: response.referenceId } : {}) },
      metadata: { httpStatus: response.status } as Record<string, string | number | boolean | null>,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The HTTP request failed.";
    const match = message.match(/^Webhook returned status (\d+)\.$/);
    const details = match ? classifyConnectorHttpFailure(Number(match[1])) : ambiguousAcknowledgement();
    return { status: details.category === "ambiguous_acknowledgement" ? "ambiguous" : "failed", acknowledged: false, externallyDelivered: false, output: {}, metadata: {} as Record<string, string | number | boolean | null>, error: details };
  }
};

const internalActionHandler: ConnectorActionHandler = async (input, context) => ({
  status: "succeeded",
  acknowledged: true,
  externallyDelivered: true,
  providerReferenceId: `test:${createHash("sha256").update(context.idempotencyKey).digest("hex").slice(0, 16)}`,
  output: { accepted: true, message: String(input.message ?? "") },
  metadata: { internal: true },
});

const connectors: RegisteredConnector[] = [
  {
    manifest: genericWebhookManifest,
    runtime: {
      actionHandlers: {},
      triggerHandlers: {
        "event_received@1": {
          verify: async () => true,
          normalize: async (_request, payload, operation) => ({
            eventId: randomUUID(), connectorId: "flowmind_webhook", operationKey: operation.key, operationVersion: operation.version,
            occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), data: { payload }, metadata: {},
          }),
        },
      },
    },
  },
  { manifest: genericHttpManifest, runtime: { actionHandlers: { "post_json@1": httpPostHandler }, triggerHandlers: {} } },
  {
    manifest: googleGmailManifest,
    runtime: {
      actionHandlers: { "send_email@1": gmailSendHandler, "reply_to_email@1": gmailReplyHandler },
      triggerHandlers: { "new_email@1": googleTriggerAdapter, "new_email_matching_search@1": googleTriggerAdapter },
    },
  },
  {
    manifest: googleSheetsManifest,
    runtime: { actionHandlers: { "add_row@1": sheetsAddHandler, "find_row@1": sheetsFindHandler, "update_row@1": sheetsUpdateHandler }, triggerHandlers: {} },
  },
  {
    manifest: internalTestManifest,
    runtime: {
      actionHandlers: { "acknowledge@1": internalActionHandler },
      triggerHandlers: {
        "test_event@1": {
          verify: async (request, body, secret) => {
            if (!secret) return false;
            const provided = request.headers.get("x-flowmind-test-signature") ?? "";
            const expected = createHash("sha256").update(secret).update(body).digest("hex");
            const left = Buffer.from(provided); const right = Buffer.from(expected);
            return left.length === right.length && timingSafeEqual(left, right);
          },
          normalize: async (_request, payload, operation) => ({
            eventId: randomUUID(), connectorId: "flowmind_test", operationKey: operation.key, operationVersion: operation.version,
            occurredAt: new Date().toISOString(), receivedAt: new Date().toISOString(), data: (payload && typeof payload === "object" ? payload : { value: payload }) as Record<string, unknown>, metadata: { internal: true },
          }),
        },
      },
    },
  },
];

function operationId(operation: ConnectorOperation) { return `${operation.kind}:${operation.key}@${operation.version}`; }

export function validateConnectorRegistry(entries: RegisteredConnector[] = connectors): string[] {
  const errors: string[] = [];
  const connectorIds = new Set<string>();
  for (const connector of entries) {
    const { manifest, runtime } = connector;
    if (!/^[a-z][a-z0-9_]{2,79}$/.test(manifest.id)) errors.push(`Malformed connector ID: ${manifest.id}`);
    if (connectorIds.has(manifest.id)) errors.push(`Duplicate connector ID: ${manifest.id}`);
    connectorIds.add(manifest.id);
    const operationIds = new Set<string>();
    for (const operation of [...manifest.triggers, ...manifest.actions]) {
      const id = operationId(operation);
      if (operationIds.has(id)) errors.push(`Duplicate operation ${manifest.id}/${id}`);
      operationIds.add(id);
      const runtimeKey = `${operation.key}@${operation.version}`;
      const handler = operation.kind === "action" ? runtime.actionHandlers[runtimeKey] : runtime.triggerHandlers[runtimeKey];
      if ((manifest.status === "AVAILABLE" || manifest.status === "BETA" || manifest.status === "INTERNAL") && !handler) errors.push(`Missing runtime handler ${manifest.id}/${id}`);
      if (operation.production && manifest.status === "INTERNAL") errors.push(`Internal connector cannot expose production operation ${manifest.id}/${id}`);
    }
  }
  return errors;
}

const registryErrors = validateConnectorRegistry();
if (registryErrors.length) throw new Error(`Invalid connector registry: ${registryErrors.join("; ")}`);

export function getConnector(connectorId: string): RegisteredConnector | null {
  return connectors.find(({ manifest }) => manifest.id === connectorId) ?? null;
}

export function getConnectorOperation(connectorId: string, kind: "trigger" | "action", key: string, version: number) {
  const connector = getConnector(connectorId);
  if (!connector) return null;
  const operation = (kind === "trigger" ? connector.manifest.triggers : connector.manifest.actions).find((item) => item.key === key && item.version === version);
  if (!operation) return null;
  const handlerKey = `${key}@${version}`;
  return { connector, operation, handler: kind === "trigger" ? connector.runtime.triggerHandlers[handlerKey] : connector.runtime.actionHandlers[handlerKey] };
}

export function getConnectorTrigger(connectorId: string, key: string, version: number) {
  const connector = getConnector(connectorId);
  if (!connector) return null;
  const operation = connector.manifest.triggers.find((item) => item.key === key && item.version === version);
  const handler = connector.runtime.triggerHandlers[`${key}@${version}`];
  return operation && handler ? { connector, operation, handler } : null;
}

export function listCustomerConnectors() {
  return connectors.filter(({ manifest }) => manifest.status === "AVAILABLE" || manifest.status === "BETA").map(({ manifest }) => manifest);
}

export function listAllConnectorManifests() { return connectors.map(({ manifest }) => manifest); }
