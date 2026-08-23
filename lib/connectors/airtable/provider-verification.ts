import "@/lib/server-only-runtime";

import { matchesOwnedConnectorConnection } from "@/lib/connectors/connection-matching";
import { getConnector } from "@/lib/connectors/registry";
import {
  AIRTABLE_CREATE_RECORD_SCOPE,
  isValidAirtableRecordId,
} from "@/lib/connectors/airtable/workflow-configuration";
import type { Json } from "@/lib/supabase/types";

export { AIRTABLE_CREATE_RECORD_SCOPE } from "@/lib/connectors/airtable/workflow-configuration";

type ExecutionEvidence = {
  id: string;
  user_id: string;
  workflow_id: string;
  workflow_version_id: string | null;
  trigger_type: string;
  status: string;
};

type StepEvidence = {
  execution_id: string;
  workflow_step_id: string;
  status: string;
  provider_reference_id: string | null;
  sanitized_output_metadata: Json;
};

type AirtableConnectionEvidence = {
  id: string;
  user_id: string;
  connector_id: string;
  provider_family: string;
  auth_type: "none" | "api_key" | "oauth2";
  status: string;
  granted_scopes: string[];
  safe_metadata: Json;
  updated_at: string;
};

export type AirtableTestVerificationInput = {
  userId: string;
  workflowId: string;
  workflowVersionId: string;
  executionId: string;
  stepId: string;
  connectionId: string;
  capabilityId: "airtable.create_record";
  mode: "TEST";
  acknowledged: true;
  providerReferenceId: string;
};

export type AirtableProviderVerificationDependencies = {
  loadExecution(input: AirtableTestVerificationInput): Promise<ExecutionEvidence | null>;
  loadStep(input: AirtableTestVerificationInput): Promise<StepEvidence | null>;
  loadConnection(input: AirtableTestVerificationInput): Promise<AirtableConnectionEvidence | null>;
  persistConnection(input: {
    userId: string;
    connectionId: string;
    previousUpdatedAt: string;
    grantedScopes: string[];
    safeMetadata: Record<string, Json | undefined>;
    verifiedAt: string;
  }): Promise<boolean>;
  now(): Date;
};

export type AirtableProviderVerificationResult = {
  status: "verified" | "already_verified";
  verifiedAt: string;
};

export class AirtableProviderVerificationError extends Error {
  constructor() {
    super("Airtable connection verification needs reconciliation.");
    this.name = "AirtableProviderVerificationError";
  }
}

function metadataRecord(value: Json): Record<string, Json | undefined> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Json | undefined>
    : null;
}

const defaultDependencies: AirtableProviderVerificationDependencies = {
  async loadExecution(input) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data, error } = await createAdminClient()
      .from("workflow_executions")
      .select("id,user_id,workflow_id,workflow_version_id,trigger_type,status")
      .eq("id", input.executionId)
      .eq("user_id", input.userId)
      .eq("workflow_id", input.workflowId)
      .eq("workflow_version_id", input.workflowVersionId)
      .maybeSingle();
    if (error) throw new AirtableProviderVerificationError();
    return data;
  },
  async loadStep(input) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data, error } = await createAdminClient()
      .from("workflow_execution_steps")
      .select("execution_id,workflow_step_id,status,provider_reference_id,sanitized_output_metadata")
      .eq("execution_id", input.executionId)
      .eq("workflow_step_id", input.stepId)
      .maybeSingle();
    if (error) throw new AirtableProviderVerificationError();
    return data;
  },
  async loadConnection(input) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data, error } = await createAdminClient()
      .from("connector_connections")
      .select("id,user_id,connector_id,provider_family,auth_type,status,granted_scopes,safe_metadata,updated_at")
      .eq("id", input.connectionId)
      .eq("user_id", input.userId)
      .eq("connector_id", "airtable")
      .eq("provider_family", "airtable")
      .maybeSingle();
    if (error) throw new AirtableProviderVerificationError();
    return data;
  },
  async persistConnection(input) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data, error } = await createAdminClient()
      .from("connector_connections")
      .update({
        granted_scopes: input.grantedScopes,
        safe_metadata: input.safeMetadata,
        updated_at: input.verifiedAt,
      })
      .eq("id", input.connectionId)
      .eq("user_id", input.userId)
      .eq("connector_id", "airtable")
      .eq("provider_family", "airtable")
      .eq("status", "connected")
      .eq("updated_at", input.previousUpdatedAt)
      .select("id")
      .maybeSingle();
    if (error) throw new AirtableProviderVerificationError();
    return Boolean(data);
  },
  now: () => new Date(),
};

