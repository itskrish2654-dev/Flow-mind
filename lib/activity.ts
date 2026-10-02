import "server-only";

import { getAuthenticatedContext } from "@/lib/auth";
import { ApprovalActionSnapshotSchema } from "@/lib/approvals-core";
import {
  ACTIVITY_FILTER_TYPES,
  ACTIVITY_PAGE_SIZE,
  type ActivityEvent,
  type ActivityFilter,
} from "@/lib/activity-core";

export type ActivityPage = { events: ActivityEvent[]; nextCursor: number | null };
export type ActivityDetail = {
  event: ActivityEvent;
  trail: ActivityEvent[];
  title: string | null;
  summary: string | null;
  approval: {
    status: string; requestedAt: string; requestedByYou: boolean;
    decidedAt: string | null; decidedByYou: boolean;
    target: string | null; parameters: { label: string; value: string }[];
  } | null;
  action: {
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    acknowledged: boolean;
    externallyDelivered: boolean;
    resultSummary: string | null;
    failureCategory: string | null;
  } | null;
  workItemStatus: string | null;
};

export async function listCurrentWorkspaceActivity(
  filter: ActivityFilter, cursor: number | null, eventTypes?: string[],
): Promise<ActivityPage | null> {
  const auth = await getAuthenticatedContext();
  if (!auth) return null;
  let query = auth.supabase.from("activity_events").select("*")
    .eq("workspace_id", auth.workspace.id)
    .order("id", { ascending: false })
    .limit(ACTIVITY_PAGE_SIZE + 1);
  if (cursor !== null) query = query.lt("id", cursor);
  if (eventTypes?.length) query = query.in("event_type", eventTypes);
  else if (filter !== "all") query = query.in("event_type", ACTIVITY_FILTER_TYPES[filter]);
  const { data, error } = await query;
  if (error) throw new Error("Activity could not be loaded.");
  const events = data.slice(0, ACTIVITY_PAGE_SIZE);
  return { events, nextCursor: data.length > ACTIVITY_PAGE_SIZE ? events.at(-1)?.id ?? null : null };
}

/** Details are loaded only for the private owner; shared events stay generic. */
export async function getCurrentWorkspaceActivityDetail(id: number): Promise<ActivityDetail | null> {
  const auth = await getAuthenticatedContext();
  if (!auth) return null;
  const { data: event, error } = await auth.supabase.from("activity_events").select("*")
    .eq("id", id).eq("workspace_id", auth.workspace.id).maybeSingle();
  if (error || !event) return null;
  const detail: ActivityDetail = {
    event, trail: [event], title: null, summary: null, approval: null, action: null, workItemStatus: null,
  };
  if (event.visibility !== "private" || event.owner_user_id !== auth.user.id) return detail;

  const trailQueries = [
    event.work_item_id ? auth.supabase.from("activity_events").select("*")
      .eq("workspace_id", auth.workspace.id).eq("owner_user_id", auth.user.id)
      .eq("visibility", "private").eq("work_item_id", event.work_item_id).order("id").limit(30) : null,
    event.approval_request_id ? auth.supabase.from("activity_events").select("*")
      .eq("workspace_id", auth.workspace.id).eq("owner_user_id", auth.user.id)
      .eq("visibility", "private").eq("approval_request_id", event.approval_request_id).order("id").limit(30) : null,
    event.action_execution_id ? auth.supabase.from("activity_events").select("*")
      .eq("workspace_id", auth.workspace.id).eq("owner_user_id", auth.user.id)
      .eq("visibility", "private").eq("action_execution_id", event.action_execution_id).order("id").limit(30) : null,
  ].filter((query) => query !== null);
  if (trailQueries.length) {
    const results = await Promise.all(trailQueries);
    if (results.some((result) => result.error)) throw new Error("Activity history could not be loaded.");
    detail.trail = [...new Map(results.flatMap((result) => result.data ?? []).map((entry) => [entry.id, entry])).values()]
      .sort((a, b) => a.id - b.id).slice(-50);
  }

  if (event.work_item_id) {
    const { data: item, error: itemError } = await auth.supabase.from("work_items")
      .select("title,summary,status")
      .eq("id", event.work_item_id).eq("workspace_id", auth.workspace.id)
      .eq("assignee_user_id", auth.user.id).maybeSingle();
    if (itemError) throw new Error("Activity details could not be loaded.");
    detail.title = item?.title ?? null;
    detail.summary = item?.summary ?? null;
    detail.workItemStatus = item?.status ?? null;
  }
  if (event.approval_request_id) {
    const { data: approval, error: approvalError } = await auth.supabase.from("approval_requests")
      .select("action_title,action_summary,action_snapshot,status,created_at,requested_by_user_id,decided_at,decided_by_user_id")
      .eq("id", event.approval_request_id).eq("workspace_id", auth.workspace.id)
      .eq("approver_user_id", auth.user.id).maybeSingle();
    if (approvalError) throw new Error("Activity details could not be loaded.");
    if (approval) {
      const snapshot = ApprovalActionSnapshotSchema.safeParse(approval.action_snapshot);
      detail.title = approval.action_title;
      detail.summary = approval.action_summary;
      detail.approval = {
        status: approval.status, requestedAt: approval.created_at,
        requestedByYou: approval.requested_by_user_id === auth.user.id,
        decidedAt: approval.decided_at, decidedByYou: approval.decided_by_user_id === auth.user.id,
        target: snapshot.success ? snapshot.data.target.label : null,
        parameters: snapshot.success
          ? snapshot.data.parameters.map(({ label, value }) => ({ label, value })) : [],
      };
    }
  }
  if (event.action_execution_id) {
    const { data: action, error: actionError } = await auth.supabase.from("action_executions")
      .select("status,claimed_at,completed_at,acknowledged,externally_delivered,result_summary,failure_category")
      .eq("id", event.action_execution_id).eq("workspace_id", auth.workspace.id)
      .eq("requester_user_id", auth.user.id).maybeSingle();
    if (actionError) throw new Error("Activity details could not be loaded.");
    if (action) detail.action = {
      status: action.status, startedAt: action.claimed_at, completedAt: action.completed_at,
      acknowledged: action.acknowledged, externallyDelivered: action.externally_delivered,
      resultSummary: action.result_summary, failureCategory: action.failure_category,
    };
  }
  if (event.workflow_id) {
    const { data: workflow, error: workflowError } = await auth.supabase.from("workflows")
      .select("name").eq("id", event.workflow_id).eq("workspace_id", auth.workspace.id)
      .eq("user_id", auth.user.id).maybeSingle();
    if (workflowError) throw new Error("Activity details could not be loaded.");
    detail.title = workflow?.name ?? null;
  }
  return detail;
}
