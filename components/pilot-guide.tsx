import Link from "next/link";

const parts = [
  { title: "My Day", description: "Your assigned tasks, approvals, waiting work, and what CrazyLoops has finished.", href: "/my-day" },
  { title: "A Goal", description: "An outcome your manager turns into a proposed plan. People and deadlines are reviewed before tasks are assigned.", href: "/goals" },
  { title: "Ask CrazyLoops", description: "Ask about work and authorized company sources. Answers should say when information is missing.", href: "/ask" },
  { title: "Do with AI", description: "Draft work inside a task, review it, then save or finalize it. Your private draft is not a manager report.", href: "/my-day" },
  { title: "Automate This", description: "After repeated completed work, review a suggested automation before activating it. Nothing starts on its own.", href: "/automations" },
  { title: "Approvals", description: "Review the exact external action first. Approval permits an attempt; Activity records whether the provider actually completed it.", href: "/activity" },
] as const;

export function PilotGuide() {
  return <section aria-labelledby="pilot-guide-title" className="mt-8 rounded-2xl border border-[#ded6ca] bg-white p-5 sm:p-7">
    <h2 id="pilot-guide-title" className="text-xl font-semibold text-[#272536]">How CrazyLoops fits into your day</h2>
    <div className="mt-5 grid gap-3 sm:grid-cols-2">{parts.map((part) => <article key={part.title} className="rounded-xl border border-[#eee8de] bg-[#fcfbf8] p-4">
      <h3 className="text-sm font-semibold text-[#272536]"><Link href={part.href} className="underline decoration-[#cbb99a] underline-offset-4 hover:decoration-[#4b357d]">{part.title}</Link></h3>
      <p className="mt-1 text-sm leading-6 text-slate-600">{part.description}</p>
    </article>)}</div>
    <p className="mt-5 border-t border-[#eee8de] pt-4 text-sm leading-6 text-slate-600">Managers can see company goals, assigned tasks, progress, blockers, and appropriate final work. They do not automatically see your private Ask conversations, Gmail, or unfinished AI drafts.</p>
  </section>;
}
