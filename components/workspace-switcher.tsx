"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";

import { switchWorkspaceAction, type CompanyActionState } from "@/app/actions/company";
import type { WorkspaceOption } from "@/lib/company";

export function WorkspaceSwitcher({ workspaces }: { workspaces: WorkspaceOption[] }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(switchWorkspaceAction, { ok: false } satisfies CompanyActionState);
  const active = workspaces.find((workspace) => workspace.active)?.id ?? workspaces[0]?.id;
  useEffect(() => {
    if (state.ok) {
      router.refresh();
      router.push("/my-day");
    }
  }, [router, state.ok]);
  if (workspaces.length < 2) return null;
  return (
    <form action={action} className="rounded-xl border border-[#e4ddd2] bg-[#faf8f4] p-3">
      <label htmlFor="workspace-selector" className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">Active company</label>
      <div className="mt-2 flex gap-2">
        <select id="workspace-selector" name="workspaceId" defaultValue={active} disabled={pending} className="min-w-0 flex-1 rounded-lg border border-[#d8d0c5] bg-white px-3 py-2 text-xs font-semibold text-slate-800">
          {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} · {workspace.role}</option>)}
        </select>
        <button type="submit" disabled={pending} className="rounded-lg bg-[#272536] px-3 text-xs font-semibold text-white disabled:opacity-60">{pending ? "Switching…" : "Switch"}</button>
      </div>
      {state.message && <p role="alert" className="mt-2 text-xs text-rose-700">{state.message}</p>}
    </form>
  );
}
