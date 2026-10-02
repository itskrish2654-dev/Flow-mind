import Link from "next/link";
import { redirect } from "next/navigation";

import { CreateGoalForm } from "@/components/goals/create-goal-form";
import { getAuthenticatedContext } from "@/lib/auth";
import { listGoalMembers, listWorkspaceGoals } from "@/lib/goals";

export default async function GoalsPage() {
  const auth = await getAuthenticatedContext();
  if (!auth) redirect("/login?next=/goals");
  const [{ goals, canManage }, members] = await Promise.all([listWorkspaceGoals(), listGoalMembers()]);
  return <main className="min-w-0 flex-1 overflow-y-auto bg-[#f7f4ee] px-4 pb-12 pt-16 text-[#272536] sm:px-8 lg:pt-8">
    <div className="mx-auto max-w-5xl">
      <header className="mb-8"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#856b36]">Work OS</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Goals</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">Turn a clear outcome into a reviewed plan and track progress from work your team actually completes.</p>
      </header>
      {canManage && <CreateGoalForm members={members} currentUserId={auth.user.id} />}
      <section aria-label="Workspace goals" className="mt-8">
        {goals.length === 0 ? <div className="rounded-2xl border border-dashed border-[#d8caa8] bg-white p-8">
          <h2 className="text-lg font-semibold">No goals yet</h2>
          <p className="mt-2 text-sm text-slate-600">{canManage ? "Create a goal with a concrete outcome. The plan will be reviewed before anyone receives work." : "An owner or admin can create the first workspace goal."}</p>
        </div> : <ul className="grid gap-3 md:grid-cols-2">{goals.map((goal) => {
          const owner = members.find((member) => member.userId === goal.owner_user_id)?.label ?? "Owner unavailable";
          return <li key={goal.id}><Link href={`/goals/${goal.id}`} className="block h-full rounded-2xl border border-[#e4ddd2] bg-white p-5 shadow-sm transition hover:border-[#ae9bca] hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6047a0]">
            <div className="flex flex-wrap items-start justify-between gap-2"><h2 className="max-w-[36ch] break-words text-lg font-semibold">{goal.title}</h2><span className="rounded-full bg-[#f3eff8] px-3 py-1 text-xs font-semibold capitalize text-[#4b357d]">{goal.status.replaceAll("_", " ")}</span></div>
            <p className="mt-3 text-sm text-slate-600">Owner: {owner}{goal.target_date ? ` · Target ${new Date(`${goal.target_date}T12:00:00`).toLocaleDateString("en-GB")}` : ""}</p>
            <p className="mt-3 text-sm font-medium text-[#4b357d]">{goal.progress ? `${goal.progress.completed}/${goal.progress.total} Work Items done${goal.progress.needsAttention ? ` · ${goal.progress.needsAttention} need attention` : ""}` : "No work active yet"}</p>
          </Link></li>;
        })}</ul>}
      </section>
    </div>
  </main>;
}
