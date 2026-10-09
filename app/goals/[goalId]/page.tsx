import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { reviseGoalWorkAssignmentAction } from "@/app/actions/goals";
import { GoalManager } from "@/components/goals/goal-manager";
import { activityLabel } from "@/lib/activity-core";
import { getAuthenticatedContext } from "@/lib/auth";
import { getWorkspaceGoal, listGoalMembers } from "@/lib/goals";
import { listManagerFinalDeliverables } from "@/lib/workbench";

function shortDate(value: string | null) {
  return value ? new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString("en-GB") : "Not set";
}

export default async function GoalDetailPage({ params, searchParams }: {
  params: Promise<{ goalId: string }>;
  searchParams: Promise<{ assignment_error?: string }>;
}) {
  const { goalId } = await params;
  const auth = await getAuthenticatedContext();
  if (!auth) redirect(`/login?next=/goals/${encodeURIComponent(goalId)}`);
  const [detail, members, finalResults] = await Promise.all([getWorkspaceGoal(goalId), listGoalMembers(), listManagerFinalDeliverables(goalId)]);
  if (!detail) notFound();
  const { goal, plan, items, progress, revisions, events } = detail;
  const assignmentError = (await searchParams).assignment_error === "1";
  const labelFor = (id: string | null) => members.find((member) => member.userId === id)?.label ?? "Member unavailable";
  const sources = Array.isArray(plan?.source_references) ? plan.source_references.flatMap((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return [];
    const item = source as Record<string, unknown>;
    return typeof item.documentId === "string" && typeof item.chunkId === "string" && typeof item.title === "string"
      ? [{ documentId: item.documentId, chunkId: item.chunkId, title: item.title,
        location: typeof item.pageNumber === "number" ? `page ${item.pageNumber}` : `section ${item.section ?? ""}` }] : [];
  }) : [];
  return <main className="min-w-0 flex-1 overflow-y-auto bg-[#f7f4ee] px-4 pb-12 pt-16 text-[#272536] sm:px-8 lg:pt-8">
    <div className="mx-auto max-w-5xl">
      <Link href="/goals" className="text-sm font-semibold text-[#4b357d] hover:underline">← All goals</Link>
      <header className="mt-5 rounded-2xl border border-[#e4ddd2] bg-white p-5 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#856b36]">Workspace goal</p><h1 className="mt-2 break-words text-3xl font-semibold tracking-tight sm:text-4xl">{goal.title}</h1></div><span className="rounded-full bg-[#f3eff8] px-3 py-1 text-xs font-semibold capitalize text-[#4b357d]">{goal.status.replaceAll("_", " ")}</span></div>
        {goal.description && <p className="mt-4 max-w-3xl whitespace-pre-wrap text-sm leading-6 text-slate-700">{goal.description}</p>}
        <dl className="mt-5 grid gap-4 border-t border-[#e4ddd2] pt-5 text-sm sm:grid-cols-3"><div><dt className="font-semibold">Success condition</dt><dd className="mt-1 whitespace-pre-wrap text-slate-600">{goal.success_criteria || "Needs clarification before approval"}</dd></div><div><dt className="font-semibold">Owner</dt><dd className="mt-1 text-slate-600">{labelFor(goal.owner_user_id)}</dd></div><div><dt className="font-semibold">Target</dt><dd className="mt-1 text-slate-600">{shortDate(goal.target_date)}</dd></div></dl>
      </header>
      <section aria-label="Goal progress" className="mt-5 rounded-2xl border border-[#e4ddd2] bg-white p-5 sm:p-6">
        <h2 className="text-xl font-semibold">Progress from actual work</h2>
        {progress ? <><p className="mt-2 text-2xl font-semibold text-[#4b357d]">{progress.completed} of {progress.total} done</p><p className="mt-2 text-sm text-slate-600">{progress.needsAttention} need attention · {progress.blocked} blocked · {progress.overdue} overdue{progress.missing ? ` · ${progress.missing} missing assigned Work Items` : ""}. Only Work Items marked done count as complete.</p></>
          : <p className="mt-2 text-sm text-slate-600">No work is active. A manager must review and approve a plan first.</p>}
      </section>
      {detail.canManage && <GoalManager key={`${goal.updated_at}:${plan?.id ?? "none"}`} goal={goal} plan={plan} items={items} members={members} />}
      {assignmentError && <p role="alert" className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">That assignment changed or could not be saved. Refresh and review the live work before trying again.</p>}
      <section aria-label="Execution plan" className="mt-5 rounded-2xl border border-[#e4ddd2] bg-white p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-xl font-semibold">{plan?.status === "approved" ? "Approved execution plan" : "Proposed plan"}</h2>{plan && <span className="text-xs text-slate-600">Revision {plan.revision} · {plan.status}</span>}</div>
        {items.length === 0 ? <p className="mt-3 text-sm text-slate-600">No proposal yet. A manager can generate or write one.</p> : <ol className="mt-4 space-y-3">{items.map((item) => <li key={item.id} className="rounded-xl border border-[#e4ddd2] bg-[#fcfbf8] p-4">
          <div className="flex items-start gap-3"><span className="text-sm font-semibold text-[#856b36]">{String(item.position).padStart(2, "0")}</span><div className="min-w-0 flex-1"><h3 className="break-words text-sm font-semibold">{item.title}</h3>{item.description && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{item.description}</p>}
            {item.rationale && <p className="mt-1 whitespace-pre-wrap text-xs text-slate-600"><span className="font-semibold">Why this work:</span> {item.rationale}</p>}
            {item.suggested_owner_role && <p className="mt-1 text-xs text-slate-600">Suggested role: {item.suggested_owner_role}</p>}
            <p className="mt-2 text-xs text-slate-600">{labelFor(item.workItem?.assignee_user_id ?? item.assignee_user_id)} · Due {shortDate(item.workItem ? item.workItem.due_at : item.due_at)} · {item.priority} priority{item.workItem ? ` · ${item.workItem.status.replaceAll("_", " ")}` : ""}</p>
            {item.workItem?.status_reason && (item.workItem.status === "blocked" || item.workItem.status === "waiting") && (detail.canManage || item.workItem.assignee_user_id === detail.currentUserId) && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-700">{item.workItem.status === "blocked" ? "Blocker" : "Waiting on"}: {item.workItem.status_reason}</p>}
            {item.workItem?.assignee_user_id === detail.currentUserId && <Link href={`/my-day#work-item-${item.workItem.id}`} className="mt-2 inline-block text-xs font-semibold text-[#4b357d] hover:underline">Open in My Day →</Link>}</div></div>
          {detail.canManage && goal.status === "active" && item.workItem && item.workItem.status !== "done" && item.workItem.status !== "handled" && <form action={reviseGoalWorkAssignmentAction} className="mt-3 grid gap-2 border-t border-[#e4ddd2] pt-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
            <input type="hidden" name="goalId" value={goal.id} /><input type="hidden" name="workItemId" value={item.workItem.id} /><input type="hidden" name="expectedUpdatedAt" value={item.workItem.updated_at} />
            <label className="grid gap-1 text-xs font-medium">Assigned to<select name="assigneeUserId" defaultValue={item.workItem.assignee_user_id} className="min-h-11 rounded-lg border border-[#d6cfc4] bg-white px-2 text-sm">{members.map((member) => <option key={member.userId} value={member.userId}>{member.label}</option>)}</select></label>
            <label className="grid gap-1 text-xs font-medium">Due<input type="date" name="dueDate" defaultValue={item.workItem.due_at?.slice(0, 10) ?? ""} className="min-h-11 rounded-lg border border-[#d6cfc4] bg-white px-2 text-sm" /></label>
            <button className="min-h-11 rounded-lg border border-[#c9bdd9] px-3 text-xs font-semibold text-[#4b357d] hover:bg-white">Save assignment</button>
          </form>}
        </li>)}</ol>}
        {detail.canManage && goal.status === "active" && <p className="mt-4 text-xs text-slate-600">Live assignment and due-date changes are recorded in Activity. The approved plan remains unchanged.</p>}
        {sources.length > 0 && <div className="mt-5 border-t border-[#e4ddd2] pt-4"><h3 className="text-sm font-semibold">Company sources used in this proposal</h3><ul className="mt-2 space-y-1">{sources.map((source) => <li key={source.chunkId}><Link className="text-sm text-[#4b357d] hover:underline" href={`/knowledge/${source.documentId}?chunk=${source.chunkId}#chunk-${source.chunkId}`}>{source.title} · {source.location}</Link></li>)}</ul></div>}
      </section>
      {detail.canManage && <section aria-label="Final team work" className="mt-5 rounded-2xl border border-[#e4ddd2] bg-white p-5 sm:p-6">
        <h2 className="text-xl font-semibold">Final team work</h2>
        <p className="mt-2 text-sm text-slate-600">Only employee-finalized deliverables appear here. Private AI working notes and drafts remain with their assigned employee.</p>
        {finalResults.length === 0 ? <p className="mt-4 text-sm text-slate-600">No final results yet.</p> : <div className="mt-4 space-y-4">{finalResults.map((result) => <article key={result.id} className="rounded-xl border border-[#e4ddd2] bg-[#fcfbf8] p-4">
          <h3 className="break-words text-base font-semibold">{result.title}</h3><p className="mt-1 text-xs text-slate-600">By {labelFor(result.owner_user_id)} · {result.finalized_at ? new Date(result.finalized_at).toLocaleDateString("en-GB") : "Final"}</p>
          <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-slate-700">{result.content}</p>
        </article>)}</div>}
      </section>}
      {revisions.length > 1 && <p className="mt-4 text-xs text-slate-600">{revisions.length} proposal revisions preserved. The approved revision cannot be edited.</p>}
      <section aria-label="Goal activity" className="mt-5 rounded-2xl border border-[#e4ddd2] bg-white p-5 sm:p-6"><h2 className="text-xl font-semibold">Recent Activity</h2>
        {events.length === 0 ? <p className="mt-3 text-sm text-slate-600">No goal events recorded yet.</p> : <ul className="mt-3 divide-y divide-[#e4ddd2]">{events.map((event) => <li key={event.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><span>{activityLabel(event)}</span><time className="text-slate-600" dateTime={event.occurred_at}>{shortDate(event.occurred_at)}</time></li>)}</ul>}
      </section>
    </div>
  </main>;
}
