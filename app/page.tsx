import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  Braces,
  Check,
  ChevronDown,
  CircleDot,
  Database,
  FileText,
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

import { HomepageWorkflowDemo } from "@/components/homepage-workflow-demo";

const title = "CrazyLoops — Run the work. Not every task.";
const description =
  "Tell CrazyLoops what should happen. It turns the outcome into a reliable workflow and keeps the work moving.";

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
  twitter: { card: "summary_large_image", title, description },
};

const handoffs = [
  "Request comes in",
  "Someone reads it",
  "Something gets created",
  "Another system gets updated",
  "Someone gets notified",
];

const buildSteps = [
  ["01", "Tell it what should happen"],
  ["02", "Connect what’s needed"],
  ["03", "Let the loop run"],
];

const reliability = [
  {
    title: "It remembers what already worked.",
    body: "Retry-safe execution does not blindly repeat completed irreversible steps.",
    icon: RefreshCcw,
  },
  {
    title: "Every change has a history.",
    body: "Meaningful workflow changes create versions you can trace back.",
    icon: History,
  },
  {
    title: "You can see what happened.",
    body: "Every execution records step-by-step status, results, and failures.",
    icon: Route,
  },
  {
    title: "Delivered means acknowledged.",
    body: "External delivery succeeds only after the destination confirms the request.",
    icon: Check,
  },
];

const capabilities = [
  ["Collect", "Hosted forms / authenticated webhooks"],
  ["Think", "AI transformation"],
  ["Create", "Private PDFs"],
  ["Store", "CrazyLoops storage"],
  ["Send", "Approved HTTPS JSON actions"],
  ["Connect", "Gmail + Google Sheets beta"],
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
          <a href="#connectors" className="landing-nav-link">Connections</a>
          <Link href="/security" className="landing-nav-link">Security</Link>
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
            <a href="#connectors">Connections</a>
            <Link href="/security">Security</Link>
            <Link href="/login">Sign in</Link>
            <Link href="/login?mode=signup" className="mobile-cta">Start building</Link>
          </nav>
        </details>
      </div>
    </header>
  );
}

function LoopMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "landing-loop-symbol compact" : "landing-loop-symbol"} aria-hidden="true">
      <span />
      <ArrowRight />
    </span>
  );
}

