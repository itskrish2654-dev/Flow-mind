import type { AskSubmissionResult } from "@/lib/ask-reliability";

export type AskClientSubmission = {
  requestId: string;
  question: string;
  threadId: string | null;
};

export function createAskClientSubmission(
  question: string,
  threadId: string | null,
  createId: () => string = () => crypto.randomUUID(),
): AskClientSubmission {
  return { requestId: createId(), question, threadId };
}

export async function performAskClientSubmission(
  pending: AskClientSubmission,
  submit: (input: { requestId: string; threadId?: string; message: string }) => Promise<AskSubmissionResult>,
): Promise<{ kind: "result"; result: AskSubmissionResult } | { kind: "network_error"; pending: AskClientSubmission }> {
  try {
    const result = await submit({
      requestId: pending.requestId,
      ...(pending.threadId ? { threadId: pending.threadId } : {}),
      message: pending.question,
    });
    return { kind: "result", result };
  } catch {
    return { kind: "network_error", pending };
  }
}

export function shouldApplyAskResult(
  pending: AskClientSubmission,
  currentThreadId: string | null,
  result: AskSubmissionResult,
): boolean {
  if (result.requestId !== pending.requestId) return false;
  if (pending.threadId) return currentThreadId === pending.threadId;
  return currentThreadId === null || currentThreadId === result.threadId;
}
