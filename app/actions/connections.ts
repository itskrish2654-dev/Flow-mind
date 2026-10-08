"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getAuthenticatedContext } from "@/lib/auth";
import { readConnectionSecret, revokeConnection } from "@/lib/connectors/connection-vault";
import { isDeferredCustomerAirtableConnection } from "@/lib/connectors/airtable/workflow-configuration";
import { connectorConnectionIds, matchesOwnedConnectorConnection } from "@/lib/connectors/connection-matching";
import { getConnectorOperation } from "@/lib/connectors/registry";
import { inspectGoogleSpreadsheet } from "@/lib/connectors/google/sheets";
import {
  assertSelectedGoogleSpreadsheet,
  listSelectedGoogleSpreadsheets,
  registerPickerSelectedSpreadsheet,
} from "@/lib/connectors/google/selected-spreadsheets";
import { GOOGLE_LEGACY_SHEETS_SCOPE, GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";
import { listSlackChannels } from "@/lib/connectors/slack/messages";
import { inspectNotionDataSource, listNotionResources } from "@/lib/connectors/notion/actions";
import { notionApiFetch } from "@/lib/connectors/notion/api";
import { NOTION_CAPABILITIES } from "@/lib/connectors/notion/constants";
import { introspectNotionAccessToken, verifyNotionTokenBotIdentity } from "@/lib/connectors/notion/oauth-provider";
import { notionLiveAcceptanceEnabled } from "@/lib/notion-live-acceptance";
import { captureOperationalEvent } from "@/lib/observability";
import { CompiledWorkflowSchema } from "@/lib/schemas/workflow";
import { createAdminClient } from "@/lib/supabase/admin";
import { createImmutableWorkflowVersion, loadWorkflowSnapshot } from "@/lib/workflow-versioning";

export async function disconnectConnector(connectionId: string) {
  const parsed = z.string().uuid().safeParse(connectionId);
  if (!parsed.success) return { ok: false as const, error: "Connection not found." };
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false as const, error: "Unauthorized" };
  const { user } = auth;
  try {
    await revokeConnection(user.id, parsed.data);
    revalidatePath("/connections");
    revalidatePath("/dashboard");
    return { ok: true as const };
  } catch {
    return { ok: false as const, error: "Connection could not be disconnected." };
  }
}

export async function getGoogleConnectionOptions() {
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false as const, error: "Unauthorized", connections: [] };
  const { user } = auth;
  const { data, error } = await createAdminClient().from("connector_connections").select("id,external_account_label,external_account_id,status,granted_scopes").eq("user_id", user.id).eq("workspace_id", auth.workspace.id).eq("provider_family", "google").neq("status", "revoked").order("created_at", { ascending: true });
  if (error) return { ok: false as const, error: "Google connections could not be loaded.", connections: [] };
  return { ok: true as const, connections: (data ?? []).map((item) => ({ id: item.id, label: item.external_account_label ?? item.external_account_id, status: item.status, scopes: item.granted_scopes })) };
}

export async function getConnectorConnectionOptions(providerFamily: string) {
  const provider = z.enum(["airtable", "google", "slack", "notion", "hubspot"]).safeParse(providerFamily);
  if (!provider.success) return { ok: false as const, error: "Connector provider is invalid.", connections: [] };
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false as const, error: "Unauthorized", connections: [] };
  const { user } = auth;
  let query = createAdminClient().from("connector_connections").select("id,external_account_label,external_account_id,status,granted_scopes").eq("user_id", user.id).eq("workspace_id", auth.workspace.id).eq("provider_family", provider.data).neq("status", "revoked");
  if (provider.data === "airtable" || provider.data === "hubspot") query = query.eq("connector_id", provider.data);
  const { data, error } = await query.order("created_at", { ascending: true });
  if (error) return { ok: false as const, error: "Connections could not be loaded.", connections: [] };
  return { ok: true as const, connections: (data ?? []).map((item) => ({ id: item.id, label: item.external_account_label ?? item.external_account_id, status: item.status, scopes: item.granted_scopes })) };
}

