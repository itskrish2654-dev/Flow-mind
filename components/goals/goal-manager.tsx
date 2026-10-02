"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  approveGoalPlanAction, editGoalAction, finishGoalAction, generateGoalPlanAction, saveGoalPlanAction,
} from "@/app/actions/goals";
import type { GoalMember } from "@/lib/goals";
import type { Database } from "@/lib/supabase/types";

type Goal = Database["public"]["Tables"]["goals"]["Row"];
type Plan = Database["public"]["Tables"]["goal_plans"]["Row"];
type PlanItem = Database["public"]["Tables"]["goal_plan_items"]["Row"];
type ItemEdit = { title: string; description: string; rationale: string; suggestedOwnerRole: string;
  assigneeUserId: string; dueDate: string; priority: "low" | "normal" | "high" };

const emptyItem = (): ItemEdit => ({ title: "", description: "", rationale: "", suggestedOwnerRole: "",
  assigneeUserId: "", dueDate: "", priority: "normal" });

export function GoalManager({ goal, plan, items, members }: {
  goal: Goal; plan: Plan | null; items: PlanItem[]; members: GoalMember[];
}) {
  const router = useRouter();
  const editable = goal.status === "draft" || goal.status === "awaiting_approval";
  const [editingGoal, setEditingGoal] = useState(false);
  const [editingPlan, setEditingPlan] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [planItems, setPlanItems] = useState<ItemEdit[]>(items.length ? items.map((item) => ({
    title: item.title, description: item.description ?? "", rationale: item.rationale ?? "",
    suggestedOwnerRole: item.suggested_owner_role ?? "", assigneeUserId: item.assignee_user_id ?? "",
    dueDate: item.due_at?.slice(0, 10) ?? "", priority: item.priority,
  })) : [emptyItem()]);
  const labelFor = (id: string | null) => members.find((member) => member.userId === id)?.label ?? "Unassigned";
  async function run(action: () => Promise<{ ok: boolean; error?: string; question?: string }>) {
    if (pending) return;
    setPending(true); setNotice(null);
    const result = await action();
    setPending(false);
    if (!result.ok) setNotice(result.error ?? "This change could not be saved.");
    else if (result.question) setNotice(result.question);
    else { setEditingGoal(false); setEditingPlan(false); setReviewing(false); router.refresh(); }
  }
  function changeItem(index: number, change: Partial<ItemEdit>) {
    setPlanItems((current) => current.map((item, position) => position === index ? { ...item, ...change } : item));
  }
  return <section aria-label="Manage goal" className="mt-5 rounded-2xl border border-[#d9cba9] bg-[#fffdf7] p-5 sm:p-6">
    <h2 className="text-xl font-semibold">Manager controls</h2>
    <p className="mt-1 text-sm text-slate-600">Plans are proposals until you approve the exact revision. Approval creates internal Work Items only; it does not send messages or run external actions.</p>
    {editable && <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" onClick={() => { setEditingGoal(!editingGoal); setEditingPlan(false); }} className="min-h-11 rounded-xl border border-[#c9bdd9] px-4 py-2 text-sm font-semibold text-[#4b357d] hover:bg-white">{editingGoal ? "Close goal edits" : "Edit goal"}</button>
      <button type="button" onClick={() => { setEditingPlan(!editingPlan); setEditingGoal(false); }} className="min-h-11 rounded-xl border border-[#c9bdd9] px-4 py-2 text-sm font-semibold text-[#4b357d] hover:bg-white">{editingPlan ? "Close plan editor" : plan ? "Revise plan" : "Write plan"}</button>
      <button type="button" disabled={pending} onClick={() => void run(async () => generateGoalPlanAction(goal.id))} className="min-h-11 rounded-xl border border-[#c9bdd9] px-4 py-2 text-sm font-semibold text-[#4b357d] hover:bg-white disabled:opacity-50">Propose plan with AI</button>
    </div>}
    {notice && <p role="status" className="mt-4 rounded-xl border border-[#e4ddd2] bg-white p-3 text-sm text-[#583c27]">{notice}</p>}
    {editingGoal && editable && <form className="mt-5 grid gap-4 border-t border-[#e4ddd2] pt-5 sm:grid-cols-2" onSubmit={(event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      void run(() => editGoalAction({ goalId: goal.id, expectedUpdatedAt: goal.updated_at,
        title: data.get("title"), description: data.get("description") || null,
        successCriteria: data.get("successCriteria") || null,
        targetDate: data.get("targetDate") || null, ownerUserId: data.get("ownerUserId") }));
    }}>
      <p className="text-xs text-slate-600 sm:col-span-2">Changing the goal retires the current unapproved proposal. Save or regenerate a new plan after editing.</p>
      <label className="grid gap-1 text-sm font-medium sm:col-span-2">Outcome<input name="title" required minLength={8} maxLength={180} defaultValue={goal.title} className="min-h-11 rounded-xl border border-[#d6cfc4] px-3 py-2 font-normal" /></label>
      <label className="grid gap-1 text-sm font-medium sm:col-span-2">Success condition<textarea name="successCriteria" rows={2} maxLength={1000} defaultValue={goal.success_criteria ?? ""} className="rounded-xl border border-[#d6cfc4] px-3 py-2 font-normal" /></label>
      <label className="grid gap-1 text-sm font-medium sm:col-span-2">Context<textarea name="description" rows={2} maxLength={2000} defaultValue={goal.description ?? ""} className="rounded-xl border border-[#d6cfc4] px-3 py-2 font-normal" /></label>
      <label className="grid gap-1 text-sm font-medium">Owner<select name="ownerUserId" defaultValue={goal.owner_user_id ?? ""} className="min-h-11 rounded-xl border border-[#d6cfc4] px-3 py-2 font-normal">{members.map((member) => <option key={member.userId} value={member.userId}>{member.label}</option>)}</select></label>
      <label className="grid gap-1 text-sm font-medium">Target date<input name="targetDate" type="date" defaultValue={goal.target_date ?? ""} className="min-h-11 rounded-xl border border-[#d6cfc4] px-3 py-2 font-normal" /></label>
      <button type="submit" disabled={pending} className="min-h-11 rounded-xl bg-[#342555] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 sm:col-span-2">Save goal changes</button>
    </form>}
    {editingPlan && editable && <form className="mt-5 space-y-4 border-t border-[#e4ddd2] pt-5" onSubmit={(event) => {
      event.preventDefault();
      void run(() => saveGoalPlanAction({ goalId: goal.id, expectedRevision: plan?.revision ?? 0,
        items: planItems.map((item) => ({ title: item.title, description: item.description || null,
          rationale: item.rationale || null, suggestedOwnerRole: item.suggestedOwnerRole || null,
          assigneeUserId: item.assigneeUserId || null,
          dueAt: item.dueDate ? new Date(`${item.dueDate}T12:00:00Z`).toISOString() : null,
          priority: item.priority })) }));
    }}>
      <p className="text-sm text-slate-600">Saving creates a new immutable proposal revision. Assign every item to a current member before approval.</p>
      {planItems.map((item, index) => <div key={index} className="rounded-xl border border-[#e4ddd2] bg-white p-4">
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Step {index + 1}</h3><button type="button" disabled={planItems.length === 1} onClick={() => setPlanItems((current) => current.filter((_, position) => position !== index))} className="text-xs font-semibold text-red-800 disabled:opacity-40">Remove</button></div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm sm:col-span-2">Work Item title<input required maxLength={180} value={item.title} onChange={(event) => changeItem(index, { title: event.target.value })} className="min-h-11 rounded-lg border border-[#d6cfc4] px-3" /></label>
          <label className="grid gap-1 text-sm sm:col-span-2">Description<textarea maxLength={1000} rows={2} value={item.description} onChange={(event) => changeItem(index, { description: event.target.value })} className="rounded-lg border border-[#d6cfc4] px-3 py-2" /></label>
          <label className="grid gap-1 text-sm">Assignee<select value={item.assigneeUserId} onChange={(event) => changeItem(index, { assigneeUserId: event.target.value })} className="min-h-11 rounded-lg border border-[#d6cfc4] px-3"><option value="">Choose a member</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.label}</option>)}</select></label>
          <label className="grid gap-1 text-sm">Due date<input type="date" value={item.dueDate} onChange={(event) => changeItem(index, { dueDate: event.target.value })} className="min-h-11 rounded-lg border border-[#d6cfc4] px-3" /></label>
          <label className="grid gap-1 text-sm">Priority<select value={item.priority} onChange={(event) => changeItem(index, { priority: event.target.value as ItemEdit["priority"] })} className="min-h-11 rounded-lg border border-[#d6cfc4] px-3"><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></label>
          <div className="flex items-end gap-2"><button type="button" disabled={index === 0} onClick={() => setPlanItems((current) => { const next = [...current]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })} className="min-h-11 rounded-lg border border-[#d6cfc4] px-3 text-xs font-semibold disabled:opacity-40">Move up</button><button type="button" disabled={index === planItems.length - 1} onClick={() => setPlanItems((current) => { const next = [...current]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; return next; })} className="min-h-11 rounded-lg border border-[#d6cfc4] px-3 text-xs font-semibold disabled:opacity-40">Move down</button></div>
        </div>
      </div>)}
      <div className="flex flex-wrap gap-2"><button type="button" disabled={planItems.length >= 12} onClick={() => setPlanItems((current) => [...current, emptyItem()])} className="min-h-11 rounded-xl border border-[#c9bdd9] px-4 text-sm font-semibold text-[#4b357d] disabled:opacity-40">Add step</button><button type="submit" disabled={pending} className="min-h-11 rounded-xl bg-[#342555] px-4 text-sm font-semibold text-white disabled:opacity-50">Save proposal</button></div>
    </form>}
    {editable && plan?.status === "proposed" && !editingPlan && <div className="mt-5 border-t border-[#e4ddd2] pt-5">
      <button type="button" onClick={() => setReviewing(!reviewing)} className="min-h-11 rounded-xl bg-[#342555] px-4 py-2 text-sm font-semibold text-white">{reviewing ? "Close approval review" : "Review exact plan for approval"}</button>
      {reviewing && <div className="mt-4 rounded-xl border border-[#c9bdd9] bg-white p-4"><h3 className="text-base font-semibold">Approve revision {plan.revision}?</h3><p className="mt-2 text-sm">{goal.title}</p><p className="mt-1 text-sm text-slate-600">Success: {goal.success_criteria || "Not defined"}</p>
        <ol className="mt-3 list-inside list-decimal space-y-1 text-sm">{items.map((item) => <li key={item.id}>{item.title} — {labelFor(item.assignee_user_id)}{item.due_at ? ` · ${item.due_at.slice(0, 10)}` : ""} · {item.priority}</li>)}</ol>
        <p className="mt-3 text-sm font-semibold">This creates exactly {items.length} internal Work Items. It does not authorize external actions.</p>
        <button type="button" disabled={pending || !goal.success_criteria || items.some((item) => !item.assignee_user_id)} onClick={() => void run(() => approveGoalPlanAction({ goalId: goal.id, planId: plan.id, revision: plan.revision }))} className="mt-3 min-h-11 rounded-xl bg-[#342555] px-4 text-sm font-semibold text-white disabled:opacity-40">Approve and create work</button>
        {items.some((item) => !item.assignee_user_id) && <p className="mt-2 text-xs text-red-800">Assign every step before approval.</p>}
      </div>}
    </div>}
    {goal.status === "active" && <button type="button" disabled={pending} onClick={() => void run(() => finishGoalAction({ goalId: goal.id, action: "complete" }))} className="mt-5 min-h-11 rounded-xl border border-[#c9bdd9] px-4 text-sm font-semibold text-[#4b357d] disabled:opacity-50">Mark goal complete when all work is done</button>}
    {editable && <button type="button" disabled={pending} onClick={() => { if (window.confirm("Cancel this unapproved goal? Existing Activity history remains.")) void run(() => finishGoalAction({ goalId: goal.id, action: "cancel" })); }} className="mt-5 ml-2 min-h-11 rounded-xl px-4 text-sm font-semibold text-red-800 disabled:opacity-50">Cancel draft goal</button>}
  </section>;
}
