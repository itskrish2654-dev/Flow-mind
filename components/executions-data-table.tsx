"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Clock3,
  Activity,
  Download,
  ExternalLink,
  FileText,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";

import {
  exportAllWorkflowExecutions,
  listWorkflowExecutions,
  type WorkflowExecutionRecord,
} from "@/app/actions/executions";
import { retryWorkflowExecution } from "@/app/actions/execute";
import { createDocumentDownloadUrl } from "@/app/actions/documents";
import { AccessibleDialog } from "@/components/accessible-dialog";
import type { Json } from "@/lib/supabase/types";
import type { DataTableColumn } from "@/lib/schemas/workflow";

type JsonObject = Record<string, Json | undefined>;

const executionDateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function asJsonObject(value: Json | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function cleanExecutionKey(key: string): string {
  const readable = key
    .replace(/^step[_-]?\d+[-_]+/i, "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

  return readable
    .replace(/\bAi\b/g, "AI")
    .replace(/\bId\b/g, "ID")
    .replace(/\bPdf\b/g, "PDF")
    .replace(/\bUrl\b/g, "URL");
}

function readableValue(value: Json | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(value);
}

function valueAtPath(data: JsonObject, path: string): Json | undefined {
  if (data[path] !== undefined) return data[path];
  return path.split(".").reduce<Json | undefined>((value, segment) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as JsonObject)[segment];
  }, data);
}

