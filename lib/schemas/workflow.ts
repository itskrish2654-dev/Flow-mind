import { z } from "zod";

export const StepInputSchema = z.object({
  key: z.string(),
  label: z.string().min(1),
  type: z.enum(["text", "url", "secret"]),
  placeholder: z.string().optional(),
  value: z.string().optional(),
  helpText: z.string().min(1).optional(),
  howToGetIt: z.string().min(1).optional(),
});

export const PublicFormFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
  label: z.string().min(1).max(80),
  type: z.enum(["text", "email", "url", "textarea"]),
  placeholder: z.string().max(160).optional(),
  required: z.boolean().default(true),
});

export const PublicFormDefinitionSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(300),
  fields: z.array(PublicFormFieldSchema).min(1).max(10),
});

export const WorkflowStepSchema = z.object({
  id: z.string(),
  type: z.enum([
    "webhook_trigger",
    "ai_transform",
    "http_request",
    "filter_condition",
  ]),
  title: z.string(),
  description: z.string(),
  inputsRequired: z.array(StepInputSchema).optional(),
  config: z
    .object({
      endpoint: z.string().optional(),
      method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional(),
      transformPrompt: z.string().optional(),
    })
    .optional(),
});

export const CompiledWorkflowSchema = z.object({
  workflowName: z.string(),
  summary: z.string(),
  steps: z.array(WorkflowStepSchema),
  publicForm: PublicFormDefinitionSchema.optional(),
});

export type CompiledWorkflow = z.infer<typeof CompiledWorkflowSchema>;
export type StepInput = z.infer<typeof StepInputSchema>;
export type PublicFormDefinition = z.infer<typeof PublicFormDefinitionSchema>;
export type PublicFormField = z.infer<typeof PublicFormFieldSchema>;
