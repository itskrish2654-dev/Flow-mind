import { createHash } from "node:crypto";

const MAX_GMAIL_TEXT = 64 * 1024;

export const MAX_GMAIL_RECIPIENTS = 50;
export const MAX_GMAIL_RECIPIENT_HEADER_BYTES = 8 * 1024;
export const MAX_GMAIL_HEADER_VALUE_BYTES = 900;
export const MAX_GMAIL_SUBJECT_BYTES = 512;
export const MAX_GMAIL_BODY_BYTES = 128 * 1024;
export const MAX_GMAIL_MIME_BYTES = 160 * 1024;

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const GMAIL_RESOURCE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const MESSAGE_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;

export class GmailMessageValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GmailMessageValidationError";
  }
}

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function recipientList(value: unknown, label: string): string[] {
  if (value === undefined || value === null || value === "") return [];
  const values = typeof value === "string"
    ? [value]
    : Array.isArray(value) && value.every((item) => typeof item === "string")
      ? value
      : null;
  if (!values) {
    throw new GmailMessageValidationError(
      "GMAIL_RECIPIENT_INVALID",
      `${label} recipients must be email addresses.`,
    );
  }
  const result: string[] = [];
  for (const valuePart of values) {
    if (/\r|\n|\0/.test(valuePart)) {
      throw new GmailMessageValidationError(
        "GMAIL_RECIPIENT_INVALID",
        `${label} recipients contain an invalid value.`,
      );
    }
    const parts = valuePart.split(",");
    if (parts.some((part) => !part.trim())) {
      throw new GmailMessageValidationError(
        "GMAIL_RECIPIENT_INVALID",
        `${label} recipients contain an invalid value.`,
      );
    }
    for (const part of parts) {
      const address = part.trim();
      if (utf8Bytes(address) > 254 || !EMAIL.test(address)) {
        throw new GmailMessageValidationError(
          "GMAIL_RECIPIENT_INVALID",
          `${label} recipients must be valid email addresses.`,
        );
      }
      result.push(address);
    }
  }
  return result;
}

export function parseGmailRecipients(input: {
  to: unknown;
  cc?: unknown;
  bcc?: unknown;
}) {
  const to = recipientList(input.to, "To");
  const cc = recipientList(input.cc, "Cc");
  const bcc = recipientList(input.bcc, "Bcc");
  const total = to.length + cc.length + bcc.length;
  if (to.length === 0 || total === 0) {
    throw new GmailMessageValidationError(
      "GMAIL_RECIPIENT_REQUIRED",
      "At least one To recipient is required.",
    );
  }
  if (total > MAX_GMAIL_RECIPIENTS) {
    throw new GmailMessageValidationError(
      "GMAIL_RECIPIENT_LIMIT",
      `Gmail actions support at most ${MAX_GMAIL_RECIPIENTS} recipients.`,
    );
  }
  const headerBytes = utf8Bytes(to.join(", ")) + utf8Bytes(cc.join(", ")) + utf8Bytes(bcc.join(", "));
  if (headerBytes > MAX_GMAIL_RECIPIENT_HEADER_BYTES) {
    throw new GmailMessageValidationError(
      "GMAIL_RECIPIENT_HEADERS_TOO_LARGE",
      "Gmail recipient headers are too large.",
    );
  }
  return { to, cc, bcc };
}

export function safeGmailHeader(
  value: unknown,
  label: string,
  options: { required?: boolean; maxBytes?: number } = {},
) {
  if (typeof value !== "string") {
    throw new GmailMessageValidationError(
      "GMAIL_HEADER_INVALID",
      `${label} must be text.`,
    );
  }
  const text = value.trim();
  if ((options.required ?? true) && !text) {
    throw new GmailMessageValidationError(
      "GMAIL_HEADER_INVALID",
      `${label} is required.`,
    );
  }
  if (/\r|\n|\0/.test(text)) {
    throw new GmailMessageValidationError(
      "GMAIL_HEADER_INVALID",
      `${label} must not contain line breaks.`,
    );
  }
  if (utf8Bytes(text) > (options.maxBytes ?? MAX_GMAIL_HEADER_VALUE_BYTES)) {
    throw new GmailMessageValidationError(
      "GMAIL_HEADER_TOO_LARGE",
      `${label} is too large.`,
    );
  }
  return text;
}

