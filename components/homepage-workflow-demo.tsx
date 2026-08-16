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
  MousePointer2,
  Sparkles,
  GitBranch,
  Webhook,
} from "lucide-react";
import { requestConnectorCapability } from "@/app/actions/connector-requests";

import {
  preserveHomepageDemoDraft,
  previewHomepageDemo,
  trackHomepageDemoInteraction,
} from "@/app/actions/homepage-demo";
import type { HomepageDemoResult, HomepageDemoStep } from "@/lib/homepage-demo";

const DEFAULT_PROMPT = "When a new request comes in, summarize it, create a PDF and save the result.";
const GUIDE_SESSION_KEY = "crazyloops_demo_guide_seen";
const EXAMPLES = [
  "Every morning at 8 AM Asia/Kolkata, summarize new requests and save them",
  "If a form request priority equals urgent, notify Slack. Otherwise save it",
  "Ask me before sending the reply",
];

function StepIcon({ step }: { step: HomepageDemoStep }) {
  if (step.category === "ai") return <Sparkles aria-hidden="true" />;
  if (step.category === "document") return <FileText aria-hidden="true" />;
  if (step.category === "storage") return <Database aria-hidden="true" />;
  if (step.category === "control") return <GitBranch aria-hidden="true" />;
  if (step.label === "Webhook") return <Webhook aria-hidden="true" />;
  return <FormInput aria-hidden="true" />;
}

function stepKind(step: HomepageDemoStep): string {
  if (step.category === "trigger") return "Trigger";
  if (step.category === "ai") return "AI";
  if (step.category === "document") return "Create";
  if (step.category === "control") return "Decision";
  if (step.category === "storage") return "Store";
  return "Send";
}

