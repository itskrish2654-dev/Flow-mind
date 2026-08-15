import type { Metadata } from "next";

import { LegalPageShell } from "@/components/legal-page-shell";
import { getSupportEmail } from "@/lib/site-contact";

export const metadata: Metadata = {
  title: "Security",
  description: "CrazyLoops security and trust practices.",
  alternates: { canonical: "https://www.crazy-loops.com/security" },
};

export default function SecurityPage() {
  const supportEmail = getSupportEmail();
  return (
    <LegalPageShell eyebrow="Trust" title="Security at CrazyLoops" description="A concise, truthful overview of safeguards currently used by the product. No system is perfectly secure.">
      <section><h2>Account and data isolation</h2><p className="mt-3">Supabase Auth establishes user sessions. Authenticated data access is owner-scoped, with row-level database policies where applicable and explicit server-side ownership checks around privileged operations.</p></section>
      <section><h2>Credentials and documents</h2><p className="mt-3">Connector credential values are encrypted using authenticated encryption before being stored in a server-only vault; ordinary read responses expose metadata, not plaintext. Generated documents are stored in a private bucket and accessed through short-lived signed download links after ownership verification.</p></section>
      <section><h2>Application safeguards</h2><ul className="mt-3"><li>Cloudflare Turnstile protects authentication and configured public forms.</li><li>Durable rate limits, usage quotas, and expiring concurrency leases reduce abuse and accidental overload.</li><li>Immutable workflow versions and execution idempotency improve auditability and prevent common duplicate-run failures.</li><li>The execution engine validates capabilities server-side and records explicit success or failure states.</li><li>Outbound HTTP destinations are restricted to approved public HTTPS targets.</li></ul></section>
      <section><h2>Responsible reporting</h2><p className="mt-3">Please do not access or modify data that is not yours, disrupt service, or publish sensitive findings before remediation. Report a suspected vulnerability to <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.</p></section>
      <section><h2>No certification claim</h2><p className="mt-3">CrazyLoops does not currently claim SOC 2, ISO 27001, HIPAA compliance, formal penetration-test status, or any guarantee of absolute security.</p></section>
    </LegalPageShell>
  );
}
