import "server-only";

import type { Json } from "@/lib/supabase/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveTrustedWorkspaceMembership } from "@/lib/workspace-context";
import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";

export type ConnectionProvider = "airtable" | "google" | "slack" | "notion" | "hubspot";

export type ConnectionView = {
  id: string;
  provider: ConnectionProvider;
  providerName: string;
  accountLabel: string;
  status: "connected" | "expired" | "error";
  lastCheckedAt: string;
  usedByWorkflows: number;
  permissionSummary: string;
  verification: "provider_verified" | "locally_configured";
  gmailIntakeStatus?: "active" | "setting_up" | "needs_attention";
  sheetsAccess?: boolean;
  calendarAccess?: boolean;
};

const providerDetails: Record<ConnectionProvider, {
  name: string;
  fallbackLabel: string;
  permissionSummary: string;
}> = {
  slack: {
    name: "Slack",
    fallbackLabel: "Connected Slack workspace",
    permissionSummary: "Capture new messages from joined public channels. Send exact approved messages to joined public channels. No historical channel crawl.",
  },
  notion: {
    name: "Notion",
    fallbackLabel: "Connected Notion workspace",
    permissionSummary: "Use only the pages and data sources shared with CrazyLoops.",
  },
  google: {
    name: "Google",
    fallbackLabel: "Connected Google account",
    permissionSummary: "Use only the Google permissions granted to this account.",
  },
  airtable: {
    name: "Airtable",
    fallbackLabel: "Airtable connection",
    permissionSummary: "Create records using the personal access token you saved. CrazyLoops does not verify the token until an Airtable action runs.",
  },
  hubspot: {
    name: "HubSpot",
    fallbackLabel: "Connected HubSpot account",
    permissionSummary: "Read only the contact and properties explicitly selected for a TEST run.",
  },
};

function providerFrom(value: string): ConnectionProvider | null {
  return value === "airtable" || value === "slack" || value === "notion" || value === "google" || value === "hubspot"
    ? value
    : null;
}

function safeAccountLabel(provider: ConnectionProvider, value: string | null): string {
  const details = providerDetails[provider];
  const label = value?.trim();
  if (!label) return details.fallbackLabel;
  if (provider === "slack" && /^T[A-Z0-9]{8,}$/i.test(label)) return details.fallbackLabel;
  if (provider === "notion" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(label)) return details.fallbackLabel;
  if (provider === "google" && !label.includes("@")) return details.fallbackLabel;
  if (provider === "airtable") return details.fallbackLabel;
  return label;
}

function collectConnectionIds(value: unknown, result: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectConnectionIds(item, result);
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key === "connectionId" && typeof nested === "string") result.add(nested);
    else collectConnectionIds(nested, result);
  }
}

export async function listConnectionViews(userId: string): Promise<ConnectionView[]> {
  const admin = createAdminClient();
  const membership = await resolveTrustedWorkspaceMembership(userId);
  const [{ data: rows, error }, { data: workflows }] = await Promise.all([
    admin
      .from("connector_connections")
      .select("id,provider_family,external_account_label,status,granted_scopes,last_error_category,last_refreshed_at,updated_at")
      .eq("user_id", userId)
      .eq("workspace_id", membership.workspaceId)
      .neq("status", "revoked")
      .order("created_at", { ascending: false }),
    admin
      .from("workflows")
      .select("id,current_version_id,published_version_id")
      .eq("user_id", userId)
      .eq("workspace_id", membership.workspaceId),
  ]);

  if (error) throw new Error("Connections could not be loaded.");
  const gmailConnectionIds = (rows ?? []).filter((row) => row.provider_family === "google").map((row) => row.id);
  const intakeResult = gmailConnectionIds.length
    ? await admin.from("gmail_ingestion_states")
        .select("connection_id,status,last_error_category,poll_error_category")
        .eq("user_id", userId).in("connection_id", gmailConnectionIds)
    : { data: [], error: null };
  if (intakeResult.error) throw new Error("Gmail intake health could not be loaded.");
  const intakeByConnection = new Map((intakeResult.data ?? []).map((state) => [state.connection_id, state]));
  const versionIds = (workflows ?? [])
    .flatMap((workflow) => [workflow.current_version_id, workflow.published_version_id])
    .filter((id): id is string => Boolean(id));
  const versions = versionIds.length
    ? await admin.from("workflow_versions").select("id,compiled_workflow").in("id", versionIds)
    : { data: [] as Array<{ id: string; compiled_workflow: Json }> };
  const versionsById = new Map((versions.data ?? []).map((version) => [version.id, version.compiled_workflow]));
  const workflowCounts = new Map<string, number>();

  for (const workflow of workflows ?? []) {
    const connectionIds = new Set<string>();
    if (workflow.current_version_id) {
      collectConnectionIds(versionsById.get(workflow.current_version_id), connectionIds);
    }
    if (workflow.published_version_id) {
      collectConnectionIds(versionsById.get(workflow.published_version_id), connectionIds);
    }
    for (const connectionId of connectionIds) {
      workflowCounts.set(connectionId, (workflowCounts.get(connectionId) ?? 0) + 1);
    }
  }

  return (rows ?? []).flatMap((row) => {
    const provider = providerFrom(row.provider_family);
    if (!provider || row.status === "revoked") return [];
    const details = providerDetails[provider];
    const gmailRead = provider === "google" && row.granted_scopes.includes(GOOGLE_SCOPES.gmailReadonly);
    const gmailSend = provider === "google" && row.granted_scopes.includes(GOOGLE_SCOPES.gmailSend);
    const sheets = provider === "google" && row.granted_scopes.includes(GOOGLE_SCOPES.driveFile);
    const calendar = provider === "google" && row.granted_scopes.includes(GOOGLE_SCOPES.calendarEventsOwned);
    const status = row.status === "connected"
      ? "connected"
      : row.status === "expired"
        ? "expired"
        : "error";
    return [{
      id: row.id,
      provider,
      providerName: provider === "google" ? gmailRead || gmailSend ? "Gmail" : sheets ? "Google Sheets" : calendar ? "Google Calendar" : "Google" : details.name,
      accountLabel: safeAccountLabel(provider, row.external_account_label),
      status,
      lastCheckedAt: row.last_refreshed_at ?? row.updated_at,
      usedByWorkflows: workflowCounts.get(row.id) ?? 0,
      permissionSummary: provider === "google"
        ? [gmailRead ? "Read the connected mailbox." : "", gmailSend ? "Send exact approved emails." : "",
          sheets ? "Use spreadsheets explicitly selected through Google Picker." : "",
          calendar ? "Read and change events on the owned primary calendar only after approval." : ""].filter(Boolean).join(" ")
          || "This Google account needs permission review before use."
        : details.permissionSummary,
      verification: provider === "airtable" ? "locally_configured" : "provider_verified",
      ...(sheets ? { sheetsAccess: true } : {}),
      ...(calendar ? { calendarAccess: true } : {}),
      ...(provider === "google" && gmailRead ? {
        gmailIntakeStatus: row.last_error_category === "gmail_intake_setup"
          ? "needs_attention" as const
          : !intakeByConnection.has(row.id) ? "setting_up" as const
          : ["resync_required", "reconnect_required"].includes(intakeByConnection.get(row.id)?.status ?? "")
            || intakeByConnection.get(row.id)?.last_error_category
            || intakeByConnection.get(row.id)?.poll_error_category
            ? "needs_attention" as const : "active" as const,
      } : {}),
    }];
  });
}
