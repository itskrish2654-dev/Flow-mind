import { createHash, randomUUID } from "node:crypto";
import { after, NextResponse } from "next/server";

import { getConnectorTrigger } from "@/lib/connectors/registry";
import { verifyConnectorEndpointToken } from "@/lib/connectors/subscriptions";
import { dispatchConnectorReceipt } from "@/lib/connectors/webhook-dispatch";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { SECURITY_LIMITS, enforceRateLimit, enforceUsageQuota } from "@/lib/security/limits";
import { getClientIp } from "@/lib/security/request-context";

export const maxDuration = 30;
const MAX_EVENT_BYTES = 64 * 1024;

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== "flowmind_webhook") return NextResponse.json({ error: "Provider not found." }, { status: 404 });
  const url = new URL(request.url); const subscriptionId = url.searchParams.get("subscription") ?? ""; const token = url.searchParams.get("token") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(subscriptionId)) return NextResponse.json({ error: "Invalid endpoint." }, { status: 404 });
  let verified = false; try { verified = verifyConnectorEndpointToken(subscriptionId, token); } catch { verified = false; }
  if (!verified) return NextResponse.json({ error: "Invalid endpoint token." }, { status: 401 });
  const admin = createAdminClient();
  const { data: subscription } = await admin.from("connector_subscriptions").select("id, user_id, workflow_id, workflow_version_id, connector_id, operation_key, operation_version, status").eq("id", subscriptionId).eq("connector_id", provider).eq("status", "active").maybeSingle();
  if (!subscription) return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_EVENT_BYTES) return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_EVENT_BYTES) return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  let payload: unknown; try { payload = JSON.parse(Buffer.from(raw).toString("utf8")); } catch { return NextResponse.json({ error: "Valid JSON is required." }, { status: 400 }); }
  const registered = getConnectorTrigger(provider, subscription.operation_key, subscription.operation_version);
  if (!registered || !registered.operation.production || !registered.handler || !(await registered.handler.verify(request, raw))) return NextResponse.json({ error: "Webhook verification failed." }, { status: 401 });
  try {
    const ip = await getClientIp();
    await enforceRateLimit("connector-webhook-ip", [ip], SECURITY_LIMITS.publicFormIp);
    await enforceRateLimit("connector-webhook-subscription", [subscription.id], SECURITY_LIMITS.publicFormWorkflow);
    await enforceUsageQuota(subscription.user_id, "public_form_submissions");
  } catch { return NextResponse.json({ error: "Request limit reached." }, { status: 429 }); }
  const providerEventKey = (request.headers.get("x-flowmind-event-id") ?? request.headers.get("idempotency-key") ?? createHash("sha256").update(raw).digest("hex")).slice(0, 200);
  const normalized = await registered.handler.normalize(request, payload, registered.operation);
  const receiptId = randomUUID();
  const { error } = await admin.from("connector_event_receipts").insert({ id: receiptId, subscription_id: subscription.id, workflow_id: subscription.workflow_id, workflow_version_id: subscription.workflow_version_id, provider_event_key: providerEventKey, status: "queued", payload: normalized.data as Json, safe_metadata: { connectorId: provider, operationKey: subscription.operation_key } });
  if (error?.code === "23505") return NextResponse.json({ accepted: true, duplicate: true }, { status: 202 });
  if (error) return NextResponse.json({ error: "Event could not be queued." }, { status: 503 });
  after(() => dispatchConnectorReceipt(receiptId));
  return NextResponse.json({ accepted: true, receiptId }, { status: 202 });
}
