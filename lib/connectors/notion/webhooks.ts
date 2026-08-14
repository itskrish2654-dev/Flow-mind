import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyNotionWebhook(request: Request, rawBody: Uint8Array) {
  const token = process.env.FLOWMIND_CONNECTOR_NOTION_WEBHOOK_VERIFICATION_TOKEN;
  const signature = request.headers.get("x-notion-signature") ?? "";
  if (!token || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = `sha256=${createHmac("sha256", token).update(rawBody).digest("hex")}`;
  const left = Buffer.from(signature); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyNotionVerificationToken(provided: string) {
  const expected = process.env.FLOWMIND_CONNECTOR_NOTION_WEBHOOK_VERIFICATION_TOKEN ?? "";
  const left = Buffer.from(provided); const right = Buffer.from(expected);
  return expected.length >= 16 && left.length === right.length && timingSafeEqual(left, right);
}

export type NotionWebhookEvent = { id?: string; timestamp?: string; workspace_id?: string; integration_id?: string; type?: string; api_version?: string; entity?: { id?: string; type?: string }; data?: Record<string, unknown>; verification_token?: string };

export function notionOperationForEvent(event: NotionWebhookEvent) {
  if (event.type === "page.created") return "page_created_or_added";
  if (event.type === "page.content_updated" || event.type === "page.properties_updated" || event.type === "page.moved") return "page_updated";
  return null;
}
