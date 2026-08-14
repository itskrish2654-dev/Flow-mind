"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CircleDot,
  Database,
  FileText,
  FormInput,
  LoaderCircle,
  Sparkles,
  Webhook,
} from "lucide-react";

import {
  preserveHomepageDemoDraft,
  previewHomepageDemo,
} from "@/app/actions/homepage-demo";
import type { HomepageDemoResult, HomepageDemoStep } from "@/lib/homepage-demo";

const DEFAULT_PROMPT = "When a new request comes in, summarize it, create a PDF and save the result.";
const EXAMPLES = [
  "Summarize incoming requests",
  "Turn form responses into PDFs",
  "When webhook data arrives, analyze it and store the result",
];

function StepIcon({ step }: { step: HomepageDemoStep }) {
  if (step.category === "ai") return <Sparkles aria-hidden="true" />;
  if (step.category === "document") return <FileText aria-hidden="true" />;
  if (step.category === "storage") return <Database aria-hidden="true" />;
  if (step.label === "Webhook") return <Webhook aria-hidden="true" />;
  return <FormInput aria-hidden="true" />;
}

export function HomepageWorkflowDemo() {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [result, setResult] = useState<HomepageDemoResult | null>(null);
  const [isPlanning, setIsPlanning] = useState(false);
  const [revealedSteps, setRevealedSteps] = useState(0);
  const [clarification, setClarification] = useState("");
  const [clarificationTurn, setClarificationTurn] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isLeaving, setIsLeaving] = useState(false);
  const timers = useRef<number[]>([]);

  useEffect(() => () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  async function buildLoop(nextClarification?: string, nextClarificationTurn = clarificationTurn) {
    if (isPlanning || prompt.trim().length < 4) return;
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
    setIsPlanning(true);
    setResult(null);
    setRevealedSteps(0);
    setError(null);

    const response = await previewHomepageDemo({
      prompt,
      ...(nextClarification ? { clarification: nextClarification } : {}),
      clarificationTurn: nextClarificationTurn,
    });
    setIsPlanning(false);
    if (!response.ok) {
      setError(response.error);
      return;
    }

    setResult(response.result);
    if (response.result.status === "supported") {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduceMotion) {
        setRevealedSteps(response.result.steps.length);
      } else {
        response.result.steps.forEach((_, index) => {
          timers.current.push(window.setTimeout(() => setRevealedSteps(index + 1), index * 90));
        });
      }
    }
  }

  async function saveAndContinue() {
    if (isLeaving) return;
    setIsLeaving(true);
    setError(null);
    const response = await preserveHomepageDemoDraft({ prompt });
    if (!response.ok) {
      setError(response.error);
      setIsLeaving(false);
      return;
    }
    window.location.assign(response.href);
  }

  function reset(nextPrompt = prompt) {
    setPrompt(nextPrompt);
    setResult(null);
    setError(null);
    setClarification("");
    setClarificationTurn(0);
    setRevealedSteps(0);
  }

  const statusText = isPlanning
    ? "Understanding…"
    : result?.status === "supported"
      ? "Loop preview ready"
      : result?.status === "unsupported"
        ? "Not available"
        : result?.status === "clarification"
          ? "One detail needed"
          : "Preview only";

  return (
    <div className="landing-demo landing-demo-compact landing-demo-interactive">
      <div className="landing-demo-topbar">
        <div className="flex items-center gap-2" aria-hidden="true"><span /><span /><span /></div>
        <p>CrazyLoops</p>
        <span className="landing-demo-status"><CircleDot aria-hidden="true" />{statusText}</span>
      </div>

      <div className="landing-demo-body">
        {!result && !isPlanning && (
          <form onSubmit={(event) => { event.preventDefault(); void buildLoop(); }}>
            <div className="landing-demo-prompt landing-demo-prompt-editable">
              <div className="landing-demo-avatar"><Sparkles aria-hidden="true" /></div>
              <div>
                <label htmlFor="homepage-loop-prompt" className="landing-demo-label">Tell CrazyLoops what should happen</label>
                <textarea
                  id="homepage-loop-prompt"
                  value={prompt}
                  maxLength={600}
                  rows={3}
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </div>
              <button className="landing-demo-build" type="submit" disabled={prompt.trim().length < 4}>
                Build the loop <ArrowRight aria-hidden="true" />
              </button>
            </div>
            <div className="landing-demo-examples" aria-label="Quick examples">
              <span>Try:</span>
              {EXAMPLES.map((example) => (
                <button key={example} type="button" onClick={() => reset(example)}>{example}</button>
              ))}
            </div>
          </form>
        )}

        {isPlanning && (
          <div className="landing-demo-processing" role="status" aria-live="polite">
            <LoaderCircle aria-hidden="true" />
            <div><strong>Understanding…</strong><p>Checking the request against what CrazyLoops can really do.</p></div>
          </div>
        )}

        {result?.status === "supported" && (
          <div className="landing-demo-result" aria-live="polite">
            <div className="landing-understanding">
              <span><Check aria-hidden="true" />Outcome understood</span>
              <p>Supported preview · nothing has run</p>
            </div>
            <ol className="landing-workflow landing-workflow-horizontal" aria-label="Proposed CrazyLoops workflow">
              {result.steps.map((step, index) => (
                <li key={step.id} className={index < revealedSteps ? "is-revealed" : "is-waiting"}>
                  <span className="landing-node-index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="landing-node-icon"><StepIcon step={step} /></span>
                  <div><strong>{step.label}</strong><p>{step.detail}</p></div>
                  <span className="landing-node-ready"><Check aria-hidden="true" />Ready</span>
                </li>
              ))}
            </ol>
            <div className="landing-demo-result-actions">
              <p>{result.message}</p>
              <div>
                <button type="button" onClick={() => void saveAndContinue()} disabled={isLeaving} className="landing-demo-build">
                  {isLeaving ? "Saving draft…" : "Build it for real"} <ArrowRight aria-hidden="true" />
                </button>
                <button type="button" onClick={() => reset()} className="landing-demo-text-button">Try another</button>
              </div>
            </div>
          </div>
        )}

        {result?.status === "unsupported" && (
          <div className="landing-demo-message landing-demo-unsupported" role="status" aria-live="polite">
            <span className="landing-demo-message-mark" aria-hidden="true">!</span>
            <p className="landing-demo-label">{result.title}</p>
            <h3>{result.message}</h3>
            <p>CrazyLoops will not invent a connector or pretend this loop can run.</p>
            <button type="button" onClick={() => reset(DEFAULT_PROMPT)} className="landing-demo-build">Try a supported example <ArrowRight aria-hidden="true" /></button>
          </div>
        )}

        {result?.status === "clarification" && (
          <div className="landing-demo-message landing-demo-clarification" role="status" aria-live="polite">
            <p className="landing-demo-label">One thing before I build this:</p>
            <h3>{result.question}</h3>
            {result.canClarify ? (
              <form onSubmit={(event) => {
                event.preventDefault();
                if (!clarification.trim()) return;
                setClarificationTurn(1);
                void buildLoop(clarification, 1);
              }}>
                <label htmlFor="homepage-loop-clarification" className="sr-only">Clarification</label>
                <input
                  id="homepage-loop-clarification"
                  value={clarification}
                  maxLength={240}
                  onChange={(event) => setClarification(event.target.value)}
                  placeholder="For example: A hosted form, then store it in CrazyLoops"
                />
                <button type="submit" className="landing-demo-build" disabled={!clarification.trim()}>Update the loop <ArrowRight aria-hidden="true" /></button>
              </form>
            ) : (
              <button type="button" onClick={() => void saveAndContinue()} disabled={isLeaving} className="landing-demo-build">
                Continue in CrazyLoops <ArrowRight aria-hidden="true" />
              </button>
            )}
            <button type="button" onClick={() => reset()} className="landing-demo-text-button">Try another description</button>
          </div>
        )}

        {error && <p className="landing-demo-error" role="alert">{error}</p>}
        <p className="landing-demo-trust">No account needed to preview. Nothing runs until you choose to build it.</p>
      </div>
    </div>
  );
}
