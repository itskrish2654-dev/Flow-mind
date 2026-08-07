"use server";

import { z } from "zod";

import { getAuthenticatedContext } from "@/lib/auth";
import type { Json } from "@/lib/supabase/types";

export type WorkflowExecutionRecord = {
  id: string;
  workflowId: string;
  inputData: Json;
  outputData: Json;
  createdAt: string;
};

export type ListWorkflowExecutionsResult =
  | { ok: true; executions: WorkflowExecutionRecord[] }
  | { ok: false; error: string };

export async function listWorkflowExecutions(
  workflowId: string,
): Promise<ListWorkflowExecutionsResult> {
  const parsedId = z.string().uuid().safeParse(workflowId);
  if (!parsedId.success) {
    return { ok: false, error: "We could not identify that automation." };
  }

  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };

  const { data: workflow, error: workflowError } = await auth.supabase
    .from("workflows")
    .select("id")
    .eq("id", parsedId.data)
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (workflowError || !workflow) {
    return { ok: false, error: "Unauthorized" };
  }

  const { data, error } = await auth.supabase
    .from("workflow_executions")
    .select("id, workflow_id, input_data, output_data, created_at")
    .eq("workflow_id", parsedId.data)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("Supabase execution list failed", {
      code: error.code,
      message: error.message,
    });
    return { ok: false, error: "We couldn’t load execution data." };
  }

  return {
    ok: true,
    executions: (data ?? []).map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      inputData: row.input_data,
      outputData: row.output_data,
      createdAt: row.created_at,
    })),
  };
}
