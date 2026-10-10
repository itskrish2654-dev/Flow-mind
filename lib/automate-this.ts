import "server-only";

import { getAuthenticatedContext } from "@/lib/auth";
import { AUTOMATION_EVIDENCE_DAYS, detectRepeatedWork, isFollowUpWorkTitle, type RepeatedWorkEvidence } from "@/lib/automate-this-core";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

export type AutomationSuggestion = Database["public"]["Tables"]["automation_suggestions"]["Row"];

/** Reads only the signed-in employee's durable, completed work; no private AI scratch content is loaded. */
export async function listMyAutomationSuggestions(): Promise<AutomationSuggestion[] | null> {
  const auth = await getAuthenticatedContext();
  if (!auth) return null;
  const admin = createAdminClient();
  const since = new Date(Date.now() - AUTOMATION_EVIDENCE_DAYS * 86_400_000).toISOString();
  const [deliverables, handoffs] = await Promise.all([
    admin.from("work_item_deliverables").select("work_item_id,finalized_at")
      .eq("workspace_id", auth.workspace.id).eq("owner_user_id", auth.user.id)
      .eq("status", "final").eq("ai_assisted", true)
      .gte("finalized_at", since).order("finalized_at", { ascending: false }).limit(100),
    admin.from("automation_workbench_handoffs").select("work_item_id,ask_turn_id")
      .eq("workspace_id", auth.workspace.id).eq("owner_user_id", auth.user.id)
      .gte("created_at", since).order("created_at", { ascending: false }).limit(100),
  ]);
  if (deliverables.error || handoffs.error) throw new Error("Repeated work could not be checked safely.");
  const turnIds = handoffs.data.map((handoff) => handoff.ask_turn_id);
  const messages = turnIds.length ? await admin.from("ask_messages").select("id,turn_id")
    .eq("workspace_id", auth.workspace.id).eq("user_id", auth.user.id)
    .eq("role", "assistant").in("turn_id", turnIds).limit(100) : { data: [], error: null };
  if (messages.error) throw new Error("Gmail handoff provenance is unavailable.");
  const messageToWorkItem = new Map(messages.data.flatMap((message) => {
    const handoff = handoffs.data.find((row) => row.ask_turn_id === message.turn_id);
    return handoff ? [[message.id, handoff.work_item_id] as const] : [];
  }));
  const messageIds = [...messageToWorkItem.keys()];
  const actions = messageIds.length ? await admin.from("action_executions")
    .select("source_message_id,completed_at,capability_id")
    .eq("workspace_id", auth.workspace.id).eq("requester_user_id", auth.user.id)
    .eq("status", "succeeded").eq("acknowledged", true).eq("externally_delivered", true)
    .eq("capability_id", "gmail_send_email").in("source_message_id", messageIds)
    .gte("completed_at", since).limit(100) : { data: [], error: null };
  if (actions.error) throw new Error("Gmail send provenance is unavailable.");
  const ids = [...new Set([...deliverables.data.map((row) => row.work_item_id), ...handoffs.data.map((row) => row.work_item_id)])];
  const workItems = ids.length ? await admin.from("work_items")
    .select("id,workspace_id,assignee_user_id,title,source_type")
    .eq("workspace_id", auth.workspace.id).eq("assignee_user_id", auth.user.id)
    .in("id", ids).limit(200) : { data: [], error: null };
  if (workItems.error || workItems.data.length !== ids.length) throw new Error("Repeated work provenance is unavailable.");
  const byId = new Map(workItems.data.map((item) => [item.id, item]));
  const evidence: RepeatedWorkEvidence[] = [];
  for (const row of deliverables.data) {
    const item = byId.get(row.work_item_id);
    if (item && row.finalized_at) evidence.push({ workItemId: item.id,
      kind: "work_item_ai_result", sourceType: item.source_type,
      title: item.title, completedAt: row.finalized_at });
  }
  for (const row of actions.data) {
    const item = byId.get(messageToWorkItem.get(row.source_message_id ?? "") ?? "");
    if (item && row.completed_at && isFollowUpWorkTitle(item.title)) evidence.push({
      workItemId: item.id, kind: "gmail_follow_up", sourceType: item.source_type,
      title: item.title, completedAt: row.completed_at,
    });
  }
  const patterns = detectRepeatedWork(evidence);
  for (const pattern of patterns) {
    const { data: inserted, error } = await admin.from("automation_suggestions").insert({
      workspace_id: auth.workspace.id, owner_user_id: auth.user.id,
      pattern_key: pattern.key, pattern_kind: pattern.kind,
      source_type: pattern.sourceType as AutomationSuggestion["source_type"],
      source_title: pattern.title, evidence_count: pattern.count,
      evidence_item_ids: pattern.workItemIds,
      evidence_first_at: pattern.firstAt, evidence_last_at: pattern.lastAt,
    }).select("id").maybeSingle();
    if (error && error.code !== "23505") throw new Error("Automation suggestion could not be saved.");
    if (inserted) {
      const { error: activityError } = await admin.from("activity_events").insert({
        workspace_id: auth.workspace.id, owner_user_id: auth.user.id,
        actor_user_id: null, visibility: "private", event_type: "automation_suggested",
        source_type: "automation", source_id: inserted.id,
        event_key: `automation:suggested:${inserted.id}`,
      });
      if (activityError && activityError.code !== "23505") throw new Error("Suggestion Activity could not be saved.");
    } else {
      const { error: refreshError } = await admin.from("automation_suggestions").update({
        evidence_count: pattern.count, evidence_item_ids: pattern.workItemIds,
        evidence_last_at: pattern.lastAt, updated_at: new Date().toISOString(),
      }).eq("workspace_id", auth.workspace.id).eq("owner_user_id", auth.user.id)
        .eq("pattern_key", pattern.key).eq("status", "suggested");
      if (refreshError) throw new Error("Suggestion evidence could not be refreshed.");
    }
  }
  const { data, error } = await auth.supabase.from("automation_suggestions").select("*")
    .eq("workspace_id", auth.workspace.id).eq("owner_user_id", auth.user.id)
    .neq("status", "dismissed").order("updated_at", { ascending: false }).limit(30);
  if (error) throw new Error("Automation suggestions could not be loaded.");
  return data;
}
