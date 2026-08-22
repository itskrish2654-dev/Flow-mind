import "@/lib/server-only-runtime";

import { randomUUID } from "node:crypto";

import { ConnectorRunnerExecutor } from "@/lib/executors/connector-runner";
import type { CapabilityExecutionRequest } from "@/lib/executors/types";
import {
  isD2OperatorAuthorized,
  type D2OperatorEnvironment,
} from "@/lib/operations/d2-operator-auth";

const CAPABILITY_ID = "airtable.create_record";
const CAPABILITY_VERSION = 1;
const STEP_ID = "d2_airtable_create_record";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AcceptanceEnvironment = D2OperatorEnvironment;

type AcceptanceDependencies = {
  environment?: AcceptanceEnvironment;
  executor?: Pick<ConnectorRunnerExecutor, "execute">;
  randomUUID?: () => string;
};

function parseFields(value: string | undefined): Record<string, unknown> | null {
  if (!value || Buffer.byteLength(value, "utf8") > 60 * 1024) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function isAirtableAcceptanceAuthorized(
  request: Request,
  environment: AcceptanceEnvironment = process.env,
): boolean {
  return isD2OperatorAuthorized({
    request,
    environment,
    enabledName: "D2_AIRTABLE_ACCEPTANCE_ENABLED",
    secretName: "D2_AIRTABLE_ACCEPTANCE_SECRET",
  });
}

export async function executeAirtableAcceptance(
  dependencies: AcceptanceDependencies = {},
) {
  const environment = dependencies.environment ?? process.env;
  const ownerId = environment.D2_AIRTABLE_ACCEPTANCE_OWNER_ID ?? "";
  const connectionId = environment.D2_AIRTABLE_ACCEPTANCE_CONNECTION_ID ?? "";
  const baseId = environment.D2_AIRTABLE_ACCEPTANCE_BASE_ID ?? "";
  const tableId = environment.D2_AIRTABLE_ACCEPTANCE_TABLE_ID ?? "";
  const fields = parseFields(environment.D2_AIRTABLE_ACCEPTANCE_FIELDS_JSON);
  if (!UUID.test(ownerId) || !UUID.test(connectionId) || !fields) {
    throw new Error("D2 acceptance configuration is unavailable.");
  }
  const makeUuid = dependencies.randomUUID ?? randomUUID;
  const requestId = makeUuid();
  const executionId = makeUuid();
  const workflowVersionId = makeUuid();
  const request: CapabilityExecutionRequest = {
    authenticatedUserId: ownerId,
    workflowOwnerId: ownerId,
    credentialReference: { connectionId, connectorId: "airtable" },
    envelope: {
      protocolVersion: 1,
      requestId,
      executionId,
      workflowVersionId,
      stepId: STEP_ID,
      capabilityId: CAPABILITY_ID,
      capabilityVersion: CAPABILITY_VERSION,
      mode: "TEST",
      idempotencyKey: `${executionId}:${STEP_ID}:v1`,
      input: { baseId, tableId, fields },
    },
  };
  const result = await (dependencies.executor ?? new ConnectorRunnerExecutor()).execute(request);
  if (!result.ok || typeof result.output.recordId !== "string") {
    return { ok: false as const, errorCategory: result.ok ? "DELEGATED_BAD_RESPONSE" : result.errorCategory };
  }
  return { ok: true as const, requestId, executionId, recordId: result.output.recordId };
}

export async function handleAirtableAcceptancePost(
  request: Request,
  dependencies: AcceptanceDependencies = {},
): Promise<Response> {
  const environment = dependencies.environment ?? process.env;
  if (!isAirtableAcceptanceAuthorized(request, environment)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await executeAirtableAcceptance({ ...dependencies, environment });
    return result.ok
      ? Response.json(result, { status: 200 })
      : Response.json({ ok: false, error: "Airtable acceptance execution failed." }, { status: 502 });
  } catch {
    return Response.json(
      { ok: false, error: "Airtable acceptance execution failed." },
      { status: 500 },
    );
  }
}
