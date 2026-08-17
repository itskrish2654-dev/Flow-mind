import "server-only";

import type { Json } from "@/lib/supabase/types";
import { createAdminClient } from "@/lib/supabase/admin";

export type ConnectionProvider = "google" | "slack" | "notion";

export type ConnectionView = {
  id: string;
  provider: ConnectionProvider;
  providerName: string;
  accountLabel: string;
  status: "connected" | "expired" | "error";
  lastCheckedAt: string;
  usedByWorkflows: number;
  permissionSummary: string;
};

const providerDetails: Record<ConnectionProvider, {
  name: string;
  fallbackLabel: string;
  permissionSummary: string;
}> = {
  slack: {
    name: "Slack",
    fallbackLabel: "Connected Slack workspace",
    permissionSummary: "Read selected public channel activity and send the messages you configure.",
  },
  notion: {
    name: "Notion",
    fallbackLabel: "Connected Notion workspace",
    permissionSummary: "Use only the pages and data sources shared with CrazyLoops.",
  },
  google: {
    name: "Google",
    fallbackLabel: "Connected Google account",
    permissionSummary: "Use approved Gmail permissions and spreadsheets explicitly selected through Google Picker.",
  },
};

function providerFrom(value: string): ConnectionProvider | null {
  return value === "slack" || value === "notion" || value === "google"
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
  const [{ data: rows, error }, { data: workflows }] = await Promise.all([
    admin
      .from("connector_connections")
      .select("id,provider_family,external_account_label,status,last_refreshed_at,updated_at")
      .eq("user_id", userId)
      .neq("status", "revoked")
      .order("created_at", { ascending: false }),
    admin
      .from("workflows")
      .select("id,current_version_id")
      .eq("user_id", userId),
  ]);

  if (error) throw new Error("Connections could not be loaded.");
  const versionIds = (workflows ?? [])
    .map((workflow) => workflow.current_version_id)
    .filter((id): id is string => Boolean(id));
  const versions = versionIds.length
    ? await admin.from("workflow_versions").select("id,compiled_workflow").in("id", versionIds)
    : { data: [] as Array<{ id: string; compiled_workflow: Json }> };
  const versionsById = new Map((versions.data ?? []).map((version) => [version.id, version.compiled_workflow]));
  const workflowCounts = new Map<string, number>();

  for (const workflow of workflows ?? []) {
    if (!workflow.current_version_id) continue;
    const connectionIds = new Set<string>();
    collectConnectionIds(versionsById.get(workflow.current_version_id), connectionIds);
    for (const connectionId of connectionIds) {
      workflowCounts.set(connectionId, (workflowCounts.get(connectionId) ?? 0) + 1);
    }
  }

  return (rows ?? []).flatMap((row) => {
    const provider = providerFrom(row.provider_family);
    if (!provider || row.status === "revoked") return [];
    const details = providerDetails[provider];
    const status = row.status === "connected"
      ? "connected"
      : row.status === "expired"
        ? "expired"
        : "error";
    return [{
      id: row.id,
      provider,
      providerName: details.name,
      accountLabel: safeAccountLabel(provider, row.external_account_label),
      status,
      lastCheckedAt: row.last_refreshed_at ?? row.updated_at,
      usedByWorkflows: workflowCounts.get(row.id) ?? 0,
      permissionSummary: details.permissionSummary,
    }];
  });
}
