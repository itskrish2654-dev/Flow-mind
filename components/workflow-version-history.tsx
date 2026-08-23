"use client";

import { useState, useTransition } from "react";
import { ArrowLeft, Check, History, LoaderCircle, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";

import { rollbackWorkflowVersion, type WorkflowVersionSummary } from "@/app/actions/versions";
import { AccessibleDialog } from "@/components/accessible-dialog";

const changeDateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

const SCOPE_LABELS: Record<string, string> = {
  setup: "Updated loop setup",
  destination: "Changed destination",
  trigger: "Changed how the loop starts",
  form: "Changed form",
  form_schema: "Changed form",
  schedule: "Changed schedule",
  configuration: "Updated configuration",
  presentation: "Updated configuration",
  ai_instructions: "Updated configuration",
  full_replacement: "Replaced loop setup",
  workflow_structure: "Changed loop steps",
  rollback: "Restored an earlier setup",
};

function changeLabel(version: WorkflowVersionSummary): string {
  const summary = version.summary?.trim();
  if (summary && !summary.includes("_") && !/\bworkflow version\b/i.test(summary)) {
    return summary
      .replace(/\bworkflow\b/gi, "loop")
      .replace(/\bversion\b/gi, "setup");
  }
  return SCOPE_LABELS[version.scope] ?? "Updated configuration";
}

function VersionCard({
  version,
  isPending,
  onRestore,
}: {
  version: WorkflowVersionSummary;
  isPending: boolean;
  onRestore: (version: WorkflowVersionSummary) => void;
}) {
  return (
    <article className="rounded-xl border border-[#e4ddd2] bg-[#fffdfa] p-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${version.current ? "bg-emerald-50 text-emerald-700" : "bg-[#f8f4ec] text-[#6c6458]"}`}>
          {version.current ? <Check className="size-4" /> : <History className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold leading-5 text-slate-800">{changeLabel(version)}</p>
          <p className="mt-0.5 text-[9px] text-slate-400" title={changeDateFormatter.format(new Date(version.createdAt))}>
            {changeDateFormatter.format(new Date(version.createdAt))}
          </p>
        </div>
        {version.current ? (
          <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[9px] font-semibold text-emerald-700">Current setup</span>
        ) : (
          <button type="button" onClick={() => onRestore(version)} disabled={isPending} className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-[#ded6ca] px-2.5 text-[9px] font-semibold text-slate-600 hover:border-[#d7aa2f] hover:bg-[#fff8e3] disabled:opacity-50">
            <RotateCcw className="size-3" /> Restore this setup
          </button>
        )}
      </div>
    </article>
  );
}

export function WorkflowVersionHistory({
  workflowId,
  versions,
  onClose,
}: {
  workflowId: string;
  versions: WorkflowVersionSummary[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [restoreCandidate, setRestoreCandidate] = useState<WorkflowVersionSummary | null>(null);
  const current = versions.filter((version) => version.current);
  const earlier = versions.filter((version) => !version.current);

  function restore(version: WorkflowVersionSummary) {
    if (version.current || isPending) return;
    startTransition(async () => {
      const result = await rollbackWorkflowVersion(workflowId, version.id);
      if (!result.ok) return setError(result.error);
      setError(null);
      setRestoreCandidate(null);
      router.refresh();
    });
  }

  return (
    <section className="h-full overflow-y-auto bg-[#f8f5ef] p-4 sm:p-6">
      <div className="mx-auto max-w-3xl rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-5 shadow-sm">
        <button type="button" onClick={onClose} className="mb-4 flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-[10px] font-semibold text-slate-500 transition hover:bg-[#f8f4ec] hover:text-slate-900">
          <ArrowLeft className="size-3.5" /> Back to Workflow
        </button>
        <div className="flex items-start gap-3">
          <span className="flex size-9 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]"><History className="size-4" /></span>
          <div>
            <h2 className="text-sm font-semibold text-slate-950">Change history</h2>
            <p className="mt-1 max-w-xl text-[10px] leading-5 text-slate-500">CrazyLoops saves previous setups automatically, so you can undo a change without losing your history.</p>
          </div>
        </div>
        {error && <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
        <div className="mt-6 space-y-6">
          {current.length > 0 && (
            <section aria-labelledby="current-setup-heading">
              <h3 id="current-setup-heading" className="mb-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">Current setup</h3>
              <div className="space-y-2">{current.map((version) => <VersionCard key={version.id} version={version} isPending={isPending} onRestore={setRestoreCandidate} />)}</div>
            </section>
          )}
          {earlier.length > 0 ? (
            <section aria-labelledby="earlier-setups-heading">
              <h3 id="earlier-setups-heading" className="mb-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">Earlier setups</h3>
              <div className="space-y-2">{earlier.map((version) => <VersionCard key={version.id} version={version} isPending={isPending} onRestore={setRestoreCandidate} />)}</div>
            </section>
          ) : (
            <div className="rounded-xl border border-dashed border-[#ded6ca] bg-[#f8f4ec] px-5 py-8 text-center">
              <p className="text-[11px] font-semibold text-slate-800">Your current setup is the first version.</p>
              <p className="mt-1 text-[10px] text-slate-500">Future changes will appear here automatically.</p>
            </div>
          )}
        </div>
      </div>
      <AccessibleDialog open={Boolean(restoreCandidate)} onOpenChange={(open) => { if (!open && !isPending) setRestoreCandidate(null); }} title="Restore this setup?" description="Make this earlier setup current while keeping all newer history." contentClassName="max-w-md">
        <div className="p-6">
          <h3 className="text-base font-semibold text-slate-950">Restore this setup?</h3>
          <p className="mt-2 text-[11px] leading-5 text-slate-500">This earlier setup will become current. Every newer setup will stay in your change history.</p>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => setRestoreCandidate(null)} disabled={isPending} className="min-h-11 rounded-xl border border-[#ded6ca] px-4 text-[11px] font-semibold text-slate-600 disabled:opacity-50">Keep current setup</button>
            <button type="button" onClick={() => { if (restoreCandidate) restore(restoreCandidate); }} disabled={isPending} className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#f1c94b] px-4 text-[11px] font-semibold text-[#272536] transition hover:bg-[#e6bb36] disabled:opacity-50">
              {isPending ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} Restore this setup
            </button>
          </div>
        </div>
      </AccessibleDialog>
    </section>
  );
}
