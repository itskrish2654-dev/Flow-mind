"use client";

import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  CirclePlay,
  LoaderCircle,
  PauseCircle,
  Play,
} from "lucide-react";

import type { TestExecutionLog } from "@/app/actions/execute";
import type { CompiledWorkflow } from "@/lib/schemas/workflow";
import type { WorkflowReadiness } from "@/lib/workflow-readiness";
import { toPlainEnglish } from "@/lib/workflow-setup";

type WorkflowStep = CompiledWorkflow["steps"][number];

function failedStepTitle(
  steps: WorkflowStep[],
  logs: TestExecutionLog[],
): string | null {
  const failed = logs.find((log) => log.status === "failed" && log.stepId);
  return failed?.stepId
    ? toPlainEnglish(
        steps.find((step) => step.id === failed.stepId)?.title ?? "a workflow step",
      )
    : null;
}

function failedStepId(logs: TestExecutionLog[]): string | null {
  return logs.find((log) => log.status === "failed" && log.stepId)?.stepId ?? null;
}

function successfulStepIds(logs: TestExecutionLog[]): Set<string> {
  return new Set(
    logs
      .filter((log) => log.status === "succeeded" && log.stepId)
      .map((log) => log.stepId as string),
  );
}

export function WorkflowJourneyPanel({
  workflow,
  steps,
  readiness,
  published,
  isTesting,
  testSucceeded,
  logs,
  delivered,
  onSelectStep,
  onRunTest,
  onPublicationChange,
}: {
  workflow: CompiledWorkflow;
  steps: WorkflowStep[];
  readiness: WorkflowReadiness;
  published: boolean;
  isTesting: boolean;
  testSucceeded: boolean | null;
  logs: TestExecutionLog[];
  delivered: boolean | null;
  onSelectStep: (stepId: string) => void;
  onRunTest: () => void;
  onPublicationChange: (publish: boolean) => void;
}) {
  const failedTitle = failedStepTitle(steps, logs);
  const stoppedAtStepId = failedStepId(logs);
  const succeededSteps = successfulStepIds(logs);

  return (
    <div className="grid min-w-0 gap-3">
      <section
        aria-labelledby="workflow-readiness-title"
        className="rounded-2xl border border-[#e4ddd2] bg-white p-4 shadow-[0_10px_30px_rgba(39,37,54,.05)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-[#805b00]">
              Setup
            </p>
            <h2 id="workflow-readiness-title" className="mt-1 text-sm font-semibold text-[#272536]">
              {readiness.attention.length > 0
                ? "Needs your attention"
                : "Ready to test"}
            </h2>
          </div>
          <span
            className={`inline-flex min-h-7 items-center rounded-full px-2.5 text-[9px] font-semibold ${readiness.attention.length > 0 ? "bg-[#fff2bd] text-[#765600]" : "bg-emerald-50 text-emerald-700"}`}
          >
            {readiness.attention.length > 0
              ? `${readiness.attention.length} to finish`
              : "Setup complete"}
          </span>
        </div>

        {readiness.attention.length > 0 ? (
          <ul className="mt-3 grid gap-2">
            {readiness.attention.map((item) => (
              <li key={item.key} className="rounded-xl border border-[#eadfcb] bg-[#fffdfa] p-3">
                <p className="text-[11px] font-semibold text-slate-900">{item.title}</p>
                <p className="mt-1 text-[10px] leading-4 text-slate-500">{item.description}</p>
                <button
                  type="button"
                  onClick={() => onSelectStep(item.stepId)}
                  className="mt-2 inline-flex min-h-10 items-center text-[10px] font-semibold text-[#765600] hover:text-[#9a7007]"
                >
                  {item.actionLabel}
                  <ArrowRight className="ml-1 size-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[10px] leading-5 text-slate-500">
            Every required connection and detail is in place. Run a test with sample data before turning the workflow on.
          </p>
        )}
      </section>

      <section
        aria-labelledby="workflow-test-title"
        aria-live="polite"
        className="rounded-2xl border border-[#e4ddd2] bg-white p-4 shadow-[0_10px_30px_rgba(39,37,54,.05)]"
      >
        <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-[#805b00]">Test</p>
        <div className="mt-1 flex items-start gap-2">
          {isTesting ? (
            <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-[#9a7007]" aria-hidden="true" />
          ) : testSucceeded === true ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden="true" />
          ) : testSucceeded === false ? (
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-rose-600" aria-hidden="true" />
          ) : (
            <CirclePlay className="mt-0.5 size-4 shrink-0 text-[#9a7007]" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <h2 id="workflow-test-title" className="text-sm font-semibold text-[#272536]">
              {isTesting
                ? "Testing your workflow…"
                : testSucceeded === true
                  ? "Test successful"
                  : testSucceeded === false
                    ? `Test stopped${failedTitle ? ` at ${failedTitle}` : ""}`
                    : "See what happens before going live"}
            </h2>
            <p className="mt-1 text-[10px] leading-5 text-slate-500">
              {isTesting
                ? "CrazyLoops is running each step in order. Keep this page open."
                : testSucceeded === true
                  ? delivered
                    ? "The workflow finished and the external destination acknowledged the result."
                    : "The workflow finished successfully. Its result was stored in CrazyLoops."
                  : testSucceeded === false
                    ? "No success was assumed. Review the highlighted step, make a change, and try again."
                    : "A test uses your current setup and shows which steps completed."}
            </p>
          </div>
        </div>

        {testSucceeded === true && (
          <ol className="mt-3 grid gap-1.5 border-t border-[#eee8de] pt-3">
            {steps.map((step) => (
              <li key={step.id} className="flex items-start gap-2 text-[10px] leading-4 text-slate-600">
                <Check className={`mt-0.5 size-3 shrink-0 ${succeededSteps.has(step.id) ? "text-emerald-600" : "text-slate-400"}`} aria-hidden="true" />
                <span>{toPlainEnglish(step.title)}</span>
              </li>
            ))}
          </ol>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {testSucceeded === false && stoppedAtStepId && (
            <button
              type="button"
              onClick={() => onSelectStep(stoppedAtStepId)}
              className="inline-flex min-h-10 items-center rounded-xl border border-[#ded6ca] bg-white px-3.5 text-[10px] font-semibold text-slate-700 hover:border-[#d7aa2f]"
            >
              Review failed step
            </button>
          )}
          <button
            type="button"
            onClick={onRunTest}
            disabled={!readiness.testReady || isTesting}
            className="inline-flex min-h-10 items-center rounded-xl border border-[#d7aa2f] bg-[#fff9e8] px-3.5 text-[10px] font-semibold text-[#6f5100] transition hover:bg-[#fff2bd] disabled:cursor-not-allowed disabled:border-[#ded6ca] disabled:bg-[#f8f4ec] disabled:text-slate-400"
          >
            {isTesting ? <LoaderCircle className="mr-1.5 size-3 animate-spin" /> : <Play className="mr-1.5 size-3" />}
            {testSucceeded === null ? "Run test" : "Test again"}
          </button>
          {logs.length > 0 && (
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event("flowmind:show-executions"))}
              className="inline-flex min-h-10 items-center px-2 text-[10px] font-semibold text-slate-600 hover:text-slate-900"
            >
              View in Activity
              <ArrowRight className="ml-1 size-3" aria-hidden="true" />
            </button>
          )}
        </div>
      </section>

      <section
        aria-labelledby="workflow-activation-title"
        className={`rounded-2xl border p-4 shadow-[0_10px_30px_rgba(39,37,54,.05)] ${published ? "border-emerald-200 bg-emerald-50/70" : "border-[#e4ddd2] bg-white"}`}
      >
        <div className="flex items-start gap-2">
          {published ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden="true" />
          ) : (
            <PauseCircle className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden="true" />
          )}
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">Activation</p>
            <h2 id="workflow-activation-title" className="mt-1 text-sm font-semibold text-[#272536]">
              {published ? "Active — this workflow is running" : "Not active yet"}
            </h2>
            <p className="mt-1 text-[10px] leading-5 text-slate-500">
              {published
                ? "New trigger events can run the current workflow. Turn it off before making structural changes."
                : !readiness.activationReady
                  ? "Finish the items above before turning this workflow on."
                  : testSucceeded !== true
                    ? "A successful test is recommended so you know what will happen."
                    : "Your setup is complete and the latest test succeeded."}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onPublicationChange(!published)}
          disabled={!published && !readiness.activationReady}
          className="mt-3 inline-flex min-h-10 items-center rounded-xl border border-[#d7aa2f] bg-transparent px-3.5 text-[10px] font-semibold text-[#6f5100] transition hover:bg-[#fff9e8] disabled:cursor-not-allowed disabled:border-[#ded6ca] disabled:text-slate-400"
        >
          {published ? "Turn off workflow" : "Turn on workflow"}
        </button>
      </section>

      <p className="sr-only">{workflow.workflowName}</p>
    </div>
  );
}
