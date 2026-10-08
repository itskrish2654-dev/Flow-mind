import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { ActionPreviewSchema, type ActionPreview } from "@/lib/action-execution-core";
import type { AskGroundedResponse } from "@/lib/ask-core";
import { getCapability } from "@/lib/capability-registry";
import { googleSheetsAcceptanceCapability } from "@/lib/google-sheets-live-acceptance";
import { notionAcceptanceAction, notionLiveAcceptanceEnabled } from "@/lib/notion-live-acceptance";
import { connectorConnectionIds } from "@/lib/connectors/connection-matching";
import { getConnector } from "@/lib/connectors/registry";
import { parseGmailSendIntent } from "@/lib/connectors/google/gmail-action-intent";
import { parseCalendarActionIntent } from "@/lib/connectors/google/calendar-action-intent";
import { listGoogleCalendars, readGoogleCalendarEvent } from "@/lib/connectors/google/calendar";
import { parseSheetWriteIntent } from "@/lib/connectors/google/sheets-action-intent";
import { findSelectedGoogleSpreadsheetRow, inspectSelectedGoogleWorksheet, readSelectedGoogleSpreadsheetRow } from "@/lib/connectors/google/sheets";
import { resolveSelectedSheetForQuestion } from "@/lib/connectors/google/sheets-work-context";
import { parseSlackReplyIntent, parseSlackSendIntent } from "@/lib/connectors/slack/action-intent";
import { listSlackChannels, verifySlackThread } from "@/lib/connectors/slack/messages";
import { parseNotionActionIntent } from "@/lib/connectors/notion/action-intent";
import { inspectNotionDataSource, listNotionResources } from "@/lib/connectors/notion/actions";
import { notionApiFetch } from "@/lib/connectors/notion/api";
import { NOTION_CAPABILITIES } from "@/lib/connectors/notion/constants";
import { mapNotionProperties, notionPageBelongsToDataSource } from "@/lib/connectors/notion/properties";
import type { Database } from "@/lib/supabase/types";

type Scope = { userId: string; workspaceId: string; supabase: SupabaseClient<Database> };

function acceptanceHarnessEnabled() {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.WORK_OS_ACTION_ACCEPTANCE_ENABLED !== "true") return false;
  try {
    return new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "").hostname === "localhost";
  } catch {
    return false;
  }
}

async function ownedConnection(scope: Scope, connectorId: string, requiredScopes: readonly string[]) {
  const connector = getConnector(connectorId);
  if (!connector) return null;
  const { data, error } = await scope.supabase.from("connector_connections")
    .select("id,connector_id,status,granted_scopes,external_account_label")
    .eq("workspace_id", scope.workspaceId)
    .eq("user_id", scope.userId)
    .eq("provider_family", connector.manifest.providerFamily)
    .in("connector_id", connectorConnectionIds(connector.manifest))
    .eq("status", "connected")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Action connection could not be checked.");
  if (!data || requiredScopes.some((required) => !data.granted_scopes.includes(required))) return null;
  return data;
}

async function ownedGmailSendConnection(scope: Scope, requiredScopes: readonly string[], fromAccount?: string) {
  const { data, error } = await scope.supabase.from("connector_connections")
    .select("id,external_account_label,granted_scopes")
    .eq("workspace_id", scope.workspaceId).eq("user_id", scope.userId)
    .eq("provider_family", "google").in("connector_id", ["google", "google_gmail"])
    .eq("status", "connected").order("created_at", { ascending: false }).limit(6);
  if (error) throw new Error("Gmail sending account could not be checked.");
  const usable = (data ?? []).filter((item) => requiredScopes.every((scope) => item.granted_scopes.includes(scope)));
  if (fromAccount) return usable.find((item) => item.external_account_label?.toLowerCase() === fromAccount.toLowerCase()) ?? null;
  if (usable.length > 1) return "selection_required" as const;
  return usable[0] ?? null;
}

