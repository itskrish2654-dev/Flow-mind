import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assessCapability } from "../lib/capability-registry";
import { addGoogleAuthorizationParameters } from "../lib/connectors/google/oauth-provider";
import {
  buildRawGmailMessage,
  htmlToSafeText,
  normalizeGmailMessage,
} from "../lib/connectors/google/gmail-message";
import {
  GOOGLE_SCOPES,
  googleScopesForOperation,
} from "../lib/connectors/google/scopes";
import {
  normalizeSpreadsheetId,
  quoteSheetName,
  rowForHeaders,
  safeSheetValue,
} from "../lib/connectors/google/sheets-values";
import { assessConnectorPlan } from "../lib/connectors/planning";
import { getConnector } from "../lib/connectors/registry";
import { compileReadyPlan } from "../lib/workflow-compiler";
import { deriveGmailSearch, planWorkflow } from "../lib/workflow-planner";

const b64url = (value: string) => Buffer.from(value).toString("base64url");

test("7B-1. Google provider family exposes only Gmail and Sheets as beta", () => {
  const gmail = getConnector("google_gmail")!;
  const sheets = getConnector("google_sheets")!;
  assert.equal(gmail.manifest.providerFamily, "google");
  assert.equal(sheets.manifest.providerFamily, "google");
  assert.equal(gmail.manifest.status, "BETA");
  assert.equal(sheets.manifest.status, "BETA");
  assert.deepEqual(gmail.manifest.triggers.map((item) => item.key), ["new_email", "new_email_matching_search"]);
  assert.deepEqual(gmail.manifest.actions.map((item) => item.key), ["send_email", "reply_to_email"]);
  assert.deepEqual(sheets.manifest.actions.map((item) => item.key), ["add_row", "find_row", "update_row"]);
});

test("7B-2. Calendar and Drive remain explicitly unsupported", () => {
  assert.equal(assessCapability("google_calendar", "production").available, false);
  assert.equal(assessCapability("google_drive", "production").available, false);
  assert.equal(planWorkflow("Connect Google Calendar and create an event.").status, "UNSUPPORTED");
  assert.equal(planWorkflow("Save this file to Google Drive.").status, "UNSUPPORTED");
});

test("7B-3. OAuth scopes are incremental and connector-specific", () => {
  const sheets = googleScopesForOperation("google_sheets", "add_row");
  const gmailRead = googleScopesForOperation("google_gmail", "new_email");
  const gmailSend = googleScopesForOperation("google_gmail", "send_email");
  assert.ok(sheets.includes(GOOGLE_SCOPES.sheets));
  assert.ok(!sheets.includes(GOOGLE_SCOPES.gmailReadonly));
  assert.ok(!gmailRead.includes(GOOGLE_SCOPES.sheets));
  assert.ok(gmailRead.includes(GOOGLE_SCOPES.gmailReadonly));
  assert.ok(gmailSend.includes(GOOGLE_SCOPES.gmailSend));
  assert.ok(!gmailSend.includes(GOOGLE_SCOPES.gmailReadonly));
  assert.ok(!gmailSend.includes("https://mail.google.com/"));
});

test("7B-4. Google OAuth requests offline and incremental authorization", () => {
  const url = addGoogleAuthorizationParameters(new URL("https://accounts.google.com/o/oauth2/v2/auth"), { loginHint: "owner@example.com", selectAccount: true });
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("include_granted_scopes"), "true");
  assert.match(url.searchParams.get("prompt") ?? "", /consent/);
  assert.equal(url.searchParams.get("login_hint"), "owner@example.com");
});

test("7B-5. OAuth state is replay-safe, owner-bound, and binds an intended connection", async () => {
  const oauth = await readFile("lib/connectors/oauth.ts", "utf8");
  const callback = await readFile("app/api/connectors/oauth/[connectorId]/callback/route.ts", "utf8");
  assert.match(oauth, /state_hash/);
  assert.match(oauth, /consumed_at/);
  assert.match(oauth, /\.eq\("user_id", input\.userId\)/);
  assert.match(oauth, /intended_connection_id/);
  assert.match(callback, /external_account_id !== tokens\.externalAccountId/);
});

test("7B-6. Multiple Google accounts require an exact selection", () => {
  const gmail = getConnector("google_gmail")!;
  const operation = gmail.manifest.actions[0];
  const accounts = [
    { id: "personal", connectorId: "google", providerFamily: "google", status: "connected" as const, grantedScopes: [GOOGLE_SCOPES.gmailSend] },
    { id: "sales", connectorId: "google", providerFamily: "google", status: "connected" as const, grantedScopes: [GOOGLE_SCOPES.gmailSend] },
  ];
  assert.equal(assessConnectorPlan(gmail.manifest, operation, accounts, "production").status, "CONNECTION_REQUIRED");
  assert.equal(assessConnectorPlan(gmail.manifest, operation, accounts, "production", "sales").status, "SUPPORTED");
});

