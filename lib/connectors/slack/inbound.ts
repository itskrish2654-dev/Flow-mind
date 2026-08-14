import { randomUUID } from "node:crypto";

import { normalizeSlackMessage, type SlackEventEnvelope, verifySlackRequest } from "@/lib/connectors/slack/events";
import { captureOperationalEvent } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export async function queueSlackEvent(request: Request, raw: Uint8Array, payload: SlackEventEnvelope) {
  if (!verifySlackRequest(request, raw)) throw new Error("SLACK_SIGNATURE_INVALID");
  if (payload.type === "url_verification") return { challenge: payload.challenge ?? "", receiptIds: [] };
  const message = normalizeSlackMessage(payload);
  if (!message) return { receiptIds: [] };
  const admin = createAdminClient();
  const { data: connections } = await admin.from("connector_connections").select("id,user_id,safe_metadata")
    .eq("provider_family", "slack").eq("external_account_id", message.teamId).eq("status", "connected");
  const eligible = (connections ?? []).filter((connection) => {
    const metadata = connection.safe_metadata && typeof connection.safe_metadata === "object" && !Array.isArray(connection.safe_metadata) ? connection.safe_metadata as Record<string, unknown> : {};
    return message.userId !== metadata.botUserId;
  });
  if (!eligible.length) return { receiptIds: [] };
  const { data: subscriptions } = await admin.from("connector_subscriptions").select("id,user_id,workflow_id,workflow_version_id,connection_id,safe_metadata")
    .in("connection_id", eligible.map((connection) => connection.id)).eq("connector_id", "slack").eq("operation_key", "new_channel_message").eq("status", "active");
  const receiptIds: string[] = [];
  for (const subscription of subscriptions ?? []) {
    const settings = subscription.safe_metadata && typeof subscription.safe_metadata === "object" && !Array.isArray(subscription.safe_metadata) ? subscription.safe_metadata as Record<string, unknown> : {};
    const configuredChannel = String(settings.channel ?? settings.channelId ?? "");
    if (configuredChannel && configuredChannel !== message.channelId) continue;
    const receiptId = randomUUID();
    const { error } = await admin.from("connector_event_receipts").insert({ id: receiptId, subscription_id: subscription.id, workflow_id: subscription.workflow_id, workflow_version_id: subscription.workflow_version_id, provider_event_key: message.eventId, status: "queued", payload: { message: { id: message.messageTs, channelId: message.channelId, userId: message.userId, text: message.text, threadTs: message.threadTs, createdAt: message.createdAt } } as Json, safe_metadata: { connectorId: "slack", operationKey: "new_channel_message" } });
    if (!error) {
      receiptIds.push(receiptId);
      await captureOperationalEvent({ level: "info", event: "slack_event_received", userId: subscription.user_id, workflowId: subscription.workflow_id, status: "queued", metadata: { operation: "new_channel_message" } });
    } else if (error.code === "23505") {
      await captureOperationalEvent({ level: "info", event: "slack_event_deduplicated", userId: subscription.user_id, workflowId: subscription.workflow_id, status: "duplicate", metadata: { operation: "new_channel_message" } });
    } else throw new Error("SLACK_RECEIPT_FAILED");
  }
  return { receiptIds };
}
