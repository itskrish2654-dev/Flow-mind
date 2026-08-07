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
    <main className="dashboard-theme relative h-dvh overflow-y-auto bg-[#f7f4ee] px-4 py-8 sm:px-6 sm:py-12">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_50%_6%,rgba(241,201,75,.2),transparent_34%)]" />
      <div className="pointer-events-none fixed inset-0 opacity-40 [background-image:radial-gradient(circle,rgba(116,109,99,.2)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:linear-gradient(to_bottom,black,transparent_48%)]" />
      <div className="relative mx-auto flex min-h-[calc(100dvh-4rem)] items-center justify-center sm:min-h-[calc(100dvh-6rem)]">
        <PublicWorkflowForm projectId={publicWorkflow.id} form={publicWorkflow.form} />
      </div>
    </main>
  );
}
