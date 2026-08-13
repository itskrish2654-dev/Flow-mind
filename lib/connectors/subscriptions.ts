import "server-only";

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";

function endpointSecret() {
  const secret = process.env.FLOWMIND_CONNECTOR_ENDPOINT_SECRET;
  if (!secret || secret.length < 32) throw new Error("Connector webhook endpoints are not configured.");
  return secret;
}

export function connectorEndpointToken(subscriptionId: string) {
  return createHmac("sha256", endpointSecret()).update(`flowmind-webhook:v1:${subscriptionId}`).digest("base64url");
}

export function verifyConnectorEndpointToken(subscriptionId: string, provided: string) {
  const expected = Buffer.from(connectorEndpointToken(subscriptionId)); const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function connectorWebhookUrl(subscriptionId: string) {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (!siteUrl) throw new Error("NEXT_PUBLIC_SITE_URL is not configured.");
  return `${siteUrl}/api/connectors/events/flowmind_webhook?subscription=${encodeURIComponent(subscriptionId)}&token=${encodeURIComponent(connectorEndpointToken(subscriptionId))}`;
}

export async function activateWorkflowConnectorSubscriptions(input: { userId: string; workflowId: string; workflowVersionId: string; steps: Array<{ config?: { connector?: { connectorId: string; operationKind: "trigger" | "action"; operationKey: string; operationVersion: number; connectionId?: string } } }> }) {
  const admin = createAdminClient();
  await admin.from("connector_subscriptions").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("workflow_id", input.workflowId).eq("user_id", input.userId).eq("status", "active");
  const triggers = input.steps.flatMap((step) => step.config?.connector?.operationKind === "trigger" ? [step.config.connector] : []);
  const created: Array<{ id: string; url: string }> = [];
  for (const trigger of triggers) {
    const id = randomUUID();
    const token = connectorEndpointToken(id);
    const { error } = await admin.from("connector_subscriptions").insert({
      id, user_id: input.userId, workflow_id: input.workflowId, workflow_version_id: input.workflowVersionId,
      ...(trigger.connectionId ? { connection_id: trigger.connectionId } : {}), connector_id: trigger.connectorId,
      operation_key: trigger.operationKey, operation_version: trigger.operationVersion, endpoint_token_hash: createHash("sha256").update(token).digest("hex"), status: "active",
    });
    if (error) throw new Error("Connector subscription could not be activated.");
    created.push({ id, url: connectorWebhookUrl(id) });
  }
  return created;
}

export async function deactivateWorkflowConnectorSubscriptions(userId: string, workflowId: string) {
  const { error } = await createAdminClient().from("connector_subscriptions").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("workflow_id", workflowId).eq("user_id", userId).eq("status", "active");
  if (error) throw new Error("Connector subscriptions could not be revoked.");
}