export function HomepageWorkflowDemo() {
  const [prompt, setPrompt] = useState("");
  const [submittedPrompt, setSubmittedPrompt] = useState("");
  const [result, setResult] = useState<HomepageDemoResult | null>(null);
  const [isPlanning, setIsPlanning] = useState(false);
  const [revealedSteps, setRevealedSteps] = useState(0);
  const [clarification, setClarification] = useState("");
  const [clarificationTurn, setClarificationTurn] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isLeaving, setIsLeaving] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [guideVisible, setGuideVisible] = useState(false);
  const [requestMessage, setRequestMessage] = useState<string | null>(null);
  const demoRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const viewedRef = useRef(false);
  const focusedRef = useRef(false);

  useEffect(() => {
    const demo = demoRef.current;
    if (!demo) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(({ isIntersecting }) => isIntersecting) || viewedRef.current) return;
      viewedRef.current = true;
      void trackHomepageDemoInteraction("demo_viewed");
      if (window.sessionStorage.getItem(GUIDE_SESSION_KEY)) return;
      window.sessionStorage.setItem(GUIDE_SESSION_KEY, "1");
      setGuideVisible(true);
      timers.current.push(window.setTimeout(() => setGuideVisible(false), 2_400));
    }, { threshold: 0.35 });
    observer.observe(demo);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
  }, []);

  function beginInteraction() {
    setHasInteracted(true);
    setGuideVisible(false);
    window.sessionStorage.setItem(GUIDE_SESSION_KEY, "1");
  }

  function handleFocus() {
    beginInteraction();
    if (!focusedRef.current) {
      focusedRef.current = true;
      void trackHomepageDemoInteraction("demo_input_focused");
    }
  }

  async function buildLoop(nextClarification?: string, nextClarificationTurn = clarificationTurn) {
    if (isPlanning || prompt.trim().length < 4) return;
    beginInteraction();
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
    setIsPlanning(true);
    setSubmittedPrompt(prompt.trim());
    setResult(null);
    setRevealedSteps(0);
    setError(null);

    try {
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
    } catch {
      setIsPlanning(false);
      setError("The preview is temporarily unavailable. Nothing ran—please try again.");
    }
  }

  async function saveAndContinue() {
    if (isLeaving) return;
    setIsLeaving(true);
    setError(null);
    const response = await preserveHomepageDemoDraft({ prompt: submittedPrompt || prompt });
    if (!response.ok) {
      setError(response.error);
      setIsLeaving(false);
      return;
    }
    window.location.assign(response.href);
  }

  function reset(nextPrompt = "") {
    setPrompt(nextPrompt);
    setSubmittedPrompt("");
    setResult(null);
    setError(null);
    setClarification("");
    setClarificationTurn(0);
    setRevealedSteps(0);
  }

  function chooseExample(example: string) {
    beginInteraction();
    reset(example);
    void trackHomepageDemoInteraction("demo_example_clicked");
  }

  const statusText = isPlanning
    ? "Understanding…"
    : result?.status === "supported"
      ? "Loop ready ✓"
      : result?.status === "unsupported"
        ? "Not available"
        : result?.status === "clarification"
          ? "One detail needed"
          : hasInteracted
            ? "Try a loop"
            : "Live preview";

  return (
    <div ref={demoRef} className={`landing-demo landing-demo-compact landing-demo-interactive${guideVisible ? " is-guiding" : ""}`}>
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
              <div className="landing-demo-field">
                <label htmlFor="homepage-loop-prompt" className="landing-demo-label">Tell CrazyLoops what should happen</label>
                <p className="landing-demo-field-hint">Use plain language. You can change anything.</p>
                <textarea
                  id="homepage-loop-prompt"
                  value={prompt}
                  maxLength={600}
                  rows={3}
                  placeholder="Describe something you do repeatedly..."
                  onPointerDown={beginInteraction}
                  onFocus={handleFocus}
                  onKeyDown={beginInteraction}
                  onChange={(event) => { beginInteraction(); setPrompt(event.target.value); }}
                />
                {guideVisible && (
                  <span className="landing-demo-guide" aria-hidden="true">
                    <MousePointer2 /> Try it — type what should happen
                  </span>
                )}
                {guideVisible && !prompt && <span className="landing-demo-fake-caret" aria-hidden="true" />}
              </div>
              <button className="landing-demo-build" type="submit" disabled={prompt.trim().length < 4 || isPlanning}>
                {hasInteracted ? "Build my loop" : "Build the loop"} <ArrowRight aria-hidden="true" />
              </button>
            </div>
            <div className="landing-demo-examples" aria-label="Quick examples">
              <span>Try an example</span>
              <div>
                {EXAMPLES.map((example) => (
                  <button key={example} type="button" onClick={() => chooseExample(example)}>{example}</button>
                ))}
              </div>
            </div>
          </form>
        )}

        {isPlanning && (
          <div className="landing-demo-processing" role="status" aria-live="polite">
            <LoaderCircle aria-hidden="true" />
            <div>
              <strong>Understanding…</strong>
              <p className="landing-demo-processing-prompt">“{submittedPrompt}”</p>
              <p>Checking this against what CrazyLoops can really do.</p>
            </div>
          </div>
        )}

        {result?.status === "supported" && (
          <div className="landing-demo-result" aria-live="polite">
            <div className="landing-understanding">
              <span><Check aria-hidden="true" />Your loop</span>
              <p>Built from what you just typed.</p>
            </div>
            <ol className="landing-workflow landing-workflow-horizontal" aria-label="Proposed CrazyLoops workflow">
              {result.steps.map((step, index) => (
                <li key={step.id} className={index < revealedSteps ? "is-revealed" : "is-waiting"}>
                  <span className="landing-node-index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="landing-node-icon"><StepIcon step={step} /></span>
                  <div><small className="landing-node-kind">{stepKind(step)}</small><strong>{step.label}</strong><p>{step.detail}</p></div>
                  <span className="landing-node-ready"><Check aria-hidden="true" />Ready</span>
                </li>
              ))}
            </ol>
            <div className="landing-demo-result-actions">
              <div className="landing-demo-result-copy">
                <strong>Built from what you just typed.</strong>
                <p>Nothing runs until you choose to build it.</p>
              </div>
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
            <div className="mt-4 flex flex-wrap gap-2">
              {result.requestedCapabilities.map((capability) => (
                <button
                  key={capability.capabilityId}
                  type="button"
                  className="landing-demo-text-button"
                  onClick={async () => {
                    const response = await requestConnectorCapability({ capabilityId: capability.capabilityId, source: "homepage_demo" });
                    setRequestMessage(response.ok ? response.message : response.error);
                  }}
                >
                  Request {capability.displayName}
                </button>
              ))}
            </div>
            {requestMessage && <p role="status" className="mt-2">{requestMessage}</p>}
            <button type="button" onClick={() => chooseExample(DEFAULT_PROMPT)} className="landing-demo-build">Try a supported example <ArrowRight aria-hidden="true" /></button>
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
        <div className="landing-demo-trust"><span>No account needed.</span><span>Nothing runs until you choose to build it.</span></div>
      </div>
    </div>
  );
}
