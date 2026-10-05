import { createHash } from "node:crypto";

export type SlackWorkClassification = "ACTIONABLE" | "INFORMATIONAL" | "UNCERTAIN";

const DIRECT_REQUEST = /\b(?:can you|could you|would you|please\s+(?:review|reply|respond|confirm|check|share|provide|update|send|approve)|need you to\s+(?:review|reply|respond|confirm|check|share|provide|update|send|approve)|your (?:review|reply|response|approval|decision) (?:is )?(?:needed|required))\b/i;
const INFORMATIONAL = /\b(?:fyi|for your information|no action needed|automated notification)\b/i;
const INSTRUCTION_ATTACK = /\b(?:ignore (?:all |your )?(?:previous |prior )?instructions|system prompt|developer instructions|reveal (?:a |the )?(?:secret|token|password))\b/i;

/** An owner-scoped Slack connection is not proof that every channel request is for its owner. */
export function classifySlackWork(text: string, installingUserId: string | null): SlackWorkClassification {
  if (!installingUserId || !/^[UW][A-Z0-9]{7,20}$/.test(installingUserId)) return "UNCERTAIN";
  const lead = text.split(/\n\s*(?:>|On .+ wrote:|From:)/i, 1)[0].slice(0, 2_000);
  if (INFORMATIONAL.test(lead) || INSTRUCTION_ATTACK.test(lead)) return "INFORMATIONAL";
  if (!lead.includes(`<@${installingUserId}>`)) return "UNCERTAIN";
  return DIRECT_REQUEST.test(lead) ? "ACTIONABLE" : "UNCERTAIN";
}

export function slackWorkItemDedupeKey(eventId: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(eventId)) throw new Error("Slack event identity is invalid.");
  return `slack-event:${createHash("sha256").update(eventId).digest("hex")}`;
}
