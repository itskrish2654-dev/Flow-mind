"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  HelpCircle,
  LoaderCircle,
  Play,
  RotateCcw,
  Sparkles,
} from "lucide-react";

import {
  runTestWorkflow,
  type TestExecutionLog,
} from "@/app/actions/execute";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { CompiledWorkflow, StepInput } from "@/lib/schemas/workflow";
import {
  friendlyStepCopy,
  getStepInputs,
  orderWorkflowSteps,
  toPlainEnglish,
  type WorkflowStep,
} from "@/lib/workflow-setup";

type ProjectSetupProps = {
  workflowId: string;
  workflow: CompiledWorkflow;
};

type SetupQuestion = {
  id: string;
  step: WorkflowStep;
  stepIndex: number;
  input: StepInput;
};

function guideSteps(guide: string): string[] {
  const withBreaks = guide.replace(
    /\s+(?=(?:[1-3][.)]|[1-3]️⃣)\s*)/g,
    "\n",
  );
  return withBreaks
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[1-3][.)]|[1-3]️⃣)\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

function linkedText(text: string, linksEnabled = true): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\[([^\]]+)]\((https?:\/\/[^)]+)\)|(https?:\/\/[^\s]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const rawHref = match[2] ?? match[3] ?? "";
    const trailingPunctuation = match[3]?.match(/[.,;:!?]+$/)?.[0] ?? "";
    const href = trailingPunctuation
      ? rawHref.slice(0, -trailingPunctuation.length)
      : rawHref;
    const label = match[1] ?? href.replace(/^https?:\/\//, "").replace(/\/$/, "");
    parts.push(
      <a
        key={`${href}-${match.index}`}
        href={href}
        target="_blank"
        rel="noreferrer"
        tabIndex={linksEnabled ? undefined : -1}
        className="font-semibold text-violet-700 underline decoration-violet-300 underline-offset-2 hover:text-violet-900"
      >
        {label}
      </a>,
    );
    if (trailingPunctuation) parts.push(trailingPunctuation);
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function quickExampleLinks(input: StepInput): { label: string; href: string }[] {
  const context = `${input.label} ${input.helpText ?? ""} ${input.howToGetIt ?? ""}`;
  const discoveredUrls = Array.from(context.matchAll(/https?:\/\/[^\s)]+/g)).map(
    (match) => match[0].replace(/[.,;:!?]+$/, ""),
  );
  const contextualUrls = [...discoveredUrls];

  if (/trend|rss/i.test(context)) {
    contextualUrls.unshift("https://trends.google.com/trending");
  } else if (/youtube|script prompt/i.test(context)) {
    contextualUrls.unshift("https://www.youtube.com/creators/");
  } else if (/whatsapp|phone number/i.test(context)) {
    contextualUrls.unshift("https://faq.whatsapp.com/");
  } else if (/email|forwarding/i.test(context)) {
    contextualUrls.unshift("https://support.google.com/mail/answer/10957");
  }

  return Array.from(new Set(contextualUrls)).slice(0, 2).map((href) => {
    const hostname = new URL(href).hostname.replace(/^www\./, "");
    const label = href.includes("trends.google.com")
      ? "Example: Google Trends RSS Feed"
      : href.includes("news.google.com")
        ? "Example: Google News RSS Feed"
        : href.includes("docs.google.com")
          ? "Example: Google Docs"
          : href.includes("notion.so")
            ? "Example: Notion"
            : href.includes("youtube.com")
              ? "Example: YouTube Creator Resources"
              : href.includes("whatsapp.com")
                ? "Example: WhatsApp Help"
                : `Example: ${hostname}`;
    return { label, href };
  });
}

function HelpGuide({
  guideId,
  input,
  isOpen,
  onToggle,
  tone = "slate",
}: {
  guideId: string;
  input: StepInput;
  isOpen: boolean;
  onToggle: () => void;
  tone?: "slate" | "violet";
}) {
  const steps = guideSteps(input.howToGetIt ?? "");
  const examples = quickExampleLinks(input);
  const violet = tone === "violet";

  return (
    <div className={violet ? "mt-3" : "mt-4 rounded-2xl border border-slate-200 bg-slate-50/80"}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls={guideId}
        className={`flex w-full items-center gap-2.5 text-left text-sm font-semibold transition-colors ${violet ? "py-1 text-violet-700" : "px-4 py-3.5 text-slate-700 hover:text-violet-700"}`}
      >
        <HelpCircle className={`size-4 ${violet ? "text-violet-600" : "text-violet-500"}`} />
        ❓ Where do I find this?
        <ChevronDown className={`ml-auto size-4 transition-transform duration-300 ${isOpen ? "rotate-180" : ""} ${violet ? "text-violet-500" : "text-slate-400"}`} />
      </button>

      <div
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
      >
        <div className="overflow-hidden">
          <div
            id={guideId}
            aria-hidden={!isOpen}
            className={violet ? "mt-3 border-t border-violet-100 pt-4" : "border-t border-slate-200 px-4 py-4"}
          >
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-violet-700">
              Follow these three steps
            </p>
            <ol className="mt-3 space-y-3">
              {steps.map((step, index) => (
                <li key={`${step}-${index}`} className="flex items-start gap-3 text-sm leading-6 text-slate-600">
                  <span className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-violet-700 ${violet ? "bg-white shadow-sm" : "bg-violet-100"}`}>
                    {index + 1}
                  </span>
                  <span>{linkedText(step, isOpen)}</span>
                </li>
              ))}
            </ol>
            {examples.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-200/70 pt-4">
                {examples.map((example) => (
                  <a
                    key={example.href}
                    href={example.href}
                    target="_blank"
                    rel="noreferrer"
                    tabIndex={isOpen ? undefined : -1}
                    className="rounded-full border border-violet-200 bg-white px-3 py-1.5 text-xs font-semibold text-violet-700 transition-colors hover:bg-violet-100"
                  >
                    {example.label} ↗
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ProjectSetup({ workflowId, workflow }: ProjectSetupProps) {
  const projectName = toPlainEnglish(workflow.workflowName);
  const projectSummary = toPlainEnglish(workflow.summary);
  const orderedSteps = useMemo(
    () => orderWorkflowSteps(workflow.steps),
    [workflow.steps],
  );
  const setupItems = useMemo<SetupQuestion[]>(
    () =>
      orderedSteps.flatMap((step, stepIndex) =>
        getStepInputs(step, workflowId).map((input) => ({
          id: `${step.id}-${input.key}`,
          step,
          stepIndex,
          input,
        })),
      ),
    [orderedSteps, workflowId],
  );
  const { listeningLinkItem, questions } = useMemo(() => {
    const listeningItem = setupItems.find(
      (item) => item.input.key === "flowpilot_listening_link",
    );
    const requiredItems = setupItems.filter((item) =>
      item.step.inputsRequired?.some((input) => input.key === item.input.key),
    );
    return {
      listeningLinkItem: listeningItem,
      questions: requiredItems.length > 0
        ? requiredItems
        : listeningItem
          ? [listeningItem]
          : setupItems,
    };
  }, [setupItems]);
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(setupItems.map((item) => [item.id, item.input.value ?? ""])),
  );
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [openGuideId, setOpenGuideId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [setupComplete, setSetupComplete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isTrying, setIsTrying] = useState(false);
  const [results, setResults] = useState<TestExecutionLog[]>([]);
  const [deliverySucceeded, setDeliverySucceeded] = useState<boolean | null>(null);
  const restoredProjectState = useRef(false);

  const currentQuestion = questions[currentQuestionIndex];
  const currentValue = currentQuestion ? answers[currentQuestion.id] ?? "" : "";
  const progress = setupComplete
    ? 100
    : Math.round(((currentQuestionIndex + 1) / Math.max(questions.length, 1)) * 100);

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      try {
        const saved = JSON.parse(
          window.localStorage.getItem(`flowmind:project:${workflowId}`) ?? "null",
        ) as {
          answers?: Record<string, string>;
          currentQuestionIndex?: number;
          setupComplete?: boolean;
        } | null;
        if (saved?.answers) {
          setAnswers((current) => ({ ...current, ...saved.answers }));
          setCurrentQuestionIndex(
            Math.min(
              Math.max(saved.currentQuestionIndex ?? 0, 0),
              Math.max(questions.length - 1, 0),
            ),
          );
          setSetupComplete(Boolean(saved.setupComplete));
        } else {
          setAnswers((current) => ({ ...current }));
        }
      } catch {
        setAnswers((current) => ({ ...current }));
      } finally {
        restoredProjectState.current = true;
      }
    }, 0);
    return () => window.clearTimeout(restoreTimer);
  }, [questions.length, workflowId]);

  useEffect(() => {
    if (!restoredProjectState.current) return;
    window.localStorage.setItem(
      `flowmind:project:${workflowId}`,
      JSON.stringify({ answers, currentQuestionIndex, setupComplete }),
    );
    window.localStorage.setItem(
      `flowmind:values:${workflowId}`,
      JSON.stringify(answers),
    );
    const allReady = questions.every((question) =>
      (answers[question.id] ?? question.input.value ?? "").trim(),
    );
    const working = window.localStorage.getItem(`flowmind:status:${workflowId}`) === "working";
    const status = allReady ? (working ? "Working" : "Ready") : "Draft";
    window.dispatchEvent(
      new CustomEvent("flowmind:status-changed", {
        detail: { id: workflowId, status },
      }),
    );
  }, [answers, currentQuestionIndex, questions, setupComplete, workflowId]);

  function goForward() {
    if (!currentQuestion || !currentValue.trim()) {
      setMessage("Please add this detail before continuing.");
      return;
    }

    if (currentQuestion.input.type === "url") {
      try {
        const parsed = new URL(currentValue.trim());
        if (!["http:", "https:"].includes(parsed.protocol)) {
          setMessage("Please enter a valid link beginning with http:// or https://.");
          return;
        }
      } catch {
        setMessage("Please enter a valid link beginning with http:// or https://.");
        return;
      }
    }

    setMessage(null);
    setOpenGuideId(null);
    if (currentQuestionIndex === questions.length - 1) {
      setSetupComplete(true);
      return;
    }
    setCurrentQuestionIndex((index) => index + 1);
  }

  function goBack() {
    setMessage(null);
    setOpenGuideId(null);
    setCurrentQuestionIndex((index) => Math.max(index - 1, 0));
  }

  async function copyLink(link: string) {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setMessage("Please select the link and copy it manually.");
    }
  }

  async function tryAutomation() {
    if (isTrying) return;
    setIsTrying(true);
    setResults([]);
    setDeliverySucceeded(null);
    setMessage(null);

    try {
      const result = await runTestWorkflow(workflowId, orderedSteps, answers);
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setResults(result.logs);
      setDeliverySucceeded(result.delivered);
      if (result.delivered) {
        window.localStorage.setItem(`flowmind:status:${workflowId}`, "working");
        window.dispatchEvent(
          new CustomEvent("flowmind:status-changed", {
            detail: { id: workflowId, status: "Working" },
          }),
        );
      }
    } catch {
      setMessage("We could not try your automation just now. Please try again.");
    } finally {
      setIsTrying(false);
    }
  }

  const isListeningLink = currentQuestion?.input.key === "flowpilot_listening_link";
  const showPreparedLink = Boolean(
    listeningLinkItem && !questions.some((question) => question.id === listeningLinkItem.id),
  );
  const listeningLinkValue = listeningLinkItem
    ? answers[listeningLinkItem.id] ?? listeningLinkItem.input.value ?? ""
    : "";

  return (
    <div className="relative min-h-full overflow-hidden">
      <div className="workspace-grid pointer-events-none absolute inset-x-0 top-0 h-[520px] opacity-60" />
      <div className="relative mx-auto w-full max-w-[1040px] px-5 pb-24 pt-7 sm:px-8 sm:pt-10 lg:px-12 lg:pt-12">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
          <Link href="/dashboard" className="transition-colors hover:text-violet-700">
            My Automations
          </Link>
          <span>/</span>
          <span className="text-slate-700">Friendly setup</span>
        </div>

        <header className="mt-10 max-w-3xl sm:mt-12">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.04em] text-slate-950 sm:text-[42px]">
              {projectName}
            </h1>
            <Badge className="h-7 gap-1.5 border border-violet-200 bg-violet-50 px-3 text-xs font-semibold text-violet-700">
              <Sparkles className="size-3.5" />
              {setupComplete ? "Ready to try" : "Setup in progress"}
            </Badge>
          </div>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500 sm:text-base">
            {projectSummary}
          </p>
        </header>

        <section className="mt-8" aria-labelledby="setup-wizard-title">
          <Card className="gap-0 overflow-hidden rounded-[28px] border border-violet-200 bg-white py-0 shadow-[0_30px_90px_-46px_rgba(109,40,217,0.4)] ring-0">
            <div className="bg-gradient-to-r from-violet-600 via-violet-600 to-indigo-600 px-6 py-5 text-white sm:px-8">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.13em] text-violet-200">
                    Your setup helper
                  </p>
                  <h2 id="setup-wizard-title" className="mt-1.5 text-lg font-semibold sm:text-xl">
                    👋 Let&apos;s configure your {projectName} automation in {questions.length} simple {questions.length === 1 ? "step" : "steps"}.
                  </h2>
                </div>
                <span className="shrink-0 text-sm font-semibold text-violet-100">
                  {setupComplete ? "All done" : `${currentQuestionIndex + 1} of ${questions.length}`}
                </span>
              </div>
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/20">
                <div
                  className="h-full rounded-full bg-white transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            <CardContent className="px-5 py-7 sm:px-8 sm:py-9">
              {showPreparedLink && listeningLinkItem && (
                <div className="mx-auto mb-8 max-w-2xl rounded-2xl border border-violet-100 bg-violet-50/60 p-4 sm:p-5">
                  <label
                    htmlFor={`${listeningLinkItem.id}-prepared`}
                    className="block text-sm font-semibold text-slate-800"
                  >
                    {listeningLinkItem.input.label}
                  </label>
                  <p className="mt-1.5 text-sm italic leading-6 text-slate-500">
                    {listeningLinkItem.input.helpText}
                  </p>
                  <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                    <Input
                      id={`${listeningLinkItem.id}-prepared`}
                      type="url"
                      value={listeningLinkValue}
                      readOnly
                      className="h-11 flex-1 rounded-xl border-violet-200 bg-white px-3.5 text-sm text-slate-700 shadow-none"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void copyLink(listeningLinkValue)}
                      className="h-11 shrink-0 rounded-xl border-violet-200 bg-white px-4 font-semibold text-violet-700 hover:bg-violet-100 hover:text-violet-800"
                    >
                      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                      {copied ? "Copied!" : "Copy Link"}
                    </Button>
                  </div>
                  <HelpGuide
                    guideId={`${listeningLinkItem.id}-prepared-guide`}
                    input={listeningLinkItem.input}
                    isOpen={openGuideId === listeningLinkItem.id}
                    onToggle={() =>
                      setOpenGuideId((openId) =>
                        openId === listeningLinkItem.id ? null : listeningLinkItem.id,
                      )
                    }
                    tone="violet"
                  />
                </div>
              )}

              {setupComplete ? (
                <div className="text-center">
                  <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
                    <CheckCircle2 className="size-7" />
                  </span>
                  <h3 className="mt-4 text-xl font-semibold text-slate-950">You&apos;re ready to go</h3>
                  <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-500">
                    Your answers are in place. Try a safe example now to see how your automation will work.
                  </p>
                  <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setSetupComplete(false);
                        setCurrentQuestionIndex(0);
                        setResults([]);
                        setDeliverySucceeded(null);
                      }}
                      className="h-11 rounded-xl border-slate-200 px-5 text-slate-700"
                    >
                      <RotateCcw className="size-4" />
                      Review my answers
                    </Button>
                    <Button
                      onClick={() => void tryAutomation()}
                      disabled={isTrying}
                      className="h-11 rounded-xl bg-violet-600 px-6 font-semibold shadow-lg shadow-violet-600/20 hover:bg-violet-700"
                    >
                      {isTrying ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
                      {isTrying ? "Running test execution..." : "Run Test Execution"}
                    </Button>
                  </div>
                </div>
              ) : currentQuestion ? (
                <div className="mx-auto max-w-2xl">
                  <div className="flex items-center gap-2 text-xs font-semibold text-violet-700">
                    <span className="flex size-7 items-center justify-center rounded-lg bg-violet-100">
                      {friendlyStepCopy[currentQuestion.step.type].icon}
                    </span>
                    A quick question for step {currentQuestion.stepIndex + 1}
                  </div>

                  <label
                    htmlFor={currentQuestion.id}
                    className="mt-5 block text-xl font-semibold leading-8 tracking-[-0.02em] text-slate-950 sm:text-2xl"
                  >
                    {currentQuestion.input.label}
                  </label>
                  {currentQuestion.input.helpText && (
                    <p className="mt-2 text-sm leading-6 text-slate-500">
                      {currentQuestion.input.helpText}
                    </p>
                  )}

                  <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                    <Input
                      id={currentQuestion.id}
                      type={currentQuestion.input.type === "secret" ? "password" : currentQuestion.input.type === "url" ? "url" : "text"}
                      value={currentValue}
                      onChange={(event) => {
                        setAnswers((current) => ({
                          ...current,
                          [currentQuestion.id]: event.target.value,
                        }));
                        setMessage(null);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          goForward();
                        }
                      }}
                      placeholder={currentQuestion.input.placeholder}
                      maxLength={10_000}
                      autoComplete={currentQuestion.input.type === "secret" ? "off" : undefined}
                      readOnly={isListeningLink}
                      className="h-12 flex-1 rounded-xl border-slate-200 bg-slate-50/70 px-4 text-sm text-slate-800 shadow-none placeholder:text-slate-400 focus-visible:border-violet-400 focus-visible:ring-violet-100"
                    />
                    {isListeningLink && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void copyLink(currentValue)}
                        className="h-12 shrink-0 rounded-xl border-violet-200 bg-violet-50 px-5 font-semibold text-violet-700 hover:bg-violet-100 hover:text-violet-800"
                      >
                        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                        {copied ? "Copied!" : "Copy Link"}
                      </Button>
                    )}
                  </div>

                  {message && (
                    <p role="alert" className="mt-3 text-sm font-medium text-rose-600">
                      {message}
                    </p>
                  )}

                  <HelpGuide
                    guideId={`${currentQuestion.id}-guide`}
                    input={currentQuestion.input}
                    isOpen={openGuideId === currentQuestion.id}
                    onToggle={() =>
                      setOpenGuideId((openId) =>
                        openId === currentQuestion.id ? null : currentQuestion.id,
                      )
                    }
                  />

                  <Separator className="my-6 bg-slate-100" />
                  <div className="flex items-center justify-between gap-3">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={goBack}
                      disabled={currentQuestionIndex === 0}
                      className="h-11 rounded-xl px-4 text-slate-600"
                    >
                      <ArrowLeft className="size-4" />
                      Back
                    </Button>
                    <Button
                      type="button"
                      onClick={goForward}
                      className="h-11 rounded-xl bg-violet-600 px-6 font-semibold shadow-lg shadow-violet-600/15 hover:bg-violet-700"
                    >
                      {currentQuestionIndex === questions.length - 1 ? "Finish Setup" : "Continue"}
                      <ArrowRight className="size-4" />
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </section>

        <section className="mt-14" aria-labelledby="automation-plan-title">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.13em] text-violet-600">Your plan</p>
              <h2 id="automation-plan-title" className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-slate-950">
                Here&apos;s what FlowPilot will do
              </h2>
            </div>
            <span className="text-xs font-medium text-slate-400">{orderedSteps.length} easy steps</span>
          </div>

          <div className="relative mt-7 space-y-4">
            {orderedSteps.length > 1 && (
              <div className="absolute bottom-10 left-6 top-10 w-px bg-gradient-to-b from-violet-200 via-indigo-200 to-emerald-200 sm:left-8" />
            )}
            {orderedSteps.map((step, index) => {
              const friendly = friendlyStepCopy[step.type];
              const stepQuestions = questions.filter((question) => question.step.id === step.id);
              const readyCount = stepQuestions.filter((question) => answers[question.id]?.trim()).length;
              const stepReady = readyCount === stepQuestions.length;

              return (
                <Card
                  key={step.id}
                  className="relative gap-0 rounded-3xl border border-slate-200/90 bg-white py-0 shadow-[0_18px_55px_-40px_rgba(15,23,42,0.32)] ring-0 sm:ml-16"
                >
                  <span className={`absolute left-4 top-6 z-10 flex size-12 items-center justify-center rounded-2xl text-xl font-bold shadow-lg sm:-left-[65px] sm:size-14 sm:text-2xl ${friendly.numberColor}`}>
                    {index + 1}
                  </span>
                  <CardContent className="pb-6 pl-20 pr-5 pt-6 sm:px-7">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <Badge className={`h-7 border px-3 text-[10px] font-bold tracking-[0.08em] ${friendly.color}`}>
                          <span>{friendly.icon}</span>
                          {friendly.label}
                        </Badge>
                        <h3 className="mt-3 text-lg font-semibold tracking-[-0.02em] text-slate-900">
                          {toPlainEnglish(step.title)}
                        </h3>
                        <p className="mt-1.5 text-sm leading-6 text-slate-500">
                          {toPlainEnglish(step.description)}
                        </p>
                      </div>
                      <Badge className={`h-7 shrink-0 border px-3 text-xs font-semibold ${stepReady ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
                        {stepReady ? <CheckCircle2 className="size-3.5" /> : <Sparkles className="size-3.5" />}
                        {stepReady ? "Ready" : `${stepQuestions.length - readyCount} answer${stepQuestions.length - readyCount === 1 ? "" : "s"} left`}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>

        {results.length > 0 && (
          <Card className={`mt-10 gap-0 rounded-3xl border py-0 shadow-none ring-0 ${deliverySucceeded ? "border-emerald-200 bg-emerald-50/70" : "border-amber-200 bg-amber-50/70"}`}>
            <CardContent className="px-6 py-6 sm:px-8">
              <div className="flex items-center gap-3">
                <span className={`flex size-10 items-center justify-center rounded-xl text-white ${deliverySucceeded ? "bg-emerald-600" : "bg-amber-500"}`}>
                  {deliverySucceeded ? (
                    <CheckCircle2 className="size-5" />
                  ) : (
                    <AlertTriangle className="size-5" />
                  )}
                </span>
                <div>
                  <h2 className="font-semibold text-slate-950">
                    {deliverySucceeded
                      ? "Your real test data was delivered"
                      : "The test finished, but delivery needs attention"}
                  </h2>
                  <p className={`mt-0.5 text-xs ${deliverySucceeded ? "text-emerald-700" : "text-amber-700"}`}>
                    Here&apos;s what happened, step by step.
                  </p>
                </div>
              </div>
              <div className="mt-5 space-y-2.5">
                {results.map((result) => (
                  <div key={result.message} className="flex items-start gap-3 rounded-xl border border-emerald-100 bg-white/80 px-4 py-3 text-sm text-slate-700">
                    <span aria-hidden="true">{result.icon}</span>
                    <span>{result.message}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
