"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { createGoalAction } from "@/app/actions/goals";
import type { GoalMember } from "@/lib/goals";

export function CreateGoalForm({ members, currentUserId }: {
  members: GoalMember[]; currentUserId: string;
}) {
  const router = useRouter();
  const requestId = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <section className="rounded-2xl border border-[#e4ddd2] bg-white p-5 shadow-sm sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-lg font-semibold">Set an outcome for your team</h2><p className="mt-1 text-sm text-slate-600">A draft does not assign anyone work. You review the plan first.</p></div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="min-h-11 rounded-xl bg-[#342555] px-4 py-2 text-sm font-semibold text-white hover:bg-[#4e377a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6047a0]">{open ? "Close" : "Create goal"}</button>
    </div>
    {open && <form className="mt-6 grid gap-4 border-t border-[#e4ddd2] pt-5 sm:grid-cols-2" onSubmit={async (event) => {
      event.preventDefault(); if (pending) return;
      const form = new FormData(event.currentTarget);
      requestId.current ??= crypto.randomUUID();
      setPending(true); setError(null);
      const result = await createGoalAction({ requestId: requestId.current,
        title: form.get("title"), description: form.get("description") || null,
        successCriteria: form.get("successCriteria") || null,
        targetDate: form.get("targetDate") || null, ownerUserId: form.get("ownerUserId") });
      setPending(false);
      if (result.ok && result.goalId) router.push(`/goals/${result.goalId}`);
      else if (!result.ok) setError(result.error);
    }}>
      <label className="grid gap-1 text-sm font-medium sm:col-span-2">Desired outcome
        <input name="title" required minLength={8} maxLength={180} placeholder="Hire 3 customer support agents" className="min-h-11 rounded-xl border border-[#d6cfc4] px-3 py-2 font-normal focus-visible:outline-2 focus-visible:outline-[#6047a0]" /></label>
      <label className="grid gap-1 text-sm font-medium sm:col-span-2">What does success look like?
        <textarea name="successCriteria" maxLength={1000} rows={2} placeholder="Three candidates have accepted written offers." className="rounded-xl border border-[#d6cfc4] px-3 py-2 font-normal focus-visible:outline-2 focus-visible:outline-[#6047a0]" /></label>
      <label className="grid gap-1 text-sm font-medium sm:col-span-2">Context <span className="text-slate-500">(optional)</span>
        <textarea name="description" maxLength={2000} rows={2} className="rounded-xl border border-[#d6cfc4] px-3 py-2 font-normal focus-visible:outline-2 focus-visible:outline-[#6047a0]" /></label>
      <label className="grid gap-1 text-sm font-medium">Goal owner
        <select name="ownerUserId" defaultValue={currentUserId} className="min-h-11 rounded-xl border border-[#d6cfc4] px-3 py-2 font-normal focus-visible:outline-2 focus-visible:outline-[#6047a0]">{members.map((member) => <option key={member.userId} value={member.userId}>{member.label} ({member.role})</option>)}</select></label>
      <label className="grid gap-1 text-sm font-medium">Target date <span className="text-slate-500">(optional)</span>
        <input type="date" name="targetDate" className="min-h-11 rounded-xl border border-[#d6cfc4] px-3 py-2 font-normal focus-visible:outline-2 focus-visible:outline-[#6047a0]" /></label>
      {error && <p role="alert" className="text-sm text-red-800 sm:col-span-2">{error}</p>}
      <button type="submit" disabled={pending} className="min-h-11 rounded-xl bg-[#342555] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 sm:col-span-2">{pending ? "Saving…" : "Save draft goal"}</button>
    </form>}
  </section>;
}
