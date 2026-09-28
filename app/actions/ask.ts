"use server";

import { revalidatePath } from "next/cache";

import { sendAskMessage, type SendAskResult } from "@/lib/ask";

export async function submitAskMessage(input: {
  threadId?: string;
  message: string;
}): Promise<SendAskResult> {
  const result = await sendAskMessage(input);
  revalidatePath("/ask");
  return result;
}
