import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";

import { getAuthenticatedContext } from "@/lib/auth";
import { deriveGoalProgress, GoalDraftEditSchema, GoalDraftSchema, GoalPlanEditSchema,
  GOAL_LIMITS, type GoalWorkState } from "@/lib/goals-core";
import { proposeGoalPlanWithModel } from "@/lib/goals-planning";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types";

type Goal = Database["public"]["Tables"]["goals"]["Row"];
type Plan = Database["public"]["Tables"]["goal_plans"]["Row"];
type PlanItem = Database["public"]["Tables"]["goal_plan_items"]["Row"];
type WorkItem = Database["public"]["Tables"]["work_items"]["Row"];
type Auth = NonNullable<Awaited<ReturnType<typeof getAuthenticatedContext>>>;

export type GoalMember = { userId: string; role: "owner" | "admin" | "member"; label: string };

async function goalsContext(manage = false): Promise<Auth> {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Sign in to access goals.");
  const { data, error } = await createAdminClient().from("workspace_memberships")
    .select("role").eq("workspace_id", auth.workspace.id).eq("user_id", auth.user.id)
    .eq("is_default", true).maybeSingle();
  if (error || !data || (manage && data.role === "member")) {
    throw new Error("Goals are unavailable to this account.");
  }
  return auth;
}

async function assertAssignee(workspaceId: string, userId: string) {
  const { data, error } = await createAdminClient().from("workspace_memberships")
    .select("user_id").eq("workspace_id", workspaceId).eq("user_id", userId)
    .eq("is_default", true).maybeSingle();
  if (error || !data) throw new Error("Choose a current member of this workspace.");
}

export async function listGoalMembers(): Promise<GoalMember[]> {
  const auth = await goalsContext();
  const admin = createAdminClient();
  const { data, error } = await admin.from("workspace_memberships")
    .select("user_id,role").eq("workspace_id", auth.workspace.id)
    .eq("is_default", true).order("created_at").limit(100);
  if (error || !data) throw new Error("Workspace members could not be loaded.");
  return Promise.all(data.map(async (member) => {
    const { data: account } = await admin.auth.admin.getUserById(member.user_id);
    const email = account.user?.email;
    return { userId: member.user_id, role: member.role,
      label: email ? email.slice(0, 120) : member.user_id === auth.user.id ? "You" : "Workspace member" };
  }));
}

async function progressForGoals(workspaceId: string, goals: readonly Goal[]) {
  const ids = goals.filter((goal) => goal.approved_plan_id).map((goal) => goal.id);
  const planIds = goals.map((goal) => goal.approved_plan_id).filter((id): id is string => Boolean(id));
  if (!ids.length) return new Map<string, ReturnType<typeof deriveGoalProgress>>();
  const admin = createAdminClient();
  const [{ data: items, error: itemError }, { data: work, error: workError }] = await Promise.all([
    admin.from("goal_plan_items").select("id,goal_id,plan_id").eq("workspace_id", workspaceId)
      .in("plan_id", planIds).limit(GOAL_LIMITS.list * GOAL_LIMITS.items),
    admin.from("work_items").select("goal_id,goal_plan_item_id,status,due_at")
      .eq("workspace_id", workspaceId).in("goal_id", ids).limit(GOAL_LIMITS.list * GOAL_LIMITS.items),
  ]);
  if (itemError || workError || !items || !work) throw new Error("Goal progress could not be loaded.");
  const workByItem = new Map(work.filter((entry) => entry.goal_plan_item_id)
    .map((entry) => [entry.goal_plan_item_id, { status: entry.status, dueAt: entry.due_at } as GoalWorkState]));
  const progress = new Map<string, ReturnType<typeof deriveGoalProgress>>();
  for (const goal of goals) {
    if (!goal.approved_plan_id) continue;
    const planItems = items.filter((item) => item.goal_id === goal.id && item.plan_id === goal.approved_plan_id);
    progress.set(goal.id, deriveGoalProgress(planItems.map((item) => workByItem.get(item.id) ?? null)));
  }
  return progress;
}

export async function listWorkspaceGoals() {
  const auth = await goalsContext();
  const { data, error } = await auth.supabase.from("goals").select("*")
    .eq("workspace_id", auth.workspace.id).order("created_at", { ascending: false })
    .limit(GOAL_LIMITS.list);
  if (error || !data) throw new Error("Goals could not be loaded.");
  const progress = await progressForGoals(auth.workspace.id, data);
  return { goals: data.map((goal) => ({ ...goal, progress: progress.get(goal.id) ?? null })),
    canManage: auth.membership.role !== "member" };
}

