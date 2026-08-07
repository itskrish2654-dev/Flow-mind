"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Database, Download, LoaderCircle, RefreshCw } from "lucide-react";

import {
  listWorkflowExecutions,
  type WorkflowExecutionRecord,
} from "@/app/actions/executions";
import type { Json } from "@/lib/supabase/types";

const executionDateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function compactJson(value: Json): string {
  if (value === null) return "—";
  if (typeof value !== "object") return String(value);
  return JSON.stringify(value);
}

function executionStatus(value: Json): string {
  if (!value || Array.isArray(value) || typeof value !== "object") return "Processed";
  const status = value.status;
  return typeof status === "string"
    ? status.charAt(0).toUpperCase() + status.slice(1)
    : "Processed";
}

function csvCell(value: string): string {
  const safeValue = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

export function ExecutionsDataTable({
  workflowId,
  initialExecutions,
}: {
  workflowId: string;
  initialExecutions: WorkflowExecutionRecord[];
}) {
  const [executions, setExecutions] = useState(initialExecutions);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, startRefresh] = useTransition();

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
    const rows = [
      ["execution_id", "created_at", "status", "input_data", "output_data"],
      ...executions.map((execution) => [
        execution.id,
        execution.createdAt,
        executionStatus(execution.outputData),
        compactJson(execution.inputData),
        compactJson(execution.outputData),
      ]),
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
    <section className="flex h-full min-h-0 flex-col bg-[#f8fafc]">
      <header className="flex min-h-[65px] shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-6">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-slate-950">Execution history</h2>
          <p className="mt-0.5 text-[10px] text-slate-400">Public form submissions and test runs</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={isRefreshing}
            className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-[10px] font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {isRefreshing ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            <span className="hidden sm:inline">Refresh</span>
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={executions.length === 0}
            className="flex h-9 items-center gap-2 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 px-3 text-[10px] font-semibold text-white shadow-md shadow-indigo-100 transition hover:brightness-110 disabled:opacity-40"
          >
            <Download className="size-3.5" />
            Export CSV
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        {error && (
          <p role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700">
            {error}
          </p>
        )}

        {executions.length === 0 ? (
          <div className="flex min-h-[320px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white text-center">
            <div className="max-w-xs px-6">
              <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-500">
                <Database className="size-5" />
              </span>
              <h3 className="mt-4 text-sm font-semibold text-slate-900">No execution data yet</h3>
              <p className="mt-2 text-[11px] leading-5 text-slate-500">
                Submit the public form or run a test. Results will appear here automatically.
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="overflow-x-auto">
              <table className="min-w-[820px] w-full border-collapse text-left">
                <thead className="bg-slate-50">
                  <tr className="border-b border-slate-200 text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-400">
                    <th className="px-4 py-3">Received</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Input data</th>
                    <th className="px-4 py-3">Output data</th>
                  </tr>
                </thead>
                <tbody>
                  {executions.map((execution) => (
                    <tr key={execution.id} className="border-b border-slate-100 align-top last:border-0">
                      <td className="whitespace-nowrap px-4 py-4 text-[10px] text-slate-500">
                        {executionDateFormatter.format(new Date(execution.createdAt))}
                      </td>
                      <td className="px-4 py-4">
                        <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[9px] font-semibold text-emerald-700">
                          {executionStatus(execution.outputData)}
                        </span>
                      </td>
                      <td className="max-w-[280px] px-4 py-4">
                        <code className="block whitespace-pre-wrap break-words text-[10px] leading-5 text-slate-600">
                          {compactJson(execution.inputData)}
                        </code>
                      </td>
                      <td className="max-w-[320px] px-4 py-4">
                        <code className="block whitespace-pre-wrap break-words text-[10px] leading-5 text-slate-600">
                          {compactJson(execution.outputData)}
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
