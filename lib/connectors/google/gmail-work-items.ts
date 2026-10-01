import "server-only";

import type { GmailReadMessage } from "@/lib/connectors/google/gmail-read";
import { classifyGmailWork, gmailWorkItemDedupeKey } from "@/lib/connectors/google/gmail-work-items-core";
import { createAdminClient } from "@/lib/supabase/admin";

function bounded(value: string, maximum: number) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

export async function createGmailWorkItem(input: {
  userId: string;
  workspaceId: string;
  connectionId: string;
  message: GmailReadMessage;
}) {
  if (classifyGmailWork(input.message) !== "ACTIONABLE") return { created: false, reason: "not_actionable" as const };
  const admin = createAdminClient();
  const [{ data: membership }, { data: connection }] = await Promise.all([
    admin.from("workspace_memberships").select("user_id").eq("workspace_id", input.workspaceId).eq("user_id", input.userId).maybeSingle(),
    admin.from("connector_connections").select("id").eq("id", input.connectionId).eq("workspace_id", input.workspaceId)
      .eq("user_id", input.userId).eq("provider_family", "google").eq("status", "connected").maybeSingle(),
  ]);
  if (!membership || !connection) throw new Error("Gmail work ownership is no longer valid.");
  const dedupeKey = gmailWorkItemDedupeKey(input.message.threadId, input.message.id);
  const existing = await admin.from("work_items").select("id")
    .eq("workspace_id", input.workspaceId).eq("assignee_user_id", input.userId)
    .eq("source_type", "connector_event").eq("source_id", input.connectionId)
    .eq("dedupe_key", dedupeKey).maybeSingle();
  if (existing.error) throw new Error("Gmail Work Item dedupe could not be checked.");
  if (existing.data) return { created: false, reason: "duplicate" as const, id: existing.data.id };
  const title = bounded(input.message.subject || `Email from ${input.message.from}`, 180) || "Gmail message needs your attention";
  const summary = bounded(input.message.text || `Message from ${input.message.from}`, 1_000);
  const { data, error } = await admin.from("work_items").insert({
    workspace_id: input.workspaceId,
    assignee_user_id: input.userId,
    title,
    summary: summary || null,
    why_it_matters: "This Gmail message contains an explicit request or decision signal.",
    suggested_action: "Review the email and decide whether to reply.",
    status: "needs_you",
    priority: "normal",
    source_type: "connector_event",
    source_id: input.connectionId,
    source_label: "Gmail",
    dedupe_key: dedupeKey,
  }).select("id").single();
  if (error) {
    if (error.code === "23505") return { created: false, reason: "duplicate" as const };
    throw new Error("Gmail Work Item could not be created.");
  }
  return { created: true, id: data.id };
}
