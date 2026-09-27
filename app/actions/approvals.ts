"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { decideCurrentUserApproval } from "@/lib/approvals";

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
    await decideCurrentUserApproval({
      id: parsed.data.id,
      decision: parsed.data.decision,
      rejectionReason: parsed.data.decision === "rejected" ? parsed.data.rejectionReason || null : null,
    });
  } catch {
    redirect("/my-day?approval_error=decision_failed");
  }
  revalidatePath("/my-day");
  redirect("/my-day");
}
