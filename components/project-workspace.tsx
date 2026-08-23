"use client";

import { useEffect, useState } from "react";
import { Activity, History, Workflow } from "lucide-react";

import type { WorkflowExecutionRecord } from "@/app/actions/executions";
import { AutomationWorkspace } from "@/components/automation-workspace";
import { ExecutionsDataTable } from "@/components/executions-data-table";
import { WorkflowVersionHistory } from "@/components/workflow-version-history";
import type { WorkflowVersionSummary } from "@/app/actions/versions";
import type { CompiledWorkflow } from "@/lib/schemas/workflow";
import { getDataTableDefinition } from "@/lib/workflow-customization";

export function ProjectWorkspace({
  workflowId,
  workflow,
  published,
  hasUnpublishedChanges,
  initialExecutions,
  initialExecutionCursor,
  initialSetupConfig,
  versions,
}: {
  workflowId: string;
  workflow: CompiledWorkflow;
  published: boolean;
  hasUnpublishedChanges: boolean;
  initialExecutions: WorkflowExecutionRecord[];
  initialExecutionCursor: string | null;
  initialSetupConfig: Record<string, string>;
  versions: WorkflowVersionSummary[];
}) {
  const [view, setView] = useState<"workflow" | "activity">("workflow");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [executionCount, setExecutionCount] = useState(initialExecutions.length);
  const [currentWorkflow, setCurrentWorkflow] = useState(workflow);

  useEffect(() => {
    const handleExecution = (event: Event) => {
      if ((event as CustomEvent<string>).detail === workflowId) {
        setExecutionCount((count) => count + 1);
      }
    };
    window.addEventListener("flowmind:executions-changed", handleExecution);
    const showExecutions = () => {
      setHistoryOpen(false);
      setView("activity");
    };
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
      <nav className="flex h-14 shrink-0 items-end gap-1 overflow-x-auto border-b border-[#e4ddd2] bg-[#fffdfa] pl-16 pr-2 sm:h-11 sm:px-5" aria-label="Project views">
        <button
          type="button"
          onClick={() => {
            setHistoryOpen(false);
            setView("workflow");
          }}
          aria-current={view === "workflow" ? "page" : undefined}
          className={`flex h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-xs font-semibold transition ${view === "workflow" ? "border-[#d7aa2f] text-[#272536]" : "border-transparent text-[#6c6458] hover:text-[#272536]"}`}
        >
          <Workflow className="size-3.5" />
          Workflow
        </button>
        <button
          type="button"
          onClick={() => {
            setHistoryOpen(false);
            setView("activity");
          }}
          aria-current={view === "activity" ? "page" : undefined}
          className={`flex h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-xs font-semibold transition ${view === "activity" ? "border-[#d7aa2f] text-[#272536]" : "border-transparent text-[#6c6458] hover:text-[#272536]"}`}
        >
          <Activity className="size-3.5" />
          Activity
          {executionCount > 0 && (
            <span className="ml-1 rounded-full bg-[#fff0b9] px-2 py-0.5 text-[10px] font-semibold text-[#7f5d00]">
              {executionCount}
            </span>
          )}
        </button>
        {view === "workflow" && (
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            aria-pressed={historyOpen}
            className="ml-auto flex h-9 shrink-0 items-center gap-1.5 self-center rounded-lg px-2.5 text-[10px] font-semibold text-[#6c6458] transition hover:bg-[#f8f4ec] hover:text-[#272536]"
          >
            <History className="size-3.5" />
            Change history
          </button>
        )}
      </nav>
      <div className="min-h-0 flex-1">
        {view === "workflow" && historyOpen ? (
          <WorkflowVersionHistory
            workflowId={workflowId}
            versions={versions}
            onClose={() => setHistoryOpen(false)}
          />
        ) : view === "workflow" ? (
          <AutomationWorkspace
            key={workflowId}
            initialWorkflowId={workflowId}
            initialWorkflow={currentWorkflow}
            initialPublished={published}
            initialHasUnpublishedChanges={hasUnpublishedChanges}
            initialSetupConfig={initialSetupConfig}
          />
        ) : (
          <ExecutionsDataTable
            workflowId={workflowId}
            initialExecutions={initialExecutions}
            initialNextCursor={initialExecutionCursor}
            columns={getDataTableDefinition(currentWorkflow).columns}
          />
        )}
      </div>
    </div>
  );
}
