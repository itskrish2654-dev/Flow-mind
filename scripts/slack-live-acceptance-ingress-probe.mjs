import { createHash, createHmac, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

const expectedProject = "gamdxwtgccluifatcrrs";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
const signingSecret = process.env.FLOWMIND_CONNECTOR_SLACK_SIGNING_SECRET;
const ownerId = process.env.WORK_OS_SLACK_ACCEPTANCE_USER_ID;
const ingress = process.env.WORK_OS_SLACK_INGRESS_URL;
if (!url || !secret || !signingSecret || !ownerId || !ingress
  || new URL(url).hostname.split(".")[0] !== expectedProject
  || new URL(ingress).pathname !== "/api/connectors/events/slack") {
  throw new Error("The isolated Slack acceptance configuration is incomplete.");
}

const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const owner = await admin.auth.admin.getUserById(ownerId);
if (owner.error || owner.data.user?.user_metadata?.acceptance_run !== "work-os-slack-v1") {
  throw new Error("The marked Slack acceptance owner is unavailable.");
}
const connection = await admin.from("connector_connections")
  .select("id,workspace_id,external_account_id,safe_metadata")
  .eq("user_id", ownerId).eq("provider_family", "slack").single();
if (connection.error || !connection.data) throw new Error("The marked Slack installation is unavailable.");
const metadata = connection.data.safe_metadata;
const installingUserId = metadata && typeof metadata === "object" && !Array.isArray(metadata)
  ? metadata.installingUserId : null;
if (typeof installingUserId !== "string" || !/^[UW][A-Z0-9]{7,20}$/.test(installingUserId)) {
  throw new Error("The installing user identity is unavailable.");
}

const eventId = `EvAcceptance${randomUUID().replaceAll("-", "")}`;
const dedupeKey = `slack-event:${createHash("sha256").update(eventId).digest("hex")}`;
const now = Math.floor(Date.now() / 1_000);
const text = `<@${installingUserId}> please review the signed Slack acceptance ingress preflight.`;
const raw = JSON.stringify({
  type: "event_callback",
  event_id: eventId,
  team_id: connection.data.external_account_id,
  event_time: now,
  event: {
    type: "message",
    channel_type: "channel",
    channel: "C0BR8V8MKDW",
    user: installingUserId,
    text,
    ts: `${now}.123456`,
  },
});

async function post(body, timestamp = now, signatureBody = body) {
  const signature = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${signatureBody}`).digest("hex")}`;
  const start = Date.now();
  const response = await fetch(ingress, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature,
    },
    body,
    signal: AbortSignal.timeout(12_000),
  });
  return { status: response.status, elapsedMs: Date.now() - start };
}

async function counts() {
  const [message, work] = await Promise.all([
    admin.from("slack_message_events").select("id", { count: "exact", head: true })
      .eq("user_id", ownerId).eq("connection_id", connection.data.id).eq("provider_event_id", eventId),
    admin.from("work_items").select("id", { count: "exact", head: true })
      .eq("assignee_user_id", ownerId).eq("dedupe_key", dedupeKey),
  ]);
  if (message.error || work.error) throw new Error("Preflight fixture counts are unavailable.");
  return { events: message.count, workItems: work.count };
}

try {
  const first = await post(raw);
  const afterFirst = await counts();
  const duplicate = await post(raw);
  const afterDuplicate = await counts();
  const tampered = await post(raw.replace("please review", "please ignore"), now, raw);
  const stale = await post(raw, now - 600);
  const result = {
    firstHttp: first.status,
    firstAckMs: first.elapsedMs,
    oneEvent: afterFirst.events === 1,
    oneActionableWorkItem: afterFirst.workItems === 1,
    duplicateHttp: duplicate.status,
    duplicateStillOneEvent: afterDuplicate.events === 1,
    duplicateStillOneWorkItem: afterDuplicate.workItems === 1,
    tamperedDenied: tampered.status === 401,
    staleDenied: stale.status === 401,
  };
  console.log(JSON.stringify(result));
  if (first.status !== 200 || duplicate.status !== 200 || Object.entries(result).some(([key, value]) => key !== "firstAckMs" && typeof value === "boolean" && !value)) {
    process.exitCode = 1;
  }
} finally {
  const removedWork = await admin.from("work_items").delete().eq("assignee_user_id", ownerId).eq("dedupe_key", dedupeKey);
  const removedEvent = await admin.from("slack_message_events").delete().eq("user_id", ownerId)
    .eq("connection_id", connection.data.id).eq("provider_event_id", eventId);
  if (removedWork.error || removedEvent.error) throw new Error("Signed ingress preflight cleanup failed.");
  const final = await counts();
  console.log(JSON.stringify({ preflightCleanup: final.events === 0 && final.workItems === 0 }));
  if (final.events !== 0 || final.workItems !== 0) process.exitCode = 1;
}
