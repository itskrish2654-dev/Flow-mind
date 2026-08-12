"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  LoaderCircle,
  LogOut,
  Plus,
  Settings,
  Trash2,
  Workflow,
  X,
  Zap,
} from "lucide-react";

import { deleteWorkflow, listWorkflows, type SavedWorkflow } from "@/app/actions/workflow";
import { createClient } from "@/lib/supabase/client";

type AutomationStatus = "Draft" | "Ready" | "Working" | "Running" | "Failed";
type AccountDetails = {
  displayName: string;
  email: string;
  memberSince: string;
};

function readableAccountName(email: string, metadata: Record<string, unknown>): string {
  const savedName = [metadata.full_name, metadata.name, metadata.display_name]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (savedName) return savedName.trim();

  const emailName = email.split("@")[0]?.replace(/[._-]+/g, " ").trim();
  if (!emailName) return "FlowMind user";
  return emailName.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function accountInitials(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return initials || "FM";
}

function cleanSensitiveLegacyStorage() {
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith("flowmind:values:")) continue;
    try {
      window.localStorage.setItem(
        key,
        JSON.stringify(
          {},
        ),
      );
    } catch {
      window.localStorage.removeItem(key);
    }
  }
}

function workflowStatus(item: SavedWorkflow): AutomationStatus {
  return item.readiness;
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [automations, setAutomations] = useState<Array<SavedWorkflow & { status: AutomationStatus }>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedWorkflow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [account, setAccount] = useState<AccountDetails | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const loadAutomations = useCallback(async () => {
    const result = await listWorkflows();
    if (!result.ok) {
      setAutomations([]);
      setIsLoading(false);
      return;
    }
    setAutomations(result.workflows.map((item) => ({ ...item, status: workflowStatus(item) })));
    setNextCursor(result.nextCursor);
    setIsLoading(false);
  }, []);

  const loadMoreAutomations = useCallback(async () => {
    if (!nextCursor) return;
    const result = await listWorkflows(nextCursor);
    if (!result.ok) return;
    setAutomations((current) => {
      const known = new Set(current.map((item) => item.id));
      return [...current, ...result.workflows.filter((item) => !known.has(item.id)).map((item) => ({ ...item, status: workflowStatus(item) }))];
    });
    setNextCursor(result.nextCursor);
  }, [nextCursor]);

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

  useEffect(() => {
    let active = true;

    async function loadAccount() {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser();

      if (!active) return;
      if (error || !user?.email) {
        setAccountError("We couldn’t load your account details.");
        return;
      }

      const createdAt = new Date(user.created_at);
      setAccount({
        displayName: readableAccountName(user.email, user.user_metadata),
        email: user.email,
        memberSince: Number.isNaN(createdAt.getTime())
          ? "FlowMind member"
          : `Member since ${new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(createdAt)}`,
      });
      setAccountError(null);
    }

    void loadAccount();
    return () => {
      active = false;
    };
  }, [supabase]);

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

  async function logOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    setAccountError(null);
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) {
      setAccountError("We couldn’t log you out. Please try again.");
      setIsSigningOut(false);
      return;
    }
    cleanSensitiveLegacyStorage();
    window.location.replace("/login");
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
              {nextCursor && (
                <button type="button" onClick={() => void loadMoreAutomations()} className="mt-2 h-9 w-full rounded-lg border border-[#ded6ca] bg-transparent text-[10px] font-semibold text-slate-500 hover:bg-[#f8f4ec]">
                  Load older automations
                </button>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-[#e4ddd2] px-3 py-3">
          <p className="px-3 pb-2 text-[9px] font-semibold uppercase tracking-[0.15em] text-slate-400">Account</p>
          <div className="rounded-xl border border-[#e4ddd2] bg-[#faf8f4] p-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-[#e4c35d] bg-[#fff2bd] text-[10px] font-bold text-[#805b00]">
                {account ? accountInitials(account.displayName) : <LoaderCircle className="size-3.5 animate-spin" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-semibold text-slate-800">{account?.displayName ?? "Loading account…"}</span>
                <span className="block truncate text-[9px] text-slate-500">{account?.email ?? "Secure workspace"}</span>
              </span>
            </div>
            {account && <p className="mt-2 text-[8px] text-slate-400">{account.memberSince}</p>}
            {accountError && <p role="alert" className="mt-2 text-[9px] leading-4 text-rose-600">{accountError}</p>}
            <Link href="/settings" className="mt-3 flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-[#ded6ca] bg-[#fffdfa] text-[10px] font-semibold text-slate-600 transition hover:border-[#c9b98f] hover:bg-[#fff8e3] hover:text-slate-900"><Settings className="size-3.5" />Settings</Link>
            <button
              type="button"
              onClick={() => void logOut()}
              disabled={isSigningOut}
              className="mt-2 flex h-8 w-full items-center justify-center gap-2 rounded-lg border border-[#ded6ca] bg-[#fffdfa] text-[10px] font-semibold text-slate-600 transition hover:border-[#c9b98f] hover:bg-[#fff8e3] hover:text-slate-900 disabled:cursor-wait disabled:opacity-60"
            >
              {isSigningOut ? <LoaderCircle className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />}
              {isSigningOut ? "Logging out…" : "Log out"}
            </button>
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
