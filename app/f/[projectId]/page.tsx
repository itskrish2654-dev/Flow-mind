import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublicWorkflowForm } from "@/components/public-workflow-form";
import { getPublicExecutableWorkflow } from "@/lib/public-workflow";

export const metadata: Metadata = {
  title: "Secure Form",
  description: "Submit information to a secure CrazyLoops automation.",
  robots: { index: false, follow: false },
};

export default async function PublicFormPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const publicWorkflow = await getPublicExecutableWorkflow(projectId);
  if (!publicWorkflow) notFound();
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const challengeUnavailable =
    publicWorkflow.challengeMode === "turnstile" && !turnstileSiteKey;

  return (
    <main className="dashboard-theme relative h-dvh overflow-y-auto bg-[#f7f4ee] px-4 py-8 sm:px-6 sm:py-12">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_50%_6%,rgba(241,201,75,.2),transparent_34%)]" />
      <div className="pointer-events-none fixed inset-0 opacity-40 [background-image:radial-gradient(circle,rgba(116,109,99,.2)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:linear-gradient(to_bottom,black,transparent_48%)]" />
      <div className="relative mx-auto flex min-h-[calc(100dvh-4rem)] items-center justify-center sm:min-h-[calc(100dvh-6rem)]">
        {publicWorkflow.capabilityError || challengeUnavailable ? (
          <section className="w-full max-w-xl rounded-[28px] border border-amber-200 bg-[#fffdfa] p-8 text-center shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-amber-700">Automation unavailable</p>
            <h1 className="mt-3 text-2xl font-semibold text-slate-950">This form cannot run yet</h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              {publicWorkflow.capabilityError ?? "The form's bot protection is not configured."}
            </p>
            <p className="mt-5 text-xs text-slate-500">No submission was sent or marked successful.</p>
          </section>
        ) : (
          <PublicWorkflowForm
            projectId={publicWorkflow.id}
            form={publicWorkflow.form}
            challengeMode={publicWorkflow.challengeMode}
            turnstileSiteKey={turnstileSiteKey}
          />
        )}
      </div>
    </main>
  );
}
