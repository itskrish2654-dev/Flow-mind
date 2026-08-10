"use client";

import { useEffect, useState } from "react";
import { Database, Workflow } from "lucide-react";

import type { WorkflowExecutionRecord } from "@/app/actions/executions";
import { AutomationWorkspace } from "@/components/automation-workspace";
import { ExecutionsDataTable } from "@/components/executions-data-table";
import type { CompiledWorkflow } from "@/lib/schemas/workflow";
import { getDataTableDefinition } from "@/lib/workflow-customization";

export function ProjectWorkspace({
  workflowId,
  workflow,
  published,
  initialExecutions,
}: {
  workflowId: string;
  workflow: CompiledWorkflow;
  published: boolean;
  initialExecutions: WorkflowExecutionRecord[];
}) {
  const [view, setView] = useState<"builder" | "data">("builder");
  const [executionCount, setExecutionCount] = useState(initialExecutions.length);
  const [currentWorkflow, setCurrentWorkflow] = useState(workflow);

  useEffect(() => {
    const handleExecution = (event: Event) => {
      if ((event as CustomEvent<string>).detail === workflowId) {
        setExecutionCount((count) => count + 1);
      }
    };
    window.addEventListener("flowmind:executions-changed", handleExecution);
    const showExecutions = () => setView("data");
    const updateWorkflow = (event: Event) =>
      setCurrentWorkflow((event as CustomEvent<CompiledWorkflow>).detail);
    window.addEventListener("flowmind:show-executions", showExecutions);
    window.addEventListener("flowmind:workflow-customized", updateWorkflow);
    return () => {
      window.removeEventListener("flowmind:executions-changed", handleExecution);
      window.removeEventListener("flowmind:show-executions", showExecutions);
      window.removeEventListener("flowmind:workflow-customized", updateWorkflow);
    };
  }, [workflowId]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <nav className="flex h-11 shrink-0 items-end gap-1 border-b border-[#e4ddd2] bg-[#fffdfa] px-3 sm:px-5" aria-label="Project views">
        <button
          type="button"
          onClick={() => setView("builder")}
          className={`flex h-10 items-center gap-2 border-b-2 px-3 text-[11px] font-semibold transition ${view === "builder" ? "border-[#d7aa2f] text-[#272536]" : "border-transparent text-[#6c6458] hover:text-[#272536]"}`}
        >
          <Workflow className="size-3.5" />
          Workflow
        </button>
        <button
          type="button"
          onClick={() => setView("data")}
          className={`flex h-10 items-center gap-2 border-b-2 px-3 text-[11px] font-semibold transition ${view === "data" ? "border-[#d7aa2f] text-[#272536]" : "border-transparent text-[#6c6458] hover:text-[#272536]"}`}
        >
          <Database className="size-3.5" />
          Executions &amp; Data
          {executionCount > 0 && (
            <span className="ml-2 rounded-full bg-[#272536] px-2 py-0.5 text-[10px] font-semibold text-[#f1c94b]">
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
            initialWorkflow={currentWorkflow}
            initialPublished={published}
          />
        ) : (
          <ExecutionsDataTable
            workflowId={workflowId}
            initialExecutions={initialExecutions}
            columns={getDataTableDefinition(currentWorkflow).columns}
          />
        )}
      </div>
    </div>
  );
}
