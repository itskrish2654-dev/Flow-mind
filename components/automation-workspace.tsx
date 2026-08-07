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
  LockKeyhole,
  Network,
  Play,
  Save,
  Send,
  Sparkles,
  Workflow,
  Zap,
} from "lucide-react";

import { runTestWorkflow, type TestExecutionLog } from "@/app/actions/execute";
import { compileWorkflow, saveDocumentTemplate } from "@/app/actions/workflow";
import { getPublicFormPath, getPublicFormUrl } from "@/lib/public-form";
import type { CompiledWorkflow, StepInput } from "@/lib/schemas/workflow";
import { getStepInputs, orderWorkflowSteps, toPlainEnglish } from "@/lib/workflow-setup";

type Step = CompiledWorkflow["steps"][number];
type InputValues = Record<string, string>;

type AutomationWorkspaceProps = {
  initialWorkflow?: CompiledWorkflow | null;
  initialWorkflowId?: string | null;
};

const examples = [
  "Summarize customer emails and send them to Slack",
  "Welcome every new customer with a personal message",
  "Check new leads and tell my sales team about the best ones",
];

const stepVisuals = {
  webhook_trigger: { label: "Trigger", icon: Zap, tone: "emerald" },
  ai_transform: { label: "AI Process", icon: Sparkles, tone: "indigo" },
  http_request: { label: "Destination", icon: Send, tone: "violet" },
  generate_pdf: { label: "PDF Document", icon: FileText, tone: "rose" },
  filter_condition: { label: "Condition", icon: Filter, tone: "amber" },
} as const;

const toneClasses = {
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-600",
  indigo: "border-indigo-200 bg-indigo-50 text-indigo-600",
  violet: "border-violet-200 bg-violet-50 text-violet-600",
  rose: "border-rose-200 bg-rose-50 text-rose-600",
  amber: "border-amber-200 bg-amber-50 text-amber-600",
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

function WorkflowNode({ step, index, selected, ready, onSelect }: { step: Step; index: number; selected: boolean; ready: boolean; onSelect: () => void }) {
  const visual = stepVisuals[step.type];
  const Icon = visual.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-[185px] shrink-0 rounded-xl border bg-white p-3.5 text-left shadow-[0_14px_34px_rgba(15,23,42,.08)] transition hover:-translate-y-0.5 hover:border-indigo-400 ${selected ? "border-indigo-400 ring-4 ring-indigo-100" : "border-slate-200"}`}
    >
      <span className="flex items-center gap-2.5">
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-[10px] border ${toneClasses[visual.tone]}`}><Icon className="size-4" /></span>
        <span className="min-w-0"><span className="block text-[9px] uppercase tracking-[0.1em] text-slate-400">Step {index + 1} · {visual.label}</span><span className="mt-1 block truncate text-[12px] font-semibold text-slate-900">{toPlainEnglish(step.title)}</span></span>
      </span>
      <span className={`mt-3 flex items-center gap-1.5 text-[10px] ${ready ? "text-emerald-400" : "text-amber-400"}`}>
        {ready ? <CheckCircle2 className="size-3" /> : <CircleDot className="size-3" />}
        {ready ? "Ready" : "Setup needed"}
      </span>
    </button>
  );
}

function EmptyCanvas() {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center">
      <div>
        <span className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-indigo-500/20 bg-indigo-500/10 text-indigo-400"><Network className="size-5" /></span>
        <h2 className="mt-4 text-[13px] font-semibold text-slate-900">Your workflow will appear here</h2>
        <p className="mx-auto mt-1.5 max-w-sm text-[11px] leading-5 text-slate-500">Describe what you want below. The generated steps will become a real, selectable workflow.</p>
      </div>
    </div>
  );
}

