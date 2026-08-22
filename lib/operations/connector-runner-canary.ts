import "@/lib/server-only-runtime";

import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { ConnectorRunnerExecutor } from "@/lib/executors/connector-runner";
import type {
  CapabilityExecutionRequest,
  DelegatedErrorCategory,
} from "@/lib/executors/types";
import type { OperationalEvent } from "@/lib/observability";

const CANARY_CAPABILITY = "internal.connector_runner_canary";
const CANARY_CAPABILITY_VERSION = 1;
const CANARY_CREDENTIAL_PREFIX = "CRAZYLOOPS_D17_CANARY_";
const CANARY_PROOF_CONTEXT = "CrazyLoops runner proof";
const CANARY_STEP_ID = "d17_vercel_runner_canary";
const MIN_OPERATOR_SECRET_LENGTH = 32;

const FORBIDDEN_SECRET_NAMES = [
  "CRON_SECRET",
  "SCHEDULE_DISPATCH_SECRET",
  "CONNECTOR_RUNNER_SECRET",
  "ACTIVEPIECES_BRIDGE_SECRET",
  "SUPABASE_SECRET_KEY",
  "GROQ_API_KEY",
  "FLOWMIND_CREDENTIAL_MASTER_KEY",
  "FLOWMIND_RATE_LIMIT_SECRET",
  "FLOWMIND_CONNECTOR_ENDPOINT_SECRET",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "FLOWMIND_CONNECTOR_SLACK_CLIENT_SECRET",
  "FLOWMIND_CONNECTOR_SLACK_SIGNING_SECRET",
  "FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET",
  "FLOWMIND_CONNECTOR_NOTION_WEBHOOK_VERIFICATION_TOKEN",
  "FLOWMIND_CONNECTOR_NOTION_SETUP_SECRET",
  "TURNSTILE_SECRET_KEY",
] as const;

type TelemetryCapture = (event: OperationalEvent) => Promise<unknown>;
type CanaryEnvironment = Record<string, string | undefined>;

type CanaryDependencies = {
  environment?: CanaryEnvironment;
  fetchImplementation?: typeof fetch;
  captureTelemetry?: TelemetryCapture;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  randomUUID?: () => string;
};

type CanaryExecutionResult =
  | {
      ok: true;
      requestId: string;
      executionId: string;
      proofVerified: true;
    }
  | {
      ok: false;
      requestId: string;
      executionId: string;
      errorCategory: DelegatedErrorCategory | "CANARY_PROOF_MISMATCH";
    };

