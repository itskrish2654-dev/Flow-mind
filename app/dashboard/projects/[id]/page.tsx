import { notFound } from "next/navigation";

import { listWorkflowExecutions } from "@/app/actions/executions";
import { getWorkflow } from "@/app/actions/workflow";
import { listWorkflowVersions } from "@/app/actions/versions";
import { AutomationWorkspace } from "@/components/automation-workspace";
import { ProjectWorkspace } from "@/components/project-workspace";

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

  if (!result.workflow) {
    return (
      <AutomationWorkspace
        key={id}
        initialWorkflowId={id}
        initialWorkflowName={result.name}
        initialPrompt={result.prompt}
      />
    );
  }

  const [executionsResult, versionsResult] = await Promise.all([
    listWorkflowExecutions(id),
    listWorkflowVersions(id),
  ]);

  return (
    <ProjectWorkspace
      workflowId={id}
      workflow={result.workflow}
      published={result.published}
      initialExecutions={executionsResult.ok ? executionsResult.executions : []}
      initialExecutionCursor={executionsResult.ok ? executionsResult.nextCursor : null}
      initialSetupConfig={result.setupConfig}
      versions={versionsResult.ok ? versionsResult.versions : []}
    />
  );
}
