import { z } from "zod";

import {
  ApprovalActionParameterSchema,
  ApprovalActionSnapshotSchema,
  ApprovalActionTargetSchema,
} from "@/lib/approvals-core";

const sensitiveName = /(?:secret|password|passwd|token|credential|api[_-]?key|authorization|cookie|private[_-]?key)/i;
const sensitiveValue = /(?:\bBearer\s+\S+|sb_secret_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

export const ActionPreviewSchema = z.object({
  version: z.literal(1),
  capabilityId: z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/),
  connectorId: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  operationKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  operationVersion: z.number().int().positive(),
  connectionId: z.uuid(),
  actionTitle: z.string().trim().min(1).max(180),
  actionSummary: z.string().trim().min(1).max(2_000),
  approvalReason: z.string().trim().min(1).max(1_000),
  target: ApprovalActionTargetSchema,
  parameters: z.array(ApprovalActionParameterSchema).max(12),
}).strict().superRefine((value, context) => {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).length > 8_192 || sensitiveValue.test(serialized)) {
    context.addIssue({ code: "custom", message: "Action preview cannot contain credential material." });
  }
  for (const parameter of value.parameters) {
    if (sensitiveName.test(parameter.name) || sensitiveName.test(parameter.label) || sensitiveValue.test(parameter.value)) {
      context.addIssue({ code: "custom", message: "Action preview cannot contain credential material." });
      break;
    }
  }
});

export type ActionPreview = z.infer<typeof ActionPreviewSchema>;

export const ActionExecutionStatusSchema = z.enum([
  "pending_approval", "queued", "executing", "succeeded", "failed", "ambiguous", "rejected", "cancelled",
]);
export type ActionExecutionStatus = z.infer<typeof ActionExecutionStatusSchema>;

export function approvalSnapshotFromPreview(preview: ActionPreview) {
  return ApprovalActionSnapshotSchema.parse({
    version: 1,
    operationKey: preview.capabilityId,
    target: preview.target,
    parameters: preview.parameters,
  });
}

export function actionOutcomeSummary(status: ActionExecutionStatus): string {
  switch (status) {
    case "succeeded": return "The provider acknowledged the exact approved action.";
    case "failed": return "The approved action failed and needs attention.";
    case "ambiguous": return "CrazyLoops could not confirm whether the provider completed the action. Review it before retrying.";
    case "queued": return "The action is approved and waiting to execute.";
    case "executing": return "The approved action is executing.";
    case "rejected": return "The action was rejected and was not executed.";
    case "cancelled": return "The action was cancelled and was not executed.";
    default: return "The action is waiting for approval. Nothing has been sent yet.";
  }
}

export function isTerminalActionStatus(status: ActionExecutionStatus) {
  return ["succeeded", "failed", "ambiguous", "rejected", "cancelled"].includes(status);
}

export function actionApprovalDisposition(
  status: ActionExecutionStatus,
  decision: "approved" | "rejected",
): "decide" | "resume_queued" | "already_decided" {
  if (status === "pending_approval") return "decide";
  // An approved action can be resumed after an interrupted request. The
  // database claim still permits only one provider execution.
  if (status === "queued" && decision === "approved") return "resume_queued";
  return "already_decided";
}
