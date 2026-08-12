import type { Metadata } from "next";

import { LegalPageShell } from "@/components/legal-page-shell";
import { getSupportEmail, SUPPORT_EMAIL_PLACEHOLDER } from "@/lib/site-contact";

export const metadata: Metadata = { title: "Support | FlowMind", description: "Get help with FlowMind accounts, workflows, privacy, and security." };

export default function SupportPage() {
  const supportEmail = getSupportEmail();
  const contact = supportEmail ? <a href={`mailto:${supportEmail}`}>{supportEmail}</a> : <strong>{SUPPORT_EMAIL_PLACEHOLDER}</strong>;
  return (
    <LegalPageShell eyebrow="Help" title="FlowMind Support" description="Where to get help with accounts, workflows, data requests, and security reports.">
      <section><h2>Contact</h2><p className="mt-3">Support contact: {contact}</p><p className="mt-2">When reporting a problem, include what you expected, what happened, and the approximate time. Do not send passwords, API keys, CAPTCHA tokens, recovery links, or private credentials.</p></section>
      <section><h2>Account and login help</h2><p className="mt-3">Use “Forgot password?” on the login page for password recovery. If a recovery link is expired or already used, request a fresh link. For account deletion or export help, describe the issue without sending sensitive identity material.</p></section>
      <section><h2>Workflow and bug reports</h2><p className="mt-3">Include the workflow name, visible error message, and whether the problem happened during planning, setup, execution, public submission, AI processing, or document generation. Internal IDs are not required unless support requests one.</p></section>
      <section><h2>Usage and billing</h2><p className="mt-3">Current usage and free limits appear under Settings → Usage. Paid billing is not implemented, so there is no purchasable upgrade flow yet.</p></section>
      <section><h2>Privacy and security</h2><p className="mt-3">Use the contact above for privacy, export, deletion, or responsible security reports. Do not test against another user’s data or disrupt the service.</p></section>
    </LegalPageShell>
  );
}
