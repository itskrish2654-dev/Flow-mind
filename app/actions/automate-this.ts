"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { AutomationConfigurationSchema, compileAutomationSuggestion } from "@/lib/automate-this-plan";
import { getAuthenticatedContext } from "@/lib/auth";
import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";
import { PLAN_ENTITLEMENTS } from "@/lib/security/limits";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { createImmutableWorkflowVersion, loadWorkflowSnapshot } from "@/lib/workflow-versioning";
import { deleteWorkflow, setWorkflowPublication } from "@/app/actions/workflow";

export async function dismissAutomationSuggestion(formData: FormData) {
  const id = z.uuid().safeParse(formData.get("suggestionId"));
  if (!id.success) throw new Error("Suggestion is unavailable.");
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Sign in to review automations.");
  const { data, error } = await createAdminClient().from("automation_suggestions")
    .update({ status: "dismissed", dismissed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id.data).eq("workspace_id", auth.workspace.id)
    .eq("owner_user_id", auth.user.id).eq("status", "suggested")
    .select("id").maybeSingle();
  if (error || !data) throw new Error("Suggestion is no longer available.");
  revalidatePath("/my-day");
  revalidatePath("/automations");
}

export async function configureAutomationSuggestion(formData: FormData) {
  const id = z.uuid().safeParse(formData.get("suggestionId"));
  if (!id.success) throw new Error("Suggestion is unavailable.");
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Sign in to review automations.");
  const admin = createAdminClient();
  const { data: suggestion, error } = await admin.from("automation_suggestions").select("*")
    .eq("id", id.data).eq("workspace_id", auth.workspace.id)
    .eq("owner_user_id", auth.user.id).in("status", ["suggested", "configured", "active", "paused"]).maybeSingle();
  if (error || !suggestion) throw new Error("Suggestion is unavailable.");
  const configuration = AutomationConfigurationSchema.parse({
    kind: suggestion.pattern_kind,
    matchTitle: suggestion.source_title,
    sourceType: suggestion.source_type,
    instruction: formData.get("instruction"),
    ...(suggestion.pattern_kind === "gmail_follow_up" ? {
      waitDays: Number(formData.get("waitDays")),
      gmailConnectionId: formData.get("gmailConnectionId"),
      recipientEmail: formData.get("recipientEmail"),
      subject: formData.get("subject"),
    } : {}),
  });
  if (configuration.kind === "gmail_follow_up") {
    const { data: connection, error: connectionError } = await admin.from("connector_connections")
      .select("id,granted_scopes").eq("id", configuration.gmailConnectionId)
      .eq("workspace_id", auth.workspace.id).eq("user_id", auth.user.id)
      .eq("provider_family", "google").eq("status", "connected").maybeSingle();
    if (connectionError || !connection || !connection.granted_scopes.includes(GOOGLE_SCOPES.gmailSend)) {
      throw new Error("Choose your own connected Gmail account with send permission.");
    }
  }
  const compiled = compileAutomationSuggestion(suggestion, configuration);
  const setup = { automate_this: JSON.stringify(configuration) };
  let workflowId = suggestion.workflow_id;
  if (workflowId) {
    const snapshot = await loadWorkflowSnapshot(admin, workflowId, auth.user.id);
    if (!snapshot || snapshot.workspaceId !== auth.workspace.id) throw new Error("Automation draft is unavailable.");
    await createImmutableWorkflowVersion(admin, {
      workflowId, userId: auth.user.id, expectedVersionId: snapshot.versionId,
      workflow: compiled, setupConfig: setup, scope: "workflow_structure",
      summary: "Reviewed Automate This configuration.",
    });
  } else {
    const { data: created, error: createError } = await admin.rpc("create_versioned_workflow_with_quota", {
      p_user_id: auth.user.id, p_name: compiled.workflowName.slice(0, 80),
      p_prompt: `Prepare matching work: ${suggestion.source_title}`,
      p_compiled_workflow: compiled as unknown as Json, p_setup_config: setup,
      p_limit: PLAN_ENTITLEMENTS.free.workflows,
    });
    workflowId = created?.[0]?.workflow_id ?? null;
    if (createError || !workflowId) throw new Error("Automation draft could not be saved.");
  }
  const { error: updateError } = await admin.from("automation_suggestions").update({
    workflow_id: workflowId, configuration: configuration as Json,
    status: suggestion.status === "active" ? "active" : "configured",
    updated_at: new Date().toISOString(),
  }).eq("id", suggestion.id).eq("workspace_id", auth.workspace.id)
    .eq("owner_user_id", auth.user.id);
  if (updateError) throw new Error("Automation draft could not be linked to its evidence.");
  revalidatePath("/automations");
  redirect(`/automations/${suggestion.id}`);
}

export async function changeAutomationActivation(formData: FormData) {
  const input = z.object({ suggestionId: z.uuid(), activate: z.enum(["yes", "no"]) }).safeParse({
    suggestionId: formData.get("suggestionId"), activate: formData.get("activate"),
  });
  if (!input.success) throw new Error("Automation choice is invalid.");
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Sign in to review automations.");
  const { data: suggestion, error } = await auth.supabase.from("automation_suggestions")
    .select("id,workflow_id,status").eq("id", input.data.suggestionId)
    .eq("workspace_id", auth.workspace.id).eq("owner_user_id", auth.user.id).maybeSingle();
  if (error || !suggestion?.workflow_id || !["configured", "active", "paused"].includes(suggestion.status)) {
    throw new Error("Review and configure this automation first.");
  }
  const result = await setWorkflowPublication(suggestion.workflow_id, input.data.activate === "yes");
  if (!result.ok) throw new Error(result.error);
  revalidatePath("/automations");
  revalidatePath(`/automations/${suggestion.id}`);
  redirect(`/automations/${suggestion.id}`);
}

export async function disableAutomationSuggestion(formData: FormData) {
  const id = z.uuid().safeParse(formData.get("suggestionId"));
  if (!id.success) throw new Error("Automation is unavailable.");
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Sign in to manage automations.");
  const admin = createAdminClient();
  const { data: suggestion, error } = await admin.from("automation_suggestions")
    .select("id,workflow_id,status").eq("id", id.data)
    .eq("workspace_id", auth.workspace.id).eq("owner_user_id", auth.user.id).maybeSingle();
  if (error || !suggestion?.workflow_id || !["configured", "active", "paused"].includes(suggestion.status)) {
    throw new Error("Automation is unavailable.");
  }
  const removed = await deleteWorkflow(suggestion.workflow_id);
  if (!removed.ok) throw new Error(removed.error);
  const { error: updateError } = await admin.from("automation_suggestions")
    .update({ status: "disabled", updated_at: new Date().toISOString() })
    .eq("id", suggestion.id).eq("owner_user_id", auth.user.id).eq("workspace_id", auth.workspace.id);
  if (updateError) throw new Error("Workflow was disabled, but automation status needs review.");
  const { error: activityError } = await admin.from("activity_events").insert({
    workspace_id: auth.workspace.id, owner_user_id: auth.user.id,
    actor_user_id: auth.user.id, visibility: "private",
    event_type: "automation_disabled", source_type: "automation", source_id: suggestion.id,
    event_key: `automation:disabled:${suggestion.id}`,
  });
  if (activityError && activityError.code !== "23505") throw new Error("Automation was disabled, but Activity needs review.");
  revalidatePath("/automations");
  revalidatePath(`/automations/${suggestion.id}`);
}
