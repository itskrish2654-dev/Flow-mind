import "server-only";

import { createHmac, randomUUID } from "node:crypto";

import type { Json } from "@/lib/supabase/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { redactForLog } from "@/lib/security/redaction";

export type LogLevel = "info" | "warn" | "error";

export type OperationalEvent = {
  level: LogLevel;
  event: string;
  requestId?: string | null;
  userId?: string | null;
  workflowId?: string | null;
  workflowVersionId?: string | null;
  executionId?: string | null;
  stepId?: string | null;
  capability?: string | null;
  durationMs?: number | null;
  status?: string | null;
  errorCategory?: string | null;
  metadata?: Record<string, unknown>;
};

export const PRODUCT_EVENTS = [
  "signup_completed",
  "login_completed",
  "recovery_requested",
  "dashboard_viewed",
  "prompt_submitted",
  "planner_ready_to_compile",
  "planner_needs_clarification",
  "planner_unsupported",
  "planner_conflicting_requirements",
  "homepage_demo_started",
  "homepage_demo_submitted",
  "homepage_demo_supported",
  "homepage_demo_unsupported",
  "homepage_demo_clarification",
  "homepage_demo_build_clicked",
  "workflow_created",
  "second_workflow_created",
  "workflow_configured",
  "workflow_published",
  "workflow_unpublished",
  "execution_started",
  "execution_succeeded",
  "execution_partially_failed",
  "execution_failed",
  "execution_retry_attempted",
  "execution_retry_succeeded",
  "public_form_failed",
  "ai_failed",
  "pdf_failed",
  "quota_reached",
] as const;

export type ProductEventName = (typeof PRODUCT_EVENTS)[number];

const PRIVATE_METADATA_KEY =
  /password|captcha|token|secret|authorization|cookie|credential|cipher|nonce|auth[_-]?tag|prompt|submission|input|output|content|document[_-]?url|email/i;

const SAFE_ANALYTICS_KEYS = new Set([
  "planner_status",
  "capability",
  "category",
  "status",
  "trigger_type",
  "step_count",
  "workflow_count",
  "published",
  "retry",
  "success",
  "duration_ms",
  "failure_category",
  "source",
]);

function runtimeEnvironment(): string {
  return (process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown").slice(0, 40);
}

function releaseIdentifier(): string | null {
  const release = process.env.VERCEL_GIT_COMMIT_SHA || process.env.FLOWMIND_RELEASE;
  return release ? release.slice(0, 100) : null;
}

export function hashOperationalIdentity(value?: string | null): string | null {
  if (!value) return null;
  const secret = process.env.FLOWMIND_RATE_LIMIT_SECRET;
  if (!secret || secret.length < 32) return null;
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function sanitizeOperationalMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, Json | undefined> {
  if (!metadata) return {};
  const sanitized = redactForLog(metadata);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return {};
  return Object.fromEntries(
    Object.entries(sanitized as Record<string, unknown>)
      .filter(([key]) => !PRIVATE_METADATA_KEY.test(key))
      .slice(0, 20)
      .map(([key, value]) => [key.slice(0, 80), value as Json]),
  );
}

function structuredPayload(event: OperationalEvent, eventId: string) {
  return {
    timestamp: new Date().toISOString(),
    level: event.level,
    event: event.event.slice(0, 120),
    event_id: eventId,
    request_id: event.requestId ?? null,
    user_id_hash: hashOperationalIdentity(event.userId),
    workflow_id: event.workflowId ?? null,
    workflow_version_id: event.workflowVersionId ?? null,
    execution_id: event.executionId ?? null,
    step_id: event.stepId ?? null,
    capability: event.capability ?? null,
    duration_ms: event.durationMs ?? null,
    status: event.status ?? null,
    error_category: event.errorCategory ?? null,
    environment: runtimeEnvironment(),
    release: releaseIdentifier(),
    metadata: sanitizeOperationalMetadata(event.metadata),
  };
}

export async function captureOperationalEvent(event: OperationalEvent): Promise<string> {
  const eventId = randomUUID();
  const payload = structuredPayload(event, eventId);
  const line = JSON.stringify(payload);
  if (event.level === "error") console.error(line);
  else if (event.level === "warn") console.warn(line);
  else console.info(line);

  try {
    const { error } = await createAdminClient().from("operational_events").insert({
      id: eventId,
      level: event.level,
      event: payload.event,
      request_id: payload.request_id,
      user_id_hash: payload.user_id_hash,
      workflow_id: payload.workflow_id,
      workflow_version_id: payload.workflow_version_id,
      execution_id: payload.execution_id,
      step_id: payload.step_id,
      capability: payload.capability,
      duration_ms: payload.duration_ms,
      status: payload.status,
      error_category: payload.error_category,
      environment: payload.environment,
      release: payload.release,
      metadata: payload.metadata,
    });
    if (error) console.error(JSON.stringify({ event: "telemetry_persistence_failed", category: "database" }));
  } catch {
    // Runtime logs are the fail-safe monitoring sink when telemetry storage is unavailable.
  }
  return eventId.slice(0, 8).toUpperCase();
}

export async function captureOperationalError(
  event: Omit<OperationalEvent, "level"> & { error?: unknown },
): Promise<string> {
  const { error, metadata, ...context } = event;
  return captureOperationalEvent({
    ...context,
    level: "error",
    metadata: {
      ...metadata,
      ...(error instanceof Error
        ? { errorName: error.name, errorMessage: error.message }
        : error ? { errorName: "UnknownError" } : {}),
    },
  });
}

export function sanitizeAnalyticsProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, Json | undefined> {
  if (!properties) return {};
  return Object.fromEntries(
    Object.entries(properties)
      .filter(([key, value]) =>
        SAFE_ANALYTICS_KEYS.has(key) &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null),
      )
      .slice(0, 20)
      .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 100) : value as Json]),
  );
}

export async function trackProductEvent(input: {
  event: ProductEventName;
  userId?: string | null;
  anonymousId?: string | null;
  workflowId?: string | null;
  properties?: Record<string, unknown>;
}): Promise<void> {
  const properties = sanitizeAnalyticsProperties(input.properties);
  try {
    const { error } = await createAdminClient().from("product_analytics_events").insert({
      event_name: input.event,
      user_id_hash: hashOperationalIdentity(input.userId),
      anonymous_id_hash: hashOperationalIdentity(input.anonymousId),
      workflow_id: input.workflowId ?? null,
      environment: runtimeEnvironment(),
      properties,
    });
    if (error) {
      await captureOperationalEvent({
        level: "warn",
        event: "analytics_persistence_failed",
        errorCategory: "database",
        metadata: { analyticsEvent: input.event },
      });
    }
  } catch {
    console.warn(JSON.stringify({ event: "analytics_persistence_failed", category: "database" }));
  }
}