test("7B-7. A connected Google account can require an additional operation scope", () => {
  const gmail = getConnector("google_gmail")!;
  const send = gmail.manifest.actions.find((item) => item.key === "send_email")!;
  const result = assessConnectorPlan(gmail.manifest, send, [{ id: "one", connectorId: "google", providerFamily: "google", status: "connected", grantedScopes: [GOOGLE_SCOPES.gmailReadonly] }], "production", "one");
  assert.equal(result.status, "ADDITIONAL_SCOPE_REQUIRED");
  assert.deepEqual(result.missingScopes, [GOOGLE_SCOPES.gmailSend]);
});

test("7B-8. workflow configuration verifies both workflow and connection ownership", async () => {
  const actions = await readFile("app/actions/connections.ts", "utf8");
  const publication = await readFile("app/actions/workflow.ts", "utf8");
  const subscriptions = await readFile("lib/connectors/subscriptions.ts", "utf8");
  assert.match(actions, /loadWorkflowSnapshot\(admin, request\.data\.workflowId, user\.id\)/);
  assert.match(actions, /\.eq\("id", request\.data\.connectionId\)\.eq\("user_id", user\.id\)/);
  assert.match(actions, /createImmutableWorkflowVersion/);
  assert.match(publication, /validateWorkflowConnectorConnections/);
  assert.match(subscriptions, /\.eq\("id", config\.connectionId\)\.eq\("user_id", input\.userId\)/);
});

test("7B-9. Gmail normalization prefers plain text and exposes a safe contract", () => {
  const normalized = normalizeGmailMessage({
    id: "m1", threadId: "t1", internalDate: "1700000000000", labelIds: ["INBOX"],
    payload: { mimeType: "multipart/alternative", headers: [{ name: "From", value: "Alice <alice@example.com>" }, { name: "Subject", value: "Demo" }], parts: [{ mimeType: "text/html", body: { data: b64url("<p>HTML</p>") } }, { mimeType: "text/plain", body: { data: b64url("Plain body") } }] },
  });
  assert.equal(normalized.message.text, "Plain body");
  assert.equal(normalized.message.from, "Alice <alice@example.com>");
  assert.equal(normalized.message.subject, "Demo");
  assert.deepEqual(normalized.message.labels, ["INBOX"]);
  assert.ok(!("payload" in normalized.message));
});

test("7B-10. Gmail HTML is converted to inert text", () => {
  const text = htmlToSafeText('<style>body{display:none}</style><p>Hello <b>Alice</b></p><script>alert("x")</script>');
  assert.equal(text, "Hello Alice");
  assert.doesNotMatch(text, /script|alert|display/);
});

test("7B-11. Gmail multipart attachments remain metadata-only", () => {
  const normalized = normalizeGmailMessage({ id: "m", threadId: "t", payload: { parts: [{ mimeType: "application/pdf", filename: "invoice.pdf", body: { attachmentId: "ref-1", size: 250 } }] } });
  assert.deepEqual(normalized.message.attachments, [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 250, attachmentId: "ref-1" }]);
  assert.doesNotMatch(JSON.stringify(normalized), /attachment body|downloadUrl/);
});

test("7B-12. Gmail processed text is bounded", () => {
  const normalized = normalizeGmailMessage({ payload: { mimeType: "text/plain", body: { data: b64url("a".repeat(70_000)) } } });
  assert.equal(normalized.message.text.length, 64 * 1024);
});

test("7B-13. Gmail reply MIME preserves threading headers and a stable message id", () => {
  const raw = Buffer.from(buildRawGmailMessage({ to: ["alice@example.com"], subject: "Re: Demo", body: "Reply", messageId: "<stable@crazyloops.com>", inReplyTo: "<original@example.com>", references: "<old@example.com> <original@example.com>" }), "base64url").toString("utf8");
  assert.match(raw, /Message-ID: <stable@crazyloops\.com>/);
  assert.match(raw, /In-Reply-To: <original@example\.com>/);
  assert.match(raw, /References: <old@example\.com> <original@example\.com>/);
});

test("7B-14. Gmail push validates the exact OIDC audience and service account", async () => {
  const push = await readFile("lib/connectors/google/gmail-push.ts", "utf8");
  assert.match(push, /verifyIdToken/);
  assert.match(push, /GOOGLE_PUBSUB_AUDIENCE/);
  assert.match(push, /GOOGLE_PUBSUB_SERVICE_ACCOUNT/);
  assert.match(push, /payload\.email === serviceAccount/);
});

