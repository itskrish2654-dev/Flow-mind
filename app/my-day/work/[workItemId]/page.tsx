import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { completeWorkbenchWorkAction, finalizeWorkbenchResultAction, generateWorkbenchAction,
  prepareWorkbenchEmailAction, saveWorkbenchResultAction } from "@/app/actions/workbench";
import { CopyButton } from "@/components/workbench/copy-button";
import { getAuthenticatedContext } from "@/lib/auth";
import type { Json } from "@/lib/supabase/types";
import { loadWorkItemWorkbench } from "@/lib/workbench";
import { classifyWorkMode } from "@/lib/workbench-core";
import { getCurrentUserWorkItem } from "@/lib/work-items";

function sources(value: Json) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    return typeof row.documentId === "string" && typeof row.chunkId === "string" && typeof row.title === "string"
      && /^[0-9a-f-]{36}$/i.test(row.documentId) && /^[0-9a-f-]{36}$/i.test(row.chunkId)
      ? [{ documentId: row.documentId, chunkId: row.chunkId, title: row.title,
        location: typeof row.location === "string" ? row.location : "Company knowledge" }] : [];
  });
}

function SourceList({ value }: { value: Json }) {
  const references = sources(value);
  return references.length ? <div className="mt-3 border-t border-[#eee8de] pt-3">
    <p className="text-xs font-semibold text-slate-700">Company sources consulted — verify against the final wording</p>
    <ul className="mt-2 space-y-1">{references.map((source) => <li key={source.chunkId}>
      <Link className="break-words text-xs text-[#4b357d] underline underline-offset-2" href={`/knowledge/${source.documentId}?chunk=${source.chunkId}#chunk-${source.chunkId}`}>
        {source.title} · {source.location}
      </Link>
    </li>)}</ul>
  </div> : <p className="mt-3 text-xs text-slate-500">No company source was cited. Check external facts before relying on this draft.</p>;
}

const messages: Record<string, string> = {
  generated: "AI draft ready. Review and edit it before saving.",
  processing: "This AI draft is still in progress. Refresh shortly to check its result.",
  ai_failed: "AI could not finish this draft. Your task and saved results were not changed.",
  saved: "Result saved as a new draft revision.",
  save_failed: "The result could not be saved. Check the task and try again.",
  finalized: "Final result is ready for the Goal manager to review.",
  finalize_failed: "This draft could not be finalized.",
  completed: "Task marked complete. Goal progress now reflects this work.",
  complete_failed: "The task could not be marked complete.",
  email_failed: "The email preview could not be prepared. Nothing was sent.",
};

