"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Bot, LoaderCircle, MessageCircle, Plus, RefreshCw, Send, Sparkles } from "lucide-react";

import {
  checkAskMessageStatus,
  retryAskMessageAction,
  submitAskMessage,
} from "@/app/actions/ask";
import { requestAskActionApproval } from "@/app/actions/action-executions";
import {
  createAskClientSubmission,
  performAskClientSubmission,
  shouldApplyAskResult,
  type AskClientSubmission,
} from "@/lib/ask-client-submission";
import type { AskPageData, SendAskResult } from "@/lib/ask";

const STARTERS = [
  "What do I need to do today?",
  "What am I waiting on?",
  "What needs my approval?",
  "Which workflows need attention?",
] as const;

function sourceLabel(kind: string): string {
  switch (kind) {
    case "work_item": return "Work Item";
    case "approval": return "Approval";
    case "workflow": return "Workflow";
    case "execution": return "Execution";
    case "action_execution": return "Action result";
    case "gmail_message": return "Gmail";
    case "sheet_row": return "Sheet row";
    case "sheet_range": return "Sheet range";
    default: return "CrazyLoops";
  }
}

function pendingFromPage(data: AskPageData): AskClientSubmission | null {
  if (!data.pendingSubmission) {
    return data.requestedSubmissionId
      ? { requestId: data.requestedSubmissionId, question: "", threadId: data.selectedThread?.id ?? null }
      : null;
  }
  if (data.pendingSubmission.state === "completed") return null;
  return {
    requestId: data.pendingSubmission.request_id,
    question: "",
    threadId: data.pendingSubmission.thread_id,
  };
}

function pendingFeedback(data: AskPageData): SendAskResult | null {
  const turn = data.pendingSubmission;
  if (!turn) {
    return data.requestedSubmissionId ? {
      ok: false, requestId: data.requestedSubmissionId, threadId: data.selectedThread?.id ?? null,
      outcome: "uncertain", messageSaved: null, replayed: false, retryable: false,
      error: "CrazyLoops has not confirmed this request yet. Check the saved status before submitting it again.",
    } : null;
  }
  if (turn.state === "completed") return null;
  if (turn.state === "processing") {
    return {
      ok: false, requestId: turn.request_id, threadId: turn.thread_id,
      outcome: "processing", messageSaved: true, replayed: true, retryable: false,
      error: "Your question is still processing. Check its status again shortly.",
    };
  }
  return {
    ok: false, requestId: turn.request_id, threadId: turn.thread_id,
    outcome: "failed", messageSaved: true, replayed: true, retryable: true,
    error: turn.failure_category === "interrupted"
      ? "Your question was saved, but the attempt was interrupted. You can retry it safely."
      : "Your question was saved, but CrazyLoops could not generate an answer. You can retry it safely.",
  };
}

