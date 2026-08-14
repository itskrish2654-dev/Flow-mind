import type { Metadata } from "next";

import { LegalPageShell } from "@/components/legal-page-shell";

export const metadata: Metadata = { title: "AI & Data Use | FlowMind", description: "How AI and workflow data are used in FlowMind." };

export default function DataUsePage() {
  return (
    <LegalPageShell eyebrow="Plain-language guide" title="AI & Data Use" description="What happens to workflow data when an automation runs—and when AI is involved.">
      <section><h2>AI runs only when configured</h2><p className="mt-3">FlowMind does not send every workflow through AI. When a workflow has no AI capability, its execution does not call the AI provider. When an enabled AI step runs, relevant instructions and input are sent server-side to the configured provider so that step can produce its result.</p></section>
      <section><h2>Review AI output</h2><p className="mt-3">AI output may be inaccurate, incomplete, or unexpected. Review important results before sending, publishing, paying, deciding, or relying on them. Failed AI requests are recorded as failures rather than replaced with fake success text.</p></section>
      <section><h2>Public-form submissions</h2><p className="mt-3">A public-form submission may pass through AI only if the workflow owner’s published workflow explicitly includes an AI step. Otherwise it is processed by the configured non-AI capabilities. The form does not reveal private workflow instructions or credentials.</p></section>
      <section><h2>Credentials are separate</h2><p className="mt-3">Connector credentials are stored separately in an encrypted vault and are not ordinary prompt text. Users should never paste passwords, private keys, or API secrets into prompts, form fields, or document templates.</p></section>
      <section><h2>Connected Google data</h2><p className="mt-3">FlowMind requests Google access incrementally for the Gmail or Google Sheets operation a user chooses. A configured Gmail trigger may read the matching message text and metadata needed to run that workflow. A configured Sheets action may read worksheet names and headers and read or write the selected rows. FlowMind does not request broad mailbox access for a Sheets-only workflow, and it does not automatically download Gmail attachments.</p></section>
      <section><h2>Execution history and documents</h2><p className="mt-3">FlowMind stores execution and step history to show outcomes, support retries, enforce idempotency, and provide an audit trail. Generated documents are private by default and are downloaded through expiring signed links.</p></section>
      <section><h2>Your controls</h2><p className="mt-3">Authenticated users can inspect execution results, export account data, revoke saved credentials, delete workflows, and delete their account. See the <a href="/privacy">Privacy Policy</a> for a fuller description of data categories, providers, retention, and deletion.</p></section>
    </LegalPageShell>
  );
}
