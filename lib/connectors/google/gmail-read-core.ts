const QUERY_STOP_WORDS = new Set([
  "a", "about", "any", "did", "do", "email", "emails", "from", "gmail", "in", "inbox",
  "is", "latest", "mail", "me", "message", "messages", "my", "recent", "said", "say", "the",
  "thread", "to", "what", "who",
]);

export const MAX_GMAIL_MESSAGE_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_GMAIL_LIST_RESPONSE_BYTES = 128 * 1024;

/** Gmail attachment bytes are fetched separately; API JSON still needs a hard read limit. */
async function readBoundedGmailJson(response: Response, maximumBytes: number): Promise<Record<string, unknown>> {
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error("Gmail message exceeded the safe read limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Gmail message body was unavailable.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("Gmail message exceeded the safe read limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("Gmail returned an invalid message.");
  }
}

export function readBoundedGmailMessagePayload(response: Response): Promise<Record<string, unknown>> {
  return readBoundedGmailJson(response, MAX_GMAIL_MESSAGE_RESPONSE_BYTES);
}

export function readBoundedGmailListPayload(response: Response): Promise<Record<string, unknown>> {
  return readBoundedGmailJson(response, MAX_GMAIL_LIST_RESPONSE_BYTES);
}

export function gmailSearchQuery(question: string): string {
  const terms = question
    .toLowerCase()
    .replace(/[^a-z0-9@._+-]+/g, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 2 && !QUERY_STOP_WORDS.has(term))
    .slice(0, 6)
    .map((term) => term.replace(/[{}()[\]"]/g, ""))
    .filter(Boolean);
  return ["in:inbox", "newer_than:30d", ...terms].join(" ").slice(0, 500);
}
