import { notFound } from "next/navigation";

import { listWorkflowExecutions } from "@/app/actions/executions";
import { getWorkflow } from "@/app/actions/workflow";
import { listWorkflowVersions } from "@/app/actions/versions";
import { AutomationWorkspace } from "@/components/automation-workspace";
import { ProjectWorkspace } from "@/components/project-workspace";
import { getAuthenticatedContext } from "@/lib/auth";
import { listConnectionViews } from "@/lib/connectors/connection-view";

function connectionName(value: string | null): string {
  if (value?.startsWith("google_")) return "Google";
  if (value === "slack") return "Slack";
  if (value === "notion") return "Notion";
  if (value === "airtable") return "Airtable";
  return "App";
}

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    connected?: string | string[];
    connection_error?: string | string[];
    step?: string | string[];
  }>;
}) {
  const { id } = await params;
  const [result, auth, query] = await Promise.all([
    getWorkflow(id),
    getAuthenticatedContext(),
    searchParams,
  ]);

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

  const connections = auth ? await listConnectionViews(auth.user.id) : [];
  const requestedStep = typeof query.step === "string" ? query.step : null;
  const selectedStepId = requestedStep && result.workflow.steps.some((step) => step.id === requestedStep)
    ? requestedStep
    : null;
  const connected = typeof query.connected === "string" ? query.connected : null;
  const connectionError = typeof query.connection_error === "string" ? query.connection_error : null;
  const connectionNotice = connected
    ? { tone: "success" as const, message: `${connectionName(connected)} connected. Continue setting up this step.` }
    : connectionError
      ? {
        tone: "error" as const,
        message: connectionError === "oauth_cancelled"
          ? "The app wasn’t connected. Your workflow draft is still here."
          : "The app couldn’t be connected. Your workflow draft is still here—try again when you’re ready.",
      }
      : null;

  const [executionsResult, versionsResult] = await Promise.all([
    listWorkflowExecutions(id),
    listWorkflowVersions(id),
  ]);

  return (
    <ProjectWorkspace
      key={result.versionId}
      workflowId={id}
      workflow={result.workflow}
      published={result.published}
      hasUnpublishedChanges={result.hasUnpublishedChanges}
      initialExecutions={executionsResult.ok ? executionsResult.executions : []}
      initialExecutionCursor={executionsResult.ok ? executionsResult.nextCursor : null}
      initialSetupConfig={result.setupConfig}
      versions={versionsResult.ok ? versionsResult.versions : []}
      connections={connections}
      initialSelectedStepId={selectedStepId}
      connectionNotice={connectionNotice}
    />
  );
}
