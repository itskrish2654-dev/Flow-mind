import type { CompiledWorkflow } from "@/lib/schemas/workflow";
import { getStepInputs, orderWorkflowSteps, toPlainEnglish } from "@/lib/workflow-setup";

type WorkflowStep = CompiledWorkflow["steps"][number];
type InputValues = Record<string, string>;
export type WorkflowConnectionReadiness = {
  id: string;
  provider: "airtable" | "google" | "slack" | "notion";
  status: "connected" | "expired" | "error";
};

export type WorkflowAttentionItem = {
  key: string;
  stepId: string;
  title: string;
  description: string;
  actionLabel: string;
  blocksTest: boolean;
  blocksActivation: boolean;
};

export type WorkflowReadiness = {
  attention: WorkflowAttentionItem[];
  readySteps: number;
  totalSteps: number;
  testReady: boolean;
  activationReady: boolean;
  stepReady: Record<string, boolean>;
};

function inputValueId(stepId: string, key: string): string {
  return `${stepId}-${key}`;
}

function connectorName(connectorId: string): string {
  if (connectorId.startsWith("google_")) return "Google";
  return connectorId
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function inputActionLabel(key: string, fallback: string): string {
  const labels: Record<string, string> = {
    destination_url: "Add destination link",
    recipient: "Add recipient",
    to: "Add recipient",
    channel: "Choose Slack channel",
    channelId: "Choose Slack channel",
    resourceId: "Choose Notion page",
    parentPageId: "Choose Notion page",
    pageId: "Choose Notion page",
    dataSourceId: "Choose Notion database",
    spreadsheetId: "Select Google Sheet",
    worksheet: "Choose worksheet",
    baseId: "Choose Airtable base",
    tableId: "Choose Airtable table",
    fields: "Match Airtable fields",
    document_template: "Review document content",
  };
  return labels[key] ?? `Add ${toPlainEnglish(fallback).toLowerCase()}`;
}

function requiredInputIsPresent({
  step,
  key,
  type,
  fallbackValue,
  values,
  configuredCredentialKeys,
}: {
  step: WorkflowStep;
  key: string;
  type: "text" | "url" | "secret";
  fallbackValue?: string;
  values: InputValues;
  configuredCredentialKeys: ReadonlySet<string>;
}): boolean {
  if (
    type === "secret" &&
    configuredCredentialKeys.has(`${step.capabilityId ?? step.type}:${key}`)
  ) {
    return true;
  }
  return Boolean(
    (values[inputValueId(step.id, key)] ?? fallbackValue ?? "").trim(),
  );
}

export function getWorkflowReadiness({
  workflow,
  workflowId,
  values,
  configuredCredentialKeys,
  connections,
  invalidInputIds,
}: {
  workflow: CompiledWorkflow | null;
  workflowId: string | null;
  values: InputValues;
  configuredCredentialKeys: ReadonlySet<string>;
  connections?: readonly WorkflowConnectionReadiness[];
  invalidInputIds?: ReadonlySet<string>;
}): WorkflowReadiness {
  const steps = workflow ? orderWorkflowSteps(workflow.steps) : [];
  const attention: WorkflowAttentionItem[] = [];
  const stepReady: Record<string, boolean> = {};

  for (const step of steps) {
    let readyForTest = true;
    const addAttention = (
      item: Omit<WorkflowAttentionItem, "key" | "stepId"> & { key: string },
    ) => {
      attention.push({ ...item, stepId: step.id });
      if (item.blocksTest) readyForTest = false;
    };

    if (step.capabilityStatus === "unsupported") {
      addAttention({
        key: `${step.id}:unsupported`,
        title: `${toPlainEnglish(step.title)} is not available`,
        description:
          step.capabilityMessage ??
          "Remove or replace this step before testing the workflow.",
        actionLabel: "Review step",
        blocksTest: true,
        blocksActivation: true,
      });
    } else if (step.capabilityStatus === "test_only") {
      addAttention({
        key: `${step.id}:test-only`,
        title: `${toPlainEnglish(step.title)} is test-only`,
        description:
          step.capabilityMessage ??
          "You can test this step, but it cannot run in an active workflow.",
        actionLabel: "Review step",
        blocksTest: false,
        blocksActivation: true,
      });
    }

    const connector = step.config?.connector;
    if (connector && !connector.connectorId.startsWith("flowmind_")) {
      const name = connectorName(connector.connectorId);
      const provider = connector.connectorId.startsWith("google_")
        ? "google"
        : connector.connectorId as WorkflowConnectionReadiness["provider"];
      const providerConnections = connections?.filter((connection) => connection.provider === provider) ?? [];
      const selectedConnection = connector.connectionId
        ? connections?.find((connection) => connection.id === connector.connectionId)
        : null;
      if (!connector.connectionId) {
        const hasUsableAccount = providerConnections.some((connection) => connection.status === "connected");
        addAttention({
          key: `${step.id}:connection`,
          title: hasUsableAccount ? `Choose ${name} account` : `Connect ${name}`,
          description: hasUsableAccount
            ? `${toPlainEnglish(step.title)} needs the exact ${name} account you want this step to use.`
            : `${toPlainEnglish(step.title)} needs your ${name} account. Your workflow draft will stay here while you connect it.`,
          actionLabel: hasUsableAccount ? `Choose ${name} account` : `Connect ${name}`,
          blocksTest: true,
          blocksActivation: true,
        });
      } else if (connections && (!selectedConnection || selectedConnection.status !== "connected")) {
        addAttention({
          key: `${step.id}:connection`,
          title: `Reconnect ${name}`,
          description: `${toPlainEnglish(step.title)} is still bound to its saved ${name} account, but that connection needs attention.`,
          actionLabel: `Reconnect ${name}`,
          blocksTest: true,
          blocksActivation: true,
        });
      }
    }

    const inputs = ["public_form_trigger", "webhook_trigger", "store_data"].includes(
      step.type,
    )
      ? []
      : getStepInputs(step, workflowId);

    if (["webhook_post", "http_request"].includes(step.type)) {
      const destination =
        values[inputValueId(step.id, "destination_url")] ??
        step.config?.http?.url ??
        step.config?.endpoint ??
        "";
      if (!destination.trim()) {
        addAttention({
          key: `${step.id}:destination_url`,
          title: "Add a destination link",
          description: `${toPlainEnglish(step.title)} needs to know where to send its result.`,
          actionLabel: "Add destination link",
          blocksTest: true,
          blocksActivation: true,
        });
      }
    }

    for (const input of inputs) {
      if (input.required === false) continue;
      if (
        ["webhook_post", "http_request"].includes(step.type) &&
        input.key === "destination_url"
      ) {
        continue;
      }
      if (invalidInputIds?.has(inputValueId(step.id, input.key))) {
        const actionLabel = inputActionLabel(input.key, input.label);
        addAttention({
          key: `${step.id}:${input.key}:unavailable`,
          title: actionLabel,
          description: `${toPlainEnglish(step.title)} uses a saved resource that is no longer available. Choose another one before this step runs.`,
          actionLabel,
          blocksTest: true,
          blocksActivation: true,
        });
        continue;
      }
      if (
        requiredInputIsPresent({
          step,
          key: input.key,
          type: input.type,
          fallbackValue: input.value,
          values,
          configuredCredentialKeys,
        })
      ) {
        continue;
      }
      const actionLabel = inputActionLabel(input.key, input.label);
      addAttention({
        key: `${step.id}:${input.key}`,
        title: actionLabel,
        description: `${toPlainEnglish(step.title)} needs this detail before it can run.`,
        actionLabel,
        blocksTest: true,
        blocksActivation: true,
      });
    }

    stepReady[step.id] = readyForTest;
  }

  const testReady =
    steps.length > 0 && !attention.some((item) => item.blocksTest);
  const activationReady =
    steps.length > 0 && !attention.some((item) => item.blocksActivation);

  return {
    attention,
    readySteps: Object.values(stepReady).filter(Boolean).length,
    totalSteps: steps.length,
    testReady,
    activationReady,
    stepReady,
  };
}
