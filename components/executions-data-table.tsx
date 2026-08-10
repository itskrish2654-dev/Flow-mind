"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Clock3,
  Database,
  Download,
  ExternalLink,
  FileText,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";

import {
  listWorkflowExecutions,
  type WorkflowExecutionRecord,
} from "@/app/actions/executions";
import type { Json } from "@/lib/supabase/types";
import type { DataTableColumn } from "@/lib/schemas/workflow";

type JsonObject = Record<string, Json | undefined>;

const executionDateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

const INTERNAL_OUTPUT_FIELDS = new Set([
  "documents",
  "logs",
  "pdf_url",
]);

const HANDLED_OUTPUT_FIELDS = new Set([
  ...INTERNAL_OUTPUT_FIELDS,
  "ai_result",
  "delivered",
  "status",
  "summary",
]);

function asJsonObject(value: Json): JsonObject {
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

function configuredColumnValue(
  execution: WorkflowExecutionRecord,
  column: DataTableColumn,
): Json | undefined {
  const source = column.source === "input" ? execution.inputData : execution.outputData;
  return valueAtPath(asJsonObject(source), column.key);
}

function ConfiguredValue({
  execution,
  column,
}: {
  execution: WorkflowExecutionRecord;
  column: DataTableColumn;
}) {
  const value = configuredColumnValue(execution, column);
  if (column.source === "output" && column.key === "status") {
    return <StatusBadge value={execution.outputData} />;
  }
  if (
    column.source === "output" &&
    column.key === "pdf_url" &&
    typeof value === "string" &&
    value.startsWith("https://")
  ) {
    return (
      <a href={value} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-[#7f5d00] hover:underline">
        <FileText className="size-3.5" /> Download PDF
      </a>
    );
  }
  return <span className="block max-w-[230px] truncate text-[10px] text-slate-600" title={readableValue(value)}>{readableValue(value)}</span>;
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

function executionStatus(value: Json): string {
  const status = asJsonObject(value).status;
  return typeof status === "string"
    ? status.charAt(0).toUpperCase() + status.slice(1)
    : "Processed";
}

function statusClasses(status: string): string {
  const normalized = status.toLowerCase();
  if (["delivered", "success", "completed"].includes(normalized)) {
    return "bg-emerald-50 text-emerald-700 ring-emerald-600/10";
  }
  if (["failed", "error"].includes(normalized)) {
    return "bg-rose-50 text-rose-700 ring-rose-600/10";
  }
  return "bg-[#fff0b9] text-[#7f5d00] ring-[#d7aa2f]/20";
}

function StatusBadge({ value }: { value: Json }) {
  const status = executionStatus(value);
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-[9px] font-semibold ring-1 ring-inset ${statusClasses(status)}`}
    >
      {status}
    </span>
  );
}

function executionDocuments(value: Json): Array<{ url: string; filename: string }> {
  const output = asJsonObject(value);
  const documents: Array<{ url: string; filename: string }> = [];

  if (typeof output.pdf_url === "string" && output.pdf_url.startsWith("https://")) {
    documents.push({ url: output.pdf_url, filename: "Generated document.pdf" });
  }

  if (Array.isArray(output.documents)) {
    for (const item of output.documents) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      if (typeof item.url !== "string" || !item.url.startsWith("https://")) continue;
      if (documents.some((document) => document.url === item.url)) continue;
      documents.push({
        url: item.url,
        filename:
          typeof item.filename === "string" ? item.filename : "Generated document.pdf",
      });
    }
  }

  return documents;
}

function executionLogs(value: Json): Array<{ icon: string; message: string }> {
  const logs = asJsonObject(value).logs;
  if (!Array.isArray(logs)) return [];

  return logs.flatMap((log) => {
    if (!log || typeof log !== "object" || Array.isArray(log)) return [];
    if (typeof log.message !== "string") return [];
    return [{
      icon: typeof log.icon === "string" ? log.icon : "•",
      message: log.message,
    }];
  });
}

function csvCell(value: string): string {
  const safeValue = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

function csvColumnName(value: string): string {
  return value
    .replace(/^step[_-]?\d+[-_]+/i, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function executionCsvRecord(
  execution: WorkflowExecutionRecord,
  columns: DataTableColumn[],
): Record<string, string> {
  const record: Record<string, string> = {
    execution_id: execution.id,
    received_date: execution.createdAt,
  };
  for (const column of columns) {
    record[`${column.source}_${csvColumnName(column.label)}`] = readableValue(
      configuredColumnValue(execution, column),
    );
  }
  return record;
}

function ExecutionDetailsDrawer({
  execution,
  onClose,
}: {
  execution: WorkflowExecutionRecord | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!execution) return;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [execution, onClose]);

  if (!execution) return null;

  const output = asJsonObject(execution.outputData);
  const summary = typeof output.summary === "string" ? output.summary : null;
  const aiResult = typeof output.ai_result === "string" ? output.ai_result : null;
  const delivered = typeof output.delivered === "boolean" ? output.delivered : null;
  const documents = executionDocuments(execution.outputData);
  const logs = executionLogs(execution.outputData);
  const additionalOutput = Object.fromEntries(
    Object.entries(output).filter(([key]) => !HANDLED_OUTPUT_FIELDS.has(key)),
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
      <button
        type="button"
        aria-label="Close execution details"
        onClick={onClose}
        className="absolute inset-0 bg-slate-950/25 backdrop-blur-[2px]"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="execution-details-title"
        className="relative flex h-full w-full max-w-lg flex-col bg-[#fffdfa] shadow-2xl"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-[#e4ddd2] px-5 py-4 sm:px-6">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]">
            <Database className="size-4.5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 id="execution-details-title" className="text-sm font-semibold text-slate-950">
              Execution details
            </h3>
            <p className="mt-1 text-[10px] text-slate-400">
              {executionDateFormatter.format(new Date(execution.createdAt))}
            </p>
          </div>
          <button
            type="button"
            autoFocus
            onClick={onClose}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[#ded6ca] text-slate-400 transition hover:bg-[#f8f4ec] hover:text-[#272536]"
            aria-label="Close details"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge value={execution.outputData} />
            {delivered !== null && (
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[9px] font-semibold ${delivered ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                <CheckCircle2 className="size-3" />
                {delivered ? "Delivered" : "Processed locally"}
              </span>
            )}
          </div>

          <section className="mt-6">
            <h4 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Trigger submission
            </h4>
            <div className="mt-3">
              {formatJsonToChips(asJsonObject(execution.inputData))}
            </div>
          </section>

          {(summary || aiResult) && (
            <section className="mt-6 space-y-3">
              <h4 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                Generated result
              </h4>
              {summary && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                  <p className="flex items-center gap-2 text-[10px] font-semibold text-emerald-800">
                    <CheckCircle2 className="size-3.5" /> Summary
                  </p>
                  <p className="mt-2 whitespace-pre-wrap break-words text-[11px] leading-5 text-emerald-900/80">
                    {summary}
                  </p>
                </div>
              )}
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
            </section>
          )}

          {documents.length > 0 && (
            <section className="mt-6">
              <h4 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                Documents
              </h4>
              <div className="mt-3 grid gap-2">
                {documents.map((document, index) => (
                  <a
                    key={document.url}
                    href={document.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex min-h-11 items-center gap-3 rounded-xl border border-[#e7c75f] bg-[#fff7dc] px-3.5 py-2.5 text-[10px] font-semibold text-[#7f5d00] transition hover:bg-[#fff0b9]"
                  >
                    <FileText className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {documents.length === 1 ? "Download PDF" : `Download PDF ${index + 1}`}
                    </span>
                    <ExternalLink className="size-3.5 shrink-0" />
                  </a>
                ))}
              </div>
            </section>
          )}

          {Object.keys(additionalOutput).length > 0 && (
            <section className="mt-6">
              <h4 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                Additional output
              </h4>
              <div className="mt-3">{formatJsonToChips(additionalOutput)}</div>
            </section>
          )}

          {logs.length > 0 && (
            <section className="mt-6 pb-3">
              <h4 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                Processing log
              </h4>
              <div className="mt-3 space-y-2">
                {logs.map((log, index) => (
                  <div
                    key={`${log.message}-${index}`}
                    className="flex gap-2.5 rounded-xl border border-[#ded6ca] bg-[#f8f4ec] px-3 py-2.5"
                  >
                    <span className="shrink-0 text-xs">{log.icon}</span>
                    <p className="text-[10px] leading-5 text-slate-600">{log.message}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}

export function ExecutionsDataTable({
  workflowId,
  initialExecutions,
  columns,
}: {
  workflowId: string;
  initialExecutions: WorkflowExecutionRecord[];
  columns: DataTableColumn[];
}) {
  const [executions, setExecutions] = useState(initialExecutions);
  const [selectedExecution, setSelectedExecution] =
    useState<WorkflowExecutionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, startRefresh] = useTransition();

  const closeDetails = useCallback(() => setSelectedExecution(null), []);
  const refresh = useCallback(() => {
    startRefresh(async () => {
      const result = await listWorkflowExecutions(workflowId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setExecutions(result.executions);
      setError(null);
    });
  }, [workflowId]);

  useEffect(() => {
    const timer = window.setTimeout(refresh, 0);
    const handleExecution = (event: Event) => {
      const executionWorkflowId = (event as CustomEvent<string>).detail;
      if (executionWorkflowId === workflowId) refresh();
    };
    window.addEventListener("flowmind:executions-changed", handleExecution);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("flowmind:executions-changed", handleExecution);
    };
  }, [refresh, workflowId]);

  function exportCsv() {
    const records = executions.map((execution) => executionCsvRecord(execution, columns));
    const headers = Array.from(
      new Set(records.flatMap((record) => Object.keys(record))),
    );
    const rows = [
      headers,
      ...records.map((record) => headers.map((header) => record[header] ?? "")),
    ];
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `flowmind-executions-${workflowId}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#f8f5ef]">
      <header className="flex min-h-[65px] shrink-0 flex-wrap items-center gap-3 border-b border-[#e4ddd2] bg-[#fffdfa] px-4 py-3 sm:px-6">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-semibold text-slate-950">Execution history</h2>
          <p className="mt-0.5 text-[10px] text-slate-400">Public form submissions and test runs</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={isRefreshing}
            aria-label="Refresh execution history"
            className="flex h-9 items-center gap-2 rounded-lg border border-[#ded6ca] bg-white px-3 text-[10px] font-medium text-slate-600 transition hover:border-[#d7aa2f] hover:bg-[#fff7dc] disabled:opacity-50"
          >
            {isRefreshing ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            <span className="hidden sm:inline">Refresh</span>
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={executions.length === 0}
            className="flex h-9 items-center gap-2 rounded-lg border border-[#dcd4c8] bg-transparent px-3 text-[10px] font-semibold text-[#272536] transition hover:border-[#d7aa2f] hover:bg-[#fff8e3] disabled:opacity-40"
          >
            <Download className="size-3.5" />
            Export CSV
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
                <Database className="size-5" />
              </span>
              <h3 className="mt-4 text-sm font-semibold text-slate-900">No execution data yet</h3>
              <p className="mt-2 text-[11px] leading-5 text-slate-500">
                Submit the public form or run a test. Results will appear here automatically.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-3 md:hidden">
              {executions.map((execution) => (
                <article key={execution.id} className="rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-[10px] text-slate-500">
                        <Clock3 className="size-3 shrink-0" />
                        {executionDateFormatter.format(new Date(execution.createdAt))}
                      </p>
                      <div className="mt-2"><StatusBadge value={execution.outputData} /></div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedExecution(execution)}
                      className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-[#e1bd4b] bg-[#fff7dc] px-3 text-[10px] font-semibold text-[#7f5d00]"
                    >
                      View Details
                      <ChevronRight className="size-3.5" />
                    </button>
                  </div>
                  <div className="mt-4 border-t border-slate-100 pt-3">
                    <p className="mb-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-400">Saved data</p>
                    <div className="grid gap-2">
                      {columns.slice(0, 4).map((column) => (
                        <div key={`${column.source}-${column.key}`} className="flex items-center justify-between gap-3 rounded-lg bg-[#f8f4ec] px-2.5 py-2">
                          <span className="text-[9px] font-semibold text-slate-500">{column.label}</span>
                          <ConfiguredValue execution={execution} column={column} />
                        </div>
                      ))}
                    </div>
                  </div>
                </article>
              ))}
            </div>

            <div className="hidden overflow-x-auto rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] shadow-sm md:block">
              <table className="min-w-full border-collapse text-left">
                <thead className="bg-[#f8f4ec]">
                  <tr className="border-b border-[#e4ddd2] text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                    <th className="min-w-44 px-4 py-3">Received Date</th>
                    {columns.map((column) => (
                      <th key={`${column.source}-${column.key}`} className="min-w-40 px-4 py-3">{column.label}</th>
                    ))}
                    <th className="min-w-36 px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {executions.map((execution) => (
                    <tr key={execution.id} className="border-b border-slate-100 align-middle last:border-0">
                      <td className="px-4 py-4 text-[10px] text-slate-500">
                        {executionDateFormatter.format(new Date(execution.createdAt))}
                      </td>
                      {columns.map((column) => (
                        <td key={`${column.source}-${column.key}`} className="px-4 py-4">
                          <ConfiguredValue execution={execution} column={column} />
                        </td>
                      ))}
                      <td className="px-4 py-4 text-right">
                        <button
                          type="button"
                          onClick={() => setSelectedExecution(execution)}
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#ded6ca] bg-white px-3 text-[10px] font-semibold text-slate-600 transition hover:border-[#d7aa2f] hover:bg-[#fff7dc] hover:text-[#7f5d00]"
                        >
                          View Details
                          <ChevronRight className="size-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <ExecutionDetailsDrawer execution={selectedExecution} onClose={closeDetails} />
    </section>
  );
}
