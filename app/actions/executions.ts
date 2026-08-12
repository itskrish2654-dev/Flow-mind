"use server";

import { z } from "zod";

import { getAuthenticatedContext } from "@/lib/auth";
import { securityLog } from "@/lib/security/redaction";
import type { Json } from "@/lib/supabase/types";

const PAGE_SIZE = 50;
const MAX_EXPORT_ROWS = 10_000;

export type WorkflowExecutionRecord = {
  id: string;
  workflowId: string;
  workflowVersionId: string | null;
  status: "queued" | "running" | "succeeded" | "partially_failed" | "failed" | "cancelled";
  inputData: Json;
  outputData: Json;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failureCategory: string | null;
};

export type ListWorkflowExecutionsResult =
  | { ok: true; executions: WorkflowExecutionRecord[]; nextCursor: string | null }
  | { ok: false; error: string };

function toRecord(row: {
  id: string; workflow_id: string; workflow_version_id: string | null; status: WorkflowExecutionRecord["status"];
  input_data: Json; output_data: Json; created_at: string; started_at: string | null;
  completed_at: string | null; failure_category: string | null;
}): WorkflowExecutionRecord {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersionId: row.workflow_version_id,
    status: row.status,
    inputData: row.input_data,
    outputData: row.output_data,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failureCategory: row.failure_category,
  };
}

async function authorizeWorkflow(workflowId: string) {
  const auth = await getAuthenticatedContext();
  if (!auth) return null;
  const { data } = await auth.supabase.from("workflows").select("id")
    .eq("id", workflowId).eq("user_id", auth.user.id).maybeSingle();
  return data ? auth : null;
}

export async function listWorkflowExecutions(
  workflowId: string,
  cursor?: string | null,
): Promise<ListWorkflowExecutionsResult> {
  const parsed = z.object({
    workflowId: z.string().uuid(),
    cursor: z.string().regex(/^\d{4}-\d{2}-\d{2}T.+\|[0-9a-f-]{36}$/).nullable().optional(),
  }).safeParse({ workflowId, cursor });
  if (!parsed.success) return { ok: false, error: "We could not identify that automation or page." };
  const auth = await authorizeWorkflow(parsed.data.workflowId);
  if (!auth) return { ok: false, error: "Unauthorized" };

  let query = auth.supabase.from("workflow_executions")
    .select("id, workflow_id, workflow_version_id, status, input_data, output_data, created_at, started_at, completed_at, failure_category")
    .eq("workflow_id", parsed.data.workflowId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PAGE_SIZE + 1);
  if (parsed.data.cursor) {
    const [createdAt, id] = parsed.data.cursor.split("|");
    query = query.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`);
  }
  const { data, error } = await query;
  if (error) {
    securityLog("Execution list failed", { code: error.code, message: error.message });
    return { ok: false, error: "We couldn't load execution data." };
  }
  const page = (data ?? []).slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return {
    ok: true,
    executions: page.map(toRecord),
    nextCursor: (data?.length ?? 0) > PAGE_SIZE && last ? `${last.created_at}|${last.id}` : null,
  };
}

function csvSafe(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const protectedValue = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

function flatten(value: unknown, prefix = "", result: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, result);
  } else result[prefix || "value"] = value;
  return result;
}

export async function exportAllWorkflowExecutions(workflowId: string): Promise<
  | { ok: true; csv: string; rowCount: number; truncated: boolean }
  | { ok: false; error: string }
> {
  const id = z.string().uuid().safeParse(workflowId);
  if (!id.success) return { ok: false, error: "Workflow not found." };
  const auth = await authorizeWorkflow(id.data);
  if (!auth) return { ok: false, error: "Unauthorized" };
  const rows: WorkflowExecutionRecord[] = [];
  let cursor: string | null = null;
  while (rows.length < MAX_EXPORT_ROWS + 1) {
    let query = auth.supabase.from("workflow_executions")
      .select("id, workflow_id, workflow_version_id, status, input_data, output_data, created_at, started_at, completed_at, failure_category")
      .eq("workflow_id", id.data)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(500);
    if (cursor) {
      const [createdAt, rowId] = cursor.split("|");
      query = query.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${rowId})`);
    }
    const { data, error } = await query;
    if (error) return { ok: false, error: "Execution export failed." };
    if (!data?.length) break;
    rows.push(...data.map(toRecord));
    const last = data.at(-1)!;
    cursor = `${last.created_at}|${last.id}`;
    if (data.length < 500) break;
  }
  const truncated = rows.length > MAX_EXPORT_ROWS;
  const selected = rows.slice(0, MAX_EXPORT_ROWS);
  const records: Array<Record<string, unknown>> = selected.map((row) => ({
    id: row.id, created_at: row.createdAt, status: row.status,
    workflow_version_id: row.workflowVersionId, ...flatten(row.inputData, "input"), ...flatten(row.outputData, "output"),
  }));
  const headers = Array.from(new Set(records.flatMap((record) => Object.keys(record))));
  const csv = [headers.map(csvSafe).join(","), ...records.map((record) => headers.map((header) => csvSafe(record[header])).join(","))].join("\r\n");
  return { ok: true, csv, rowCount: selected.length, truncated };
}