export async function configureGoogleWorkflowStep(workflowId: string, stepId: string, connectionId: string) {
  const request = z.object({ workflowId: z.string().uuid(), stepId: z.string().min(1).max(100), connectionId: z.string().uuid() }).safeParse({ workflowId, stepId, connectionId });
  if (!request.success) return { ok: false as const, error: "Choose a valid Google account." };
  const auth = await getAuthenticatedContext(); const user = auth?.user; if (!auth || !user) return { ok: false as const, error: "Unauthorized" };
  const admin = createAdminClient(); const snapshot = await loadWorkflowSnapshot(admin, request.data.workflowId, user.id); if (!snapshot) return { ok: false as const, error: "Workflow not found." };
  const parsed = CompiledWorkflowSchema.safeParse(snapshot.workflow); if (!parsed.success) return { ok: false as const, error: "Workflow configuration is invalid." };
  const index = parsed.data.steps.findIndex((step) => step.id === request.data.stepId); const connector = parsed.data.steps[index]?.config?.connector;
  if (index < 0 || !connector || !connector.connectorId.startsWith("google_")) return { ok: false as const, error: "This is not a Google step." };
  const { data: connection } = await admin.from("connector_connections").select("id,status,granted_scopes").eq("id", request.data.connectionId).eq("user_id", user.id).eq("workspace_id", auth.workspace.id).eq("provider_family", "google").maybeSingle();
  if (!connection || connection.status !== "connected") return { ok: false as const, error: "Reconnect Google to continue." };
  const registered = getConnectorOperation(connector.connectorId, connector.operationKind, connector.operationKey, connector.operationVersion);
  if (!registered) return { ok: false as const, error: "Google operation is unavailable." };
  const missing = registered.operation.requiredScopes.filter((scope) => !connection.granted_scopes.includes(scope));
  if (missing.length) return { ok: false as const, error: "CrazyLoops needs additional Google permission for this workflow.", additionalScopes: missing };
  const workflow = structuredClone(parsed.data); workflow.steps[index] = { ...workflow.steps[index], config: { ...workflow.steps[index].config, connector: { ...connector, connectionId: connection.id } } };
  const setupConfig = { ...snapshot.setupConfig };
  if (connector.connectorId === "google_sheets") {
    delete setupConfig[`${request.data.stepId}-spreadsheetId`];
    delete setupConfig[`${request.data.stepId}-worksheet`];
  }
  try { await createImmutableWorkflowVersion(admin, { workflowId: request.data.workflowId, userId: user.id, expectedVersionId: snapshot.versionId, workflow, setupConfig, scope: "setup", summary: "Selected Google account for connector step." }); revalidatePath(`/dashboard/projects/${request.data.workflowId}`); return { ok: true as const, workflow }; }
  catch { return { ok: false as const, error: "Google account selection could not be saved." }; }
}

