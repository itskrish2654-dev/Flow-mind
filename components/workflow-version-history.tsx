"use client";

import { useState, useTransition } from "react";
import { History, LoaderCircle, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";

import { rollbackWorkflowVersion, type WorkflowVersionSummary } from "@/app/actions/versions";

export function WorkflowVersionHistory({
  workflowId,
  versions,
}: {
  workflowId: string;
  versions: WorkflowVersionSummary[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function restore(version: WorkflowVersionSummary) {
    if (version.current || isPending) return;
    if (!window.confirm(`Restore version ${version.versionNumber}? This creates a new version and keeps all existing history.`)) return;
    startTransition(async () => {
      const result = await rollbackWorkflowVersion(workflowId, version.id);
      if (!result.ok) return setError(result.error);
      setError(null);
      router.refresh();
    });
  }

  return (
    <section className="h-full overflow-y-auto bg-[#f8f5ef] p-4 sm:p-6">
      <div className="mx-auto max-w-3xl rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]"><History className="size-4" /></span>
          <div>
            <h2 className="text-sm font-semibold text-slate-950">Version history</h2>
            <p className="mt-0.5 text-[10px] text-slate-500">Restoring an older definition creates a new version. Nothing is overwritten.</p>
          </div>
        </div>
        {error && <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
        <div className="mt-5 divide-y divide-[#ece6dc]">
          {versions.map((version) => (
            <article key={version.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#f8f4ec] text-[11px] font-bold text-[#6c6458]">v{version.versionNumber}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-semibold text-slate-800">{version.summary || version.scope.replaceAll("_", " ")}</p>
                <p className="mt-0.5 text-[9px] text-slate-400">{new Date(version.createdAt).toLocaleString()} · {version.scope.replaceAll("_", " ")}</p>
              </div>
              {version.current ? (
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[9px] font-semibold text-emerald-700">Current</span>
              ) : (
                <button type="button" onClick={() => restore(version)} disabled={isPending} className="flex h-8 items-center gap-1.5 rounded-lg border border-[#ded6ca] px-2.5 text-[9px] font-semibold text-slate-600 hover:border-[#d7aa2f] disabled:opacity-50">
                  {isPending ? <LoaderCircle className="size-3 animate-spin" /> : <RotateCcw className="size-3" />} Restore
                </button>
              )}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
