import { randomUUID } from "node:crypto";

import { notionApiFetch } from "@/lib/connectors/notion/api";
import { NOTION_API_VERSION, NOTION_CAPABILITIES } from "@/lib/connectors/notion/constants";
import { normalizeNotionPage } from "@/lib/connectors/notion/properties";
import { notionOperationForEvent, type NotionWebhookEvent, verifyNotionWebhook } from "@/lib/connectors/notion/webhooks";
import { captureOperationalEvent } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export async function queueNotionEvent(request: Request, raw: Uint8Array, payload: NotionWebhookEvent) {
  if (!verifyNotionWebhook(request, raw)) throw new Error("NOTION_SIGNATURE_INVALID");
  const operationKey = notionOperationForEvent(payload);
  if (!operationKey || !payload.id || !payload.workspace_id || !payload.entity?.id || payload.entity.type !== "page") return { receiptIds: [] };
  if (payload.api_version && payload.api_version !== NOTION_API_VERSION) throw new Error("NOTION_VERSION_MISMATCH");
  const admin = createAdminClient();
  const { data: connections } = await admin.from("connector_connections").select("id,user_id")
    .eq("provider_family", "notion").eq("external_account_id", payload.workspace_id).eq("status", "connected");
  if (!connections?.length) return { receiptIds: [] };
  const { data: subscriptions } = await admin.from("connector_subscriptions").select("id,user_id,workflow_id,workflow_version_id,connection_id,safe_metadata")
    .in("connection_id", connections.map((connection) => connection.id)).eq("connector_id", "notion").eq("operation_key", operationKey).eq("status", "active");
  const receiptIds: string[] = [];
  const pages = new Map<string, ReturnType<typeof normalizeNotionPage>>();
  for (const subscription of subscriptions ?? []) {
    if (!subscription.connection_id) continue;
    let normalized = pages.get(subscription.connection_id);
    if (!normalized) {
      const page = await notionApiFetch({ userId: subscription.user_id, connectionId: subscription.connection_id, requiredCapabilities: [NOTION_CAPABILITIES.readContent], path: `/pages/${encodeURIComponent(payload.entity.id)}` });
      normalized = normalizeNotionPage(page); pages.set(subscription.connection_id, normalized);
    }
    const settings = subscription.safe_metadata && typeof subscription.safe_metadata === "object" && !Array.isArray(subscription.safe_metadata) ? subscription.safe_metadata as Record<string, unknown> : {};
    const resourceId = String(settings.resourceId ?? settings.pageId ?? settings.dataSourceId ?? "").replace(/-/g, "");
    const actualIds = [normalized.page.id, normalized.page.parentId].map((id) => id.replace(/-/g, ""));
    if (resourceId && !actualIds.includes(resourceId)) continue;
    const receiptId = randomUUID();
    const { error } = await admin.from("connector_event_receipts").insert({ id: receiptId, subscription_id: subscription.id, workflow_id: subscription.workflow_id, workflow_version_id: subscription.workflow_version_id, provider_event_key: payload.id, status: "queued", payload: normalized as unknown as Json, safe_metadata: { connectorId: "notion", operationKey, apiVersion: NOTION_API_VERSION } });
    if (!error) {
      receiptIds.push(receiptId);
      await captureOperationalEvent({ level: "info", event: "notion_event_received", userId: subscription.user_id, workflowId: subscription.workflow_id, status: "queued", metadata: { operation: operationKey } });
    } else if (error.code !== "23505") throw new Error("NOTION_RECEIPT_FAILED");
  }
  return { receiptIds };
}