export function AskView({ data }: { data: AskPageData }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [feedback, setFeedback] = useState<SendAskResult | null>(() => pendingFeedback(data));
  const [pending, setPending] = useState<AskClientSubmission | null>(() => pendingFromPage(data));
  const submittingRef = useRef(false);
  const activeThreadRef = useRef<string | null>(data.selectedThread?.id ?? null);
  useEffect(() => {
    activeThreadRef.current = data.selectedThread?.id ?? null;
  }, [data.selectedThread?.id]);

  function requestUrl(submission: AskClientSubmission, resolvedThreadId?: string | null): string {
    const params = new URLSearchParams();
    const threadId = resolvedThreadId ?? submission.threadId;
    if (threadId) params.set("thread", threadId);
    params.set("request", submission.requestId);
    return `/ask?${params.toString()}`;
  }

  function rememberInUrl(submission: AskClientSubmission, resolvedThreadId?: string | null) {
    window.history.replaceState(window.history.state, "", requestUrl(submission, resolvedThreadId));
  }

  function currentUrlThread(): string | null {
    return new URLSearchParams(window.location.search).get("thread");
  }

  function applyResult(submission: AskClientSubmission, result: SendAskResult) {
    if (!shouldApplyAskResult(submission, currentUrlThread(), result)) return;
    setFeedback(result);
    if (result.messageSaved === true) setMessage((current) => current === submission.question ? "" : current);

    if (result.outcome === "completed") {
      setPending(null);
      router.replace(result.threadId ? `/ask?thread=${encodeURIComponent(result.threadId)}` : "/ask");
      router.refresh();
      return;
    }
    if (result.outcome === "processing" || result.outcome === "failed" || result.outcome === "uncertain") {
      const retained = { ...submission, threadId: result.threadId ?? submission.threadId };
      setPending(retained);
      rememberInUrl(retained, result.threadId);
      router.refresh();
      return;
    }
    if (result.outcome === "busy" || result.outcome === "rejected") {
      setPending(null);
      const threadId = submission.threadId ?? activeThreadRef.current;
      window.history.replaceState(window.history.state, "", threadId ? `/ask?thread=${encodeURIComponent(threadId)}` : "/ask");
    }
  }

  async function send(value = message) {
    const question = value.trim();
    if (!question || submittingRef.current
      || (pending && (feedback?.outcome === "processing" || feedback?.outcome === "uncertain"))) return;
    submittingRef.current = true;
    setIsSending(true);
    setFeedback(null);
    const submission = createAskClientSubmission(question, activeThreadRef.current);
    setPending(submission);
    rememberInUrl(submission);
    try {
      const attempt = await performAskClientSubmission(submission, submitAskMessage);
      if (attempt.kind === "network_error") {
        if (currentUrlThread() === submission.threadId) {
          setPending(submission);
          setFeedback({
            ok: false,
            requestId: submission.requestId,
            threadId: submission.threadId,
            outcome: "uncertain",
            messageSaved: null,
            replayed: false,
            retryable: false,
            error: "The network response was interrupted. Your draft is preserved; check the saved status before submitting again.",
          });
        }
        return;
      }
      applyResult(submission, attempt.result);
    } finally {
      submittingRef.current = false;
      setIsSending(false);
    }
  }

  async function reconcilePending() {
    if (!pending || submittingRef.current) return;
    submittingRef.current = true;
    setIsSending(true);
    try {
      const result = await checkAskMessageStatus({
        requestId: pending.requestId,
        ...(pending.threadId ? { threadId: pending.threadId } : {}),
      });
      applyResult(pending, result);
    } catch {
      if (currentUrlThread() === pending.threadId) {
        setFeedback({
          ok: false, requestId: pending.requestId, threadId: pending.threadId,
          outcome: "uncertain", messageSaved: null, replayed: false, retryable: false,
          error: "CrazyLoops still could not confirm the saved status. Your draft and request identifier are preserved.",
        });
      }
    } finally {
      submittingRef.current = false;
      setIsSending(false);
    }
  }

  async function retryPending() {
    if (!pending || submittingRef.current) return;
    submittingRef.current = true;
    setIsSending(true);
    setFeedback(null);
    try {
      const result = await retryAskMessageAction({
        requestId: pending.requestId,
        ...(pending.threadId ? { threadId: pending.threadId } : {}),
      });
      applyResult(pending, result);
    } catch {
      if (currentUrlThread() === pending.threadId) {
        setFeedback({
          ok: false, requestId: pending.requestId, threadId: pending.threadId,
          outcome: "uncertain", messageSaved: true, replayed: false, retryable: false,
          error: "The retry response was interrupted. Check the stored status before retrying again.",
        });
      }
    } finally {
      submittingRef.current = false;
      setIsSending(false);
    }
  }

  return (
    <main className="flex h-dvh min-w-0 flex-col overflow-hidden bg-[#f7f4ee] pt-16 lg:pt-0">
      <header className="flex min-h-[76px] items-center justify-between border-b border-[#e4ddd2] bg-[#fffdfa] px-4 sm:px-6 lg:px-8">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9a7007]">Your work, grounded in CrazyLoops</p>
          <h1 className="mt-1 text-xl font-semibold tracking-[-0.025em] text-[#272536] sm:text-2xl">Ask CrazyLoops</h1>
        </div>
        <Link href="/ask" className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#d9cfbf] bg-white px-3 text-sm font-semibold text-[#34313d] transition hover:border-[#d7aa2f] hover:bg-[#fff8e3] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8a6200]">
          <Plus className="size-4" />
          <span className="hidden sm:inline">New conversation</span>
          <span className="sm:hidden">New</span>
        </Link>
      </header>

      <div className="grid min-h-0 min-w-0 flex-1 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside aria-label="Recent Ask conversations" className="min-w-0 border-b border-[#e4ddd2] bg-[#fbf9f5] p-3 lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <p className="px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Recent conversations</p>
          <div className="flex gap-2 overflow-x-auto pb-1 lg:block lg:space-y-1 lg:overflow-visible">
            {data.threads.length === 0 ? (
              <p className="min-w-[220px] rounded-xl border border-dashed border-[#ddd3c3] px-3 py-4 text-xs leading-5 text-slate-500">Your private conversations will appear here.</p>
            ) : data.threads.map((thread) => {
              const active = data.selectedThread?.id === thread.id;
              return (
                <Link key={thread.id} href={`/ask?thread=${encodeURIComponent(thread.id)}`} aria-current={active ? "page" : undefined} className={`flex min-h-11 min-w-[220px] items-center gap-2 rounded-xl px-3 py-2 text-left text-xs transition lg:min-w-0 ${active ? "bg-[#fff2bd] font-semibold text-[#5f4705]" : "text-slate-700 hover:bg-[#f2ede5]"}`}>
                  <MessageCircle className="size-4 shrink-0" />
                  <span className="truncate">{thread.title}</span>
                </Link>
              );
            })}
          </div>
        </aside>

        <section aria-label="Ask conversation" className="flex min-h-0 min-w-0 flex-col">
          <div aria-live="polite" className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 lg:px-10">
            <div className="mx-auto max-w-3xl space-y-4">
              {data.unavailable && (
                <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">This conversation is unavailable. It may not belong to your account, or CrazyLoops could not load it safely.</p>
              )}
              {!data.selectedThread && !data.unavailable && (
                <div className="py-8 text-center sm:py-14">
                  <span className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-[#e4c35d] bg-[#fff2bd] text-[#805b00]"><Sparkles className="size-5" /></span>
                  <h2 className="mt-5 text-2xl font-semibold tracking-[-0.03em] text-[#272536]">What is happening with your work?</h2>
                  <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">Ask about the Work Items, approvals, workflows, and activity already stored in your private CrazyLoops workspace.</p>
                  <div className="mx-auto mt-7 grid max-w-2xl gap-2 sm:grid-cols-2">
                    {STARTERS.map((starter) => (
                      <button key={starter} type="button" onClick={() => { setMessage(starter); void send(starter); }} disabled={isSending || Boolean(pending)} className="group flex min-h-12 items-center justify-between rounded-xl border border-[#ddd3c3] bg-[#fffdfa] px-4 text-left text-sm text-slate-700 transition hover:border-[#d7aa2f] hover:bg-[#fff8e3] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8a6200] disabled:opacity-60">
                        <span>{starter}</span><ArrowRight className="size-4 shrink-0 text-[#9a7007] transition group-hover:translate-x-0.5" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {data.messages.map((item) => (
                <article key={item.id} className={`flex gap-3 ${item.role === "user" ? "justify-end" : "justify-start"}`}>
                  {item.role === "assistant" && <span aria-hidden="true" className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-xl bg-[#fff2bd] text-[#805b00]"><Bot className="size-4" /></span>}
                  <div className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-6 sm:max-w-[75%] ${item.role === "user" ? "bg-[#34313d] text-white" : "border border-[#e4ddd2] bg-[#fffdfa] text-slate-800"}`}>
                    <p className="whitespace-pre-wrap break-words">{item.content}</p>
                    {item.metadata?.actionPreview && (
                      <section aria-label="Action preview" className="mt-3 rounded-xl border border-[#e0c35d] bg-[#fff9df] p-3 text-slate-800">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#805b00]">Action preview</p>
                        <h3 className="mt-1 font-semibold">{item.metadata.actionPreview.actionTitle}</h3>
                        <p className="mt-1 text-xs leading-5 text-slate-600">{item.metadata.actionPreview.actionSummary}</p>
                        <dl className="mt-3 space-y-2 text-xs">
                          <div><dt className="font-semibold text-slate-500">Target</dt><dd className="break-words">{item.metadata.actionPreview.target.label}</dd></div>
                          {item.metadata.actionPreview.parameters.map((parameter) => (
                            <div key={parameter.name}><dt className="font-semibold text-slate-500">{parameter.label}</dt><dd className="whitespace-pre-wrap break-words">{parameter.value}</dd></div>
                          ))}
                        </dl>
                        <p className="mt-3 text-xs font-semibold text-[#765600]">Nothing has been sent or changed yet.</p>
                        <form action={requestAskActionApproval} className="mt-3">
                          <input type="hidden" name="messageId" value={item.id} />
                          <button type="submit" className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-[#34313d] px-4 text-xs font-semibold text-white transition hover:bg-[#211f2a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8a6200]">
                            Review and request approval <ArrowRight className="size-3.5" />
                          </button>
                        </form>
                      </section>
                    )}
                    {item.metadata && item.metadata.references.length > 0 && (
                      <div aria-label="Sources" className="mt-3 flex flex-wrap gap-2 border-t border-[#e8e1d6] pt-3">
                        {item.metadata.references.map((reference) => (
                          <Link key={`${reference.kind}:${reference.entityId}`} href={reference.href} className="inline-flex min-h-8 items-center rounded-full border border-[#ddd3c3] bg-white px-3 text-[11px] font-semibold text-slate-700 hover:border-[#d7aa2f] hover:bg-[#fff8e3]">
                            {sourceLabel(reference.kind)} · {reference.label}
                          </Link>
                        ))}
                      </div>
                    )}
                    {item.metadata?.suggestedAction && (
                      <Link href={item.metadata.suggestedAction.href} className="mt-3 inline-flex min-h-9 items-center gap-1 text-xs font-semibold text-[#765600] underline decoration-[#d7aa2f] underline-offset-4">{item.metadata.suggestedAction.label}<ArrowRight className="size-3.5" /></Link>
                    )}
                  </div>
                </article>
              ))}
              {isSending && <p role="status" className="flex items-center gap-2 text-sm text-slate-500"><LoaderCircle className="size-4 animate-spin" />CrazyLoops is checking your workspace…</p>}
            </div>
          </div>

          <div className="border-t border-[#e4ddd2] bg-[#fffdfa] p-3 sm:p-4">
            <form className="mx-auto max-w-3xl" onSubmit={(event) => { event.preventDefault(); void send(); }}>
              {feedback?.error && (
                <div role={feedback.outcome === "processing" ? "status" : "alert"} className={`mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs ${feedback.outcome === "failed" ? "bg-rose-50 text-rose-800" : "bg-amber-50 text-amber-900"}`}>
                  <span>{feedback.error}</span>
                  {pending && (
                    <span className="flex gap-2">
                      {(feedback.outcome === "processing" || feedback.outcome === "uncertain") && (
                        <button type="button" onClick={() => void reconcilePending()} disabled={isSending} className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-current/20 px-2 font-semibold disabled:opacity-50"><RefreshCw className="size-3.5" />Check status</button>
                      )}
                      {feedback.outcome === "failed" && feedback.retryable && (
                        <button type="button" onClick={() => void retryPending()} disabled={isSending} className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-current/20 px-2 font-semibold disabled:opacity-50"><RefreshCw className="size-3.5" />Retry answer</button>
                      )}
                    </span>
                  )}
                </div>
              )}
              <div className="flex items-end gap-2 rounded-2xl border border-[#d9cfbf] bg-white p-2 shadow-sm focus-within:border-[#b58a13] focus-within:ring-2 focus-within:ring-[#efd77f]/40">
                <label htmlFor="ask-message" className="sr-only">Ask CrazyLoops</label>
                <textarea id="ask-message" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={2_000} rows={2} disabled={isSending} placeholder="Ask about your work, approvals, workflows, or recent activity…" className="max-h-36 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 disabled:opacity-60" />
                <button type="submit" disabled={isSending || !message.trim() || Boolean(pending && (feedback?.outcome === "processing" || feedback?.outcome === "uncertain"))} aria-label="Send message" className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#f1c94b] text-[#272536] transition hover:bg-[#e5bb3a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#8a6200] disabled:cursor-not-allowed disabled:opacity-50">
                  {isSending ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
                </button>
              </div>
              <p className="mt-2 px-2 text-[11px] text-slate-500">Ask uses only scoped CrazyLoops data. Supported external actions always show an exact preview and require approval before execution.</p>
            </form>
          </div>
        </section>
      </div>
    </main>
  );
}