async function ownedSlackSendConnection(scope: Scope, requiredScopes: readonly string[]) {
  const { data, error } = await scope.supabase.from("connector_connections")
    .select("id,external_account_label,granted_scopes")
    .eq("workspace_id", scope.workspaceId).eq("user_id", scope.userId)
    .eq("provider_family", "slack").eq("connector_id", "slack")
    .eq("status", "connected").order("created_at", { ascending: false }).limit(6);
  if (error) throw new Error("Slack sending account could not be checked.");
  const usable = (data ?? []).filter((item) => requiredScopes.every((required) => item.granted_scopes.includes(required)));
  if (usable.length > 1) return "selection_required" as const;
  return usable[0] ?? null;
}

function response(preview: ActionPreview): AskGroundedResponse {
  return {
    answer: `${preview.actionSummary}\n\nNothing has been sent or changed yet. Review the exact action before requesting approval.`,
    metadata: {
      version: 1,
      responseType: "action_preview",
      clarificationRequired: false,
      references: [],
      actionPreview: preview,
    },
  };
}

function clarification(answer: string): AskGroundedResponse {
  return {
    answer,
    metadata: { version: 1, responseType: "clarification", clarificationRequired: true, references: [] },
  };
}

function connectionRequired(name: string): AskGroundedResponse {
  return {
    answer: `Connect ${name} before CrazyLoops can prepare this action for approval. Nothing was sent or changed.`,
    metadata: {
      version: 1,
      responseType: "unsupported",
      clarificationRequired: false,
      references: [],
      unsupportedReason: `${name} is not connected for this workspace.`,
      suggestedAction: { label: "Open Connections", href: "/connections" },
    },
  };
}

function parameter(name: string, label: string, value: string) {
  return { name, label, value };
}

function existingColumnAssignments(headers: string[], requested: Record<string, string>) {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(requested)) {
    const header = headers.find((item) => item.toLowerCase() === key.trim().toLowerCase());
    if (!header || Object.hasOwn(values, header) || !value.trim()) return null;
    values[header] = value.trim();
  }
  return values;
}

