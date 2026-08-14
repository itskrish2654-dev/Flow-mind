"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { revokeConnection } from "@/lib/connectors/connection-vault";
import { getConnectorOperation } from "@/lib/connectors/registry";
import { inspectGoogleSpreadsheet } from "@/lib/connectors/google/sheets";
import { listSlackChannels } from "@/lib/connectors/slack/messages";
import { inspectNotionDataSource, listNotionResources } from "@/lib/connectors/notion/actions";
import { CompiledWorkflowSchema } from "@/lib/schemas/workflow";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { createImmutableWorkflowVersion, loadWorkflowSnapshot } from "@/lib/workflow-versioning";

export async function disconnectConnector(connectionId: string) {
  const parsed = z.string().uuid().safeParse(connectionId);
  if (!parsed.success) return { ok: false as const, error: "Connection not found." };
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Unauthorized" };
  try { await revokeConnection(user.id, parsed.data); revalidatePath("/settings/connections"); return { ok: true as const }; }
  catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Connection could not be disconnected." }; }
}

export async function getGoogleConnectionOptions() {
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Unauthorized", connections: [] };
  const { data, error } = await createAdminClient().from("connector_connections").select("id,external_account_label,external_account_id,status,granted_scopes").eq("user_id", user.id).eq("provider_family", "google").neq("status", "revoked").order("created_at", { ascending: true });
  if (error) return { ok: false as const, error: "Google connections could not be loaded.", connections: [] };
  return { ok: true as const, connections: (data ?? []).map((item) => ({ id: item.id, label: item.external_account_label ?? item.external_account_id, status: item.status, scopes: item.granted_scopes })) };
}

export async function getConnectorConnectionOptions(providerFamily: string) {
  const provider = z.enum(["google", "slack", "notion"]).safeParse(providerFamily);
  if (!provider.success) return { ok: false as const, error: "Connector provider is invalid.", connections: [] };
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Unauthorized", connections: [] };
  const { data, error } = await createAdminClient().from("connector_connections").select("id,external_account_label,external_account_id,status,granted_scopes").eq("user_id", user.id).eq("provider_family", provider.data).neq("status", "revoked").order("created_at", { ascending: true });
  if (error) return { ok: false as const, error: "Connections could not be loaded.", connections: [] };
  return { ok: true as const, connections: (data ?? []).map((item) => ({ id: item.id, label: item.external_account_label ?? item.external_account_id, status: item.status, scopes: item.granted_scopes })) };
}

export async function configureGoogleWorkflowStep(workflowId: string, stepId: string, connectionId: string) {
  const request = z.object({ workflowId: z.string().uuid(), stepId: z.string().min(1).max(100), connectionId: z.string().uuid() }).safeParse({ workflowId, stepId, connectionId });
  if (!request.success) return { ok: false as const, error: "Choose a valid Google account." };
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser(); if (!user) return { ok: false as const, error: "Unauthorized" };
  const admin = createAdminClient(); const snapshot = await loadWorkflowSnapshot(admin, request.data.workflowId, user.id); if (!snapshot) return { ok: false as const, error: "Workflow not found." };
  const parsed = CompiledWorkflowSchema.safeParse(snapshot.workflow); if (!parsed.success) return { ok: false as const, error: "Workflow configuration is invalid." };
  const index = parsed.data.steps.findIndex((step) => step.id === request.data.stepId); const connector = parsed.data.steps[index]?.config?.connector;
  if (index < 0 || !connector || !connector.connectorId.startsWith("google_")) return { ok: false as const, error: "This is not a Google step." };
  const { data: connection } = await admin.from("connector_connections").select("id,status,granted_scopes").eq("id", request.data.connectionId).eq("user_id", user.id).eq("provider_family", "google").maybeSingle();
  if (!connection || connection.status !== "connected") return { ok: false as const, error: "Reconnect Google to continue." };
  const registered = getConnectorOperation(connector.connectorId, connector.operationKind, connector.operationKey, connector.operationVersion);
  if (!registered) return { ok: false as const, error: "Google operation is unavailable." };
  const missing = registered.operation.requiredScopes.filter((scope) => !connection.granted_scopes.includes(scope));
  if (missing.length) return { ok: false as const, error: "CrazyLoops needs additional Google permission for this workflow.", additionalScopes: missing };
  const workflow = structuredClone(parsed.data); workflow.steps[index] = { ...workflow.steps[index], config: { ...workflow.steps[index].config, connector: { ...connector, connectionId: connection.id } } };
  try { await createImmutableWorkflowVersion(admin, { workflowId: request.data.workflowId, userId: user.id, expectedVersionId: snapshot.versionId, workflow, setupConfig: snapshot.setupConfig, scope: "setup", summary: "Selected Google account for connector step." }); revalidatePath(`/dashboard/projects/${request.data.workflowId}`); return { ok: true as const, workflow }; }
  catch { return { ok: false as const, error: "Google account selection could not be saved." }; }
}

