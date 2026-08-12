import type { Metadata } from "next";

import { LegalPageShell } from "@/components/legal-page-shell";
import { getSupportEmail, SUPPORT_EMAIL_PLACEHOLDER } from "@/lib/site-contact";

export const metadata: Metadata = {
  title: "Privacy Policy | FlowMind",
  description: "How FlowMind handles account, workflow, submission, and execution data.",
};

export default function PrivacyPage() {
  const supportEmail = getSupportEmail();
  return (
    <LegalPageShell eyebrow="Privacy" title="Privacy Policy" description="A technically grounded draft describing the information FlowMind handles and the controls available to account holders.">
      <section><h2>Who operates FlowMind</h2><p className="mt-3">FlowMind is operated by <strong>[LEGAL ENTITY NAME — OWNER REVIEW REQUIRED]</strong>. A business address, privacy contact, and applicable jurisdiction still require owner and legal review before broad public launch.</p></section>
      <section><h2>Information we handle</h2><ul className="mt-3"><li>Account email, Auth identity metadata, and session cookies needed to sign in.</li><li>Workflow prompts, configuration, immutable versions, public-form settings, and publication status.</li><li>Public-form submissions, execution inputs and outputs, step history, status, timing, and sanitized provider metadata.</li><li>Generated PDF documents and private document metadata.</li><li>Connector credential ciphertext and metadata. Credential values are encrypted before storage and are not included in account exports.</li><li>Usage counters and pseudonymous security signals used for rate limiting, concurrency control, fraud prevention, and reliability.</li></ul></section>
      <section><h2>How information is used</h2><p className="mt-3">We use this information to authenticate users, save and run requested automations, show execution history, generate documents, enforce limits, diagnose failures, prevent abuse, and provide account export or deletion controls. A public submission is processed according to the workflow owner’s configured and published workflow.</p></section>
      <section><h2>AI processing</h2><p className="mt-3">When—and only when—a workflow contains an enabled AI capability, relevant workflow instructions and input may be sent server-side to the configured AI provider. Current production AI processing uses Groq. AI output can be inaccurate and should be reviewed before important use. See <a href="/data-use">AI &amp; Data Use</a>.</p></section>
      <section><h2>Infrastructure and service providers</h2><p className="mt-3">FlowMind currently relies on Vercel for application hosting, Supabase for authentication, database, and private object storage, Groq for configured AI execution, and Cloudflare Turnstile for bot protection. These providers process information under their own terms and policies. Processor terms and any required contractual disclosures need owner/legal review.</p></section>
      <section><h2>Cookies and browser storage</h2><p className="mt-3">Supabase Auth uses cookies to maintain an authenticated session. FlowMind may use browser storage for non-secret workflow interface state; legacy FlowMind browser entries are cleared on logout and account deletion. Credentials and elevated service keys are not intentionally stored in browser storage.</p></section>
      <section><h2>Retention, export, and deletion</h2><p className="mt-3">Account data is retained while needed to provide the service or until the account holder removes it. FlowMind does not yet promise a fixed retention schedule. Account settings provide a bounded JSON export and self-service deletion. Deletion first disables public forms, then removes account-owned workflow data, credential records, generated documents, usage records, and the Auth identity. Short-lived security records keyed by pseudonymous hashes expire through their operational windows and are not used as account content.</p></section>
      <section><h2>Security and choices</h2><p className="mt-3">FlowMind uses account-scoped authorization, row-level database controls where applicable, encrypted credential storage, private document storage, expiring signed links, CAPTCHA, rate limits, and execution safeguards. No online service can promise absolute security. You can export or delete your data in Settings.</p></section>
      <section><h2>Contact and legal review</h2><p className="mt-3">For privacy, export, or deletion help, contact {supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : <strong>{SUPPORT_EMAIL_PLACEHOLDER}</strong>}. This draft requires owner/legal review for entity identity, address, jurisdiction, retention commitments, and processor disclosures.</p></section>
    </LegalPageShell>
  );
}
