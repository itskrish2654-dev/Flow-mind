import "server-only";

import { getAuthenticatedContext } from "@/lib/auth";
import {
  ASK_LIMITS,
  AskToolIdSchema,
  boundedText,
  type AskReferenceKind,
  type AskToolId,
  type AskToolRecord,
  type AskToolResult,
} from "@/lib/ask-core";
import { loadMyDayData } from "@/lib/my-day";
import { listCurrentUserPendingApprovals } from "@/lib/approvals";
import { listCurrentUserWorkItems } from "@/lib/work-items";

export type AskTrustedScope = { userId: string; workspaceId: string };

function safeRecord(input: {
  key: string;
  kind: AskReferenceKind;
  id: string;
  label: string;
  href: string;
  facts: Record<string, string | null | undefined>;
}): AskToolRecord {
  return {
    referenceKey: input.key,
    reference: {
      kind: input.kind,
      entityId: input.id,
      label: boundedText(input.label, "CrazyLoops item", 180),
      href: input.href,
    },
    facts: Object.fromEntries(Object.entries(input.facts).flatMap(([key, value]) => {
      if (!value) return [];
      return [[boundedText(key, "field", 80), boundedText(value, "", ASK_LIMITS.recordFieldCharacters)]];
    })),
  };
}

function itemHref(id: string): string {
  return `/my-day#work-item-${id}`;
}

async function assertTrustedScope(scope: AskTrustedScope) {
  const auth = await getAuthenticatedContext();
  if (!auth || auth.user.id !== scope.userId || auth.workspace.id !== scope.workspaceId) {
    throw new Error("Ask data is unavailable.");
  }
  return auth;
}

async function loadWorkItems(scope: AskTrustedScope): Promise<AskToolResult> {
  await assertTrustedScope(scope);
  const items = await listCurrentUserWorkItems();
  return {
    tool: "work_items",
    summary: `${items.length} open Work Item${items.length === 1 ? "" : "s"} belong to this employee.`,
    records: items.slice(0, ASK_LIMITS.recordsPerTool).map((item, index) => safeRecord({
      key: `work_item:${index}`,
      kind: "work_item",
      id: item.id,
      label: item.title,
      href: itemHref(item.id),
      facts: {
        title: item.title,
        summary: item.summary,
        status: item.status.replaceAll("_", " "),
        priority: item.priority,
        whyItMatters: item.why_it_matters,
        suggestedAction: item.suggested_action,
        source: item.source_label,
        dueAt: item.due_at,
      },
    })),
  };
}

async function loadApprovals(scope: AskTrustedScope): Promise<AskToolResult> {
  await assertTrustedScope(scope);
  const approvals = await listCurrentUserPendingApprovals();
  return {
    tool: "pending_approvals",
    summary: `${approvals.length} pending approval${approvals.length === 1 ? "" : "s"} require this employee.`,
    records: approvals.slice(0, ASK_LIMITS.recordsPerTool).map((approval, index) => safeRecord({
      key: `approval:${index}`,
      kind: "approval",
      id: approval.id,
      label: approval.action_title,
      href: `/my-day#approval-${approval.id}`,
      facts: {
        title: approval.action_title,
        summary: approval.action_summary,
        reason: approval.approval_reason,
        status: approval.status,
        createdAt: approval.created_at,
      },
    })),
  };
}

function uuidFromCompositeId(value: string): string | null {
  return value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0] ?? null;
}

async function loadMyDay(scope: AskTrustedScope): Promise<AskToolResult> {
  await assertTrustedScope(scope);
  const data = await loadMyDayData();
  if (!data) throw new Error("Ask data is unavailable.");
  const items = [
    ...data.needsYou,
    ...data.waitingOn,
    ...data.handledByCrazyLoops,
    ...data.recentActivity,
  ].slice(0, ASK_LIMITS.recordsPerTool);
  const records = items.flatMap((item, index) => {
    const id = item.workItem?.id ?? uuidFromCompositeId(item.id);
    if (!id) return [];
    const kind: AskReferenceKind = item.id.startsWith("execution:") ? "execution"
      : item.id.startsWith("workflow:") ? "workflow" : "work_item";
    return [safeRecord({
      key: `${kind}:${index}`,
      kind,
      id,
      label: item.title,
      href: item.cta.href,
      facts: {
        title: item.title,
        description: item.description,
        source: item.source,
        status: item.status.replaceAll("_", " "),
        timestamp: item.timestamp,
        whyItMatters: item.workItem?.whyItMatters,
        suggestedAction: item.workItem?.suggestedAction,
      },
    })];
  });
  return { tool: "my_day", summary: data.summary.sentence, records };
}

