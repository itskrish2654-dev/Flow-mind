import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, CircleAlert, RotateCcw, Zap } from "lucide-react";

export const metadata: Metadata = {
  title: "Submission Result",
  description: "The result of a CrazyLoops hosted form submission.",
  robots: { index: false, follow: false },
};

const outcomes: Record<
  string,
  { success: boolean; title: string; message: string }
> = {
  stored: {
    success: true,
    title: "Submission received",
    message: "Your submission was stored in CrazyLoops.",
  },
  pdf_generated: {
    success: true,
    title: "Document generated",
    message: "Your PDF was generated and stored in CrazyLoops.",
  },
  completed: {
    success: true,
    title: "Workflow completed",
    message: "Your submission was processed successfully.",
  },
  invalid_link: {
    success: false,
    title: "Invalid form link",
    message: "This form link is not valid.",
  },
  rejected: {
    success: false,
    title: "Submission rejected",
    message: "This submission could not be accepted.",
  },
  invalid_submission: {
    success: false,
    title: "Check your answers",
    message: "Review the required fields and formats, then try again.",
  },
  unavailable: {
    success: false,
    title: "Form unavailable",
    message: "This automation is not currently accepting submissions.",
  },
  execution_failed: {
    success: false,
    title: "Workflow could not finish",
    message: "CrazyLoops could not complete this workflow safely. Please try again.",
  },
  persistence_failed: {
    success: false,
    title: "Submission was not saved",
    message: "CrazyLoops could not save this submission. Please try again.",
  },
  workflow_failed: {
    success: false,
    title: "Workflow stopped",
    message: "A workflow step failed, so this submission was not marked successful.",
  },
  rate_limited: {
    success: false,
    title: "Please wait a moment",
    message: "Too many requests were received. Try again shortly.",
  },
  duplicate: {
    success: false,
    title: "Already received",
    message: "This submission was already received. Wait a moment before trying again.",
  },
  challenge_failed: {
    success: false,
    title: "Verification needed",
    message: "Please complete the bot verification and submit again.",
  },
};

export default async function PublicFormResultPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ outcome?: string }>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  const outcome = outcomes[query.outcome ?? ""] ?? outcomes.workflow_failed;
  const Icon = outcome.success ? CheckCircle2 : CircleAlert;

  return (
    <main className="dashboard-theme relative h-dvh overflow-y-auto bg-[#f7f4ee] px-4 py-8 sm:px-6 sm:py-12">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_50%_6%,rgba(241,201,75,.2),transparent_34%)]" />
      <div className="relative mx-auto flex min-h-[calc(100dvh-4rem)] items-center justify-center sm:min-h-[calc(100dvh-6rem)]">
        <section className="relative w-full max-w-xl overflow-hidden rounded-[28px] border border-[#ddd5c9] bg-[#fffdfa] p-8 text-center shadow-[0_30px_90px_-52px_rgba(72,61,35,.32)] sm:p-12">
          <div className="absolute inset-x-0 top-0 h-1 bg-[#f1c94b]" />
          <div className="mb-8 flex items-center justify-center gap-2 text-[11px] font-semibold text-[#6f685d]">
            <span className="flex size-6 items-center justify-center rounded-lg border border-[#e4c35d] bg-[#fff2bd] text-[#8a6200]">
              <Zap className="size-3.5 fill-current" />
            </span>
            CrazyLoops secure automation
          </div>
          <span className={`mx-auto flex size-16 items-center justify-center rounded-2xl ${outcome.success ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"}`}>
            <Icon className="size-8" />
          </span>
          <h1 className="mt-6 text-2xl font-semibold tracking-[-0.035em] text-slate-950 sm:text-3xl">
            {outcome.title}
          </h1>
          <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-slate-500">
            {outcome.message}
          </p>
          {outcome.success ? (
            <p className="mt-8 text-[11px] text-slate-500">You can safely close this page.</p>
          ) : (
            <Link
              href={`/f/${encodeURIComponent(projectId)}`}
              className="mx-auto mt-8 inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[#d8cfae] bg-[#fff8dc] px-4 text-sm font-semibold text-[#725300] transition hover:bg-[#fff2bd]"
            >
              <RotateCcw className="size-4" /> Try again
            </Link>
          )}
        </section>
      </div>
    </main>
  );
}