export async function getWorkspaceGoal(goalId: string) {
  const id = z.uuid().safeParse(goalId);
  if (!id.success) return null;
  const auth = await goalsContext();
  const { data: goal, error } = await auth.supabase.from("goals").select("*")
    .eq("workspace_id", auth.workspace.id).eq("id", id.data).maybeSingle();
  if (error || !goal) return null;
  const admin = createAdminClient();
  const [{ data: plan, error: planError }, { data: revisions, error: revisionError },
    { data: members, error: memberError }, { data: events, error: eventError }] = await Promise.all([
    goal.current_plan_id ? auth.supabase.from("goal_plans").select("*")
      .eq("workspace_id", auth.workspace.id).eq("goal_id", goal.id)
      .eq("id", goal.current_plan_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    auth.supabase.from("goal_plans").select("id,revision,status,created_at,approved_at")
      .eq("workspace_id", auth.workspace.id).eq("goal_id", goal.id)
      .order("revision", { ascending: false }).limit(20),
    admin.from("workspace_memberships").select("user_id,role")
      .eq("workspace_id", auth.workspace.id).eq("is_default", true).limit(100),
    auth.supabase.from("activity_events").select("*")
      .eq("workspace_id", auth.workspace.id).eq("goal_id", goal.id)
      .order("id", { ascending: false }).limit(15),
  ]);
  if (planError || revisionError || memberError || eventError || !revisions || !members || !events) {
    throw new Error("Goal details could not be loaded.");
  }
  let items: PlanItem[] = [];
  let work: Pick<WorkItem, "id" | "goal_plan_item_id" | "assignee_user_id" | "status" | "due_at" | "resolved_at">[] = [];
  if (plan) {
    const [{ data: loadedItems, error: itemError }, { data: loadedWork, error: workError }] = await Promise.all([
      auth.supabase.from("goal_plan_items").select("*")
        .eq("workspace_id", auth.workspace.id).eq("plan_id", plan.id)
        .order("position").limit(GOAL_LIMITS.items),
      admin.from("work_items").select("id,goal_plan_item_id,assignee_user_id,status,due_at,resolved_at")
        .eq("workspace_id", auth.workspace.id).eq("goal_id", goal.id).limit(GOAL_LIMITS.items),
    ]);
    if (itemError || workError || !loadedItems || !loadedWork) throw new Error("Goal work could not be loaded.");
    items = loadedItems; work = loadedWork;
  }
  const workByItem = new Map(work.map((item) => [item.goal_plan_item_id, item]));
  const progress = plan?.status === "approved"
    ? deriveGoalProgress(items.map((item) => {
      const current = workByItem.get(item.id);
      return current ? { status: current.status, dueAt: current.due_at } : null;
    })) : null;
  return { goal, plan: plan as Plan | null, revisions, items: items.map((item) => ({
    ...item, workItem: workByItem.get(item.id) ?? null,
  })), progress, events,
    members: members.map((member) => ({ userId: member.user_id, role: member.role })),
    canManage: auth.membership.role !== "member", currentUserId: auth.user.id };
}

export async function createGoalDraft(input: unknown): Promise<Goal> {
  const value = GoalDraftSchema.parse(input);
  const auth = await goalsContext(true);
  await assertAssignee(auth.workspace.id, value.ownerUserId);
  const payload = { title: value.title, description: value.description ?? null,
    successCriteria: value.successCriteria ?? null, targetDate: value.targetDate ?? null,
    ownerUserId: value.ownerUserId };
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const admin = createAdminClient();
  const { data, error } = await admin.from("goals").insert({
    workspace_id: auth.workspace.id, created_by_user_id: auth.user.id,
    last_actor_user_id: auth.user.id,
    owner_user_id: value.ownerUserId, request_key: value.requestId, request_hash: hash,
    title: value.title, description: value.description || null,
    success_criteria: value.successCriteria || null, target_date: value.targetDate ?? null,
  }).select("*").single();
  if (!error && data) return data;
  if (error?.code !== "23505") throw new Error("Goal draft could not be saved.");
  const { data: existing, error: existingError } = await admin.from("goals").select("*")
    .eq("workspace_id", auth.workspace.id).eq("created_by_user_id", auth.user.id)
    .eq("request_key", value.requestId).maybeSingle();
  if (existingError || !existing || existing.request_hash !== hash) {
    throw new Error("This goal request changed while it was being submitted.");
  }
  return existing;
}

export async function updateGoalDraft(input: unknown): Promise<void> {
  const value = GoalDraftEditSchema.parse(input);
  const auth = await goalsContext(true);
  await assertAssignee(auth.workspace.id, value.ownerUserId);
  const { data, error } = await createAdminClient().rpc("update_goal_draft", {
    p_actor_user_id: auth.user.id, p_goal_id: value.goalId,
    p_expected_updated_at: value.expectedUpdatedAt, p_owner_user_id: value.ownerUserId,
    p_title: value.title, p_description: value.description || null,
    p_success_criteria: value.successCriteria || null, p_target_date: value.targetDate ?? null,
  });
  if (error || data !== value.goalId) throw new Error("Goal changed; refresh before editing.");
}

async function savePlan(input: {
  goalId: string; expectedRevision: number;
  items: z.input<typeof GoalPlanEditSchema>["items"];
  origin: "manager" | "ai_assisted";
  sourceChunkIds: string[];
}): Promise<string> {
  const value = GoalPlanEditSchema.parse({ goalId: input.goalId,
    expectedRevision: input.expectedRevision, items: input.items });
  const auth = await goalsContext(true);
  const { data, error } = await createAdminClient().rpc("save_goal_plan", {
    p_actor_user_id: auth.user.id, p_goal_id: value.goalId,
    p_expected_revision: value.expectedRevision, p_origin: input.origin,
    p_items: JSON.parse(JSON.stringify(value.items)) as Json,
    p_source_chunk_ids: input.sourceChunkIds,
  });
  if (error || !data) throw new Error("Plan could not be saved. Check assignments and refresh the goal.");
  return data;
}

export async function saveManagerGoalPlan(input: unknown): Promise<string> {
  const value = GoalPlanEditSchema.parse(input);
  const detail = await getWorkspaceGoal(value.goalId);
  if (!detail || !detail.canManage) throw new Error("Goal plan is unavailable.");
  const sources = Array.isArray(detail.plan?.source_references) ? detail.plan.source_references : [];
  const sourceChunkIds = sources.flatMap((source) => source && typeof source === "object"
    && !Array.isArray(source) && typeof source.chunkId === "string" ? [source.chunkId] : []);
  return savePlan({ ...value, origin: "manager", sourceChunkIds });
}

export async function generateGoalPlan(goalId: string) {
  const detail = await getWorkspaceGoal(z.uuid().parse(goalId));
  if (!detail || !detail.canManage || !["draft", "awaiting_approval"].includes(detail.goal.status)) {
    throw new Error("Goal plan is unavailable.");
  }
  const proposal = await proposeGoalPlanWithModel({ goal: detail.goal,
    actorUserId: detail.currentUserId, workspaceId: detail.goal.workspace_id });
  if (proposal.kind === "clarification") return proposal;
  const planId = await savePlan({ goalId, expectedRevision: detail.plan?.revision ?? 0,
    items: proposal.items, origin: "ai_assisted", sourceChunkIds: proposal.sourceChunkIds });
  return { kind: "proposal" as const, planId };
}

export async function approveGoalPlan(input: { goalId: string; planId: string; revision: number }): Promise<void> {
  const parsed = z.object({ goalId: z.uuid(), planId: z.uuid(), revision: z.number().int().min(1).max(100) }).strict().parse(input);
  const auth = await goalsContext(true);
  const { data, error } = await createAdminClient().rpc("activate_goal_plan", {
    p_actor_user_id: auth.user.id, p_goal_id: parsed.goalId,
    p_plan_id: parsed.planId, p_expected_revision: parsed.revision,
  });
  if (error || data !== parsed.goalId) throw new Error("Plan approval failed. Assign every item and refresh before retrying.");
}

export async function finishWorkspaceGoal(input: { goalId: string; action: "cancel" | "complete" }) {
  const parsed = z.object({ goalId: z.uuid(), action: z.enum(["cancel", "complete"]) }).strict().parse(input);
  const auth = await goalsContext(true);
  const { data, error } = await createAdminClient().rpc("finish_goal", {
    p_actor_user_id: auth.user.id, p_goal_id: parsed.goalId, p_action: parsed.action,
  });
  if (error || data !== parsed.goalId) throw new Error(parsed.action === "complete"
    ? "All linked work must be marked done before completing the goal."
    : "Only a draft or unapproved goal can be cancelled.");
}
