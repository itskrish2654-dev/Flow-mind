"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
  RotateCcw,
  Send,
  Sparkles,
  Workflow,
  Zap,
} from "lucide-react";

import { runTestWorkflow, type TestExecutionLog } from "@/app/actions/execute";
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
} from "@/app/actions/workflow";
import { DataTableBuilder } from "@/components/data-table-builder";
import { FormBuilder } from "@/components/form-builder";
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
import { getStepInputs, orderWorkflowSteps, toPlainEnglish } from "@/lib/workflow-setup";

type Step = CompiledWorkflow["steps"][number];
type InputValues = Record<string, string>;

type AutomationWorkspaceProps = {
  initialWorkflow?: CompiledWorkflow | null;
  initialWorkflowId?: string | null;
  initialWorkflowName?: string;
  initialPrompt?: string;
  initialPublished?: boolean;
  initialSetupConfig?: InputValues;
};

const examples = [
  "Collect customer feedback in a form and store it in FlowMind",
  "Collect support requests in a form, summarize them, and store them in FlowMind",
  "Collect proposal details in a form, draft a proposal, and generate a PDF",
];

const stepVisuals = {
  public_form_trigger: { label: "Trigger", icon: Zap, tone: "emerald" },
  webhook_trigger: { label: "Trigger", icon: Zap, tone: "emerald" },
  ai_transform: { label: "AI Process", icon: Sparkles, tone: "indigo" },
  store_data: { label: "FlowMind Storage", icon: Database, tone: "violet" },
  webhook_post: { label: "Test Webhook", icon: Send, tone: "violet" },
  http_request: { label: "Destination", icon: Send, tone: "violet" },
  generate_pdf: { label: "PDF Document", icon: FileText, tone: "rose" },
  filter_condition: { label: "Condition", icon: Filter, tone: "amber" },
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

  return Object.fromEntries(
    orderWorkflowSteps(workflow.steps).flatMap((step) =>
      getStepInputs(step, workflowId).map((input) => [
        inputId(step.id, input.key),
        input.value ?? "",
      ]),
    ),
  );
}

function cleanLegacySensitiveValues(): void {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const storageKey = localStorage.key(index);
    if (!storageKey?.startsWith("flowmind:values:")) continue;
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as InputValues;
      const cleaned = Object.fromEntries(
        Object.entries(value).filter(([key]) => !isSensitiveFieldName(key)),
      );
      localStorage.setItem(storageKey, JSON.stringify(cleaned));
    } catch {
      localStorage.removeItem(storageKey);
    }
  }
}

