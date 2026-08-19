"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  CircleDot,
  CirclePlay,
  Copy,
  Database,
  ExternalLink,
  FileText,
  Filter,
  Info,
  LoaderCircle,
  Globe2,
  GlobeLock,
  LockKeyhole,
  Network,
  Play,
  PlugZap,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Sparkles,
  Workflow,
  Zap,
} from "lucide-react";

import { runTestWorkflow, type TestExecutionLog } from "@/app/actions/execute";
import { requestConnectorCapability } from "@/app/actions/connector-requests";
import { clearHomepageDemoDraft } from "@/app/actions/homepage-demo";
import {
  configureConnectorWorkflowStep,
  getConnectorConnectionOptions,
  getNotionResourceOptions,
  getSlackChannelOptions,
  inspectNotionSource,
} from "@/app/actions/connections";
import {
  getWorkflowCredentialMetadata,
  revokeWorkflowCredential,
  saveWorkflowCredential,
} from "@/app/actions/credentials";
import {
  customizeDataTableWithAi,
  customizeDocumentWithAi,
  customizeFormWithAi,
} from "@/app/actions/customize";
import {
  compileWorkflow,
  saveDocumentTemplate,
  saveWebhookEndpoint,
  saveWorkflowCustomization,
  setWorkflowPublication,
  getWorkflowConnectorEndpoints,
} from "@/app/actions/workflow";
import { DataTableBuilder } from "@/components/data-table-builder";
import { AccessibleDialog } from "@/components/accessible-dialog";
import { FormBuilder } from "@/components/form-builder";
import { GoogleSpreadsheetPicker } from "@/components/google-spreadsheet-picker";
import { AiCustomizationBar } from "@/components/ai-customization-bar";
import { getPublicFormPath, getPublicFormUrl } from "@/lib/public-form";
import { isSensitiveFieldName } from "@/lib/security/redaction";
import type {
  CompiledWorkflow,
  DataTableDefinition,
  PublicFormDefinition,
  StepInput,
} from "@/lib/schemas/workflow";
import type { WorkflowPlan } from "@/lib/workflow-planner";
import {
  getDataTableDefinition,
  previewDocumentTemplate,
  workflowVariables,
} from "@/lib/workflow-customization";
import {
  getStepInputs,
  orderWorkflowSteps,
  toPlainEnglish,
} from "@/lib/workflow-setup";

type Step = CompiledWorkflow["steps"][number];
type InputValues = Record<string, string>;

type AutomationWorkspaceProps = {
  initialWorkflow?: CompiledWorkflow | null;
  initialWorkflowId?: string | null;
  initialWorkflowName?: string;
  initialPrompt?: string;
  initialDraftReady?: boolean;
  initialPublished?: boolean;
  initialSetupConfig?: InputValues;
  initialConnections?: Array<{
    id: string;
    provider: "google" | "slack" | "notion";
    providerName: string;
    accountLabel: string;
    status: "connected" | "expired" | "error";
  }>;
};

const examples = [
  "Collect customer feedback in a form and store it in CrazyLoops",
  "Collect support requests in a form, summarize them, and store them in CrazyLoops",
  "Collect proposal details in a form, draft a proposal, and generate a PDF",
];

const stepVisuals = {
  public_form_trigger: { label: "Trigger", icon: Zap, tone: "emerald" },
  webhook_trigger: { label: "Trigger", icon: Zap, tone: "emerald" },
  ai_transform: { label: "AI Process", icon: Sparkles, tone: "indigo" },
  formatter_transform: { label: "Formatter", icon: SlidersHorizontal, tone: "amber" },
  store_data: { label: "CrazyLoops Storage", icon: Database, tone: "violet" },
  webhook_post: { label: "Test Webhook", icon: Send, tone: "violet" },
  http_request: { label: "Destination", icon: Send, tone: "violet" },
  generate_pdf: { label: "PDF Document", icon: FileText, tone: "rose" },
  filter_condition: { label: "Condition", icon: Filter, tone: "amber" },
  connector_trigger: { label: "Connected Trigger", icon: Zap, tone: "emerald" },
  connector_action: { label: "Connected Action", icon: Send, tone: "violet" },
  scheduled_trigger: { label: "When", icon: Zap, tone: "emerald" },
} as const;

const toneClasses = {
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-600",
  indigo: "border-[#e7c75f] bg-[#fff3c8] text-[#8a6200]",
  violet: "border-[#ded6ca] bg-[#f7f2e8] text-[#272536]",
  rose: "border-[#ead89e] bg-[#fff7dc] text-[#9a7007]",
  amber: "border-[#ead89e] bg-[#fff7dc] text-[#9a7007]",
};

function inputId(stepId: string, key: string) {
  return `${stepId}-${key}`;
}

function defaultInputValues(
  workflow: CompiledWorkflow | null,
  workflowId: string | null,
): InputValues {
  if (!workflow) return {};

  const setupValues = Object.fromEntries(
    orderWorkflowSteps(workflow.steps).flatMap((step) =>
      getStepInputs(step, workflowId).map((input) => [
        inputId(step.id, input.key),
        input.value ?? "",
      ]),
    ),
  );
  const sampleValues = Object.fromEntries((workflow.publicForm?.fields ?? []).map((field) => {
    const sample = field.type === "email" ? "test@example.com" : field.type === "number" ? "1000" : field.type === "checkbox" ? "true" : field.type === "date" ? new Date().toISOString().slice(0, 10) : field.type === "url" ? "https://example.com" : field.options?.[0] ?? `Sample ${field.label.toLowerCase()}`;
    return [`test_input:${field.key}`, sample];
  }));
  return { ...setupValues, ...sampleValues };
}

function cleanLegacySensitiveValues(): void {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const storageKey = localStorage.key(index);
    if (!storageKey?.startsWith("flowmind:values:")) continue;
    try {
      const value = JSON.parse(
        localStorage.getItem(storageKey) ?? "{}",
      ) as InputValues;
      const cleaned = Object.fromEntries(
        Object.entries(value).filter(([key]) => !isSensitiveFieldName(key)),
      );
      localStorage.setItem(storageKey, JSON.stringify(cleaned));
    } catch {
      localStorage.removeItem(storageKey);
    }
  }
}

function WorkflowNode({
  step,
  index,
  selected,
  ready,
  onSelect,
}: {
  step: Step;
  index: number;
  selected: boolean;
  ready: boolean;
  onSelect: () => void;
}) {
  const visual = stepVisuals[step.type];
  const Icon = visual.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full max-w-[360px] shrink-0 rounded-xl border bg-[#fffdfa] p-3.5 text-left shadow-[0_14px_34px_rgba(39,37,54,.08)] transition hover:-translate-y-0.5 hover:border-[#d7aa2f] ${selected ? "border-[#d7aa2f] ring-2 ring-[#f4e5ad]" : "border-[#e4ddd2]"}`}
    >
      <span className="flex items-center gap-2.5">
        <span
          className={`flex size-9 shrink-0 items-center justify-center rounded-[10px] border ${toneClasses[visual.tone]}`}
        >
          <Icon className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block text-[9px] uppercase tracking-[0.1em] text-slate-400">
            Step {index + 1} · {visual.label}
          </span>
          <span className="mt-1 block truncate text-[12px] font-semibold text-slate-900">
            {toPlainEnglish(step.title)}
          </span>
        </span>
      </span>
      <span
        className={`mt-3 flex items-center gap-1.5 text-[10px] ${step.capabilityStatus === "unsupported" || step.capabilityStatus === "test_only" ? "text-rose-500" : ready ? "text-emerald-500" : "text-amber-500"}`}
      >
        {ready ? (
          <CheckCircle2 className="size-3" />
        ) : (
          <CircleDot className="size-3" />
        )}
        {step.capabilityStatus === "unsupported"
          ? "Unsupported"
          : step.capabilityStatus === "test_only"
            ? "Test only"
            : ready
              ? "Ready"
              : "Setup needed"}
      </span>
    </button>
  );
}

function EmptyCanvas({ draftReady = false }: { draftReady?: boolean }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div>
        <span className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-[#e7c75f] bg-[#fff3c8] text-[#9a7007]">
          <Network className="size-5" />
        </span>
        <h2 className="mt-4 text-[13px] font-semibold text-slate-900">
          {draftReady
            ? "Your loop is ready to finish."
            : "Your workflow will appear here"}
        </h2>
        <p className="mx-auto mt-1.5 max-w-sm text-[11px] leading-5 text-slate-500">
          {draftReady
            ? "Your homepage description is restored below. Review it, then build the real workflow when you’re ready."
            : "Describe what you want below. The generated steps will become a real, selectable workflow."}
        </p>
      </div>
    </div>
  );
}

