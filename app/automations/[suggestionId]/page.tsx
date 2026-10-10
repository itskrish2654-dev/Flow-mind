import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { changeAutomationActivation, configureAutomationSuggestion, disableAutomationSuggestion, dismissAutomationSuggestion } from "@/app/actions/automate-this";
import { getAuthenticatedContext } from "@/lib/auth";
import { AutomationConfigurationSchema } from "@/lib/automate-this-plan";
import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";

export default async function AutomationProposalPage({ params }: { params: Promise<{ suggestionId: string }> }) {
  const { suggestionId } = await params;
  if (!z.uuid().safeParse(suggestionId).success) notFound();
  const auth = await getAuthenticatedContext();
  if (!auth) redirect(`/login?next=/automations/${suggestionId}`);
  const { data: suggestion, error } = await auth.supabase.from("automation_suggestions").select("*")
    .eq("id", suggestionId).eq("workspace_id", auth.workspace.id).eq("owner_user_id", auth.user.id).maybeSingle();
  if (error || !suggestion || suggestion.status === "dismissed") notFound();
  const saved = AutomationConfigurationSchema.safeParse(suggestion.configuration);
  const config = saved.success ? saved.data : null;
  const { data: connectionRows } = suggestion.pattern_kind === "gmail_follow_up"
    ? await auth.supabase.from("connector_connections").select("id,external_account_label,granted_scopes")
      .eq("workspace_id", auth.workspace.id).eq("user_id", auth.user.id)
      .eq("provider_family", "google").eq("status", "connected")
    : { data: [] };
  const gmailConnections = (connectionRows ?? []).filter((row) => row.granted_scopes.includes(GOOGLE_SCOPES.gmailSend));
  const isGmail = suggestion.pattern_kind === "gmail_follow_up";
  const hasDraft = Boolean(suggestion.workflow_id);
  const { data: workflowVersions } = suggestion.workflow_id
    ? await auth.supabase.from("workflows").select("current_version_id,published_version_id")
      .eq("id", suggestion.workflow_id).eq("workspace_id", auth.workspace.id)
      .eq("user_id", auth.user.id).maybeSingle()
    : { data: null };
  const hasUnpublishedChanges = Boolean(workflowVersions?.published_version_id
    && workflowVersions.current_version_id !== workflowVersions.published_version_id);
  return <main className="mx-auto w-full max-w-4xl px-4 pb-16 pt-20 sm:px-6 lg:px-8 lg:pt-10">
    <Link href="/automations" className="text-sm font-medium text-[#4b357d] underline underline-offset-2">← Your automations</Link>
    <header className="mt-5 rounded-3xl border border-[#ded6ca] bg-[#fffdfa] p-6 sm:p-9">
      <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#725300]">Review before anything runs</p>
      <h1 className="mt-2 break-words text-3xl font-semibold tracking-tight text-[#272536] sm:text-4xl">{suggestion.source_title}</h1>
      <p className="mt-3 text-sm leading-6 text-slate-700">You completed {suggestion.evidence_count} similar {isGmail ? "Gmail follow-ups" : "AI-assisted Work Item results"} in the last 14 days. This suggestion uses completed examples—not a prediction about a customer or an app you have not connected.</p>
      <p className="mt-3 text-xs font-medium text-slate-600">Current state: {suggestion.status.replaceAll("_", " ")}. Suggestions never activate themselves.</p>
    </header>
    <section aria-labelledby="proposal-title" className="mt-6 rounded-3xl border border-[#ded6ca] bg-white p-6 sm:p-8">
      <h2 id="proposal-title" className="text-xl font-semibold text-[#272536]">What would happen</h2>
      <ol className="mt-5 grid gap-3 md:grid-cols-3">
        <li className="rounded-xl border border-[#e5dfd5] bg-[#faf8f4] p-4"><span className="text-xs font-bold uppercase tracking-wide text-[#725300]">When</span><p className="mt-2 text-sm leading-6 text-slate-700">A new assigned Work Item has this exact title and source{isGmail ? " and remains waiting and due after your chosen number of days" : ""}.</p></li>
        <li className="rounded-xl border border-[#e5dfd5] bg-[#faf8f4] p-4"><span className="text-xs font-bold uppercase tracking-wide text-[#725300]">Do</span><p className="mt-2 text-sm leading-6 text-slate-700">Use AI to prepare a private draft from that Work Item&apos;s details. You can review or edit it.</p></li>
        <li className="rounded-xl border border-[#e5dfd5] bg-[#faf8f4] p-4"><span className="text-xs font-bold uppercase tracking-wide text-[#725300]">Then</span><p className="mt-2 text-sm leading-6 text-slate-700">{isGmail ? "Place an exact Gmail send preview in your approvals. Nothing sends until you approve the recipient, subject, and body." : "Save the result as a private Work Item draft. No external action is taken."}</p></li>
      </ol>
      {isGmail && <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">CrazyLoops does not verify whether a customer has replied in this version. This condition only means the matching Work Item is still waiting and due. Review each proposed email before sending.</p>}
    </section>
    {suggestion.status !== "disabled" && <section aria-labelledby="configuration-title" className="mt-6 rounded-3xl border border-[#ded6ca] bg-white p-6 sm:p-8">
      <h2 id="configuration-title" className="text-xl font-semibold text-[#272536]">Set it up in your words</h2>
      <p className="mt-1 text-sm text-slate-600">Save a reviewable draft first. Saving does not activate it.</p>
      <form action={configureAutomationSuggestion} className="mt-5 space-y-4">
        <input type="hidden" name="suggestionId" value={suggestion.id} />
        <label className="block text-sm font-medium text-slate-800">What should the draft do?
          <textarea name="instruction" required minLength={12} maxLength={600} rows={4} defaultValue={config?.instruction ?? (isGmail ? "Prepare a concise, polite follow-up using only this Work Item's details. Do not invent facts or claim an email was sent." : "Prepare a concise manager update using only this Work Item's details. Leave decisions and final edits to me.")} className="mt-2 block w-full rounded-xl border border-[#cec6ba] bg-white p-3 text-sm leading-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b357d]" />
        </label>
        {isGmail && <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium text-slate-800">Wait at least this many days<input name="waitDays" type="number" min={1} max={30} required defaultValue={config?.kind === "gmail_follow_up" ? config.waitDays : 3} className="mt-2 block min-h-11 w-full rounded-xl border border-[#cec6ba] px-3" /></label>
          <label className="block text-sm font-medium text-slate-800">Your Gmail account<select name="gmailConnectionId" required defaultValue={config?.kind === "gmail_follow_up" ? config.gmailConnectionId : ""} className="mt-2 block min-h-11 w-full rounded-xl border border-[#cec6ba] bg-white px-3"><option value="">Choose your connected account</option>{gmailConnections.map((row) => <option key={row.id} value={row.id}>{row.external_account_label || "Connected Gmail account"}</option>)}</select></label>
          <label className="block text-sm font-medium text-slate-800">Exact recipient<input name="recipientEmail" type="email" required maxLength={320} defaultValue={config?.kind === "gmail_follow_up" ? config.recipientEmail : ""} placeholder="person@example.com" className="mt-2 block min-h-11 w-full rounded-xl border border-[#cec6ba] px-3" /></label>
          <label className="block text-sm font-medium text-slate-800">Email subject<input name="subject" required minLength={3} maxLength={180} defaultValue={config?.kind === "gmail_follow_up" ? config.subject : ""} className="mt-2 block min-h-11 w-full rounded-xl border border-[#cec6ba] px-3" /></label>
        </div>}
        {isGmail && gmailConnections.length === 0 && <p role="alert" className="text-sm text-amber-900">Connect your own Gmail account with send permission before saving this draft.</p>}
        <button className="min-h-11 rounded-xl bg-[#4b357d] px-5 text-sm font-semibold text-white hover:bg-[#3d2968] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b357d]">{hasDraft ? "Save a new draft version" : "Save for review"}</button>
      </form>
    </section>}
    <section aria-labelledby="control-title" className="mt-6 rounded-3xl border border-[#ded6ca] bg-white p-6 sm:p-8">
      <h2 id="control-title" className="text-xl font-semibold text-[#272536]">Your control</h2>
      <p className="mt-2 text-sm leading-6 text-slate-700">{hasDraft ? "Your saved setup is an immutable workflow draft. Activating publishes the reviewed version; later edits remain drafts until you publish again." : "Save the setup above before activation is available."}</p>
      <div className="mt-5 flex flex-wrap gap-3">
        {hasDraft && suggestion.status !== "disabled" && <form action={changeAutomationActivation}><input type="hidden" name="suggestionId" value={suggestion.id} /><input type="hidden" name="activate" value={suggestion.status === "active" ? "no" : "yes"} /><button className="min-h-11 rounded-xl bg-[#4b357d] px-5 text-sm font-semibold text-white hover:bg-[#3d2968]">{suggestion.status === "active" ? "Pause automation" : "Activate reviewed draft"}</button></form>}
        {suggestion.status === "active" && hasUnpublishedChanges && <form action={changeAutomationActivation}><input type="hidden" name="suggestionId" value={suggestion.id} /><input type="hidden" name="activate" value="yes" /><button className="min-h-11 rounded-xl border border-[#4b357d] px-4 text-sm font-semibold text-[#4b357d] hover:bg-[#f5f0ff] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4b357d]">Publish reviewed changes</button></form>}
        {hasDraft && suggestion.status !== "disabled" && <form action={disableAutomationSuggestion}><input type="hidden" name="suggestionId" value={suggestion.id} /><button className="min-h-11 rounded-xl border border-[#cec6ba] px-4 text-sm font-medium text-slate-700 hover:bg-[#faf8f4]">Disable and archive</button></form>}
        {!hasDraft && <form action={dismissAutomationSuggestion}><input type="hidden" name="suggestionId" value={suggestion.id} /><button className="min-h-11 rounded-xl border border-[#cec6ba] px-4 text-sm font-medium text-slate-700 hover:bg-[#faf8f4]">Not now</button></form>}
      </div>
    </section>
  </main>;
}