export function requireGmailBody(value: unknown) {
  if (typeof value !== "string") {
    throw new GmailMessageValidationError(
      "GMAIL_BODY_INVALID",
      "Email body must be text.",
    );
  }
  if (!value.trim()) {
    throw new GmailMessageValidationError(
      "GMAIL_BODY_REQUIRED",
      "Email body is required.",
    );
  }
  if (utf8Bytes(value) > MAX_GMAIL_BODY_BYTES) {
    throw new GmailMessageValidationError(
      "GMAIL_BODY_TOO_LARGE",
      "Email body is too large.",
    );
  }
  return value;
}

export function requireGmailResourceId(value: unknown, label: string) {
  if (typeof value !== "string" || !GMAIL_RESOURCE_ID.test(value.trim())) {
    throw new GmailMessageValidationError(
      "GMAIL_REPLY_METADATA_INVALID",
      `${label} is invalid.`,
    );
  }
  return value.trim();
}

export function requireGmailMessageIdHeader(value: unknown, label: string) {
  const text = safeGmailHeader(value, label);
  if (!MESSAGE_ID.test(text)) {
    throw new GmailMessageValidationError(
      "GMAIL_REPLY_METADATA_INVALID",
      `${label} is invalid.`,
    );
  }
  return text;
}

export function requireGmailReferences(value: unknown) {
  const text = safeGmailHeader(value, "References", { required: false });
  if (!text) return "";
  const references = text.split(/\s+/);
  if (references.length > 50 || references.some((reference) => !MESSAGE_ID.test(reference))) {
    throw new GmailMessageValidationError(
      "GMAIL_REPLY_METADATA_INVALID",
      "References contain invalid message identifiers.",
    );
  }
  return references.join(" ");
}

export function gmailMessageIdForIdempotencyKey(value: unknown) {
  if (typeof value !== "string" || !value || utf8Bytes(value) > 2_048) {
    throw new GmailMessageValidationError(
      "GMAIL_IDEMPOTENCY_KEY_INVALID",
      "The Gmail execution key is invalid.",
    );
  }
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `<${digest}@crazy-loops.com>`;
}

function encodeMimeHeader(value: string) {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

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
  to: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject: unknown;
  body: unknown;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
}) {
  const recipients = parseGmailRecipients(input);
  const subject = safeGmailHeader(input.subject, "Subject", { maxBytes: MAX_GMAIL_SUBJECT_BYTES });
  const body = requireGmailBody(input.body);
  const messageId = input.messageId === undefined
    ? ""
    : requireGmailMessageIdHeader(input.messageId, "Message-ID");
  const inReplyTo = input.inReplyTo === undefined
    ? ""
    : requireGmailMessageIdHeader(input.inReplyTo, "In-Reply-To");
  const references = input.references === undefined ? "" : requireGmailReferences(input.references);
  const lines = [`To: ${recipients.to.join(", ")}`];
  if (recipients.cc.length) lines.push(`Cc: ${recipients.cc.join(", ")}`);
  if (recipients.bcc.length) lines.push(`Bcc: ${recipients.bcc.join(", ")}`);
  lines.push(`Subject: ${encodeMimeHeader(subject)}`);
  if (messageId) lines.push(`Message-ID: ${messageId}`);
  lines.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit");
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push("", body);
  const mime = lines.join("\r\n");
  if (utf8Bytes(mime) > MAX_GMAIL_MIME_BYTES) {
    throw new GmailMessageValidationError(
      "GMAIL_MIME_TOO_LARGE",
      "The encoded Gmail message is too large.",
    );
  }
  return Buffer.from(mime, "utf8").toString("base64url");
}
