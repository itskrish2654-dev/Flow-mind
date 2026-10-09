import { CompiledWorkflowSchema, type CompiledWorkflow } from "@/lib/schemas/workflow";
import {
  annotateWorkflowCapabilities,
  getCapability,
  resolveStepCapabilityId,
} from "@/lib/capability-registry";
import {
  getWorkflowReadiness,
  type WorkflowConnectionReadiness,
} from "@/lib/workflow-readiness";
import { getStepInputs } from "@/lib/workflow-setup";
import type { WorkItem } from "@/lib/work-items-core";
import { ApprovalActionSnapshotSchema, type ApprovalRequest } from "@/lib/approvals-core";
import type { ActionExecutionStatus } from "@/lib/action-execution-core";

export const MY_DAY_LIMITS = {
  workflows: 30,
  executions: 10,
  selectedConnections: 300,
  credentials: 200,
  credentialPages: 5,
  needsYou: 8,
  today: 5,
  waitingOn: 5,
  recentActivity: 5,
  durableWorkItems: 50,
  handled: 5,
  teamWork: 20,
  completed: 10,
  approvals: 50,
} as const;

export type MyDayItemKind = "attention" | "today" | "waiting" | "activity" | "blocked" | "completed";
export type MyDayItemStatus =
  | "action_required"
  | "ready"
  | "waiting"
  | "running"
  | "success"
  | "handled"
  | "failed"
  | "cancelled"
  | "blocked"
  | "completed";

export type MyDayItem = {
  id: string;
  kind: MyDayItemKind;
  priority: number;
  title: string;
  description: string;
  source: string;
  timestamp: string | null;
  status: MyDayItemStatus;
  cta: {
    label: string;
    href: string;
  };
  workItem?: {
    id: string;
    status: WorkItem["status"];
    priority: WorkItem["priority"];
    dueAt: string | null;
    goalId: string | null;
    statusReason: string | null;
    whyItMatters: string | null;
    suggestedAction: string | null;
  };
};

export type MyDayData = {
  summary: {
    workflowCount: number;
    attentionCount: number;
    readyToTestCount: number;
    recentCompletedCount: number;
    sentence: string;
  };
  startWith: MyDayItem | null;
  needsYou: MyDayItem[];
  today: MyDayItem[];
  managerAssigned: MyDayItem[];
  deadlines: MyDayItem[];
  blocked: MyDayItem[];
  waitingOn: MyDayItem[];
  completed: MyDayItem[];
  recentActivity: MyDayItem[];
  handledByCrazyLoops: MyDayItem[];
  approvals: MyDayApproval[];
  agenda: { priorities: Array<{ title: string; href: string; reason: string }>;
    waiting: number; atRisk: number };
  approvalsUnavailable: boolean;
  workItemsUnavailable: boolean;
  workflowDataUnavailable: boolean;
  actionActivityUnavailable: boolean;
};

export type MyDayApproval = {
  id: string;
  workItemId: string;
  title: string;
  summary: string;
  reason: string;
  source: string;
  target: string;
  parameters: Array<{ label: string; value: string }>;
  createdAt: string;
};

export type MyDayWorkflowCandidate = {
  id: string;
  userId: string;
  name: string;
  lifecycleState: "active" | "disabled" | "archived";
  updatedAt: string;
  workflow: unknown;
  setupConfig: unknown;
  configuredCredentialKeys: readonly string[];
  credentialMetadataComplete: boolean;
};

export type MyDayExecutionCandidate = {
  id: string;
  userId: string;
  workflowId: string;
  status: "queued" | "running" | "succeeded" | "partially_failed" | "failed" | "cancelled";
  triggerType: string;
  createdAt: string;
  completedAt: string | null;
  failureCategory: string | null;
};

