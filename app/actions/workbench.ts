"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { sendAskMessage } from "@/lib/ask";
import { finalizeWorkItemDeliverable, generateWorkItemResult, loadWorkItemWorkbench, saveWorkItemDeliverable } from "@/lib/workbench";
import { transitionCurrentUserWorkItem } from "@/lib/work-items";

const id = z.uuid();
const href = (workItemId: string) => `/my-day/work/${encodeURIComponent(workItemId)}`;

export async function generateWorkbenchAction(formData: FormData): Promise<void> {
  const workItemId = id.safeParse(formData.get("workItemId"));
  if (!workItemId.success) redirect("/my-day");
  let outcome = "generated";
  try {
    const turn = await generateWorkItemResult({ workItemId: workItemId.data, requestKey: formData.get("requestKey"),
      instruction: formData.get("instruction") });
    if (turn.status !== "completed") outcome = turn.status === "failed" ? "ai_failed" : "processing";
  } catch { outcome = "ai_failed"; }
  revalidatePath(href(workItemId.data));
  redirect(`${href(workItemId.data)}?result=${outcome}`);
}

export async function saveWorkbenchResultAction(formData: FormData): Promise<void> {
  const workItemId = id.safeParse(formData.get("workItemId"));
  if (!workItemId.success) redirect("/my-day");
  let outcome = "saved";
  try {
    await saveWorkItemDeliverable({ workItemId: workItemId.data,
      requestKey: formData.get("requestKey"), title: formData.get("title"), content: formData.get("content"),
      aiTurnId: formData.get("aiTurnId") || null, basedOnId: formData.get("basedOnId") || null });
  } catch { outcome = "save_failed"; }
  revalidatePath(href(workItemId.data));
  redirect(`${href(workItemId.data)}?result=${outcome}`);
}

export async function finalizeWorkbenchResultAction(formData: FormData): Promise<void> {
  const workItemId = id.safeParse(formData.get("workItemId"));
  const deliverableId = id.safeParse(formData.get("deliverableId"));
  if (!workItemId.success || !deliverableId.success) redirect("/my-day");
  let outcome = "finalized";
  try { await finalizeWorkItemDeliverable(workItemId.data, deliverableId.data); }
  catch { outcome = "finalize_failed"; }
  revalidatePath(href(workItemId.data));
  redirect(`${href(workItemId.data)}?result=${outcome}`);
}

export async function completeWorkbenchWorkAction(formData: FormData): Promise<void> {
  const workItemId = id.safeParse(formData.get("workItemId"));
  if (!workItemId.success) redirect("/my-day");
  let outcome = "completed";
  try {
    const work = await loadWorkItemWorkbench(workItemId.data);
    if (!work.deliverables.some((result) => result.status === "final")) throw new Error("No final result");
    await transitionCurrentUserWorkItem(workItemId.data, "done");
  }
  catch { outcome = "complete_failed"; }
  revalidatePath("/my-day");
  revalidatePath(href(workItemId.data));
  redirect(`${href(workItemId.data)}?result=${outcome}`);
}

/** Handoff to the existing Ask preview path; this never sends an email itself. */
export async function prepareWorkbenchEmailAction(formData: FormData): Promise<void> {
  const workItemId = id.safeParse(formData.get("workItemId"));
  if (!workItemId.success) redirect("/my-day");
  const email = z.email().safeParse(formData.get("recipient"));
  const body = z.string().trim().min(1).max(450).safeParse(formData.get("body"));
  if (!email.success || !body.success) redirect(`${href(workItemId.data)}?result=email_failed`);
  const work = await loadWorkItemWorkbench(workItemId.data).catch(() => null);
  if (!work?.deliverables.some((result) => result.status === "final")) {
    redirect(`${href(workItemId.data)}?result=email_failed`);
  }
  const result = await sendAskMessage({ requestId: randomUUID(),
    message: `Send an email to ${email.data} saying ${body.data}` });
  if (result.ok && result.threadId) redirect(`/ask?thread=${encodeURIComponent(result.threadId)}`);
  redirect(`${href(workItemId.data)}?result=email_failed`);
}
