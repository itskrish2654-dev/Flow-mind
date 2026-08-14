import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Braces,
  Check,
  ChevronDown,
  CircleDot,
  Database,
  FileText,
  FileUp,
  FormInput,
  History,
  KeyRound,
  LockKeyhole,
  Mail,
  Menu,
  RefreshCcw,
  Route,
  ShieldCheck,
  Sparkles,
  Table2,
  Webhook,
  X,
} from "lucide-react";

import { TrustLinks } from "@/components/trust-links";

const title = "CrazyLoops — Automate work by describing it";
const description =
  "Build reliable AI-powered workflows from plain English with forms, webhooks, documents, data, and supported app connections.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "https://crazyloops.com/" },
  openGraph: {
    type: "website",
    url: "https://crazyloops.com/",
    siteName: "CrazyLoops",
    title,
    description,
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
};

const supportedCapabilities = [
  "Hosted forms",
  "Authenticated webhooks",
  "AI processing",
  "PDF generation",
  "Internal CrazyLoops storage",
  "HTTPS JSON actions",
  "Workflow versions",
  "Reliable retries and execution history",
];

const howItWorks = [
  {
    number: "01",
    title: "Describe it",
    body: "“Collect client requests, summarize them, and create a PDF.”",
  },
  {
    number: "02",
    title: "CrazyLoops builds it",
    body: "The planner determines the trigger, steps, mappings, and anything still needing your input.",
  },
  {
    number: "03",
    title: "Run the loop",
    body: "Activate it, then inspect executions, versions, results, and failures in one place.",
  },
];

const examples = [
  {
    label: "Project intake",
    parts: ["Collect project requests", "AI summarize", "Generate PDF", "Store"],
  },
  {
    label: "Webhook analysis",
    parts: ["Receive webhook", "Analyze payload", "Send HTTPS JSON"],
  },
  {
    label: "Structured feedback",
    parts: ["Public form", "AI processing", "Internal result"],
  },
];

function Wordmark() {
  return (
    <span className="landing-wordmark" aria-label="CrazyLoops">
      Crazy<span>Loops</span>
    </span>
  );
}

function Header() {
  return (
    <header className="landing-header">
      <div className="landing-shell flex h-[72px] items-center">
        <Link href="/" className="shrink-0" aria-label="CrazyLoops home">
          <Wordmark />
        </Link>

        <nav aria-label="Primary navigation" className="ml-auto hidden items-center gap-8 lg:flex">
          <a href="#product" className="landing-nav-link">Product</a>
          <Link href="/security" className="landing-nav-link">Security</Link>
          <a href="#connectors" className="landing-nav-link">Connectors</a>
          <Link href="/login" className="landing-nav-link ml-4">Sign in</Link>
          <Link href="/login?mode=signup" className="landing-button landing-button-primary">
            Start building <ArrowRight aria-hidden="true" />
          </Link>
        </nav>

        <details className="landing-mobile-menu ml-auto lg:hidden">
          <summary aria-label="Open navigation menu">
            <Menu className="menu-open" aria-hidden="true" />
            <X className="menu-close" aria-hidden="true" />
          </summary>
          <nav aria-label="Mobile navigation">
            <a href="#product">Product</a>
            <Link href="/security">Security</Link>
            <a href="#connectors">Connectors</a>
            <Link href="/login">Sign in</Link>
            <Link href="/login?mode=signup" className="mobile-cta">Start building</Link>
          </nav>
        </details>
      </div>
    </header>
  );
}