export default async function WorkItemWorkbenchPage({ params, searchParams }: {
  params: Promise<{ workItemId: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { workItemId } = await params;
  const auth = await getAuthenticatedContext();
  if (!auth) redirect(`/login?next=/my-day/work/${encodeURIComponent(workItemId)}`);
  const item = await getCurrentUserWorkItem(workItemId).catch(() => null);
  if (!item) notFound();
  const data = await loadWorkItemWorkbench(item.id);
  const result = (await searchParams).result ?? "";
  const active = !["done", "handled"].includes(item.status);
  const mode = classifyWorkMode(`${item.title} ${item.summary ?? ""}`);
  const latestTurn = data.turns.find((turn) => turn.status === "completed");
  const latestDraft = data.deliverables.find((deliverable) => deliverable.status === "draft");
  const latestFinal = data.deliverables.find((deliverable) => deliverable.status === "final");
  return <main className="min-w-0 flex-1 overflow-y-auto bg-[#f7f4ee] px-4 pb-20 pt-16 text-[#272536] sm:px-8 lg:pt-8">
    <div className="mx-auto max-w-5xl">
      <Link href="/my-day" className="text-sm font-semibold text-[#4b357d] hover:underline">← Back to My Day</Link>
      <header className="mt-5 rounded-2xl border border-[#e4ddd2] bg-white p-5 sm:p-8">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-[#856b36]">Your assigned work</p>
        <h1 className="mt-2 break-words text-3xl font-semibold tracking-tight sm:text-4xl">{item.title}</h1>
        {item.summary && <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">{item.summary}</p>}
        <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 border-t border-[#eee8de] pt-4 text-xs text-slate-600">
          <span>Status: {item.status.replaceAll("_", " ")}</span><span>Priority: {item.priority}</span>
          {item.due_at && <span>Due: <time dateTime={item.due_at}>{new Date(item.due_at).toLocaleDateString("en-GB")}</time></span>}
          {data.goal && <Link href={`/goals/${data.goal.id}`} className="text-[#4b357d] underline">Goal: {data.goal.title}</Link>}
        </div>
        {data.planItem?.description && <p className="mt-4 text-sm text-slate-700"><span className="font-semibold">Manager instructions:</span> {data.planItem.description}</p>}
      </header>
      {messages[result] && <p role="status" className="mt-4 rounded-xl border border-[#e4ddd2] bg-white p-4 text-sm">{messages[result]}</p>}
      <section aria-labelledby="do-with-ai" className="mt-5 rounded-2xl border border-[#e4ddd2] bg-white p-5 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-[#856b36]">Task-focused assistance</p>
          <h2 id="do-with-ai" className="mt-2 text-2xl font-semibold">Do with AI</h2></div>
          <span className="rounded-full bg-[#f3eff8] px-3 py-1 text-xs font-semibold text-[#4b357d]">{mode.toLowerCase()} assistance</span></div>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">CrazyLoops brings in this task, its approved Goal plan, and relevant company knowledge you can access. It drafts the work; you decide what to keep. It does not send or publish anything here.</p>
        {active ? <form action={generateWorkbenchAction} className="mt-5 grid gap-3">
          <input type="hidden" name="workItemId" value={item.id} /><input type="hidden" name="requestKey" value={randomUUID()} />
          <label htmlFor="workbench-instruction" className="text-sm font-semibold">What should the draft focus on?</label>
          <textarea id="workbench-instruction" name="instruction" required minLength={3} maxLength={2000} rows={3}
            defaultValue="Prepare a useful first draft for this task. Flag gaps in the available context."
            className="w-full min-w-0 rounded-xl border border-[#ded6ca] bg-[#fffdfa] p-3 text-sm leading-6 focus-visible:outline-2 focus-visible:outline-[#9b7309]" />
          <button className="min-h-11 justify-self-start rounded-lg bg-[#4b357d] px-5 text-sm font-semibold text-white hover:bg-[#3d2968] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b357d]">Create draft</button>
        </form> : <p className="mt-4 text-sm text-slate-600">This task is complete. Saved results remain available below.</p>}
      </section>
      {latestTurn && <section aria-labelledby="ai-draft" className="mt-5 rounded-2xl border border-[#e4ddd2] bg-white p-5 sm:p-8">
        <h2 id="ai-draft" className="text-xl font-semibold">Latest AI draft</h2>
        <p className="mt-2 text-xs text-slate-600">Generated <time dateTime={latestTurn.finished_at ?? undefined}>{latestTurn.finished_at ? new Date(latestTurn.finished_at).toLocaleString("en-GB") : "recently"}</time> · Private working note</p>
        <h3 className="mt-4 text-lg font-semibold">{latestTurn.response_title}</h3>
        <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-slate-700">{latestTurn.response_content}</p>
        <SourceList value={latestTurn.source_references} />
        <div className="mt-4 flex gap-2"><CopyButton text={latestTurn.response_content ?? ""} /></div>
        {active && <form action={saveWorkbenchResultAction} className="mt-5 grid gap-3 border-t border-[#eee8de] pt-5">
          <input type="hidden" name="workItemId" value={item.id} /><input type="hidden" name="requestKey" value={randomUUID()} />
          <input type="hidden" name="aiTurnId" value={latestTurn.id} />
          <label className="grid gap-1 text-sm font-semibold">Edit title<input name="title" required maxLength={180} defaultValue={latestTurn.response_title ?? ""} className="min-h-11 rounded-lg border border-[#ded6ca] px-3 font-normal" /></label>
          <label className="grid gap-1 text-sm font-semibold">Edit result<textarea name="content" required maxLength={16000} rows={10} defaultValue={latestTurn.response_content ?? ""} className="w-full min-w-0 rounded-lg border border-[#ded6ca] p-3 font-normal leading-6" /></label>
          <button className="min-h-11 justify-self-start rounded-lg border border-[#4b357d] px-4 text-sm font-semibold text-[#4b357d] hover:bg-[#f3eff8]">Save to task as draft</button>
        </form>}
      </section>}
      <section aria-labelledby="saved-results" className="mt-5 rounded-2xl border border-[#e4ddd2] bg-white p-5 sm:p-8">
        <h2 id="saved-results" className="text-xl font-semibold">Saved results</h2>
        {data.deliverables.length === 0 ? <p className="mt-3 text-sm text-slate-600">No result saved yet. Review an AI draft, edit it, then save it here.</p>
          : <div className="mt-4 space-y-4">{data.deliverables.map((deliverable) => <article key={deliverable.id} className="rounded-xl border border-[#e4ddd2] bg-[#fffdfa] p-4">
            <div className="flex flex-wrap justify-between gap-2"><h3 className="break-words text-base font-semibold">{deliverable.title}</h3><span className="text-xs font-semibold text-[#4b357d]">{deliverable.status === "final" ? "Final · manager-visible" : "Draft · private"}</span></div>
            <p className="mt-1 text-xs text-slate-500"><time dateTime={deliverable.created_at}>{new Date(deliverable.created_at).toLocaleString("en-GB")}</time>{deliverable.ai_assisted ? " · AI-assisted, employee-reviewed" : " · Employee-written"}</p>
            <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-slate-700">{deliverable.content}</p>
            <SourceList value={deliverable.source_references} />
            <div className="mt-4 flex flex-wrap gap-2"><CopyButton text={deliverable.content} />
              {active && deliverable.status === "draft" && <form action={finalizeWorkbenchResultAction}><input type="hidden" name="workItemId" value={item.id} /><input type="hidden" name="deliverableId" value={deliverable.id} /><button className="min-h-10 rounded-lg bg-[#4b357d] px-3 text-xs font-semibold text-white hover:bg-[#3d2968]">Mark final</button></form>}
            </div>
            {active && deliverable.id === (latestDraft ?? latestFinal)?.id && <details className="mt-4 border-t border-[#eee8de] pt-3"><summary className="cursor-pointer text-sm font-semibold text-[#4b357d]">Edit as a new revision</summary>
              <form action={saveWorkbenchResultAction} className="mt-3 grid gap-3"><input type="hidden" name="workItemId" value={item.id} /><input type="hidden" name="requestKey" value={randomUUID()} /><input type="hidden" name="basedOnId" value={deliverable.id} />
                <label className="grid gap-1 text-sm">Title<input name="title" required maxLength={180} defaultValue={deliverable.title} className="min-h-11 rounded-lg border border-[#ded6ca] px-3" /></label>
                <label className="grid gap-1 text-sm">Result<textarea name="content" required maxLength={16000} rows={8} defaultValue={deliverable.content} className="w-full min-w-0 rounded-lg border border-[#ded6ca] p-3" /></label>
                <button className="min-h-11 justify-self-start rounded-lg border border-[#4b357d] px-4 text-sm font-semibold text-[#4b357d]">Save new draft revision</button></form></details>}
          </article>)}</div>}
      </section>
      {latestFinal && <section aria-labelledby="finish-work" className="mt-5 rounded-2xl border border-[#e4ddd2] bg-white p-5 sm:p-8">
        <h2 id="finish-work" className="text-xl font-semibold">Finish the work</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">The final result is saved. Your manager can review this deliverable, not your private AI working notes. Marking the task done updates Goal progress.</p>
        {active && <form action={completeWorkbenchWorkAction} className="mt-4"><input type="hidden" name="workItemId" value={item.id} /><button className="min-h-11 rounded-lg bg-[#4b357d] px-5 text-sm font-semibold text-white hover:bg-[#3d2968]">Mark task complete</button></form>}
        <details className="mt-5 border-t border-[#eee8de] pt-4"><summary className="cursor-pointer text-sm font-semibold text-[#4b357d]">Prepare an email from this result</summary>
          <p className="mt-2 text-xs leading-5 text-slate-600">This opens the existing Ask preview and approval flow. Nothing is sent from this workbench. Edit the exact message before requesting approval.</p>
          <form action={prepareWorkbenchEmailAction} className="mt-3 grid gap-3"><input type="hidden" name="workItemId" value={item.id} />
            <label className="grid gap-1 text-sm">Recipient<input name="recipient" type="email" required className="min-h-11 rounded-lg border border-[#ded6ca] px-3" /></label>
            <label className="grid gap-1 text-sm">Exact message<textarea name="body" required maxLength={450} rows={5} defaultValue={latestFinal.content.slice(0, 450)} className="w-full min-w-0 rounded-lg border border-[#ded6ca] p-3" /></label>
            <button className="min-h-11 justify-self-start rounded-lg border border-[#4b357d] px-4 text-sm font-semibold text-[#4b357d]">Review email in Ask</button></form>
        </details>
      </section>}
      {data.turns.length > 1 && <details className="mt-5 rounded-2xl border border-[#e4ddd2] bg-white p-5"><summary className="cursor-pointer text-sm font-semibold">Private AI working history</summary><p className="mt-2 text-xs text-slate-600">Only you can see this while assigned to the task. Managers see final results, not these requests.</p><ul className="mt-3 space-y-3">{data.turns.map((turn) => <li key={turn.id} className="rounded-lg border border-[#eee8de] p-3 text-xs"><span className="font-semibold">{turn.mode.toLowerCase()} · {turn.status}</span><p className="mt-1 whitespace-pre-wrap break-words">{turn.instruction}</p></li>)}</ul></details>}
    </div>
  </main>;
}
