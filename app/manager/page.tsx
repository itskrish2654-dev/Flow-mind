import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { getAuthenticatedContext } from "@/lib/auth";
import { isActiveTeamWork } from "@/lib/manager-work-core";
import { loadManagerCockpit } from "@/lib/manager-work";

function dateLabel(value: string | null) {
  return value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" })
    .format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value)) : "No deadline set";
}

export default async function ManagerPage() {
  const auth = await getAuthenticatedContext();
  if (!auth) redirect("/login?next=/manager");
  const board = await loadManagerCockpit();
  if (!board) notFound();
  const { brief, work, members } = board;
  const label = (id: string) => members.find((member) => member.userId === id)?.label ?? "Former team member";
  const grouped = members.map((member) => ({ member, items: work.filter((item) => item.assignee_user_id === member.userId) }))
    .filter(({ items }) => items.length > 0);
  return <main className="min-w-0 flex-1 overflow-y-auto bg-[#f7f4ee] px-4 pb-12 pt-20 text-[#272536] sm:px-8 lg:pt-8">
    <div className="mx-auto max-w-6xl">
      <header><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#856b36]">Company work</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Team work</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">A view of assigned work and goal progress—not private conversations, email or employee activity tracking.</p>
      </header>
      <section aria-labelledby="manager-brief" className="mt-7 rounded-2xl border border-[#ded6ca] bg-white p-5 sm:p-7">
        <h2 id="manager-brief" className="text-xl font-semibold">Today’s brief</h2>
        <p className="mt-2 text-sm text-slate-600">Counts reflect approved-plan Work Items in this workspace. Completed work does not by itself prove the business outcome.</p>
        <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">{[
          ["Active", brief.active], ["Completed", brief.completed], ["Blocked", brief.blocked],
          ["Overdue", brief.overdue], ["Due within 48 hours", brief.dueSoon], ["Decisions", brief.decisions],
        ].map(([name, value]) => <div key={name} className="rounded-xl border border-[#e4ddd2] bg-[#fcfbf8] p-3"><dt className="text-xs text-slate-600">{name}</dt><dd className="mt-1 text-2xl font-semibold">{value}</dd></div>)}</dl>
        {brief.decisions > 0 && <Link href="/my-day" className="mt-4 inline-block text-sm font-semibold text-[#4b357d] underline underline-offset-2">Review your decisions</Link>}
      </section>
      <section aria-labelledby="manager-goals" className="mt-7">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="manager-goals" className="text-xl font-semibold">Goals</h2><Link href="/goals" className="text-sm font-semibold text-[#4b357d] underline underline-offset-2">Manage goals</Link></div>
        {brief.goals.length === 0 ? <p className="mt-4 rounded-xl border border-dashed border-[#ded6ca] bg-white p-5 text-sm text-slate-600">No goals yet. Define an outcome, review the proposed plan, then approve assignments.</p>
          : <ul className="mt-4 grid gap-3 md:grid-cols-2">{brief.goals.map(({ goal, total, done, blocked, overdue, atRisk }) => <li key={goal.id}><Link href={`/goals/${goal.id}`} className="block h-full rounded-xl border border-[#e4ddd2] bg-white p-5 hover:border-[#ae9bca] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6047a0]">
            <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{goal.title}</h3><span className="text-xs capitalize text-slate-600">{goal.status}</span></div>
            <p className="mt-2 text-sm">{done} of {total} Work Items done{total ? ` · ${Math.round(done / total * 100)}% of assigned work` : ""}</p>
            <p className="mt-1 text-xs text-slate-600">{blocked} blocked · {overdue} overdue · Target {dateLabel(goal.target_date)}</p>
            {atRisk && <span className="mt-3 inline-block rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900">Needs review</span>}
          </Link></li>)}</ul>}
      </section>
      <section aria-labelledby="manager-team" className="mt-8">
        <h2 id="manager-team" className="text-xl font-semibold">Team work</h2>
        <p className="mt-1 text-sm text-slate-600">Only work assigned through approved company goal plans is shown.</p>
        {grouped.length === 0 ? <p className="mt-4 rounded-xl border border-dashed border-[#ded6ca] bg-white p-5 text-sm text-slate-600">No approved work is assigned yet.</p>
          : <div className="mt-4 space-y-4">{grouped.map(({ member, items }) => <section key={member.userId} aria-label={`Assigned work for ${label(member.userId)}`} className="rounded-xl border border-[#e4ddd2] bg-white p-5">
            <div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{label(member.userId)}</h3><p className="text-xs text-slate-600">{items.filter((item) => isActiveTeamWork(item.status)).length} active · {items.filter((item) => item.status === "done").length} completed</p></div>
            <ul className="mt-3 divide-y divide-[#eee8de]">{items.map((item) => <li key={item.id} className="py-3 text-sm"><div className="flex flex-wrap items-start justify-between gap-2"><Link href={`/goals/${item.goal_id}`} className="font-medium text-[#4b357d] underline-offset-2 hover:underline">{item.title}</Link><span className="rounded-full bg-[#f3eff8] px-2.5 py-1 text-xs font-semibold capitalize">{item.status.replaceAll("_", " ")}</span></div>
              <p className="mt-1 text-xs text-slate-600">Due {dateLabel(item.due_at)} · {item.priority} priority</p>
              {item.status_reason && (item.status === "blocked" || item.status === "waiting") && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-slate-700">{item.status === "blocked" ? "Blocker" : "Waiting on"}: {item.status_reason}</p>}
            </li>)}</ul>
          </section>)}</div>}
      </section>
    </div>
  </main>;
}