function constantTimeTextEqual(expected: string, supplied: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function hasDedicatedOperatorSecret(environment: CanaryEnvironment, secret: string): boolean {
  const forbiddenValues = [
    ...FORBIDDEN_SECRET_NAMES.map((name) => environment[name]),
    ...Object.entries(environment)
      .filter(([name]) => /^CONNECTOR_RUNNER_WRAP_KEY_V\d+$/.test(name))
      .map(([, value]) => value),
  ];
  return !forbiddenValues.some((forbidden) => {
    return Boolean(forbidden) && constantTimeTextEqual(secret, forbidden ?? "");
  });
}

export function isConnectorRunnerCanaryAuthorized(
  request: Request,
  environment: CanaryEnvironment = process.env,
): boolean {
  if (environment.D17_CONNECTOR_RUNNER_CANARY_ENABLED !== "true") return false;
  const secret = environment.CONNECTOR_RUNNER_CANARY_SECRET ?? "";
  if (
    secret.length < MIN_OPERATOR_SECRET_LENGTH ||
    !hasDedicatedOperatorSecret(environment, secret)
  ) {
    return false;
  }
  const authorization = request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  return constantTimeTextEqual(secret, supplied);
}

async function emitSafely(capture: TelemetryCapture, event: OperationalEvent): Promise<void> {
  try {
    await capture(event);
  } catch {
    // Acceptance truth does not depend on the telemetry sink.
  }
}

export async function executeConnectorRunnerCanary(
  dependencies: CanaryDependencies = {},
): Promise<CanaryExecutionResult> {
  const makeRandomBytes = dependencies.randomBytes ?? randomBytes;
  const makeRandomUUID = dependencies.randomUUID ?? randomUUID;
  const now = dependencies.now ?? Date.now;
  const capture = dependencies.captureTelemetry ?? (async (event: OperationalEvent) => {
    const { captureOperationalEvent } = await import("@/lib/observability");
    return captureOperationalEvent(event);
  });
  const randomMaterial = makeRandomBytes(48);
  const credential = (() => {
    try {
      return Buffer.from(
        `${CANARY_CREDENTIAL_PREFIX}${randomMaterial.toString("hex")}`,
        "utf8",
      );
    } finally {
      randomMaterial.fill(0);
    }
  })();

  try {
    const requestId = makeRandomUUID();
    const executionId = makeRandomUUID();
    const workflowVersionId = makeRandomUUID();
    const ownerId = makeRandomUUID();
    const startedAt = now();
    const expectedProof = createHmac("sha256", credential)
      .update(CANARY_PROOF_CONTEXT)
      .digest("hex");
    const request: CapabilityExecutionRequest = {
      authenticatedUserId: ownerId,
      workflowOwnerId: ownerId,
      envelope: {
        protocolVersion: 1,
        requestId,
        executionId,
        workflowVersionId,
        stepId: CANARY_STEP_ID,
        capabilityId: CANARY_CAPABILITY,
        capabilityVersion: CANARY_CAPABILITY_VERSION,
        mode: "TEST",
        idempotencyKey: `${executionId}:${CANARY_STEP_ID}:v1`,
        input: { simulation: "success" },
      },
    };
    const executor = new ConnectorRunnerExecutor({
      ...(dependencies.fetchImplementation
        ? { fetchImplementation: dependencies.fetchImplementation }
        : {}),
      captureTelemetry: capture,
      now,
      resolveCredential: async () => credential,
    });
    const result = await executor.execute(request);
    if (!result.ok) {
      await emitSafely(capture, {
        level: "warn",
        event: "d17_connector_runner_canary_failed",
        requestId,
        userId: ownerId,
        workflowVersionId,
        executionId,
        stepId: CANARY_STEP_ID,
        capability: CANARY_CAPABILITY,
        durationMs: Math.max(0, now() - startedAt),
        status: "failed",
        errorCategory: result.errorCategory,
        metadata: { mode: "TEST", proofVerified: false },
      });
      return { ok: false, requestId, executionId, errorCategory: result.errorCategory };
    }
    const proof = typeof result.output.proof === "string" ? result.output.proof : "";
    if (!constantTimeTextEqual(expectedProof, proof)) {
      await emitSafely(capture, {
        level: "warn",
        event: "d17_connector_runner_canary_failed",
        requestId,
        userId: ownerId,
        workflowVersionId,
        executionId,
        stepId: CANARY_STEP_ID,
        capability: CANARY_CAPABILITY,
        durationMs: Math.max(0, now() - startedAt),
        status: "failed",
        errorCategory: "CANARY_PROOF_MISMATCH",
        metadata: { mode: "TEST", proofVerified: false },
      });
      return { ok: false, requestId, executionId, errorCategory: "CANARY_PROOF_MISMATCH" };
    }
    await emitSafely(capture, {
      level: "info",
      event: "d17_connector_runner_canary_succeeded",
      requestId,
      userId: ownerId,
      workflowVersionId,
      executionId,
      stepId: CANARY_STEP_ID,
      capability: CANARY_CAPABILITY,
      durationMs: Math.max(0, now() - startedAt),
      status: "succeeded",
      metadata: { mode: "TEST", proofVerified: true },
    });
    return { ok: true, requestId, executionId, proofVerified: true };
  } finally {
    credential.fill(0);
  }
}

export async function handleConnectorRunnerCanaryPost(
  request: Request,
  dependencies: CanaryDependencies = {},
): Promise<Response> {
  const environment = dependencies.environment ?? process.env;
  if (!isConnectorRunnerCanaryAuthorized(request, environment)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await executeConnectorRunnerCanary(dependencies);
    if (!result.ok) {
      return Response.json(
        { ok: false, error: "Connector Runner canary failed." },
        { status: 502 },
      );
    }
    return Response.json({
      ok: true,
      requestId: result.requestId,
      executionId: result.executionId,
      proofVerified: true,
    });
  } catch {
    return Response.json(
      { ok: false, error: "Connector Runner canary failed." },
      { status: 500 },
    );
  }
}