test("7B-15. Gmail history is checkpointed only after durable deduped receipts", async () => {
  const push = await readFile("lib/connectors/google/gmail-push.ts", "utf8");
  assert.ok(push.indexOf("connector_event_receipts") < push.indexOf("cursor_value: notification.historyId"));
  assert.match(push, /provider_event_key: `gmail:\$\{messageId\}`/);
  assert.match(push, /receiptError\.code !== "23505"/);
  assert.match(push, /processingFailed/);
});

test("7B-16. Gmail watches record expiry and renew through maintenance", async () => {
  const push = await readFile("lib/connectors/google/gmail-push.ts", "utf8");
  const maintenance = await readFile("app/api/operations/maintenance/route.ts", "utf8");
  assert.match(push, /users\/me\/watch/);
  assert.match(push, /expires_at/);
  assert.match(push, /renew_after/);
  assert.match(maintenance, /renewDueGmailWatches/);
});

test("7B-17. Disconnect stops watches, revokes a refresh token, and removes vault records", async () => {
  const vault = await readFile("lib/connectors/connection-vault.ts", "utf8");
  assert.match(vault, /stopGmailWatch/);
  assert.match(vault, /credentialKey: "refresh_token"/);
  assert.match(vault, /revokeGoogleToken/);
  assert.match(vault, /connector_connection_credentials"\)\.delete/);
});

test("7B-18. Spreadsheet selection accepts a real ID or URL and rejects invalid input", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz123456789";
  assert.equal(normalizeSpreadsheetId(id), id);
  assert.equal(normalizeSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`), id);
  assert.throws(() => normalizeSpreadsheetId("not a spreadsheet"));
  assert.equal(quoteSheetName("Sales' Leads"), "'Sales'' Leads'");
});

test("7B-19. Sheet rows map only real headers and preserve identifiers and formula-like text", () => {
  const row = rowForHeaders(["Name", "Email", "Code", "Formula"], { message: { from: "Alice <alice@example.com>" }, code: "001234", formula: "=IMPORTXML(\"x\")", ignored: "not a column" });
  assert.deepEqual(row, ["Alice", "alice@example.com", "001234", '=IMPORTXML("x")']);
  assert.equal(safeSheetValue(false), false);
  assert.equal(safeSheetValue(null), "");
});

test("7B-20. Sheets schema helper lists worksheets after owner-bound access", async () => {
  const sheets = await readFile("lib/connectors/google/sheets.ts", "utf8");
  const actions = await readFile("app/actions/connections.ts", "utf8");
  assert.match(sheets, /sheets\.properties/);
  assert.match(sheets, /worksheets/);
  assert.match(actions, /inspectGoogleSpreadsheet\(\{ userId: user\.id/);
});

test("7B-21. add and update use RAW semantics and require one-row acknowledgement", async () => {
  const sheets = await readFile("lib/connectors/google/sheets.ts", "utf8");
  assert.match(sheets, /valueInputOption=RAW/);
  assert.match(sheets, /insertDataOption=INSERT_ROWS/);
  assert.match(sheets, /updatedRows !== 1/);
  assert.match(sheets, /rowNumber < 2/);
});

test("7B-22. find row distinguishes zero, one, and multiple exact matches", async () => {
  const sheets = await readFile("lib/connectors/google/sheets.ts", "utf8");
  assert.match(sheets, /String\(row\[columnIndex\] \?\? ""\) === expected/);
  assert.match(sheets, /matches\.length > 1/);
  assert.match(sheets, /SHEETS_AMBIGUOUS_MATCH/);
  assert.match(sheets, /found: Boolean\(match\)/);
});

test("7B-23. Google 429 and ambiguous write outcomes remain truthful", async () => {
  const api = await readFile("lib/connectors/google/api.ts", "utf8");
  const errors = await readFile("lib/connectors/errors.ts", "utf8");
  assert.match(errors, /status === 429/);
  assert.match(errors, /retryable: true/);
  assert.match(api, /GOOGLE_RESPONSE_UNKNOWN/);
  assert.match(api, /externallyDelivered: false/);
});

test("7B-24. planner supports Gmail to CrazyLoops and Gmail to AI to Sheets", () => {
  const storePrompt = "When a new Gmail message arrives, store it inside CrazyLoops.";
  const storePlan = planWorkflow(storePrompt);
  assert.equal(storePlan.status, "READY_TO_COMPILE");
  if (storePlan.status === "READY_TO_COMPILE") {
    const workflow = compileReadyPlan(storePrompt, storePlan);
    assert.deepEqual(workflow.steps.map((step) => step.capabilityId), ["gmail_new_email", "flowmind_data_store"]);
  }
  const sheetsPrompt = "When a new Gmail message contains 'invoice', summarize it with AI and add it to Google Sheets.";
  const sheetsPlan = planWorkflow(sheetsPrompt);
  assert.equal(sheetsPlan.status, "READY_TO_COMPILE");
  if (sheetsPlan.status === "READY_TO_COMPILE") {
    const workflow = compileReadyPlan(sheetsPrompt, sheetsPlan);
    assert.deepEqual(workflow.steps.map((step) => step.capabilityId), ["gmail_new_email_matching_search", "ai_text_transform", "google_sheets_add_row"]);
  }
});

test("7B-25. planner supports form to Sheets and manual to Gmail", () => {
  for (const prompt of ["When a public form is submitted, add a row to Google Sheets.", "When I run this manually, send an email through Gmail."]) {
    const plan = planWorkflow(prompt);
    assert.equal(plan.status, "READY_TO_COMPILE", prompt);
    if (plan.status === "READY_TO_COMPILE") assert.ok(compileReadyPlan(prompt, plan).steps.some((step) => step.type === "connector_action"));
  }
});

test("7B-26. Gmail search is derived only from concrete sender, phrase, or subject", () => {
  assert.equal(deriveGmailSearch("When Gmail from @acme.com contains 'invoice'"), 'from:(@acme.com) "invoice"');
  assert.equal(planWorkflow("When a new Gmail message arrives from a customer, store it in CrazyLoops.").status, "NEEDS_CLARIFICATION");
});

test("7B-27. compiled Google steps pin connector, operation, version, and exact connection slot", () => {
  const prompt = "When a public form is submitted, add a row to Google Sheets.";
  const plan = planWorkflow(prompt);
  assert.equal(plan.status, "READY_TO_COMPILE");
  if (plan.status !== "READY_TO_COMPILE") return;
  const workflow = compileReadyPlan(prompt, plan);
  const connector = workflow.steps.at(-1)?.config?.connector;
  assert.deepEqual({ id: connector?.connectorId, key: connector?.operationKey, version: connector?.operationVersion }, { id: "google_sheets", key: "add_row", version: 1 });
  assert.equal(connector?.connectionId, undefined);
});

test("7B-28. tokens remain server-only and browser connection responses expose metadata only", async () => {
  const client = await readFile("components/connections-list.tsx", "utf8");
  const actions = await readFile("app/actions/connections.ts", "utf8");
  const callback = await readFile("app/api/connectors/oauth/[connectorId]/callback/route.ts", "utf8");
  assert.doesNotMatch(client, /access_token|refresh_token|client_secret/i);
  assert.doesNotMatch(actions, /ciphertext|auth_tag|nonce/);
  assert.match(callback, /storeConnectionSecret/);
  assert.doesNotMatch(callback, /NextResponse\.json\([^)]*tokens/);
});

test("7B-29. account deletion cascades connector metadata, credentials, subscriptions, and receipts", async () => {
  const migration = await readFile("supabase/migrations/20260814000100_phase7a_connector_engine.sql", "utf8");
  const account = await readFile("app/actions/account.ts", "utf8");
  const reconciliation = await readFile("lib/account-deletion-maintenance.ts", "utf8");
  for (const table of ["connector_connections", "connector_connection_credentials", "connector_subscriptions", "connector_event_receipts"]) assert.match(migration, new RegExp(table));
  assert.match(migration, /on delete cascade/i);
  assert.match(account, /revokeAllUserConnections/);
  assert.match(reconciliation, /revokeAllUserConnections/);
});

test("7B-30. privacy-safe telemetry names are present without content fields", async () => {
  const sources = await Promise.all(["lib/connectors/google/api.ts", "lib/connectors/google/gmail-push.ts", "lib/connectors/google/gmail.ts", "lib/connectors/google/sheets.ts", "app/api/connectors/oauth/[connectorId]/callback/route.ts"].map((file) => readFile(file, "utf8")));
  const combined = sources.join("\n");
  for (const event of ["google_connection_success", "google_connection_failure", "google_reconnect_required", "gmail_watch_created", "gmail_watch_renewed", "gmail_event_received", "gmail_history_error", "gmail_action_success", "gmail_action_failure", "sheets_action_success", "sheets_action_failure", "sheets_rate_limited"]) assert.match(combined, new RegExp(event));
  assert.doesNotMatch(combined, /metadata:\s*\{[^}]*emailBody|metadata:\s*\{[^}]*cellValue/);
});
