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
});

export type CompiledWorkflow = z.infer<typeof CompiledWorkflowSchema>;
export type StepInput = z.infer<typeof StepInputSchema>;
