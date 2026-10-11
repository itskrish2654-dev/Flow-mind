import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Check, ShieldCheck, Zap } from "lucide-react";
import { getSupportEmail } from "@/lib/site-contact";
import "@/app/launch-home.css";

export const metadata: Metadata = {
  title: "CrazyLoops — From company goals to completed work. With AI.",
  description: "A connected workspace where managers coordinate work, employees produce reviewed results with AI, and teams make repeated work repeatable.",
  alternates: { canonical: "https://www.crazy-loops.com/" },
};

const chapters = [
  { number: "01", label: "For managers", title: "Start with the outcome. Give your team a clear plan.", body: "Describe what needs to happen. Review an AI-proposed plan, choose the people and deadlines, and approve assignments before work reaches your team.", detail: "A proposal is not a commitment. You decide what becomes work.", items: ["Company Goals", "Reviewed plans", "Team work & progress"] },
  { number: "02", label: "For employees", title: "Know what matters. Then get on with the work.", body: "My Day brings together assigned tasks, decisions, waiting work and confirmed outcomes. Open a task with its context, understand why it matters, and use Do with AI to prepare the result.", detail: "Less hunting for the next step. More clarity about what needs you.", items: ["My Day", "Task context", "Do with AI"] },
  { number: "03", label: "AI-assisted execution", title: "Produce a useful result, not just another chat.", body: "Draft, summarise and structure the work inside the task. Review the output, make changes and finalise the deliverable. Ask can retrieve authorised work and company knowledge, with sources you can inspect.", detail: "AI assists. People review. An answer never substitutes for evidence.", items: ["Reviewed deliverables", "Grounded Ask", "Company Knowledge"] },
  { number: "04", label: "Repeated work", title: "When work repeats, give it a repeatable process.", body: "Automate This can recognise patterns in completed work and help prepare a reviewed setup. Test and activate it deliberately. The advanced workflow builder remains available when you need more control.", detail: "Nothing starts just because AI suggested it. External actions still require approval.", items: ["Automate This", "Test & activate", "Advanced workflows"] },
];