function Inspector({
  step,
  workflowId,
  inputs,
  values,
  onChange,
  onSaveTemplate,
}: {
  step: Step | null;
  workflowId: string | null;
  inputs: StepInput[];
  values: InputValues;
  onChange: (id: string, value: string) => void;
  onSaveTemplate: (stepId: string, template: string) => Promise<string | null>;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [templateStatus, setTemplateStatus] = useState<string | null>(null);
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);

  async function copyValue(id: string, value: string) {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(id);
    window.setTimeout(() => setCopied(null), 1500);
  }

  if (!step) {
    return (
      <aside className="hidden w-[292px] shrink-0 flex-col border-l border-slate-200 bg-white xl:flex">
        <div className="flex h-[65px] items-center border-b border-slate-200 px-5"><span className="text-[12px] font-semibold text-slate-900">Step setup</span></div>
        <div className="flex flex-1 items-center justify-center p-6 text-center"><div><Info className="mx-auto size-5 text-slate-300" /><p className="mt-3 text-[11px] text-slate-400">Build a workflow, then select a step to configure it.</p></div></div>
      </aside>
    );
  }

  const visual = stepVisuals[step.type];
  const Icon = visual.icon;
  const publicFormPath = workflowId ? getPublicFormPath(workflowId) : null;
  return (
    <aside className="hidden w-[292px] shrink-0 flex-col border-l border-slate-200 bg-white xl:flex">
      <div className="flex min-h-[65px] items-center gap-2.5 border-b border-slate-200 px-4">
        <span className={`flex size-8 shrink-0 items-center justify-center rounded-[10px] border ${toneClasses[visual.tone]}`}><Icon className="size-3.5" /></span>
        <span className="min-w-0"><span className="block text-[9px] uppercase tracking-[0.1em] text-slate-400">{visual.label}</span><span className="block truncate text-[12px] font-semibold text-slate-900">{toPlainEnglish(step.title)}</span></span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="text-[11px] leading-5 text-slate-500">{toPlainEnglish(step.description)}</p>
        <div className="my-4 h-px bg-slate-100" />
        {step.type === "webhook_trigger" && publicFormPath && (
          <div className="mb-4 rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-violet-50 p-3.5">
            <p className="text-[10px] font-semibold text-slate-900">Your hosted form is ready</p>
            <p className="mt-1 text-[9px] leading-4 text-slate-500">
              Share this link to collect information and start the automation.
            </p>
            <div className="mt-3 grid gap-2">
              <button
                type="button"
                onClick={() => {
                  if (workflowId) {
                    void copyValue(
                      "public-form",
                      getPublicFormUrl(workflowId, window.location.origin),
                    );
                  }
                }}
                className="flex h-9 items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-[10px] font-semibold text-white shadow-md shadow-indigo-100 transition hover:brightness-110"
              >
                {copied === "public-form" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied === "public-form" ? "Link copied" : "Copy Public Form Link"}
              </button>
              <a
                href={publicFormPath}
                target="_blank"
                rel="noreferrer"
                className="flex h-9 items-center justify-center gap-2 rounded-lg border border-indigo-200 bg-white text-[10px] font-semibold text-indigo-700 transition hover:bg-indigo-50"
              >
                <ExternalLink className="size-3.5" />
                Preview Form
              </a>
            </div>
          </div>
        )}
        {step.type === "http_request" && workflowId && (
          <div className="mb-4 rounded-xl border border-violet-200 bg-gradient-to-br from-violet-50 to-indigo-50 p-3.5">
            <p className="text-[10px] font-semibold text-slate-900">Internal data table connected</p>
            <p className="mt-1 text-[9px] leading-4 text-slate-500">
              Every form submission and test result is saved automatically.
            </p>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event("flowmind:show-executions"))}
              className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-violet-200 bg-white text-[10px] font-semibold text-violet-700 transition hover:bg-violet-50"
            >
              <Database className="size-3.5" />
              View Executions &amp; Data
            </button>
          </div>
        )}
        {step.type === "generate_pdf" && (
          <div className="mb-4 rounded-xl border border-rose-200 bg-gradient-to-br from-rose-50 to-orange-50 p-3.5">
            <p className="flex items-center gap-2 text-[10px] font-semibold text-slate-900">
              <FileText className="size-3.5 text-rose-500" />
              Native PDF generator
            </p>
            <p className="mt-1 text-[9px] leading-4 text-slate-500">
              Use variables from the form or earlier steps with double curly braces, such as {"{{name}}"} and {"{{ai_summary}}"}.
            </p>
          </div>
        )}
        {inputs.length === 0 ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center"><CheckCircle2 className="mx-auto size-5 text-emerald-500" /><p className="mt-2 text-[11px] font-medium text-slate-900">{step.type === "webhook_trigger" ? "Native form connected" : step.type === "http_request" ? "Native data table connected" : "No setup needed"}</p></div>
        ) : (
          <div className="space-y-4">
            <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">Required details</p>
            {inputs.map((input) => {
              const id = inputId(step.id, input.key);
              const value = values[id] ?? input.value ?? "";
              return (
                <div key={id}>
                  <label htmlFor={id} className="block text-[10px] font-medium leading-4 text-slate-700">{toPlainEnglish(input.label)}</label>
                  {input.helpText && <p className="mt-1 text-[9px] leading-4 text-slate-400">{toPlainEnglish(input.helpText)}</p>}
                  {step.type === "generate_pdf" && input.key === "document_template" ? (
                    <>
                      <textarea
                        id={id}
                        rows={13}
                        maxLength={50_000}
                        value={value}
                        onChange={(event) => {
                          onChange(id, event.target.value);
                          setTemplateStatus(null);
                        }}
                        placeholder={input.placeholder}
                        spellCheck
                        className="mt-2 w-full resize-y rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2.5 font-mono text-[10px] leading-5 text-slate-800 outline-none placeholder:text-slate-400 focus:border-rose-400 focus:bg-white focus:ring-4 focus:ring-rose-50"
                      />
                      <button
                        type="button"
                        disabled={!workflowId || !value.trim() || isSavingTemplate}
                        onClick={async () => {
                          setIsSavingTemplate(true);
                          const saveError = await onSaveTemplate(step.id, value);
                          setTemplateStatus(saveError ?? "Template saved for future runs.");
                          setIsSavingTemplate(false);
                        }}
                        className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-br from-rose-500 to-orange-500 text-[10px] font-semibold text-white shadow-md shadow-rose-100 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {isSavingTemplate ? <LoaderCircle className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                        {isSavingTemplate ? "Saving…" : "Save Document Template"}
                      </button>
                      {templateStatus && (
                        <p className={`mt-2 text-[9px] leading-4 ${templateStatus.startsWith("Template saved") ? "text-emerald-600" : "text-rose-600"}`}>
                          {templateStatus}
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="relative mt-2">
                      <input
                        id={id}
                        type={input.type === "secret" ? "password" : input.type === "url" ? "url" : "text"}
                        value={value}
                        onChange={(event) => onChange(id, event.target.value)}
                        placeholder={input.placeholder}
                        autoComplete={input.type === "secret" ? "off" : undefined}
                        className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50/70 px-3 pr-9 text-[10px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-indigo-400 focus:bg-white focus:ring-4 focus:ring-indigo-50"
                      />
                      {input.type === "url" && value && <button type="button" onClick={() => void copyValue(id, value)} className="absolute right-1 top-1 flex size-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-800">{copied === id ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}</button>}
                    </div>
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
}: AutomationWorkspaceProps) {
  const router = useRouter();
  const initialSteps = initialWorkflow
    ? orderWorkflowSteps(initialWorkflow.steps)
    : [];
  const [prompt, setPrompt] = useState("");
  const [workflow, setWorkflow] = useState<CompiledWorkflow | null>(initialWorkflow);
  const [workflowId, setWorkflowId] = useState<string | null>(initialWorkflowId);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(
    initialSteps[0]?.id ?? null,
  );
  const [values, setValues] = useState<InputValues>(() =>
    defaultInputValues(initialWorkflow, initialWorkflowId),
  );
  const [isBuilding, setIsBuilding] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<TestExecutionLog[]>([]);
  const [delivered, setDelivered] = useState<boolean | null>(null);
  const buildRequestInFlight = useRef(false);

  const steps = useMemo(() => workflow ? orderWorkflowSteps(workflow.steps) : [], [workflow]);
  const selectedStep = steps.find((step) => step.id === selectedStepId) ?? steps[0] ?? null;
  const selectedInputs = selectedStep && !["webhook_trigger", "http_request"].includes(selectedStep.type)
    ? getStepInputs(selectedStep, workflowId)
    : [];

  function inputsFor(step: Step) {
    if (step.type === "webhook_trigger" || step.type === "http_request") return [];
    return getStepInputs(step, workflowId);
  }

  function stepIsReady(step: Step) {
    return inputsFor(step).every((input) => (values[inputId(step.id, input.key)] ?? input.value ?? "").trim());
  }

  const readySteps = steps.filter(stepIsReady).length;
  const workflowReady = steps.length > 0 && readySteps === steps.length;

  const resetBuilder = useCallback(() => {
    setWorkflow(null);
    setWorkflowId(null);
    setSelectedStepId(null);
    setValues({});
    setPrompt("");
    setLogs([]);
    setDelivered(null);
    setError(null);
    window.dispatchEvent(new CustomEvent("flowmind:active-workflow", { detail: null }));
    if (window.location.pathname !== "/dashboard") {
      router.push("/dashboard");
    }
  }, [router]);

  useEffect(() => {
    if (!initialWorkflow || !initialWorkflowId) return;

    const restoreTimer = window.setTimeout(() => {
      const ordered = orderWorkflowSteps(initialWorkflow.steps);
      let savedValues: InputValues = {};
      try {
        savedValues = JSON.parse(
          window.localStorage.getItem(`flowmind:values:${initialWorkflowId}`) ?? "{}",
        ) as InputValues;
      } catch {
        savedValues = {};
      }

      setValues(
        Object.fromEntries(
          ordered.flatMap((step) =>
            getStepInputs(step, initialWorkflowId).map((input) => {
              const id = inputId(step.id, input.key);
              return [id, savedValues[id] ?? input.value ?? ""];
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
  }, [initialWorkflow, initialWorkflowId]);

  useEffect(() => {
    const reset = () => resetBuilder();
    window.addEventListener("flowmind:new-workflow", reset);
    return () => {
      window.removeEventListener("flowmind:new-workflow", reset);
    };
  }, [resetBuilder]);

  useEffect(() => {
    if (!workflowId || !workflow) return;
    window.localStorage.setItem(`flowmind:values:${workflowId}`, JSON.stringify(values));
    const wasWorking = window.localStorage.getItem(`flowmind:status:${workflowId}`) === "working";
    const status = workflowReady ? (wasWorking ? "Working" : "Ready") : "Draft";
    if (!workflowReady) window.localStorage.removeItem(`flowmind:status:${workflowId}`);
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
    try {
      const result = await compileWorkflow(description);
      if (!result.success) {
        setError(result.error);
        return;
      }
      const ordered = orderWorkflowSteps(result.workflow.steps);
      const initialValues = Object.fromEntries(ordered.flatMap((step) => getStepInputs(step, result.id).map((input) => [inputId(step.id, input.key), input.value ?? ""])));
      setWorkflow(result.workflow);
      setWorkflowId(result.id);
      setValues(initialValues);
      setSelectedStepId(ordered[0]?.id ?? null);
      setPrompt("");
      window.dispatchEvent(new CustomEvent("flowmind:active-workflow", { detail: result.id }));
      window.dispatchEvent(new Event("flowmind:automations-changed"));
      router.push(`/dashboard/projects/${result.id}`);
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
      const result = await runTestWorkflow(workflowId, steps, values);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLogs(result.logs);
      setDelivered(result.delivered);
      window.dispatchEvent(
        new CustomEvent("flowmind:executions-changed", { detail: workflowId }),
      );
      if (result.delivered) {
        window.localStorage.setItem(`flowmind:status:${workflowId}`, "working");
        window.dispatchEvent(new CustomEvent("flowmind:status-changed", { detail: { id: workflowId, status: "Working" } }));
      }
    } catch {
      setError("The test couldn’t run. Please try again.");
    } finally {
      setIsTesting(false);
    }
  }

  async function persistDocumentTemplate(
    stepId: string,
    template: string,
  ): Promise<string | null> {
    try {
      if (!workflowId) return "Create the workflow before saving its template.";
      const result = await saveDocumentTemplate(workflowId, stepId, template);
      if (!result.ok) return result.error;
      setWorkflow(result.workflow);
      return null;
    } catch {
      return "We couldn’t save the document template. Please try again.";
    }
  }

  return (
    <div className="flex h-full min-w-0 overflow-hidden">
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex min-h-[65px] shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-5">
          <div className="flex items-center gap-2 lg:hidden"><span className="flex size-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-indigo-500 to-violet-600 text-white"><Zap className="size-4 fill-current" /></span><span className="font-bold text-slate-950">FlowMind</span></div>
          <div className="hidden min-w-0 items-center gap-2 lg:flex"><Workflow className="size-4 shrink-0 text-indigo-500" /><span className="truncate text-[13px] font-semibold text-slate-900">{workflow ? toPlainEnglish(workflow.workflowName) : "New Automation"}</span></div>
          {workflow && <span className={`hidden rounded-full px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.08em] sm:block ${workflowReady ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400"}`}>{workflowReady ? "Ready" : `${steps.length - readySteps} steps need setup`}</span>}
          <div className="ml-auto flex items-center gap-2">
            {workflow && <button type="button" onClick={resetBuilder} className="hidden h-8 rounded-lg border border-slate-200 bg-white px-3 text-[10px] text-slate-500 transition hover:bg-slate-50 hover:text-slate-900 sm:block">New</button>}
            <button type="button" onClick={() => void runTest()} disabled={!workflow || isTesting} className="flex h-8 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 text-[10px] text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35">{isTesting ? <LoaderCircle className="size-3 animate-spin" /> : <Play className="size-3 fill-current text-emerald-500" />} Test Run</button>
          </div>
        </header>

        <section className="workflow-canvas relative h-[44%] min-h-[260px] shrink-0 overflow-hidden border-b border-slate-200">
          {!workflow ? <EmptyCanvas /> : (
            <div className="h-full overflow-x-auto px-6">
              <div className="flex h-full min-w-max items-center justify-center">
                {steps.map((step, index) => (
                  <div key={step.id} className="flex items-center">
                    {index > 0 && <div className="relative w-12 shrink-0"><div className="h-0.5 bg-gradient-to-r from-indigo-500 to-violet-500" /><span className="absolute right-0 top-1/2 size-1.5 -translate-y-1/2 rotate-45 border-r-2 border-t-2 border-violet-400" /></div>}
                    <WorkflowNode step={step} index={index} selected={selectedStep?.id === step.id} ready={stepIsReady(step)} onSelect={() => setSelectedStepId(step.id)} />
                  </div>
                ))}
              </div>
            </div>
          )}
          {workflow && <div className="absolute bottom-3 left-4 flex items-center gap-3 text-[9px] text-slate-400"><span className="flex items-center gap-1"><Network className="size-3" />{steps.length} nodes</span><span>{readySteps}/{steps.length} ready</span></div>}
        </section>

        <section className="flex min-h-0 flex-1 flex-col bg-[#f8fafc]">
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
            {!workflow && !isBuilding && !error && (
              <div className="flex items-start gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600"><Bot className="size-4 text-white" /></span><div className="max-w-xl rounded-2xl rounded-tl-sm border border-slate-200 bg-white px-4 py-3 text-[11px] leading-5 text-slate-600 shadow-sm">Describe an outcome below and I’ll turn it into connected, configurable steps.</div></div>
            )}
            {workflow && (
              <div className="flex items-start gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600"><Sparkles className="size-4 text-white" /></span><div className="max-w-2xl rounded-2xl rounded-tl-sm border border-slate-200 bg-white px-4 py-3 shadow-sm"><p className="text-[11px] font-semibold text-slate-900">{toPlainEnglish(workflow.workflowName)}</p><p className="mt-1 text-[11px] leading-5 text-slate-500">{toPlainEnglish(workflow.summary)}</p><p className="mt-2 text-[10px] text-indigo-600">Select each node to complete its setup.</p></div></div>
            )}
            {isBuilding && <div className="flex items-center gap-3"><span className="flex size-8 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600"><Bot className="size-4 text-white" /></span><span className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-slate-200 bg-white px-4 py-3 text-[11px] text-slate-500 shadow-sm"><LoaderCircle className="size-3.5 animate-spin text-indigo-500" />Building your workflow…</span></div>}
            {error && <div role="alert" className="mt-3 rounded-xl border border-rose-500/25 bg-rose-500/[.07] px-4 py-3 text-[11px] text-rose-300">{error}</div>}
            {logs.length > 0 && <div className={`mt-4 rounded-xl border p-3 ${delivered ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}><p className="flex items-center gap-2 text-[11px] font-semibold text-slate-900"><CirclePlay className={`size-3.5 ${delivered ? "text-emerald-500" : "text-amber-500"}`} />Test results</p><div className="mt-2 space-y-1.5">{logs.map((log, index) => <p key={`${log.message}-${index}`} className="text-[10px] leading-4 text-slate-600">{log.icon} {log.message}</p>)}</div></div>}
          </div>

          <div className="shrink-0 border-t border-slate-200 bg-white px-4 pb-4 pt-3 sm:px-5">
            <div className="flex items-end gap-2 rounded-2xl border-[1.5px] border-slate-200 bg-white px-3 py-2.5 shadow-[0_8px_30px_rgba(15,23,42,.06)] transition focus-within:border-indigo-400 focus-within:ring-4 focus-within:ring-indigo-50">
              <textarea value={prompt} onChange={(event) => { setPrompt(event.target.value); setError(null); }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void buildAutomation(); } }} rows={1} maxLength={10_000} placeholder={workflow ? "Describe a different automation to replace this one…" : "Describe the automation you want to build…"} className="max-h-28 min-h-8 flex-1 resize-none bg-transparent py-1 text-[12px] leading-5 text-slate-800 outline-none placeholder:text-slate-400" />
              <button type="button" onClick={() => void buildAutomation()} disabled={!prompt.trim() || isBuilding} className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-[0_0_20px_rgba(99,102,241,.25)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35">{isBuilding ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</button>
            </div>
            {!workflow && <div className="mt-2 flex gap-2 overflow-x-auto pb-0.5">{examples.map((example) => <button key={example} type="button" onClick={() => setPrompt(example)} className="shrink-0 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[9px] text-slate-500 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600">{example}</button>)}</div>}
            <div className="mt-2 flex items-center gap-1.5 text-[9px] text-slate-400"><LockKeyhole className="size-3" />Private credentials stay in your workspace</div>
          </div>
        </section>
      </main>

      <Inspector workflowId={workflowId} step={selectedStep} inputs={selectedInputs} values={values} onSaveTemplate={persistDocumentTemplate} onChange={(id, value) => { setValues((current) => ({ ...current, [id]: value })); setError(null); setLogs([]); }} />
    </div>
  );
}
