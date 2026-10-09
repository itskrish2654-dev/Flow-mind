import "server-only";

import { getAuthenticatedContext } from "@/lib/auth";
import { listGoalMembers } from "@/lib/goals";
import { buildManagerBrief, type TeamGoal, type TeamWorkItem } from "@/lib/manager-work-core";
import { createAdminClient } from "@/lib/supabase/admin";

const MAX_GOALS = 50;
const MAX_WORK = 600;

export async function loadManagerCockpit() {
  const auth = await getAuthenticatedContext();
  if (!auth) return null;
  if (auth.membership.role === "member") return null;
  const admin = createAdminClient();
  const [goalResult, workResult, approvalResult, members] = await Promise.all([
    admin.from("goals").select("id,title,status,target_date,approved_plan_id")
      .eq("workspace_id", auth.workspace.id).order("created_at", { ascending: false }).limit(MAX_GOALS + 1),
    admin.from("work_items").select("id,goal_id,assignee_user_id,title,status,status_reason,priority,due_at,updated_at,resolved_at")
      .eq("workspace_id", auth.workspace.id).not("goal_id", "is", null)
      .order("updated_at", { ascending: false }).limit(MAX_WORK + 1),
    admin.from("approval_requests").select("id")
      .eq("workspace_id", auth.workspace.id).eq("approver_user_id", auth.user.id)
      .eq("status", "pending").limit(51),
    listGoalMembers(),
  ]);
  if (goalResult.error || workResult.error || approvalResult.error || !goalResult.data
    || !workResult.data || !approvalResult.data || goalResult.data.length > MAX_GOALS
    || workResult.data.length > MAX_WORK || approvalResult.data.length > 50) {
    throw new Error("The full company work view could not be loaded safely.");
  }
  const goals = goalResult.data as TeamGoal[];
  const work = workResult.data as TeamWorkItem[];
  return { brief: buildManagerBrief({ goals, work, pendingApprovals: approvalResult.data.length }),
    work, members, workspaceId: auth.workspace.id, actorUserId: auth.user.id };
}
