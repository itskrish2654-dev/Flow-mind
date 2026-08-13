import { NextResponse } from "next/server";

import { getAuthenticatedContext } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const EXPORT_LIMITS = {
  workflows: 250,
  versions: 5_000,
  executions: 5_000,
  executionSteps: 25_000,
  documents: 5_000,
  credentials: 2_000,
  connections: 500,
} as const;

function attachmentName() {
  return `flowmind-export-${new Date().toISOString().slice(0, 10)}.json`;
}

export async function GET() {
  const auth = await getAuthenticatedContext();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  try {
    const { data: workflows, error: workflowError, count: workflowCount } = await admin
      .from("workflows")
      .select("id, name, prompt, compiled_steps, public_form_enabled, published_at, public_form_challenge_mode, created_at, updated_at, current_version_id, lifecycle_state, archived_at", { count: "exact" })
      .eq("user_id", auth.user.id)
      .order("created_at", { ascending: true })
      .limit(EXPORT_LIMITS.workflows + 1);
    if (workflowError || (workflowCount ?? 0) > EXPORT_LIMITS.workflows) throw new Error("export_too_large_workflows");

    const [versionResult, executionResult, documentResult, credentialResult, connectionResult, usageResult] = await Promise.all([
      admin.from("workflow_versions")
        .select("id, workflow_id, version_number, compiled_workflow, setup_config, change_scope, change_summary, source_version_id, created_at", { count: "exact" })
        .eq("user_id", auth.user.id).order("created_at", { ascending: true }).limit(EXPORT_LIMITS.versions + 1),
      admin.from("workflow_executions")
        .select("id, workflow_id, workflow_version_id, input_data, output_data, created_at, trigger_type, trigger_metadata, status, started_at, completed_at, failure_category, sanitized_metadata, attempt_count", { count: "exact" })
        .eq("user_id", auth.user.id).order("created_at", { ascending: true }).limit(EXPORT_LIMITS.executions + 1),
      admin.from("generated_document_records")
        .select("id, workflow_id, filename, content_type, size_bytes, created_at", { count: "exact" })
        .eq("user_id", auth.user.id).order("created_at", { ascending: true }).limit(EXPORT_LIMITS.documents + 1),
      admin.from("workflow_credentials")
        .select("workflow_id, connector_id, credential_key, credential_type, created_at, updated_at", { count: "exact" })
        .eq("user_id", auth.user.id).order("created_at", { ascending: true }).limit(EXPORT_LIMITS.credentials + 1),
      admin.from("connector_connections")
        .select("id, connector_id, provider_family, external_account_label, auth_type, status, granted_scopes, token_expires_at, last_refreshed_at, last_error_category, created_at, updated_at", { count: "exact" })
        .eq("user_id", auth.user.id).order("created_at", { ascending: true }).limit(EXPORT_LIMITS.connections + 1),
      admin.from("usage_counters")
        .select("metric, period_started_at, used, updated_at")
        .eq("user_id", auth.user.id).order("period_started_at", { ascending: true }),
    ]);
    const results = [versionResult, executionResult, documentResult, credentialResult, connectionResult, usageResult];
    if (results.some((result) => result.error)) throw new Error("export_query_failed");
    if ((versionResult.count ?? 0) > EXPORT_LIMITS.versions) throw new Error("export_too_large_versions");
    if ((executionResult.count ?? 0) > EXPORT_LIMITS.executions) throw new Error("export_too_large_executions");
    if ((documentResult.count ?? 0) > EXPORT_LIMITS.documents) throw new Error("export_too_large_documents");
    if ((credentialResult.count ?? 0) > EXPORT_LIMITS.credentials) throw new Error("export_too_large_credentials");
    if ((connectionResult.count ?? 0) > EXPORT_LIMITS.connections) throw new Error("export_too_large_connections");

    const executionIds = (executionResult.data ?? []).map((execution) => execution.id);
    const executionSteps: Array<Record<string, unknown>> = [];
    for (let index = 0; index < executionIds.length; index += 100) {
      const { data, error, count } = await admin.from("workflow_execution_steps")
        .select("id, execution_id, workflow_version_id, workflow_step_id, step_index, capability_id, status, attempt_number, started_at, completed_at, sanitized_input_metadata, sanitized_output_metadata, error_category, retryable, created_at, updated_at", { count: "exact" })
        .in("execution_id", executionIds.slice(index, index + 100))
        .order("created_at", { ascending: true });
      if (error) throw new Error("export_query_failed");
      if (executionSteps.length + (count ?? 0) > EXPORT_LIMITS.executionSteps) throw new Error("export_too_large_steps");
      executionSteps.push(...(data ?? []));
    }

    const archive = {
      format: "flowmind-account-export",
      version: 1,
      generatedAt: new Date().toISOString(),
      account: { email: auth.user.email ?? null, createdAt: auth.user.created_at },
      exportLimits: EXPORT_LIMITS,
      data: {
        workflows: workflows ?? [],
        workflowVersions: versionResult.data ?? [],
        executions: executionResult.data ?? [],
        executionSteps,
        generatedDocuments: documentResult.data ?? [],
        credentials: (credentialResult.data ?? []).map((credential) => ({ ...credential, configured: true })),
        connections: connectionResult.data ?? [],
        usage: usageResult.data ?? [],
      },
      excluded: ["credential plaintext", "encryption material", "authentication tokens", "service secrets", "document storage paths"],
    };
    return new NextResponse(JSON.stringify(archive, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${attachmentName()}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const tooLarge = error instanceof Error && error.message.startsWith("export_too_large");
    return NextResponse.json({
      error: tooLarge
        ? "Your export is larger than the documented safety limit. Contact support for assistance; no data was silently omitted."
        : "Your export could not be generated right now. Please try again.",
    }, { status: tooLarge ? 413 : 500 });
  }
}
