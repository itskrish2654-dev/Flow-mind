import type { Metadata } from "next";

import { LegalPageShell } from "@/components/legal-page-shell";
import { getSupportEmail } from "@/lib/site-contact";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "Terms governing use of CrazyLoops.",
  alternates: { canonical: "https://crazyloops.com/terms" },
};

export default function TermsPage() {
  const supportEmail = getSupportEmail();
  return (
    <LegalPageShell eyebrow="Legal" title="Terms of Service" description="A launch draft for using CrazyLoops. Sections marked for owner review are not final legal facts.">
      <section><h2>Operator and agreement</h2><p className="mt-3">These Terms are between you and <strong>[LEGAL ENTITY NAME — OWNER REVIEW REQUIRED]</strong>, the operator of CrazyLoops. By creating an account or using CrazyLoops, you agree to these Terms. The operator’s legal name, address, governing law, and court location require owner/legal review.</p></section>
      <section><h2>Eligibility and accounts</h2><p className="mt-3">You must be legally able to enter this agreement and provide accurate account information. You are responsible for your password, account activity, and promptly reporting suspected unauthorized access. Do not share access in a way that defeats account isolation or service limits.</p></section>
      <section><h2>Your workflows and content</h2><p className="mt-3">You retain responsibility for prompts, templates, submissions, documents, destinations, and other content you provide or cause CrazyLoops to process. You must have the rights and permissions needed for that content and for people whose information you collect through public forms.</p></section>
      <section><h2>Automations, public forms, and integrations</h2><p className="mt-3">You are responsible for reviewing a workflow before publishing or running it, configuring only supported capabilities, and verifying outputs. If you publish a hosted form, you are responsible for an appropriate notice and lawful collection of submitted information. Connector availability and third-party acknowledgements may change or fail.</p></section>
      <section><h2>AI-generated output</h2><p className="mt-3">AI output may be incomplete, inaccurate, or unsuitable. Do not rely on it as professional, legal, medical, financial, or safety-critical advice. Review important output and maintain human oversight appropriate to your use case.</p></section>
      <section><h2>Credentials and security</h2><p className="mt-3">Only provide credentials you are authorized to use. Do not place passwords, API keys, or other secrets in ordinary prompts or public-form fields. CrazyLoops may suspend access or disable workflows to address security, abuse, legal, or operational risk.</p></section>
      <section><h2>Acceptable use</h2><ul className="mt-3"><li>Do not violate law, privacy rights, intellectual property rights, or third-party terms.</li><li>Do not send spam, malware, deceptive content, or abusive requests.</li><li>Do not probe, bypass, overload, or interfere with authentication, quotas, authorization, CAPTCHA, or service infrastructure.</li><li>Do not use CrazyLoops for high-risk decisions without qualified human review and appropriate safeguards.</li></ul></section>
      <section><h2>Availability, changes, and termination</h2><p className="mt-3">CrazyLoops may change, limit, suspend, or discontinue features. The service is provided without a promise of uninterrupted availability. You may delete your account in Settings. CrazyLoops may suspend or terminate access for material breach, security risk, abuse, or legal necessity.</p></section>
      <section><h2>Intellectual property</h2><p className="mt-3">CrazyLoops’ software, interface, and service materials are owned by the operator or its licensors. These Terms do not transfer ownership. Rights in user content remain subject to the permissions needed to operate the service.</p></section>
      <section><h2>Disclaimers and liability</h2><p className="mt-3"><strong>[OWNER/LEGAL REVIEW REQUIRED]</strong> To the extent permitted by applicable law, CrazyLoops is provided “as is” and “as available,” without warranties that cannot legally be excluded. A final limitation-of-liability amount, excluded damages, mandatory consumer protections, and any jurisdiction-specific language must be selected by qualified counsel and are not invented here.</p></section>
      <section><h2>Changes and contact</h2><p className="mt-3">Material Terms changes should be posted with an updated date and, where required, additional notice. {supportEmail ? <>Questions may be sent to <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.</> : <>The public support contact still requires owner configuration.</>}</p></section>
    </LegalPageShell>
  );
}
