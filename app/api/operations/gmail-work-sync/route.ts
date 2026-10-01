import { timingSafeEqual } from "node:crypto";

import {
  drainGmailIngestion,
  initializeExistingGmailWorkIntake,
  pollGmailWorkIntake,
} from "@/lib/connectors/google/gmail-push";
import { captureOperationalError, captureOperationalEvent } from "@/lib/observability";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request: Request) {
  const secret = process.env.SCHEDULE_DISPATCH_SECRET;
  const supplied = request.headers.get("authorization");
  if (!secret || !supplied) return false;
  const expected = `Bearer ${secret}`;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    const initialized = await initializeExistingGmailWorkIntake(1);
    const polled = await pollGmailWorkIntake(1);
    const drained = await drainGmailIngestion(1, 8);
    await captureOperationalEvent({ level: "info", event: "gmail_work_sync_completed", status: "succeeded",
      metadata: {
        initialized: initialized.initialized, initializationFailed: initialized.failed,
        polled: polled.succeeded, pollFailed: polled.failed,
        ingestionClaimed: drained.claimed, ingestionFailed: drained.failed,
      } });
    return Response.json({ ok: true, initialized, polled, drained });
  } catch (error) {
    const reference = await captureOperationalError({ event: "gmail_work_sync_failed", error,
      status: "failed", errorCategory: "gmail_sync_failed" });
    return Response.json({ ok: false, error: "Gmail work sync failed.", reference }, { status: 500 });
  }
}
