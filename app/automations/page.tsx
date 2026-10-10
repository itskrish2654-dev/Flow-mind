import Link from "next/link";
import { redirect } from "next/navigation";

import { dismissAutomationSuggestion } from "@/app/actions/automate-this";
import { listMyAutomationSuggestions } from "@/lib/automate-this";

const groups = [
  { key: "active", title: "Active", description: "Only work matching your reviewed conditions is prepared." },
  { key: "suggested", title: "Suggested", description: "Patterns CrazyLoops noticed. Nothing runs until you activate it." },
  { key: "paused", title: "Paused", description: "These will not prepare new work until you resume them." },
  { key: "configured", title: "Ready for review", description: "A draft exists, but it is not active." },
  { key: "disabled", title: "Disabled", description: "These workflows have been archived and cannot run." },
] as const;

export default async function AutomationsPage() {
  const suggestions = await listMyAutomationSuggestions();
  if (!suggestions) redirect("/login?next=/automations");
  return <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-20 sm:px-6 lg:px-8 lg:pt-10">
    <header className="rounded-3xl border border-[#ded6ca] bg-[#fffdfa] p-6 sm:p-9">
      <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#725300]">Your work, made repeatable</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[#272536] sm:text-4xl">Automations</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-700">CrazyLoops can notice repeated completed work and suggest a safer way to prepare the next instance. You decide what it does and when it starts. External actions still require your approval.</p>
    </header>
    {groups.map((group) => {
      const entries = suggestions.filter((item) => item.status === group.key || (group.key === "configured" && item.status === "accepted"));
      return <section key={group.key} aria-labelledby={`${group.key}-title`} className="mt-8">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><h2 id={`${group.key}-title`} className="text-xl font-semibold text-[#272536]">{group.title}</h2><p className="text-sm text-slate-600">{group.description}</p></div>
        {entries.length ? <div className="mt-4 grid gap-3 sm:grid-cols-2">{entries.map((item) => <article key={item.id} className="min-w-0 rounded-2xl border border-[#ded6ca] bg-white p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#725300]">{item.pattern_kind === "gmail_follow_up" ? "Gmail follow-up" : "AI preparation"} · {item.evidence_count} completed examples</p>
          <h3 className="mt-2 break-words text-lg font-semibold text-[#272536]">{item.source_title}</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">CrazyLoops found the same kind of work repeatedly in the past 14 days. No future work is changed unless you activate the reviewed setup.</p>
          <div className="mt-4 flex flex-wrap items-center gap-3"><Link href={`/automations/${item.id}`} className="inline-flex min-h-11 items-center rounded-lg bg-[#4b357d] px-4 text-sm font-semibold text-white hover:bg-[#3d2968] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b357d]">{group.key === "suggested" ? "Automate this" : "Review automation"}</Link>
            {group.key === "suggested" && <form action={dismissAutomationSuggestion}><input type="hidden" name="suggestionId" value={item.id} /><button className="min-h-11 rounded-lg px-3 text-sm font-medium text-slate-600 hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b357d]">Not now</button></form>}</div>
        </article>)}</div> : <p className="mt-4 rounded-2xl border border-dashed border-[#ded6ca] bg-white/60 p-5 text-sm text-slate-600">{group.key === "suggested" ? "No repeated-work suggestion yet. CrazyLoops waits for multiple completed examples before suggesting one." : "Nothing here right now."}</p>}
      </section>;
    })}
  </main>;
}