export async function configureConnectorWorkflowStep(workflowId: string, stepId: string, connectionId: string) {
  const request = z.object({ workflowId: z.string().uuid(), stepId: z.string().min(1).max(100), connectionId: z.string().uuid() }).safeParse({ workflowId, stepId, connectionId });
  if (!request.success) return { ok: false as const, error: "Choose a valid connected account." };
  const auth = await getAuthenticatedContext(); const user = auth?.user; if (!auth || !user) return { ok: false as const, error: "Unauthorized" };
  const admin = createAdminClient(); const snapshot = await loadWorkflowSnapshot(admin, request.data.workflowId, user.id); if (!snapshot) return { ok: false as const, error: "Workflow not found." };
  const parsed = CompiledWorkflowSchema.safeParse(snapshot.workflow); if (!parsed.success) return { ok: false as const, error: "Workflow configuration is invalid." };
  const index = parsed.data.steps.findIndex((step) => step.id === request.data.stepId); const connector = parsed.data.steps[index]?.config?.connector;
  if (index < 0 || !connector) return { ok: false as const, error: "This is not a connector step." };
  const registered = getConnectorOperation(connector.connectorId, connector.operationKind, connector.operationKey, connector.operationVersion);
  if (!registered) return { ok: false as const, error: "Connector operation is unavailable." };
  const { data: connection } = await admin.from("connector_connections").select("id,user_id,status,connector_id,provider_family,auth_type,granted_scopes,safe_metadata").eq("id", request.data.connectionId).eq("user_id", user.id).eq("workspace_id", auth.workspace.id).eq("provider_family", registered.connector.manifest.providerFamily).in("connector_id", connectorConnectionIds(registered.connector.manifest)).maybeSingle();
  if (!connection || !matchesOwnedConnectorConnection({ connection, authenticatedUserId: user.id, connectionId: request.data.connectionId, manifest: registered.connector.manifest })) return { ok: false as const, error: `Reconnect ${registered.connector.manifest.displayName} to continue.` };
  const missing = registered.operation.requiredScopes.filter((scope) => !connection.granted_scopes.includes(scope));
  const deferredAirtable = connector.connectorId === "airtable" &&
    connector.operationKind === "action" &&
    connector.operationKey === "create_record" &&
    connector.operationVersion === 1 &&
    isDeferredCustomerAirtableConnection(connection);
  if (missing.length && !deferredAirtable) return { ok: false as const, error: `CrazyLoops needs additional ${registered.connector.manifest.displayName} permission for this workflow.`, additionalScopes: missing };
  const workflow = structuredClone(parsed.data); workflow.steps[index] = { ...workflow.steps[index], config: { ...workflow.steps[index].config, connector: { ...connector, connectionId: connection.id } } };
  const setupConfig = { ...snapshot.setupConfig };
  if (connector.connectorId === "google_sheets") {
    delete setupConfig[`${request.data.stepId}-spreadsheetId`];
    delete setupConfig[`${request.data.stepId}-worksheet`];
  }
  try { await createImmutableWorkflowVersion(admin, { workflowId: request.data.workflowId, userId: user.id, expectedVersionId: snapshot.versionId, workflow, setupConfig, scope: "setup", summary: `Selected ${registered.connector.manifest.displayName} account for connector step.` }); revalidatePath(`/dashboard/projects/${request.data.workflowId}`); return { ok: true as const, workflow }; }
  catch { return { ok: false as const, error: "Connected account selection could not be saved." }; }
}

export async function getSlackChannelOptions(connectionId: string) {
  const parsed = z.string().uuid().safeParse(connectionId); if (!parsed.success) return { ok: false as const, error: "Choose a valid Slack workspace.", channels: [] };
  const auth = await getAuthenticatedContext(); const user = auth?.user; if (!user) return { ok: false as const, error: "Unauthorized", channels: [] };
  try { return { ok: true as const, channels: await listSlackChannels({ userId: user.id, connectionId: parsed.data }) }; }
  catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Slack channels could not be loaded.", channels: [] }; }
}

export async function getNotionResourceOptions(connectionId: string) {
  const parsed = z.string().uuid().safeParse(connectionId); if (!parsed.success) return { ok: false as const, error: "Choose a valid Notion workspace.", resources: [] };
  const auth = await getAuthenticatedContext(); const user = auth?.user; if (!auth || !user) return { ok: false as const, error: "Unauthorized", resources: [] };
  const { data: connection } = await createAdminClient().from("connector_connections")
    .select("id,status").eq("id", parsed.data).eq("user_id", user.id).eq("workspace_id", auth.workspace.id)
    .eq("connector_id", "notion").eq("provider_family", "notion").maybeSingle();
  if (!connection || connection.status !== "connected") return { ok: false as const, error: "Notion connection is unavailable.", resources: [] };
  try { return { ok: true as const, resources: await listNotionResources({ userId: user.id, connectionId: parsed.data }) }; }
  catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Accessible Notion resources could not be loaded.", resources: [] }; }
}

