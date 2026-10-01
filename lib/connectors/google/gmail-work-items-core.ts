import { createHash } from "node:crypto";

export type GmailWorkClassification = "ACTIONABLE" | "INFORMATIONAL" | "UNCERTAIN";

/** Retry of one message is a duplicate; a later request in the same thread is new work. */
export function gmailWorkItemDedupeKey(threadId: string, messageId: string): string {
  const validId = /^[A-Za-z0-9_-]{1,200}$/;
  if (!validId.test(messageId) || (threadId && !validId.test(threadId))) {
    throw new Error("Gmail message identity is invalid.");
  }
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  return `gmail-thread:${digest(threadId || messageId)}:${digest(messageId)}`;
}

const ACTIONABLE = /\b(?:action required|(?:your|you[r']?re)\s+(?:approval|decision|response|reply)\s+(?:is\s+)?(?:needed|required)|can you|could you|would you|please\s+(?:review|respond|reply|send|confirm|approve|check|share|provide|update|sign|complete)|need\s+you\s+to\s+(?:review|respond|reply|send|confirm|approve|check|share|provide|update|sign|complete))\b/i;
const INFORMATIONAL = /\b(?:newsletter|unsubscribe|receipt|automated notification|no[- ]?reply|for your information|fyi)\b/i;

/** Conservative and explainable: uncertainty never creates employee work. */
export function classifyGmailWork(message: { subject: string; text: string; from: string }): GmailWorkClassification {
  // Quoted conversations and signatures often contain old requests. Only the
  // current, bounded lead text may create new work for the employee.
  const lead = message.text.split(/\n\s*(?:On .+ wrote:|From:\s|>{1,2}\s)/i, 1)[0];
  const text = `${message.subject}\n${lead}`.slice(0, 2_000);
  if (INFORMATIONAL.test(text) || /no[-_.]?reply@/i.test(message.from)) return "INFORMATIONAL";
  if (ACTIONABLE.test(text)) return "ACTIONABLE";
  return "UNCERTAIN";
}
