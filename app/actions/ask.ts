"use server";

import { revalidatePath } from "next/cache";
import { getAuthenticatedContext } from "@/lib/auth";
import { trackProductEvent } from "@/lib/observability";

import {
  getAskMessageStatus,
  retryAskMessage,
  sendAskMessage,
  type SendAskResult,
} from "@/lib/ask";

export async function submitAskMessage(input: {
  requestId: string;
  threadId?: string;
  message: string;
}): Promise<SendAskResult> {
  const result = await sendAskMessage(input);
  if (result.ok) {
    const auth = await getAuthenticatedContext();
    if (auth) await trackProductEvent({ event: "ask_used", userId: auth.user.id });
  }
  revalidatePath("/ask");
  return result;
}

export async function checkAskMessageStatus(input: {
  requestId: string;
  threadId?: string;
}): Promise<SendAskResult> {
  const result = await getAskMessageStatus(input);
  revalidatePath("/ask");
  return result;
}

export async function retryAskMessageAction(input: {
  requestId: string;
  threadId?: string;
}): Promise<SendAskResult> {
  const result = await retryAskMessage(input);
  revalidatePath("/ask");
  return result;
}
