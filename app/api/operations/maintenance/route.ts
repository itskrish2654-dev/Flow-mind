import { timingSafeEqual } from "node:crypto";

import { reconcileFailedAccountDeletions } from "@/lib/account-deletion-maintenance";
import { captureOperationalError, captureOperationalEvent } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization");
  if (!secret || !supplied) return false;
  const expected = `Bearer ${secret}`;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  try {
    const now = Date.now();
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("run_operational_maintenance", {
      p_stale_before: new Date(now - 15 * 60_000).toISOString(),
      p_rate_limit_retention_before: new Date(now - 24 * 60 * 60_000).toISOString(),
      p_deletion_job_stale_before: new Date(now - 15 * 60_000).toISOString(),
    });
    if (error) throw new Error("maintenance_rpc_failed");
    const { data: connectorMetrics, error: connectorError } = await admin.rpc("run_connector_maintenance", {});
    if (connectorError) throw new Error("connector_maintenance_rpc_failed");
    const result = data && typeof data === "object" && !Array.isArray(data) ? data : {};
    const deletionJobs = await reconcileFailedAccountDeletions();
    await captureOperationalEvent({
      level: "info",
      event: "operational_maintenance_completed",
      durationMs: Date.now() - started,
      status: typeof result.status === "string" ? result.status : "succeeded",
      metadata: {
        staleExecutions: result.staleExecutions,
        expiredRateLimits: result.expiredRateLimits,
        expiredConcurrencyLeases: result.expiredConcurrencyLeases,
        staleDeletionJobs: result.staleDeletionJobs,
        deletionJobsInspected: deletionJobs.inspected,
        deletionJobsRetried: deletionJobs.retried,
        deletionJobsSucceeded: deletionJobs.succeeded,
        connectorMetrics,
      },
    });
    return Response.json({ ok: true, status: result.status ?? "succeeded" });
  } catch (error) {
    try {
      await createAdminClient().from("operational_maintenance_runs").insert({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_category: "maintenance_failed",
        metrics: {},
      });
    } catch {
      // The structured runtime log below remains the fail-safe when the database is unavailable.
    }
    const reference = await captureOperationalError({
      event: "operational_maintenance_failed",
      error,
      durationMs: Date.now() - started,
      status: "failed",
      errorCategory: "maintenance_failed",
    });
    return Response.json({ ok: false, error: "Maintenance failed.", reference }, { status: 500 });
  }
}
