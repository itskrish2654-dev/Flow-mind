"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { decideCurrentUserApproval } from "@/lib/approvals";
import { decideAndExecuteCurrentUserAction } from "@/lib/action-executions";
import { getAuthenticatedContext } from "@/lib/auth";
import { trackProductEvent } from "@/lib/observability";

const ApprovalActionSchema = z.object({
  id: z.uuid(),
  decision: z.enum(["approved", "rejected"]),
  rejectionReason: z.string().trim().max(500).optional(),
}).strict();

export async function decideMyApproval(formData: FormData): Promise<void> {
  const parsed = ApprovalActionSchema.safeParse({
    id: formData.get("id"),
    decision: formData.get("decision"),
    rejectionReason: formData.get("rejectionReason") ?? undefined,
  });
  if (!parsed.success) redirect("/my-day?approval_error=decision_failed");
  try {
    const action = await decideAndExecuteCurrentUserAction({
      approvalId: parsed.data.id,
      decision: parsed.data.decision,
      rejectionReason: parsed.data.decision === "rejected" ? parsed.data.rejectionReason || null : null,
    });
    if (!action) {
      await decideCurrentUserApproval({
        id: parsed.data.id,
        decision: parsed.data.decision,
        rejectionReason: parsed.data.decision === "rejected" ? parsed.data.rejectionReason || null : null,
      });
    }
    if (action && parsed.data.decision === "approved") {
      const auth = await getAuthenticatedContext();
      if (auth) {
        await trackProductEvent({ event: "external_action_approved", userId: auth.user.id });
        if (action.status === "succeeded" && action.acknowledged && action.externally_delivered) {
          await trackProductEvent({ event: "external_action_executed", userId: auth.user.id });
        }
      }
    }
  } catch {
    redirect("/my-day?approval_error=decision_failed");
  }
  revalidatePath("/my-day");
  redirect("/my-day");
}
