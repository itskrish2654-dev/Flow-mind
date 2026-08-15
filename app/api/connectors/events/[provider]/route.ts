import { createHash, randomUUID } from "node:crypto";
import { after, NextResponse } from "next/server";

import { getConnectorTrigger } from "@/lib/connectors/registry";
import { verifyConnectorEndpointToken } from "@/lib/connectors/subscriptions";
import { dispatchConnectorReceipt } from "@/lib/connectors/webhook-dispatch";
import { processGmailPush, verifyGooglePubSubRequest } from "@/lib/connectors/google/gmail-push";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { SECURITY_LIMITS, enforceRateLimit, enforceUsageQuota } from "@/lib/security/limits";
import { getClientIp } from "@/lib/security/request-context";
import { queueSlackEvent } from "@/lib/connectors/slack/inbound";
import { queueNotionEvent } from "@/lib/connectors/notion/inbound";
import { getSlackUrlVerificationChallenge, verifySlackRequest, type SlackEventEnvelope } from "@/lib/connectors/slack/events";
import { getInitialNotionVerificationToken, type NotionWebhookEvent } from "@/lib/connectors/notion/webhooks";
import { captureInitialNotionVerificationToken, consumeCapturedNotionVerificationToken } from "@/lib/connectors/notion/verification-capture";

export const maxDuration = 30;
const MAX_EVENT_BYTES = 64 * 1024;

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== "notion") return NextResponse.json({ error: "Provider not found." }, { status: 404 });
  try {
    const result = await consumeCapturedNotionVerificationToken(request);
    if (result.status === "disabled") return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (result.status === "unauthorized") return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: { "Cache-Control": "no-store" } });
    if (result.status === "empty") return NextResponse.json({ error: "No unexpired verification token is waiting." }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ verification_token: result.token }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Verification token retrieval is temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!["flowmind_webhook", "google_gmail", "slack", "notion"].includes(provider)) return NextResponse.json({ error: "Provider not found." }, { status: 404 });
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_EVENT_BYTES) return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_EVENT_BYTES) return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  let payload: unknown; try { payload = JSON.parse(Buffer.from(raw).toString("utf8")); } catch { return NextResponse.json({ error: "Valid JSON is required." }, { status: 400 }); }
  if (provider === "google_gmail") {
    if (!(await verifyGooglePubSubRequest(request))) {
      return NextResponse.json({ error: "Google notification verification failed." }, { status: 401 });
    }
    try {
      const receiptIds = await processGmailPush(request, payload, true);
      after(() => Promise.allSettled(receiptIds.map((receiptId) => dispatchConnectorReceipt(receiptId))));
      return NextResponse.json({ accepted: true, queued: receiptIds.length }, { status: 202 });
    } catch { return NextResponse.json({ error: "Google notification processing is temporarily unavailable." }, { status: 503 }); }
  }
  if (provider === "slack") {
    try {
      const slackPayload = payload as SlackEventEnvelope;
      const challenge = getSlackUrlVerificationChallenge(slackPayload);
      if (slackPayload.type === "url_verification") {
        if (!verifySlackRequest(request, raw)) return NextResponse.json({ error: "Slack request verification failed." }, { status: 401 });
        if (!challenge) return NextResponse.json({ error: "Slack challenge is missing." }, { status: 400 });
        return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      const queued = await queueSlackEvent(request, raw, slackPayload);
      after(() => Promise.allSettled(queued.receiptIds.map((receiptId) => dispatchConnectorReceipt(receiptId))));
      return NextResponse.json({ accepted: true, queued: queued.receiptIds.length }, { status: 200 });
    } catch (error) {
      const invalid = error instanceof Error && error.message === "SLACK_SIGNATURE_INVALID";
      return NextResponse.json({ error: invalid ? "Slack request verification failed." : "Slack event could not be queued." }, { status: invalid ? 401 : 503 });
    }
  }
  if (provider === "notion") {
    try {
      const notionPayload = payload as NotionWebhookEvent;
      const initialVerificationToken = getInitialNotionVerificationToken(payload);
      if (initialVerificationToken) {
        const capture = await captureInitialNotionVerificationToken(initialVerificationToken).catch(() => "capture_failed" as const);
        return NextResponse.json({ accepted: true, verification: capture }, { status: 200, headers: { "Cache-Control": "no-store" } });
      }
      const queued = await queueNotionEvent(request, raw, notionPayload);
      after(() => Promise.allSettled(queued.receiptIds.map((receiptId) => dispatchConnectorReceipt(receiptId))));
      return NextResponse.json({ accepted: true, queued: queued.receiptIds.length }, { status: 200 });
    } catch (error) {
      const invalid = error instanceof Error && ["NOTION_SIGNATURE_INVALID", "NOTION_VERSION_MISMATCH"].includes(error.message);
      return NextResponse.json({ error: invalid ? "Notion request verification failed." : "Notion event could not be queued." }, { status: invalid ? 401 : 503 });
    }
  }
  const url = new URL(request.url); const subscriptionId = url.searchParams.get("subscription") ?? ""; const token = url.searchParams.get("token") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(subscriptionId)) return NextResponse.json({ error: "Invalid endpoint." }, { status: 404 });
  let verified = false; try { verified = verifyConnectorEndpointToken(subscriptionId, token); } catch { verified = false; }
  if (!verified) return NextResponse.json({ error: "Invalid endpoint token." }, { status: 401 });
  const admin = createAdminClient();
  const { data: subscription } = await admin.from("connector_subscriptions").select("id, user_id, workflow_id, workflow_version_id, connector_id, operation_key, operation_version, status").eq("id", subscriptionId).eq("connector_id", provider).eq("status", "active").maybeSingle();
  if (!subscription) return NextResponse.json({ error: "Subscription not found." }, { status: 404 });
  const registered = getConnectorTrigger(provider, subscription.operation_key, subscription.operation_version);
  if (!registered || !registered.operation.production || !registered.handler || !(await registered.handler.verify(request, raw))) return NextResponse.json({ error: "Webhook verification failed." }, { status: 401 });
  try {
    const ip = await getClientIp();
    await enforceRateLimit("connector-webhook-ip", [ip], SECURITY_LIMITS.publicFormIp);
    await enforceRateLimit("connector-webhook-subscription", [subscription.id], SECURITY_LIMITS.publicFormWorkflow);
    await enforceUsageQuota(subscription.user_id, "public_form_submissions");
  } catch { return NextResponse.json({ error: "Request limit reached." }, { status: 429 }); }
  const providerEventKey = (request.headers.get("x-crazyloops-event-id") ?? request.headers.get("x-flowmind-event-id") ?? request.headers.get("idempotency-key") ?? createHash("sha256").update(raw).digest("hex")).slice(0, 200);
  const normalized = await registered.handler.normalize(request, payload, registered.operation);
  const receiptId = randomUUID();
  const { error } = await admin.from("connector_event_receipts").insert({ id: receiptId, subscription_id: subscription.id, workflow_id: subscription.workflow_id, workflow_version_id: subscription.workflow_version_id, provider_event_key: providerEventKey, status: "queued", payload: normalized.data as Json, safe_metadata: { connectorId: provider, operationKey: subscription.operation_key } });
  if (error?.code === "23505") return NextResponse.json({ accepted: true, duplicate: true }, { status: 202 });
  if (error) return NextResponse.json({ error: "Event could not be queued." }, { status: 503 });
  after(() => dispatchConnectorReceipt(receiptId));
  return NextResponse.json({ accepted: true, receiptId }, { status: 202 });
}