/** Existing staging OAuth tokens can be verified without broadening consent. */
export async function verifyNotionConnectionCapabilities(connectionId: string) {
  const parsed = z.string().uuid().safeParse(connectionId);
  if (!parsed.success || !notionLiveAcceptanceEnabled()) return { ok: false as const, error: "Notion verification is unavailable." };
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false as const, error: "Unauthorized" };
  const admin = createAdminClient();
  const { data: connection, error } = await admin.from("connector_connections")
    .select("id,safe_metadata,status,last_refreshed_at")
    .eq("id", parsed.data).eq("user_id", auth.user.id).eq("workspace_id", auth.workspace.id)
    .eq("connector_id", "notion").eq("provider_family", "notion").maybeSingle();
  if (error || !connection || connection.status !== "connected") return { ok: false as const, error: "Notion connection is unavailable." };
  const metadata = connection.safe_metadata && typeof connection.safe_metadata === "object" && !Array.isArray(connection.safe_metadata)
    ? connection.safe_metadata : {};
  const botId = typeof metadata.botId === "string" ? metadata.botId : "";
  try {
    const accessToken = await readConnectionSecret({ userId: auth.user.id, connectionId: connection.id, credentialKey: "access_token" });
    await verifyNotionTokenBotIdentity(accessToken, botId);
    const scopes = await introspectNotionAccessToken(accessToken);
    const update = admin.from("connector_connections").update({
      granted_scopes: scopes,
      safe_metadata: { ...metadata, capabilityVerification: "notion_token_introspection_v1" },
      last_refreshed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", connection.id).eq("user_id", auth.user.id).eq("workspace_id", auth.workspace.id).eq("status", "connected");
    // A reconnect during provider verification must not restore stale grants.
    const guardedUpdate = connection.last_refreshed_at
      ? update.eq("last_refreshed_at", connection.last_refreshed_at)
      : update.is("last_refreshed_at", null);
    const { data: updated, error: updateError } = await guardedUpdate.select("id").single();
    if (updateError || updated?.id !== connection.id) throw new Error("Notion capability verification could not be saved.");
    revalidatePath("/connections");
    return { ok: true as const };
  } catch {
    return { ok: false as const, error: "Notion could not verify this connection's capabilities. No permissions were changed." };
  }
}

/** Read-only, owner-bound staging proof; this does not enable Notion workflows. */
export async function verifyNotionContentRead(connectionId: string, resourceId: string) {
  const parsed = z.object({ connectionId: z.string().uuid(), resourceId: z.string().uuid() }).safeParse({ connectionId, resourceId });
  if (!parsed.success || !notionLiveAcceptanceEnabled()) return { ok: false as const, error: "Notion verification is unavailable." };
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false as const, error: "Unauthorized" };
  const { data: connection, error } = await createAdminClient().from("connector_connections")
    .select("id,status")
    .eq("id", parsed.data.connectionId).eq("user_id", auth.user.id).eq("workspace_id", auth.workspace.id)
    .eq("connector_id", "notion").eq("provider_family", "notion").maybeSingle();
  if (error || !connection || connection.status !== "connected") {
    return { ok: false as const, error: "Notion connection is unavailable." };
  }
  try {
    const resources = await listNotionResources({ userId: auth.user.id, connectionId: connection.id });
    const selected = resources.find((resource) => resource.id.replace(/-/g, "") === parsed.data.resourceId.replace(/-/g, ""));
    if (!selected) {
      return { ok: false as const, error: "The selected Notion resource is not accessible to this connection." };
    }
    const resource = await notionApiFetch({
      userId: auth.user.id,
      connectionId: connection.id,
      requiredCapabilities: [NOTION_CAPABILITIES.readContent],
      path: selected.type === "page" ? `/pages/${parsed.data.resourceId}` : `/data_sources/${parsed.data.resourceId}`,
    });
    if (String(resource.id ?? "").replace(/-/g, "") !== parsed.data.resourceId.replace(/-/g, "")) {
      return { ok: false as const, error: "Notion content could not be verified." };
    }
    await captureOperationalEvent({
      level: "info", event: "notion_live_content_read_success", userId: auth.user.id,
      status: "succeeded", metadata: { resourceType: selected.type },
    });
    return { ok: true as const };
  } catch {
    return { ok: false as const, error: "Notion content could not be read with this connection." };
  }
}

