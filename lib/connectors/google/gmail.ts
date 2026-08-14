import { googleApiErrorResult, googleApiFetch } from "@/lib/connectors/google/api";
import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";
import type { ConnectorActionHandler } from "@/lib/connectors/types";
import { captureOperationalEvent } from "@/lib/observability";
import { buildRawGmailMessage, gmailHeader } from "@/lib/connectors/google/gmail-message";
export { htmlToSafeText, normalizeGmailMessage } from "@/lib/connectors/google/gmail-message";

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function addresses(value: unknown, required: boolean) {
  const list = String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (required && list.length === 0) throw new Error("At least one recipient is required.");
  if (list.some((item) => !EMAIL.test(item))) throw new Error("Every recipient must be a valid email address.");
  return list;
}

function safeHeader(value: unknown, label: string) {
  const text = String(value ?? "").trim();
  if (!text || /[\r\n]/.test(text)) throw new Error(`${label} is required and must not contain line breaks.`);
  return text.slice(0, 998);
}

export const gmailSendEmail: ConnectorActionHandler = async (input, context) => {
  try {
    if (!context.connectionId) throw new Error("Choose a Google account before sending email.");
    const to = addresses(input.to, true); const cc = addresses(input.cc, false); const bcc = addresses(input.bcc, false);
    const subject = safeHeader(input.subject, "Subject"); const body = String(input.body ?? "").trim();
    if (!body) throw new Error("Email body is required.");
    const stableMessageId = `<${Buffer.from(context.idempotencyKey).toString("base64url").slice(0, 80)}@crazyloops.com>`;
    const response = await googleApiFetch({ userId: context.userId, connectionId: context.connectionId, requiredScopes: [GOOGLE_SCOPES.gmailSend], url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", method: "POST", body: { raw: buildRawGmailMessage({ to, cc, bcc, subject, body, messageId: stableMessageId }) } });
    const sent = await response.json() as { id?: string; threadId?: string };
    if (!sent.id) throw new Error("Gmail did not acknowledge the sent message.");
    await captureOperationalEvent({ level: "info", event: "gmail_action_success", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "succeeded", metadata: { operation: "send_email" } });
    return { status: "succeeded", acknowledged: true, externallyDelivered: true, providerReferenceId: sent.id, output: { messageId: sent.id, threadId: sent.threadId ?? "" }, metadata: { operation: "send_email" } };
  } catch (error) {
    await captureOperationalEvent({ level: "warn", event: "gmail_action_failure", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "failed", errorCategory: "provider" });
    return googleApiErrorResult(error);
  }
};

export const gmailReplyToEmail: ConnectorActionHandler = async (input, context) => {
  try {
    if (!context.connectionId) throw new Error("Choose a Google account before replying.");
    const messageId = String(input.messageId ?? "").trim(); const threadId = String(input.threadId ?? "").trim();
    if (!messageId || !threadId) throw new Error("A Gmail message and thread reference are required.");
    const sourceResponse = await googleApiFetch({ userId: context.userId, connectionId: context.connectionId, requiredScopes: [GOOGLE_SCOPES.gmailReadonly], url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject&metadataHeaders=Reply-To&metadataHeaders=From` });
    const source = await sourceResponse.json() as { threadId?: string; payload?: { headers?: Array<{ name?: string; value?: string }> } };
    if (source.threadId !== threadId) throw new Error("The Gmail message does not belong to the selected thread.");
    const headers = source.payload?.headers; const originalMessageId = gmailHeader(headers, "Message-ID");
    if (!originalMessageId) throw new Error("The original Gmail message does not contain a valid thread reference.");
    const to = addresses(input.to || gmailHeader(headers, "Reply-To") || gmailHeader(headers, "From").match(/<([^>]+)>/)?.[1] || gmailHeader(headers, "From"), true);
    const originalSubject = gmailHeader(headers, "Subject"); const subject = safeHeader(input.subject || (/^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`), "Subject");
    const replyBody = String(input.body ?? "").trim(); if (!replyBody) throw new Error("Reply body is required.");
    const references = [gmailHeader(headers, "References"), originalMessageId].filter(Boolean).join(" ");
    const stableMessageId = `<${Buffer.from(context.idempotencyKey).toString("base64url").slice(0, 80)}@crazyloops.com>`;
    const sendResponse = await googleApiFetch({ userId: context.userId, connectionId: context.connectionId, requiredScopes: [GOOGLE_SCOPES.gmailReadonly, GOOGLE_SCOPES.gmailSend], url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", method: "POST", body: { threadId, raw: buildRawGmailMessage({ to, subject, body: replyBody, messageId: stableMessageId, inReplyTo: originalMessageId, references }) } });
    const sent = await sendResponse.json() as { id?: string; threadId?: string };
    if (!sent.id || sent.threadId !== threadId) throw new Error("Gmail did not acknowledge the reply in the requested thread.");
    await captureOperationalEvent({ level: "info", event: "gmail_action_success", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "succeeded", metadata: { operation: "reply_to_email" } });
    return { status: "succeeded", acknowledged: true, externallyDelivered: true, providerReferenceId: sent.id, output: { messageId: sent.id, threadId }, metadata: { operation: "reply_to_email" } };
  } catch (error) {
    await captureOperationalEvent({ level: "warn", event: "gmail_action_failure", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "failed", errorCategory: "provider" });
    return googleApiErrorResult(error);
  }
};