async function loadWorkflowStatus(scope: AskTrustedScope): Promise<AskToolResult> {
  const auth = await assertTrustedScope(scope);
  const { data: workflows, error: workflowError } = await auth.supabase
    .from("workflows")
    .select("id,name,lifecycle_state,updated_at")
    .eq("workspace_id", scope.workspaceId)
    .eq("user_id", scope.userId)
    .neq("lifecycle_state", "archived")
    .order("updated_at", { ascending: false })
    .limit(ASK_LIMITS.recordsPerTool);
  if (workflowError) throw new Error("Workflow status is unavailable.");
  const workflowIds = workflows.map((workflow) => workflow.id);
  const executionResult = workflowIds.length
    ? await auth.supabase.from("workflow_executions")
        .select("id,workflow_id,status,created_at,completed_at,failure_category")
        .eq("user_id", scope.userId)
        .in("workflow_id", workflowIds)
        .order("created_at", { ascending: false })
        .limit(30)
    : { data: [], error: null };
  if (executionResult.error) throw new Error("Workflow status is unavailable.");
  const latest = new Map<string, (typeof executionResult.data)[number]>();
  for (const execution of executionResult.data) {
    if (!latest.has(execution.workflow_id)) latest.set(execution.workflow_id, execution);
  }
  return {
    tool: "workflow_status",
    summary: `${workflows.length} current workflow${workflows.length === 1 ? "" : "s"} are visible to this employee.`,
    records: workflows.map((workflow, index) => {
      const execution = latest.get(workflow.id);
      return safeRecord({
        key: `workflow:${index}`,
        kind: "workflow",
        id: workflow.id,
        label: workflow.name,
        href: `/dashboard/projects/${workflow.id}`,
        facts: {
          name: workflow.name,
          lifecycle: workflow.lifecycle_state,
          latestRunStatus: execution?.status ?? "No recent run",
          latestRunAt: execution?.created_at,
          failureCategory: execution?.failure_category,
          updatedAt: workflow.updated_at,
        },
      });
    }),
  };
}

async function loadRecentActivity(scope: AskTrustedScope): Promise<AskToolResult> {
  await assertTrustedScope(scope);
  const data = await loadMyDayData();
  if (!data) throw new Error("Recent activity is unavailable.");
  return {
    tool: "recent_activity",
    summary: `${data.recentActivity.length} recent CrazyLoops event${data.recentActivity.length === 1 ? "" : "s"} are available.`,
    records: data.recentActivity.slice(0, ASK_LIMITS.recordsPerTool).flatMap((item, index) => {
      const id = uuidFromCompositeId(item.id);
      if (!id) return [];
      const kind: AskReferenceKind = item.id.startsWith("execution:") ? "execution" : "workflow";
      return [safeRecord({
        key: `${kind}:${index}`,
        kind,
        id,
        label: item.source,
        href: item.cta.href,
        facts: {
          event: item.title,
          description: item.description,
          status: item.status,
          workflow: item.source,
          timestamp: item.timestamp,
        },
      })];
    }),
  };
}

/** Strict registry: callers cannot invent a tool name or provide query text. */
export async function executeAskTool(tool: AskToolId, scope: AskTrustedScope): Promise<AskToolResult> {
  switch (AskToolIdSchema.parse(tool)) {
    case "my_day": return loadMyDay(scope);
    case "work_items": return loadWorkItems(scope);
    case "pending_approvals": return loadApprovals(scope);
    case "workflow_status": return loadWorkflowStatus(scope);
    case "recent_activity": return loadRecentActivity(scope);
  }
}
