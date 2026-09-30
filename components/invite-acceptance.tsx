"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Building2 } from "lucide-react";

import { acceptCompanyInvitationAction, type CompanyActionState } from "@/app/actions/company";

export function InviteAcceptance({ token, workspaceName }: { token: string; workspaceName: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(acceptCompanyInvitationAction, { ok: false } satisfies CompanyActionState);
  useEffect(() => { if (state.ok) router.replace("/my-day?joined=1"); }, [router, state.ok]);
  return <div className="w-full max-w-lg rounded-3xl border border-[#ddd5c9] bg-[#fffdfa] p-6 shadow-[0_30px_90px_-52px_rgba(72,61,35,.32)] sm:p-8"><span className="flex size-12 items-center justify-center rounded-2xl bg-[#fff2bd] text-[#8a6200]"><Building2 className="size-6" /></span><p className="mt-6 text-xs font-semibold uppercase tracking-[0.14em] text-[#8a6200]">Company invitation</p><h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950">Join {workspaceName}</h1><p className="mt-3 text-sm leading-6 text-slate-600">Accept to add this company to CrazyLoops and make it your active workspace. Your existing workspace remains available.</p><form action={action} className="mt-6"><input type="hidden" name="token" value={token} /><button type="submit" disabled={pending} className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#f1c94b] px-5 text-sm font-semibold text-[#272536] disabled:opacity-60">{pending ? "Joining…" : "Accept invitation"}<ArrowRight className="size-4" /></button></form>{state.message && !state.ok && <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{state.message}</p>}</div>;
}
