import { z } from "zod";

export const StepInputSchema = z.object({
  key: z.string(),
  label: z.string().min(1),
  type: z.enum(["text", "url", "secret"]),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  value: z.string().optional(),
  helpText: z.string().min(1).optional(),
  howToGetIt: z.string().min(1).optional(),
});

export const PublicFormFieldTypeSchema = z.enum([
  "text",
  "email",
  "phone",
  "number",
  "date",
  "url",
  "textarea",
  "select",
  "checkbox",
]);

export const PublicFormFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
    label: z.string().min(1).max(80),
    type: PublicFormFieldTypeSchema,
    placeholder: z.string().max(160).optional(),
    helpText: z.string().max(240).optional(),
    required: z.boolean().default(true),
    options: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    minLength: z.number().int().min(0).max(5_000).optional(),
    maxLength: z.number().int().min(1).max(5_000).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .superRefine((field, context) => {
    if (field.type === "select" && (!field.options || field.options.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "Select fields need at least one option.",
        path: ["options"],
      });
    }
    if (
      field.type === "select" &&
      field.options &&
      new Set(field.options).size !== field.options.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Dropdown options must be unique.",
        path: ["options"],
      });
    }
    if (
      field.minLength !== undefined &&
      field.maxLength !== undefined &&
      field.minLength > field.maxLength
    ) {
      context.addIssue({
        code: "custom",
        message: "Minimum length cannot be greater than maximum length.",
        path: ["minLength"],
      });
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      context.addIssue({
        code: "custom",
        message: "Minimum value cannot be greater than maximum value.",
        path: ["min"],
      });
    }
  });

export const PublicFormDefinitionSchema = z
  .object({
    title: z.string().min(1).max(120),
    description: z.string().max(300),
    fields: z.array(PublicFormFieldSchema).min(1).max(10),
    submitButtonLabel: z.string().min(1).max(60).default("Submit response"),
    successTitle: z.string().min(1).max(100).default("Thank you!"),
    successMessage: z
      .string()
      .min(1)
      .max(240)
      .default("Your submission has been processed."),
  })
  .superRefine((form, context) => {
    if (new Set(form.fields.map((field) => field.key)).size !== form.fields.length) {
      context.addIssue({
        code: "custom",
        message: "Every form field needs a unique variable key.",
        path: ["fields"],
      });
    }
  });

export const DataTableColumnSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  label: z.string().min(1).max(80),
  source: z.enum(["input", "output"]),
});

export const DataTableDefinitionSchema = z
  .object({
    columns: z.array(DataTableColumnSchema).min(1).max(10),
  })
  .superRefine((table, context) => {
    const identifiers = table.columns.map(
      (column) => `${column.source}:${column.key}`,
    );
    if (new Set(identifiers).size !== identifiers.length) {
      context.addIssue({
        code: "custom",
        message: "Every data column must be unique.",
        path: ["columns"],
      });
    }
  });

const FormatterSourceSchema = z.object({
  kind: z.enum(["trigger", "step", "literal", "ai"]),
  path: z.string().max(200).optional(),
  stepId: z.string().max(100).optional(),
  value: z.unknown().optional(),
});

export const FormatterConfigSchema = z.object({
  version: z.literal(1),
  operation: z.enum([
    "trim", "uppercase", "lowercase", "title_case", "replace", "split", "join",
    "prepend", "append", "add", "subtract", "multiply", "divide", "round",
    "format_date", "add_duration", "subtract_duration", "convert_timezone",
    "default_value", "first_non_empty",
  ]),
  source: FormatterSourceSchema,
  sources: z.array(FormatterSourceSchema).max(10).optional(),
  outputKey: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  find: z.string().max(500).optional(),
  replacement: z.string().max(500).optional(),
  separator: z.string().max(100).optional(),
  value: z.unknown().optional(),
  operand: z.number().finite().optional(),
  decimalPlaces: z.number().int().min(0).max(12).optional(),
  dateFormat: z.string().min(1).max(40).optional(),
  timezone: z.string().min(1).max(100).optional(),
  durationAmount: z.number().int().min(-5_256_000).max(5_256_000).optional(),
  durationUnit: z.enum(["minutes", "hours", "days"]).optional(),
});