export async function configureConnectorWorkflowStep(workflowId: string, stepId: string, connectionId: string) {
  const request = z.object({ workflowId: z.string().uuid(), stepId: z.string().min(1).max(100), connectionId: z.string().uuid() }).safeParse({ workflowId, stepId, connectionId });
  if (!request.success) return { ok: false as const, error: "Choose a valid connected account." };
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser(); if (!user) return { ok: false as const, error: "Unauthorized" };
  const admin = createAdminClient(); const snapshot = await loadWorkflowSnapshot(admin, request.data.workflowId, user.id); if (!snapshot) return { ok: false as const, error: "Workflow not found." };
  const parsed = CompiledWorkflowSchema.safeParse(snapshot.workflow); if (!parsed.success) return { ok: false as const, error: "Workflow configuration is invalid." };
  const index = parsed.data.steps.findIndex((step) => step.id === request.data.stepId); const connector = parsed.data.steps[index]?.config?.connector;
  if (index < 0 || !connector) return { ok: false as const, error: "This is not a connector step." };
  const registered = getConnectorOperation(connector.connectorId, connector.operationKind, connector.operationKey, connector.operationVersion);
  if (!registered) return { ok: false as const, error: "Connector operation is unavailable." };
  const { data: connection } = await admin.from("connector_connections").select("id,status,provider_family,granted_scopes").eq("id", request.data.connectionId).eq("user_id", user.id).eq("provider_family", registered.connector.manifest.providerFamily).maybeSingle();
  if (!connection || connection.status !== "connected") return { ok: false as const, error: `Reconnect ${registered.connector.manifest.displayName} to continue.` };
  const missing = registered.operation.requiredScopes.filter((scope) => !connection.granted_scopes.includes(scope));
  if (missing.length) return { ok: false as const, error: `CrazyLoops needs additional ${registered.connector.manifest.displayName} permission for this workflow.`, additionalScopes: missing };
  const workflow = structuredClone(parsed.data); workflow.steps[index] = { ...workflow.steps[index], config: { ...workflow.steps[index].config, connector: { ...connector, connectionId: connection.id } } };
  try { await createImmutableWorkflowVersion(admin, { workflowId: request.data.workflowId, userId: user.id, expectedVersionId: snapshot.versionId, workflow, setupConfig: snapshot.setupConfig, scope: "setup", summary: `Selected ${registered.connector.manifest.displayName} account for connector step.` }); revalidatePath(`/dashboard/projects/${request.data.workflowId}`); return { ok: true as const, workflow }; }
  catch { return { ok: false as const, error: "Connected account selection could not be saved." }; }
}

export async function getSlackChannelOptions(connectionId: string) {
  const parsed = z.string().uuid().safeParse(connectionId); if (!parsed.success) return { ok: false as const, error: "Choose a valid Slack workspace.", channels: [] };
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser(); if (!user) return { ok: false as const, error: "Unauthorized", channels: [] };
  try { return { ok: true as const, channels: await listSlackChannels({ userId: user.id, connectionId: parsed.data }) }; }
  catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Slack channels could not be loaded.", channels: [] }; }
}

export async function getNotionResourceOptions(connectionId: string) {
  const parsed = z.string().uuid().safeParse(connectionId); if (!parsed.success) return { ok: false as const, error: "Choose a valid Notion workspace.", resources: [] };
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser(); if (!user) return { ok: false as const, error: "Unauthorized", resources: [] };
  try { return { ok: true as const, resources: await listNotionResources({ userId: user.id, connectionId: parsed.data }) }; }
  catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Accessible Notion resources could not be loaded.", resources: [] }; }
}

export async function inspectNotionSource(connectionId: string, dataSourceId: string) {
  const parsed = z.object({ connectionId: z.string().uuid(), dataSourceId: z.string().max(100) }).safeParse({ connectionId, dataSourceId }); if (!parsed.success) return { ok: false as const, error: "Choose a valid Notion data source." };
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser(); if (!user) return { ok: false as const, error: "Unauthorized" };
  try { return { ok: true as const, dataSource: await inspectNotionDataSource({ userId: user.id, connectionId: parsed.data.connectionId, dataSourceId: parsed.data.dataSourceId }) }; }
  catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Notion data source could not be inspected." }; }
}

export async function inspectGoogleSheet(connectionId: string, spreadsheetId: string) {
  const parsed = z.object({ connectionId: z.string().uuid(), spreadsheetId: z.string().max(500) }).safeParse({ connectionId, spreadsheetId }); if (!parsed.success) return { ok: false as const, error: "Choose a valid spreadsheet." };
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser(); if (!user) return { ok: false as const, error: "Unauthorized" };
  try { return { ok: true as const, spreadsheet: await inspectGoogleSpreadsheet({ userId: user.id, connectionId: parsed.data.connectionId, spreadsheetId: parsed.data.spreadsheetId }) }; }
  catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Spreadsheet could not be inspected." }; }
}
