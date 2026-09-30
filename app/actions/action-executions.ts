"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { createActionApprovalFromAskMessage } from "@/lib/action-executions";

export async function requestAskActionApproval(formData: FormData): Promise<void> {
  const parsed = z.uuid().safeParse(formData.get("messageId"));
  if (!parsed.success) redirect("/ask?action_error=invalid_preview");
  try {
    await createActionApprovalFromAskMessage(parsed.data);
  } catch {
    redirect("/ask?action_error=approval_failed");
  }
  revalidatePath("/ask");
  revalidatePath("/my-day");
  redirect("/my-day?action=pending_approval");
}
