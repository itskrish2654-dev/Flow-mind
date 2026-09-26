"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { transitionCurrentUserWorkItem } from "@/lib/work-items";

const ActionSchema = z.object({
  id: z.uuid(),
  to: z.enum(["needs_you", "waiting", "done"]),
});

export async function updateMyWorkItem(formData: FormData): Promise<void> {
  const parsed = ActionSchema.safeParse({ id: formData.get("id"), to: formData.get("to") });
  if (!parsed.success) redirect("/my-day?work_item_error=update_failed");
  try {
    await transitionCurrentUserWorkItem(parsed.data.id, parsed.data.to);
  } catch {
    redirect("/my-day?work_item_error=update_failed");
  }
  revalidatePath("/my-day");
  redirect("/my-day");
}
