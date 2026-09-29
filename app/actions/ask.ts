"use server";

import { revalidatePath } from "next/cache";

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
