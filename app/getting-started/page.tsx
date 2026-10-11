import Link from "next/link";
import { redirect } from "next/navigation";

import { PilotGuide } from "@/components/pilot-guide";
import { getAuthenticatedContext } from "@/lib/auth";
import { getCompanyAdministration, listCurrentUserWorkspaces } from "@/lib/company";
import { listWorkspaceGoals } from "@/lib/goals";
import { listCompanyKnowledge } from "@/lib/knowledge";

type SetupStep = { title: string; description: string; href: string; action: string; done?: boolean; optional?: boolean };

export default async function GettingStartedPage() {
  const auth = await getAuthenticatedContext();
  if (!auth) redirect("/login?next=/getting-started");
  let workspaces: Awaited<ReturnType<typeof listCurrentUserWorkspaces>>;
  try {
    workspaces = await listCurrentUserWorkspaces();
  } catch {
    return <main className="p-8" role="alert">We couldn’t load your workspace right now. Refresh the page or contact support. Your existing work has not changed.</main>;
  }
  const workspace = workspaces.find((entry) => entry.active);
  if (!workspace) return <main className="p-8" role="alert">Your company workspace could not be loaded. Refresh the page or contact support.</main>;

  const canManage = auth.membership.role !== "member";
  let steps: SetupStep[] = [];
  let setupUnavailable = false;
  if (canManage) {
    try {
      const [company, knowledge, goalPage] = await Promise.all([
        getCompanyAdministration(), listCompanyKnowledge(), listWorkspaceGoals(),
      ]);
      steps = [
        { title: "Name your workspace", description: "Give your team a company name they will recognize. Your private workspace is already created.", href: "/settings/company", action: "Set company name", done: company.workspace.name !== "My workspace" },
        { title: "Add your team", description: "Invite employees by work email and choose their roles. Invitations can be revoked before they are accepted.", href: "/settings/company", action: "Invite teammates", done: company.members.length > 1 || company.invitations.some((invite) => invite.status === "pending" || invite.status === "accepted") },
        { title: "Add Company Knowledge", description: "Upload a short SOP, policy, onboarding guide, process document, or product note. Everyone in this workspace can read it.", href: "/knowledge", action: "Add a document", done: knowledge.documents.some((document) => document.status === "ready") },
        { title: "Create your first Goal", description: "Describe an outcome. CrazyLoops proposes a plan; you review people and deadlines before approving any assignments.", href: "/goals", action: "Create a goal", done: goalPage.goals.length > 0 },
        { title: "Connect tools when needed", description: "Connections are optional at first. Add only the apps a task actually requires.", href: "/connections", action: "Explore connections", optional: true },
        { title: "Start using CrazyLoops", description: "Open My Day to see approvals, assigned work, waiting items, and completed actions.", href: "/my-day", action: "Open My Day" },
      ];
    } catch {
      setupUnavailable = true;
    }
  }

  return <main className="min-w-0 flex-1 overflow-y-auto bg-[#f7f4ee] px-4 pb-16 pt-20 text-[#272536] sm:px-8 lg:pt-9">
    <div className="mx-auto max-w-5xl">
      <header className="rounded-3xl border border-[#ded6ca] bg-[#fffdfa] p-6 sm:p-9">
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#725300]">Getting started · {workspace.name}</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{canManage ? "Bring your company into CrazyLoops" : `Welcome to ${workspace.name}`}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-700">{canManage
          ? "Start with your team and one real goal. You can add knowledge now and connect apps only when your work needs them. No workflow builder is required."
          : "My Day is where work that needs you appears. Ask can help you find context; Do with AI helps you prepare work; Automate This can suggest a repeatable setup after work is completed."}</p>
        {!canManage && <Link href="/my-day" className="mt-6 inline-flex min-h-11 items-center rounded-xl bg-[#4b357d] px-5 text-sm font-semibold text-white hover:bg-[#3d2968]">Go to My Day →</Link>}
      </header>

      {canManage && (setupUnavailable
        ? <section role="alert" className="mt-6 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">We couldn’t check your setup right now. Refresh this page before deciding what is complete. Your existing work has not changed.</section>
        : <section aria-labelledby="setup-title" className="mt-8"><h2 id="setup-title" className="text-xl font-semibold">Your first-company checklist</h2>
          <ol className="mt-4 grid gap-3 md:grid-cols-2">{steps.map((step, index) => <li key={step.title} className="rounded-2xl border border-[#ded6ca] bg-white p-5">
            <div className="flex items-start justify-between gap-3"><span className="text-xs font-bold tracking-wide text-[#856b36]">{String(index + 1).padStart(2, "0")}</span><span className="rounded-full bg-[#f4f0e8] px-2.5 py-1 text-xs font-semibold text-slate-700">{step.optional ? "Optional" : step.done ? "Ready" : "Next step"}</span></div>
            <h3 className="mt-3 text-base font-semibold">{step.title}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{step.description}</p>
            <Link href={step.href} className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-[#4b357d] underline underline-offset-4">{step.action} →</Link>
          </li>)}</ol>
          <p className="mt-5 text-sm text-slate-600">For managers: create a Goal → review the proposed plan → adjust people and deadlines → approve → employees receive tasks in My Day.</p>
        </section>)}
      <PilotGuide />
    </div>
  </main>;
}
