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
} as const;

export type MyDayItemKind = "attention" | "today" | "waiting" | "activity";
export type MyDayItemStatus =
  | "action_required"
  | "ready"
  | "waiting"
  | "running"
  | "success"
  | "failed"
  | "cancelled";

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
  waitingOn: MyDayItem[];
  recentActivity: MyDayItem[];
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
  workflows: readonly MyDayWorkflowCandidate[];
  executions: readonly MyDayExecutionCandidate[];
  connections: readonly MyDayConnectionCandidate[];
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

export function buildMyDayData(input: BuildMyDayInput): MyDayData {
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

  const allNeedsYou = [...readinessAttention, ...executionAttention].sort(attentionSort);
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

  const today = [...readyToday, ...setupToday]
    .sort((left, right) => left.priority - right.priority || newestFirst(left, right))
    .slice(0, MY_DAY_LIMITS.today);

  const waitingOn = executions
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

  const recentActivity = executions
    .slice(0, MY_DAY_LIMITS.recentActivity)
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

  const recentCompletedCount = executions.filter((execution) => Boolean(execution.completedAt)).length;
  const readyToTestCount = evaluated.filter(({ readiness }) => readiness.testReady).length;
  const sentence = [
    `${plural(allNeedsYou.length, "thing")} need${allNeedsYou.length === 1 ? "s" : ""} you.`,
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
    startWith: needsYou[0] ?? today[0] ?? null,
    needsYou,
    today,
    waitingOn,
    recentActivity,
  };
}
