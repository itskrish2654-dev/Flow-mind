import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { activityLabel } from "../lib/activity-core";
import { selectAskTools, runGroundedAsk, type AskToolResult } from "../lib/ask-core";
import { buildManagerBrief, selectTeamWorkForQuestion, type TeamGoal, type TeamWorkItem } from "../lib/manager-work-core";
import { buildMyDayData } from "../lib/my-day-model";
import { visibleGoalWorkReason } from "../lib/goals-core";
import { EmployeeWorkUpdateSchema, type WorkItem } from "../lib/work-items-core";

const workspace = "00000000-0000-4000-8000-000000000001";
const employee = "00000000-0000-4000-8000-000000000002";
const otherEmployee = "00000000-0000-4000-8000-000000000003";
const goalId = "00000000-0000-4000-8000-000000000004";
const now = new Date("2026-10-09T09:00:00Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

function item(n: number, overrides: Partial<WorkItem> = {}): WorkItem {
  return { id: uuid(n), workspace_id: workspace, assignee_user_id: employee,
    title: `Onboarding work ${n}`, summary: "Deliver the approved plan item.",
    why_it_matters: "The rollout needs this work.", suggested_action: "Review and finish.",
    status: "needs_you", status_reason: null, status_actor_user_id: null,
    priority: "normal", due_at: null, source_type: "internal", source_id: null,
    source_label: "Approved goal", dedupe_key: null, goal_id: goalId,
    goal_plan_item_id: uuid(n + 100), created_at: now.toISOString(),
    updated_at: now.toISOString(), resolved_at: null, ...overrides };
}

test("employee My Day partitions durable assigned work once and excludes other owners", () => {
  const data = buildMyDayData({ userId: employee, workspaceId: workspace, now,
    workflows: [], executions: [], connections: [], workItems: [
      item(10, { status: "in_progress" }),
      item(11, { due_at: "2026-10-13T12:00:00Z" }),
      item(12),
      item(13, { status: "waiting", status_reason: "Waiting for Finance" }),
      item(14, { status: "blocked", status_reason: "Needs Legal review" }),
      item(15, { status: "done", resolved_at: now.toISOString() }),
      item(16, { assignee_user_id: otherEmployee }),
      item(17, { workspace_id: uuid(99) }),
    ] });
  const sections = [data.needsYou, data.today, data.managerAssigned, data.deadlines,
    data.waitingOn, data.blocked, data.handledByCrazyLoops, data.completed];
  const ids = sections.flatMap((section) => section.flatMap((entry) => entry.workItem ? [entry.workItem.id] : []));
  assert.deepEqual(new Set(ids).size, ids.length);
  assert.equal(ids.length, 6);
  assert.equal(data.today.some((entry) => entry.workItem?.id === uuid(10)), true);
  assert.equal(data.deadlines.some((entry) => entry.workItem?.id === uuid(11)), true);
  assert.equal(data.managerAssigned.some((entry) => entry.workItem?.id === uuid(12)), true);
  assert.equal(data.blocked[0].workItem?.statusReason, "Needs Legal review");
  assert.equal(data.completed[0].workItem?.id, uuid(15));
  assert.ok(data.agenda.priorities.every((priority) => priority.href.startsWith("/my-day#work-item-")));
});

test("employee updates require a blocker reason and never accept handled", () => {
  assert.equal(EmployeeWorkUpdateSchema.safeParse({ id: uuid(10), to: "blocked" }).success, false);
  assert.equal(EmployeeWorkUpdateSchema.safeParse({ id: uuid(10), to: "blocked", reason: "Waiting for Legal" }).success, true);
  assert.equal(EmployeeWorkUpdateSchema.safeParse({ id: uuid(10), to: "handled" }).success, false);
  assert.equal(EmployeeWorkUpdateSchema.safeParse({ id: uuid(10), to: "done", workspaceId: workspace }).success, false);
});

test("manager brief counts real approved-plan work and never treats handled as goal completion", () => {
  const goals: TeamGoal[] = [{ id: goalId, title: "Launch onboarding", status: "active",
    target_date: "2026-10-15", approved_plan_id: uuid(50) }];
  const work: TeamWorkItem[] = [
    item(10, { status: "done", resolved_at: now.toISOString() }),
    item(11, { status: "blocked", status_reason: "Waiting for Legal", due_at: "2026-10-08T10:00:00Z" }),
    item(12, { status: "in_progress", due_at: "2026-10-10T10:00:00Z" }),
    item(13, { status: "handled", resolved_at: now.toISOString() }),
  ];
  const brief = buildManagerBrief({ goals, work, pendingApprovals: 1, now });
  assert.equal(brief.active, 2);
  assert.equal(brief.completed, 1);
  assert.equal(brief.blocked, 1);
  assert.equal(brief.overdue, 1);
  assert.equal(brief.decisions, 2);
  assert.deepEqual(brief.goals.map(({ total, done, blocked, overdue, atRisk }) =>
    ({ total, done, blocked, overdue, atRisk })),
  [{ total: 4, done: 1, blocked: 1, overdue: 1, atRisk: true }]);
});

test("manager Ask selects the named employee and real completion window without substituting team data", () => {
  const work: TeamWorkItem[] = [
    item(20, { status: "blocked", status_reason: "Needs Legal", assignee_user_id: employee }),
    item(21, { status: "blocked", status_reason: "Needs Finance", assignee_user_id: otherEmployee }),
    item(22, { status: "done", resolved_at: "2026-10-08T15:00:00Z" }),
    item(23, { status: "done", resolved_at: "2026-10-07T15:00:00Z" }),
  ];
  const members = [{ userId: employee, label: "rahul@example.test" },
    { userId: otherEmployee, label: "priya@example.test" }];
  const blocked = selectTeamWorkForQuestion({ question: "What is Rahul blocked on?", work, members, now });
  assert.deepEqual(blocked.items.map((entry) => entry.id), [uuid(20)]);
  const yesterday = selectTeamWorkForQuestion({ question: "What did the team complete yesterday?", work, members, now });
  assert.deepEqual(yesterday.items.map((entry) => entry.id), [uuid(22)]);
  const unknown = selectTeamWorkForQuestion({ question: "What is Ashwin blocked on?", work, members, now });
  assert.equal(unknown.needsEmployeeClarification, true);
  assert.deepEqual(unknown.items, []);
});

test("goal blocker explanations reach managers and the assigned employee, not other members", async () => {
  const input = { reason: "Needs Legal review", assigneeUserId: employee,
    viewerUserId: otherEmployee, canManage: false };
  assert.equal(visibleGoalWorkReason(input), null);
  assert.equal(visibleGoalWorkReason({ ...input, viewerUserId: employee }), "Needs Legal review");
  assert.equal(visibleGoalWorkReason({ ...input, canManage: true }), "Needs Legal review");
  const goalService = await readFile("lib/goals.ts", "utf8");
  const askService = await readFile("lib/ask-tools.ts", "utf8");
  assert.match(goalService, /status_reason: visibleGoalWorkReason/);
  assert.match(askService, /item\.workItem\?\.status_reason \? `, reason:/);
});

test("Ask routes own work and team work distinctly; member team access fails truthfully", async () => {
  assert.ok(selectAskTools("What should I focus on today?").includes("my_day"));
  assert.ok(selectAskTools("What is due this week?").includes("my_day"));
  assert.ok(selectAskTools("What did I complete yesterday?").includes("my_day"));
  assert.ok(selectAskTools("What did the team complete yesterday?").includes("team_work"));
  assert.ok(selectAskTools("What is Rahul blocked on?").includes("team_work"));
  assert.ok(!selectAskTools("What work did my manager assign me?").includes("team_work"));
  const response = await runGroundedAsk({ question: "What did the team complete yesterday?", history: [],
    loadTool: async (tool): Promise<AskToolResult> => ({ tool,
      ...(tool === "team_work" ? { availability: "not_available" as const } : {}),
      summary: "No company-wide access.", records: [] }),
    callModel: async () => { throw new Error("The model must not be called for denied team access."); },
  });
  assert.match(response.answer, /only to a manager/);
  assert.equal(response.metadata.references.length, 0);
});

test("Activity shared work labels are generic and never repeat employee reasons", () => {
  const event = { visibility: "workspace", source_type: "work_item", event_type: "work_item_blocked" } as Parameters<typeof activityLabel>[0];
  assert.equal(activityLabel(event), "Company work is blocked");
});

test("migration preserves service-only mutation, workspace membership and generic manager Activity", async () => {
  const sql = await readFile("supabase/migrations/20261009000100_work_os_manager_employee_loop.sql", "utf8");
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;\s*$/);
  assert.match(sql, /for update/);
  assert.match(sql, /updated_at is distinct from p_expected_updated_at/);
  assert.match(sql, /v_item\.goal_id is distinct from p_goal_id/);
  assert.match(sql, /add column status_reason text;/);
  assert.match(sql, /add constraint work_items_status_reason_length_check/);
  assert.match(sql, /add constraint work_items_status_reason_check/);
  assert.match(sql, /manager\.role in \('owner', 'admin'\)/);
  assert.match(sql, /m\.role in \('owner', 'admin'\)/);
  assert.match(sql, /m\.user_id = p_assignee_user_id and m\.is_default/);
  assert.match(sql, /grant execute on function public\.revise_goal_work_assignment[\s\S]*?to service_role/);
  assert.doesNotMatch(sql, /grant (?:execute|update) [\s\S]*? to authenticated;/i);
  assert.match(sql, /visibility = 'private' and owner_user_id = \(select auth\.uid\(\)\)/);
  assert.match(sql, /visibility = 'workspace' and source_type = 'work_item'/);
  assert.doesNotMatch(sql, /new\.status_reason|new\.title|new\.summary/);
});

test("manager service is role- and workspace-scoped and reads no employee-private source", async () => {
  const service = await readFile("lib/manager-work.ts", "utf8");
  assert.match(service, /auth\.membership\.role === "member"/);
  assert.match(service, /\.eq\("workspace_id", auth\.workspace\.id\)/);
  assert.match(service, /\.not\("goal_id", "is", null\)/);
  assert.doesNotMatch(service, /ask_threads|ask_messages|gmail|slack|connector_connections|workflow_executions/);
  const route = await readFile("app/manager/page.tsx", "utf8");
  assert.match(route, /if \(!board\) notFound\(\)/);
});

test("manager reviews proposal rationale, owner-role hint and exact assignments before approval", async () => {
  const manager = await readFile("components/goals/goal-manager.tsx", "utf8");
  const detail = await readFile("app/goals/[goalId]/page.tsx", "utf8");
  assert.match(manager, /Why this work is proposed/);
  assert.match(manager, /Suggested owner role/);
  assert.match(manager, /Approve and create work/);
  assert.match(manager, /items\.some\(\(item\) => !item\.assignee_user_id\)/);
  assert.match(detail, /Why this work:/);
  assert.match(detail, /Suggested role:/);
});