export async function inspectNotionSource(connectionId: string, dataSourceId: string) {
  const parsed = z.object({ connectionId: z.string().uuid(), dataSourceId: z.string().uuid() }).safeParse({ connectionId, dataSourceId }); if (!parsed.success) return { ok: false as const, error: "Choose a valid Notion data source." };
  const auth = await getAuthenticatedContext(); if (!auth) return { ok: false as const, error: "Unauthorized" };
  const { data: connection } = await createAdminClient().from("connector_connections")
    .select("id,status").eq("id", parsed.data.connectionId).eq("user_id", auth.user.id)
    .eq("workspace_id", auth.workspace.id).eq("connector_id", "notion").eq("provider_family", "notion").maybeSingle();
  if (!connection || connection.status !== "connected") return { ok: false as const, error: "Notion connection is unavailable." };
  try { return { ok: true as const, dataSource: await inspectNotionDataSource({ userId: auth.user.id, connectionId: parsed.data.connectionId, dataSourceId: parsed.data.dataSourceId }) }; }
  catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Notion data source could not be inspected." }; }
}

export async function getGooglePickerConfiguration(connectionId: string) {
  const parsed = z.string().uuid().safeParse(connectionId);
  if (!parsed.success) return { ok: false as const, error: "Choose a valid Google account." };
  const auth = await getAuthenticatedContext(); const user = auth?.user;
  if (!auth || !user) return { ok: false as const, error: "Unauthorized" };
  const { data: connection } = await createAdminClient().from("connector_connections")
    .select("id,status,external_account_label,granted_scopes")
    .eq("id", parsed.data).eq("user_id", user.id).eq("workspace_id", auth.workspace.id).eq("provider_family", "google").maybeSingle();
  if (!connection || connection.status !== "connected" || !connection.granted_scopes.includes(GOOGLE_SCOPES.driveFile) || connection.granted_scopes.includes(GOOGLE_LEGACY_SHEETS_SCOPE)) {
    return { ok: false as const, error: "Reconnect Google Sheets with per-file access to continue." };
  }
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const apiKey = process.env.GOOGLE_PICKER_API_KEY;
  const appId = process.env.GOOGLE_PICKER_APP_ID;
  if (!clientId || !apiKey || !appId) return { ok: false as const, error: "Google Picker is not configured yet." };
  return { ok: true as const, config: { clientId, apiKey, appId, accountHint: connection.external_account_label ?? undefined } };
}

export async function getSelectedGoogleSpreadsheetOptions(connectionId: string) {
  const parsed = z.string().uuid().safeParse(connectionId);
  if (!parsed.success) return { ok: false as const, error: "Choose a valid Google account.", spreadsheets: [] };
  const auth = await getAuthenticatedContext(); const user = auth?.user;
  if (!auth || !user) return { ok: false as const, error: "Unauthorized", spreadsheets: [] };
  const { data: connection } = await createAdminClient().from("connector_connections")
    .select("id,status,granted_scopes").eq("id", parsed.data).eq("user_id", user.id).eq("workspace_id", auth.workspace.id).eq("provider_family", "google").maybeSingle();
  if (!connection || connection.status !== "connected" || !connection.granted_scopes.includes(GOOGLE_SCOPES.driveFile)) {
    return { ok: false as const, error: "Reconnect Google Sheets to continue.", spreadsheets: [] };
  }
  try { return { ok: true as const, spreadsheets: await listSelectedGoogleSpreadsheets({ userId: user.id, workspaceId: auth.workspace.id, connectionId: parsed.data }) }; }
  catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Selected spreadsheets could not be loaded.", spreadsheets: [] }; }
}

