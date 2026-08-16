import { timingSafeEqual } from "node:crypto";

import { captureOperationalError, captureOperationalEvent } from "@/lib/observability";
import { dispatchDueSchedules } from "@/lib/scheduled-workflows";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request: Request): boolean {
  const secret = process.env.SCHEDULE_DISPATCH_SECRET;
  const supplied = request.headers.get("authorization");
  if (!secret || !supplied) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const started = Date.now();
  try {
    const metrics = await dispatchDueSchedules(20);
    await captureOperationalEvent({ level: "info", event: "schedule_dispatch_completed", durationMs: Date.now() - started, status: "succeeded", metadata: metrics });
    return Response.json({ ok: true, metrics });
  } catch (error) {
    const reference = await captureOperationalError({ event: "schedule_dispatch_failed", error, durationMs: Date.now() - started, status: "failed", errorCategory: "schedule_dispatch_failed" });
    return Response.json({ ok: false, error: "Schedule dispatch failed.", reference }, { status: 500 });
  }
}
