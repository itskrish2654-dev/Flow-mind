import Link from "next/link";
import { redirect } from "next/navigation";

import { activityLabel, activityOutcome, activitySourceHref, parseActivityCursor, parseActivityFilter, type ActivityFilter } from "@/lib/activity-core";
import { getCurrentWorkspaceActivityDetail, listCurrentWorkspaceActivity } from "@/lib/activity";

const filters: { key: ActivityFilter; label: string }[] = [
  { key: "all", label: "All" }, { key: "attention", label: "Needs attention" },
  { key: "approvals", label: "Approvals" }, { key: "actions", label: "Actions" },
  { key: "workflows", label: "Workflows" },
];

function activityTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));
}

export default async function ActivityPage({ searchParams }: {
  searchParams: Promise<{ filter?: string; before?: string; entry?: string }>;
}) {
  const params = await searchParams;
  const filter = parseActivityFilter(params.filter);
  const page = await listCurrentWorkspaceActivity(filter, parseActivityCursor(params.before));
  if (!page) redirect("/login?next=/activity");
  const entryId = parseActivityCursor(params.entry);
  const detail = entryId !== null ? await getCurrentWorkspaceActivityDetail(entryId) : null;

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-[#f7f4ee] px-4 pb-12 pt-16 text-[#272536] sm:px-8 lg:pt-8">
      <div className="mx-auto max-w-4xl">
        <header className="mb-7">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#856b36]">Work OS</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Activity</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">What needed attention, what was approved, and what CrazyLoops actually completed. Approval alone never means a provider received the action.</p>
        </header>
        <nav aria-label="Activity filters" className="mb-6 flex flex-wrap gap-2">
          {filters.map(({ key, label }) => <Link key={key} href={`/activity?filter=${key}`} aria-current={filter === key ? "page" : undefined}
            className={`rounded-full border px-4 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#725300] ${filter === key ? "border-[#b48b2c] bg-[#fff1ba] text-[#272536]" : "border-[#ddd5c9] bg-white text-slate-700 hover:border-[#b48b2c]"}`}>{label}</Link>)}
        </nav>
        {detail && <section aria-labelledby="activity-detail-title" className="mb-6 rounded-2xl border border-[#d8caa8] bg-white p-5 shadow-sm sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#856b36]">Trust trail</p><h2 id="activity-detail-title" className="mt-1 text-xl font-semibold">{detail.title ?? activityLabel(detail.event)}</h2></div>
            <Link href={`/activity?filter=${filter}`} className="text-sm font-medium text-[#725300] underline underline-offset-4">Close</Link>
          </div>
          {detail.summary && <p className="mt-3 break-words text-sm leading-6 text-slate-700">{detail.summary}</p>}
          {detail.event.visibility === "workspace" && <p className="mt-3 text-sm text-slate-600">Only this company-safe outcome is shared. Private content and action parameters are not available here.</p>}
          {detail.approval && <div className="mt-4 rounded-xl bg-[#f8f4ec] px-4 py-3 text-sm text-slate-700">
            <p>Requested by {detail.approval.requestedByYou ? "you" : "a teammate"} on {activityTime(detail.approval.requestedAt)}. Decision: {detail.approval.status}{detail.approval.decidedAt ? ` at ${activityTime(detail.approval.decidedAt)}` : " pending"}{detail.approval.decidedByYou ? " by you" : ""}. An approval is not delivery.</p>
            {detail.approval.target && <p className="mt-2">Approved target: <span className="break-words font-medium">{detail.approval.target}</span></p>}
            {detail.approval.parameters.length > 0 && <dl className="mt-2 space-y-1">{detail.approval.parameters.map((parameter) => <div key={parameter.label} className="flex flex-wrap gap-x-2"><dt className="font-medium">{parameter.label}:</dt><dd className="break-all">{parameter.value}</dd></div>)}</dl>}
          </div>}
          {detail.action && <div className="mt-3 rounded-xl bg-[#f8f4ec] px-4 py-3 text-sm text-slate-700">
            <p>Execution: {detail.action.status === "ambiguous" ? "outcome uncertain" : detail.action.status}. Provider acknowledgement: {detail.action.acknowledged && detail.action.externallyDelivered && detail.action.status === "succeeded" ? "confirmed" : "not confirmed"}.</p>
            {detail.action.startedAt && <p className="mt-1">Started {activityTime(detail.action.startedAt)}.</p>}
            {detail.action.completedAt && <p className="mt-1">Last result {activityTime(detail.action.completedAt)}.</p>}
            {detail.action.resultSummary && <p className="mt-1 break-words">{detail.action.resultSummary}</p>}
            {detail.action.failureCategory && <p className="mt-1">Reason: {detail.action.failureCategory.replaceAll("_", " ")}.</p>}
          </div>}
          <ol className="mt-5 space-y-3 border-l-2 border-[#eadcb8] pl-5">
            {detail.trail.map((event) => <li key={event.id} className="relative text-sm before:absolute before:-left-[27px] before:top-1 before:size-2.5 before:rounded-full before:bg-[#bd9634]">
              <span className="font-medium">{activityLabel(event)}</span><span className="ml-2 text-slate-500">{activityTime(event.occurred_at)}</span>
            </li>)}
          </ol>
          {activitySourceHref(detail.event) && <Link href={activitySourceHref(detail.event)!} className="mt-5 inline-block text-sm font-semibold text-[#725300] underline underline-offset-4">Open related work</Link>}
        </section>}
        {entryId !== null && !detail && <p role="status" className="mb-6 rounded-xl border border-[#ddd5c9] bg-white p-4 text-sm text-slate-700">That Activity entry is unavailable to you.</p>}
        {page.events.length === 0 ? <section className="rounded-2xl border border-dashed border-[#d8caa8] bg-white p-8 text-center"><h2 className="text-lg font-semibold">No Activity here yet</h2><p className="mt-2 text-sm text-slate-600">Meaningful work and decisions will appear here after they happen.</p></section>
          : <ol aria-label="Recent activity" className="space-y-3">{page.events.map((event) => <li key={event.id}>
            <Link href={`/activity?filter=${filter}&entry=${event.id}`} className="block rounded-2xl border border-[#e4ddd2] bg-white p-4 shadow-sm transition hover:border-[#c6a454] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#725300] sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-2"><h2 className="min-w-0 flex-1 text-base font-semibold">{activityLabel(event)}</h2><span className="rounded-full bg-[#f8f4ec] px-3 py-1 text-xs font-medium text-slate-700">{activityOutcome(event)}</span></div>
              <p className="mt-2 text-xs text-slate-500"><time dateTime={event.occurred_at}>{activityTime(event.occurred_at)} UTC</time> · {event.visibility === "private" ? "Your private activity" : "Company-safe summary"}</p>
            </Link>
          </li>)}</ol>}
        {page.nextCursor !== null && <Link href={`/activity?filter=${filter}&before=${page.nextCursor}`} className="mt-6 inline-flex min-h-11 items-center rounded-xl border border-[#d8caa8] bg-white px-5 text-sm font-semibold text-[#725300]">Older activity</Link>}
      </div>
    </main>
  );
}
