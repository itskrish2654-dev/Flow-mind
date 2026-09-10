import Link from "next/link";
import {
  Activity,
  ArrowRight,
  CircleCheck,
  Clock3,
  ListChecks,
  Plus,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

import { StartMyDay } from "@/components/my-day/start-my-day";
import type { MyDayData, MyDayItem, MyDayItemStatus } from "@/lib/my-day-model";

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
  failed: "border-rose-200 bg-rose-50 text-rose-700",
};

const statusLabels: Record<MyDayItemStatus, string> = {
  action_required: "Needs you",
  ready: "Ready",
  waiting: "Waiting",
  running: "Running",
  success: "Success",
  failed: "Failed",
};

function MyDayItemCard({ item }: { item: MyDayItem }) {
  const shownTime = displayTime(item.timestamp);
  return (
    <article className="rounded-2xl border border-[#e4ddd2] bg-[#fffdfa] p-4 transition hover:border-[#d6c9af] sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.11em] ${statusStyles[item.status]}`}>
          {statusLabels[item.status]}
        </span>
        {shownTime && <time dateTime={item.timestamp ?? undefined} className="text-[11px] text-slate-500">{shownTime}</time>}
      </div>
      <h3 className="mt-3 text-[15px] font-semibold tracking-[-0.015em] text-slate-950">{item.title}</h3>
      <p className="mt-1.5 text-sm leading-6 text-slate-600">{item.description}</p>
      <div className="mt-4 flex flex-col gap-3 border-t border-[#eee8de] pt-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 truncate text-xs font-medium text-slate-500">{item.source}</p>
        <Link
          href={item.cta.href}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 self-start rounded-lg px-1 text-xs font-semibold text-[#725300] hover:text-[#493500] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9b7309] focus-visible:ring-offset-2 sm:min-h-0 sm:self-auto"
        >
          {item.cta.label}<ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
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
}: {
  id: string;
  title: string;
  description: string;
  icon: typeof ListChecks;
  items: MyDayItem[];
  empty: string;
}) {
  return (
    <section aria-labelledby={id} className="rounded-3xl border border-[#ded6ca] bg-white/65 p-4 shadow-[0_18px_60px_rgba(44,39,31,0.035)] sm:p-6">
      <SectionHeader id={id} title={title} description={description} icon={icon} count={items.length} />
      {items.length > 0 ? (
        <div className="mt-5 space-y-3">{items.map((item) => <MyDayItemCard key={item.id} item={item} />)}</div>
      ) : (
        <div className="mt-5 rounded-2xl border border-dashed border-[#ddd3c2] bg-[#faf8f4] px-5 py-8 text-center">
          <CircleCheck className="mx-auto size-5 text-[#a49372]" aria-hidden="true" />
          <p className="mt-2 text-sm leading-6 text-slate-600">{empty}</p>
        </div>
      )}
    </section>
  );
}

export function MyDayView({ data }: { data: MyDayData }) {
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

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <MyDaySection
              id="needs-you-title"
              title="Needs You"
              description="Configuration, connection, or run issues that need a decision."
              icon={TriangleAlert}
              items={data.needsYou}
              empty="You’re clear for now."
            />
          </div>
          <div className="lg:col-span-5">
            <MyDaySection
              id="today-title"
              title="Today"
              description="Workflows you can move forward now."
              icon={ListChecks}
              items={data.today}
              empty={data.summary.workflowCount === 0
                ? "Create your first workflow to give CrazyLoops something to help you move."
                : "Nothing is ready to move right now. Review Needs You for the next step."}
            />
          </div>

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
              id="recent-activity-title"
              title="Recent Activity"
              description="A small, safe view of your latest workflow runs."
              icon={Activity}
              items={data.recentActivity}
              empty="Your workflow runs will appear here."
            />
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