async function planSheetsAction(scope: Scope, question: string): Promise<AskGroundedResponse | null> {
  const intent = parseSheetWriteIntent(question);
  if (!intent) return null;
  if (intent === "clarification") return clarification("Specify a Google spreadsheet, worksheet, and exact existing column values such as Status = Qualified. Nothing was changed.");
  const capability = getCapability(intent.kind === "add" ? "google_sheets_add_row" : "google_sheets_update_row");
  if (!capability?.supported || !(capability.availableInProduction || googleSheetsAcceptanceCapability(capability.id)) || !capability.connectorOperation) return null;
  const resolved = await resolveSelectedSheetForQuestion({ userId: scope.userId, workspaceId: scope.workspaceId, question });
  if (resolved.status === "connection_required" || resolved.status === "reconnect_required") return connectionRequired("Google Sheets");
  if (resolved.status !== "ok") return clarification(resolved.message + " Nothing was changed.");
  const selected = resolved.selection;
  const worksheet = await inspectSelectedGoogleWorksheet({
    userId: scope.userId, workspaceId: scope.workspaceId,
    connectionId: selected.connectionId, spreadsheetId: selected.spreadsheetId, worksheet: selected.worksheet,
  });
  const requested = { ...intent.assignments };
  if (intent.kind === "add" && intent.initialValue) {
    const subjectHeader = worksheet.headers.find((header) => /^(?:company|customer|client)$/i.test(header));
    if (!subjectHeader || Object.keys(requested).some((key) => key.toLowerCase() === subjectHeader.toLowerCase())) {
      return clarification(`Name the exact column for “${intent.initialValue.slice(0, 80)}” and every value to add. Nothing was changed.`);
    }
    requested[subjectHeader] = intent.initialValue;
  }
  const values = existingColumnAssignments(worksheet.headers, requested);
  if (!values || Object.keys(values).length === 0) {
    return clarification("Use only existing worksheet headers, with a non-empty value for each requested column. Nothing was changed.");
  }
  const changes = Object.entries(values).map(([header, value]) => `${header} = “${value}”`).join("; ");
  const common = [
    parameter("spreadsheetId", "Picker-selected spreadsheet ID", selected.spreadsheetId),
    parameter("worksheet", "Worksheet", selected.worksheet),
  ];
  if (intent.kind === "add") {
    const preview = ActionPreviewSchema.safeParse({
      version: 1, capabilityId: capability.id,
      connectorId: capability.connectorOperation.connectorId,
      operationKey: capability.connectorOperation.operationKey,
      operationVersion: capability.connectorOperation.operationVersion,
      connectionId: selected.connectionId,
      actionTitle: "Add one Google Sheets row",
      actionSummary: `Add one row in ${selected.spreadsheetName} / ${selected.worksheet}: ${changes}. Other existing columns will be blank.`,
      approvalReason: "Appending a row changes an external spreadsheet and requires approval.",
      target: { kind: "external_resource", label: `${selected.spreadsheetName} / ${selected.worksheet}`.slice(0, 180), reference: selected.spreadsheetId },
      parameters: [...common, parameter("values", "Exact column values", JSON.stringify(values)), parameter("strictColumns", "Require exact columns", "true")],
    });
    return preview.success ? response(preview.data)
      : clarification("This row is too large or contains credential-like text for a safe approval preview. Nothing was changed.");
  }

  let rowNumber: number;
  let current: Record<string, string | number | boolean>;
  let rowHash: string;
  const requestedRow = intent.target.match(/^row\s+(\d{1,6})$/i);
  if (requestedRow) {
    const row = await readSelectedGoogleSpreadsheetRow({
      userId: scope.userId, workspaceId: scope.workspaceId,
      connectionId: selected.connectionId, spreadsheetId: selected.spreadsheetId,
      worksheet: selected.worksheet, rowNumber: Number(requestedRow[1]),
    });
    rowNumber = row.rowNumber; current = row.values; rowHash = row.rowHash;
  } else {
    const matchColumn = worksheet.headers.find((header) => /^(?:company|customer|client)$/i.test(header));
    if (!matchColumn) return clarification("Name a unique row number or use a worksheet with a Company, Customer, or Client header. Nothing was changed.");
    const match = await findSelectedGoogleSpreadsheetRow({
      userId: scope.userId, workspaceId: scope.workspaceId,
      connectionId: selected.connectionId, spreadsheetId: selected.spreadsheetId,
      worksheet: selected.worksheet, matchColumn, matchValue: intent.target,
    });
    if (match.multipleMatches) return clarification("More than one row matches that name. Specify a unique row number. Nothing was changed.");
    if (!match.found || !match.rowNumber) return clarification("No exact matching row was found in the selected worksheet. Nothing was changed.");
    const row = await readSelectedGoogleSpreadsheetRow({
      userId: scope.userId, workspaceId: scope.workspaceId,
      connectionId: selected.connectionId, spreadsheetId: selected.spreadsheetId,
      worksheet: selected.worksheet, rowNumber: match.rowNumber,
    });
    if (String(row.values[matchColumn] ?? "") !== intent.target) {
      return clarification("The matching row changed while preparing the preview. Ask again before approving anything.");
    }
    rowNumber = row.rowNumber; current = row.values; rowHash = row.rowHash;
  }
  const beforeAfter = Object.entries(values).map(([header, value]) =>
    `${header}: “${String(current[header] ?? "")}” → “${value}”`).join("; ");
  const preview = ActionPreviewSchema.safeParse({
    version: 1, capabilityId: capability.id,
    connectorId: capability.connectorOperation.connectorId,
    operationKey: capability.connectorOperation.operationKey,
    operationVersion: capability.connectorOperation.operationVersion,
    connectionId: selected.connectionId,
    actionTitle: "Update one Google Sheets row",
    actionSummary: `Update only row ${rowNumber} in ${selected.spreadsheetName} / ${selected.worksheet}. ${beforeAfter}. All other columns remain unchanged. If the row changes before execution, the update stops.`,
    approvalReason: "Changing an existing spreadsheet row requires approval of this exact row and values.",
    target: { kind: "external_resource", label: `${selected.spreadsheetName} / ${selected.worksheet} / row ${rowNumber}`.slice(0, 180), reference: `${selected.spreadsheetId}:${rowNumber}` },
    parameters: [...common, parameter("rowNumber", "Exact row number", String(rowNumber)),
      parameter("values", "Changed column values", JSON.stringify(values)),
      parameter("expectedRowHash", "Reviewed row fingerprint", rowHash),
      parameter("strictColumns", "Require exact columns", "true")],
  });
  return preview.success ? response(preview.data)
    : clarification("This update is too large or contains credential-like text for a safe approval preview. Nothing was changed.");
}

