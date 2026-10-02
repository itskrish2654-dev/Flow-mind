import type { Database } from "@/lib/supabase/types";

export type ActivityEvent = Database["public"]["Tables"]["activity_events"]["Row"];
export type ActivityFilter = "all" | "attention" | "approvals" | "actions" | "workflows";

export const ACTIVITY_PAGE_SIZE = 20;

export function activityEventTypesForQuestion(question: string): string[] | undefined {
  const intent = question.toLowerCase();
  if (/\b(?:uncertain|ambiguous)\b/.test(intent)) return ["action_ambiguous"];
  if (/\b(?:failed|failure)\b.{0,32}\bactions?\b|\bactions?\b.{0,32}\b(?:failed|failure)\b/.test(intent)) {
    return ["action_failed"];
  }
  return undefined;
}

export const ACTIVITY_FILTER_TYPES: Record<Exclude<ActivityFilter, "all">, string[]> = {
  attention: ["work_item_created", "work_item_needs_you", "work_item_waiting", "approval_requested", "action_failed", "action_ambiguous"],
  approvals: ["approval_requested", "approval_approved", "approval_rejected", "approval_cancelled"],
  actions: ["action_proposed", "action_queued", "action_executing", "action_succeeded", "action_failed", "action_ambiguous", "action_rejected", "action_cancelled"],
  workflows: ["workflow_succeeded", "workflow_failed"],
};

export function parseActivityFilter(value: unknown): ActivityFilter {
  return value === "attention" || value === "approvals" || value === "actions" || value === "workflows" ? value : "all";
}

export function parseActivityCursor(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d{0,14}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function activityLabel(event: ActivityEvent): string {
  if (event.visibility === "workspace") {
    if (event.event_type === "action_succeeded") return "A teammate's approved action completed";
    if (event.event_type === "action_ambiguous") return "A teammate's action outcome is uncertain";
    return "A teammate's approved action failed";
  }
  const labels: Record<string, string> = {
    work_item_created: "Work item created",
    work_item_needs_you: "Work returned for your review",
    work_item_waiting: "Work is waiting",
    work_item_handled: "CrazyLoops handled this work",
    work_item_done: "You marked work done",
    approval_requested: "Approval requested",
    approval_approved: "You approved an action",
    approval_rejected: "You rejected an action",
    approval_cancelled: "Approval cancelled",
    action_proposed: "Action prepared for approval",
    action_queued: "Approved action queued",
    action_executing: "CrazyLoops started the approved action",
    action_succeeded: "Provider confirmed the approved action",
    action_failed: "The approved action failed",
    action_ambiguous: "Action outcome could not be confirmed",
    action_rejected: "Proposed action rejected",
    action_cancelled: "Proposed action cancelled",
    workflow_succeeded: "Workflow completed",
    workflow_failed: "Workflow did not complete",
  };
  return labels[event.event_type] ?? "CrazyLoops activity";
}

export function activityOutcome(event: ActivityEvent): string {
  if (event.event_type === "work_item_created") return "Created";
  if (event.event_type === "approval_cancelled" || event.event_type === "action_cancelled") return "Cancelled";
  if (event.event_type === "action_ambiguous") return "Outcome uncertain";
  if (event.event_type.endsWith("_failed")) return "Failed";
  if (event.event_type.endsWith("_succeeded") || event.event_type === "work_item_handled" || event.event_type === "work_item_done") return "Completed";
  if (event.event_type === "approval_approved") return "Approved, not yet delivered";
  if (event.event_type.endsWith("_rejected")) return "Rejected";
  if (event.event_type === "action_executing") return "Running";
  if (event.event_type === "work_item_waiting" || event.event_type === "action_queued") return "Waiting";
  return "Needs attention";
}

export function activitySourceHref(event: ActivityEvent): string | null {
  if (event.visibility !== "private") return null;
  if (event.work_item_id) return `/my-day#work-item-${event.work_item_id}`;
  if (event.workflow_id) return `/dashboard/projects/${event.workflow_id}`;
  return null;
}
