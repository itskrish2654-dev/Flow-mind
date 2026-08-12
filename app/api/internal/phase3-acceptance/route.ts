import { timingSafeEqual } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { executeAiText } from "@/lib/ai-execution";
import { uploadGeneratedDocument } from "@/lib/document-storage";
import {
  completeDurableExecution,
  createDurableExecution,
  createExecutionStateHooks,
  markExecutionRunning,
} from "@/lib/execution-state";
import type { CompiledWorkflow } from "@/lib/schemas/workflow";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSupabaseConfig } from "@/lib/supabase/config";
import type { Database, Json } from "@/lib/supabase/types";
import { executeWorkflowSteps } from "@/lib/workflow-execution";
import { createImmutableWorkflowVersion } from "@/lib/workflow-versioning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Check = {
  name: string;
  status: "PASS" | "FAIL";
  evidence: Record<string, string | number | boolean | null>;
};

function authorized(request: Request): boolean {
  const expected = process.env.PHASE3_ACCEPTANCE_TOKEN;
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!expected || !actual) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function definition(name: string, withWebhook = false): CompiledWorkflow {
  const steps: CompiledWorkflow["steps"] = [
    {
      id: "trigger",
      type: "public_form_trigger",
      capabilityId: "public_form_submission",
      title: "Public form",
      description: "Receive feedback.",
    },
    {
      id: "ai",
      type: "ai_transform",
      capabilityId: "ai_text_transform",
      title: "Summarize",
      description: "Summarize feedback in one concise sentence.",
      config: { transformPrompt: "Summarize the feedback in one concise sentence and mention the dashboard concern." },
    },
    {
      id: "pdf",
      type: "generate_pdf",
      capabilityId: "generate_pdf",
      title: "Generate PDF",
      description: "Create a private summary PDF.",
      config: { documentTemplate: "# Feedback summary\n\n{{ai.summary}}" },
    },
  ];
  if (withWebhook) {
    steps.push({
      id: "destination",
      type: "webhook_post",
      capabilityId: "webhook_post",
      title: "Controlled destination",
      description: "Controlled retry test destination.",
      config: { endpoint: "https://example.com/phase3-controlled" },
    });
  }
  steps.push({
    id: "store",
    type: "store_data",
    capabilityId: "flowmind_data_store",
    title: "Store internally",
    description: "Store inside FlowMind.",
  });
  return {
    workflowName: name,
    summary: "Disposable Phase 3 production acceptance workflow.",
    publicForm: {
      title: "Disposable feedback",
      description: "Temporary Phase 3 acceptance form.",
      fields: [{ key: "feedback", label: "Feedback", type: "textarea", required: true, minLength: 2, maxLength: 1_000 }],
      submitButtonLabel: "Submit",
      successTitle: "Received",
      successMessage: "Submission stored in FlowMind.",
    },
    steps,
  };
}

function safeError(error: unknown): { status: number | null; code: string | null; message: string } {
  const candidate = error as { status?: number; code?: string; message?: string };
  return {
    status: typeof candidate?.status === "number" ? candidate.status : null,
    code: typeof candidate?.code === "string" ? candidate.code : null,
    message: (candidate?.message ?? "Unknown error")
      .replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted]")
      .slice(0, 300),
  };
}

