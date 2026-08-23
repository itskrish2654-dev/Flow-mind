import "server-only";

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import { activateGmailWatch, stopGmailWatch } from "@/lib/connectors/google/gmail-push";
import { getConnectorOperation } from "@/lib/connectors/registry";
import { assertSelectedGoogleSpreadsheet } from "@/lib/connectors/google/selected-spreadsheets";
import { connectorConnectionIds, matchesOwnedConnectorConnection } from "@/lib/connectors/connection-matching";
import {
  isDeferredCustomerAirtableConnection,
  isVerifiedCustomerAirtableCreateRecordConnection,
  parseAirtableFieldMappings,
  validateAirtableDestinationIdentifiers,
} from "@/lib/connectors/airtable/workflow-configuration";
import { getSiteOrigin } from "@/lib/site-origin";
import type { Json } from "@/lib/supabase/types";

export async function validateWorkflowConnectorConnections(input: { userId: string; mode?: "test" | "production"; setupConfig?: Record<string, string>; steps: Array<{ id?: string; config?: { connector?: { connectorId: string; operationKind: "trigger" | "action"; operationKey: string; operationVersion: number; connectionId?: string } } }> }) {
  const admin = createAdminClient();
  const mode = input.mode ?? "production";
  for (const step of input.steps) {
    const config = step.config?.connector;
    if (!config) continue;
    const registered = getConnectorOperation(config.connectorId, config.operationKind, config.operationKey, config.operationVersion);
    if (!registered || (mode === "test" ? !registered.operation.testMode : !registered.operation.production)) return `This connector operation is unavailable in ${mode}.`;
    if (!registered.operation.connectionRequired) continue;
    if (!config.connectionId) return `Choose an account for ${registered.connector.manifest.displayName}.`;
    const { data } = await admin.from("connector_connections").select("id,user_id,status,connector_id,provider_family,auth_type,granted_scopes,safe_metadata").eq("id", config.connectionId).eq("user_id", input.userId).eq("provider_family", registered.connector.manifest.providerFamily).in("connector_id", connectorConnectionIds(registered.connector.manifest)).maybeSingle();
    if (!data || !matchesOwnedConnectorConnection({ connection: data, authenticatedUserId: input.userId, connectionId: config.connectionId, manifest: registered.connector.manifest })) return `Reconnect ${registered.connector.manifest.displayName} to continue.`;
    const deferredAirtable = mode === "test" && config.connectorId === "airtable" && config.operationKind === "action" && config.operationKey === "create_record" && config.operationVersion === 1 && isDeferredCustomerAirtableConnection(data);
    if (
      mode === "production" &&
      config.connectorId === "airtable" &&
      config.operationKind === "action" &&
      config.operationKey === "create_record" &&
      config.operationVersion === 1 &&
      !isVerifiedCustomerAirtableCreateRecordConnection(data)
    ) {
      return "This Airtable connection needs a successful test before this loop can be activated.";
    }
    if (registered.operation.requiredScopes.some((scope) => !data.granted_scopes.includes(scope)) && !deferredAirtable) return `CrazyLoops needs additional ${registered.connector.manifest.displayName} permission for this workflow.`;
    if (config.connectorId === "airtable") {
      try {
        validateAirtableDestinationIdentifiers(
          input.setupConfig?.[`${step.id ?? ""}-baseId`] ?? "",
          input.setupConfig?.[`${step.id ?? ""}-tableId`] ?? "",
        );
        parseAirtableFieldMappings(input.setupConfig?.[`${step.id ?? ""}-fields`] ?? "");
      } catch (error) {
        return error instanceof Error ? error.message : "Airtable setup is invalid.";
      }
    }
    if (config.connectorId === "google_sheets") {
      const spreadsheetId = input.setupConfig?.[`${step.id ?? ""}-spreadsheetId`];
      if (!spreadsheetId) return "Choose a spreadsheet through Google Picker.";
      try {
        await assertSelectedGoogleSpreadsheet({ userId: input.userId, connectionId: data.id, spreadsheetId });
      } catch {
        return "Choose this spreadsheet through Google Picker before publishing.";
      }
    }
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
  const siteUrl = getSiteOrigin();
  return `${siteUrl}/api/connectors/events/flowmind_webhook?subscription=${encodeURIComponent(subscriptionId)}&token=${encodeURIComponent(connectorEndpointToken(subscriptionId))}`;
}

function providerWebhookUrl(provider: "google_gmail" | "slack" | "notion") {
  const siteUrl = getSiteOrigin();
  return `${siteUrl}/api/connectors/events/${provider}`;
}

export async function prepareWorkflowConnectorPublication(input: { userId: string; workflowId: string; workflowVersionId: string; setupConfig?: Record<string, string>; steps: Array<{ id?: string; config?: { connector?: { connectorId: string; operationKind: "trigger" | "action"; operationKey: string; operationVersion: number; connectionId?: string; settings?: Record<string, unknown> } } }> }) {
  const admin = createAdminClient();
  const triggers = input.steps.flatMap((step) => step.config?.connector?.operationKind === "trigger" ? [{ ...step.config.connector, stepId: step.id ?? "" }] : []);
  const { data: existing, error: existingError } = await admin
    .from("connector_subscriptions")
    .select("id,connector_id,operation_key")
    .eq("workflow_id", input.workflowId)
    .eq("workflow_version_id", input.workflowVersionId)
    .eq("user_id", input.userId);
  if (existingError) throw new Error("Connector publication could not be prepared.");
  const existingIds = new Map((existing ?? []).map((subscription) => [`${subscription.connector_id}:${subscription.operation_key}`, subscription.id]));
  const preparedTriggers = triggers.map((trigger) => {
    const runtimeSettings = {
      ...(trigger.settings ?? {}),
      ...Object.fromEntries(Object.entries(input.setupConfig ?? {}).flatMap(([key, value]) => key.startsWith(`${trigger.stepId}-`) && value ? [[key.slice(trigger.stepId.length + 1), value]] : [])),
    };
    if (trigger.connectorId === "google_gmail" && !trigger.connectionId) throw new Error("Choose a Google account before activating Gmail.");
    if (trigger.connectorId === "slack" && !String(runtimeSettings.channel ?? runtimeSettings.channelId ?? "").trim()) throw new Error("Choose a Slack channel before activating this workflow.");
    if (trigger.connectorId === "notion" && !String(runtimeSettings.resourceId ?? runtimeSettings.pageId ?? runtimeSettings.dataSourceId ?? "").trim()) throw new Error("Choose a Notion page or data source before activating this workflow.");
    const id = existingIds.get(`${trigger.connectorId}:${trigger.operationKey}`) ?? randomUUID();
    const token = connectorEndpointToken(id);
    return {
      ...trigger,
      id,
      runtimeSettings,
      endpointTokenHash: createHash("sha256").update(token).digest("hex"),
      url: trigger.connectorId === "google_gmail" || trigger.connectorId === "slack" || trigger.connectorId === "notion" ? providerWebhookUrl(trigger.connectorId) : connectorWebhookUrl(id),
    };
  });
  const gmailWatches = new Map<string, Awaited<ReturnType<typeof activateGmailWatch>>>();
  const gmailConnectionIds = Array.from(new Set(preparedTriggers.filter((trigger) => trigger.connectorId === "google_gmail").flatMap((trigger) => trigger.connectionId ? [trigger.connectionId] : [])));
  try {
    for (const connectionId of gmailConnectionIds) {
      gmailWatches.set(connectionId, await activateGmailWatch({ userId: input.userId, connectionId, persistActiveSubscriptions: false }));
    }
  } catch (error) {
    await stopUnusedGmailWatches(input.userId, Array.from(gmailWatches.keys()));
    throw error;
  }

  const subscriptions = preparedTriggers.map((trigger) => {
    const gmailWatch = trigger.connectionId ? gmailWatches.get(trigger.connectionId) : undefined;
    return {
      id: trigger.id,
      connectionId: trigger.connectionId ?? "",
      connectorId: trigger.connectorId,
      operationKey: trigger.operationKey,
      operationVersion: trigger.operationVersion,
      endpointTokenHash: trigger.endpointTokenHash,
      providerSubscriptionId: gmailWatch ? trigger.connectionId ?? "" : "",
      cursorValue: gmailWatch?.historyId ?? "",
      renewAfter: gmailWatch?.renewAfter ?? "",
      expiresAt: gmailWatch?.expiresAt ?? "",
      safeMetadata: trigger.runtimeSettings as Json,
      url: trigger.url,
    };
  });
  return {
    payload: subscriptions.map((subscription) => ({
      id: subscription.id,
      connectionId: subscription.connectionId,
      connectorId: subscription.connectorId,
      operationKey: subscription.operationKey,
      operationVersion: subscription.operationVersion,
      endpointTokenHash: subscription.endpointTokenHash,
      providerSubscriptionId: subscription.providerSubscriptionId,
      cursorValue: subscription.cursorValue,
      renewAfter: subscription.renewAfter,
      expiresAt: subscription.expiresAt,
      safeMetadata: subscription.safeMetadata,
    })) as Json,
    endpoints: subscriptions.map((subscription) => subscription.url),
    gmailConnectionIds,
  };
}

export async function stopUnusedGmailWatches(userId: string, connectionIds: string[]) {
  const admin = createAdminClient();
  for (const connectionId of Array.from(new Set(connectionIds))) {
    const { count, error } = await admin.from("connector_subscriptions").select("id", { count: "exact", head: true }).eq("connection_id", connectionId).eq("user_id", userId).eq("connector_id", "google_gmail").eq("status", "active");
    if (error) throw new Error("Gmail watch usage could not be verified safely.");
    if ((count ?? 0) === 0) await stopGmailWatch({ userId, connectionId });
  }
}

export async function deactivateWorkflowConnectorSubscriptions(userId: string, workflowId: string) {
  const admin = createAdminClient();
  const { data: gmail } = await admin.from("connector_subscriptions").select("connection_id").eq("workflow_id", workflowId).eq("user_id", userId).eq("connector_id", "google_gmail").eq("status", "active");
  const { error } = await admin.from("connector_subscriptions").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("workflow_id", workflowId).eq("user_id", userId).eq("status", "active");
  if (error) throw new Error("Connector subscriptions could not be revoked.");
  await stopUnusedGmailWatches(userId, (gmail ?? []).flatMap((item) => item.connection_id ? [item.connection_id] : []));
}
