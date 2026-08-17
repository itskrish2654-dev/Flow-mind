import type {
  CompiledWorkflow,
  PublicFormDefinition,
  PublicFormField,
} from "@/lib/schemas/workflow";
import { resolveSiteOrigin } from "@/lib/site-origin";

function uniqueFields(fields: PublicFormField[]): PublicFormField[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    if (seen.has(field.key)) return false;
    seen.add(field.key);
    return true;
  });
}

export function createPublicFormDefinition(
  source: string,
  workflowName: string,
  summary: string,
): PublicFormDefinition {
  const context = `${source} ${workflowName} ${summary}`.toLowerCase();
  const fields: PublicFormField[] = [
    {
      key: "name",
      label: "Name",
      type: "text",
      placeholder: "Your name",
      required: true,
    },
    {
      key: "email",
      label: "Email address",
      type: "email",
      placeholder: "you@company.com",
      required: true,
    },
  ];

  if (/lead|sales|prospect|client|customer/.test(context)) {
    fields.push({
      key: "company",
      label: "Company",
      type: "text",
      placeholder: "Company name",
      required: false,
    });
  }

  if (/industry|business|market|audience/.test(context)) {
    fields.push({
      key: "industry",
      label: "Industry",
      type: "text",
      placeholder: "e.g. Healthcare, retail, SaaS",
      required: true,
    });
  }

  if (/social|post|content|caption|youtube|video|script/.test(context)) {
    fields.push({
      key: "topic",
      label: "Topic",
      type: "text",
      placeholder: "What should the content be about?",
      required: true,
    });
  }

  fields.push({
    key: /support|question|query|responder|reply|lead/.test(context)
      ? "query"
      : "details",
    label: /support|question|query|responder|reply|lead/.test(context)
      ? "How can we help?"
      : "Details",
    type: "textarea",
    placeholder: "Share the information this automation should process",
    required: true,
  });

  return {
    title: workflowName,
    description: summary,
    fields: uniqueFields(fields).slice(0, 6),
    submitButtonLabel: "Submit response",
    successTitle: "Thank you!",
    successMessage: "Your submission has been processed.",
  };
}

export function getPublicFormDefinition(
  workflow: CompiledWorkflow,
): PublicFormDefinition {
  return (
    workflow.publicForm ??
    createPublicFormDefinition(
      `${workflow.workflowName} ${workflow.summary}`,
      workflow.workflowName,
      workflow.summary,
    )
  );
}

export function getPublicFormPath(workflowId: string): string {
  return `/f/${workflowId}`;
}

export function getPublicFormUrl(workflowId: string, fallbackOrigin = ""): string {
  const siteUrl = resolveSiteOrigin({
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
    fallbackOrigin,
  });
  return `${siteUrl}${getPublicFormPath(workflowId)}`;
}

export type PublicFormSubmissionState =
  | { status: "idle"; message: "" }
  | { status: "error"; message: string }
  | { status: "success"; message: string };