function formatJsonToChips(
  data: JsonObject,
  options: { limit?: number; compact?: boolean } = {},
) {
  const entries = Object.entries(data).filter(
    ([, value]) => value !== null && value !== undefined && value !== "",
  );
  const visibleEntries = options.limit
    ? entries.slice(0, options.limit)
    : entries;

  if (visibleEntries.length === 0) {
    return <span className="text-[10px] text-slate-400">No submitted values</span>;
  }

  return (
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {visibleEntries.map(([key, value]) => (
        <span
          key={key}
          className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-[#ded6ca] bg-[#f8f4ec] px-2.5 py-1 text-[9px] leading-4 text-slate-600"
          title={`${cleanExecutionKey(key)}: ${readableValue(value)}`}
        >
          <span className="shrink-0 font-semibold text-slate-700">
            {cleanExecutionKey(key)}:
          </span>
          <span
            className={
              options.compact
                ? "max-w-[190px] truncate"
                : "min-w-0 whitespace-normal break-words"
            }
          >
            {readableValue(value)}
          </span>
        </span>
      ))}
      {options.limit && entries.length > options.limit && (
        <span className="inline-flex items-center rounded-full bg-[#fff0b9] px-2.5 py-1 text-[9px] font-semibold text-[#8a6200]">
          +{entries.length - options.limit} more
        </span>
      )}
    </div>
  );
}

function executionStatus(execution: WorkflowExecutionRecord): "Success" | "Failed" | "Running" {
  if (["queued", "running"].includes(execution.status)) return "Running";
  if (execution.status === "succeeded") return "Success";
  return "Failed";
}

function statusClasses(status: string): string {
  const normalized = status.toLowerCase();
  if (["delivered", "success", "succeeded", "completed"].includes(normalized)) {
    return "bg-emerald-50 text-emerald-700 ring-emerald-600/10";
  }
  if (["failed", "partial", "error"].includes(normalized)) {
    return "bg-rose-50 text-rose-700 ring-rose-600/10";
  }
  return "bg-[#fff0b9] text-[#7f5d00] ring-[#d7aa2f]/20";
}

function StatusBadge({ execution }: { execution: WorkflowExecutionRecord }) {
  const status = executionStatus(execution);
  return (
    <span
      role={status === "Running" ? "status" : undefined}
      className={`inline-flex rounded-full px-2.5 py-1 text-[9px] font-semibold ring-1 ring-inset ${statusClasses(status)}`}
    >
      {status}
    </span>
  );
}

function ExecutionModeBadge({ triggerType }: { triggerType: string }) {
  const test = triggerType === "manual_test";
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[9px] font-semibold ${test ? "bg-sky-50 text-sky-700" : "bg-emerald-50 text-emerald-700"}`}>{test ? "Test run" : "Live run"}</span>;
}

type CustomerStep = {
  stepId: string;
  capabilityId: string;
  title: string;
  status: string;
  message: string;
};

function executionSteps(value: Json): CustomerStep[] {
  const steps = asJsonObject(value).steps;
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return [];
    const item = step as JsonObject;
    if (typeof item.title !== "string" || typeof item.status !== "string") return [];
    return [{
      stepId: typeof item.stepId === "string" ? item.stepId : "",
      capabilityId: typeof item.capabilityId === "string" ? item.capabilityId : "",
      title: item.title,
      status: item.status,
      message: typeof item.message === "string" ? item.message : "",
    }];
  });
}

function customerMessage(message: string): string {
  return message
    .replace(/FlowMind/g, "CrazyLoops")
    .replace(/\bworkflow\b/gi, "loop")
    .replace(/provider acknowledgement/gi, "destination confirmation")
    .replace(/^Skipped — condition not matched\.$/i, "Not needed because its condition did not match.");
}

function triggerDescription(triggerType: string): string {
  if (triggerType === "manual_test") return "Started manually with test data";
  if (triggerType === "public_form") return "Started by a public form submission";
  if (["schedule", "scheduled"].includes(triggerType)) return "Started by its schedule";
  if (triggerType === "connector_webhook") return "Started by a connected app event";
  if (triggerType.includes("webhook")) return "Started by an incoming webhook";
  return "Started automatically";
}

function resultDescription(execution: WorkflowExecutionRecord): string {
  const status = executionStatus(execution);
  if (status === "Running") return "CrazyLoops is working through this loop.";
  const output = asJsonObject(execution.outputData);
  const steps = executionSteps(execution.outputData);
  const stopped = steps.find((step) => ["failed", "unsupported"].includes(step.status));
  if (status === "Failed") {
    if (stopped) return `Stopped at: ${stopped.title}. ${customerMessage(stopped.message)}`;
    const summary = typeof output.summary === "string" ? customerMessage(output.summary) : "This run stopped before it could finish.";
    return summary;
  }
  if (executionDocuments(execution.outputData).length > 0) return "Created a document and completed the loop.";
  if (output.delivered === true) return "Completed the loop and the destination confirmed receipt.";
  const lastCompleted = steps.findLast((step) => step.status === "succeeded");
  if (lastCompleted?.message) return customerMessage(lastCompleted.message);
  return "Completed the loop successfully.";
}

function humanTimestamp(value: string): string {
  return executionDateFormatter.format(new Date(value));
}

function timelineStatus(status: string): string {
  if (status === "succeeded") return "Completed";
  if (status === "running" || status === "pending") return "In progress";
  if (status === "failed") return "Stopped";
  if (status === "unsupported") return "Needs attention";
  return "Not run";
}

function timelineClasses(status: string): string {
  if (status === "succeeded") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (["failed", "unsupported"].includes(status)) return "border-rose-200 bg-rose-50 text-rose-700";
  if (["running", "pending"].includes(status)) return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-500";
}

function executionDocuments(value: Json): Array<{ id: string; filename: string }> {
  const output = asJsonObject(value);
  const documents: Array<{ id: string; filename: string }> = [];

  if (Array.isArray(output.documents)) {
    for (const item of output.documents) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      if (typeof item.id !== "string") continue;
      if (documents.some((document) => document.id === item.id)) continue;
      documents.push({
        id: item.id,
        filename:
          typeof item.filename === "string" ? item.filename : "Generated document.pdf",
      });
    }
  }

  return documents;
}

function SecureDocumentButton({
  document,
  label,
}: {
  document: { id: string; filename: string };
  label: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await createDocumentDownloadUrl(document.id);
            if (!result.ok) {
              setError(result.error);
              return;
            }
            window.location.assign(result.url);
          });
        }}
        className="flex min-h-11 w-full items-center gap-3 rounded-xl border border-[#e7c75f] bg-[#fff7dc] px-3.5 py-2.5 text-[10px] font-semibold text-[#7f5d00] transition hover:bg-[#fff0b9] disabled:opacity-60"
      >
        {pending ? <LoaderCircle className="size-4 shrink-0 animate-spin" /> : <FileText className="size-4 shrink-0" />}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ExternalLink className="size-3.5 shrink-0" />
      </button>
      {error && <p className="mt-1 text-[9px] text-rose-600">{error}</p>}
    </div>
  );
}

function httpExecutionResults(value: Json) {
  const results = asJsonObject(asJsonObject(value).http_results);
  return Object.entries(results).flatMap(([stepId, raw]) => {
    const result = asJsonObject(raw);
    if (typeof result.status !== "number") return [];
    return [{
      stepId,
      method: typeof result.method === "string" ? result.method : "HTTP",
      status: result.status,
      durationMs: typeof result.durationMs === "number" ? result.durationMs : null,
      acknowledged: result.acknowledged === true,
      body: typeof result.body === "string" ? result.body : "",
    }];
  });
}

function httpStatusLabel(status: number): string {
  const labels: Record<number, string> = { 200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 429: "Too Many Requests", 500: "Server Error", 502: "Bad Gateway", 503: "Unavailable", 504: "Gateway Timeout" };
  return `${status}${labels[status] ? ` ${labels[status]}` : ""}`;
}

function ExecutionDetailsDrawer({
  execution,
  onClose,
  onRetry,
  columns,
}: {
  execution: WorkflowExecutionRecord | null;
  onClose: () => void;
  onRetry: (execution: WorkflowExecutionRecord) => void;
  columns: DataTableColumn[];
}) {
  if (!execution) return null;

  const output = asJsonObject(execution.outputData);
  const summary = typeof output.summary === "string" ? output.summary : null;
  const aiResult = typeof output.ai_result === "string" ? output.ai_result : null;
  const documents = executionDocuments(execution.outputData);
  const httpResults = httpExecutionResults(execution.outputData);
  const steps = executionSteps(execution.outputData);
  const status = executionStatus(execution);
  const submitted = asJsonObject(execution.inputData);
  const configuredInputEntries = columns
    .filter((column) => column.source === "input")
    .flatMap((column) => {
      const value = valueAtPath(submitted, column.key);
      return value === undefined ? [] : [[column.label, value] as const];
    });
  const configuredKeys = new Set(columns.filter((column) => column.source === "input").map((column) => column.key));
  const submittedData = Object.fromEntries([
    ...configuredInputEntries,
    ...Object.entries(submitted).filter(([key]) => !configuredKeys.has(key)),
  ]);
  const startedAt = execution.startedAt ?? execution.createdAt;
  const durationMs = execution.completedAt
    ? Math.max(0, new Date(execution.completedAt).getTime() - new Date(startedAt).getTime())
    : null;

  return (
    <AccessibleDialog open={Boolean(execution)} onOpenChange={(open) => { if (!open) onClose(); }} title="Run details" description="What started this run, what CrazyLoops did, and the result." side="right" showClose={false}>
      <aside
        className="relative flex h-full w-full max-w-lg flex-col bg-[#fffdfa] shadow-2xl"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-[#e4ddd2] px-5 py-4 sm:px-6">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]">
            <Activity className="size-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 id="execution-details-title" className="text-sm font-semibold text-slate-950">
              Run details
            </h3>
            <p className="mt-1 text-[10px] text-slate-400">
              {humanTimestamp(execution.createdAt)}
            </p>
          </div>
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-[#ded6ca] text-slate-500 transition hover:bg-[#f8f4ec] hover:text-[#272536]"
            aria-label="Close details"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge execution={execution} />
            <ExecutionModeBadge triggerType={execution.triggerType} />
          </div>

          <section className="mt-6" aria-labelledby="what-happened-heading">
            <h4 id="what-happened-heading" className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              What happened
            </h4>
            {steps.length > 0 ? (
              <ol className="mt-3 space-y-2">
                {steps.map((step, index) => (
                  <li key={`${step.stepId}-${index}`} className="relative flex gap-3 rounded-xl border border-[#e4ddd2] bg-[#fffdfa] p-3">
                    <span className={`flex size-7 shrink-0 items-center justify-center rounded-full border ${timelineClasses(step.status)}`} aria-hidden="true">
                      {step.status === "succeeded" ? <CheckCircle2 className="size-3.5" /> : step.status === "running" || step.status === "pending" ? <LoaderCircle className="size-3.5 animate-spin" /> : <span className="text-[10px] font-bold">{index + 1}</span>}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[10px] font-semibold text-slate-800">{step.title}</p>
                        <span className={`text-[9px] font-semibold ${["failed", "unsupported"].includes(step.status) ? "text-rose-700" : step.status === "succeeded" ? "text-emerald-700" : "text-slate-500"}`}>{timelineStatus(step.status)}</span>
                      </div>
                      {step.message && <p className="mt-1 text-[10px] leading-5 text-slate-500">{customerMessage(step.message)}</p>}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-3 rounded-xl bg-[#f8f4ec] px-3 py-2.5 text-[10px] text-slate-500">Run details will appear as CrazyLoops processes each step.</p>
            )}
          </section>

          <section className="mt-6" aria-labelledby="result-heading">
            <h4 id="result-heading" className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">Result</h4>
            <div className={`mt-3 rounded-xl border p-4 ${status === "Success" ? "border-emerald-200 bg-emerald-50" : status === "Failed" ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50"}`}>
              <p className={`text-[11px] font-semibold ${status === "Success" ? "text-emerald-800" : status === "Failed" ? "text-rose-800" : "text-amber-800"}`}>{resultDescription(execution)}</p>
              {status === "Failed" && <p className="mt-2 text-[10px] leading-5 text-rose-700">Check the stopped step’s setup, then retry it when you’re ready.</p>}
              {status === "Failed" && (
                <button type="button" onClick={() => onRetry(execution)} className="mt-3 min-h-9 rounded-lg border border-rose-200 bg-white px-3 text-[10px] font-semibold text-rose-700 hover:bg-rose-50">Retry stopped step</button>
              )}
            </div>
          </section>

          <section className="mt-6" aria-labelledby="submitted-data-heading">
            <h4 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              <span id="submitted-data-heading">Submitted data</span>
            </h4>
            <div className="mt-3">
              {formatJsonToChips(submittedData)}
            </div>
          </section>

          {(summary || aiResult) && (
            <section className="mt-6 space-y-3">
              <h4 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                AI result
              </h4>
              {aiResult && (
                <div className="rounded-xl border border-[#e7c75f] bg-[#fff7dc] p-4">
                  <p className="flex items-center gap-2 text-[10px] font-semibold text-[#7f5d00]">
                    <Sparkles className="size-3.5" /> AI result
                  </p>
                  <p className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-5 text-[#4f421f]">
                    {aiResult}
                  </p>
                </div>
              )}
              {!aiResult && summary && (
                <div className="rounded-xl border border-[#ded6ca] bg-[#f8f4ec] p-4">
                  <p className="whitespace-pre-wrap break-words text-[11px] leading-5 text-slate-600">{customerMessage(summary)}</p>
                </div>
              )}
            </section>
          )}

          {documents.length > 0 && (
            <section className="mt-6">
              <h4 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                Documents
              </h4>
              <div className="mt-3 grid gap-2">
                {documents.map((document, index) => (
                  <SecureDocumentButton
                    key={document.id}
                    document={document}
                    label={documents.length === 1 ? "Download PDF" : `Download PDF ${index + 1}`}
                  />
                ))}
              </div>
            </section>
          )}

          <details className="mt-6 rounded-xl border border-[#ded6ca] bg-[#f8f4ec] p-4 text-[10px] text-slate-500">
            <summary className="cursor-pointer font-semibold text-slate-700">Technical details</summary>
            <dl className="mt-3 grid gap-2 sm:grid-cols-2">
              <div><dt className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">Run ID</dt><dd className="mt-0.5 break-all">{execution.id}</dd></div>
              {execution.workflowVersionId && <div><dt className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">Setup ID</dt><dd className="mt-0.5 break-all">{execution.workflowVersionId}</dd></div>}
              <div><dt className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">Started</dt><dd className="mt-0.5">{executionDateFormatter.format(new Date(startedAt))}</dd></div>
              {durationMs !== null && <div><dt className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">Duration</dt><dd className="mt-0.5">{durationMs} ms</dd></div>}
              {execution.failureCategory && <div><dt className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">Failure category</dt><dd className="mt-0.5">{cleanExecutionKey(execution.failureCategory)}</dd></div>}
            </dl>
            {httpResults.length > 0 && (
              <div className="mt-4 space-y-2">
                <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">Request responses</p>
                {httpResults.map((result) => (
                  <p key={result.stepId} className="rounded-lg bg-white px-3 py-2">{result.method} · {httpStatusLabel(result.status)} · {result.acknowledged ? "Confirmed" : "Not confirmed"}{result.durationMs !== null ? ` · ${result.durationMs} ms` : ""}</p>
                ))}
              </div>
            )}
          </details>
        </div>
      </aside>
    </AccessibleDialog>
  );
}

export function ExecutionsDataTable({
  workflowId,
  initialExecutions,
  initialNextCursor,
  columns,
}: {
  workflowId: string;
  initialExecutions: WorkflowExecutionRecord[];
  initialNextCursor: string | null;
  columns: DataTableColumn[];
}) {
  const [executions, setExecutions] = useState(initialExecutions);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [selectedExecution, setSelectedExecution] =
    useState<WorkflowExecutionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, startRefresh] = useTransition();
  const [isExporting, startExport] = useTransition();

  const closeDetails = useCallback(() => setSelectedExecution(null), []);
  const refresh = useCallback(() => {
    startRefresh(async () => {
      const result = await listWorkflowExecutions(workflowId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setExecutions(result.executions);
      setNextCursor(result.nextCursor);
      setError(null);
    });
  }, [workflowId]);

  useEffect(() => {
    const handleExecution = (event: Event) => {
      const executionWorkflowId = (event as CustomEvent<string>).detail;
      if (executionWorkflowId === workflowId) refresh();
    };
    window.addEventListener("flowmind:executions-changed", handleExecution);
    return () => {
      window.removeEventListener("flowmind:executions-changed", handleExecution);
    };
  }, [refresh, workflowId]);

  function exportCsv() {
    startExport(async () => {
      const result = await exportAllWorkflowExecutions(workflowId);
      if (!result.ok) return setError(result.error);
      const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `crazyloops-executions-${workflowId}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      setError(result.truncated ? "Export reached the documented 10,000-row safety limit." : null);
    });
  }

  function loadMore() {
    if (!nextCursor) return;
    startRefresh(async () => {
      const result = await listWorkflowExecutions(workflowId, nextCursor);
      if (!result.ok) return setError(result.error);
      setExecutions((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...result.executions.filter((item) => !known.has(item.id))];
      });
      setNextCursor(result.nextCursor);
    });
  }

  function retryExecution(execution: WorkflowExecutionRecord) {
    startRefresh(async () => {
      const result = await retryWorkflowExecution(execution.id);
      if (!result.ok) setError(result.error);
      refresh();
    });
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#f8f5ef]">
      <header className="flex min-h-[65px] shrink-0 flex-wrap items-center gap-3 border-b border-[#e4ddd2] bg-[#fffdfa] px-4 py-3 sm:px-6">
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
          <h2 className="text-[13px] font-semibold text-slate-950">Activity</h2>
          <p className="mt-0.5 text-[10px] text-slate-500">See what your loop has done.</p>
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <button
            type="button"
            onClick={refresh}
            disabled={isRefreshing}
            aria-label="Refresh activity"
            className="flex h-9 items-center gap-2 rounded-lg border border-[#ded6ca] bg-white px-3 text-[10px] font-medium text-slate-600 transition hover:border-[#d7aa2f] hover:bg-[#fff7dc] disabled:opacity-50"
          >
            {isRefreshing ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            <span className="hidden sm:inline">Refresh</span>
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={executions.length === 0 || isExporting}
            className="flex h-9 items-center gap-2 rounded-lg border border-[#dcd4c8] bg-transparent px-3 text-[10px] font-semibold text-[#272536] transition hover:border-[#d7aa2f] hover:bg-[#fff8e3] disabled:opacity-40"
          >
            <Download className="size-3.5" />
            {isExporting ? "Preparing export..." : "Export activity (max 10,000)"}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {error && (
          <p role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">
            {error}
          </p>
        )}

        {executions.length === 0 ? (
          <div className="flex min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-[#ded6ca] bg-[#fffdfa] text-center">
            <div className="max-w-xs px-6">
              <span className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]">
                <Activity className="size-5" />
              </span>
              <h3 className="mt-4 text-sm font-semibold text-slate-900">No activity yet.</h3>
              <p className="mt-2 text-[11px] leading-5 text-slate-500">
                Test your loop or activate it to see what happens here.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="hidden grid-cols-[100px_90px_120px_minmax(160px,1fr)_minmax(200px,1.25fr)_auto] gap-3 rounded-t-2xl border border-b-0 border-[#e4ddd2] bg-[#f8f4ec] px-4 py-3 text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-400 lg:grid">
              <span>Status</span><span>Run</span><span>When</span><span>What started it</span><span>Result</span><span className="text-right">Details</span>
            </div>
            <div className="space-y-3 lg:space-y-0 lg:overflow-hidden lg:rounded-b-2xl lg:border lg:border-[#e4ddd2] lg:bg-[#fffdfa] lg:shadow-sm">
              {executions.map((execution) => (
                <article key={execution.id} className="grid min-w-0 gap-4 rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-4 shadow-sm lg:grid-cols-[100px_90px_120px_minmax(160px,1fr)_minmax(200px,1.25fr)_auto] lg:items-center lg:gap-3 lg:rounded-none lg:border-0 lg:border-b lg:border-slate-100 lg:shadow-none lg:last:border-b-0">
                  <div><span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-slate-400 lg:hidden">Status</span><StatusBadge execution={execution} /></div>
                  <div><span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-slate-400 lg:hidden">Run</span><ExecutionModeBadge triggerType={execution.triggerType} /></div>
                  <div className="min-w-0">
                    <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-slate-400 lg:hidden">When</span>
                    <p className="flex items-center gap-1.5 text-[10px] text-slate-500" title={executionDateFormatter.format(new Date(execution.createdAt))}><Clock3 className="size-3 shrink-0" />{humanTimestamp(execution.createdAt)}</p>
                  </div>
                  <div className="min-w-0">
                    <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-slate-400 lg:hidden">What started it</span>
                    <p className="text-[10px] leading-5 text-slate-700">{triggerDescription(execution.triggerType)}</p>
                  </div>
                  <div className="min-w-0">
                    <span className="mb-1 block text-[9px] font-semibold uppercase tracking-wide text-slate-400 lg:hidden">Result</span>
                    <p className={`line-clamp-2 text-[10px] leading-5 ${executionStatus(execution) === "Failed" ? "text-rose-700" : "text-slate-600"}`} title={resultDescription(execution)}>{resultDescription(execution)}</p>
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    {executionStatus(execution) === "Failed" && (
                      <button type="button" onClick={() => retryExecution(execution)} disabled={isRefreshing} className="min-h-9 rounded-lg border border-[#ded6ca] px-3 text-[10px] font-semibold text-slate-600 disabled:opacity-50">Retry</button>
                    )}
                    <button type="button" onClick={() => setSelectedExecution(execution)} className="flex min-h-9 items-center gap-1.5 rounded-lg border border-[#ded6ca] bg-white px-3 text-[10px] font-semibold text-slate-600 transition hover:border-[#d7aa2f] hover:bg-[#fff7dc] hover:text-[#7f5d00]">
                      View details <ChevronRight className="size-3.5" />
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {nextCursor && (
              <button type="button" onClick={loadMore} disabled={isRefreshing} className="mx-auto mt-5 flex h-9 items-center rounded-lg border border-[#ded6ca] bg-white px-4 text-[10px] font-semibold text-slate-600 disabled:opacity-50">
                {isRefreshing ? "Loading..." : "Load older activity"}
              </button>
            )}
          </>
        )}
      </div>

      <ExecutionDetailsDrawer execution={selectedExecution} onClose={closeDetails} onRetry={retryExecution} columns={columns} />
    </section>
  );
}
