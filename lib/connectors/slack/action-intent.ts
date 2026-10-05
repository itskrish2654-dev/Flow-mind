export type SlackSendIntent = { channelName: string; text: string } | "clarification" | null;
export type SlackReplyIntent = { channelName: string; threadTs: string; text: string } | "clarification" | null;

/** Thread replies need an explicit parent timestamp; never infer a target from retrieved text. */
export function parseSlackReplyIntent(question: string): SlackReplyIntent {
  const trimmed = question.trim();
  if (!/^(?:please\s+)?reply\b/i.test(trimmed)) return null;
  if (!/#\w+|\bslack\b|\bchannel\b/i.test(trimmed)) return null;
  const match = trimmed.match(/^(?:please\s+)?reply\s+in\s+#([a-z0-9_-]{1,80})\s+to\s+thread\s+(\d{10,20}\.\d{1,10})\s+(?:with|saying|that|:)\s+([\s\S]+)$/i);
  if (!match) return "clarification";
  const text = match[3].trim();
  if (!text || text.length > 2_000 || /[\u0000-\u001f\u007f]/.test(text)) return "clarification";
  return { channelName: match[1].toLowerCase(), threadTs: match[2], text };
}

/** Only the authenticated employee's direct instruction can propose a send. */
export function parseSlackSendIntent(question: string): SlackSendIntent {
  const trimmed = question.trim();
  if (!/^(?:please\s+)?(?:tell|post|send|notify)\b/i.test(trimmed)) return null;
  if (!/#\w+|\bslack\b|\bchannel\b/i.test(trimmed)) return null;
  const match = trimmed.match(/^(?:please\s+)?(?:tell|notify|post(?:\s+(?:a\s+)?message)?\s+to|send(?:\s+(?:a\s+)?message)?\s+to)\s+#([a-z0-9_-]{1,80})\s+(?:that|saying|with|:)\s+([\s\S]+)$/i);
  if (!match) return "clarification";
  const text = match[2].trim();
  if (!text || text.length > 2_000 || /[\u0000-\u001f\u007f]/.test(text)) return "clarification";
  return { channelName: match[1].toLowerCase(), text };
}
