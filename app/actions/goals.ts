"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import {
  approveGoalPlan, createGoalDraft, finishWorkspaceGoal, generateGoalPlan,
  reviseManagerGoalWorkAssignment, saveManagerGoalPlan, updateGoalDraft,
} from "@/lib/goals";

type GoalActionResult = { ok: true; goalId?: string; question?: string } | { ok: false; error: string };

function refreshGoal(goalId?: string) {
  revalidatePath("/goals");
  if (goalId) revalidatePath(`/goals/${goalId}`);
  revalidatePath("/my-day");
  revalidatePath("/activity");
}

export async function reviseGoalWorkAssignmentAction(formData: FormData): Promise<void> {
  const goalId = z.uuid().safeParse(formData.get("goalId"));
  if (!goalId.success) redirect("/goals");
  let failed = false;
  try {
    const rawDate = formData.get("dueDate");
    const dueAt = typeof rawDate === "string" && z.iso.date().safeParse(rawDate).success
      ? new Date(`${rawDate}T12:00:00Z`).toISOString() : null;
    await reviseManagerGoalWorkAssignment({ goalId: goalId.data,
      workItemId: formData.get("workItemId"), expectedUpdatedAt: formData.get("expectedUpdatedAt"),
      assigneeUserId: formData.get("assigneeUserId"), dueAt });
  } catch { failed = true; }
  refreshGoal(goalId.data);
  revalidatePath("/manager");
  redirect(`/goals/${goalId.data}${failed ? "?assignment_error=1" : ""}`);
}

export async function createGoalAction(input: unknown): Promise<GoalActionResult> {
  try {
    const goal = await createGoalDraft(input);
    refreshGoal(goal.id);
    return { ok: true, goalId: goal.id };
  } catch {
    return { ok: false, error: "The goal could not be saved. Check the title, owner and dates, then try again." };
  }
}

export async function editGoalAction(input: unknown): Promise<GoalActionResult> {
  try {
    await updateGoalDraft(input);
    const goalId = (input as { goalId: string }).goalId;
    refreshGoal(goalId);
    return { ok: true, goalId };
  } catch {
    return { ok: false, error: "The goal changed or is no longer editable. Refresh and review it before trying again." };
  }
}

export async function generateGoalPlanAction(goalId: string): Promise<GoalActionResult> {
  try {
    const result = await generateGoalPlan(goalId);
    if (result.kind === "clarification") return { ok: true, question: result.question };
    refreshGoal(goalId);
    return { ok: true, goalId };
  } catch (error) {
    const safeMessages = new Set([
      "The proposed plan could not be validated. Please try again or write the plan manually.",
      "Company knowledge search is unavailable.",
      "Plan could not be saved. Check assignments and refresh the goal.",
    ]);
    return { ok: false, error: error instanceof Error && safeMessages.has(error.message)
      ? error.message : "A valid plan could not be generated. You can write and save a plan manually." };
  }
}

export async function saveGoalPlanAction(input: unknown): Promise<GoalActionResult> {
  try {
    await saveManagerGoalPlan(input);
    const goalId = (input as { goalId: string }).goalId;
    refreshGoal(goalId);
    return { ok: true, goalId };
  } catch {
    return { ok: false, error: "The plan could not be saved. Check assignments and refresh the goal before retrying." };
  }
}

export async function approveGoalPlanAction(input: {
  goalId: string; planId: string; revision: number;
}): Promise<GoalActionResult> {
  try {
    await approveGoalPlan(input);
    refreshGoal(input.goalId);
    return { ok: true, goalId: input.goalId };
  } catch {
    return { ok: false, error: "Approval failed. Confirm every assignee is a current member, then refresh and review the exact plan." };
  }
}

export async function finishGoalAction(input: {
  goalId: string; action: "cancel" | "complete";
}): Promise<GoalActionResult> {
  try {
    await finishWorkspaceGoal(input);
    refreshGoal(input.goalId);
    return { ok: true, goalId: input.goalId };
  } catch {
    return { ok: false, error: input.action === "complete"
      ? "All linked Work Items must be marked done before this goal can be completed."
      : "Only a draft or unapproved goal can be cancelled." };
  }
}
