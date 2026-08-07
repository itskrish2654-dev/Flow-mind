import { notFound } from "next/navigation";

import { getWorkflow } from "@/app/actions/workflow";
import { ProjectSetup } from "@/components/project-setup";

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

  return <ProjectSetup workflowId={id} workflow={result.workflow} />;
}
