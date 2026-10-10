import "server-only";

import { createHash } from "node:crypto";

import { ActionPreviewSchema, approvalSnapshotFromPreview } from "@/lib/action-execution-core";
import { matchingAutomationWorkItem } from "@/lib/automate-this-core";
import { AutomationConfigurationSchema, isReviewedAutomateThisWorkflow } from "@/lib/automate-this-plan";
import { executeAiText } from "@/lib/ai-execution";
import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";
import { completeDurableExecution, createDurableExecution, createExecutionStateHooks, markExecutionRunning } from "@/lib/execution-state";
import { CompiledWorkflowSchema } from "@/lib/schemas/workflow";
import { SECURITY_LIMITS, enforceRateLimit, enforceUsageQuota, withConcurrencyLease } from "@/lib/security/limits";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/types";
import { LIKELY_WORKBENCH_SECRET, parseWorkbenchModelResult } from "@/lib/workbench-core";
import { executeWorkflowSteps } from "@/lib/workflow-execution";

type WorkItem = Database["public"]["Tables"]["work_items"]["Row"];
type Run = Database["public"]["Tables"]["automation_work_item_runs"]["Row"];
type Suggestion = Database["public"]["Tables"]["automation_suggestions"]["Row"];

function stableUuid(material: string): string {
  const hex = createHash("sha256").update(material).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function persistPreparedDraft(input: {
  run: Run; workItem: WorkItem; instruction: string; aiResult: string;
}) {
  const admin = createAdminClient();
  const parsed = parseWorkbenchModelResult(input.aiResult, []);
  if (LIKELY_WORKBENCH_SECRET.test(parsed.content)) throw new Error("AI result contains credential material.");
  const turnKey = stableUuid(`${input.run.id}:ai-turn`);
  const { data: priorTurn, error: turnReadError } = await admin.from("work_item_ai_turns").select("*")
    .eq("workspace_id", input.run.workspace_id).eq("owner_user_id", input.run.owner_user_id)
    .eq("work_item_id", input.workItem.id).eq("request_key", turnKey).maybeSingle();
  if (turnReadError) throw new Error("Prepared result state could not be checked.");
  let turn = priorTurn;
  if (!turn) {
    const { data, error } = await admin.from("work_item_ai_turns").insert({
      workspace_id: input.run.workspace_id, owner_user_id: input.run.owner_user_id,
      work_item_id: input.workItem.id, request_key: turnKey,
      mode: "WRITING", instruction: input.instruction,
    }).select("*").single();
    if (error || !data) throw new Error("Prepared AI result could not be started.");
    turn = data;
  }
  if (turn.status === "processing") {
    const { data, error } = await admin.from("work_item_ai_turns").update({
      status: "completed", response_title: parsed.title, response_content: parsed.content,
      source_references: [], finished_at: new Date().toISOString(),
    }).eq("id", turn.id).eq("status", "processing").select("*").maybeSingle();
    if (error || !data) throw new Error("Prepared AI result could not be completed.");
    turn = data;
  }
  if (turn.status !== "completed" || turn.response_title !== parsed.title || turn.response_content !== parsed.content) {
    throw new Error("Prepared AI result changed during replay.");
  }
  const deliverableKey = stableUuid(`${input.run.id}:draft`);
  const { data: existing, error: existingError } = await admin.from("work_item_deliverables").select("*")
    .eq("workspace_id", input.run.workspace_id).eq("owner_user_id", input.run.owner_user_id)
    .eq("work_item_id", input.workItem.id).eq("request_key", deliverableKey).maybeSingle();
  if (existingError) throw new Error("Prepared draft state could not be checked.");
  if (existing) {
    if (existing.ai_turn_id !== turn.id || existing.content !== parsed.content) throw new Error("Prepared draft changed during replay.");
    return parsed;
  }
  const { error: insertError } = await admin.from("work_item_deliverables").insert({
    workspace_id: input.run.workspace_id, owner_user_id: input.run.owner_user_id,
    work_item_id: input.workItem.id, goal_id: input.workItem.goal_id,
    ai_turn_id: turn.id, request_key: deliverableKey,
    title: parsed.title, content: parsed.content, source_references: [], ai_assisted: true,
  });
  if (insertError) throw new Error("Prepared draft could not be saved.");
  return parsed;
}

async function prepareGmailApproval(input: {
  run: Run; configuration: Extract<ReturnType<typeof AutomationConfigurationSchema.parse>, { kind: "gmail_follow_up" }>;
  executionId: string; body: string;
}) {
  if (input.body.length > 500) throw new Error("Prepared email is too long for an exact approval preview.");
  const admin = createAdminClient();
  const { data: connection, error } = await admin.from("connector_connections")
    .select("id,granted_scopes").eq("id", input.configuration.gmailConnectionId)
    .eq("workspace_id", input.run.workspace_id).eq("user_id", input.run.owner_user_id)
    .eq("provider_family", "google").eq("status", "connected").maybeSingle();
  if (error || !connection?.granted_scopes.includes(GOOGLE_SCOPES.gmailSend)) {
    throw new Error("The selected Gmail connection is no longer available.");
  }
  const preview = ActionPreviewSchema.parse({
    version: 1, capabilityId: "gmail_send_email", connectorId: "google_gmail",
    operationKey: "send_email", operationVersion: 1, connectionId: connection.id,
    actionTitle: "Review prepared Gmail follow-up",
    actionSummary: `Review the prepared follow-up to ${input.configuration.recipientEmail}. Nothing has been sent.`,
    approvalReason: "Sending externally requires approval of the exact recipient, subject, and body.",
    target: { kind: "external_resource", label: input.configuration.recipientEmail, reference: input.configuration.recipientEmail },
    parameters: [
      { name: "to", label: "To", value: input.configuration.recipientEmail },
      { name: "subject", label: "Subject", value: input.configuration.subject },
      { name: "body", label: "Email body", value: input.body },
    ],
  });
  const { data, error: rpcError } = await admin.rpc("create_automation_action_approval", {
    p_actor_user_id: input.run.owner_user_id,
    p_workflow_execution_id: input.executionId,
    p_request_key: `automation-action:${input.executionId}`,
    p_action_title: preview.actionTitle, p_action_summary: preview.actionSummary,
    p_approval_reason: preview.approvalReason, p_connection_id: connection.id,
    p_action_snapshot: approvalSnapshotFromPreview(preview) as Json,
  });
  if (rpcError || data?.length !== 1) throw new Error("Prepared Gmail action could not be queued for approval.");
}

async function recordRunFailure(run: Run) {
  const admin = createAdminClient();
  // Failure is durable and visible to the owner; it does not silently disappear.
  const { error: itemError } = await admin.from("work_items").insert({
    workspace_id: run.workspace_id, assignee_user_id: run.owner_user_id,
    title: "Automation needs your attention", summary: "The prepared work could not be completed safely.",
    why_it_matters: "The original work was not hidden or marked complete.",
    suggested_action: "Review the automation and the original Work Item before trying again.",
    source_type: "system", source_id: run.id, source_label: "Automation",
    status: "needs_you", priority: "normal", dedupe_key: `automation-failure:${run.id}`,
  });
  if (itemError && itemError.code !== "23505") throw new Error("Automation failure Work Item could not be created.");
  const { error: activityError } = await admin.from("activity_events").insert({
    workspace_id: run.workspace_id, owner_user_id: run.owner_user_id,
    actor_user_id: null, visibility: "private", event_type: "automation_failed",
    source_type: "automation", source_id: run.suggestion_id, workflow_id: run.workflow_id,
    work_item_id: run.work_item_id, event_key: `automation:failed:${run.id}`,
  });
  if (activityError && activityError.code !== "23505") throw new Error("Automation failure Activity could not be recorded.");
}

async function failRun(run: Run, token: string, reason: string) {
  const admin = createAdminClient();
  const { data: failed, error: failError } = await admin.from("automation_work_item_runs").update({ status: "failed", claim_token: null,
    lease_until: null, failure_category: reason, updated_at: new Date().toISOString() })
    .eq("id", run.id).eq("claim_token", token).eq("status", "running").select("id").maybeSingle();
  if (failError || !failed) throw new Error("Automation failure could not be recorded.");
  await recordRunFailure(run);
}

async function reconcileExpiredRuns(now: Date) {
  const admin = createAdminClient();
  const { data: expired, error } = await admin.from("automation_work_item_runs").select("*")
    .eq("status", "running").lt("lease_until", now.toISOString())
    .order("lease_until", { ascending: true }).limit(20);
  if (error) throw new Error("Interrupted automation runs could not be checked.");
  let failed = 0;
  for (const run of expired) {
    // A worker may have stopped after producing a durable draft or approval.
    // Never replay an uncertain outcome: surface it for employee review.
    const { data: changed, error: updateError } = await admin.from("automation_work_item_runs")
      .update({ status: "failed", claim_token: null, lease_until: null,
        failure_category: "interrupted_execution", updated_at: now.toISOString() })
      .eq("id", run.id).eq("status", "running")
      .lt("lease_until", now.toISOString()).select("id").maybeSingle();
    if (updateError) throw new Error("Interrupted automation run could not be closed.");
    if (changed) {
      await recordRunFailure(run);
      failed += 1;
    }
  }
  return failed;
}

async function executeRun(run: Run, suggestion: Suggestion, workItem: WorkItem,
  workflow: { name: string; published_version_id: string }, configuration: ReturnType<typeof AutomationConfigurationSchema.parse>) {
  const admin = createAdminClient();
  const { data: claimed, error: claimError } = await admin.rpc("claim_automation_work_item_run", {
    p_run_id: run.id, p_owner_user_id: run.owner_user_id,
  });
  const token = claimed?.[0]?.claim_token;
  if (claimError || !claimed?.[0]?.claimed || !token) return false;
  try {
    const { error: activityError } = await admin.from("activity_events").insert({
      workspace_id: run.workspace_id, owner_user_id: run.owner_user_id,
      actor_user_id: null, visibility: "private", event_type: "automation_triggered",
      source_type: "automation", source_id: suggestion.id, workflow_id: run.workflow_id,
      work_item_id: workItem.id, event_key: `automation:triggered:${run.id}`,
    });
    if (activityError && activityError.code !== "23505") throw new Error("Automation trigger Activity could not be recorded.");
    const { data: version, error: versionError } = await admin.from("workflow_versions")
      .select("compiled_workflow,setup_config").eq("id", run.workflow_version_id)
      .eq("workflow_id", run.workflow_id).eq("user_id", run.owner_user_id).maybeSingle();
    const parsed = CompiledWorkflowSchema.safeParse(version?.compiled_workflow);
    if (versionError || !parsed.success || !isReviewedAutomateThisWorkflow(parsed.data)) {
      throw new Error("Reviewed workflow version is unavailable.");
    }
    const pinnedConfig = AutomationConfigurationSchema.safeParse(
      typeof version?.setup_config === "object" && version.setup_config && !Array.isArray(version.setup_config)
        ? JSON.parse(String(version.setup_config.automate_this ?? "null")) : null,
    );
    if (!pinnedConfig.success || JSON.stringify(pinnedConfig.data) !== JSON.stringify(configuration)
      || suggestion.workflow_id !== run.workflow_id || workflow.published_version_id !== run.workflow_version_id) {
      throw new Error("The published automation configuration changed.");
    }
    const inputValues = {
      work_item_id: workItem.id, title: workItem.title,
      details: workItem.summary ?? "", why_it_matters: workItem.why_it_matters ?? "",
      due_at: workItem.due_at ?? "", source: workItem.source_label ?? workItem.source_type,
    };
    const durable = await createDurableExecution(admin, {
      workflowId: run.workflow_id, workflowVersionId: run.workflow_version_id,
      userId: run.owner_user_id, triggerType: "work_item",
      triggerMetadata: { workItemId: workItem.id, suggestionId: suggestion.id },
      idempotencyKey: `automate-this:${run.workflow_id}:${workItem.id}`,
      inputData: inputValues,
    });
    const { error: bindError } = await admin.from("automation_work_item_runs")
      .update({ execution_id: durable.id, updated_at: new Date().toISOString() })
      .eq("id", run.id).eq("claim_token", token).eq("status", "running");
    if (bindError) throw new Error("Automation execution could not be linked.");
    let aiResult: string | null = null;
    if (durable.created) {
      await markExecutionRunning(admin, durable.id);
      const result = await withConcurrencyLease("user-execution", [run.owner_user_id], 2, async () => {
        await enforceUsageQuota(run.owner_user_id, "executions");
        return executeWorkflowSteps({
          userId: run.owner_user_id, workflowId: run.workflow_id,
          workflowName: workflow.name, steps: parsed.data.steps,
          inputValues, mode: "scheduled", telemetryExecutionId: durable.id,
          workflowVersionId: run.workflow_version_id,
          idempotencyKey: `automate-this:${run.workflow_id}:${workItem.id}`,
          stateHooks: createExecutionStateHooks(admin, durable.id, {
            userId: run.owner_user_id, workflowId: run.workflow_id,
            workflowVersionId: run.workflow_version_id,
          }),
          executeAi: async (request) => {
            await enforceRateLimit("ai-execution", [run.owner_user_id], SECURITY_LIMITS.ai);
            await enforceUsageQuota(run.owner_user_id, "ai_generations");
            await enforceUsageQuota(run.owner_user_id, "ai_input_chars", request.instruction.length + request.content.length);
            const result = await executeAiText({ ...request, maxOutputTokens: 1000 });
            await enforceUsageQuota(run.owner_user_id, "ai_output_tokens", result.metadata.outputTokens ?? Math.max(1, Math.ceil(result.text.length / 4)));
            return result;
          },
        });
      });
      await completeDurableExecution(admin, durable.id, result);
      if (!result.ok) throw new Error("AI preparation failed.");
      aiResult = result.outputData.ai_result;
    } else if (durable.status === "succeeded") {
      const { data: persisted, error: persistedError } = await admin.from("workflow_executions")
        .select("output_data").eq("id", durable.id).eq("user_id", run.owner_user_id).maybeSingle();
      if (persistedError || !persisted || typeof persisted.output_data !== "object"
        || !persisted.output_data || Array.isArray(persisted.output_data)) throw new Error("Completed AI result is unavailable.");
      aiResult = typeof persisted.output_data.ai_result === "string" ? persisted.output_data.ai_result : null;
    } else throw new Error("A previous automation attempt needs review before replay.");
    if (!aiResult) throw new Error("AI preparation returned no result.");
    const prepared = await persistPreparedDraft({ run, workItem,
      instruction: configuration.instruction, aiResult });
    if (configuration.kind === "gmail_follow_up") {
      await prepareGmailApproval({ run, configuration, executionId: durable.id, body: prepared.content });
    }
    const { data: finished, error: finishError } = await admin.from("automation_work_item_runs")
      .update({ status: "succeeded", claim_token: null, lease_until: null,
        failure_category: null, updated_at: new Date().toISOString() })
      .eq("id", run.id).eq("claim_token", token).eq("status", "running")
      .select("id").maybeSingle();
    if (finishError || !finished) throw new Error("Prepared automation outcome could not be confirmed.");
    return true;
  } catch {
    await failRun(run, token, "preparation_failed");
    return false;
  }
}

/** Bounded trigger adapter for the accepted durable workflow engine; never sends to a provider. */
export async function dispatchDueWorkItemAutomations(limit = 2, now = new Date()) {
  const admin = createAdminClient();
  const metrics = { inspected: 0, claimed: 0, prepared: 0, failed: 0 };
  metrics.failed += await reconcileExpiredRuns(now);
  const { data: suggestions, error } = await admin.from("automation_suggestions").select("*")
    .eq("status", "active").not("workflow_id", "is", null)
    .order("updated_at", { ascending: true }).limit(20);
  if (error) throw new Error("Active automation suggestions could not be loaded.");
  for (const suggestion of suggestions) {
    if (metrics.claimed >= Math.min(Math.max(limit, 1), 3)) break;
    const { data: workflow, error: workflowError } = await admin.from("workflows")
      .select("id,name,user_id,workspace_id,published_at,published_version_id,lifecycle_state,public_form_enabled")
      .eq("id", suggestion.workflow_id!).eq("workspace_id", suggestion.workspace_id)
      .eq("user_id", suggestion.owner_user_id).maybeSingle();
    if (workflowError || !workflow || !workflow.public_form_enabled || workflow.lifecycle_state !== "active"
      || !workflow.published_at || !workflow.published_version_id) continue;
    const { data: version } = await admin.from("workflow_versions")
      .select("setup_config").eq("id", workflow.published_version_id)
      .eq("workflow_id", workflow.id).eq("user_id", workflow.user_id).maybeSingle();
    let raw: unknown = null;
    try {
      if (version?.setup_config && typeof version.setup_config === "object" && !Array.isArray(version.setup_config)) {
        raw = JSON.parse(String(version.setup_config.automate_this ?? "null"));
      }
    } catch { continue; }
    const parsed = AutomationConfigurationSchema.safeParse(raw);
    if (!parsed.success || parsed.data.kind !== suggestion.pattern_kind
      || parsed.data.matchTitle !== suggestion.source_title
      || parsed.data.sourceType !== suggestion.source_type) continue;
    let query = admin.from("work_items").select("*")
      .eq("workspace_id", suggestion.workspace_id).eq("assignee_user_id", suggestion.owner_user_id)
      .eq("title", parsed.data.matchTitle).eq("source_type", parsed.data.sourceType)
      .gte("created_at", workflow.published_at)
      .order("created_at", { ascending: false }).limit(30);
    if (parsed.data.kind === "gmail_follow_up") {
      query = query.eq("status", "waiting").lte("due_at", now.toISOString())
        .lte("created_at", new Date(now.getTime() - parsed.data.waitDays * 86_400_000).toISOString());
    } else query = query.in("status", ["needs_you", "waiting"]);
    const { data: workItems, error: itemError } = await query;
    if (itemError) throw new Error("Matching work could not be loaded.");
    for (const workItem of workItems) {
      if (metrics.claimed >= Math.min(Math.max(limit, 1), 3)) break;
      metrics.inspected += 1;
      if (!matchingAutomationWorkItem({ title: workItem.title, sourceType: workItem.source_type,
        status: workItem.status, createdAt: workItem.created_at, dueAt: workItem.due_at,
        publishedAt: workflow.published_at, now,
        waitDays: parsed.data.kind === "gmail_follow_up" ? parsed.data.waitDays : null,
      }, { title: parsed.data.matchTitle, sourceType: parsed.data.sourceType })) continue;
      const { data: inserted, error: insertError } = await admin.from("automation_work_item_runs").insert({
        workspace_id: suggestion.workspace_id, owner_user_id: suggestion.owner_user_id,
        suggestion_id: suggestion.id, workflow_id: workflow.id,
        workflow_version_id: workflow.published_version_id, work_item_id: workItem.id,
      }).select("*").maybeSingle();
      if (insertError && insertError.code !== "23505") throw new Error("Automation claim could not be saved.");
      const run = inserted ?? (await admin.from("automation_work_item_runs").select("*")
        .eq("workflow_id", workflow.id).eq("work_item_id", workItem.id).maybeSingle()).data;
      if (!run || run.status === "succeeded" || run.status === "failed") continue;
      metrics.claimed += 1;
      if (await executeRun(run, suggestion, workItem, { name: workflow.name,
        published_version_id: workflow.published_version_id }, parsed.data)) metrics.prepared += 1;
      else metrics.failed += 1;
    }
  }
  return metrics;
}
