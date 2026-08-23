import "server-only";

import { trackProductEvent } from "@/lib/observability";
import type { CompiledWorkflow } from "@/lib/schemas/workflow";
import { nextScheduleOccurrence } from "@/lib/scheduling";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/types";

export function scheduleStep(workflow: CompiledWorkflow) {
  return workflow.steps.find((step) => step.capabilityId === "schedule.trigger" && step.type === "scheduled_trigger") ?? null;
}

export function prepareWorkflowSchedule(
  workflow: CompiledWorkflow,
  anchor = new Date(),
): Json | null {
  const step = scheduleStep(workflow);
  const schedule = step?.config?.schedule;
  if (!step || !schedule) return null;
  const nextRunAt = nextScheduleOccurrence(schedule, new Date(anchor.getTime() - 1), anchor);
  if (!nextRunAt) throw new Error("This schedule has no future occurrence.");
  return {
    definition: schedule as unknown as Json,
    humanLabel: schedule.humanLabel,
    timezone: schedule.timezone,
    anchorAt: anchor.toISOString(),
    nextRunAt: nextRunAt.toISOString(),
  };
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