export async function verifyAirtableCustomerTestExecution(
  input: AirtableTestVerificationInput,
  dependencies: AirtableProviderVerificationDependencies = defaultDependencies,
): Promise<AirtableProviderVerificationResult> {
  if (
    input.capabilityId !== "airtable.create_record" ||
    input.mode !== "TEST" ||
    input.acknowledged !== true ||
    !isValidAirtableRecordId(input.providerReferenceId)
  ) {
    throw new AirtableProviderVerificationError();
  }

  const [execution, step, connection] = await Promise.all([
    dependencies.loadExecution(input),
    dependencies.loadStep(input),
    dependencies.loadConnection(input),
  ]);
  const stepMetadata = step ? metadataRecord(step.sanitized_output_metadata) : null;
  const connector = getConnector("airtable");
  if (
    !execution ||
    execution.id !== input.executionId ||
    execution.user_id !== input.userId ||
    execution.workflow_id !== input.workflowId ||
    execution.workflow_version_id !== input.workflowVersionId ||
    execution.trigger_type !== "manual_test" ||
    execution.status !== "succeeded" ||
    !step ||
    step.execution_id !== input.executionId ||
    step.workflow_step_id !== input.stepId ||
    step.status !== "succeeded" ||
    step.provider_reference_id !== input.providerReferenceId ||
    stepMetadata?.capabilityId !== "airtable.create_record" ||
    stepMetadata?.provider !== "airtable" ||
    stepMetadata?.operation !== "create_record" ||
    stepMetadata?.mode !== "TEST" ||
    stepMetadata?.acknowledged !== true ||
    !connector ||
    !connection ||
    !matchesOwnedConnectorConnection({
      connection,
      authenticatedUserId: input.userId,
      connectionId: input.connectionId,
      manifest: connector.manifest,
    }) ||
    connection.auth_type !== "api_key"
  ) {
    throw new AirtableProviderVerificationError();
  }

  const safeMetadata = metadataRecord(connection.safe_metadata);
  if (
    !safeMetadata ||
    safeMetadata.connectionMode !== "customer_api_key" ||
    !["deferred", "operation_verified"].includes(String(safeMetadata.providerVerification))
  ) {
    throw new AirtableProviderVerificationError();
  }

  if (
    safeMetadata.providerVerification === "operation_verified" &&
    safeMetadata.verifiedOperation === "airtable.create_record" &&
    connection.granted_scopes.includes(AIRTABLE_CREATE_RECORD_SCOPE)
  ) {
    return {
      status: "already_verified",
      verifiedAt: typeof safeMetadata.verifiedAt === "string" ? safeMetadata.verifiedAt : connection.updated_at,
    };
  }

  const verifiedAt = dependencies.now().toISOString();
  const grantedScopes = Array.from(new Set([
    ...connection.granted_scopes,
    AIRTABLE_CREATE_RECORD_SCOPE,
  ]));
  const nextMetadata: Record<string, Json | undefined> = {
    ...safeMetadata,
    providerVerification: "operation_verified",
    verifiedOperation: "airtable.create_record",
    verifiedAt,
    verifiedExecutionId: input.executionId,
    verifiedWorkflowId: input.workflowId,
    verifiedWorkflowVersionId: input.workflowVersionId,
    verifiedStepId: input.stepId,
  };
  const persisted = await dependencies.persistConnection({
    userId: input.userId,
    connectionId: input.connectionId,
    previousUpdatedAt: connection.updated_at,
    grantedScopes,
    safeMetadata: nextMetadata,
    verifiedAt,
  });
  if (!persisted) throw new AirtableProviderVerificationError();
  return { status: "verified", verifiedAt };
}