function DashboardConnections({
  connections,
}: {
  connections: NonNullable<AutomationWorkspaceProps["initialConnections"]>;
}) {
  const visible = connections
    .filter((connection) => connection.status !== "connected")
    .concat(connections.filter((connection) => connection.status === "connected"))
    .slice(0, 3);

  if (connections.length === 0) {
    return (
      <section aria-labelledby="dashboard-connections-title" className="mt-4 max-w-2xl rounded-2xl border border-[#ded6ca] bg-[#fffdfa] p-4 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-[#ead89e] bg-[#fff7dc] text-[#8a6200]"><PlugZap className="size-4" aria-hidden="true" /></span>
          <div className="min-w-0 flex-1">
            <h2 id="dashboard-connections-title" className="text-[12px] font-semibold text-slate-900">Connect the tools you already use.</h2>
            <p className="mt-1 text-[10px] leading-5 text-slate-500">CrazyLoops can build better loops once it knows where work should happen.</p>
            <Link href="/connections" className="mt-2 inline-flex min-h-10 items-center text-[10px] font-semibold text-[#765600] hover:text-[#9a7007]">Connect an app <ArrowRight className="ml-1 size-3" aria-hidden="true" /></Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="dashboard-connections-title" className="mt-4 max-w-2xl rounded-2xl border border-[#ded6ca] bg-[#fffdfa] p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 id="dashboard-connections-title" className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400">Connected apps</h2>
        <Link href="/connections" className="inline-flex min-h-8 items-center text-[9px] font-semibold text-[#765600] hover:text-[#9a7007]">Manage connections <ArrowRight className="ml-1 size-3" aria-hidden="true" /></Link>
      </div>
      <div className="mt-2 divide-y divide-[#eee8de]">
        {visible.map((connection) => (
          <div key={connection.id} className="flex min-w-0 items-center gap-3 py-2 first:pt-1 last:pb-0">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#f8f4ec] text-[10px] font-bold text-slate-700" aria-hidden="true">{connection.providerName.slice(0, 1)}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] font-semibold text-slate-800">{connection.providerName}</span>
              <span className="block truncate text-[9px] text-slate-500">{connection.accountLabel}</span>
            </span>
            <span className={`shrink-0 text-[9px] font-semibold ${connection.status === "connected" ? "text-emerald-700" : "text-amber-700"}`}>
              {connection.status === "connected" ? "● Connected" : "● Reconnect required"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Inspector({
  workflow,
  step,
  workflowId,
  inputs,
  values,
  onChange,
  onSavePublicForm,
  onSaveDataTable,
  onAiCustomizeForm,
  onAiCustomizeDataTable,
  onAiCustomizeDocument,
  onRestoreDocument,
  published,
  connectorEndpoint,
  onPublicationChange,
  onSaveWebhook,
  className = "hidden w-[288px] shrink-0 flex-col border-l border-[#e4ddd2] bg-[#fffdfa] xl:flex 2xl:w-[320px]",
}: {
  workflow: CompiledWorkflow | null;
  step: Step | null;
  workflowId: string | null;
  inputs: StepInput[];
  values: InputValues;
  onChange: (id: string, value: string) => void;
  onSavePublicForm: (form: PublicFormDefinition) => Promise<string | null>;
  onSaveDataTable: (definition: DataTableDefinition) => Promise<string | null>;
  onAiCustomizeForm: (instruction: string) => Promise<{
    error?: string;
    message?: string;
    form?: PublicFormDefinition;
  }>;
  onAiCustomizeDataTable: (instruction: string) => Promise<{
    error?: string;
    message?: string;
    definition?: DataTableDefinition;
  }>;
  onAiCustomizeDocument: (
    stepId: string,
    instruction: string,
  ) => Promise<{
    error?: string;
    message?: string;
  }>;
  onRestoreDocument: (
    stepId: string,
    template: string,
  ) => Promise<string | null>;
  published: boolean;
  connectorEndpoint: string | null;
  onPublicationChange: (publish: boolean) => Promise<string | null>;
  onSaveWebhook: (stepId: string, endpoint: string) => Promise<string | null>;
  className?: string;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [documentUndo, setDocumentUndo] = useState<{
    stepId: string;
    template: string;
  } | null>(null);
  const [undoingDocument, setUndoingDocument] = useState(false);
  const [configuredSecrets, setConfiguredSecrets] = useState<Set<string>>(
    new Set(),
  );
  const [credentialBusy, setCredentialBusy] = useState<string | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [connectorConnections, setConnectorConnections] = useState<
    Array<{ id: string; label: string; status: string; scopes: string[] }>
  >([]);
  const [connectorConnectionMessage, setConnectorConnectionMessage] = useState<
    string | null
  >(null);
  const [pendingConnectionId, setPendingConnectionId] = useState<string | null>(
    null,
  );
  const [slackChannels, setSlackChannels] = useState<
    Array<{ id: string; name: string; isMember: boolean }>
  >([]);
  const [notionResources, setNotionResources] = useState<
    Array<{
      id: string;
      type: "page" | "data_source";
      title: string;
      url?: string;
    }>
  >([]);
  const [googleSheetInfo, setGoogleSheetInfo] = useState<{
    title: string;
    worksheets: Array<{ id: number; title: string }>;
  } | null>(null);
  const [notionSourceInfo, setNotionSourceInfo] = useState<{ properties: Array<{ id: string; name: string; type: string; supported: boolean }> } | null>(null);
  const [notionSourceBusy, setNotionSourceBusy] = useState(false);

  useEffect(() => {
    if (!workflowId) return;
    let active = true;
    void getWorkflowCredentialMetadata(workflowId).then((result) => {
      if (!active || !result.ok) return;
      setConfiguredSecrets(
        new Set(
          result.credentials.map(
            (credential) =>
              `${credential.connectorId}:${credential.credentialKey}`,
          ),
        ),
      );
    });
    return () => {
      active = false;
    };
  }, [workflowId]);

  useEffect(() => {
    const connectorId = step?.config?.connector?.connectorId;
    if (
      !connectorId ||
      !["google_gmail", "google_sheets", "slack", "notion"].includes(
        connectorId,
      )
    )
      return;
    const providerFamily = connectorId.startsWith("google_")
      ? "google"
      : connectorId;
    let active = true;
    void getConnectorConnectionOptions(providerFamily).then((result) => {
      if (active && result.ok) setConnectorConnections(result.connections);
    });
    return () => {
      active = false;
    };
  }, [step]);

  useEffect(() => {
    const connector = step?.config?.connector;
    if (!connector?.connectionId) return;
    let active = true;
    if (connector.connectorId === "slack")
      void getSlackChannelOptions(connector.connectionId).then((result) => {
        if (active && result.ok) setSlackChannels(result.channels);
      });
    if (connector.connectorId === "notion")
      void getNotionResourceOptions(connector.connectionId).then((result) => {
        if (active && result.ok) setNotionResources(result.resources);
      });
    return () => {
      active = false;
    };
  }, [step]);

  async function copyValue(id: string, value: string) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(id);
    window.setTimeout(() => setCopied(null), 1500);
  }

  if (!step) {
    return (
      <aside className={className} aria-label="Workflow step setup">
        <div className="flex h-[65px] items-center border-b border-[#e4ddd2] px-5">
          <span className="text-[12px] font-semibold text-[#272536]">
            Step setup
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <div>
            <Info className="mx-auto size-5 text-slate-300" />
            <p className="mt-3 text-[11px] text-slate-400">
              Build a workflow, then select a step to configure it.
            </p>
          </div>
        </div>
      </aside>
    );
  }

  const visual = stepVisuals[step.type];
  const Icon = visual.icon;
  const publicFormPath = workflowId ? getPublicFormPath(workflowId) : null;
  const publicForm = workflow?.publicForm;
  const documentVariables = workflowVariables(publicForm);
  return (
    <aside
      className={className}
      aria-label={`${toPlainEnglish(step.title)} setup`}
    >
      <div className="flex min-h-[65px] items-center gap-2.5 border-b border-[#e4ddd2] px-4">
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-[10px] border ${toneClasses[visual.tone]}`}
        >
          <Icon className="size-3.5" />
        </span>
        <span className="min-w-0">
          <span className="block text-[9px] uppercase tracking-[0.1em] text-slate-400">
            {visual.label}
          </span>
          <span className="block truncate text-[12px] font-semibold text-slate-900">
            {toPlainEnglish(step.title)}
          </span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="text-[11px] leading-5 text-slate-500">
          {toPlainEnglish(step.description)}
        </p>
        {(step.capabilityStatus === "unsupported" ||
          step.capabilityStatus === "test_only") && (
          <div
            role="alert"
            className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[10px] leading-4 text-rose-700"
          >
            <p className="font-semibold">This step cannot run in production.</p>
            <p className="mt-1">
              {step.capabilityMessage ??
                "This capability is not currently supported."}
            </p>
          </div>
        )}
        <div className="my-4 h-px bg-[#eee8de]" />
        {step.config?.connector &&
          ["google_gmail", "google_sheets", "slack", "notion"].includes(
            step.config.connector.connectorId,
          ) &&
          workflowId && (
            <div className="mb-4 rounded-xl border border-[#e7c75f] bg-[#fff7dc] p-3.5">
              <p className="text-[10px] font-semibold text-slate-900">
                {step.config.connector.connectorId.startsWith("google_")
                  ? "Google account"
                  : step.config.connector.connectorId === "slack"
                    ? "Slack workspace"
                    : "Notion workspace"}
              </p>
              <p className="mt-1 text-[9px] leading-4 text-slate-500">
                Choose the exact account for this step. CrazyLoops never selects
                the first connected account automatically.
              </p>
              {connectorConnections.length ? (
                <select
                  aria-label="Connected account for this step"
                  value={step.config.connector.connectionId ?? ""}
                  onChange={async (event) => {
                    const selectedId = event.target.value;
                    setPendingConnectionId(selectedId);
                    setConnectorConnectionMessage(null);
                    const result = await configureConnectorWorkflowStep(
                      workflowId,
                      step.id,
                      selectedId,
                    );
                    if (!result.ok) {
                      setConnectorConnectionMessage(result.error);
                      return;
                    }
                    window.location.reload();
                  }}
                  className="mt-3 h-10 w-full rounded-lg border border-[#d8caa8] bg-white px-3 text-xs text-slate-800"
                >
                  <option value="">Choose connected account</option>
                  {connectorConnections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.label} · {connection.status}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="mt-3">
                  <p className="text-[10px] font-semibold text-slate-800">
                    {step.config.connector.connectorId.startsWith("google_")
                      ? "Google"
                      : step.config.connector.connectorId === "slack"
                        ? "Slack"
                        : "Notion"} needs to be connected.
                  </p>
                  <a
                    href={`/api/connectors/oauth/${step.config.connector.connectorId}/start?operation=${step.config.connector.operationKey}&return=${encodeURIComponent(`/dashboard/projects/${workflowId}`)}`}
                    className="mt-2 flex min-h-11 items-center justify-center rounded-lg border border-[#d7aa2f] bg-white text-[10px] font-semibold text-[#6f5100] hover:bg-[#fffaf0]"
                  >
                    Connect {step.config.connector.connectorId.startsWith("google_")
                      ? "Google"
                      : step.config.connector.connectorId === "slack"
                        ? "Slack"
                        : "Notion"} <ArrowRight className="ml-1.5 size-3" aria-hidden="true" />
                  </a>
                </div>
              )}
              {connectorConnectionMessage && (
                <>
                  <p role="alert" className="mt-2 text-[9px] text-rose-700">
                    {connectorConnectionMessage}
                  </p>
                  <a
                    href={`/api/connectors/oauth/${step.config.connector.connectorId}/start?operation=${step.config.connector.operationKey}&connection=${pendingConnectionId ?? step.config.connector.connectionId ?? ""}&return=${encodeURIComponent(`/dashboard/projects/${workflowId}`)}`}
                    className="mt-2 block text-[9px] font-semibold text-[#795700]"
                  >
                    Approve the additional permission
                  </a>
                </>
              )}
            </div>
          )}
        {step.type === "scheduled_trigger" && step.config?.schedule && (
          <div className="mb-4 rounded-xl border border-[#e7c75f] bg-[#fff7dc] p-3.5">
            <p className="text-[10px] font-semibold text-slate-900">{step.config.schedule.humanLabel}</p>
            <p className="mt-1 text-[9px] leading-4 text-slate-600">{step.config.schedule.timezone}</p>
            <p className="mt-2 text-[9px] leading-4 text-slate-500">Run a safe manual live test first. Activation starts future occurrences; it never waits for the next occurrence to test.</p>
            <button type="button" onClick={() => void onPublicationChange(!published)} className="mt-3 flex h-9 w-full items-center justify-center rounded-lg border border-[#d7aa2f] bg-white text-[10px] font-semibold text-[#6f5100]">
              {published ? "Disable schedule" : "Activate schedule"}
            </button>
          </div>
        )}
        {step.type === "filter_condition" && step.config?.condition && (
          <div className="mb-4 rounded-xl border border-[#e7c75f] bg-[#fff7dc] p-3.5">
            <p className="text-[10px] font-semibold text-slate-900">IF</p>
            <p className="mt-1 text-[10px] leading-4 text-slate-700">{step.config.condition.humanLabel.replace(/^If\s+/i, "")}</p>
            <p className="mt-2 text-[9px] leading-4 text-slate-500">Only the matching branch runs. The other branch is recorded as skipped—not failed.</p>
          </div>
        )}
        {step.type === "formatter_transform" && step.config?.formatter && (
          <div className="mb-4 rounded-xl border border-[#e7c75f] bg-[#fff7dc] p-3.5">
            <p className="flex items-center gap-2 text-[10px] font-semibold text-slate-900">
              <SlidersHorizontal className="size-3.5 text-[#9a7007]" />
              Deterministic Formatter
            </p>
            <dl className="mt-3 grid gap-2 text-[9px]">
              <div className="flex items-start justify-between gap-3">
                <dt className="text-slate-500">Operation</dt>
                <dd className="text-right font-semibold text-slate-800">{step.config.formatter.operation.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())}</dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="text-slate-500">Input</dt>
                <dd className="text-right font-semibold text-slate-800">{(step.config.formatter.source.path || "Previous value").replaceAll("_", " ")}</dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="text-slate-500">Save as</dt>
                <dd className="text-right font-semibold text-slate-800">{step.config.formatter.outputKey.replaceAll("_", " ")}</dd>
              </div>
              {step.config.formatter.operand !== undefined && (
                <div className="flex items-start justify-between gap-3"><dt className="text-slate-500">Number</dt><dd className="font-semibold text-slate-800">{step.config.formatter.operand}</dd></div>
              )}
              {step.config.formatter.decimalPlaces !== undefined && (
                <div className="flex items-start justify-between gap-3"><dt className="text-slate-500">Decimal places</dt><dd className="font-semibold text-slate-800">{step.config.formatter.decimalPlaces}</dd></div>
              )}
              {step.config.formatter.dateFormat && (
                <div className="flex items-start justify-between gap-3"><dt className="text-slate-500">Date format</dt><dd className="font-semibold text-slate-800">{step.config.formatter.dateFormat}</dd></div>
              )}
              {step.config.formatter.find !== undefined && (
                <div className="flex items-start justify-between gap-3"><dt className="text-slate-500">Find</dt><dd className="max-w-[160px] break-words text-right font-semibold text-slate-800">{step.config.formatter.find}</dd></div>
              )}
              {step.config.formatter.replacement !== undefined && (
                <div className="flex items-start justify-between gap-3"><dt className="text-slate-500">Replace with</dt><dd className="max-w-[160px] break-words text-right font-semibold text-slate-800">{step.config.formatter.replacement || "(empty)"}</dd></div>
              )}
              {step.config.formatter.separator !== undefined && (
                <div className="flex items-start justify-between gap-3"><dt className="text-slate-500">Separator</dt><dd className="max-w-[160px] break-words text-right font-semibold text-slate-800">{step.config.formatter.separator || "(empty)"}</dd></div>
              )}
              {step.config.formatter.value !== undefined && (
                <div className="flex items-start justify-between gap-3"><dt className="text-slate-500">Fallback / text</dt><dd className="max-w-[160px] break-words text-right font-semibold text-slate-800">{String(step.config.formatter.value)}</dd></div>
              )}
              {step.config.formatter.durationAmount !== undefined && step.config.formatter.durationUnit && (
                <div className="flex items-start justify-between gap-3"><dt className="text-slate-500">Duration</dt><dd className="font-semibold text-slate-800">{step.config.formatter.durationAmount} {step.config.formatter.durationUnit}</dd></div>
              )}
              {step.config.formatter.timezone && (
                <div className="flex items-start justify-between gap-3"><dt className="text-slate-500">Timezone</dt><dd className="font-semibold text-slate-800">{step.config.formatter.timezone}</dd></div>
              )}
            </dl>
            <p className="mt-3 border-t border-[#ead89e] pt-3 text-[9px] leading-4 text-slate-500">Runs locally in the CrazyLoops execution engine. No AI or external request is used.</p>
          </div>
        )}
        {step.type === "public_form_trigger" && workflow?.publicForm && (
          <div className="mb-4 rounded-xl border border-[#ded6ca] bg-white p-3.5">
            <p className="text-[10px] font-semibold text-slate-900">Safe sample input</p>
            <p className="mt-1 text-[9px] leading-4 text-slate-500">Used only for Live Test. It does not publish or submit the hosted form.</p>
            <div className="mt-3 grid gap-3">
              {workflow.publicForm.fields.map((field) => {
                const key = `test_input:${field.key}`;
                return <label key={field.key} className="grid gap-1 text-[9px] font-semibold text-slate-600">
                  {field.label}
                  {field.type === "textarea" ? (
                    <textarea value={values[key] ?? ""} onChange={(event) => onChange(key, event.target.value)} rows={3} className="rounded-lg border border-[#ded6ca] bg-[#fffdfa] px-3 py-2 text-[10px] font-normal text-slate-800 outline-none focus:border-slate-400" />
                  ) : (
                    <input type={field.type === "email" || field.type === "number" || field.type === "date" || field.type === "url" ? field.type : "text"} value={values[key] ?? ""} onChange={(event) => onChange(key, event.target.value)} className="h-9 rounded-lg border border-[#ded6ca] bg-[#fffdfa] px-3 text-[10px] font-normal text-slate-800 outline-none focus:border-slate-400" />
                  )}
                </label>;
              })}
            </div>
          </div>
        )}
        {["webhook_trigger", "connector_trigger"].includes(step.type) && (
          <div className="mb-4 rounded-xl border border-[#ded6ca] bg-white p-3.5">
            <label className="grid gap-1 text-[9px] font-semibold text-slate-600">
              Safe sample event
              <textarea value={values["test_input:message"] ?? ""} onChange={(event) => onChange("test_input:message", event.target.value)} rows={4} placeholder='{"text":"Sample message","priority":"urgent"}' className="rounded-lg border border-[#ded6ca] bg-[#fffdfa] px-3 py-2 font-mono text-[10px] font-normal text-slate-800 outline-none focus:border-slate-400" />
            </label>
          </div>
        )}
        {step.type === "public_form_trigger" && publicFormPath && (
          <div className="mb-4 rounded-xl border border-[#e7c75f] bg-[#fff7dc] p-3.5">
            <p className="flex items-center gap-2 text-[10px] font-semibold text-slate-900">
              {published ? (
                <Globe2 className="size-3.5 text-emerald-600" />
              ) : (
                <GlobeLock className="size-3.5 text-[#9a7007]" />
              )}
              {published ? "Hosted form is public" : "Hosted form is private"}
            </p>
            <p className="mt-1 text-[9px] leading-4 text-slate-500">
              {published
                ? "Anyone with the link can submit. Unpublish to revoke access immediately."
                : "Customize it, then publish when you're ready to accept submissions."}
            </p>
            <div className="mt-3 grid gap-2">
              {published && (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      if (workflowId)
                        void copyValue(
                          "public-form",
                          getPublicFormUrl(workflowId, window.location.origin),
                        );
                    }}
                    className="flex h-9 items-center justify-center gap-2 rounded-lg border border-[#d7aa2f] bg-[#fffdfa] text-[10px] font-semibold text-[#6f5100] transition hover:bg-[#fff0b9]"
                  >
                    {copied === "public-form" ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                    {copied === "public-form"
                      ? "Link copied"
                      : "Copy Public Form Link"}
                  </button>
                  <a
                    href={publicFormPath}
                    target="_blank"
                    rel="noreferrer"
                    className="flex h-9 items-center justify-center gap-2 rounded-lg border border-[#e1bd4b] bg-white text-[10px] font-semibold text-[#7f5d00] transition hover:bg-[#fff3c8]"
                  >
                    <ExternalLink className="size-3.5" /> Open Public Form
                  </a>
                </>
              )}
              <button
                type="button"
                onClick={() => void onPublicationChange(!published)}
                className="flex h-9 items-center justify-center gap-2 rounded-lg border border-[#d7aa2f] bg-white text-[10px] font-semibold text-[#6f5100] transition hover:bg-[#fff0b9]"
              >
                {published ? (
                  <GlobeLock className="size-3.5" />
                ) : (
                  <Globe2 className="size-3.5" />
                )}
                {published ? "Unpublish & Revoke" : "Publish Form"}
              </button>
              {publicForm && (
                <FormBuilder
                  form={publicForm}
                  onSave={onSavePublicForm}
                  onAiCustomize={onAiCustomizeForm}
                />
              )}
            </div>
          </div>
        )}
        {step.capabilityId === "generic_webhook_trigger" && (
          <div className="mb-4 rounded-xl border border-[#e7c75f] bg-[#fff7dc] p-3.5">
            <p className="flex items-center gap-2 text-[10px] font-semibold text-slate-900">
              {published ? (
                <Globe2 className="size-3.5 text-emerald-600" />
              ) : (
                <GlobeLock className="size-3.5 text-[#9a7007]" />
              )}
              {published
                ? "Webhook endpoint is active"
                : "Webhook endpoint is inactive"}
            </p>
            <p className="mt-1 text-[9px] leading-4 text-slate-500">
              The secret URL starts this pinned workflow version. Unpublishing
              revokes it immediately.
            </p>
            <div className="mt-3 grid gap-2">
              {published && connectorEndpoint && (
                <>
                  <label
                    htmlFor={`connector-endpoint-${step.id}`}
                    className="sr-only"
                  >
                    Webhook endpoint
                  </label>
                  <input
                    id={`connector-endpoint-${step.id}`}
                    aria-label="Webhook endpoint"
                    value={connectorEndpoint}
                    readOnly
                    className="h-9 min-w-0 rounded-lg border border-[#e2d8c8] bg-white px-3 text-[9px] text-slate-600 outline-none focus:border-[#d7aa2f]"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      void copyValue("connector-webhook", connectorEndpoint)
                    }
                    className="flex h-9 items-center justify-center gap-2 rounded-lg border border-[#d7aa2f] bg-[#fffdfa] text-[10px] font-semibold text-[#6f5100] hover:bg-[#fff0b9]"
                  >
                    {copied === "connector-webhook" ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                    {copied === "connector-webhook"
                      ? "Endpoint copied"
                      : "Copy webhook endpoint"}
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => void onPublicationChange(!published)}
                className="flex h-9 items-center justify-center gap-2 rounded-lg border border-[#d7aa2f] bg-white text-[10px] font-semibold text-[#6f5100] hover:bg-[#fff0b9]"
              >
                {published ? (
                  <GlobeLock className="size-3.5" />
                ) : (
                  <Globe2 className="size-3.5" />
                )}
                {published ? "Unpublish & Revoke" : "Publish Webhook"}
              </button>
            </div>
          </div>
        )}
        {step.type === "store_data" && workflowId && (
          <div className="mb-4 rounded-xl border border-[#ded6ca] bg-[#f7f2e8] p-3.5">
            <p className="text-[10px] font-semibold text-slate-900">
              Internal data table connected
            </p>
            <p className="mt-1 text-[9px] leading-4 text-slate-500">
              Every form submission and test result is saved automatically.
            </p>
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(new Event("flowmind:show-executions"))
              }
              className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[#d9cfbf] bg-white text-[10px] font-semibold text-[#272536] transition hover:border-[#d7aa2f] hover:bg-[#fff7dc]"
            >
              <Database className="size-3.5" />
              View Executions &amp; Data
            </button>
            {publicForm && workflow && (
              <DataTableBuilder
                form={publicForm}
                definition={getDataTableDefinition(workflow)}
                onSave={onSaveDataTable}
                onAiCustomize={onAiCustomizeDataTable}
              />
            )}
          </div>
        )}
        {step.type === "generate_pdf" && (
          <div className="mb-4 rounded-xl border border-[#e7c75f] bg-[#fff7dc] p-3.5">
            <p className="flex items-center gap-2 text-[10px] font-semibold text-slate-900">
              <FileText className="size-3.5 text-[#9a7007]" />
              Native PDF generator
            </p>
            <p className="mt-1 text-[9px] leading-4 text-slate-500">
              Describe the document you want and CrazyLoops will connect the
              right form answers and AI results automatically.
            </p>
            {publicForm && workflow && (
              <DataTableBuilder
                form={publicForm}
                definition={getDataTableDefinition(workflow)}
                onSave={onSaveDataTable}
                onAiCustomize={onAiCustomizeDataTable}
              />
            )}
          </div>
        )}
        {inputs.length === 0 ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center">
            <CheckCircle2 className="mx-auto size-5 text-emerald-500" />
            <p className="mt-2 text-[11px] font-medium text-slate-900">
              {step.type === "public_form_trigger"
                ? "Native form connected"
                : step.capabilityId === "generic_webhook_trigger"
                  ? "Authenticated webhook connected"
                  : step.type === "store_data"
                    ? "Native data table connected"
                    : "No setup needed"}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Required details
            </p>
            {inputs.map((input) => {
              const id = inputId(step.id, input.key);
              const value = values[id] ?? input.value ?? "";
              return (
                <div key={id}>
                  {!(
                    step.type === "generate_pdf" &&
                    input.key === "document_template"
                  ) && (
                    <>
                      <label
                        htmlFor={id}
                        className="block text-[10px] font-medium leading-4 text-slate-700"
                      >
                        {toPlainEnglish(input.label)}
                      </label>
                      {input.helpText && (
                        <p className="mt-1 text-[9px] leading-4 text-slate-400">
                          {toPlainEnglish(input.helpText)}
                        </p>
                      )}
                    </>
                  )}
                  {step.type === "generate_pdf" &&
                  input.key === "document_template" ? (
                    <>
                      <AiCustomizationBar
                        question="What should this document look like?"
                        placeholder="For example: Create a friendly proposal with the client's name, project details, AI recommendation, timeline, and a clear next step."
                        suggestions={[
                          "Make it a professional proposal",
                          "Add an executive summary and next steps",
                          "Make the tone warmer and more concise",
                        ]}
                        onApply={async (instruction) => {
                          const result = await onAiCustomizeDocument(
                            step.id,
                            instruction,
                          );
                          if (!result.error) {
                            setDocumentUndo({
                              stepId: step.id,
                              template: value,
                            });
                          }
                          return result;
                        }}
                      />
                      {documentUndo?.stepId === step.id && (
                        <button
                          type="button"
                          disabled={undoingDocument}
                          onClick={async () => {
                            setUndoingDocument(true);
                            const restoreError = await onRestoreDocument(
                              step.id,
                              documentUndo.template,
                            );
                            setUndoingDocument(false);
                            if (!restoreError) setDocumentUndo(null);
                          }}
                          className="mt-2 flex h-8 items-center gap-1.5 rounded-lg border border-[#ded6ca] px-2.5 text-[9px] font-semibold text-slate-600 hover:bg-[#f8f4ec] disabled:opacity-50"
                        >
                          {undoingDocument ? (
                            <LoaderCircle className="size-3 animate-spin" />
                          ) : (
                            <RotateCcw className="size-3" />
                          )}
                          Undo AI change
                        </button>
                      )}
                      <div className="mt-2 rounded-lg border border-[#ded6ca] bg-white p-3">
                        <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                          Current document preview
                        </p>
                        <div className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[9px] leading-4 text-slate-600">
                          {previewDocumentTemplate(value, documentVariables) ||
                            "Your populated document will appear here."}
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="relative mt-2">
                        {step.config?.connector?.connectorId === "slack" &&
                        input.key === "channel" &&
                        slackChannels.length ? (
                          <select
                            id={id}
                            value={value}
                            onChange={(event) => onChange(id, event.target.value)}
                            className="h-10 w-full rounded-lg border border-[#ded6ca] bg-[#f8f4ec] px-3 text-[10px] text-slate-800 outline-none focus:border-[#d7aa2f] focus:bg-white focus:ring-4 focus:ring-[#f4e5ad]"
                          >
                            <option value="">Choose Slack channel</option>
                            {slackChannels.map((channel) => (
                              <option key={channel.id} value={channel.id}>
                                #{channel.name}{channel.isMember ? "" : " · invite CrazyLoops first"}
                              </option>
                            ))}
                          </select>
                        ) : step.config?.connector?.connectorId === "notion" &&
                          ["resourceId", "parentPageId", "dataSourceId", "pageId"].includes(input.key) &&
                          notionResources.length ? (
                          <select
                            id={id}
                            value={value}
                            onChange={(event) => onChange(id, event.target.value)}
                            className="h-10 w-full rounded-lg border border-[#ded6ca] bg-[#f8f4ec] px-3 text-[10px] text-slate-800 outline-none focus:border-[#d7aa2f] focus:bg-white focus:ring-4 focus:ring-[#f4e5ad]"
                          >
                            <option value="">Choose Notion {input.key === "dataSourceId" ? "data source" : "resource"}</option>
                            {notionResources.filter((resource) => input.key === "dataSourceId" ? resource.type === "data_source" : input.key === "parentPageId" || input.key === "pageId" ? resource.type === "page" : true).map((resource) => (
                              <option key={resource.id} value={resource.id}>
                                {resource.title} · {resource.type === "data_source" ? "data source" : "page"}
                              </option>
                            ))}
                          </select>
                        ) : step.config?.connector?.connectorId === "google_sheets" &&
                          input.key === "spreadsheetId" &&
                          workflowId ? (
                          <GoogleSpreadsheetPicker
                            key={step.config.connector.connectionId ?? "no-google-connection"}
                            workflowId={workflowId}
                            stepId={step.id}
                            connectionId={step.config.connector.connectionId}
                            value={value}
                            onSelected={(spreadsheet) => {
                              onChange(id, spreadsheet.id);
                              onChange(inputId(step.id, "worksheet"), "");
                              setGoogleSheetInfo({ title: spreadsheet.title, worksheets: spreadsheet.worksheets });
                              setConnectorConnectionMessage(null);
                            }}
                          />
                        ) : step.config?.connector?.connectorId ===
                          "google_sheets" &&
                        input.key === "worksheet" &&
                        googleSheetInfo?.worksheets.length ? (
                          <select
                            id={id}
                            value={value}
                            onChange={(event) =>
                              onChange(id, event.target.value)
                            }
                            className="h-10 w-full rounded-lg border border-[#ded6ca] bg-[#f8f4ec] px-3 text-[10px] text-slate-800 outline-none focus:border-[#d7aa2f] focus:bg-white focus:ring-4 focus:ring-[#f4e5ad]"
                          >
                            <option value="">Choose worksheet</option>
                            {googleSheetInfo.worksheets.map((worksheet) => (
                              <option
                                key={worksheet.id}
                                value={worksheet.title}
                              >
                                {worksheet.title}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            id={id}
                            type={
                              input.type === "secret"
                                ? "password"
                                : input.type === "url"
                                  ? "url"
                                  : "text"
                            }
                            value={value}
                            onChange={(event) =>
                              onChange(id, event.target.value)
                            }
                            placeholder={
                              input.type === "secret" &&
                              configuredSecrets.has(
                                `${step.capabilityId ?? step.type}:${input.key}`,
                              )
                                ? "Configured — enter a replacement"
                                : input.placeholder
                            }
                            autoComplete={
                              input.type === "secret"
                                ? "new-password"
                                : undefined
                            }
                            className="h-10 w-full rounded-lg border border-[#ded6ca] bg-[#f8f4ec] px-3 pr-9 text-[10px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-[#d7aa2f] focus:bg-white focus:ring-4 focus:ring-[#f4e5ad]"
                          />
                        )}
                        {input.type === "url" && value && (
                          <button
                            type="button"
                            onClick={() => void copyValue(id, value)}
                            className="absolute right-1 top-1 flex size-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-800"
                          >
                            {copied === id ? (
                              <Check className="size-3.5 text-emerald-500" />
                            ) : (
                              <Copy className="size-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                      {input.type === "secret" && workflowId && (
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            disabled={!value || credentialBusy === id}
                            onClick={async () => {
                              setCredentialBusy(id);
                              setCredentialError(null);
                              const connectorId =
                                step.capabilityId ?? step.type;
                              const result = await saveWorkflowCredential({
                                workflowId,
                                connectorId,
                                credentialKey: input.key,
                                credentialType: "api_key",
                                secret: value,
                              });
                              setCredentialBusy(null);
                              if (!result.ok) {
                                setCredentialError(result.error);
                                return;
                              }
                              setConfiguredSecrets((current) =>
                                new Set(current).add(
                                  `${connectorId}:${input.key}`,
                                ),
                              );
                              onChange(id, "");
                            }}
                            className="h-8 rounded-lg border border-[#d7aa2f] px-2.5 text-[9px] font-semibold text-[#6f5100] disabled:opacity-40"
                          >
                            {credentialBusy === id
                              ? "Saving…"
                              : configuredSecrets.has(
                                    `${step.capabilityId ?? step.type}:${input.key}`,
                                  )
                                ? "Replace securely"
                                : "Save securely"}
                          </button>
                          {configuredSecrets.has(
                            `${step.capabilityId ?? step.type}:${input.key}`,
                          ) && (
                            <button
                              type="button"
                              onClick={async () => {
                                const connectorId =
                                  step.capabilityId ?? step.type;
                                const result = await revokeWorkflowCredential({
                                  workflowId,
                                  connectorId,
                                  credentialKey: input.key,
                                });
                                if (result.ok) {
                                  setConfiguredSecrets((current) => {
                                    const next = new Set(current);
                                    next.delete(`${connectorId}:${input.key}`);
                                    return next;
                                  });
                                } else setCredentialError(result.error);
                              }}
                              className="h-8 text-[9px] font-semibold text-rose-600"
                            >
                              Revoke
                            </button>
                          )}
                        </div>
                      )}
                      {step.config?.connector?.connectorId === "notion" && input.key === "dataSourceId" && (
                        <div className="mt-2">
                          <button
                            type="button"
                            disabled={!value || !step.config.connector.connectionId || notionSourceBusy}
                            onClick={async () => {
                              if (!step.config?.connector?.connectionId) return;
                              setNotionSourceBusy(true);
                              setConnectorConnectionMessage(null);
                              const result = await inspectNotionSource(step.config.connector.connectionId, value);
                              setNotionSourceBusy(false);
                              if (!result.ok) { setConnectorConnectionMessage(result.error); return; }
                              setNotionSourceInfo(result.dataSource);
                            }}
                            className="h-8 rounded-lg border border-[#d7aa2f] px-2.5 text-[9px] font-semibold text-[#6f5100] disabled:opacity-40"
                          >
                            {notionSourceBusy ? "Checking…" : "Inspect data-source fields"}
                          </button>
                          {notionSourceInfo && <p className="mt-2 text-[9px] leading-4 text-slate-500">{notionSourceInfo.properties.map((property) => `${property.name} · ${property.type}${property.supported ? "" : " (not supported)"}`).join(" · ")}</p>}
                        </div>
                      )}
                      {input.type === "url" &&
                        ["webhook_post", "http_request"].includes(
                          step.type,
                        ) && (
                          <button
                            type="button"
                            disabled={!value}
                            onClick={() => void onSaveWebhook(step.id, value)}
                            className="mt-2 h-8 rounded-lg border border-[#d7aa2f] px-2.5 text-[9px] font-semibold text-[#6f5100] disabled:opacity-40"
                          >
                            Save trusted destination
                          </button>
                        )}
                      {input.type === "secret" && credentialError && (
                        <p className="mt-1 text-[9px] text-rose-600">
                          {credentialError}
                        </p>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}

export function AutomationWorkspace({
  initialWorkflow = null,
  initialWorkflowId = null,
  initialWorkflowName = "",
  initialPrompt = "",
  initialDraftReady = false,
  initialPublished = false,
  initialSetupConfig = {},
  initialConnections = [],
}: AutomationWorkspaceProps) {
  const router = useRouter();
  const initialSteps = initialWorkflow
    ? orderWorkflowSteps(initialWorkflow.steps)
    : [];
  const [prompt, setPrompt] = useState(initialPrompt);
  const [workflow, setWorkflow] = useState<CompiledWorkflow | null>(
    initialWorkflow,
  );
  const [workflowId, setWorkflowId] = useState<string | null>(
    initialWorkflowId,
  );
  const [published, setPublished] = useState(initialPublished);
  const [connectorEndpoint, setConnectorEndpoint] = useState<string | null>(
    null,
  );
  const [selectedStepId, setSelectedStepId] = useState<string | null>(
    initialSteps[0]?.id ?? null,
  );
  const [values, setValues] = useState<InputValues>(() => ({
    ...defaultInputValues(initialWorkflow, initialWorkflowId),
    ...initialSetupConfig,
  }));
  const [isBuilding, setIsBuilding] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<TestExecutionLog[]>([]);
  const [delivered, setDelivered] = useState<boolean | null>(null);
  const [testSucceeded, setTestSucceeded] = useState<boolean | null>(null);
  const [planning, setPlanning] = useState<WorkflowPlan | null>(null);
  const [connectorRequestMessage, setConnectorRequestMessage] = useState<string | null>(null);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const buildRequestInFlight = useRef(false);

  useEffect(() => {
    if (!initialDraftReady) return;
    void clearHomepageDemoDraft();
  }, [initialDraftReady]);

  useEffect(() => {
    if (
      !workflowId ||
      !published ||
      !workflow?.steps.some(
        (step) => step.capabilityId === "generic_webhook_trigger",
      )
    )
      return;
    let active = true;
    void getWorkflowConnectorEndpoints(workflowId).then((result) => {
      if (active && result.ok)
        setConnectorEndpoint(result.endpoints[0] ?? null);
    });
    return () => {
      active = false;
    };
  }, [workflowId, published, workflow]);

  const steps = useMemo(
    () => (workflow ? orderWorkflowSteps(workflow.steps) : []),
    [workflow],
  );
  const selectedStep =
    steps.find((step) => step.id === selectedStepId) ?? steps[0] ?? null;
  const selectedInputs =
    selectedStep &&
    !["public_form_trigger", "webhook_trigger", "store_data"].includes(
      selectedStep.type,
    )
      ? getStepInputs(selectedStep, workflowId)
      : [];

  function inputsFor(step: Step) {
    if (
      ["public_form_trigger", "webhook_trigger", "store_data"].includes(
        step.type,
      )
    )
      return [];
    return getStepInputs(step, workflowId);
  }

  function stepIsReady(step: Step) {
    if (step.capabilityStatus === "unsupported") return false;
    if (step.config?.connector && !step.config.connector.connectorId.startsWith("flowmind_") && !step.config.connector.connectionId) return false;
    if (["webhook_post", "http_request"].includes(step.type)) {
      return Boolean(step.config?.endpoint?.trim());
    }
    return inputsFor(step).every((input) =>
      (values[inputId(step.id, input.key)] ?? input.value ?? "").trim(),
    );
  }

  const readySteps = steps.filter(stepIsReady).length;
  const workflowReady = steps.length > 0 && readySteps === steps.length;

  const resetBuilder = useCallback(() => {
    setWorkflow(null);
    setWorkflowId(null);
    setPublished(false);
    setSelectedStepId(null);
    setValues({});
    setPrompt("");
    setLogs([]);
    setDelivered(null);
    setTestSucceeded(null);
    setPlanning(null);
    setError(null);
    window.dispatchEvent(
      new CustomEvent("flowmind:active-workflow", { detail: null }),
    );
    if (window.location.pathname !== "/dashboard") {
      router.push("/dashboard");
    }
  }, [router]);

  useEffect(() => {
    if (!initialWorkflow || !initialWorkflowId) return;

    const restoreTimer = window.setTimeout(() => {
      cleanLegacySensitiveValues();
      const ordered = orderWorkflowSteps(initialWorkflow.steps);
      setValues({
        ...defaultInputValues(initialWorkflow, initialWorkflowId),
        ...Object.fromEntries(
          ordered.flatMap((step) =>
            getStepInputs(step, initialWorkflowId).map((input) => {
              const id = inputId(step.id, input.key);
              return [
                id,
                input.type === "secret" || isSensitiveFieldName(id)
                  ? ""
                  : (initialSetupConfig[id] ?? input.value ?? ""),
              ];
            }),
          ),
        ),
      });
      window.dispatchEvent(
        new CustomEvent("flowmind:active-workflow", {
          detail: initialWorkflowId,
        }),
      );
    }, 0);

    return () => window.clearTimeout(restoreTimer);
  }, [initialSetupConfig, initialWorkflow, initialWorkflowId]);

  useEffect(() => {
    const reset = () => resetBuilder();
    window.addEventListener("flowmind:new-workflow", reset);
    return () => {
      window.removeEventListener("flowmind:new-workflow", reset);
    };
  }, [resetBuilder]);

  useEffect(() => {
    if (!workflowId || !workflow) return;
    const status = workflowReady ? "Ready" : "Draft";
    window.dispatchEvent(
      new CustomEvent("flowmind:status-changed", {
        detail: { id: workflowId, status },
      }),
    );
  }, [values, workflow, workflowId, workflowReady]);

  async function buildAutomation() {
    const description = prompt.trim();
    if (!description || isBuilding || buildRequestInFlight.current) return;
    buildRequestInFlight.current = true;
    setIsBuilding(true);
    setError(null);
    setLogs([]);
    setDelivered(null);
    setTestSucceeded(null);
    setPlanning(null);
    try {
      let editIntent: "modify" | "replace" | undefined;
      if (workflowId) {
        const modify = window.confirm(
          "Modify the current automation? Choose OK to preserve its saved setup and create a new version. Choose Cancel to keep it unchanged or replace it instead.",
        );
        if (modify) {
          editIntent = "modify";
        } else {
          const replace = window.confirm(
            "Replace the current automation completely? This clears its saved setup, but version history and rollback remain available. Choose Cancel to make no change.",
          );
          if (!replace) return;
          editIntent = "replace";
        }
      }
      const result = await compileWorkflow(description, workflowId, editIntent);
      if (!result.success) {
        setPlanning(result.planning ?? null);
        setError(result.error);
        return;
      }
      const ordered = orderWorkflowSteps(result.workflow.steps);
      const initialValues = defaultInputValues(result.workflow, result.id);
      setWorkflow(result.workflow);
      setWorkflowId(result.id);
      setPublished(false);
      setValues(initialValues);
      setSelectedStepId(ordered[0]?.id ?? null);
      setPrompt("");
      setPlanning(result.planning);
      window.dispatchEvent(
        new CustomEvent("flowmind:active-workflow", { detail: result.id }),
      );
      window.dispatchEvent(new Event("flowmind:automations-changed"));
      const projectPath = `/dashboard/projects/${result.id}`;
      if (window.location.pathname === projectPath) {
        router.refresh();
      } else {
        router.push(projectPath);
      }
    } catch {
      setError("We couldn’t build that automation just now. Please try again.");
    } finally {
      buildRequestInFlight.current = false;
      setIsBuilding(false);
    }
  }

  async function runTest() {
    if (!workflowId || !workflow || isTesting) return;
    if (!workflowReady) {
      setError("Complete the required details before running a test.");
      return;
    }
    const sideEffects = steps.flatMap((step) => {
      if (step.type === "connector_action") return [`This live test will run “${toPlainEnglish(step.title)}” in the connected app.`];
      if (["webhook_post", "http_request"].includes(step.type)) return ["This live test will send data to the configured external destination."];
      return [];
    });
    if (sideEffects.length > 0 && !window.confirm(`${sideEffects.join("\n")}\n\nContinue with the live test?`)) return;
    setIsTesting(true);
    setError(null);
    setLogs([]);
    try {
      const result = await runTestWorkflow(
        workflowId,
        steps,
        values,
        crypto.randomUUID(),
      );
      if (!result.ok) {
        setLogs(result.logs ?? []);
        setTestSucceeded(false);
        setError(result.error);
        return;
      }
      setLogs(result.logs);
      setDelivered(result.delivered);
      setTestSucceeded(true);
      window.dispatchEvent(
        new CustomEvent("flowmind:executions-changed", { detail: workflowId }),
      );
      window.dispatchEvent(
        new CustomEvent("flowmind:status-changed", {
          detail: { id: workflowId, status: "Ready" },
        }),
      );
    } catch {
      setError("The test couldn’t run. Please try again.");
    } finally {
      setIsTesting(false);
    }
  }

  async function persistPublicForm(
    publicForm: PublicFormDefinition,
  ): Promise<string | null> {
    try {
      if (!workflowId)
        return "Create the workflow before customizing its form.";
      let result = await saveWorkflowCustomization(workflowId, { publicForm });
      if (!result.ok && result.impact) {
        const confirmed = window.confirm(
          `${result.error}\n\nContinue? This creates a new version; existing execution records are retained.`,
        );
        if (!confirmed)
          return "Field removal cancelled. No changes were saved.";
        result = await saveWorkflowCustomization(workflowId, {
          publicForm,
          confirmDestructiveFieldRemoval: true,
        });
      }
      if (!result.ok) return result.error;
      setWorkflow(result.workflow);
      window.dispatchEvent(
        new CustomEvent("flowmind:workflow-customized", {
          detail: result.workflow,
        }),
      );
      return null;
    } catch {
      return "We couldn't save the form. Please try again.";
    }
  }

  async function persistDataTable(
    dataTable: DataTableDefinition,
  ): Promise<string | null> {
    try {
      if (!workflowId)
        return "Create the workflow before customizing its data table.";
      const result = await saveWorkflowCustomization(workflowId, { dataTable });
      if (!result.ok) return result.error;
      setWorkflow(result.workflow);
      window.dispatchEvent(
        new CustomEvent("flowmind:workflow-customized", {
          detail: result.workflow,
        }),
      );
      return null;
    } catch {
      return "We couldn't save the data columns. Please try again.";
    }
  }

  async function restoreDocumentTemplate(
    stepId: string,
    template: string,
  ): Promise<string | null> {
    if (!workflowId) return "Create the workflow before changing its document.";
    const result = await saveDocumentTemplate(workflowId, stepId, template);
    if (!result.ok) return result.error;
    adoptCustomizedWorkflow(result.workflow);
    setValues((current) => ({
      ...current,
      [inputId(stepId, "document_template")]: template,
    }));
    return null;
  }

  async function changePublication(publish: boolean): Promise<string | null> {
    if (!workflowId) return "Create the workflow before publishing it.";
    const result = await setWorkflowPublication(workflowId, publish);
    if (!result.ok) {
      setError(result.error);
      return result.error;
    }
    setPublished(result.published);
    setConnectorEndpoint(result.connectorEndpoints[0] ?? null);
    setError(null);
    return null;
  }

  async function persistWebhookEndpoint(
    stepId: string,
    endpoint: string,
  ): Promise<string | null> {
    if (!workflowId) return "Create the workflow before configuring delivery.";
    const result = await saveWebhookEndpoint(workflowId, stepId, endpoint);
    if (!result.ok) {
      setError(result.error);
      return result.error;
    }
    adoptCustomizedWorkflow(result.workflow);
    setError(null);
    return null;
  }

  function adoptCustomizedWorkflow(customizedWorkflow: CompiledWorkflow) {
    setWorkflow(customizedWorkflow);
    window.dispatchEvent(
      new CustomEvent("flowmind:workflow-customized", {
        detail: customizedWorkflow,
      }),
    );
  }

  async function aiCustomizeForm(instruction: string) {
    if (!workflowId)
      return { error: "Create the workflow before customizing its form." };
    const result = await customizeFormWithAi(workflowId, instruction);
    if (!result.ok) return { error: result.error };
    adoptCustomizedWorkflow(result.workflow);
    return {
      message: result.message,
      form: result.workflow.publicForm,
    };
  }

  async function aiCustomizeDataTable(instruction: string) {
    if (!workflowId)
      return {
        error: "Create the workflow before customizing its data table.",
      };
    const result = await customizeDataTableWithAi(workflowId, instruction);
    if (!result.ok) return { error: result.error };
    adoptCustomizedWorkflow(result.workflow);
    return {
      message: result.message,
      definition: getDataTableDefinition(result.workflow),
    };
  }

  async function aiCustomizeDocument(stepId: string, instruction: string) {
    if (!workflowId)
      return { error: "Create the workflow before customizing its document." };
    const result = await customizeDocumentWithAi(
      workflowId,
      stepId,
      instruction,
    );
    if (!result.ok) return { error: result.error };
    adoptCustomizedWorkflow(result.workflow);
    const documentStep = result.workflow.steps.find(
      (step) => step.id === stepId && step.type === "generate_pdf",
    );
    const template = documentStep?.config?.documentTemplate;
    if (template) {
      setValues((current) => ({
        ...current,
        [inputId(stepId, "document_template")]: template,
      }));
    }
    return { message: result.message };
  }

  return (
    <div className="flex h-full min-w-0 overflow-hidden">
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex min-h-[65px] shrink-0 items-center gap-3 border-b border-[#e4ddd2] bg-[#fffdfa] pl-16 pr-3 sm:px-5">
          <div className="flex items-center gap-2 lg:hidden">
            <span className="flex size-8 items-center justify-center rounded-[10px] border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]">
              <Zap className="size-4 fill-current" />
            </span>
            <span className="font-bold text-[#272536]">CrazyLoops</span>
            <span className="rounded-full bg-[#fff2bd] px-2 py-0.5 text-[8px] font-bold uppercase tracking-[0.1em] text-[#765600]">Early Access</span>
          </div>
          <div className="hidden min-w-0 items-center gap-2 lg:flex">
            <Workflow className="size-4 shrink-0 text-[#b18410]" />
            <span className="truncate text-[13px] font-semibold text-[#272536]">
              {workflow
                ? toPlainEnglish(workflow.workflowName)
                : initialWorkflowName
                  ? toPlainEnglish(initialWorkflowName)
                  : "New Automation"}
            </span>
          </div>
          {workflow && (
            <span
              className={`hidden rounded-full px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.08em] sm:block ${workflowReady ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400"}`}
            >
              {workflowReady
                ? "Ready"
                : `${steps.length - readySteps} steps need setup`}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => void runTest()}
              disabled={!workflow || isTesting}
              className="flex h-8 items-center gap-2 rounded-lg border border-[#dcd4c8] bg-transparent px-3 text-[10px] font-semibold text-[#272536] transition hover:border-[#d7aa2f] hover:bg-[#fff8e3] disabled:cursor-not-allowed disabled:opacity-35"
            >
              {isTesting ? (
                <LoaderCircle className="size-3 animate-spin text-[#9a7007]" />
              ) : (
                <Play className="size-3 fill-current text-[#b18410]" />
              )}{" "}
              Test this loop
            </button>
          </div>
        </header>

        <section className="flex min-h-0 flex-1 flex-col bg-[#fffdfa]">
          <div className="workflow-canvas relative min-h-0 flex-1 overflow-y-auto">
            {!workflow ? (
              <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-5 py-5 sm:px-7">
                <div className="min-h-[220px] flex-1">
                  <EmptyCanvas draftReady={initialDraftReady} />
                </div>
                {!isBuilding && !error && (
                  <div className="mx-auto w-full max-w-2xl pb-2">
                    <div className="flex items-start gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd]">
                        <Bot className="size-4 text-[#8a6200]" />
                      </span>
                      <div className="rounded-2xl rounded-tl-sm border border-[#e4ddd2] bg-[#fffdfa] px-4 py-3 text-[11px] leading-5 text-slate-600 shadow-sm">
                        Describe an outcome below and I’ll turn it into connected,
                        configurable steps.
                      </div>
                    </div>
                    <DashboardConnections connections={initialConnections} />
                  </div>
                )}
              </div>
            ) : (
              <div className="mx-auto grid min-h-full w-full max-w-5xl gap-6 px-5 py-6 sm:px-7 md:grid-cols-[minmax(280px,1fr)_minmax(250px,.9fr)] md:items-center">
                <div className="flex min-h-[420px] min-w-0 flex-col items-center justify-center py-2">
                  <div className="flex w-full max-w-[420px] flex-col items-stretch">
                    {steps.map((step, index) => (
                      <div key={step.id} className="flex w-full flex-col items-center">
                        {index > 0 && (
                          <div className="relative flex h-10 w-full items-center justify-center" aria-hidden="true">
                            <div className="h-full w-px bg-[#d7aa2f]" />
                            {step.config?.branch && (
                              <span className="absolute left-1/2 ml-3 rounded-full bg-[#fff2bd] px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em] text-[#765600]">
                                {step.config.branch.when === "true" ? "Then" : "Otherwise"}
                              </span>
                            )}
                          </div>
                        )}
                        <WorkflowNode
                          step={step}
                          index={index}
                          selected={selectedStep?.id === step.id}
                          ready={stepIsReady(step)}
                          onSelect={() => {
                            setSelectedStepId(step.id);
                            if (window.innerWidth < 1280) setMobileInspectorOpen(true);
                          }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-5 flex w-full max-w-[360px] items-center justify-between gap-3 text-[10px] text-slate-500">
                    <span className="flex items-center gap-3">
                      <span className="flex items-center gap-1.5"><Network className="size-3" />{steps.length} steps</span>
                      <span>{readySteps}/{steps.length} ready</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setMobileInspectorOpen(true)}
                      className="flex min-h-10 items-center gap-2 rounded-xl border border-[#d7aa2f] bg-[#fffdfa] px-3 font-semibold text-[#6f5100] shadow-sm xl:hidden"
                    >
                      <SlidersHorizontal className="size-4" />
                      Configure step
                    </button>
                  </div>
                </div>

                <div className="flex min-w-0 flex-col justify-center gap-3 pb-2 md:pb-0">
                  <div className="rounded-2xl border border-[#e4ddd2] bg-[#fffdfa]/95 px-4 py-4 shadow-[0_10px_30px_rgba(39,37,54,.06)]">
                    <div className="flex items-start gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd]">
                        <Sparkles className="size-4 text-[#8a6200]" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold text-slate-900">{toPlainEnglish(workflow.workflowName)}</p>
                        <p className="mt-1 text-[10px] leading-5 text-slate-500">{toPlainEnglish(workflow.summary)}</p>
                      </div>
                    </div>
                    <p className="mt-4 text-[9px] font-bold uppercase tracking-[0.12em] text-[#805b00]">What will happen</p>
                    <div className="mt-2 grid gap-1.5">
                      {steps.map((step, index) => (
                        <p key={step.id} className="text-[10px] leading-4 text-slate-600">
                          <span className="font-semibold text-slate-800">{index + 1}. {stepVisuals[step.type].label}:</span>{" "}
                          {toPlainEnglish(step.title)}
                        </p>
                      ))}
                    </div>
                  </div>

                  {planning && planning.status !== "READY_TO_COMPILE" && (
                    <div className="rounded-xl border border-[#e7c75f] bg-[#fff7dc] px-4 py-3 text-[10px] leading-4 text-slate-700">
                      <p className="font-semibold text-slate-900">
                        {planning.status === "NEEDS_CLARIFICATION" ? "A little more detail is needed" : planning.status === "UNSUPPORTED" ? "Not supported yet" : "Requirements conflict"}
                      </p>
                      {planning.clarificationQuestions.map((question) => <p key={question} className="mt-1.5">{question}</p>)}
                      {planning.requestedUnsupportedCapabilities.map((capability) => (
                        <div key={capability.capabilityId} className="mt-2 flex flex-wrap items-center justify-between gap-2">
                          <p>{capability.displayName} isn’t available yet.</p>
                          <button type="button" className="rounded-lg border border-[#d7aa2f] bg-white px-3 py-1.5 font-semibold text-[#6f5100]" onClick={async () => {
                            const response = await requestConnectorCapability({ capabilityId: capability.capabilityId, source: "workflow_builder" });
                            setConnectorRequestMessage(response.ok ? response.message : response.error);
                          }}>Request {capability.displayName}</button>
                        </div>
                      ))}
                      {connectorRequestMessage && <p role="status" className="mt-2 font-medium text-emerald-700">{connectorRequestMessage}</p>}
                    </div>
                  )}

                  {logs.length > 0 && (
                    <div role="status" aria-live="polite" className={`rounded-xl border p-3 ${testSucceeded ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`}>
                      <p className="flex items-center gap-2 text-[11px] font-semibold text-slate-900">
                        <CirclePlay className={`size-3.5 ${testSucceeded ? "text-emerald-500" : "text-rose-500"}`} />
                        {testSucceeded ? "YOUR LOOP WORKS." : "Live test needs attention"}
                        {testSucceeded && delivered ? " · external delivery acknowledged" : ""}
                      </p>
                      <div className="mt-2 space-y-1.5">
                        {logs.map((log, index) => <p key={`${log.message}-${index}`} className="text-[10px] leading-4 text-slate-600">{log.icon} {log.message}</p>)}
                      </div>
                      {testSucceeded && !published && (
                        <button type="button" onClick={() => void changePublication(true)} className="mt-3 inline-flex min-h-10 items-center rounded-lg border border-emerald-300 bg-white px-4 text-[10px] font-semibold text-emerald-700">Activate →</button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {isBuilding && (
              <div className="absolute inset-x-5 bottom-4 flex items-center justify-center gap-3">
                <span className="flex items-center gap-2 rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] px-4 py-3 text-[11px] text-slate-500 shadow-sm">
                  <LoaderCircle className="size-3.5 animate-spin text-[#b18410]" />Building your workflow…
                </span>
              </div>
            )}
            {error && (
              <div role="alert" className="mx-5 mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[11px] text-rose-700">{error}</div>
            )}
          </div>

          <div className="shrink-0 border-t border-[#eee8de] bg-[#fffdfa]/95 px-4 pb-4 pt-3 sm:px-5">
            <div className="workflow-composer flex items-center gap-3 rounded-2xl border border-[#ded6ca] bg-white px-3.5 py-2.5 shadow-[0_8px_30px_rgba(39,37,54,.05)] transition-[border-color,box-shadow] focus-within:border-[#d7aa2f] focus-within:shadow-[0_0_0_3px_rgba(215,170,47,.14)]">
              <textarea
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setError(null);
                  setPlanning(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void buildAutomation();
                  }
                }}
                rows={1}
                maxLength={10_000}
                placeholder={
                  workflow
                    ? "Describe a different automation to replace this one…"
                    : "Describe the automation you want to build…"
                }
                className="max-h-28 min-h-9 flex-1 resize-none appearance-none border-0 bg-transparent px-0 py-1.5 text-[12px] leading-5 text-slate-800 outline-none ring-0 shadow-none [field-sizing:content] placeholder:text-slate-400 focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0"
              />
              <button
                type="button"
                onClick={() => void buildAutomation()}
                disabled={!prompt.trim() || isBuilding}
                aria-label={
                  isBuilding ? "Generating workflow" : "Generate workflow"
                }
                className="flex size-9 shrink-0 items-center justify-center self-center rounded-full border border-[#dfbd4c] bg-[#fff2bd] text-[#725300] transition hover:bg-[#f1c94b] hover:text-[#272536] disabled:cursor-not-allowed disabled:opacity-35"
              >
                {isBuilding ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </button>
            </div>
            {!workflow && (
              <div className="mt-2 flex gap-2 overflow-x-auto pb-0.5">
                {examples.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setPrompt(example)}
                    className="shrink-0 rounded-lg border border-[#ded6ca] bg-[#f8f4ec] px-2.5 py-1.5 text-[9px] text-slate-500 transition hover:border-[#d7aa2f] hover:bg-[#fff7dc] hover:text-[#7f5d00]"
                  >
                    {example}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-2 flex items-center gap-1.5 text-[9px] text-slate-400">
              <LockKeyhole className="size-3" />
              Private credentials stay in your workspace
            </div>
          </div>
        </section>
      </main>

      <Inspector
        workflow={workflow}
        workflowId={workflowId}
        step={selectedStep}
        inputs={selectedInputs}
        values={values}
        onSavePublicForm={persistPublicForm}
        onSaveDataTable={persistDataTable}
        onAiCustomizeForm={aiCustomizeForm}
        onAiCustomizeDataTable={aiCustomizeDataTable}
        onAiCustomizeDocument={aiCustomizeDocument}
        onRestoreDocument={restoreDocumentTemplate}
        published={published}
        connectorEndpoint={connectorEndpoint}
        onPublicationChange={changePublication}
        onSaveWebhook={persistWebhookEndpoint}
        onChange={(id, value) => {
          setValues((current) => ({ ...current, [id]: value }));
          setError(null);
          setLogs([]);
        }}
      />
      <AccessibleDialog
        open={mobileInspectorOpen}
        onOpenChange={setMobileInspectorOpen}
        title="Workflow step setup"
        description="Configure the selected workflow step."
        side="right"
        contentClassName="xl:hidden"
      >
        <Inspector
          workflow={workflow}
          workflowId={workflowId}
          step={selectedStep}
          inputs={selectedInputs}
          values={values}
          onSavePublicForm={persistPublicForm}
          onSaveDataTable={persistDataTable}
          onAiCustomizeForm={aiCustomizeForm}
          onAiCustomizeDataTable={aiCustomizeDataTable}
          onAiCustomizeDocument={aiCustomizeDocument}
          onRestoreDocument={restoreDocumentTemplate}
          published={published}
          connectorEndpoint={connectorEndpoint}
          onPublicationChange={changePublication}
          onSaveWebhook={persistWebhookEndpoint}
          className="flex min-h-0 w-full flex-1 flex-col bg-[#fffdfa] pt-12"
          onChange={(id, value) => {
            setValues((current) => ({ ...current, [id]: value }));
            setError(null);
            setLogs([]);
          }}
        />
      </AccessibleDialog>
    </div>
  );
}