async function planCalendarAction(scope: Scope, question: string): Promise<AskGroundedResponse | null> {
  const intent = parseCalendarActionIntent(question);
  if (!intent) return null;
  if (intent === "clarification") return clarification(
    'For a safe Calendar preview, use: Create Google Calendar event "Title" from 2026-10-07T10:00:00+05:30 to 2026-10-07T10:30:00+05:30 in Asia/Kolkata. For an update, name the exact event ID and new title. Nothing was changed.',
  );
  const capability = getCapability(intent.kind === "create" ? "google_calendar_create_event" : "google_calendar_update_event");
  if (!capability?.supported || !capability.availableInProduction || !capability.connectorOperation) return null;
  const connection = await ownedConnection(scope, "google_calendar", capability.requiredScopes);
  if (!connection) return connectionRequired("Google Calendar");
  const listing = await listGoogleCalendars({ userId: scope.userId, workspaceId: scope.workspaceId, connectionId: connection.id });
  if (!listing.calendars.some((calendar) => calendar.primary && calendar.owned)) {
    return clarification("The connected account's primary calendar is not owned or is unavailable. Nothing was changed.");
  }
  const common = {
    version: 1 as const, capabilityId: capability.id,
    connectorId: capability.connectorOperation.connectorId,
    operationKey: capability.connectorOperation.operationKey,
    operationVersion: capability.connectorOperation.operationVersion,
    connectionId: connection.id,
  };
  if (intent.kind === "create") {
    const preview = ActionPreviewSchema.safeParse({ ...common,
      actionTitle: "Create one Google Calendar event",
      actionSummary: `Create “${intent.summary}” on the owned primary calendar, ${intent.start} to ${intent.end} (${intent.timeZone}). No invitations or notifications will be sent.`,
      approvalReason: "Creating an external calendar event requires approval of its exact title and time.",
      target: { kind: "external_resource", label: `${connection.external_account_label ?? "Google account"} / primary calendar`, reference: "primary" },
      parameters: [parameter("summary", "Event title", intent.summary), parameter("start", "Start", intent.start),
        parameter("end", "End", intent.end), parameter("timeZone", "Time zone", intent.timeZone)],
    });
    return preview.success ? response(preview.data) : clarification("The event cannot be safely previewed. Nothing was changed.");
  }
  const event = await readGoogleCalendarEvent({ userId: scope.userId, workspaceId: scope.workspaceId,
    connectionId: connection.id, eventId: intent.eventId });
  if (!event) return clarification("That exact event was not found on the owned primary calendar. Nothing was changed.");
  if (event.summary === intent.summary) return clarification("The event already has that title. Nothing was changed.");
  const preview = ActionPreviewSchema.safeParse({ ...common,
    actionTitle: "Update one Google Calendar event",
    actionSummary: `Change only the title of “${event.summary}” to “${intent.summary}” on the primary calendar. Its time remains ${event.startAt} to ${event.endAt}. If the event changes before execution, this update stops.`,
    approvalReason: "Changing an existing calendar event requires approval of the exact event and new title.",
    target: { kind: "external_resource", label: event.summary, reference: event.id },
    parameters: [parameter("eventId", "Exact event ID", event.id), parameter("expectedEtag", "Reviewed event version", event.etag),
      parameter("summary", "New title", intent.summary)],
  });
  return preview.success ? response(preview.data) : clarification("The update cannot be safely previewed. Nothing was changed.");
}