function ProductDemo() {
  return (
    <div className="landing-demo" aria-label="Example CrazyLoops workflow">
      <div className="landing-demo-topbar">
        <div className="flex items-center gap-2" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p>New automation</p>
        <span className="landing-demo-status"><CircleDot aria-hidden="true" />Ready to build</span>
      </div>

      <div className="landing-demo-body">
        <div className="landing-demo-prompt">
          <div className="landing-demo-avatar"><Sparkles aria-hidden="true" /></div>
          <div>
            <p className="landing-demo-label">Describe your automation</p>
            <p>When someone submits a project request, summarize it with AI, generate a PDF, and save the result.</p>
          </div>
          <span className="landing-demo-send"><ArrowRight aria-hidden="true" /></span>
        </div>

        <div className="landing-understanding" aria-label="CrazyLoops planner result">
          <span><Check aria-hidden="true" />Request understood</span>
          <p>4 production-supported steps · no missing setup</p>
        </div>

        <ol className="landing-workflow">
          <li>
            <span className="landing-node-icon"><FormInput aria-hidden="true" /></span>
            <div><small>Trigger</small><strong>Public form</strong><p>Collect the project request</p></div>
            <span className="landing-node-ready">Ready</span>
          </li>
          <li>
            <span className="landing-node-icon"><Bot aria-hidden="true" /></span>
            <div><small>Transform</small><strong>AI summary</strong><p>Summarize the submitted text</p></div>
            <span className="landing-node-ready">Ready</span>
          </li>
          <li>
            <span className="landing-node-icon"><FileText aria-hidden="true" /></span>
            <div><small>Action</small><strong>Generate PDF</strong><p>Create the formatted document</p></div>
            <span className="landing-node-ready">Ready</span>
          </li>
          <li>
            <span className="landing-node-icon"><Database aria-hidden="true" /></span>
            <div><small>Destination</small><strong>CrazyLoops storage</strong><p>Keep the result and execution history</p></div>
            <span className="landing-node-ready">Ready</span>
          </li>
        </ol>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="landing-page">
      <Header />

      <section className="landing-hero" aria-labelledby="hero-title">
        <div className="landing-shell">
          <div className="landing-hero-copy">
            <p className="landing-kicker"><span />Plain-English automation</p>
            <h1 id="hero-title">Automate work by <em>describing it.</em></h1>
            <p className="landing-hero-lede">
              CrazyLoops turns plain-English instructions into reliable workflows across your apps, AI, forms, webhooks, documents, and data.
            </p>
            <div className="landing-hero-actions">
              <Link href="/login?mode=signup" className="landing-button landing-button-primary">
                Start building <ArrowRight aria-hidden="true" />
              </Link>
              <a href="#product" className="landing-button landing-button-secondary">
                See how it works <ChevronDown aria-hidden="true" />
              </a>
            </div>
            <p className="landing-hero-note"><ShieldCheck aria-hidden="true" />Inspect every step before it runs.</p>
          </div>
          <ProductDemo />
        </div>
      </section>

      <section id="product" className="landing-section landing-outcome-section" aria-labelledby="outcome-title">
        <div className="landing-shell landing-split-heading">
          <p className="landing-section-index">The simpler way</p>
          <div>
            <h2 id="outcome-title">You describe the outcome.<br />CrazyLoops figures out the workflow.</h2>
            <div className="landing-no-list" aria-label="What you do not need">
              <span>No node canvas.</span>
              <span>No JSON.</span>
              <span>No wiring boxes together.</span>
            </div>
            <p>Connect what is needed, answer the few things CrazyLoops cannot infer, then run it.</p>
          </div>
        </div>
      </section>

      <section className="landing-section" aria-labelledby="how-title">
        <div className="landing-shell">
          <div className="landing-section-heading">
            <p className="landing-eyebrow">How it works</p>
            <h2 id="how-title">From one sentence to a workflow you can inspect.</h2>
          </div>
          <ol className="landing-how-grid">
            {howItWorks.map((item) => (
              <li key={item.number}>
                <span>{item.number}</span>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="landing-section landing-supported-section" aria-labelledby="supported-title">
        <div className="landing-shell landing-supported-grid">
          <div className="landing-section-heading">
            <p className="landing-eyebrow">Supported today</p>
            <h2 id="supported-title">Built to run real workflows — not demos.</h2>
            <p>Every capability listed here has a production execution path and an explicit result state.</p>
          </div>
          <ul className="landing-capability-list">
            {supportedCapabilities.map((capability) => (
              <li key={capability}><Check aria-hidden="true" />{capability}</li>
            ))}
          </ul>
        </div>
      </section>

      <section id="connectors" className="landing-section" aria-labelledby="connectors-title">
        <div className="landing-shell">
          <div className="landing-section-heading landing-heading-row">
            <div>
              <p className="landing-eyebrow">Connectors</p>
              <h2 id="connectors-title">Connect only what the workflow needs.</h2>
            </div>
            <p>More connectors are being added as they pass production reliability testing.</p>
          </div>

          <div className="landing-connectors-grid">
            <div className="landing-connector-group">
              <div className="landing-connector-group-heading">
                <span className="status-dot status-live" />
                <div><p>Available now</p><small>Production-ready</small></div>
              </div>
              <div className="landing-connector-row">
                <div><span><Webhook aria-hidden="true" /></span><strong>Webhook</strong></div>
                <p>Receive authenticated JSON events.</p>
              </div>
              <div className="landing-connector-row">
                <div><span><Braces aria-hidden="true" /></span><strong>HTTP JSON</strong></div>
                <p>Send JSON to approved HTTPS endpoints.</p>
              </div>
            </div>

            <div className="landing-connector-group landing-connector-beta">
              <div className="landing-connector-group-heading">
                <span className="status-dot status-beta" />
                <div><p>Private / Beta</p><small>Google approval pending</small></div>
              </div>
              <div className="landing-connector-row">
                <div><span><Mail aria-hidden="true" /></span><strong>Gmail</strong></div>
                <p>Beta — Google approval pending</p>
              </div>
              <div className="landing-connector-row">
                <div><span><Table2 aria-hidden="true" /></span><strong>Google Sheets</strong></div>
                <p>Beta — Google approval pending</p>
              </div>
            </div>
          </div>

          <div className="landing-google-note">
            <KeyRound aria-hidden="true" />
            <p>When you connect Google, CrazyLoops requests only the permissions required by the workflows you choose to build.</p>
            <Link href="/data-use">Learn about data use <ArrowRight aria-hidden="true" /></Link>
          </div>
        </div>
      </section>

      <section className="landing-section landing-reliability-section" aria-labelledby="reliability-title">
        <div className="landing-shell">
          <div className="landing-section-heading">
            <p className="landing-eyebrow">Reliability by design</p>
            <h2 id="reliability-title">Automations you can actually trust.</h2>
          </div>
          <div className="landing-reliability-grid">
            <article><History aria-hidden="true" /><h3>Versioned</h3><p>Every meaningful workflow change creates an immutable version.</p></article>
            <article><RefreshCcw aria-hidden="true" /><h3>Retry-safe</h3><p>Completed irreversible steps are not blindly repeated.</p></article>
            <article><Route aria-hidden="true" /><h3>Traceable</h3><p>Every execution has a step-by-step status and result.</p></article>
            <article><LockKeyhole aria-hidden="true" /><h3>Private by default</h3><p>Generated documents and account data use owner-scoped access controls.</p></article>
          </div>
        </div>
      </section>

      <section className="landing-section" aria-labelledby="examples-title">
        <div className="landing-shell">
          <div className="landing-section-heading landing-heading-row">
            <div>
              <p className="landing-eyebrow">Real examples</p>
              <h2 id="examples-title">Useful loops, built from supported parts.</h2>
            </div>
            <p>Every example below can be inspected before execution and traced afterward.</p>
          </div>
          <div className="landing-examples">
            {examples.map((example, index) => (
              <article key={example.label}>
                <span>0{index + 1}</span>
                <h3>{example.label}</h3>
                <div>
                  {example.parts.map((part, partIndex) => (
                    <p key={part}>{part}{partIndex < example.parts.length - 1 && <ArrowRight aria-hidden="true" />}</p>
                  ))}
                </div>
              </article>
            ))}
          </div>

          <div className="landing-beta-example">
            <div>
              <p className="landing-eyebrow">Coming through Google Beta</p>
              <h3>New Gmail message <ArrowRight aria-hidden="true" /> AI summarize <ArrowRight aria-hidden="true" /> Google Sheets</h3>
            </div>
            <span>Google integration beta — approval pending</span>
          </div>
        </div>
      </section>

      <section className="landing-section landing-security-section" aria-labelledby="security-title">
        <div className="landing-shell landing-security-grid">
          <div>
            <p className="landing-eyebrow">Security</p>
            <h2 id="security-title">Security isn’t an afterthought.</h2>
            <p>Credentials are encrypted, generated documents are private, accounts are isolated, and outbound networking is restricted.</p>
            <Link href="/security">Security at CrazyLoops <ArrowRight aria-hidden="true" /></Link>
          </div>
          <ul>
            <li><LockKeyhole aria-hidden="true" /><span><strong>Encrypted connector credentials</strong><small>Kept server-side in an authenticated vault.</small></span></li>
            <li><FileUp aria-hidden="true" /><span><strong>Private generated documents</strong><small>Opened through short-lived signed links.</small></span></li>
            <li><ShieldCheck aria-hidden="true" /><span><strong>Account and abuse safeguards</strong><small>Owner checks, bot protection, rate limits, and audit history.</small></span></li>
          </ul>
        </div>
      </section>

      <section className="landing-final-cta" aria-labelledby="cta-title">
        <div className="landing-shell">
          <span className="landing-loop-mark" aria-hidden="true"><RefreshCcw /></span>
          <h2 id="cta-title">Describe the work.<br />Build the loop.</h2>
          <p>Start with a sentence. CrazyLoops turns it into a workflow you can inspect, run, and improve.</p>
          <div>
            <Link href="/login?mode=signup" className="landing-button landing-button-primary">Start building <ArrowRight aria-hidden="true" /></Link>
            <Link href="/login" className="landing-button landing-button-secondary">Sign in</Link>
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-shell">
          <div className="landing-footer-brand">
            <Wordmark />
            <p>Reliable workflows from plain English.</p>
            <small>crazyloops.com</small>
          </div>
          <div className="landing-footer-links">
            <nav aria-label="Product links">
              <p>Product</p>
              <Link href="/login?mode=signup">Start building</Link>
              <Link href="/settings/connections">Connections</Link>
              <Link href="/security">Security</Link>
            </nav>
            <div>
              <p>Company / Trust</p>
              <TrustLinks />
            </div>
          </div>
        </div>
        <div className="landing-shell landing-footer-bottom">
          <p>© {new Date().getFullYear()} CrazyLoops</p>
          <p>Build what works. Know what ran.</p>
        </div>
      </footer>
    </main>
  );
}
