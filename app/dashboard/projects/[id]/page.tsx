import { notFound } from "next/navigation";

import { listWorkflowExecutions } from "@/app/actions/executions";
import { getWorkflow } from "@/app/actions/workflow";
import { ProjectWorkspace } from "@/components/project-workspace";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [result, executionsResult] = await Promise.all([
    getWorkflow(id),
    listWorkflowExecutions(id),
  ]);

  if (!result.ok) {
    notFound();
  }

  return (
    <ProjectWorkspace
      workflowId={id}
      workflow={result.workflow}
      initialExecutions={executionsResult.ok ? executionsResult.executions : []}
    />
  );
}
