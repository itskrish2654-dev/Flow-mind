import { parseGmailRecipients, requireGmailBody, safeGmailHeader } from "@/lib/connectors/google/gmail-message";

export type GmailSendIntent = {
  kind: "send";
  fromAccount?: string;
  to: string;
  subject: string;
  body: string;
};

export function parseGmailSendIntent(question: string): GmailSendIntent | "clarification" | null {
  const prefaced = question.match(/^\s*(?:using|from)\s+([^\s,;]+@[^\s,;]+)\s*,\s*([\s\S]+)$/i);
  const request = prefaced?.[2] ?? question;
  if (!/^\s*(?:please\s+)?(?:send\s+(?:an?\s+)?email\s+to|email)\b/i.test(request)) return null;
  const match = request.match(/^\s*(?:please\s+)?(?:send\s+(?:an?\s+)?email\s+to|email)\s+([^\s,;]+@[^\s,;]+)\s+(?:that|saying|with(?:\s+the)?\s+(?:message|body))\s+([\s\S]+?)\s*$/i);
  if (!match) return "clarification";
  try {
    const to = parseGmailRecipients({ to: match[1] }).to[0];
    const fromAccount = prefaced ? parseGmailRecipients({ to: prefaced[1] }).to[0] : undefined;
    const body = requireGmailBody(match[2].trim());
    // Approval snapshots cap each parameter at 500 characters. Reject here rather
    // than letting an otherwise valid Ask turn fail while building its preview.
    if (body.length > 500) return "clarification";
    const firstLine = body.split(/[.!?\n]/, 1)[0].trim();
    const subject = safeGmailHeader(firstLine || "Message from CrazyLoops", "Subject", { maxBytes: 512 }).slice(0, 120);
    return { kind: "send", ...(fromAccount ? { fromAccount } : {}), to, subject, body };
  } catch {
    return "clarification";
  }
}