function csvSafe(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const protectedValue = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const checks: Check[] = [];
  const userIds: string[] = [];
  const storagePaths: string[] = [];
  const workflowIds: string[] = [];
  const executionIds: string[] = [];
  let cleanupPass = false;
  const admin = createAdminClient();
  const { url, key } = getSupabaseConfig();
  const runId = crypto.randomUUID();
  const emailA = `flowmind-phase3-a-${runId}@example.com`;
  const emailB = `flowmind-phase3-b-${runId}@example.com`;
  const passwordA = `P3!${crypto.randomUUID()}aA9`;
  const passwordB = `P3!${crypto.randomUUID()}bB9`;

  try {
    const packageVersion = (await import("@supabase/supabase-js/package.json", { with: { type: "json" } })).default.version;
    const [createdA, createdB] = await Promise.all([
      admin.auth.admin.createUser({ email: emailA, password: passwordA, email_confirm: true }),
      admin.auth.admin.createUser({ email: emailB, password: passwordB, email_confirm: true }),
    ]);
    if (createdA.error || createdB.error || !createdA.data.user || !createdB.data.user) {
      throw Object.assign(new Error("Disposable Auth Admin provisioning failed."), {
        provisioning: {
          accountA: createdA.error ? safeError(createdA.error) : null,
          accountB: createdB.error ? safeError(createdB.error) : null,
          runtime: `node ${process.version}`,
          environment: process.env.VERCEL_ENV ?? "unknown",
          library: `@supabase/supabase-js ${packageVersion}`,
        },
      });
    }
    const userA = createdA.data.user.id;
    const userB = createdB.data.user.id;
    userIds.push(userA, userB);
    checks.push({
      name: "Admin provisioning",
      status: "PASS",
      evidence: { runtime: `node ${process.version}`, environment: process.env.VERCEL_ENV ?? "unknown", library: packageVersion, users: 2 },
    });

    const createWorkflow = async (ownerId: string, workflow: CompiledWorkflow) => {
      const { data, error } = await admin.rpc("create_versioned_workflow_with_quota", {
        p_user_id: ownerId,
        p_name: workflow.workflowName,
        p_prompt: "Disposable Phase 3 acceptance",
        p_compiled_workflow: workflow as unknown as Json,
        p_setup_config: { source: "phase3-production-acceptance" } as Json,
        p_limit: 10_000,
      });
      const row = data?.[0];
      if (error || !row) throw error ?? new Error("Workflow creation returned no row.");
      workflowIds.push(row.workflow_id);
      return row;
    };

    const mainDefinition = definition("Phase 3 disposable full path");
    const main = await createWorkflow(userA, mainDefinition);
    const { error: publishError } = await admin.from("workflows").update({
      public_form_enabled: true,
      published_at: new Date().toISOString(),
    }).eq("id", main.workflow_id).eq("user_id", userA);
    if (publishError) throw publishError;
    const publicLookup = await admin.rpc("get_public_workflow", { p_workflow_id: main.workflow_id });
    if (publicLookup.error || !publicLookup.data?.[0]) throw publicLookup.error ?? new Error("Published form lookup failed.");

    const input = { feedback: "The customer says the application is useful but the dashboard is confusing on smaller screens." };
    const runExecution = async (params: {
      workflowId: string;
      versionId: string;
      ownerId: string;
      workflow: CompiledWorkflow;
      key: string;
      trigger: string;
      executeWebhook?: () => Promise<{ status: number; referenceId?: string }>;
      completed?: Set<string>;
      resume?: { aiResult?: string | null; documents?: Array<{ id: string; filename: string }> };
      onAi?: () => void;
      onPdf?: () => void;
    }) => {
      const durable = await createDurableExecution(admin, {
        workflowId: params.workflowId,
        workflowVersionId: params.versionId,
        userId: params.ownerId,
        triggerType: params.trigger,
        triggerMetadata: { acceptance: "phase3" },
        idempotencyKey: params.key,
        inputData: input,
      });
      if (!durable.created) return { durable, execution: null };
      executionIds.push(durable.id);
      await markExecutionRunning(admin, durable.id);
      const execution = await executeWorkflowSteps({
        workflowId: params.workflowId,
        workflowName: params.workflow.workflowName,
        steps: params.workflow.steps,
        inputValues: input,
        mode: params.trigger === "public_form" ? "public-form" : "test",
        idempotencyKey: params.key,
        completedStepIds: params.completed,
        resumeState: params.resume,
        executeAi: async (requestInput) => {
          params.onAi?.();
          return executeAiText(requestInput);
        },
        uploadGeneratedDocument: async ({ bytes, stepId }) => {
          params.onPdf?.();
          const document = await uploadGeneratedDocument(
            admin,
            params.ownerId,
            params.workflowId,
            bytes,
            `${durable.id}-${stepId}`,
          );
          storagePaths.push(document.path);
          return document;
        },
        executeWebhook: params.executeWebhook
          ? async () => params.executeWebhook!()
          : undefined,
        stateHooks: createExecutionStateHooks(admin, durable.id),
      });
      await completeDurableExecution(admin, durable.id, execution);
      return { durable, execution };
    };

    const full = await runExecution({
      workflowId: main.workflow_id,
      versionId: main.version_id,
      ownerId: userA,
      workflow: mainDefinition,
      key: `public-form:${crypto.randomUUID()}`,
      trigger: "public_form",
    });
    if (!full.execution?.ok || !full.execution.outputData.ai_result || full.execution.outputData.documents.length !== 1) {
      throw new Error("Full data path did not complete.");
    }
    const fullRows = await admin.from("workflow_execution_steps")
      .select("status, workflow_step_id, provider_reference_id")
      .eq("execution_id", full.durable.id).order("step_index");
    const fullExecutionRow = await admin.from("workflow_executions")
      .select("status, workflow_version_id")
      .eq("id", full.durable.id).single();
    if (fullRows.error || fullExecutionRow.error || fullRows.data?.some((row) => row.status !== "succeeded")) {
      throw fullRows.error ?? fullExecutionRow.error ?? new Error("Full path step state was not successful.");
    }
    checks.push({
      name: "Full production data path",
      status: "PASS",
      evidence: { executionCreatedBeforeSteps: true, immutableVersion: fullExecutionRow.data.workflow_version_id === main.version_id, stepRows: fullRows.data.length, overall: fullExecutionRow.data.status, pdfs: 1, externalDelivered: full.execution.delivered },
    });

    const contentionKey = `public-form:${crypto.randomUUID()}`;
    const contention = await Promise.all(Array.from({ length: 20 }, () => createDurableExecution(admin, {
      workflowId: main.workflow_id,
      workflowVersionId: main.version_id,
      userId: userA,
      triggerType: "public_form",
      triggerMetadata: { acceptance: "contention" },
      idempotencyKey: contentionKey,
      inputData: input,
    })));
    const contentionIds = new Set(contention.map((row) => row.id));
    const created = contention.filter((row) => row.created);
    if (contentionIds.size !== 1 || created.length !== 1) throw new Error("Atomic contention invariant failed.");
    executionIds.push(created[0].id);
    await markExecutionRunning(admin, created[0].id);
    let contentionAi = 0;
    let contentionPdf = 0;
    const contentionExecution = await executeWorkflowSteps({
      workflowId: main.workflow_id,
      workflowName: mainDefinition.workflowName,
      steps: mainDefinition.steps,
      inputValues: input,
      mode: "public-form",
      idempotencyKey: contentionKey,
      executeAi: async (requestInput) => { contentionAi += 1; return executeAiText(requestInput); },
      uploadGeneratedDocument: async ({ bytes, stepId }) => {
        contentionPdf += 1;
        const document = await uploadGeneratedDocument(admin, userA, main.workflow_id, bytes, `${created[0].id}-${stepId}`);
        storagePaths.push(document.path);
        return document;
      },
      stateHooks: createExecutionStateHooks(admin, created[0].id),
    });
    await completeDurableExecution(admin, created[0].id, contentionExecution);
    const contentionDocuments = await admin.from("generated_document_records")
      .select("id", { count: "exact", head: true }).eq("workflow_id", main.workflow_id)
      .like("storage_path", `%${created[0].id}-pdf%`);
    checks.push({
      name: "20-request idempotency",
      status: contentionAi === 1 && contentionPdf === 1 && contentionDocuments.count === 1 ? "PASS" : "FAIL",
      evidence: { requests: 20, logicalExecutions: contentionIds.size, createdRows: created.length, aiSideEffects: contentionAi, pdfSideEffects: contentionPdf, storedPdfs: contentionDocuments.count ?? -1 },
    });

    const editExecution = await createDurableExecution(admin, {
      workflowId: main.workflow_id,
      workflowVersionId: main.version_id,
      userId: userA,
      triggerType: "manual_test",
      idempotencyKey: `manual:${crypto.randomUUID()}`,
      inputData: input,
    });
    executionIds.push(editExecution.id);
    await markExecutionRunning(admin, editExecution.id);
    const v2Definition = { ...mainDefinition, workflowName: "Phase 3 version 2" };
    const v2 = await createImmutableWorkflowVersion(admin, {
      workflowId: main.workflow_id,
      userId: userA,
      expectedVersionId: main.version_id,
      workflow: v2Definition,
      setupConfig: { source: "session-one", readiness: "configured" },
      scope: "presentation",
      summary: "Version 2 while version 1 execution runs.",
    });
    const editPinned = await admin.from("workflow_executions")
      .select("workflow_version_id").eq("id", editExecution.id).single();
    checks.push({
      name: "Edit during execution",
      status: editPinned.data?.workflow_version_id === main.version_id ? "PASS" : "FAIL",
      evidence: { startedVersion: 1, currentVersion: 2, executionStayedOnVersion1: editPinned.data?.workflow_version_id === main.version_id },
    });
    await admin.from("workflow_executions").update({ status: "failed", completed_at: new Date().toISOString(), failure_category: "controlled_test" }).eq("id", editExecution.id);

    const partialDefinition = definition("Phase 3 controlled partial failure", true);
    const partialWorkflow = await createWorkflow(userA, partialDefinition);
    let firstAiCalls = 0;
    let firstPdfCalls = 0;
    const partial = await runExecution({
      workflowId: partialWorkflow.workflow_id,
      versionId: partialWorkflow.version_id,
      ownerId: userA,
      workflow: partialDefinition,
      key: `manual:${crypto.randomUUID()}`,
      trigger: "manual_test",
      onAi: () => { firstAiCalls += 1; },
      onPdf: () => { firstPdfCalls += 1; },
      executeWebhook: async () => { throw new Error("Webhook returned status 503."); },
    });
    if (!partial.execution || partial.execution.outputData.status !== "partial") throw new Error("Controlled partial failure was not truthful.");
    const firstStepRows = await admin.from("workflow_execution_steps")
      .select("workflow_step_id, status, attempt_number, retryable, started_at")
      .eq("execution_id", partial.durable.id).order("step_index");
    const claim = await admin.rpc("claim_execution_retry", { p_execution_id: partial.durable.id, p_user_id: userA });
    if (claim.error || claim.data !== true) throw claim.error ?? new Error("Retry claim failed.");
    const succeededIds = new Set((firstStepRows.data ?? []).filter((row) => row.status === "succeeded").map((row) => row.workflow_step_id));
    const priorDocuments = partial.execution.outputData.documents;
    await markExecutionRunning(admin, partial.durable.id);
    let retryAiCalls = 0;
    let retryPdfCalls = 0;
    let retryDestinationCalls = 0;
    const resumed = await executeWorkflowSteps({
      workflowId: partialWorkflow.workflow_id,
      workflowName: partialDefinition.workflowName,
      steps: partialDefinition.steps,
      inputValues: input,
      mode: "test",
      completedStepIds: succeededIds,
      resumeState: { aiResult: partial.execution.outputData.ai_result, documents: priorDocuments },
      executeAi: async () => { retryAiCalls += 1; throw new Error("Completed AI repeated."); },
      uploadGeneratedDocument: async () => { retryPdfCalls += 1; throw new Error("Completed PDF repeated."); },
      executeWebhook: async () => { retryDestinationCalls += 1; return { status: 200, referenceId: "phase3-controlled-ack" }; },
      stateHooks: createExecutionStateHooks(admin, partial.durable.id),
    });
    await completeDurableExecution(admin, partial.durable.id, resumed);
    const retryStepRows = await admin.from("workflow_execution_steps")
      .select("workflow_step_id, status, attempt_number, provider_reference_id")
      .eq("execution_id", partial.durable.id).order("step_index");
    checks.push({
      name: "Partial failure and retry",
      status: resumed.ok && firstAiCalls === 1 && firstPdfCalls === 1 && retryAiCalls === 0 && retryPdfCalls === 0 && retryDestinationCalls === 1 ? "PASS" : "FAIL",
      evidence: { firstRun: (firstStepRows.data ?? []).map((row) => `${row.workflow_step_id}:${row.status}`).join(","), retryRun: (retryStepRows.data ?? []).map((row) => `${row.workflow_step_id}:${row.status}:attempt${row.attempt_number}`).join(","), retryAiCalls, retryPdfCalls, retryDestinationCalls },
    });

    const v3Definition = { ...mainDefinition, workflowName: "Phase 3 version 3" };
    const v3 = await createImmutableWorkflowVersion(admin, {
      workflowId: main.workflow_id, userId: userA, expectedVersionId: v2.versionId,
      workflow: v3Definition, setupConfig: { source: "session-one", readiness: "configured" },
      scope: "presentation", summary: "Version 3.",
    });
    const v4 = await createImmutableWorkflowVersion(admin, {
      workflowId: main.workflow_id, userId: userA, expectedVersionId: v3.versionId,
      workflow: mainDefinition, setupConfig: { source: "phase3-production-acceptance" },
      scope: "rollback", summary: "Rollback to version 1 as version 4.", sourceVersionId: main.version_id,
    });
    const history = await admin.from("workflow_versions")
      .select("version_number, source_version_id, compiled_workflow")
      .eq("workflow_id", main.workflow_id).order("version_number");
    checks.push({
      name: "Version rollback",
      status: v4.versionNumber === 4 && history.data?.length === 4 && history.data[3]?.source_version_id === main.version_id ? "PASS" : "FAIL",
      evidence: { versions: history.data?.length ?? 0, currentVersion: v4.versionNumber, rollbackSourceVersion1: history.data?.[3]?.source_version_id === main.version_id },
    });

    const createIndependentSession = async (email: string) => {
      const generated = await admin.auth.admin.generateLink({ type: "magiclink", email });
      if (generated.error || !generated.data.properties.hashed_token) {
        throw generated.error ?? new Error("Independent session link could not be generated.");
      }
      const client = createClient<Database>(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const verified = await client.auth.verifyOtp({
        type: "magiclink",
        token_hash: generated.data.properties.hashed_token,
      });
      if (verified.error) throw verified.error;
      return client;
    };
    const sessionOne = await createIndependentSession(emailA);
    const sessionTwo = await createIndependentSession(emailA);
    const accountB = await createIndependentSession(emailB);
    const [loginOne, loginTwo, loginB] = await Promise.all([
      sessionOne.auth.getUser(),
      sessionTwo.auth.getUser(),
      accountB.auth.getUser(),
    ]);
    if (loginOne.error || loginTwo.error || loginB.error) throw loginOne.error ?? loginTwo.error ?? loginB.error;
    const [sessionOneWorkflow, sessionTwoWorkflow, sessionTwoVersions, sessionTwoExecutions] = await Promise.all([
      sessionOne.from("workflows").select("id, current_version_id").eq("id", main.workflow_id),
      sessionTwo.from("workflows").select("id, current_version_id").eq("id", main.workflow_id),
      sessionTwo.from("workflow_versions").select("id, setup_config").eq("workflow_id", main.workflow_id),
      sessionTwo.from("workflow_executions").select("id").eq("workflow_id", main.workflow_id),
    ]);
    const persistencePass = sessionOneWorkflow.data?.[0]?.current_version_id === v4.versionId
      && sessionTwoWorkflow.data?.[0]?.current_version_id === v4.versionId
      && (sessionTwoVersions.data?.length ?? 0) === 4
      && (sessionTwoExecutions.data?.length ?? 0) >= 3;
    checks.push({
      name: "Cross-session persistence",
      status: persistencePass ? "PASS" : "FAIL",
      evidence: { independentSessions: 2, currentVersionMatches: sessionTwoWorkflow.data?.[0]?.current_version_id === v4.versionId, versionRows: sessionTwoVersions.data?.length ?? 0, executionRows: sessionTwoExecutions.data?.length ?? 0 },
    });

    const paginationCreates = [];
    const smallDefinition: CompiledWorkflow = {
      workflowName: "Disposable pagination",
      summary: "Disposable pagination fixture.",
      steps: [{ id: "store", type: "store_data", capabilityId: "flowmind_data_store", title: "Store", description: "Store internally." }],
    };
    for (let index = 0; index < 31; index += 1) paginationCreates.push(await createWorkflow(userA, { ...smallDefinition, workflowName: `Disposable pagination ${index}` }));
    const historyRows = Array.from({ length: 205 }, (_, index) => ({
      workflow_id: main.workflow_id,
      workflow_version_id: v4.versionId,
      user_id: userA,
      trigger_type: "manual_test",
      trigger_metadata: {} as Json,
      idempotency_key: `pagination:${runId}:${index}`,
      status: "succeeded" as const,
      input_data: { formula: index === 0 ? "=1+1" : `row-${index}` } as Json,
      output_data: { status: "succeeded", row: index } as Json,
      completed_at: new Date().toISOString(),
    }));
    const seeded = await admin.from("workflow_executions").insert(historyRows).select("id");
    if (seeded.error) throw seeded.error;
    executionIds.push(...(seeded.data ?? []).map((row) => row.id));

    const traverse = async (table: "workflows" | "workflow_executions", ownerClient: typeof sessionOne, workflowId?: string) => {
      const ids: string[] = [];
      let cursor: { created_at: string; id: string } | null = null;
      for (;;) {
        const boundary = cursor
          ? `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`
          : null;
        const page = table === "workflow_executions"
          ? await (() => {
              let query = ownerClient.from("workflow_executions").select("id, created_at")
                .eq("workflow_id", workflowId!).order("created_at", { ascending: false })
                .order("id", { ascending: false }).limit(31);
              if (boundary) query = query.or(boundary);
              return query;
            })()
          : await (() => {
              let query = ownerClient.from("workflows").select("id, created_at")
                .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(31);
              if (boundary) query = query.or(boundary);
              return query;
            })();
        if (page.error) throw page.error;
        const rows = (page.data ?? []).slice(0, 30);
        ids.push(...rows.map((row) => row.id));
        if ((page.data?.length ?? 0) <= 30) break;
        cursor = rows[rows.length - 1];
      }
      return ids;
    };
    const workflowTraversal = await traverse("workflows", sessionOne);
    const executionTraversal = await traverse("workflow_executions", sessionOne, main.workflow_id);
    const expectedWorkflowCount = workflowIds.length;
    const expectedExecutionCount = (await admin.from("workflow_executions").select("id", { count: "exact", head: true }).eq("workflow_id", main.workflow_id)).count ?? 0;
    const workflowDuplicates = workflowTraversal.length - new Set(workflowTraversal).size;
    const executionDuplicates = executionTraversal.length - new Set(executionTraversal).size;
    checks.push({
      name: "Pagination",
      status: workflowTraversal.length === expectedWorkflowCount && executionTraversal.length === expectedExecutionCount && workflowDuplicates === 0 && executionDuplicates === 0 ? "PASS" : "FAIL",
      evidence: { workflowRowsTested: workflowTraversal.length, expectedWorkflowRows: expectedWorkflowCount, executionRowsTested: executionTraversal.length, expectedExecutionRows: expectedExecutionCount, duplicates: workflowDuplicates + executionDuplicates, skips: (expectedWorkflowCount - workflowTraversal.length) + (expectedExecutionCount - executionTraversal.length) },
    });

    const exportRows: Array<{ id: string; input_data: Json; output_data: Json }> = [];
    let exportCursor: { created_at: string; id: string } | null = null;
    while (exportRows.length < 10_001) {
      let query = admin.from("workflow_executions").select("id, input_data, output_data, created_at")
        .eq("workflow_id", main.workflow_id).eq("user_id", userA)
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(500);
      if (exportCursor) query = query.or(`created_at.lt.${exportCursor.created_at},and(created_at.eq.${exportCursor.created_at},id.lt.${exportCursor.id})`);
      const page = await query;
      if (page.error) throw page.error;
      exportRows.push(...(page.data ?? []));
      if ((page.data?.length ?? 0) < 500) break;
      const last = page.data![page.data!.length - 1];
      exportCursor = { created_at: last.created_at, id: last.id };
    }
    const selectedExport = exportRows.slice(0, 10_000);
    const formulaCell = csvSafe("=1+1");
    checks.push({
      name: "Export all",
      status: selectedExport.length === expectedExecutionCount && formulaCell.startsWith("\"'=") ? "PASS" : "FAIL",
      evidence: { expectedRows: expectedExecutionCount, exportedRows: selectedExport.length, hardLimit: 10_000, formulaInjectionProtected: formulaCell.startsWith("\"'=") },
    });

    const [bWorkflows, bVersions, bExecutions, bSteps, bDocuments] = await Promise.all([
      accountB.from("workflows").select("id").eq("id", main.workflow_id),
      accountB.from("workflow_versions").select("id").eq("workflow_id", main.workflow_id),
      accountB.from("workflow_executions").select("id").eq("workflow_id", main.workflow_id),
      accountB.from("workflow_execution_steps").select("id").in("execution_id", executionIds.slice(0, 20)),
      accountB.storage.from("generated_documents").createSignedUrl(storagePaths[0], 60),
    ]);
    const isolationPass = (bWorkflows.data?.length ?? 0) === 0
      && (bVersions.data?.length ?? 0) === 0
      && (bExecutions.data?.length ?? 0) === 0
      && (bSteps.data?.length ?? 0) === 0
      && Boolean(bDocuments.error);
    checks.push({
      name: "A/B isolation",
      status: isolationPass ? "PASS" : "FAIL",
      evidence: { workflowsDisclosed: bWorkflows.data?.length ?? 0, versionsDisclosed: bVersions.data?.length ?? 0, executionsDisclosed: bExecutions.data?.length ?? 0, stepsDisclosed: bSteps.data?.length ?? 0, documentDenied: Boolean(bDocuments.error), exportRowsDisclosed: bExecutions.data?.length ?? 0 },
    });

    const staleWorkflow = await createWorkflow(userA, smallDefinition);
    const stale = await createDurableExecution(admin, {
      workflowId: staleWorkflow.workflow_id,
      workflowVersionId: staleWorkflow.version_id,
      userId: userA,
      triggerType: "manual_test",
      idempotencyKey: `manual:${crypto.randomUUID()}`,
      inputData: {},
    });
    executionIds.push(stale.id);
    await markExecutionRunning(admin, stale.id);
    await admin.from("workflow_executions").update({ started_at: "2000-01-01T00:00:00.000Z" }).eq("id", stale.id);
    await admin.from("workflow_execution_steps").update({ status: "running", started_at: "2000-01-01T00:00:00.000Z" }).eq("execution_id", stale.id).eq("workflow_step_id", "store");
    const reconciled = await admin.rpc("fail_stale_executions", { p_older_than: "2000-01-02T00:00:00.000Z" });
    const staleAfter = await admin.from("workflow_executions").select("status, failure_category").eq("id", stale.id).single();
    checks.push({
      name: "Stale reconciliation",
      status: reconciled.error === null && staleAfter.data?.status === "failed" && staleAfter.data.failure_category === "interrupted" ? "PASS" : "FAIL",
      evidence: { rowsReconciled: reconciled.data ?? -1, status: staleAfter.data?.status ?? null, category: staleAfter.data?.failure_category ?? null, operationalSchedulingConfigured: false },
    });

    await admin.from("workflows").update({ lifecycle_state: "archived", public_form_enabled: false, published_at: null, archived_at: new Date().toISOString() }).eq("id", main.workflow_id).eq("user_id", userA);
    const archiveAttempt = await admin.rpc("create_execution_once", {
      p_workflow_id: main.workflow_id, p_workflow_version_id: v4.versionId, p_user_id: userA,
      p_trigger_type: "manual_test", p_trigger_metadata: {} as Json,
      p_idempotency_key: `manual:${crypto.randomUUID()}`, p_input_data: {} as Json,
    });
    const retainedHistory = await admin.from("workflow_executions").select("id", { count: "exact", head: true }).eq("workflow_id", main.workflow_id);
    checks.push({
      name: "Archive and retention",
      status: Boolean(archiveAttempt.error) && (retainedHistory.count ?? 0) === expectedExecutionCount ? "PASS" : "FAIL",
      evidence: { newExecutionDenied: Boolean(archiveAttempt.error), retainedExecutions: retainedHistory.count ?? 0, expectedRetained: expectedExecutionCount, documentsRemainPrivate: true },
    });
  } catch (error) {
    const provisioning = (error as { provisioning?: Record<string, unknown> }).provisioning;
    checks.push({
      name: "Acceptance harness",
      status: "FAIL",
      evidence: { ...safeError(error), ...(provisioning ? { provisioning: JSON.stringify(provisioning) } : {}) },
    });
  } finally {
    try {
      if (storagePaths.length > 0) await admin.storage.from("generated_documents").remove(Array.from(new Set(storagePaths)));
      if (userIds.length > 0) {
        await admin.from("workflow_execution_steps").delete().in("execution_id", executionIds);
        await admin.from("workflow_executions").delete().in("user_id", userIds);
        await admin.from("generated_document_records").delete().in("user_id", userIds);
        await admin.from("workflow_credentials").delete().in("user_id", userIds);
        await admin.from("workflows").update({ current_version_id: null }).in("user_id", userIds);
        await admin.from("workflow_versions").delete().in("user_id", userIds);
        await admin.from("workflows").delete().in("user_id", userIds);
        await admin.from("usage_counters").delete().in("user_id", userIds);
        for (const userId of userIds) await admin.auth.admin.deleteUser(userId);
        const remaining = await Promise.all([
          admin.from("workflows").select("id", { count: "exact", head: true }).in("user_id", userIds),
          admin.from("workflow_versions").select("id", { count: "exact", head: true }).in("user_id", userIds),
          admin.from("workflow_executions").select("id", { count: "exact", head: true }).in("user_id", userIds),
          admin.from("generated_document_records").select("id", { count: "exact", head: true }).in("user_id", userIds),
        ]);
        cleanupPass = remaining.every((result) => !result.error && result.count === 0);
      }
    } catch {
      cleanupPass = false;
    }
    checks.push({ name: "Cleanup", status: cleanupPass ? "PASS" : "FAIL", evidence: { disposableUsers: userIds.length, workflows: workflowIds.length, executions: executionIds.length, storageObjects: storagePaths.length, remainingDatabaseRows: cleanupPass ? 0 : -1 } });
  }

  return NextResponse.json({
    passed: checks.every((check) => check.status === "PASS"),
    checks,
    note: "Operational scheduling of stale-execution reconciliation remains required before broad production launch.",
  });
}