/** Deterministic allowlist. The model cannot name or construct executable capabilities. */
export async function planAskAction(scope: Scope, question: string): Promise<AskGroundedResponse | null> {
  const notion = parseNotionActionIntent(question);
  if (notion && notionLiveAcceptanceEnabled()) {
    if (notion === "clarification") return clarification('Use: Add Notion item to "Exact data source name" with {"Name":"Exact title"}. For an update, name the exact item UUID and data source. Nothing was changed.');
    const capability = getCapability(notion.kind === "add" ? "notion_create_data_source_item" : "notion_update_item");
    if (!capability?.connectorOperation || !notionAcceptanceAction(capability.id)) return null;
    const connection = await ownedConnection(scope, "notion", capability.requiredScopes);
    if (!connection) return connectionRequired("Notion");
    const resources = await listNotionResources({ userId: scope.userId, connectionId: connection.id });
    const sources = resources.filter((resource) => resource.type === "data_source" && resource.title.toLocaleLowerCase() === notion.dataSourceName.toLocaleLowerCase());
    if (sources.length !== 1) return clarification("Name one exact, shared Notion data source. Nothing was changed.");
    const source = sources[0];
    const inspected = await inspectNotionDataSource({ userId: scope.userId, connectionId: connection.id, dataSourceId: source.id });
    try { mapNotionProperties(inspected.properties, notion.values); }
    catch { return clarification("The requested fields do not exactly match supported properties of the selected Notion data source. Nothing was changed."); }
    if (notion.kind === "update") {
      const page = await notionApiFetch({ userId: scope.userId, connectionId: connection.id,
        requiredCapabilities: [NOTION_CAPABILITIES.readContent], path: `/pages/${notion.pageId}` });
      if (!notionPageBelongsToDataSource(page, source.id)) return clarification("The exact Notion item is not in the selected data source. Nothing was changed.");
    }
    const preview = ActionPreviewSchema.safeParse({
      version: 1, capabilityId: capability.id,
      connectorId: capability.connectorOperation.connectorId,
      operationKey: capability.connectorOperation.operationKey,
      operationVersion: capability.connectorOperation.operationVersion,
      connectionId: connection.id,
      actionTitle: notion.kind === "add" ? "Add one Notion data-source item" : "Update one Notion data-source item",
      actionSummary: notion.kind === "add"
        ? `Create one item in the exact shared Notion data source “${source.title}” with the displayed properties.`
        : `Update only item ${notion.pageId} in the exact shared Notion data source “${source.title}” with the displayed properties.`,
      approvalReason: "Changing external Notion content requires approval of the exact item and values.",
      target: { kind: "external_resource", label: source.title, reference: notion.kind === "add" ? source.id : notion.pageId },
      parameters: [parameter("dataSourceId", "Data source", source.id),
        ...(notion.kind === "update" ? [parameter("pageId", "Exact item", notion.pageId)] : []),
        parameter("values", "Exact property values", JSON.stringify(notion.values))],
    });
    return preview.success ? response(preview.data)
      : clarification("The Notion change cannot be safely previewed within approval limits. Nothing was changed.");
  }
  const calendar = await planCalendarAction(scope, question);
  if (calendar) return calendar;
  const sheets = await planSheetsAction(scope, question);
  if (sheets) return sheets;
  const internal = question.match(/^\[acceptance action\]\s*acknowledge:\s*(.{1,500})$/i);
  if (internal && acceptanceHarnessEnabled()) {
    const capability = getCapability("internal.action_acknowledge");
    if (!capability?.supported || !capability.availableInTest || !capability.connectorOperation) return null;
    const connection = await ownedConnection(scope, "flowmind_test", capability.requiredScopes);
    if (!connection) return connectionRequired("the acceptance connector");
    return response(ActionPreviewSchema.parse({
      version: 1,
      capabilityId: capability.id,
      connectorId: capability.connectorOperation.connectorId,
      operationKey: capability.connectorOperation.operationKey,
      operationVersion: capability.connectorOperation.operationVersion,
      connectionId: connection.id,
      actionTitle: "Run approved acceptance action",
      actionSummary: `Acknowledge the exact message “${internal[1]}”.`,
      approvalReason: "This action produces an acknowledged side effect through the acceptance connector.",
      target: { kind: "external_resource", label: connection.external_account_label ?? "Acceptance connector", reference: connection.id },
      parameters: [parameter("message", "Message", internal[1])],
    }));
  }

  const gmailSend = parseGmailSendIntent(question);
  if (gmailSend) {
    if (gmailSend === "clarification") {
      return clarification("Provide one valid recipient and the exact email message. Nothing was sent.");
    }
    const capability = getCapability("gmail_send_email");
    if (!capability?.supported || !capability.availableInProduction || !capability.connectorOperation) return null;
    const connection = await ownedGmailSendConnection(scope, capability.requiredScopes, gmailSend.fromAccount);
    if (connection === "selection_required") {
      return clarification("Which Gmail account should send this? Start your request with ‘Using your-address@example.com, ...’. Nothing was sent.");
    }
    if (!connection) return connectionRequired("Gmail");
    const preview = ActionPreviewSchema.safeParse({
      version: 1,
      capabilityId: capability.id,
      connectorId: capability.connectorOperation.connectorId,
      operationKey: capability.connectorOperation.operationKey,
      operationVersion: capability.connectorOperation.operationVersion,
      connectionId: connection.id,
      actionTitle: "Send email through Gmail",
      actionSummary: `Send one email from ${connection.external_account_label ?? "the selected Gmail account"} to ${gmailSend.to} with subject “${gmailSend.subject}”.`,
      approvalReason: "Sending email is an external side effect and requires approval.",
      target: { kind: "external_resource", label: gmailSend.to, reference: gmailSend.to },
      parameters: [
        parameter("to", "To", gmailSend.to),
        parameter("subject", "Subject", gmailSend.subject),
        parameter("body", "Body", gmailSend.body),
      ],
    });
    if (!preview.success) {
      return clarification("The email cannot be safely prepared within the approval limits. Shorten the message or remove credential-like text. Nothing was sent.");
    }
    return response(preview.data);
  }

  const slackReply = parseSlackReplyIntent(question);
  if (slackReply) {
    if (slackReply === "clarification") return clarification("Name one joined public Slack channel, the exact parent thread timestamp, and the reply text. Nothing was sent.");
    const capability = getCapability("slack_reply_in_thread");
    if (!capability?.supported || !capability.availableInProduction || !capability.connectorOperation) return null;
    const connection = await ownedSlackSendConnection(scope, capability.requiredScopes);
    if (connection === "selection_required") return clarification("More than one Slack workspace is connected. Select one connection in your workflow or disconnect the unused installation before replying through Ask. Nothing was sent.");
    if (!connection) return connectionRequired("Slack");
    const channels = (await listSlackChannels({ userId: scope.userId, workspaceId: scope.workspaceId, connectionId: connection.id }))
      .filter((channel) => channel.isMember && channel.name.toLowerCase() === slackReply.channelName);
    if (channels.length !== 1) return clarification(`I could not identify one joined public Slack channel named #${slackReply.channelName}. Nothing was sent.`);
    const channel = channels[0];
    if (!await verifySlackThread({ userId: scope.userId, workspaceId: scope.workspaceId, connectionId: connection.id, channelId: channel.id, threadTs: slackReply.threadTs })) {
      return clarification("I could not verify that exact Slack parent message in the selected channel. Nothing was sent.");
    }
    const preview = ActionPreviewSchema.safeParse({
      version: 1,
      capabilityId: capability.id,
      connectorId: capability.connectorOperation.connectorId,
      operationKey: capability.connectorOperation.operationKey,
      operationVersion: capability.connectorOperation.operationVersion,
      connectionId: connection.id,
      actionTitle: `Reply in #${channel.name} on Slack`,
      actionSummary: `Reply to the exact thread ${slackReply.threadTs} in #${channel.name} in ${connection.external_account_label ?? "the selected Slack workspace"}.`,
      approvalReason: "Replying in a Slack thread is an external side effect and requires approval.",
      target: { kind: "external_resource", label: `#${channel.name} thread ${slackReply.threadTs}`, reference: `${channel.id}:${slackReply.threadTs}` },
      parameters: [parameter("channel", "Channel", channel.id), parameter("threadTs", "Parent message", slackReply.threadTs), parameter("text", "Reply", slackReply.text)],
    });
    if (!preview.success) return clarification("The Slack reply cannot be safely prepared within approval limits. Shorten it or remove credential-like text. Nothing was sent.");
    return response(preview.data);
  }

  const slackSend = parseSlackSendIntent(question);
  if (slackSend) {
    if (slackSend === "clarification") return clarification("Name one exact public Slack channel and the exact message, for example: ‘Tell #sales that the proposal is ready.’ Nothing was sent.");
    const capability = getCapability("slack_send_channel_message");
    if (!capability?.supported || !capability.availableInProduction || !capability.connectorOperation) return null;
    const connection = await ownedSlackSendConnection(scope, capability.requiredScopes);
    if (connection === "selection_required") return clarification("More than one Slack workspace is connected. Select one connection in your workflow or disconnect the unused installation before sending through Ask. Nothing was sent.");
    if (!connection) return connectionRequired("Slack");
    const channels = (await listSlackChannels({ userId: scope.userId, workspaceId: scope.workspaceId, connectionId: connection.id }))
      .filter((channel) => channel.isMember && channel.name.toLowerCase() === slackSend.channelName);
    if (channels.length !== 1) return clarification(`I could not identify one joined public Slack channel named #${slackSend.channelName}. Invite the CrazyLoops app to the channel or specify a different one. Nothing was sent.`);
    const channel = channels[0];
    const preview = ActionPreviewSchema.safeParse({
      version: 1,
      capabilityId: capability.id,
      connectorId: capability.connectorOperation.connectorId,
      operationKey: capability.connectorOperation.operationKey,
      operationVersion: capability.connectorOperation.operationVersion,
      connectionId: connection.id,
      actionTitle: `Post to #${channel.name} in Slack`,
      actionSummary: `Post the exact message to #${channel.name} in ${connection.external_account_label ?? "the selected Slack workspace"}.`,
      approvalReason: "Posting a Slack message is an external side effect and requires approval.",
      target: { kind: "external_resource", label: `#${channel.name}`, reference: channel.id },
      parameters: [parameter("channel", "Channel", channel.id), parameter("text", "Message", slackSend.text)],
    });
    if (!preview.success) return clarification("The Slack message cannot be safely prepared within approval limits. Shorten it or remove credential-like text. Nothing was sent.");
    return response(preview.data);
  }

  if (!/\b(?:create|add|save)\b[^.!?]*\bairtable\b/i.test(question)) return null;
  const capability = getCapability("airtable.create_record");
  if (!capability?.supported || !capability.availableInProduction || !capability.connectorOperation) return null;
  const base = question.match(/\bbase\s+(app[A-Za-z0-9]{5,})\b/i)?.[1];
  const table = question.match(/\btable\s+(tbl[A-Za-z0-9]{5,})\b/i)?.[1];
  const fieldsText = question.match(/\bfields?\s+(\{[\s\S]*\})\s*$/i)?.[1];
  if (!base || !table || !fieldsText) {
    return clarification("Which Airtable base ID, table ID, and exact JSON field values should CrazyLoops use? Nothing was created.");
  }
  let fields: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fieldsText) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    fields = parsed as Record<string, unknown>;
  } catch {
    return clarification("Provide the Airtable field values as one valid JSON object. Nothing was created.");
  }
  const fieldsJson = JSON.stringify(fields);
  if (fieldsJson.length > 500) return clarification("The Airtable field values are too large for one approval preview. Nothing was created.");
  const connection = await ownedConnection(scope, capability.connectorOperation.connectorId, capability.requiredScopes);
  if (!connection) return connectionRequired("Airtable");
  return response(ActionPreviewSchema.parse({
    version: 1,
    capabilityId: capability.id,
    connectorId: capability.connectorOperation.connectorId,
    operationKey: capability.connectorOperation.operationKey,
    operationVersion: capability.connectorOperation.operationVersion,
    connectionId: connection.id,
    actionTitle: "Create Airtable record",
    actionSummary: `Create one record in Airtable base ${base}, table ${table}.`,
    approvalReason: "Creating a provider record changes external data and requires approval.",
    target: { kind: "external_resource", label: `${base} / ${table}`, reference: `${base}/${table}` },
    parameters: [
      parameter("baseId", "Base ID", base),
      parameter("tableId", "Table ID", table),
      parameter("fields", "Fields", fieldsJson),
    ],
  }));
}
