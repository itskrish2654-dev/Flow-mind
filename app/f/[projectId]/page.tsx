import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublicWorkflowForm } from "@/components/public-workflow-form";
import { getPublicWorkflow } from "@/lib/public-workflow";

export const metadata: Metadata = {
  title: "Secure Form | FlowMind",
  description: "Submit information to a secure FlowMind automation.",
  robots: { index: false, follow: false },
};

export default async function PublicFormPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const publicWorkflow = await getPublicWorkflow(projectId);
  if (!publicWorkflow) notFound();

  return (
    <main className="relative h-dvh overflow-y-auto bg-[#f4f7fb] px-4 py-8 sm:px-6 sm:py-12">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_50%_8%,rgba(99,102,241,.14),transparent_36%)]" />
      <div className="relative mx-auto flex min-h-[calc(100dvh-4rem)] items-center justify-center sm:min-h-[calc(100dvh-6rem)]">
        <PublicWorkflowForm projectId={publicWorkflow.id} form={publicWorkflow.form} />
      </div>
    </main>
  );
}
