import type { Database } from "@/lib/supabase/types";

type WorkItem = Database["public"]["Tables"]["work_items"]["Row"];
type Goal = Database["public"]["Tables"]["goals"]["Row"];

export type TeamWorkItem = Pick<WorkItem, "id" | "goal_id" | "assignee_user_id" | "title" | "status" |
  "status_reason" | "priority" | "due_at" | "updated_at" | "resolved_at">;
export type TeamGoal = Pick<Goal, "id" | "title" | "status" | "target_date" | "approved_plan_id">;

/** Name-targeted questions must never silently fall back to another employee. */
export function selectTeamWorkForQuestion(input: { question: string; work: readonly TeamWorkItem[];
  members: readonly { userId: string; label: string }[]; now?: Date }) {
  const question = input.question.toLowerCase();
  const named = /\b(?:is|was|did|has)\s+([a-z][a-z.'-]{1,40})\s+(?:blocked|complet(?:e|ed)|finished|done)\b/i.exec(input.question)?.[1]?.toLowerCase();
  const matches = named ? input.members.filter((member) => {
    const first = member.label.toLowerCase().split("@")[0].split(/[.\s_-]/)[0];
    return first.length > 2 && first === named;
  }) : [];
  if (named && matches.length !== 1) return { items: [] as TeamWorkItem[], needsEmployeeClarification: true, namedEmployee: null };
  let items = input.work.filter((item) => !named || item.assignee_user_id === matches[0].userId);
  if (/\bblocked\b/.test(question)) items = items.filter((item) => item.status === "blocked");
  if (/\b(?:complet(?:e|ed)|finished|done)\b/.test(question)) items = items.filter((item) => item.status === "done");
  if (/\byesterday\b/.test(question)) {
    const now = input.now ?? new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    items = items.filter((item) => item.resolved_at && Date.parse(item.resolved_at) >= todayUtc - 86_400_000
      && Date.parse(item.resolved_at) < todayUtc);
  }
  return { items, needsEmployeeClarification: false, namedEmployee: named ? matches[0].label : null };
}

const active = new Set<WorkItem["status"]>(["needs_you", "in_progress", "waiting", "blocked"]);
export function isActiveTeamWork(status: WorkItem["status"]): boolean { return active.has(status); }

/** Counts are derived solely from approved-plan Work Items, never model estimates. */
export function buildManagerBrief(input: { goals: readonly TeamGoal[]; work: readonly TeamWorkItem[];
  pendingApprovals: number; now?: Date }) {
  const now = input.now ?? new Date();
  const horizon = now.getTime() + 48 * 60 * 60 * 1000;
  const activeWork = input.work.filter((item) => isActiveTeamWork(item.status));
  const risk = activeWork.filter((item) => item.due_at && Date.parse(item.due_at) <= horizon);
  const goalRows = input.goals.map((goal) => {
    const items = input.work.filter((item) => item.goal_id === goal.id);
    const done = items.filter((item) => item.status === "done").length;
    const blocked = items.filter((item) => item.status === "blocked").length;
    const overdue = items.filter((item) => isActiveTeamWork(item.status)
      && item.due_at && Date.parse(item.due_at) < now.getTime()).length;
    return { goal, total: items.length, done, blocked, overdue,
      atRisk: blocked > 0 || overdue > 0 || (goal.target_date !== null
        && goal.status === "active" && Date.parse(`${goal.target_date}T23:59:59Z`) < now.getTime()) };
  });
  return {
    active: activeWork.length,
    completed: input.work.filter((item) => item.status === "done").length,
    blocked: activeWork.filter((item) => item.status === "blocked").length,
    overdue: activeWork.filter((item) => item.due_at && Date.parse(item.due_at) < now.getTime()).length,
    dueSoon: risk.length,
    decisions: input.pendingApprovals + activeWork.filter((item) => item.status === "blocked").length,
    goals: goalRows,
  };
}
