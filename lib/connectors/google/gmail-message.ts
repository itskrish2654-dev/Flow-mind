const MAX_GMAIL_TEXT = 64 * 1024;

function decodeBase64Url(value?: string) {
  if (!value) return "";
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export function htmlToSafeText(html: string) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
};

function collectParts(
  part: GmailPart,
  text: string[],
  html: string[],
  attachments: Array<Record<string, unknown>>,
) {
  if (part.filename && part.body?.attachmentId) {
    attachments.push({
      filename: part.filename.slice(0, 255),
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body.size ?? 0,
      attachmentId: part.body.attachmentId,
    });
  }
  if (part.mimeType === "text/plain" && part.body?.data) text.push(decodeBase64Url(part.body.data));
  if (part.mimeType === "text/html" && part.body?.data) html.push(htmlToSafeText(decodeBase64Url(part.body.data)));
  for (const child of part.parts ?? []) collectParts(child, text, html, attachments);
}

export function gmailHeader(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
) {
  return headers
    ?.find((item) => item.name?.toLowerCase() === name.toLowerCase())
    ?.value?.slice(0, 2_000) ?? "";
}

export function normalizeGmailMessage(payload: Record<string, unknown>) {
  const body = (payload.payload && typeof payload.payload === "object"
    ? payload.payload
    : {}) as GmailPart & { headers?: Array<{ name?: string; value?: string }> };
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: Array<Record<string, unknown>> = [];
  collectParts(body, plain, html, attachments);
  const text = (plain.join("\n\n").trim() || html.join("\n\n").trim()).slice(0, MAX_GMAIL_TEXT);
  const internalDate = Number(payload.internalDate);
  return {
    message: {
      id: String(payload.id ?? ""),
      threadId: String(payload.threadId ?? ""),
      from: gmailHeader(body.headers, "From"),
      to: gmailHeader(body.headers, "To"),
      cc: gmailHeader(body.headers, "Cc"),
      subject: gmailHeader(body.headers, "Subject"),
      text,
      receivedAt: Number.isFinite(internalDate)
        ? new Date(internalDate).toISOString()
        : new Date().toISOString(),
      labels: Array.isArray(payload.labelIds) ? payload.labelIds.map(String).slice(0, 100) : [],
      attachments,
    },
  };
}

export function buildRawGmailMessage(input: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
}) {
  const lines = [`To: ${input.to.join(", ")}`];
  if (input.cc?.length) lines.push(`Cc: ${input.cc.join(", ")}`);
  if (input.bcc?.length) lines.push(`Bcc: ${input.bcc.join(", ")}`);
  lines.push(`Subject: ${input.subject}`);
  if (input.messageId) lines.push(`Message-ID: ${input.messageId}`);
  lines.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit");
  if (input.inReplyTo) lines.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references) lines.push(`References: ${input.references}`);
  lines.push("", input.body.slice(0, 200_000));
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}
