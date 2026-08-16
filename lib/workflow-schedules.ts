import "server-only";

import { trackProductEvent } from "@/lib/observability";
import type { CompiledWorkflow } from "@/lib/schemas/workflow";
import { nextScheduleOccurrence } from "@/lib/scheduling";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";

export function scheduleStep(workflow: CompiledWorkflow) {
  return workflow.steps.find((step) => step.capabilityId === "schedule.trigger" && step.type === "scheduled_trigger") ?? null;
}

export async function activateWorkflowSchedule(
  admin: SupabaseClient<Database>,
  input: { userId: string; workflowId: string; workflowVersionId: string; workflow: CompiledWorkflow },
) {
  const step = scheduleStep(input.workflow);
  const schedule = step?.config?.schedule;
  if (!step || !schedule) return null;
  const anchor = new Date();
  const nextRunAt = nextScheduleOccurrence(schedule, new Date(anchor.getTime() - 1), anchor);
  if (!nextRunAt) throw new Error("This schedule has no future occurrence.");
  const { data, error } = await admin.from("workflow_schedules").upsert({
    user_id: input.userId,
    workflow_id: input.workflowId,
    workflow_version_id: input.workflowVersionId,
    status: "active",
    schedule_definition: schedule as unknown as Json,
    human_label: schedule.humanLabel,
    timezone: schedule.timezone,
    anchor_at: anchor.toISOString(),
    next_run_at: nextRunAt.toISOString(),
    last_error_category: null,
    updated_at: anchor.toISOString(),
  }, { onConflict: "workflow_id" }).select("id,next_run_at").single();
  if (error || !data) throw new Error("The schedule could not be activated.");
  await trackProductEvent({ event: "schedule_created", userId: input.userId, workflowId: input.workflowId, properties: { status: "active" } });
  return data;
}

export async function disableWorkflowSchedule(
  admin: SupabaseClient<Database>,
  userId: string,
  workflowId: string,
) {
  const { data, error } = await admin.from("workflow_schedules").update({ status: "disabled", next_run_at: null, updated_at: new Date().toISOString() }).eq("workflow_id", workflowId).eq("user_id", userId).eq("status", "active").select("id");
  if (error) throw new Error("The schedule could not be disabled.");
  if ((data ?? []).length > 0) await trackProductEvent({ event: "schedule_disabled", userId, workflowId, properties: { status: "disabled" } });
}

export async function pinFutureScheduleToVersion(
  admin: SupabaseClient<Database>,
  input: { userId: string; workflowId: string; workflowVersionId: string; workflow: CompiledWorkflow },
) {
  const step = scheduleStep(input.workflow);
  if (!step?.config?.schedule) {
    await disableWorkflowSchedule(admin, input.userId, input.workflowId);
    return;
  }
  const anchor = new Date();
  const nextRunAt = nextScheduleOccurrence(step.config.schedule, new Date(anchor.getTime() - 1), anchor);
  if (!nextRunAt) throw new Error("The updated schedule has no future occurrence.");
  const { error } = await admin.from("workflow_schedules").update({
    workflow_version_id: input.workflowVersionId,
    schedule_definition: step.config.schedule as unknown as Json,
    human_label: step.config.schedule.humanLabel,
    timezone: step.config.schedule.timezone,
    anchor_at: anchor.toISOString(),
    next_run_at: nextRunAt.toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("workflow_id", input.workflowId).eq("user_id", input.userId).eq("status", "active");
  if (error) {
    await disableWorkflowSchedule(admin, input.userId, input.workflowId);
    throw new Error("The workflow changed, but its schedule was disabled because the next occurrence could not be updated safely.");
  }
}