export default function HomePage() {
  const pilotHref = `mailto:${getSupportEmail()}?subject=${encodeURIComponent("CrazyLoops early pilot enquiry")}&body=${encodeURIComponent("Hello CrazyLoops,\n\nWe are interested in an early company pilot.\n\nCompany:\nApproximate team size:\nWork we would like to improve:\n\nPlease contact me to discuss whether the pilot is a fit.")}`;
  return <div className="launch-home">
    <a href="#main-content" className="launch-skip">Skip to content</a>
    <header className="launch-nav launch-container">
      <Link href="/" aria-label="CrazyLoops home" className="launch-brand"><span><Zap size={18} aria-hidden="true" /></span>CrazyLoops</Link>
      <nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#trust">Trust</a><Link href="/login">Sign in</Link></nav>
      <a href={pilotHref} className="launch-button launch-button-small">Request an Early Pilot<ArrowRight size={16} aria-hidden="true" /></a>
    </header>
    <main id="main-content">
      <section className="launch-hero launch-container"><div>
        <p className="launch-eyebrow"><span />A WORKSPACE FOR THE WORK ITSELF</p>
        <h1>From company goals<br />to completed work.<br /><span>With AI.</span></h1>
        <p className="launch-lead">Managers coordinate. Employees create. Your team moves work forward in one connected workspace.</p>
        <p className="launch-hero-detail">Turn a goal into a reviewed plan, bring the right work into My Day, and use AI to prepare results—with people in control.</p>
        <div className="launch-actions"><a href={pilotHref} className="launch-button">Request an Early Pilot<ArrowRight size={18} aria-hidden="true" /></a><a href="#how-it-works" className="launch-text-link">See how it works ↓</a></div>
        <p className="launch-note">A focused early pilot for your company. Not another tool to configure alone.</p>
      </div><div className="launch-product" aria-label="Illustrative reviewed work journey">
        <div className="launch-product-top"><span className="launch-product-dot" />ONE GOAL. A SHARED WAY FORWARD.<span>Illustrative workspace</span></div>
        <div className="launch-product-goal"><p className="launch-eyebrow">COMPANY GOAL</p><h2>A clearer customer onboarding process</h2><p>Prepare a checklist the team can review and reuse.</p></div>
        <div className="launch-product-path"><span>01&nbsp; Plan reviewed</span><ArrowRight size={16} aria-hidden="true" /><span>02&nbsp; Work assigned</span></div>
        <div className="launch-product-task"><div><span className="launch-product-label">MY DAY</span><span className="launch-product-label launch-muted">Assigned work</span></div><h3>Draft the onboarding checklist</h3><p>Use the approved brief and company guidance to prepare a first draft.</p><div className="launch-product-ai"><Zap size={16} aria-hidden="true" /><span>Do with AI</span><span>Draft → Review → Finalise</span></div></div>
        <div className="launch-product-footer"><ShieldCheck size={18} aria-hidden="true" /><p>People approve the plan and review the result.<br /><span>Managers see progress from completed work.</span></p></div>
      </div></section>
      <section className="launch-thesis launch-container"><p className="launch-eyebrow">THE MISSING CONNECTION</p><h2>Your goals, tasks and AI tools shouldn’t live in separate worlds.</h2><p>A good plan is only the beginning. The difficult part is helping people do the work, review the result and keep the next step clear. CrazyLoops connects that everyday operating loop.</p></section>
      <div id="how-it-works" className="launch-container launch-chapters">{chapters.map((chapter) => <section key={chapter.number} className="launch-chapter"><div className="launch-chapter-label"><span>{chapter.number}</span><p className="launch-eyebrow">{chapter.label}</p></div><div><h2>{chapter.title}</h2><p>{chapter.body}</p><p className="launch-chapter-detail">{chapter.detail}</p><ul>{chapter.items.map((item) => <li key={item}><Check size={15} aria-hidden="true" />{item}</li>)}</ul></div></section>)}</div>
      <section id="trust" className="launch-trust"><div className="launch-container launch-trust-grid"><div><p className="launch-eyebrow">BUILT AROUND HUMAN JUDGEMENT</p><h2>You should be able to see—and trust—what happened.</h2><p>Important external actions are prepared for review. The approval shows the exact target and intended change. Activity distinguishes proposed work from provider-confirmed outcomes.</p><Link href="/security" className="launch-text-link">Read about security →</Link></div><ul><li><ShieldCheck aria-hidden="true" /><div><h3>Approval before action</h3><p>A draft is not a sent message or a changed record.</p></div></li><li><ShieldCheck aria-hidden="true" /><div><h3>Sources, not invented certainty</h3><p>Ask uses authorised context. You can inspect its source references.</p></div></li><li><ShieldCheck aria-hidden="true" /><div><h3>A team workspace, not surveillance</h3><p>Managers see assigned company work—not private Ask conversations or unfinished employee drafts.</p></div></li></ul></div></section>
      <section className="launch-integrations launch-container"><p className="launch-eyebrow">CONNECTED TO YOUR EVERYDAY WORK</p><h2>Your existing tools. A clearer way to work across them.</h2><ul>{["Gmail", "Google Calendar", "Google Sheets", "Slack", "Notion"].map((name) => <li key={name}>{name}</li>)}</ul><p>Pilot access depends on your connected accounts, granted permissions and supported actions. Connections do not grant access to every resource.</p><p className="launch-note">We confirm available actions and resources together during pilot setup.</p></section>
      <section id="pilot" className="launch-pilot launch-container"><div><p className="launch-eyebrow">THE FIRST-CUSTOMER PILOT</p><h2>Start with real work.<br />Keep the pilot focused.</h2><p>Bring a small team, a clear company goal and a process worth improving. Together, we’ll scope the pilot, connect appropriate tools and review whether CrazyLoops fits the way your team works.</p></div><div className="launch-pilot-action"><a href={pilotHref} className="launch-button">Request an Early Pilot<ArrowRight size={18} aria-hidden="true" /></a><p>Opens your email app with a short enquiry.<br />No account, payment or commitment required.</p><Link href="/support" className="launch-text-link">Prefer another way to contact us? →</Link></div></section>
    </main>
    <footer className="launch-container launch-footer"><div><Link href="/" className="launch-brand">CrazyLoops</Link><p>From company goals to completed work. With AI.</p></div><nav aria-label="Footer navigation"><Link href="/dashboard">Workflow builder</Link><Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link><Link href="/data-use">AI data use</Link><Link href="/support">Contact</Link></nav></footer>
  </div>;
}
