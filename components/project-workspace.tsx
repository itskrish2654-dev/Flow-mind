"use client";

import { useEffect, useState } from "react";
import { Database, Workflow } from "lucide-react";

import type { WorkflowExecutionRecord } from "@/app/actions/executions";
import { AutomationWorkspace } from "@/components/automation-workspace";
import { ExecutionsDataTable } from "@/components/executions-data-table";
import type { CompiledWorkflow } from "@/lib/schemas/workflow";

export function ProjectWorkspace({
  workflowId,
  workflow,
  initialExecutions,
}: {
  workflowId: string;
  workflow: CompiledWorkflow;
  initialExecutions: WorkflowExecutionRecord[];
}) {
  const [view, setView] = useState<"builder" | "data">("builder");
  const [executionCount, setExecutionCount] = useState(initialExecutions.length);

  useEffect(() => {
    const handleExecution = (event: Event) => {
      if ((event as CustomEvent<string>).detail === workflowId) {
        setExecutionCount((count) => count + 1);
      }
    };
    window.addEventListener("flowmind:executions-changed", handleExecution);
    const showExecutions = () => setView("data");
    window.addEventListener("flowmind:show-executions", showExecutions);
    return () => {
      window.removeEventListener("flowmind:executions-changed", handleExecution);
      window.removeEventListener("flowmind:show-executions", showExecutions);
    };
  }, [workflowId]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <nav className="flex h-11 shrink-0 items-end gap-1 border-b border-slate-200 bg-white px-3 sm:px-5" aria-label="Project views">
        <button
          type="button"
          onClick={() => setView("builder")}
          className={`flex h-10 items-center gap-2 border-b-2 px-3 text-[11px] font-semibold transition ${view === "builder" ? "border-indigo-500 text-indigo-700" : "border-transparent text-slate-400 hover:text-slate-700"}`}
        >
          <Workflow className="size-3.5" />
          Workflow
        </button>
        <button
          type="button"
          onClick={() => setView("data")}
          className={`flex h-10 items-center gap-2 border-b-2 px-3 text-[11px] font-semibold transition ${view === "data" ? "border-indigo-500 text-indigo-700" : "border-transparent text-slate-400 hover:text-slate-700"}`}
        >
          <Database className="size-3.5" />
          Executions &amp; Data
          {executionCount > 0 && (
            <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[8px] text-indigo-600">
              {executionCount}
            </span>
          )}
        </button>
      </nav>
      <div className="min-h-0 flex-1">
        {view === "builder" ? (
          <AutomationWorkspace
            key={workflowId}
            initialWorkflowId={workflowId}
            initialWorkflow={workflow}
          />
        ) : (
          <ExecutionsDataTable
            workflowId={workflowId}
            initialExecutions={initialExecutions}
          />
        )}
      </div>
    </div>
  );
}
