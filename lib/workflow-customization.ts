import type {
  CompiledWorkflow,
  DataTableColumn,
  DataTableDefinition,
  PublicFormDefinition,
} from "@/lib/schemas/workflow";

export type WorkflowVariable = {
  token: string;
  label: string;
  group: "Form" | "AI" | "Document";
  sample: string;
};

const OUTPUT_COLUMNS: DataTableColumn[] = [
  { key: "status", label: "Status", source: "output" },
  { key: "ai_result", label: "AI result", source: "output" },
  { key: "pdf_url", label: "PDF", source: "output" },
];

export function availableDataTableColumns(
  form: PublicFormDefinition,
): DataTableColumn[] {
  return [
    ...form.fields.map((field) => ({
      key: field.key,
      label: field.label,
      source: "input" as const,
    })),
    ...OUTPUT_COLUMNS,
  ];
}

export function createDefaultDataTableDefinition(
  form: PublicFormDefinition,
): DataTableDefinition {
  return {
    columns: [
      ...availableDataTableColumns(form).filter((column) => column.source === "input"),
      ...OUTPUT_COLUMNS.slice(0, 2),
    ].slice(0, 10),
  };
}

export function getDataTableDefinition(
  workflow: CompiledWorkflow,
): DataTableDefinition {
  if (workflow.dataTable && workflow.publicForm) {
    const available = new Set(
      availableDataTableColumns(workflow.publicForm).map(
        (column) => `${column.source}:${column.key}`,
      ),
    );
    const columns = workflow.dataTable.columns.filter((column) =>
      available.has(`${column.source}:${column.key}`),
    );
    if (columns.length > 0) return { columns };
    return createDefaultDataTableDefinition(workflow.publicForm);
  }
  if (workflow.dataTable) return workflow.dataTable;
  if (workflow.publicForm) return createDefaultDataTableDefinition(workflow.publicForm);
  return { columns: OUTPUT_COLUMNS.slice(0, 2) };
}

export function workflowVariables(
  form: PublicFormDefinition | undefined,
): WorkflowVariable[] {
  const formVariables: WorkflowVariable[] = (form?.fields ?? []).map((field) => ({
    token: `{{trigger.${field.key}}}`,
    label: field.label,
    group: "Form",
    sample:
      field.type === "email"
        ? "alex@example.com"
        : field.type === "number"
          ? "25"
          : field.type === "date"
            ? "2026-08-10"
            : field.type === "checkbox"
              ? "Yes"
              : field.placeholder || field.label,
  }));

  return [
    ...formVariables,
    {
      token: "{{ai.summary}}",
      label: "AI summary",
      group: "AI",
      sample: "A concise AI-generated summary of the submission.",
    },
    {
      token: "{{ai.result}}",
      label: "Complete AI result",
      group: "AI",
      sample: "The complete result created by the AI step.",
    },
    {
      token: "{{workflow.name}}",
      label: "Workflow name",
      group: "Document",
      sample: "Customer workflow",
    },
  ];
}

export function previewDocumentTemplate(
  template: string,
  variables: WorkflowVariable[],
): string {
  const samples = new Map(variables.map((variable) => [variable.token, variable.sample]));
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (token) => {
    const normalized = token.replace(/\s/g, "");
    return samples.get(normalized) ?? "";
  });
}