export async function selectGoogleSpreadsheetForWorkflow(
  workflowId: string,
  stepId: string,
  connectionId: string,
  spreadsheetId: string,
  pickerAccessToken?: string,
) {
  const request = z.object({
    workflowId: z.string().uuid(),
    stepId: z.string().min(1).max(100),
    connectionId: z.string().uuid(),
    spreadsheetId: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
    pickerAccessToken: z.string().min(1).max(4_096).optional(),
  }).safeParse({ workflowId, stepId, connectionId, spreadsheetId, pickerAccessToken });
  if (!request.success) return { ok: false as const, error: "Choose a valid spreadsheet through Google Picker." };
  const auth = await getAuthenticatedContext(); const user = auth?.user;
  if (!auth || !user) return { ok: false as const, error: "Unauthorized" };
  const admin = createAdminClient();
  const snapshot = await loadWorkflowSnapshot(admin, request.data.workflowId, user.id);
  if (!snapshot) return { ok: false as const, error: "Workflow not found." };
  const workflow = CompiledWorkflowSchema.safeParse(snapshot.workflow);
  if (!workflow.success) return { ok: false as const, error: "Workflow configuration is invalid." };
  const step = workflow.data.steps.find((item) => item.id === request.data.stepId);
  if (step?.config?.connector?.connectorId !== "google_sheets" || step.config.connector.connectionId !== request.data.connectionId) {
    return { ok: false as const, error: "Choose the Google account for this Sheets step first." };
  }
  try {
    if (request.data.pickerAccessToken) {
      await registerPickerSelectedSpreadsheet({
        userId: user.id,
        workspaceId: auth.workspace.id,
        connectionId: request.data.connectionId,
        spreadsheetId: request.data.spreadsheetId,
        pickerAccessToken: request.data.pickerAccessToken,
      });
    } else {
      await assertSelectedGoogleSpreadsheet({ userId: user.id, workspaceId: auth.workspace.id, connectionId: request.data.connectionId, spreadsheetId: request.data.spreadsheetId });
    }
    const spreadsheet = await inspectGoogleSpreadsheet({ userId: user.id, workspaceId: auth.workspace.id, connectionId: request.data.connectionId, spreadsheetId: request.data.spreadsheetId });
    const setupConfig = { ...snapshot.setupConfig, [`${request.data.stepId}-spreadsheetId`]: request.data.spreadsheetId };
    delete setupConfig[`${request.data.stepId}-worksheet`];
    await createImmutableWorkflowVersion(admin, {
      workflowId: request.data.workflowId,
      userId: user.id,
      expectedVersionId: snapshot.versionId,
      workflow: workflow.data,
      setupConfig,
      scope: "setup",
      summary: "Selected a Google spreadsheet through Google Picker.",
    });
    revalidatePath(`/dashboard/projects/${request.data.workflowId}`);
    return { ok: true as const, spreadsheet };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Spreadsheet selection could not be saved." };
  }
}

/** Work OS selection is independent of a workflow draft, but never of the owner/workspace. */
export async function selectGoogleSpreadsheetForWorkOs(connectionId: string, spreadsheetId: string, pickerAccessToken?: string) {
  const request = z.object({
    connectionId: z.string().uuid(),
    spreadsheetId: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
    pickerAccessToken: z.string().min(1).max(4_096).optional(),
  }).safeParse({ connectionId, spreadsheetId, pickerAccessToken });
  if (!request.success) return { ok: false as const, error: "Choose a valid spreadsheet through Google Picker." };
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false as const, error: "Unauthorized" };
  try {
    if (request.data.pickerAccessToken) {
      await registerPickerSelectedSpreadsheet({
        userId: auth.user.id, workspaceId: auth.workspace.id,
        connectionId: request.data.connectionId, spreadsheetId: request.data.spreadsheetId,
        pickerAccessToken: request.data.pickerAccessToken,
      });
    } else {
      await assertSelectedGoogleSpreadsheet({
        userId: auth.user.id, workspaceId: auth.workspace.id,
        connectionId: request.data.connectionId, spreadsheetId: request.data.spreadsheetId,
      });
    }
    const spreadsheet = await inspectGoogleSpreadsheet({
      userId: auth.user.id, workspaceId: auth.workspace.id,
      connectionId: request.data.connectionId, spreadsheetId: request.data.spreadsheetId,
    });
    revalidatePath("/connections");
    return { ok: true as const, spreadsheet };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Spreadsheet selection could not be saved." };
  }
}