function WorkflowNode({ step, index, selected, ready, onSelect }: { step: Step; index: number; selected: boolean; ready: boolean; onSelect: () => void }) {
  const visual = stepVisuals[step.type];
  const Icon = visual.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-[185px] shrink-0 rounded-xl border bg-[#fffdfa] p-3.5 text-left shadow-[0_14px_34px_rgba(39,37,54,.08)] transition hover:-translate-y-0.5 hover:border-[#d7aa2f] ${selected ? "border-[#d7aa2f] ring-4 ring-[#f4e5ad]" : "border-[#e4ddd2]"}`}
    >
      <span className="flex items-center gap-2.5">
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-[10px] border ${toneClasses[visual.tone]}`}><Icon className="size-4" /></span>
        <span className="min-w-0"><span className="block text-[9px] uppercase tracking-[0.1em] text-slate-400">Step {index + 1} · {visual.label}</span><span className="mt-1 block truncate text-[12px] font-semibold text-slate-900">{toPlainEnglish(step.title)}</span></span>
      </span>
      <span className={`mt-3 flex items-center gap-1.5 text-[10px] ${step.capabilityStatus === "unsupported" || step.capabilityStatus === "test_only" ? "text-rose-500" : ready ? "text-emerald-500" : "text-amber-500"}`}>
        {ready ? <CheckCircle2 className="size-3" /> : <CircleDot className="size-3" />}
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

function EmptyCanvas() {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div>
        <span className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-[#e7c75f] bg-[#fff3c8] text-[#9a7007]"><Network className="size-5" /></span>
        <h2 className="mt-4 text-[13px] font-semibold text-slate-900">Your workflow will appear here</h2>
        <p className="mx-auto mt-1.5 max-w-sm text-[11px] leading-5 text-slate-500">Describe what you want below. The generated steps will become a real, selectable workflow.</p>
      </div>
    </div>
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
  onPublicationChange,
  onSaveWebhook,
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
  onAiCustomizeDocument: (stepId: string, instruction: string) => Promise<{
    error?: string;
    message?: string;
  }>;
  onRestoreDocument: (stepId: string, template: string) => Promise<string | null>;
  published: boolean;
  onPublicationChange: (publish: boolean) => Promise<string | null>;
  onSaveWebhook: (stepId: string, endpoint: string) => Promise<string | null>;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [documentUndo, setDocumentUndo] = useState<{
    stepId: string;
    template: string;
  } | null>(null);
  const [undoingDocument, setUndoingDocument] = useState(false);
  const [configuredSecrets, setConfiguredSecrets] = useState<Set<string>>(new Set());
  const [credentialBusy, setCredentialBusy] = useState<string | null>(null);
  const [credentialError, setCredentialError] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowId) return;
    let active = true;
    void getWorkflowCredentialMetadata(workflowId).then((result) => {
      if (!active || !result.ok) return;
      setConfiguredSecrets(
        new Set(
          result.credentials.map(
            (credential) => `${credential.connectorId}:${credential.credentialKey}`,
          ),
        ),
      );
    });
    return () => {
      active = false;
    };
  }, [workflowId]);

  async function copyValue(id: string, value: string) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(id);
    window.setTimeout(() => setCopied(null), 1500);
  }

  if (!step) {
    return (
      <aside className="hidden w-[292px] shrink-0 flex-col border-l border-[#e4ddd2] bg-[#fffdfa] xl:flex">
        <div className="flex h-[65px] items-center border-b border-[#e4ddd2] px-5"><span className="text-[12px] font-semibold text-[#272536]">Step setup</span></div>
        <div className="flex flex-1 items-center justify-center p-6 text-center"><div><Info className="mx-auto size-5 text-slate-300" /><p className="mt-3 text-[11px] text-slate-400">Build a workflow, then select a step to configure it.</p></div></div>
      </aside>
    );
  }

  const visual = stepVisuals[step.type];
  const Icon = visual.icon;
  const publicFormPath = workflowId ? getPublicFormPath(workflowId) : null;
  const publicForm = workflow?.publicForm;
  const documentVariables = workflowVariables(publicForm);
  return (
    <aside className="hidden w-[292px] shrink-0 flex-col border-l border-[#e4ddd2] bg-[#fffdfa] xl:flex">
      <div className="flex min-h-[65px] items-center gap-2.5 border-b border-[#e4ddd2] px-4">
        <span className={`flex size-8 shrink-0 items-center justify-center rounded-[10px] border ${toneClasses[visual.tone]}`}><Icon className="size-3.5" /></span>
        <span className="min-w-0"><span className="block text-[9px] uppercase tracking-[0.1em] text-slate-400">{visual.label}</span><span className="block truncate text-[12px] font-semibold text-slate-900">{toPlainEnglish(step.title)}</span></span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="text-[11px] leading-5 text-slate-500">{toPlainEnglish(step.description)}</p>
        {(step.capabilityStatus === "unsupported" || step.capabilityStatus === "test_only") && (
          <div role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[10px] leading-4 text-rose-700">
            <p className="font-semibold">This step cannot run in production.</p>
            <p className="mt-1">{step.capabilityMessage ?? "This capability is not currently supported."}</p>
          </div>
        )}
        <div className="my-4 h-px bg-[#eee8de]" />
        {(step.type === "public_form_trigger" || step.type === "webhook_trigger") && publicFormPath && (
          <div className="mb-4 rounded-xl border border-[#e7c75f] bg-[#fff7dc] p-3.5">
            <p className="flex items-center gap-2 text-[10px] font-semibold text-slate-900">
              {published ? <Globe2 className="size-3.5 text-emerald-600" /> : <GlobeLock className="size-3.5 text-[#9a7007]" />}
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
                      if (workflowId) void copyValue("public-form", getPublicFormUrl(workflowId, window.location.origin));
                    }}
                    className="flex h-9 items-center justify-center gap-2 rounded-lg border border-[#d7aa2f] bg-[#fffdfa] text-[10px] font-semibold text-[#6f5100] transition hover:bg-[#fff0b9]"
                  >
                    {copied === "public-form" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {copied === "public-form" ? "Link copied" : "Copy Public Form Link"}
                  </button>
                  <a href={publicFormPath} target="_blank" rel="noreferrer" className="flex h-9 items-center justify-center gap-2 rounded-lg border border-[#e1bd4b] bg-white text-[10px] font-semibold text-[#7f5d00] transition hover:bg-[#fff3c8]">
                    <ExternalLink className="size-3.5" /> Open Public Form
                  </a>
                </>
              )}
              <button
                type="button"
                onClick={() => void onPublicationChange(!published)}
                className="flex h-9 items-center justify-center gap-2 rounded-lg border border-[#d7aa2f] bg-white text-[10px] font-semibold text-[#6f5100] transition hover:bg-[#fff0b9]"
              >
                {published ? <GlobeLock className="size-3.5" /> : <Globe2 className="size-3.5" />}
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
        {step.type === "store_data" && workflowId && (
          <div className="mb-4 rounded-xl border border-[#ded6ca] bg-[#f7f2e8] p-3.5">
            <p className="text-[10px] font-semibold text-slate-900">Internal data table connected</p>
            <p className="mt-1 text-[9px] leading-4 text-slate-500">
              Every form submission and test result is saved automatically.
            </p>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event("flowmind:show-executions"))}
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
              Describe the document you want and FlowMind will connect the right form answers and AI results automatically.
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
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center"><CheckCircle2 className="mx-auto size-5 text-emerald-500" /><p className="mt-2 text-[11px] font-medium text-slate-900">{step.type === "public_form_trigger" || step.type === "webhook_trigger" ? "Native form connected" : step.type === "store_data" ? "Native data table connected" : "No setup needed"}</p></div>
        ) : (
          <div className="space-y-4">
            <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">Required details</p>
            {inputs.map((input) => {
              const id = inputId(step.id, input.key);
              const value = values[id] ?? input.value ?? "";
              return (
                <div key={id}>
                  {!(step.type === "generate_pdf" && input.key === "document_template") && (
                    <>
                      <label htmlFor={id} className="block text-[10px] font-medium leading-4 text-slate-700">{toPlainEnglish(input.label)}</label>
                      {input.helpText && <p className="mt-1 text-[9px] leading-4 text-slate-400">{toPlainEnglish(input.helpText)}</p>}
                    </>
                  )}
                  {step.type === "generate_pdf" && input.key === "document_template" ? (
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
                          const result = await onAiCustomizeDocument(step.id, instruction);
                          if (!result.error) {
                            setDocumentUndo({ stepId: step.id, template: value });
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
                          {undoingDocument ? <LoaderCircle className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
                          Undo AI change
                        </button>
                      )}
                      <div className="mt-2 rounded-lg border border-[#ded6ca] bg-white p-3">
                        <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-400">Current document preview</p>
                        <div className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[9px] leading-4 text-slate-600">
                          {previewDocumentTemplate(value, documentVariables) || "Your populated document will appear here."}
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="relative mt-2">
                        <input
                          id={id}
                          type={input.type === "secret" ? "password" : input.type === "url" ? "url" : "text"}
                          value={value}
                          onChange={(event) => onChange(id, event.target.value)}
                          placeholder={input.type === "secret" && configuredSecrets.has(`${step.capabilityId ?? step.type}:${input.key}`) ? "Configured — enter a replacement" : input.placeholder}
                          autoComplete={input.type === "secret" ? "new-password" : undefined}
                          className="h-10 w-full rounded-lg border border-[#ded6ca] bg-[#f8f4ec] px-3 pr-9 text-[10px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-[#d7aa2f] focus:bg-white focus:ring-4 focus:ring-[#f4e5ad]"
                        />
                        {input.type === "url" && value && <button type="button" onClick={() => void copyValue(id, value)} className="absolute right-1 top-1 flex size-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-800">{copied === id ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}</button>}
                      </div>
                      {input.type === "secret" && workflowId && (
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            disabled={!value || credentialBusy === id}
                            onClick={async () => {
                              setCredentialBusy(id);
                              setCredentialError(null);
                              const connectorId = step.capabilityId ?? step.type;
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
                              setConfiguredSecrets((current) => new Set(current).add(`${connectorId}:${input.key}`));
                              onChange(id, "");
                            }}
                            className="h-8 rounded-lg border border-[#d7aa2f] px-2.5 text-[9px] font-semibold text-[#6f5100] disabled:opacity-40"
                          >
                            {credentialBusy === id ? "Saving…" : configuredSecrets.has(`${step.capabilityId ?? step.type}:${input.key}`) ? "Replace securely" : "Save securely"}
                          </button>
                          {configuredSecrets.has(`${step.capabilityId ?? step.type}:${input.key}`) && (
                            <button
                              type="button"
                              onClick={async () => {
                                const connectorId = step.capabilityId ?? step.type;
                                const result = await revokeWorkflowCredential({ workflowId, connectorId, credentialKey: input.key });
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
                      {input.type === "url" && ["webhook_post", "http_request"].includes(step.type) && (
                        <button
                          type="button"
                          disabled={!value}
                          onClick={() => void onSaveWebhook(step.id, value)}
                          className="mt-2 h-8 rounded-lg border border-[#d7aa2f] px-2.5 text-[9px] font-semibold text-[#6f5100] disabled:opacity-40"
                        >
                          Save trusted destination
                        </button>
                      )}
                      {input.type === "secret" && credentialError && <p className="mt-1 text-[9px] text-rose-600">{credentialError}</p>}
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
  initialPublished = false,
  initialSetupConfig = {},
}: AutomationWorkspaceProps) {
  const router = useRouter();
  const initialSteps = initialWorkflow
    ? orderWorkflowSteps(initialWorkflow.steps)
    : [];
  const [prompt, setPrompt] = useState(initialPrompt);
  const [workflow, setWorkflow] = useState<CompiledWorkflow | null>(initialWorkflow);
  const [workflowId, setWorkflowId] = useState<string | null>(initialWorkflowId);
  const [published, setPublished] = useState(initialPublished);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(
    initialSteps[0]?.id ?? null,
  );
  const [values, setValues] = useState<InputValues>(() =>
    ({ ...defaultInputValues(initialWorkflow, initialWorkflowId), ...initialSetupConfig }),
  );
  const [isBuilding, setIsBuilding] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<TestExecutionLog[]>([]);
  const [delivered, setDelivered] = useState<boolean | null>(null);
  const [testSucceeded, setTestSucceeded] = useState<boolean | null>(null);
  const [planning, setPlanning] = useState<WorkflowPlan | null>(null);
  const buildRequestInFlight = useRef(false);

  const steps = useMemo(() => workflow ? orderWorkflowSteps(workflow.steps) : [], [workflow]);
  const selectedStep = steps.find((step) => step.id === selectedStepId) ?? steps[0] ?? null;
  const selectedInputs = selectedStep && !["public_form_trigger", "webhook_trigger", "store_data"].includes(selectedStep.type)
    ? getStepInputs(selectedStep, workflowId)
    : [];

  function inputsFor(step: Step) {
    if (["public_form_trigger", "webhook_trigger", "store_data"].includes(step.type)) return [];
    return getStepInputs(step, workflowId);
  }

  function stepIsReady(step: Step) {
    if (step.capabilityStatus === "unsupported") return false;
    if (["webhook_post", "http_request"].includes(step.type)) {
      return Boolean(step.config?.endpoint?.trim());
    }
    return inputsFor(step).every((input) => (values[inputId(step.id, input.key)] ?? input.value ?? "").trim());
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
    window.dispatchEvent(new CustomEvent("flowmind:active-workflow", { detail: null }));
    if (window.location.pathname !== "/dashboard") {
      router.push("/dashboard");
    }
  }, [router]);

  useEffect(() => {
    if (!initialWorkflow || !initialWorkflowId) return;

    const restoreTimer = window.setTimeout(() => {
      cleanLegacySensitiveValues();
      const ordered = orderWorkflowSteps(initialWorkflow.steps);
      setValues(
        Object.fromEntries(
          ordered.flatMap((step) =>
            getStepInputs(step, initialWorkflowId).map((input) => {
              const id = inputId(step.id, input.key);
              return [
                id,
                input.type === "secret" || isSensitiveFieldName(id)
                  ? ""
                    : initialSetupConfig[id] ?? input.value ?? "",
              ];
            }),
          ),
        ),
      );
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
    window.dispatchEvent(new CustomEvent("flowmind:status-changed", { detail: { id: workflowId, status } }));
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
      const initialValues = Object.fromEntries(ordered.flatMap((step) => getStepInputs(step, result.id).map((input) => [inputId(step.id, input.key), input.value ?? ""])));
      setWorkflow(result.workflow);
      setWorkflowId(result.id);
      setPublished(false);
      setValues(initialValues);
      setSelectedStepId(ordered[0]?.id ?? null);
      setPrompt("");
      setPlanning(result.planning);
      window.dispatchEvent(new CustomEvent("flowmind:active-workflow", { detail: result.id }));
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
    setIsTesting(true);
    setError(null);
    setLogs([]);
    try {
      const result = await runTestWorkflow(workflowId, steps, values, crypto.randomUUID());
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
      window.dispatchEvent(new CustomEvent("flowmind:status-changed", { detail: { id: workflowId, status: "Ready" } }));
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
      if (!workflowId) return "Create the workflow before customizing its form.";
      let result = await saveWorkflowCustomization(workflowId, { publicForm });
      if (!result.ok && result.impact) {
        const confirmed = window.confirm(`${result.error}\n\nContinue? This creates a new version; existing execution records are retained.`);
        if (!confirmed) return "Field removal cancelled. No changes were saved.";
        result = await saveWorkflowCustomization(workflowId, {
          publicForm,
          confirmDestructiveFieldRemoval: true,
        });
      }
      if (!result.ok) return result.error;
      setWorkflow(result.workflow);
      window.dispatchEvent(
        new CustomEvent("flowmind:workflow-customized", { detail: result.workflow }),
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
      if (!workflowId) return "Create the workflow before customizing its data table.";
      const result = await saveWorkflowCustomization(workflowId, { dataTable });
      if (!result.ok) return result.error;
      setWorkflow(result.workflow);
      window.dispatchEvent(
        new CustomEvent("flowmind:workflow-customized", { detail: result.workflow }),
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
    if (!workflowId) return { error: "Create the workflow before customizing its form." };
    const result = await customizeFormWithAi(workflowId, instruction);
    if (!result.ok) return { error: result.error };
    adoptCustomizedWorkflow(result.workflow);
    return {
      message: result.message,
      form: result.workflow.publicForm,
    };
  }

  async function aiCustomizeDataTable(instruction: string) {
    if (!workflowId) return { error: "Create the workflow before customizing its data table." };
    const result = await customizeDataTableWithAi(workflowId, instruction);
    if (!result.ok) return { error: result.error };
    adoptCustomizedWorkflow(result.workflow);
    return {
      message: result.message,
      definition: getDataTableDefinition(result.workflow),
    };
  }

  async function aiCustomizeDocument(stepId: string, instruction: string) {
    if (!workflowId) return { error: "Create the workflow before customizing its document." };
    const result = await customizeDocumentWithAi(workflowId, stepId, instruction);
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
        <header className="flex min-h-[65px] shrink-0 items-center gap-3 border-b border-[#e4ddd2] bg-[#fffdfa] px-4 sm:px-5">
          <div className="flex items-center gap-2 lg:hidden"><span className="flex size-8 items-center justify-center rounded-[10px] border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]"><Zap className="size-4 fill-current" /></span><span className="font-bold text-[#272536]">FlowMind</span></div>
          <div className="hidden min-w-0 items-center gap-2 lg:flex"><Workflow className="size-4 shrink-0 text-[#b18410]" /><span className="truncate text-[13px] font-semibold text-[#272536]">{workflow ? toPlainEnglish(workflow.workflowName) : initialWorkflowName ? toPlainEnglish(initialWorkflowName) : "New Automation"}</span></div>
          {workflow && <span className={`hidden rounded-full px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.08em] sm:block ${workflowReady ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400"}`}>{workflowReady ? "Ready" : `${steps.length - readySteps} steps need setup`}</span>}
          <div className="ml-auto flex items-center gap-2">
            <button type="button" onClick={() => void runTest()} disabled={!workflow || isTesting} className="flex h-8 items-center gap-2 rounded-lg border border-[#dcd4c8] bg-transparent px-3 text-[10px] font-semibold text-[#272536] transition hover:border-[#d7aa2f] hover:bg-[#fff8e3] disabled:cursor-not-allowed disabled:opacity-35">{isTesting ? <LoaderCircle className="size-3 animate-spin text-[#9a7007]" /> : <Play className="size-3 fill-current text-[#b18410]" />} Test Run</button>
          </div>
        </header>

        <section className="workflow-canvas relative h-[44%] min-h-[260px] shrink-0 overflow-hidden border-b border-[#e4ddd2]">
          {!workflow ? <EmptyCanvas /> : (
            <div className="h-full overflow-x-auto px-6">
              <div className="flex h-full min-w-max items-center justify-center">
                {steps.map((step, index) => (
                  <div key={step.id} className="flex items-center">
                    {index > 0 && <div className="relative w-12 shrink-0"><div className="h-0.5 bg-[#d7aa2f]" /><span className="absolute right-0 top-1/2 size-1.5 -translate-y-1/2 rotate-45 border-r-2 border-t-2 border-[#d7aa2f]" /></div>}
                    <WorkflowNode step={step} index={index} selected={selectedStep?.id === step.id} ready={stepIsReady(step)} onSelect={() => setSelectedStepId(step.id)} />
                  </div>
                ))}
              </div>
            </div>
          )}
          {workflow && <div className="absolute bottom-3 left-4 flex items-center gap-3 text-[9px] text-slate-400"><span className="flex items-center gap-1"><Network className="size-3" />{steps.length} nodes</span><span>{readySteps}/{steps.length} ready</span></div>}
        </section>

        <section className="flex min-h-0 flex-1 flex-col bg-[#f8f5ef]">
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
            {!workflow && !isBuilding && !error && (
              <div className="flex items-start gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd]"><Bot className="size-4 text-[#8a6200]" /></span><div className="max-w-xl rounded-2xl rounded-tl-sm border border-[#e4ddd2] bg-[#fffdfa] px-4 py-3 text-[11px] leading-5 text-slate-600 shadow-sm">Describe an outcome below and I’ll turn it into connected, configurable steps.</div></div>
            )}
            {workflow && (
              <div className="flex items-start gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd]"><Sparkles className="size-4 text-[#8a6200]" /></span><div className="max-w-2xl rounded-2xl rounded-tl-sm border border-[#e4ddd2] bg-[#fffdfa] px-4 py-3 shadow-sm"><p className="text-[11px] font-semibold text-slate-900">{toPlainEnglish(workflow.workflowName)}</p><p className="mt-1 text-[11px] leading-5 text-slate-500">{toPlainEnglish(workflow.summary)}</p><p className="mt-3 text-[9px] font-bold uppercase tracking-[0.12em] text-[#805b00]">What will happen</p><div className="mt-2 grid gap-1.5">{steps.map((step, index) => <p key={step.id} className="text-[10px] leading-4 text-slate-600"><span className="font-semibold text-slate-800">{index + 1}. {stepVisuals[step.type].label}:</span> {toPlainEnglish(step.title)}</p>)}</div></div></div>
            )}
            {isBuilding && <div className="flex items-center gap-3"><span className="flex size-8 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd]"><Bot className="size-4 text-[#8a6200]" /></span><span className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-[#e4ddd2] bg-[#fffdfa] px-4 py-3 text-[11px] text-slate-500 shadow-sm"><LoaderCircle className="size-3.5 animate-spin text-[#b18410]" />Building your workflow…</span></div>}
            {error && <div role="alert" className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[11px] text-rose-700">{error}</div>}
            {planning && planning.status !== "READY_TO_COMPILE" && (
              <div className="mt-3 rounded-xl border border-[#e7c75f] bg-[#fff7dc] px-4 py-3 text-[10px] leading-4 text-slate-700">
                <p className="font-semibold text-slate-900">{planning.status === "NEEDS_CLARIFICATION" ? "A little more detail is needed" : planning.status === "UNSUPPORTED" ? "Not supported yet" : "Requirements conflict"}</p>
                {planning.clarificationQuestions.map((question) => <p key={question} className="mt-1.5">{question}</p>)}
                {planning.requestedUnsupportedCapabilities.map((capability) => <p key={capability.capabilityId} className="mt-1.5">{capability.displayName}: not currently supported.</p>)}
              </div>
            )}
            {logs.length > 0 && <div className={`mt-4 rounded-xl border p-3 ${testSucceeded ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`}><p className="flex items-center gap-2 text-[11px] font-semibold text-slate-900"><CirclePlay className={`size-3.5 ${testSucceeded ? "text-emerald-500" : "text-rose-500"}`} />Test results{testSucceeded && delivered ? " · external delivery acknowledged" : ""}</p><div className="mt-2 space-y-1.5">{logs.map((log, index) => <p key={`${log.message}-${index}`} className="text-[10px] leading-4 text-slate-600">{log.icon} {log.message}</p>)}</div></div>}
          </div>

          <div className="shrink-0 border-t border-[#e4ddd2] bg-[#fffdfa] px-4 pb-4 pt-3 sm:px-5">
            <div className="flex items-end gap-2 rounded-2xl border-[1.5px] border-[#ded6ca] bg-white px-3 py-2.5 shadow-[0_8px_30px_rgba(39,37,54,.06)] transition focus-within:border-[#d7aa2f] focus-within:ring-4 focus-within:ring-[#f4e5ad]">
              <textarea value={prompt} onChange={(event) => { setPrompt(event.target.value); setError(null); setPlanning(null); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void buildAutomation(); } }} rows={1} maxLength={10_000} placeholder={workflow ? "Describe a different automation to replace this one…" : "Describe the automation you want to build…"} className="max-h-28 min-h-8 flex-1 resize-none bg-transparent py-1 text-[12px] leading-5 text-slate-800 outline-none placeholder:text-slate-400" />
              <button type="button" onClick={() => void buildAutomation()} disabled={!prompt.trim() || isBuilding} aria-label={isBuilding ? "Generating workflow" : "Generate workflow"} className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-[#dfbd4c] bg-[#fff2bd] text-[#725300] transition hover:bg-[#f1c94b] hover:text-[#272536] disabled:cursor-not-allowed disabled:opacity-35">{isBuilding ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</button>
            </div>
            {!workflow && <div className="mt-2 flex gap-2 overflow-x-auto pb-0.5">{examples.map((example) => <button key={example} type="button" onClick={() => setPrompt(example)} className="shrink-0 rounded-lg border border-[#ded6ca] bg-[#f8f4ec] px-2.5 py-1.5 text-[9px] text-slate-500 transition hover:border-[#d7aa2f] hover:bg-[#fff7dc] hover:text-[#7f5d00]">{example}</button>)}</div>}
            <div className="mt-2 flex items-center gap-1.5 text-[9px] text-slate-400"><LockKeyhole className="size-3" />Private credentials stay in your workspace</div>
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
        onPublicationChange={changePublication}
        onSaveWebhook={persistWebhookEndpoint}
        onChange={(id, value) => {
          setValues((current) => ({ ...current, [id]: value }));
          setError(null);
          setLogs([]);
        }}
      />
    </div>
  );
}
