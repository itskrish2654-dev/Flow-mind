import { OAuth2Client } from "google-auth-library";

import { googleApiFetch } from "@/lib/connectors/google/api";
import { normalizeGmailMessage } from "@/lib/connectors/google/gmail-message";
import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";
import { captureOperationalEvent } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

const auth = new OAuth2Client();

export async function verifyGooglePubSubRequest(request: Request) {
  const audience = process.env.GOOGLE_PUBSUB_AUDIENCE;
  const serviceAccount = process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT;
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!audience || !serviceAccount || !bearer) return false;
  try {
    const ticket = await auth.verifyIdToken({ idToken: bearer, audience });
    const payload = ticket.getPayload();
    return payload?.email_verified === true && payload.email === serviceAccount && ["accounts.google.com", "https://accounts.google.com"].includes(payload.iss ?? "");
  } catch { return false; }
}

export function parseGmailPushPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Google Pub/Sub payload.");
  const envelope = payload as { message?: { messageId?: string; data?: string } };
  if (!envelope.message?.messageId || !envelope.message.data) throw new Error("Google Pub/Sub message is incomplete.");
  const decoded = JSON.parse(Buffer.from(envelope.message.data, "base64").toString("utf8")) as { emailAddress?: string; historyId?: string };
  if (!decoded.emailAddress || !decoded.historyId || !/^\d+$/.test(decoded.historyId)) throw new Error("Gmail notification data is invalid.");
  return { notificationId: envelope.message.messageId.slice(0, 200), emailAddress: decoded.emailAddress.toLowerCase(), historyId: decoded.historyId };
}

export async function activateGmailWatch(input: {
  userId: string;
  connectionId: string;
  persistActiveSubscriptions?: boolean;
}) {
  const topicName = process.env.GOOGLE_GMAIL_PUBSUB_TOPIC;
  if (!topicName?.startsWith("projects/")) throw new Error("Google Gmail Pub/Sub topic is not configured.");
  const response = await googleApiFetch({ userId: input.userId, connectionId: input.connectionId, requiredScopes: [GOOGLE_SCOPES.gmailReadonly], url: "https://gmail.googleapis.com/gmail/v1/users/me/watch", method: "POST", body: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "include" } });
  const watch = await response.json() as { historyId?: string; expiration?: string };
  if (!watch.historyId || !watch.expiration) throw new Error("Gmail did not acknowledge the mailbox watch.");
  const expiresAt = new Date(Number(watch.expiration)); if (!Number.isFinite(expiresAt.getTime())) throw new Error("Gmail returned an invalid watch expiration.");
  const renewAfter = new Date(expiresAt.getTime() - 24 * 60 * 60_000).toISOString();
  if (input.persistActiveSubscriptions !== false) {
    const { error } = await createAdminClient().from("connector_subscriptions").update({ cursor_value: watch.historyId, provider_subscription_id: input.connectionId, expires_at: expiresAt.toISOString(), renew_after: renewAfter, last_error_category: null, status: "active", updated_at: new Date().toISOString() }).eq("connection_id", input.connectionId).eq("user_id", input.userId).eq("connector_id", "google_gmail").eq("status", "active");
    if (error) throw new Error("Gmail watch state could not be stored.");
  }
  await captureOperationalEvent({ level: "info", event: "gmail_watch_created", userId: input.userId, status: "active" });
  return { historyId: watch.historyId, expiresAt: expiresAt.toISOString(), renewAfter };
}

export async function stopGmailWatch(input: { userId: string; connectionId: string }) {
  try {
    await googleApiFetch({ userId: input.userId, connectionId: input.connectionId, requiredScopes: [GOOGLE_SCOPES.gmailReadonly], url: "https://gmail.googleapis.com/gmail/v1/users/me/stop", method: "POST", body: {} });
  } catch {
    // Local revocation still proceeds; a Gmail watch naturally expires within seven days.
  }
}

export async function renewDueGmailWatches() {
  const admin = createAdminClient(); const now = new Date().toISOString();
  const { data, error } = await admin.from("connector_subscriptions").select("user_id,connection_id").eq("connector_id", "google_gmail").eq("status", "active").not("connection_id", "is", null).lte("renew_after", now).limit(100);
  if (error) throw new Error("Gmail watches due for renewal could not be loaded.");
  const unique = Array.from(new Map((data ?? []).map((item) => [`${item.user_id}:${item.connection_id}`, item])).values());
  let renewed = 0; let failed = 0;
  for (const item of unique) {
    if (!item.connection_id) continue;
    try { await activateGmailWatch({ userId: item.user_id, connectionId: item.connection_id }); renewed += 1; await captureOperationalEvent({ level: "info", event: "gmail_watch_renewed", userId: item.user_id, status: "active" }); }
    catch (error) {
      failed += 1;
      const reconnectRequired = error instanceof Error && /reconnect|permission|authentication/i.test(error.message);
      await admin.from("connector_subscriptions").update({ ...(reconnectRequired ? { status: "error" as const } : {}), last_error_category: reconnectRequired ? "authentication" : "provider_unavailable", updated_at: now }).eq("connection_id", item.connection_id).eq("user_id", item.user_id).eq("connector_id", "google_gmail");
    }
  }
  return { inspected: unique.length, renewed, failed };
}

