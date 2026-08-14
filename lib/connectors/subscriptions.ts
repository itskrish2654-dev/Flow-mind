import "server-only";

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import { activateGmailWatch, stopGmailWatch } from "@/lib/connectors/google/gmail-push";
import { getConnectorOperation } from "@/lib/connectors/registry";
import type { Json } from "@/lib/supabase/types";

export async function validateWorkflowConnectorConnections(input: { userId: string; steps: Array<{ config?: { connector?: { connectorId: string; operationKind: "trigger" | "action"; operationKey: string; operationVersion: number; connectionId?: string } } }> }) {
  const admin = createAdminClient();
  for (const step of input.steps) {
    const config = step.config?.connector;
    if (!config) continue;
    const registered = getConnectorOperation(config.connectorId, config.operationKind, config.operationKey, config.operationVersion);
    if (!registered || !registered.operation.production) return "This connector operation is unavailable in production.";
    if (!registered.operation.connectionRequired) continue;
    if (!config.connectionId) return `Choose an account for ${registered.connector.manifest.displayName}.`;
    const { data } = await admin.from("connector_connections").select("id,status,provider_family,granted_scopes").eq("id", config.connectionId).eq("user_id", input.userId).eq("provider_family", registered.connector.manifest.providerFamily).maybeSingle();
    if (!data || data.status !== "connected") return `Reconnect ${registered.connector.manifest.displayName} to continue.`;
    if (registered.operation.requiredScopes.some((scope) => !data.granted_scopes.includes(scope))) return `CrazyLoops needs additional ${registered.connector.manifest.displayName} permission for this workflow.`;
  }
  return null;
}

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

function providerWebhookUrl(provider: "google_gmail" | "slack" | "notion") {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (!siteUrl) throw new Error("NEXT_PUBLIC_SITE_URL is not configured.");
  return `${siteUrl}/api/connectors/events/${provider}`;
}

export async function activateWorkflowConnectorSubscriptions(input: { userId: string; workflowId: string; workflowVersionId: string; setupConfig?: Record<string, string>; steps: Array<{ id?: string; config?: { connector?: { connectorId: string; operationKind: "trigger" | "action"; operationKey: string; operationVersion: number; connectionId?: string; settings?: Record<string, unknown> } } }> }) {
  const admin = createAdminClient();
  await admin.from("connector_subscriptions").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("workflow_id", input.workflowId).eq("user_id", input.userId).eq("status", "active");
  const triggers = input.steps.flatMap((step) => step.config?.connector?.operationKind === "trigger" ? [{ ...step.config.connector, stepId: step.id ?? "" }] : []);
  const created: Array<{ id: string; url: string }> = [];
  try {
    for (const trigger of triggers) {
      const runtimeSettings = {
        ...(trigger.settings ?? {}),
        ...Object.fromEntries(Object.entries(input.setupConfig ?? {}).flatMap(([key, value]) => key.startsWith(`${trigger.stepId}-`) && value ? [[key.slice(trigger.stepId.length + 1), value]] : [])),
      };
      if (trigger.connectorId === "google_gmail" && !trigger.connectionId) throw new Error("Choose a Google account before activating Gmail.");
      if (trigger.connectorId === "slack" && !String(runtimeSettings.channel ?? runtimeSettings.channelId ?? "").trim()) throw new Error("Choose a Slack channel before activating this workflow.");
      if (trigger.connectorId === "notion" && !String(runtimeSettings.resourceId ?? runtimeSettings.pageId ?? runtimeSettings.dataSourceId ?? "").trim()) throw new Error("Choose a Notion page or data source before activating this workflow.");
      const id = randomUUID();
      const token = connectorEndpointToken(id);
      const { error } = await admin.from("connector_subscriptions").insert({
        id, user_id: input.userId, workflow_id: input.workflowId, workflow_version_id: input.workflowVersionId,
        ...(trigger.connectionId ? { connection_id: trigger.connectionId } : {}), connector_id: trigger.connectorId,
        operation_key: trigger.operationKey, operation_version: trigger.operationVersion, endpoint_token_hash: createHash("sha256").update(token).digest("hex"), status: "active",
        safe_metadata: runtimeSettings as Json,
      });
      if (error) throw new Error("Connector subscription could not be activated.");
      created.push({ id, url: trigger.connectorId === "google_gmail" || trigger.connectorId === "slack" || trigger.connectorId === "notion" ? providerWebhookUrl(trigger.connectorId) : connectorWebhookUrl(id) });
    }
    for (const connectionId of Array.from(new Set(triggers.filter((trigger) => trigger.connectorId === "google_gmail").flatMap((trigger) => trigger.connectionId ? [trigger.connectionId] : [])))) {
      await activateGmailWatch({ userId: input.userId, connectionId });
    }
  } catch (error) {
    const createdIds = created.map((item) => item.id);
    if (createdIds.length) {
      await admin.from("connector_subscriptions").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("user_id", input.userId).in("id", createdIds);
    }
    throw error;
  }
  return created;
}

export async function deactivateWorkflowConnectorSubscriptions(userId: string, workflowId: string) {
  const admin = createAdminClient();
  const { data: gmail } = await admin.from("connector_subscriptions").select("connection_id").eq("workflow_id", workflowId).eq("user_id", userId).eq("connector_id", "google_gmail").eq("status", "active");
  const { error } = await admin.from("connector_subscriptions").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("workflow_id", workflowId).eq("user_id", userId).eq("status", "active");
  if (error) throw new Error("Connector subscriptions could not be revoked.");
  for (const connectionId of Array.from(new Set((gmail ?? []).flatMap((item) => item.connection_id ? [item.connection_id] : [])))) {
    const { count } = await admin.from("connector_subscriptions").select("id", { count: "exact", head: true }).eq("connection_id", connectionId).eq("user_id", userId).eq("connector_id", "google_gmail").eq("status", "active");
    if ((count ?? 0) === 0) await stopGmailWatch({ userId, connectionId });
  }
}
