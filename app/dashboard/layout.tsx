"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleHelp,
  Clock3,
  LoaderCircle,
  LogOut,
  Plus,
  Trash2,
  Workflow,
  X,
  Zap,
} from "lucide-react";

import { deleteWorkflow, listWorkflows, type SavedWorkflow } from "@/app/actions/workflow";
import { signOut } from "@/app/actions/auth";
import { getStepInputs, orderWorkflowSteps } from "@/lib/workflow-setup";

type AutomationStatus = "Draft" | "Ready" | "Working";

function readSavedValues(workflowId: string): Record<string, string> {
  try {
    return JSON.parse(window.localStorage.getItem(`flowmind:values:${workflowId}`) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function workflowStatus(item: SavedWorkflow): AutomationStatus {
  if (window.localStorage.getItem(`flowmind:status:${item.id}`) === "working") return "Working";
  if (!item.workflow) return "Draft";
  const values = readSavedValues(item.id);
  const steps = orderWorkflowSteps(item.workflow.steps);
  const ready = steps.every((step) =>
    getStepInputs(step, item.id).every((input) =>
      (values[`${step.id}-${input.key}`] ?? input.value ?? "").trim(),
    ),
  );
  return ready ? "Ready" : "Draft";
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [automations, setAutomations] = useState<Array<SavedWorkflow & { status: AutomationStatus }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedWorkflow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadAutomations = useCallback(async () => {
    const result = await listWorkflows();
    if (!result.ok) {
      setAutomations([]);
      setIsLoading(false);
      return;
    }
    setAutomations(result.workflows.map((item) => ({ ...item, status: workflowStatus(item) })));
    setIsLoading(false);
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadAutomations(), 0);
    const refresh = () => void loadAutomations();
    const activeChanged = (event: Event) => setActiveId((event as CustomEvent<string | null>).detail);
    const statusChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; status: AutomationStatus }>).detail;
      setAutomations((current) => current.map((item) => item.id === detail.id ? { ...item, status: detail.status } : item));
    };
    window.addEventListener("flowmind:automations-changed", refresh);
    window.addEventListener("flowmind:active-workflow", activeChanged);
    window.addEventListener("flowmind:status-changed", statusChanged);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener("flowmind:automations-changed", refresh);
      window.removeEventListener("flowmind:active-workflow", activeChanged);
      window.removeEventListener("flowmind:status-changed", statusChanged);
    };
  }, [loadAutomations]);

  function newAutomation() {
    setActiveId(null);
    if (pathname === "/dashboard") {
      window.dispatchEvent(new CustomEvent("flowmind:new-workflow"));
    } else {
      router.push("/dashboard");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    const result = await deleteWorkflow(deleteTarget.id);
    if (!result.ok) {
      setDeleteError(result.error);
      setIsDeleting(false);
      return;
    }

    window.localStorage.removeItem(`flowmind:values:${deleteTarget.id}`);
    window.localStorage.removeItem(`flowmind:status:${deleteTarget.id}`);
    setAutomations((current) => current.filter((item) => item.id !== deleteTarget.id));
    if (activeId === deleteTarget.id) {
      setActiveId(null);
      window.dispatchEvent(new CustomEvent("flowmind:new-workflow"));
    }
    setDeleteTarget(null);
    setIsDeleting(false);
  }

  return (
    <div className="dashboard-theme flex h-dvh min-h-[640px] overflow-hidden bg-[#f7f4ee] text-[#34313d]">
      <aside className="hidden w-[260px] shrink-0 flex-col border-r border-[#e4ddd2] bg-[#fffdfa] lg:flex">
        <Link href="/dashboard" className="flex h-[65px] items-center gap-3 border-b border-[#e4ddd2] px-5">
          <span className="flex size-8 items-center justify-center rounded-[10px] border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]">
            <Zap className="size-4 fill-current" />
          </span>
          <span className="text-[18px] font-bold tracking-[-0.03em] text-[#272536]">FlowMind</span>
          <span className="ml-auto rounded-full bg-[#f1c94b] px-2 py-0.5 text-[9px] font-bold tracking-[0.12em] text-[#272536]">AI</span>
        </Link>

        <div className="px-4 pb-4 pt-4">
          <button type="button" onClick={newAutomation} className="group flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-[#dcd4c8] bg-transparent text-[13px] font-semibold text-[#272536] transition hover:border-[#d7aa2f] hover:bg-[#fff8e3]">
            <span className="flex size-5 items-center justify-center rounded-md bg-[#fff0b9] text-[#8a6200] transition group-hover:bg-[#f1c94b] group-hover:text-[#272536]"><Plus className="size-3.5" /></span> New Automation
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <div className="flex items-center justify-between px-3 pb-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-400">My Automations</p>
            {!isLoading && <span className="text-[9px] font-medium text-slate-400">{automations.length}</span>}
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-[10px] text-slate-400"><LoaderCircle className="size-3.5 animate-spin" />Loading automations…</div>
          ) : automations.length === 0 ? (
            <div className="mx-1 rounded-xl border border-dashed border-[#ded6ca] bg-[#f8f4ec] px-4 py-5 text-center">
              <Workflow className="mx-auto size-4 text-[#b9aa8b]" />
              <p className="mt-2 text-[10px] leading-4 text-slate-400">Your saved automations will appear here.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {automations.map((automation) => {
                const active = automation.id === activeId || pathname === `/dashboard/projects/${automation.id}`;
                return (
                  <div key={automation.id} className={`group flex items-center rounded-xl border-l-2 transition ${active ? "border-[#d7aa2f] bg-[#fff7dc]" : "border-transparent hover:bg-[#f8f4ec]"}`}>
                    <Link href={`/dashboard/projects/${automation.id}`} onClick={() => setActiveId(automation.id)} className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left">
                      <span className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg ${automation.status === "Working" ? "bg-emerald-50 text-emerald-600" : automation.status === "Ready" ? "bg-[#fff0b9] text-[#956b00]" : "bg-amber-50 text-amber-600"}`}>
                        {automation.status === "Working" ? <CheckCircle2 className="size-3.5" /> : automation.status === "Ready" ? <Zap className="size-3.5" /> : <Clock3 className="size-3.5" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-[11px] font-medium ${active ? "text-[#272536]" : "text-slate-700"}`}>{automation.name}</span>
                        <span className={`mt-0.5 block text-[9px] font-medium ${automation.status === "Working" ? "text-emerald-600" : automation.status === "Ready" ? "text-[#9a7007]" : "text-amber-600"}`}>{automation.status}</span>
                      </span>
                    </Link>
                    <button type="button" onClick={() => { setDeleteTarget(automation); setDeleteError(null); }} aria-label={`Delete ${automation.name}`} className="mr-2 flex size-7 shrink-0 items-center justify-center rounded-lg text-slate-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 focus:opacity-100 group-hover:opacity-100">
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-[#e4ddd2] px-3 py-3">
          <div className="flex items-center gap-3 rounded-xl px-3 py-2.5">
            <span className="flex size-8 items-center justify-center rounded-xl bg-[#f4ead0] text-[#9a7007]"><CircleHelp className="size-4" /></span>
            <span className="min-w-0 flex-1"><span className="block text-[11px] font-medium text-slate-700">Private workspace</span><span className="block text-[10px] text-slate-400">Drafts save automatically</span></span>
            <form action={signOut}>
              <button type="submit" aria-label="Log out" className="flex size-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-800"><LogOut className="size-3.5" /></button>
            </form>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">{children}</div>

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/25 p-4 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isDeleting) setDeleteTarget(null); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="delete-automation-title" className="w-full max-w-sm rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-5 shadow-[0_24px_80px_rgba(39,37,54,.2)]">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-600"><Trash2 className="size-[18px]" /></span>
              <div className="min-w-0 flex-1">
                <h2 id="delete-automation-title" className="text-sm font-semibold text-slate-950">Delete this automation?</h2>
                <p className="mt-1.5 text-[11px] leading-5 text-slate-500">“{deleteTarget.name}” and its saved draft details will be permanently removed.</p>
              </div>
              <button type="button" onClick={() => setDeleteTarget(null)} disabled={isDeleting} aria-label="Close confirmation" className="flex size-7 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"><X className="size-4" /></button>
            </div>
            {deleteError && <p role="alert" className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-[10px] text-rose-700">{deleteError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setDeleteTarget(null)} disabled={isDeleting} className="h-9 rounded-lg border border-[#ded6ca] bg-white px-4 text-[11px] font-medium text-slate-600 transition hover:bg-[#f8f4ec] disabled:opacity-40">Cancel</button>
              <button type="button" onClick={() => void confirmDelete()} disabled={isDeleting} className="flex h-9 items-center gap-2 rounded-lg bg-rose-600 px-4 text-[11px] font-semibold text-white transition hover:bg-rose-700 disabled:opacity-60">{isDeleting && <LoaderCircle className="size-3.5 animate-spin" />}{isDeleting ? "Deleting…" : "Delete automation"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
