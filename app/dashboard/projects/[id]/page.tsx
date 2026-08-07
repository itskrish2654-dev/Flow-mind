import { notFound } from "next/navigation";

import { getWorkflow } from "@/app/actions/workflow";
import { AutomationWorkspace } from "@/components/automation-workspace";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const result = await getWorkflow(id);

  if (!result.ok) {
    notFound();
  }

  return (
    <AutomationWorkspace
      key={id}
      initialWorkflowId={id}
      initialWorkflow={result.workflow}
    />
  );
}