export type MyDayActionCandidate = {
  id: string;
  userId: string;
  workspaceId: string;
  workItemId: string;
  capabilityId: string;
  status: ActionExecutionStatus;
  acknowledged: boolean;
  externallyDelivered: boolean;
  resultSummary: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type MyDayConnectionCandidate = {
  id: string;
  userId: string;
  provider: string;
  status: "connected" | "expired" | "revoked" | "error";
};

export type MyDayCredentialMetadataCandidate = {
  userId: string;
  workflowId: string;
  connectorId: string;
  credentialKey: string;
};

export type BuildMyDayInput = {
  userId: string;
  workspaceId?: string;
  workflows: readonly MyDayWorkflowCandidate[];
  executions: readonly MyDayExecutionCandidate[];
  actions?: readonly MyDayActionCandidate[];
  connections: readonly MyDayConnectionCandidate[];
  workItems?: readonly WorkItem[];
  approvals?: readonly ApprovalRequest[];
  approvalsUnavailable?: boolean;
  workItemsUnavailable?: boolean;
  workflowDataUnavailable?: boolean;
  actionActivityUnavailable?: boolean;
  now?: Date;
};

const USER_ACTION_FAILURES = new Set([
  "authorization",
  "invalid_credentials",
  "invalid_destination",
  "invalid_input",
  "invalid_workflow",
  "unsupported_capability",
  "http_invalid_url",
  "http_blocked_destination",
  "http_unauthorized",
  "http_forbidden",
  "http_not_found",
  "http_conflict",
  "http_client_error",
  "http_invalid_json",
  "http_response_too_large",
  "formatter_invalid_input",
  "formatter_invalid_number",
  "formatter_division_by_zero",
  "formatter_invalid_date",
  "formatter_timezone_required",
  "formatter_output_too_large",
  "ai_invalid_request",
  "ai_input_too_large",
]);

const READINESS_CONNECTION_PROVIDERS = [
  "airtable",
  "google",
  "slack",
  "notion",
  "hubspot",
] as const;
type ReadinessConnectionProvider = (typeof READINESS_CONNECTION_PROVIDERS)[number];
const READINESS_CONNECTION_PROVIDER_SET = new Set<string>(READINESS_CONNECTION_PROVIDERS);

function safeText(value: string, fallback: string, maxLength = 140): string {
  const cleaned = value.replace(/\s+/g, " ").trim().slice(0, maxLength);
  return cleaned || fallback;
}

function timestampValue(value: string | null): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function newestFirst<T extends { timestamp: string | null; id: string }>(left: T, right: T): number {
  return timestampValue(right.timestamp) - timestampValue(left.timestamp) || left.id.localeCompare(right.id);
}

function attentionSort(left: MyDayItem, right: MyDayItem): number {
  return left.priority - right.priority || newestFirst(left, right) || left.title.localeCompare(right.title);
}

function setupValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function readinessConnections(
  connections: readonly MyDayConnectionCandidate[],
): WorkflowConnectionReadiness[] {
  return connections.flatMap((connection) => {
    if (!READINESS_CONNECTION_PROVIDER_SET.has(connection.provider) || connection.status === "revoked") return [];
    return [{
      id: connection.id,
      provider: connection.provider as WorkflowConnectionReadiness["provider"],
      status: connection.status,
    }];
  });
}

export function relevantUnboundConnectionProvidersFromWorkflows(
  workflows: readonly unknown[],
): ReadinessConnectionProvider[] {
  const providers = new Set<ReadinessConnectionProvider>();
  for (const value of workflows) {
    const parsed = CompiledWorkflowSchema.safeParse(value);
    if (!parsed.success) continue;
    for (const step of parsed.data.steps) {
      const connector = step.config?.connector;
      if (!connector || connector.connectionId || connector.connectorId.startsWith("flowmind_")) continue;
      const capabilityId = resolveStepCapabilityId(step);
      const capability = capabilityId ? getCapability(capabilityId) : null;
      if (!(capability?.connectionRequired ?? true)) continue;
      const provider = capability?.providerFamily
        ?? (connector.connectorId.startsWith("google_") ? "google" : connector.connectorId);
      if (READINESS_CONNECTION_PROVIDER_SET.has(provider)) {
        providers.add(provider as ReadinessConnectionProvider);
      }
    }
  }
  return [...providers].sort();
}

export function selectedConnectionIdsFromWorkflows(workflows: readonly unknown[]): string[] {
  const selected = new Set<string>();
  for (const value of workflows) {
    const parsed = CompiledWorkflowSchema.safeParse(value);
    if (!parsed.success) continue;
    for (const step of parsed.data.steps) {
      const connectionId = step.config?.connector?.connectionId;
      if (connectionId) selected.add(connectionId);
    }
  }
  return [...selected].sort();
}

export function indexCredentialMetadata({
  userId,
  workflowIds,
  credentials,
}: {
  userId: string;
  workflowIds: ReadonlySet<string>;
  credentials: readonly MyDayCredentialMetadataCandidate[];
}): Map<string, string[]> {
  const byWorkflow = new Map<string, string[]>();
  for (const credential of credentials) {
    if (credential.userId !== userId || !workflowIds.has(credential.workflowId)) continue;
    const keys = byWorkflow.get(credential.workflowId) ?? [];
    keys.push(`${credential.connectorId}:${credential.credentialKey}`);
    byWorkflow.set(credential.workflowId, keys);
  }
  return byWorkflow;
}

function requiredCredentialKeys(workflow: CompiledWorkflow, workflowId: string): string[] {
  return workflow.steps.flatMap((step) =>
    getStepInputs(step, workflowId)
      .filter((input) => input.type === "secret" && input.required !== false)
      .map((input) => `${step.capabilityId ?? step.type}:${input.key}`),
  );
}

function attentionPriority(key: string): number {
  if (key.includes(":connection") || key.includes(":unsupported") || key.includes(":unavailable")) return 1;
  if (key.includes(":test-only")) return 4;
  return 5;
}

function activityStatus(status: MyDayExecutionCandidate["status"]): {
  status: MyDayItemStatus;
  title: string;
  description: string;
} {
  switch (status) {
    case "queued":
      return { status: "waiting", title: "Waiting to start", description: "This run is queued and has not started yet." };
    case "running":
      return { status: "running", title: "Run in progress", description: "CrazyLoops is working through this workflow." };
    case "succeeded":
      return { status: "success", title: "Run completed", description: "The workflow completed successfully." };
    case "partially_failed":
      return { status: "failed", title: "Run needs review", description: "Some steps completed before the run stopped." };
    case "cancelled":
      return { status: "cancelled", title: "Run cancelled", description: "The run was cancelled before it completed." };
    default:
      return { status: "failed", title: "Run failed", description: "The run stopped before it completed." };
  }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function durableSource(item: WorkItem): string {
  if (item.source_label) return safeText(item.source_label, "CrazyLoops", 120);
  switch (item.source_type) {
    case "workflow": return "Workflow";
    case "workflow_execution": return "Workflow run";
    case "connector_event": return "Connected app";
    default: return "CrazyLoops";
  }
}

export function durableMyDayItem(item: WorkItem): MyDayItem {
  const status: MyDayItemStatus = item.status === "needs_you" ? "action_required"
    : item.status === "in_progress" ? "running"
    : item.status === "waiting" ? "waiting"
    : item.status === "blocked" ? "blocked"
    : item.status === "done" ? "completed" : "handled";
  return {
    id: `work-item:${item.id}`,
    kind: item.status === "needs_you" ? "attention" : item.status === "waiting" ? "waiting"
      : item.status === "blocked" ? "blocked" : item.status === "done" ? "completed"
      : item.status === "in_progress" ? "today" : "activity",
    priority: item.priority === "high" ? 0 : item.priority === "normal" ? 4 : 7,
    title: safeText(item.title, "Work item", 180),
    description: item.summary ? safeText(item.summary, "Work needs review.", 2000) : "Work needs review.",
    source: durableSource(item),
    timestamp: item.updated_at,
    status,
    cta: { label: "Review item", href: `/my-day#work-item-${item.id}` },
    workItem: {
      id: item.id,
      status: item.status,
      priority: item.priority,
      dueAt: item.due_at,
      goalId: item.goal_id,
      statusReason: item.status_reason,
      whyItMatters: item.why_it_matters ? safeText(item.why_it_matters, "", 1000) : null,
      suggestedAction: item.suggested_action ? safeText(item.suggested_action, "", 500) : null,
    },
  };
}

export function buildMyDayData(input: BuildMyDayInput): MyDayData {
  const approvalRows = (input.approvals ?? [])
    .filter((approval) => approval.status === "pending"
      && approval.approver_user_id === input.userId
      && (!input.workspaceId || approval.workspace_id === input.workspaceId))
    .slice(0, MY_DAY_LIMITS.approvals);
  const approvals = approvalRows.flatMap<MyDayApproval>((approval) => {
    const snapshot = ApprovalActionSnapshotSchema.safeParse(approval.action_snapshot);
    if (!snapshot.success || snapshot.data.operationKey !== approval.capability_id) return [];
    return [{
      id: approval.id,
      workItemId: approval.work_item_id,
      title: safeText(approval.action_title, "Approval", 180),
      summary: safeText(approval.action_summary, "Review this proposed action.", 2000),
      reason: safeText(approval.approval_reason, "Your decision is required.", 1000),
      source: safeText(approval.origin_type.replaceAll("_", " "), "CrazyLoops", 120),
      target: safeText(snapshot.data.target.label, "Proposed target", 180),
      parameters: snapshot.data.parameters.map((parameter) => ({ label: parameter.label, value: parameter.value })),
      createdAt: approval.created_at,
    }];
  });
  const approvalsUnavailable = (input.approvalsUnavailable ?? false) || approvals.length !== approvalRows.length;
  const linkedPendingWorkItems = new Set(approvals.map((approval) => approval.workItemId));
  const durable = (input.workItems ?? [])
    .filter((item) => item.assignee_user_id === input.userId
      && (!input.workspaceId || item.workspace_id === input.workspaceId))
    .filter((item) => !linkedPendingWorkItems.has(item.id))
    .slice(0, MY_DAY_LIMITS.durableWorkItems * 3)
    .map(durableMyDayItem);
  const workflows = input.workflows
    .filter((workflow) => workflow.userId === input.userId && workflow.lifecycleState !== "archived")
    .slice(0, MY_DAY_LIMITS.workflows);
  const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const connections = readinessConnections(
    input.connections
      .filter((connection) => connection.userId === input.userId),
  );
  const executions = input.executions
    .filter((execution) => execution.userId === input.userId && workflowById.has(execution.workflowId))
    .sort((left, right) => timestampValue(right.createdAt) - timestampValue(left.createdAt) || left.id.localeCompare(right.id))
    .slice(0, MY_DAY_LIMITS.executions);

  const evaluated = workflows.flatMap((candidate) => {
    const parsed = CompiledWorkflowSchema.safeParse(candidate.workflow);
    if (!parsed.success) return [];
    const workflow: CompiledWorkflow = annotateWorkflowCapabilities(parsed.data);
    const requiredKeys = requiredCredentialKeys(workflow, candidate.id);
    const readinessCredentialKeys = new Set(candidate.configuredCredentialKeys);
    if (!candidate.credentialMetadataComplete) {
      for (const key of requiredKeys) readinessCredentialKeys.add(key);
    }
    const baseReadiness = getWorkflowReadiness({
      workflow,
      workflowId: candidate.id,
      values: setupValues(candidate.setupConfig),
      configuredCredentialKeys: readinessCredentialKeys,
      connections,
    });
    const readiness = !candidate.credentialMetadataComplete && requiredKeys.length > 0
      ? {
          ...baseReadiness,
          attention: [
            ...baseReadiness.attention,
            {
              key: `${workflow.steps[0].id}:credential-status-unavailable`,
              stepId: workflow.steps[0].id,
              title: "Confirm saved security setup",
              description: "CrazyLoops could not safely confirm every saved security key for this workflow. Open it to review setup.",
              actionLabel: "Review workflow",
              blocksTest: true,
              blocksActivation: true,
            },
          ],
          testReady: false,
          activationReady: false,
        }
      : baseReadiness;
    return [{ candidate, workflow, readiness }];
  });

  const readinessAttention = evaluated.flatMap(({ candidate, readiness }) => {
    const source = safeText(candidate.name, "Untitled workflow");
    return readiness.attention.map<MyDayItem>((attention) => ({
      id: `workflow:${candidate.id}:${attention.key}`,
      kind: "attention",
      priority: attentionPriority(attention.key),
      title: safeText(attention.title, "Review workflow"),
      description: safeText(attention.description, "This workflow needs your attention.", 240),
      source,
      timestamp: candidate.updatedAt,
      status: "action_required",
      cta: {
        label: safeText(attention.actionLabel, "Review workflow", 40),
        href: `/dashboard/projects/${candidate.id}?step=${encodeURIComponent(attention.stepId)}`,
      },
    }));
  });

  const seenExecutionAttention = new Set<string>();
  const executionAttention = executions.flatMap<MyDayItem>((execution) => {
    const category = execution.failureCategory?.toLowerCase() ?? "";
    const isAmbiguous = category === "ambiguous_external_result";
    const requiresAction = isAmbiguous || USER_ACTION_FAILURES.has(category);
    if (!requiresAction || seenExecutionAttention.has(execution.workflowId)) return [];
    seenExecutionAttention.add(execution.workflowId);
    const workflow = workflowById.get(execution.workflowId);
    return [{
      id: `execution:${execution.id}:attention`,
      kind: "attention",
      priority: isAmbiguous ? 2 : 3,
      title: isAmbiguous ? "Check the provider result" : "Review the failed run",
      description: isAmbiguous
        ? "The provider response could not be confirmed. Review the run before trying it again."
        : "This run needs a configuration or permission change before it can succeed.",
      source: safeText(workflow?.name ?? "Workflow", "Workflow"),
      timestamp: execution.completedAt ?? execution.createdAt,
      status: "action_required",
      cta: { label: "Open workflow", href: `/dashboard/projects/${execution.workflowId}` },
    }];
  });

  const now = input.now ?? new Date();
  const dueWithin = (item: MyDayItem, hours: number) => Boolean(item.workItem?.dueAt
    && Date.parse(item.workItem.dueAt) <= now.getTime() + hours * 60 * 60 * 1000);
  const todayWork = durable.filter((item) => item.workItem?.status === "in_progress"
    || (item.workItem?.status === "needs_you" && item.workItem.goalId && dueWithin(item, 24)));
  const todayWorkIds = new Set(todayWork.map((item) => item.id));
  const deadlineWork = durable.filter((item) => item.workItem?.status === "needs_you"
    && item.workItem.goalId && !todayWorkIds.has(item.id) && dueWithin(item, 24 * 7));
  const deadlineIds = new Set(deadlineWork.map((item) => item.id));
  const managerAssigned = durable.filter((item) => item.workItem?.status === "needs_you"
    && item.workItem.goalId && !todayWorkIds.has(item.id) && !deadlineIds.has(item.id))
    .sort(attentionSort).slice(0, MY_DAY_LIMITS.teamWork);
  const blocked = durable.filter((item) => item.workItem?.status === "blocked")
    .sort(attentionSort).slice(0, MY_DAY_LIMITS.teamWork);
  const completed = durable.filter((item) => item.workItem?.status === "done")
    .sort(newestFirst).slice(0, MY_DAY_LIMITS.completed);
  const allNeedsYou = [...durable.filter((item) => item.workItem?.status === "needs_you"
    && !item.workItem.goalId && !todayWorkIds.has(item.id)),
    ...readinessAttention, ...executionAttention].sort(attentionSort);
  const needsYou = allNeedsYou.slice(0, MY_DAY_LIMITS.needsYou);

  const readyToday = evaluated
    .filter(({ readiness }) => readiness.testReady)
    .map<MyDayItem>(({ candidate, readiness }) => ({
      id: `workflow:${candidate.id}:ready-to-test`,
      kind: "today",
      priority: readiness.activationReady ? 1 : 2,
      title: "Ready to test",
      description: readiness.activationReady
        ? "Every required detail is in place. Run a test when you are ready."
        : "This workflow can be tested now, but it still has a limitation before activation.",
      source: safeText(candidate.name, "Untitled workflow"),
      timestamp: candidate.updatedAt,
      status: "ready",
      cta: { label: "Open workflow", href: `/dashboard/projects/${candidate.id}` },
    }));

  const setupToday = evaluated
    .filter(({ readiness }) => !readiness.testReady && !readiness.attention.some((item) => item.key.includes(":unsupported")))
    .flatMap<MyDayItem>(({ candidate, readiness }) => {
      const next = readiness.attention.find((item) => item.blocksTest);
      if (!next) return [];
      return [{
        id: `workflow:${candidate.id}:continue-setup`,
        kind: "today",
        priority: 3,
        title: "Continue setup",
        description: safeText(next.description, "Add the next required detail to move this workflow forward.", 240),
        source: safeText(candidate.name, "Untitled workflow"),
        timestamp: candidate.updatedAt,
        status: "ready",
        cta: { label: safeText(next.actionLabel, "Review workflow", 40), href: `/dashboard/projects/${candidate.id}?step=${encodeURIComponent(next.stepId)}` },
      }];
    });

  const today = [...todayWork, ...readyToday, ...setupToday]
    .sort((left, right) => left.priority - right.priority || newestFirst(left, right))
    .slice(0, MY_DAY_LIMITS.today);

  const queuedWaiting = executions
    .filter((execution) => execution.status === "queued")
    .slice(0, MY_DAY_LIMITS.waitingOn)
    .map<MyDayItem>((execution) => ({
      id: `execution:${execution.id}:waiting`,
      kind: "waiting",
      priority: 1,
      title: "Waiting to start",
      description: "This run is durably queued and has not started yet.",
      source: safeText(workflowById.get(execution.workflowId)?.name ?? "Workflow", "Workflow"),
      timestamp: execution.createdAt,
      status: "waiting",
      cta: { label: "Open workflow", href: `/dashboard/projects/${execution.workflowId}` },
    }));
  const waitingOn = [...durable.filter((item) => item.workItem?.status === "waiting"), ...queuedWaiting]
    .sort(attentionSort)
    .slice(0, MY_DAY_LIMITS.waitingOn);
  const handledByCrazyLoops = durable.filter((item) => item.workItem?.status === "handled")
    .slice(0, MY_DAY_LIMITS.handled);

  const workflowActivity = executions
    .map<MyDayItem>((execution) => {
      const display = activityStatus(execution.status);
      return {
        id: `execution:${execution.id}:activity`,
        kind: "activity",
        priority: 1,
        title: display.title,
        description: display.description,
        source: safeText(workflowById.get(execution.workflowId)?.name ?? "Workflow", "Workflow"),
        timestamp: execution.completedAt ?? execution.createdAt,
        status: display.status,
        cta: { label: "View workflow", href: `/dashboard/projects/${execution.workflowId}` },
      };
    });
  const actionActivity = (input.actions ?? [])
    .filter((action) => action.userId === input.userId
      && (!input.workspaceId || action.workspaceId === input.workspaceId))
    .map<MyDayItem>((action) => {
      const confirmed = action.status === "succeeded" && action.acknowledged && action.externallyDelivered;
      const status: MyDayItemStatus = confirmed ? "success"
        : action.status === "failed" ? "failed"
        : action.status === "ambiguous" ? "action_required"
        : action.status === "rejected" || action.status === "cancelled" ? "cancelled"
        : action.status === "executing" ? "running" : "waiting";
      const gmail = action.capabilityId === "gmail_send_email";
      const sheets = action.capabilityId === "google_sheets_add_row" || action.capabilityId === "google_sheets_update_row";
      const title = sheets
        ? confirmed ? "Google Sheets change confirmed" : action.status === "ambiguous" ? "Google Sheets result needs review" : "Google Sheets action update"
        : gmail
        ? confirmed ? "Gmail email sent" : action.status === "ambiguous" ? "Gmail delivery needs review" : "Gmail send update"
        : confirmed ? "Approved action completed" : "Approved action update";
      return {
        id: `action:${action.id}:activity`,
        kind: "activity",
        priority: action.status === "ambiguous" ? 0 : 1,
        title,
        description: safeText(action.resultSummary ?? "Review the recorded action outcome.", "Review the recorded action outcome.", 240),
        source: sheets ? "Google Sheets" : gmail ? "Gmail" : "CrazyLoops action",
        timestamp: action.completedAt ?? action.createdAt,
        status,
        cta: { label: "Review work item", href: `/my-day#work-item-${action.workItemId}` },
      };
    });
  const recentActivity = [...workflowActivity, ...actionActivity]
    .sort(newestFirst)
    .slice(0, MY_DAY_LIMITS.recentActivity);

  const recentCompletedCount = executions.filter((execution) => Boolean(execution.completedAt)).length;
  const readyToTestCount = evaluated.filter(({ readiness }) => readiness.testReady).length;
  const sentence = [
    `${plural(allNeedsYou.length, "thing")} need${allNeedsYou.length === 1 ? "s" : ""} you.`,
    `${plural(managerAssigned.length, "manager assignment")} open.`,
    `${plural(blocked.length, "work item")} blocked.`,
    `${plural(approvals.length, "approval")} await${approvals.length === 1 ? "s" : ""} your decision.`,
    `${plural(readyToTestCount, "workflow")} ${readyToTestCount === 1 ? "is" : "are"} ready to test.`,
    `${plural(recentCompletedCount, "run")} completed recently.`,
  ].join(" ");

  return {
    summary: {
      workflowCount: workflows.length,
      attentionCount: allNeedsYou.length,
      readyToTestCount,
      recentCompletedCount,
      sentence,
    },
    startWith: needsYou[0] ?? blocked[0] ?? today[0] ?? deadlineWork[0] ?? managerAssigned[0] ?? null,
    needsYou,
    today,
    managerAssigned,
    deadlines: deadlineWork.sort(attentionSort).slice(0, MY_DAY_LIMITS.teamWork),
    blocked,
    waitingOn,
    completed,
    recentActivity,
    handledByCrazyLoops,
    approvals,
    agenda: {
      priorities: [...todayWork, ...deadlineWork, ...managerAssigned, ...allNeedsYou.filter((item) => item.workItem)]
        .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
        .sort((a, b) => a.priority - b.priority ||
          (Date.parse(a.workItem?.dueAt ?? "9999-12-31") - Date.parse(b.workItem?.dueAt ?? "9999-12-31")))
        .slice(0, 3).map((item) => ({ title: item.title, href: item.cta.href,
          reason: item.workItem?.status === "in_progress" ? "In progress"
            : item.workItem?.dueAt ? `Due ${item.workItem.dueAt.slice(0, 10)}`
            : item.workItem?.goalId ? "Assigned from an approved goal" : "Needs your attention" })),
      waiting: waitingOn.filter((item) => Boolean(item.workItem)).length,
      atRisk: blocked.length + deadlineWork.filter((item) => dueWithin(item, 48)).length,
    },
    approvalsUnavailable,
    workItemsUnavailable: input.workItemsUnavailable ?? false,
    workflowDataUnavailable: input.workflowDataUnavailable ?? false,
    actionActivityUnavailable: input.actionActivityUnavailable ?? false,
  };
}
