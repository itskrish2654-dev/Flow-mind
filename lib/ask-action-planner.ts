import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { ActionPreviewSchema, type ActionPreview } from "@/lib/action-execution-core";
import type { AskGroundedResponse } from "@/lib/ask-core";
import { getCapability } from "@/lib/capability-registry";
import { connectorConnectionIds } from "@/lib/connectors/connection-matching";
import { getConnector } from "@/lib/connectors/registry";
import { parseGmailSendIntent } from "@/lib/connectors/google/gmail-action-intent";
import type { Database } from "@/lib/supabase/types";

type Scope = { userId: string; workspaceId: string; supabase: SupabaseClient<Database> };

function acceptanceHarnessEnabled() {
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
      suggestedAction: { label: "Open Connections", href: "/dashboard/connections" },
    },
  };
}

function parameter(name: string, label: string, value: string) {
  return { name, label, value };
}

/** Deterministic allowlist. The model cannot name or construct executable capabilities. */
export async function planAskAction(scope: Scope, question: string): Promise<AskGroundedResponse | null> {
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