export const HttpRequestConfigSchema = z.object({
  version: z.literal(2),
  url: z.string().url().max(2_048),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  query: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  timeoutMs: z.number().int().min(1_000).max(15_000).optional(),
  authType: z.enum(["none", "bearer", "basic", "api_key_header", "api_key_query"]).default("none"),
  authUsername: z.string().max(200).optional(),
  authName: z.string().max(120).optional(),
  idempotencyHeader: z.enum(["Idempotency-Key", "X-Idempotency-Key"]).optional(),
  allowDeleteBody: z.boolean().optional(),
});

export const WorkflowStepSchema = z.object({
  id: z.string(),
  type: z.enum([
    "public_form_trigger",
    "webhook_trigger",
    "ai_transform",
    "formatter_transform",
    "store_data",
    "webhook_post",
    "http_request",
    "generate_pdf",
    "filter_condition",
    "connector_trigger",
    "connector_action",
    "scheduled_trigger",
  ]),
  capabilityId: z.string().min(1).max(80).optional(),
  capabilityStatus: z.enum(["supported", "test_only", "unsupported"]).optional(),
  capabilityMessage: z.string().max(300).optional(),
  executor: z
    .object({
      kind: z.enum(["native", "activepieces"]),
      capabilityVersion: z.number().int().positive(),
    })
    .optional(),
  title: z.string(),
  description: z.string(),
  inputsRequired: z.array(StepInputSchema).optional(),
  config: z
    .object({
      endpoint: z.string().optional(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      transformPrompt: z.string().optional(),
      formatter: FormatterConfigSchema.optional(),
      http: HttpRequestConfigSchema.optional(),
      documentTemplate: z.string().max(50_000).optional(),
      schedule: z
        .object({
          kind: z.enum([
            "hourly",
            "interval_hours",
            "daily",
            "weekday",
            "weekly",
            "monthly",
            "once",
          ]),
          timezone: z.string().min(1).max(100),
          localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
          intervalHours: z.number().int().min(2).max(168).optional(),
          weekday: z.number().int().min(1).max(7).optional(),
          dayOfMonth: z.number().int().min(1).max(28).optional(),
          runAt: z.string().datetime({ offset: true }).optional(),
          humanLabel: z.string().min(1).max(160),
        })
        .optional(),
      condition: z
        .object({
          sourcePath: z.string().min(1).max(160),
          operator: z.enum([
            "equals",
            "not_equals",
            "contains",
            "not_contains",
            "exists",
            "not_exists",
            "greater_than",
            "less_than",
            "is_true",
            "is_false",
          ]),
          expectedValue: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
          humanLabel: z.string().min(1).max(240),
        })
        .optional(),
      branch: z
        .object({
          conditionStepId: z.string().min(1).max(100),
          when: z.enum(["true", "false"]),
        })
        .optional(),
      connector: z
        .object({
          connectorId: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/),
          operationKind: z.enum(["trigger", "action"]),
          operationKey: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
          operationVersion: z.number().int().positive(),
          connectionId: z.string().uuid().optional(),
          mappings: z
            .array(
              z.object({
                target: z.string().min(1).max(80),
                source: z.object({
                  kind: z.enum(["trigger", "step", "literal", "ai"]),
                  path: z.string().max(200).optional(),
                  stepId: z.string().max(100).optional(),
                  value: z.unknown().optional(),
                }),
              }),
            )
            .max(50)
            .default([]),
          settings: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    })
    .optional(),
});

export const CompiledWorkflowSchema = z.object({
  workflowName: z.string(),
  summary: z.string(),
  steps: z.array(WorkflowStepSchema).min(1).max(10),
  publicForm: PublicFormDefinitionSchema.optional(),
  dataTable: DataTableDefinitionSchema.optional(),
});

export type CompiledWorkflow = z.infer<typeof CompiledWorkflowSchema>;
export type StepInput = z.infer<typeof StepInputSchema>;
export type PublicFormDefinition = z.infer<typeof PublicFormDefinitionSchema>;
export type PublicFormField = z.infer<typeof PublicFormFieldSchema>;
export type PublicFormFieldType = z.infer<typeof PublicFormFieldTypeSchema>;
export type DataTableColumn = z.infer<typeof DataTableColumnSchema>;
export type DataTableDefinition = z.infer<typeof DataTableDefinitionSchema>;
export type HttpRequestConfig = z.infer<typeof HttpRequestConfigSchema>;