async function gmailHistory(input: { userId: string; connectionId: string; startHistoryId: string }) {
  const messageIds = new Set<string>(); let pageToken: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history"); url.searchParams.set("startHistoryId", input.startHistoryId); url.searchParams.set("historyTypes", "messageAdded"); url.searchParams.set("maxResults", "100"); if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await googleApiFetch({ userId: input.userId, connectionId: input.connectionId, requiredScopes: [GOOGLE_SCOPES.gmailReadonly], url: url.toString() });
    const data = await response.json() as { history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>; nextPageToken?: string };
    for (const history of data.history ?? []) for (const added of history.messagesAdded ?? []) if (added.message?.id) messageIds.add(added.message.id);
    pageToken = data.nextPageToken; if (!pageToken || messageIds.size >= 500) break;
  }
  return Array.from(messageIds).slice(0, 500);
}

async function searchMatches(input: { userId: string; connectionId: string; search: string }) {
  const matches = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", input.search);
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await googleApiFetch({ userId: input.userId, connectionId: input.connectionId, requiredScopes: [GOOGLE_SCOPES.gmailReadonly], url: url.toString() });
    const data = await response.json() as { messages?: Array<{ id?: string }>; nextPageToken?: string };
    for (const message of data.messages ?? []) if (message.id) matches.add(message.id);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return matches;
}

export async function processGmailPush(request: Request, payload: unknown, alreadyVerified = false) {
  if (!alreadyVerified && !(await verifyGooglePubSubRequest(request))) throw new Error("Google Pub/Sub authentication failed.");
  const notification = parseGmailPushPayload(payload); const admin = createAdminClient();
  const { data: connections, error } = await admin.from("connector_connections").select("id,user_id").eq("provider_family", "google").eq("status", "connected").eq("external_account_label", notification.emailAddress);
  if (error) throw new Error("Google account lookup failed.");
  const receiptIds: string[] = [];
  let processingFailed = false;
  for (const connection of connections ?? []) {
    const { data: subscriptions } = await admin.from("connector_subscriptions").select("id,workflow_id,workflow_version_id,operation_key,cursor_value,safe_metadata").eq("connection_id", connection.id).eq("user_id", connection.user_id).eq("connector_id", "google_gmail").eq("status", "active");
    for (const subscription of subscriptions ?? []) {
      if (!subscription.cursor_value) continue;
      try {
        const ids = await gmailHistory({ userId: connection.user_id, connectionId: connection.id, startHistoryId: subscription.cursor_value });
        const metadata = subscription.safe_metadata && typeof subscription.safe_metadata === "object" && !Array.isArray(subscription.safe_metadata) ? subscription.safe_metadata as Record<string, Json | undefined> : {};
        const search = subscription.operation_key === "new_email_matching_search" && typeof metadata.search === "string" ? metadata.search : "";
        const allowed = search ? await searchMatches({ userId: connection.user_id, connectionId: connection.id, search }) : null;
        for (const messageId of ids) {
          if (allowed && !allowed.has(messageId)) continue;
          const response = await googleApiFetch({ userId: connection.user_id, connectionId: connection.id, requiredScopes: [GOOGLE_SCOPES.gmailReadonly], url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full` });
          const message = await response.json() as Record<string, unknown>; const normalized = normalizeGmailMessage(message);
          if (!normalized.message.labels.includes("INBOX")) continue;
          const { data: receipt, error: receiptError } = await admin.from("connector_event_receipts").insert({ subscription_id: subscription.id, workflow_id: subscription.workflow_id, workflow_version_id: subscription.workflow_version_id, provider_event_key: `gmail:${messageId}`, payload: normalized as Json, safe_metadata: { connectorId: "google_gmail", operationKey: subscription.operation_key, gmailMessageId: messageId } }).select("id").maybeSingle();
          if (receiptError && receiptError.code !== "23505") throw new Error("Gmail event receipt could not be stored.");
          if (receipt?.id) receiptIds.push(receipt.id);
        }
        await admin.from("connector_subscriptions").update({ cursor_value: notification.historyId, last_event_at: new Date().toISOString(), last_error_category: null, updated_at: new Date().toISOString() }).eq("id", subscription.id).eq("user_id", connection.user_id).eq("cursor_value", subscription.cursor_value);
      } catch {
        processingFailed = true;
        await admin.from("connector_subscriptions").update({ last_error_category: "gmail_history_error", updated_at: new Date().toISOString() }).eq("id", subscription.id).eq("user_id", connection.user_id);
        await captureOperationalEvent({ level: "warn", event: "gmail_history_error", userId: connection.user_id, workflowId: subscription.workflow_id, status: "failed", errorCategory: "provider" });
      }
    }
  }
  if (processingFailed) throw new Error("Gmail history processing must be retried.");
  await captureOperationalEvent({ level: "info", event: "gmail_event_received", status: "accepted", metadata: { receiptCount: receiptIds.length } });
  return receiptIds;
}