function ProductDemo({ compact = false }: { compact?: boolean }) {
  const nodes = [
    { label: "Request", detail: "New request received", icon: FormInput },
    { label: "AI", detail: "Summary created", icon: Sparkles },
    { label: "PDF", detail: "Private document ready", icon: FileText },
    { label: "Store", detail: "Result saved", icon: Database },
  ];

  return (
    <div className={compact ? "landing-demo landing-demo-compact" : "landing-demo"} aria-label="CrazyLoops turns a request into an AI summary, a PDF, and a stored result.">
      <div className="landing-demo-topbar">
        <div className="flex items-center gap-2" aria-hidden="true"><span /><span /><span /></div>
        <p>CrazyLoops</p>
        <span className="landing-demo-status"><CircleDot aria-hidden="true" />Loop ready</span>
      </div>
      <div className="landing-demo-body">
        <div className="landing-demo-prompt">
          <div className="landing-demo-avatar"><Sparkles aria-hidden="true" /></div>
          <div>
            <p className="landing-demo-label">Tell CrazyLoops what should happen</p>
            <p>When a new request comes in, summarize it, create a PDF and save the result.</p>
          </div>
          <span className="landing-demo-send"><ArrowRight aria-hidden="true" /></span>
        </div>
        <div className="landing-understanding">
          <span><Check aria-hidden="true" />Outcome understood</span>
          <p>4 supported steps · ready to run</p>
        </div>
        <ol className="landing-workflow landing-workflow-horizontal">
          {nodes.map(({ label, detail, icon: Icon }, index) => (
            <li key={label}>
              <span className="landing-node-index">0{index + 1}</span>
              <span className="landing-node-icon"><Icon aria-hidden="true" /></span>
              <div><strong>{label}</strong><p>{detail}</p></div>
              <span className="landing-node-ready"><Check aria-hidden="true" />Done</span>
            </li>
          ))}
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
            <p className="landing-kicker"><span />The work should keep moving</p>
            <h1 id="hero-title"><span>Run the work.</span><em>Not every task.</em></h1>
            <p className="landing-hero-lede">
              <strong>Tell CrazyLoops what should happen.</strong> It turns the outcome into a workflow, connects the steps, and keeps the work moving without you rebuilding the same process every day.
            </p>
            <div className="landing-hero-actions">
              <Link href="/login?mode=signup" className="landing-button landing-button-primary">
                Start building <ArrowRight aria-hidden="true" />
              </Link>
              <a href="#demo" className="landing-button landing-button-secondary">
                See how it works <ChevronDown aria-hidden="true" />
              </a>
            </div>
          </div>
          <div className="landing-hero-visual">
            <LoopMark />
            <ProductDemo />
            <a href="#demo" className="landing-hero-demo-link">Try it yourself <ArrowDown aria-hidden="true" /></a>
          </div>
        </div>
      </section>

      <section id="product" className="landing-section landing-problem-section" aria-labelledby="problem-title">
        <div className="landing-shell">
          <div className="landing-problem-copy">
            <p className="landing-eyebrow">The handoff problem</p>
            <h2 id="problem-title">You already know what should happen.<br /><em>The problem is making it happen every time.</em></h2>
          </div>
          <ol className="landing-process-line" aria-label="A typical manual process">
            {handoffs.map((handoff, index) => <li key={handoff}><span>0{index + 1}</span><p>{handoff}</p></li>)}
          </ol>
          <p className="landing-loop-conclusion">CrazyLoops turns that process into a loop. <LoopMark compact /></p>
        </div>
      </section>

      <section id="demo" className="landing-section landing-describe-section" aria-labelledby="describe-title">
        <div className="landing-shell">
          <div className="landing-section-heading">
            <p className="landing-eyebrow">Describe the outcome</p>
            <h2 id="describe-title">You don’t start with boxes.<br />You start with what needs to happen.</h2>
            <p>Try it. Describe a process and CrazyLoops will show you the loop.</p>
          </div>
          <HomepageWorkflowDemo />
          <div className="landing-describe-copy">
            <p>You don’t wire nodes together.</p>
            <p>You don’t translate your work into automation software.</p>
            <strong>You describe what you want done.<br />CrazyLoops works out the loop.</strong>
          </div>
        </div>
      </section>

      <section className="landing-section landing-how-section" aria-labelledby="how-title">
        <div className="landing-shell">
          <p className="landing-eyebrow">One outcome. Three moves.</p>
          <h2 id="how-title" className="sr-only">How CrazyLoops works</h2>
          <ol className="landing-how-grid">
            {buildSteps.map(([number, copy]) => <li key={number}><span>{number}</span><h3>{copy}</h3></li>)}
          </ol>
        </div>
      </section>

      <section className="landing-section landing-reliability-section" aria-labelledby="reliability-title">
        <div className="landing-shell">
          <div className="landing-reliability-intro">
            <p className="landing-eyebrow">Built for the second run, too</p>
            <h2 id="reliability-title">Simple to build.<br /><em>Serious when it runs.</em></h2>
            <p>A loop is useful only when you can trust it to remember, recover, and tell the truth.</p>
          </div>
          <div className="landing-reliability-grid">
            {reliability.map(({ title: itemTitle, body, icon: Icon }) => (
              <article key={itemTitle}><Icon aria-hidden="true" /><h3>{itemTitle}</h3><p>{body}</p></article>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section landing-pain-section" aria-labelledby="pain-title">
        <div className="landing-shell">
          <p className="landing-eyebrow">The work between the work</p>
          <h2 id="pain-title">Stop being the connection between your tools.</h2>
          <div className="landing-pain-words" aria-label="Repetitive manual handoffs">
            {['Copying.', 'Pasting.', 'Forwarding.', 'Checking.', 'Updating.', 'Following up.', 'Recreating.'].map((word) => <span key={word}>{word}</span>)}
          </div>
          <div className="landing-pain-ending">
            <p>Those little handoffs become the job.</p>
            <strong>CrazyLoops turns them into loops.</strong>
          </div>
        </div>
      </section>

      <section className="landing-section landing-capabilities-section" aria-labelledby="capabilities-title">
        <div className="landing-shell">
          <div className="landing-section-heading landing-heading-row">
            <div><p className="landing-eyebrow">Supported today</p><h2 id="capabilities-title">What you can build today</h2></div>
            <p>Real execution paths. Explicit result states. No pretend connectors.</p>
          </div>
          <dl className="landing-capability-grid">
            {capabilities.map(([term, detail], index) => (
              <div key={term}><dt><span aria-hidden="true">0{index + 1}</span>{term}</dt><dd>{detail}</dd></div>
            ))}
          </dl>
        </div>
      </section>

      <section id="connectors" className="landing-section landing-connectors-section" aria-labelledby="connectors-title">
        <div className="landing-shell">
          <div className="landing-section-heading landing-heading-row">
            <div><p className="landing-eyebrow">Connections</p><h2 id="connectors-title">Only what is ready to run.</h2></div>
            <p>More connections appear only after they pass production reliability testing.</p>
          </div>
          <div className="landing-connectors-grid">
            <div className="landing-connector-group">
              <div className="landing-connector-group-heading"><span className="status-dot status-live" /><div><p>Available</p><small>Production-ready</small></div></div>
              <div className="landing-connector-row"><div><span><Webhook aria-hidden="true" /></span><strong>Webhook</strong></div><p>Receive authenticated JSON events.</p></div>
              <div className="landing-connector-row"><div><span><Braces aria-hidden="true" /></span><strong>HTTP JSON</strong></div><p>Send JSON to approved HTTPS endpoints.</p></div>
            </div>
            <div className="landing-connector-group landing-connector-beta">
              <div className="landing-connector-group-heading"><span className="status-dot status-beta" /><div><p>Beta</p><small>Google approval pending</small></div></div>
              <div className="landing-connector-row"><div><span><Mail aria-hidden="true" /></span><strong>Gmail</strong></div><p>Google approval pending</p></div>
              <div className="landing-connector-row"><div><span><Table2 aria-hidden="true" /></span><strong>Google Sheets</strong></div><p>Google approval pending</p></div>
            </div>
          </div>
          <div className="landing-google-note"><KeyRound aria-hidden="true" /><p>When you connect Google, CrazyLoops requests only the permissions required by the workflows you choose to build.</p><Link href="/data-use">Learn about data use <ArrowRight aria-hidden="true" /></Link></div>
          <div className="landing-beta-example">
            <div><p className="landing-eyebrow">Coming through Google Beta</p><h3>When a customer emails asking for a demo, summarize the request and add it to our lead sheet.</h3></div>
            <div className="landing-beta-flow" aria-label="Gmail to AI to Google Sheets"><span>Gmail</span><ArrowDown aria-hidden="true" /><span>AI</span><ArrowDown aria-hidden="true" /><span>Google Sheets</span></div>
            <strong>Beta — Google approval pending</strong>
          </div>
        </div>
      </section>

      <section className="landing-section landing-manifesto" aria-labelledby="manifesto-title">
        <div className="landing-shell">
          <LoopMark />
          <h2 id="manifesto-title">The loop is the product.</h2>
          <div><p>Not the prompt.</p><p>Not the nodes.</p><p>Not the API calls.</p></div>
          <strong>The important part is that the work happens again tomorrow without you rebuilding it.</strong>
          <p>That’s what CrazyLoops is designed for.</p>
        </div>
      </section>

      <section className="landing-section landing-security-section" aria-labelledby="security-title">
        <div className="landing-shell landing-security-grid">
          <div>
            <p className="landing-eyebrow">Visible by design</p>
            <h2 id="security-title">Your workflows shouldn’t be a black box.</h2>
            <Link href="/security">Explore CrazyLoops Security <ArrowRight aria-hidden="true" /></Link>
          </div>
          <ul>
            <li><History aria-hidden="true" /><span><strong>Versioned workflows</strong><small>Meaningful changes have an inspectable history.</small></span></li>
            <li><RefreshCcw aria-hidden="true" /><span><strong>Retry-safe execution</strong><small>Completed work is not blindly repeated.</small></span></li>
            <li><FileText aria-hidden="true" /><span><strong>Private documents</strong><small>Files open through short-lived signed links.</small></span></li>
            <li><ShieldCheck aria-hidden="true" /><span><strong>Account isolation</strong><small>Ownership checks protect user data and resources.</small></span></li>
            <li><LockKeyhole aria-hidden="true" /><span><strong>Protected connections</strong><small>Connector credentials stay encrypted and server-side.</small></span></li>
          </ul>
        </div>
      </section>

      <section className="landing-final-cta" aria-labelledby="cta-title">
        <div className="landing-shell">
          <LoopMark />
          <h2 id="cta-title">Describe it once.<br /><em>Let the loop take it from there.</em></h2>
          <p>Start with the process you never want to do manually again.</p>
          <div><Link href="/login?mode=signup" className="landing-button landing-button-primary">Start building <ArrowRight aria-hidden="true" /></Link><Link href="/login" className="landing-button landing-button-secondary">Sign in</Link></div>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-shell">
          <div className="landing-footer-brand"><Wordmark /><p>Run the work. Not every task.</p><small>crazyloops.com</small></div>
          <div className="landing-footer-links">
            <nav aria-label="Product links"><p>Product</p><Link href="/login?mode=signup">Start building</Link><a href="#connectors">Connections</a><Link href="/security">Security</Link></nav>
            <nav aria-label="Resource links"><p>Resources</p><Link href="/data-use">Data Use</Link><Link href="/support">Support</Link></nav>
            <nav aria-label="Legal links"><p>Legal</p><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></nav>
            <nav aria-label="Account links"><p>Account</p><Link href="/login">Sign in</Link><Link href="/login?mode=signup">Create account</Link></nav>
          </div>
        </div>
        <div className="landing-shell landing-footer-bottom"><p>© {new Date().getFullYear()} CrazyLoops</p></div>
      </footer>
    </main>
  );
}
