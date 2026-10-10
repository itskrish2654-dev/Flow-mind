import Link from "next/link";
import {
  Activity,
  BadgeCheck,
  ArrowRight,
  CircleCheck,
  Clock3,
  ListChecks,
  Plus,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { updateMyWorkItem } from "@/app/actions/work-items";
import { dismissAutomationSuggestion } from "@/app/actions/automate-this";
import { decideMyApproval } from "@/app/actions/approvals";
import { StartMyDay } from "@/components/my-day/start-my-day";
import type { MyDayApproval, MyDayData, MyDayItem, MyDayItemStatus } from "@/lib/my-day-model";
import type { AutomationSuggestion } from "@/lib/automate-this";

function displayTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

const statusStyles: Record<MyDayItemStatus, string> = {
  action_required: "border-amber-200 bg-amber-50 text-amber-800",
  ready: "border-emerald-200 bg-emerald-50 text-emerald-700",
  waiting: "border-sky-200 bg-sky-50 text-sky-700",
  running: "border-blue-200 bg-blue-50 text-blue-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  handled: "border-emerald-200 bg-emerald-50 text-emerald-700",
  failed: "border-rose-200 bg-rose-50 text-rose-700",
  cancelled: "border-slate-200 bg-slate-100 text-slate-600",
  blocked: "border-rose-200 bg-rose-50 text-rose-800",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-800",
};

const statusLabels: Record<MyDayItemStatus, string> = {
  action_required: "Needs you",
  ready: "Ready",
  waiting: "Waiting",
  running: "Running",
  success: "Success",
  handled: "Handled",
  failed: "Failed",
  cancelled: "Cancelled",
  blocked: "Blocked",
  completed: "Completed",
};

function MyDayItemCard({ item }: { item: MyDayItem }) {
  const shownTime = displayTime(item.timestamp);
  const dueTime = displayTime(item.workItem?.dueAt ?? null);
  return (
    <article id={item.workItem ? `work-item-${item.workItem.id}` : undefined} className="rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-4 transition hover:border-[#d6c9af] sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.11em] ${statusStyles[item.status]}`}>
          {statusLabels[item.status]}
        </span>
        {shownTime && <time dateTime={item.timestamp ?? undefined} className="text-[11px] text-slate-500">{shownTime}</time>}
        {item.workItem && <span className="text-[11px] font-medium text-slate-500">{item.workItem.priority} priority</span>}
        {dueTime && <span className="text-[11px] text-slate-600">Due <time dateTime={item.workItem?.dueAt ?? undefined}>{dueTime}</time></span>}
      </div>
      <h3 className="mt-3 text-[15px] font-semibold tracking-[-0.015em] text-slate-950">{item.title}</h3>
      <p className="mt-1.5 text-sm leading-6 text-slate-600">{item.description}</p>
      {item.workItem?.whyItMatters && <p className="mt-2 text-xs leading-5 text-slate-600"><span className="font-semibold text-slate-800">Why it matters:</span> {item.workItem.whyItMatters}</p>}
      {item.workItem?.suggestedAction && <p className="mt-1 text-xs leading-5 text-slate-600"><span className="font-semibold text-slate-800">Suggested next step:</span> {item.workItem.suggestedAction}</p>}
      {item.workItem?.statusReason && <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-slate-700"><span className="font-semibold">{item.workItem.status === "blocked" ? "Blocker" : "Waiting on"}:</span> {item.workItem.statusReason}</p>}
      <div className="mt-4 flex flex-col gap-3 border-t border-[#eee8de] pt-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 break-words text-xs font-medium text-slate-500">{item.source}{item.workItem?.goalId && <> · <Link href={`/goals/${item.workItem.goalId}`} className="text-[#4b357d] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6047a0]">View goal and approved plan</Link></>}</p>
        {!item.workItem && <Link
          href={item.cta.href}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 self-start rounded-lg px-1 text-xs font-semibold text-[#725300] hover:text-[#493500] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9b7309] focus-visible:ring-offset-2 sm:min-h-0 sm:self-auto"
        >
          {item.cta.label}<ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>}
      </div>
      {item.workItem && item.workItem.status !== "handled" && item.workItem.status !== "done" && (<>
        <Link href={`/my-day/work/${item.workItem.id}`} className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-[#4b357d] px-4 text-xs font-semibold text-white hover:bg-[#3d2968] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b357d]">Open task · Do with AI →</Link>
        <form action={updateMyWorkItem} className="mt-3 flex flex-wrap gap-2">
          <input type="hidden" name="id" value={item.workItem.id} />
          {item.workItem.status !== "in_progress" && <button name="to" value="in_progress" className="min-h-10 rounded-lg border border-[#ded6ca] px-3 text-xs font-semibold text-slate-700 hover:bg-[#faf8f4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9b7309]">Start work</button>}
          {item.workItem.status !== "needs_you" && <button name="to" value="needs_you" className="min-h-10 rounded-lg border border-[#ded6ca] px-3 text-xs font-semibold text-slate-700 hover:bg-[#faf8f4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9b7309]">Return to Needs You</button>}
          <button name="to" value="done" className="min-h-10 rounded-lg border border-[#ded6ca] px-3 text-xs font-semibold text-slate-700 hover:bg-[#faf8f4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9b7309]">Mark done</button>
        </form>
        <form action={updateMyWorkItem} className="mt-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="id" value={item.workItem.id} />
          <label className="min-w-48 grow text-xs font-medium text-slate-700">Waiting or blocked reason <span className="font-normal">(required for blocked)</span>
            <input name="reason" maxLength={500} placeholder="What are you waiting for?" className="mt-1 block min-h-10 w-full rounded-lg border border-[#ded6ca] bg-white px-3 text-sm" />
          </label>
          {item.workItem.status !== "waiting" && <button name="to" value="waiting" className="min-h-10 rounded-lg border border-[#ded6ca] px-3 text-xs font-semibold text-slate-700 hover:bg-[#faf8f4]">Waiting</button>}
          {item.workItem.status !== "blocked" && <button name="to" value="blocked" className="min-h-10 rounded-lg border border-rose-200 px-3 text-xs font-semibold text-rose-800 hover:bg-rose-50">Blocked</button>}
        </form>
      </>)}
    </article>
  );
}

function SectionHeader({
  id,
  title,
  description,
  icon: Icon,
  count,
}: {
  id: string;
  title: string;
  description: string;
  icon: typeof ListChecks;
  count: number;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border border-[#ead89e] bg-[#fff7dc] text-[#8a6200]">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2 id={id} className="text-lg font-semibold tracking-[-0.025em] text-slate-950">{title}</h2>
          {count > 0 && <span className="rounded-full bg-[#f1ede6] px-2 py-0.5 text-[10px] font-semibold text-slate-600">{count}</span>}
        </div>
        <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
      </div>
    </div>
  );
}

function MyDaySection({
  id,
  title,
  description,
  icon,
  items,
  empty,
  totalCount = items.length,
}: {
  id: string;
  title: string;
  description: string;
  icon: typeof ListChecks;
  items: MyDayItem[];
  empty: string;
  totalCount?: number;
}) {
  return (
    <section aria-labelledby={id} className="rounded-3xl border border-[#ded6ca] bg-white/65 p-4 shadow-[0_18px_60px_rgba(44,39,31,0.035)] sm:p-6">
      <SectionHeader id={id} title={title} description={description} icon={icon} count={totalCount} />
      {items.length > 0 ? (
        <>
          <div className="mt-5 space-y-3">{items.map((item) => <MyDayItemCard key={item.id} item={item} />)}</div>
          {totalCount > items.length && (
            <p className="mt-3 text-xs text-slate-500">Showing the {items.length} highest-priority items out of {totalCount}.</p>
          )}
        </>
      ) : (
        <div className="mt-5 rounded-2xl border border-dashed border-[#ddd3c2] bg-[#faf8f4] px-5 py-8 text-center">
          <CircleCheck className="mx-auto size-5 text-[#a49372]" aria-hidden="true" />
          <p className="mt-2 text-sm leading-6 text-slate-600">{empty}</p>
        </div>
      )}
    </section>
  );
}

function ApprovalCard({ approval }: { approval: MyDayApproval }) {
  return (
    <article className="min-w-0 rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 font-bold uppercase tracking-[0.1em] text-amber-800">Decision needed</span>
        <time dateTime={approval.createdAt}>{displayTime(approval.createdAt)}</time>
        <span>{approval.source}</span>
      </div>
      <h3 className="mt-3 text-[15px] font-semibold text-slate-950">{approval.title}</h3>
      <p className="mt-1.5 break-words text-sm leading-6 text-slate-600">{approval.summary}</p>
      <p className="mt-2 break-words text-xs leading-5 text-slate-700"><span className="font-semibold">Why your approval is needed:</span> {approval.reason}</p>
      <div className="mt-3 rounded-xl border border-[#eee8de] bg-[#faf8f4] p-3 text-xs leading-5 text-slate-700">
        <p className="break-words"><span className="font-semibold">Target:</span> {approval.target}</p>
        {approval.parameters.map((parameter, index) => (
          <p key={`${parameter.label}-${index}`} className="mt-1 break-words"><span className="font-semibold">{parameter.label}:</span> {parameter.value}</p>
        ))}
      </div>
      <form action={decideMyApproval} className="mt-4 flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={approval.id} />
        <label className="min-w-0 grow text-xs font-medium text-slate-700">
          Reason for rejecting (optional)
          <input name="rejectionReason" maxLength={500} className="mt-1 block min-h-10 w-full min-w-0 rounded-lg border border-[#ded6ca] bg-white px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9b7309]" />
        </label>
        <button name="decision" value="approved" className="min-h-10 rounded-lg border border-[#a58a3e] bg-[#fff8df] px-3 text-xs font-semibold text-[#5f4709] hover:bg-[#fff1c5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9b7309]">Approve</button>
        <button name="decision" value="rejected" className="min-h-10 rounded-lg border border-[#ded6ca] px-3 text-xs font-semibold text-slate-700 hover:bg-[#faf8f4] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#9b7309]">Reject</button>
      </form>
      <p className="mt-2 text-[11px] text-slate-500">Approval authorizes only the exact action shown. CrazyLoops records execution success separately and never treats approval as delivery.</p>
    </article>
  );
}

export function MyDayView({ data, automationSuggestions = [], actionError = false, approvalActionError = false }: { data: MyDayData; automationSuggestions?: AutomationSuggestion[]; actionError?: boolean; approvalActionError?: boolean }) {
  return (
    <div className="h-dvh overflow-y-auto bg-[#f7f4ee] text-[#34313d]">
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-20 sm:px-6 sm:pb-20 lg:px-8 lg:pt-10">
        <header className="relative overflow-hidden rounded-3xl border border-[#ded6ca] bg-[#fffdfa] px-5 py-7 shadow-[0_20px_70px_rgba(50,43,30,0.055)] sm:px-8 sm:py-9">
          <div className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-[#fff0b9]/55 blur-3xl" aria-hidden="true" />
          <div className="relative max-w-3xl">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#8a6200]">Your workday, clearly</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.045em] text-[#272536] sm:text-4xl">My Day</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600 sm:text-base">Here’s what needs your attention and what you can move forward.</p>
            <StartMyDay summary={data.summary.sentence} startWith={data.startWith} />
          </div>
        </header>

        <section aria-labelledby="daily-agenda-title" className="mt-6 rounded-2xl border border-[#ded6ca] bg-white p-5 sm:p-6">
          <h2 id="daily-agenda-title" className="text-lg font-semibold">Your daily agenda</h2>
          <p className="mt-1 text-xs text-slate-600">Grounded in your assigned Work Items. Nothing is added from a guess.</p>
          {data.agenda.priorities.length ? <ol className="mt-4 space-y-2">{data.agenda.priorities.map((priority, index) => <li key={priority.href} className="flex gap-3 text-sm"><span className="font-semibold text-[#856b36]">{index + 1}.</span><Link href={priority.href} className="min-w-0 break-words font-medium text-[#4b357d] hover:underline">{priority.title}</Link><span className="text-xs text-slate-600">{priority.reason}</span></li>)}</ol>
            : <p className="mt-4 text-sm text-slate-600">No assigned priorities are due soon. Review Needs You and your approved plans below.</p>}
          <p className="mt-4 text-xs text-slate-600">{data.agenda.waiting} waiting · {data.agenda.atRisk} blocked or due within 48 hours</p>
        </section>

        {automationSuggestions.length > 0 && <section aria-labelledby="automate-this-title" className="mt-6 rounded-2xl border border-[#d6c9b3] bg-[#fffdfa] p-5 sm:p-6">
          <h2 id="automate-this-title" className="text-lg font-semibold text-[#272536]">CrazyLoops found repeated work</h2>
          <p className="mt-1 text-sm text-slate-600">These suggestions come from your completed work. Nothing runs until you review and activate it.</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">{automationSuggestions.map((item) => <article key={item.id} className="min-w-0 rounded-xl border border-[#e5dfd5] bg-white p-4">
            <h3 className="break-words text-base font-semibold text-[#272536]">{item.source_title}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">You completed {item.evidence_count} similar {item.pattern_kind === "gmail_follow_up" ? "Gmail follow-ups" : "AI-assisted results"} in the past 14 days.</p>
            <div className="mt-4 flex flex-wrap items-center gap-3"><Link href={`/automations/${item.id}`} className="inline-flex min-h-11 items-center rounded-lg bg-[#4b357d] px-4 text-xs font-semibold text-white hover:bg-[#3d2968] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b357d]">Automate this</Link>
              <form action={dismissAutomationSuggestion}><input type="hidden" name="suggestionId" value={item.id} /><button className="min-h-11 rounded-lg px-2 text-xs font-semibold text-slate-600 hover:text-slate-950">Not now</button></form></div>
          </article>)}</div>
          <Link href="/automations" className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-[#4b357d] underline underline-offset-2">View your automations</Link>
        </section>}

        {(data.workItemsUnavailable || data.approvalsUnavailable || data.workflowDataUnavailable || data.actionActivityUnavailable || actionError || approvalActionError) && (
          <div role="alert" className="mt-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {approvalActionError ? "That approval could not be decided. Refresh and review its current status."
              : actionError ? "That work item could not be updated. Refresh and try again."
              : data.approvalsUnavailable ? "Approvals are temporarily unavailable. Other work is still shown below."
              : data.workflowDataUnavailable ? "Workflow information is temporarily unavailable. Your saved work items are still shown below."
              : data.actionActivityUnavailable ? "Approved-action activity is temporarily unavailable. Other work is still shown below."
                : "Work items are temporarily unavailable. Your workflow information is still shown below."}
          </div>
        )}

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-12">
          <section aria-labelledby="approvals-title" className="rounded-3xl border border-[#ded6ca] bg-white/65 p-4 shadow-[0_18px_60px_rgba(44,39,31,0.035)] sm:p-6 lg:col-span-12">
            <SectionHeader id="approvals-title" title="Approvals" description="Review exactly what is proposed. Approving authorizes that frozen action; provider success is recorded separately." icon={BadgeCheck} count={data.approvals.length} />
            {data.approvals.length > 0 ? (
              <div className="mt-5 grid gap-3 md:grid-cols-2">{data.approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} />)}</div>
            ) : (
              <p className="mt-5 rounded-2xl border border-dashed border-[#ddd3c2] bg-[#faf8f4] px-5 py-6 text-center text-sm text-slate-600">No approvals are waiting for you.</p>
            )}
          </section>
          <div className="lg:col-span-7">
            <MyDaySection
              id="needs-you-title"
              title="Needs You"
              description="Configuration, connection, or run issues that need a decision."
              icon={TriangleAlert}
              items={data.needsYou}
              totalCount={data.summary.attentionCount}
              empty="You’re clear for now."
            />
          </div>
          <div className="lg:col-span-5">
            <MyDaySection
              id="today-title"
              title="Today"
              description="Work in progress, due today, and workflows you can move forward."
              icon={ListChecks}
              items={data.today}
              empty={data.summary.workflowCount === 0
                ? "Nothing is in progress or due today. Your manager-assigned work appears below."
                : "Nothing is ready to move right now. Review Needs You for the next step."}
            />
          </div>

          <div className="lg:col-span-6"><MyDaySection id="manager-assigned-title" title="Manager Assigned" description="Work from approved company plans assigned to you." icon={ListChecks} items={data.managerAssigned} empty="No manager-assigned work is waiting for you." /></div>
          <div className="lg:col-span-6"><MyDaySection id="deadlines-title" title="Deadlines" description="Assigned work due within seven days, including overdue work." icon={Clock3} items={data.deadlines} empty="No upcoming deadlines in your assigned work." /></div>
          <div className="lg:col-span-6"><MyDaySection id="blocked-title" title="Blocked" description="Work you have marked blocked, with your reason." icon={TriangleAlert} items={data.blocked} empty="No work is blocked." /></div>

          <div className="lg:col-span-5">
            <MyDaySection
              id="waiting-on-title"
              title="Waiting On"
              description="Durable work that is genuinely queued."
              icon={Clock3}
              items={data.waitingOn}
              empty="Nothing is waiting right now."
            />
          </div>
          <div className="lg:col-span-7">
            <MyDaySection
              id="handled-by-crazyloops-title"
              title="Handled by CrazyLoops"
              description="Work confirmed complete by a real execution."
              icon={CircleCheck}
              items={data.handledByCrazyLoops}
              empty="No work has been handled automatically yet."
            />
          </div>
          <div className="lg:col-span-6"><MyDaySection id="completed-title" title="Completed" description="Work you marked done. Goal progress uses these durable completions." icon={CircleCheck} items={data.completed} empty="No recently completed Work Items." /></div>
          <div className="lg:col-span-12">
            <MyDaySection
              id="recent-activity-title"
              title="Recent Activity"
              description="A small, safe view of your latest workflow runs and approved actions."
              icon={Activity}
              items={data.recentActivity}
              empty="Your workflow runs and approved actions will appear here."
            />
            <Link href="/activity" className="mt-3 inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold text-[#725300] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#725300]">See the full trust trail in Activity</Link>
          </div>
        </div>

        <section aria-labelledby="automate-this-title" className="mt-6 overflow-hidden rounded-3xl border border-[#d8c89d] bg-[#fff6d7] p-6 sm:flex sm:items-center sm:justify-between sm:gap-8 sm:p-8">
          <div className="flex items-start gap-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[#e0bd4d] bg-[#f4c84c] text-[#3d3217]">
              <Sparkles className="size-4" aria-hidden="true" />
            </span>
            <div>
              <h2 id="automate-this-title" className="text-lg font-semibold tracking-[-0.025em] text-[#272536]">Automate This</h2>
              <p className="mt-1 max-w-xl text-sm leading-6 text-slate-700">Doing something repeatedly? Describe it once and let CrazyLoops build the workflow.</p>
            </div>
          </div>
          <Link href="/dashboard" className="mt-5 inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border border-[#b78c20] bg-[#fffdfa] px-4 text-sm font-semibold text-[#5f4709] transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9b7309] focus-visible:ring-offset-2 sm:mt-0">
            <Plus className="size-4" aria-hidden="true" />Create automation
          </Link>
        </section>

        <div className="mt-6 text-center">
          <Link href="/dashboard" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-slate-600 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9b7309] focus-visible:ring-offset-2">
            View all workflows<ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </main>
    </div>
  );
}
