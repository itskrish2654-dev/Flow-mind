"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { transitionCurrentUserWorkItem } from "@/lib/work-items";
import { EmployeeWorkUpdateSchema } from "@/lib/work-items-core";

export async function updateMyWorkItem(formData: FormData): Promise<void> {
  const parsed = EmployeeWorkUpdateSchema.safeParse({ id: formData.get("id"),
    to: formData.get("to"), reason: formData.get("reason") || null });
  if (!parsed.success) redirect("/my-day?work_item_error=update_failed");
  try {
    await transitionCurrentUserWorkItem(parsed.data.id, parsed.data.to, parsed.data.reason);
  } catch {
    redirect("/my-day?work_item_error=update_failed");
  }
  revalidatePath("/my-day");
  redirect("/my-day");
}
