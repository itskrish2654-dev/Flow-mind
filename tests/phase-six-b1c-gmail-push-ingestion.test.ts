import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GMAIL_PUSH_LIMITS,
  GmailHistoryResyncRequiredError,
  compareHistoryIds,
  maxHistoryId,
  normalizeHistoryId,
  parseGmailPushPayload,
  readBoundedGmailHistory,
} from "../lib/connectors/google/gmail-ingestion-core";
import { assessCapability, CAPABILITY_REGISTRY } from "../lib/capability-registry";

const ROUTE = "app/api/connectors/events/[provider]/route.ts";
const PUSH = "lib/connectors/google/gmail-push.ts";
const CORE = "lib/connectors/google/gmail-ingestion-core.ts";
const MAINTENANCE = "app/api/operations/maintenance/route.ts";
const MIGRATION = "supabase/migrations/20260913072359_phase6b1c_gmail_durable_ingestion.sql";

function envelope(overrides: Record<string, unknown> = {}) {
  const notification = {
    emailAddress: "owner@example.com",
    historyId: "18446744073709551610",
    ...((overrides.notification as Record<string, unknown> | undefined) ?? {}),
  };
  return {
    subscription: "projects/crazyloops-prod/subscriptions/gmail-push",
    message: {
      messageId: "12345678901234567890",
      publishTime: "2026-09-13T07:00:00.000Z",
      data: Buffer.from(JSON.stringify(notification)).toString("base64url"),
      ...((overrides.message as Record<string, unknown> | undefined) ?? {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !["message", "notification"].includes(key))),
  };
}

async function sources() {
  const [route, push, core, maintenance, migration] = await Promise.all(
    [ROUTE, PUSH, CORE, MAINTENANCE, MIGRATION].map((file) => readFile(file, "utf8")),
  );
  return { route, push, core, maintenance, migration };
}

test("6B.1C-01 valid authenticated push is durably queued before HTTP 202 and provider work", async () => {
  const { route, push } = await sources();
  assert.ok(route.indexOf("verifyGooglePubSubRequest") < route.indexOf("queueGmailPushNotification(payload)"));
  const queueIndex = route.indexOf("queueGmailPushNotification(payload)");
  assert.ok(queueIndex < route.indexOf("status: 202", queueIndex));
  assert.doesNotMatch(push.slice(push.indexOf("queueGmailPushNotification"), push.indexOf("activateGmailWatch")), /googleApiFetch|dispatchConnectorReceipt|executeWorkflow/);
});

test("6B.1C-02 Pub/Sub duplicate identity has one durable logical receipt", async () => {
  const { migration } = await sources();
  assert.match(migration, /constraint gmail_push_receipts_pubsub_dedupe[\s\S]*unique \(connection_id, pubsub_subscription, pubsub_message_id\)/i);
  assert.match(migration, /on conflict on constraint gmail_push_receipts_pubsub_dedupe do nothing/i);
});

test("6B.1C-03 invalid push auth is rejected before queueing", async () => {
  const { route } = await sources();
  const block = route.slice(route.indexOf('provider === "google_gmail"'), route.indexOf('provider === "slack"'));
  assert.ok(block.indexOf("verifyGooglePubSubRequest") < block.indexOf("queueGmailPushNotification"));
  assert.match(block, /status: 401/);
});

test("6B.1C-04 HTTP envelope size is bounded", async () => {
  const { route } = await sources();
  assert.match(route, /MAX_EVENT_BYTES = 64 \* 1024/);
  assert.match(route, /raw\.byteLength > MAX_EVENT_BYTES/);
  assert.equal(GMAIL_PUSH_LIMITS.envelopeBytes, 64 * 1024);
});

test("6B.1C-05 malformed Base64URL is rejected deterministically", () => {
  assert.throws(() => parseGmailPushPayload(envelope({ message: { data: "***not-base64***" } })), /permanently invalid/);
});

test("6B.1C-06 malformed decoded JSON is rejected deterministically", () => {
  assert.throws(() => parseGmailPushPayload(envelope({ message: { data: Buffer.from("{").toString("base64url") } })), /permanently invalid/);
});

test("6B.1C-07 historyId rejects negatives, fractions, unsafe size, and non-decimal input", () => {
  for (const value of ["-1", "1.2", "1e5", "abc", "18446744073709551616", "0".repeat(21)]) {
    assert.throws(() => normalizeHistoryId(value));
  }
});

test("6B.1C-08 account binding uses verified durable connection and active Gmail subscription", async () => {
  const { migration } = await sources();
  assert.match(migration, /external_account_id <> ''/);
  assert.match(migration, /external_account_label = p_email_address/);
  assert.match(migration, /subscription\.connection_id = connection\.id/);
  assert.match(migration, /subscription\.user_id = connection\.user_id/);
  assert.match(migration, /subscription\.provider_subscription_id = connection\.id::text/);
});

test("6B.1C-09 slow history.list is outside the acknowledgement path", async () => {
  const { route } = await sources();
  const googleBlock = route.slice(route.indexOf('provider === "google_gmail"'), route.indexOf('provider === "slack"'));
  assert.doesNotMatch(googleBlock.slice(0, googleBlock.indexOf("after(")), /users\/me\/history|fetchHistoryPage|googleApiFetch/);
});

test("6B.1C-10 slow messages.get is outside the acknowledgement path", async () => {
  const { route } = await sources();
  assert.doesNotMatch(route, /users\/me\/messages\/\$\{/);
  assert.match(route, /after\(async \(\) =>/);
});

test("6B.1C-11 observed high-watermark comparison is precision-safe and monotonic", () => {
  assert.equal(maxHistoryId(["100", "105", "102"]), "105");
  assert.equal(compareHistoryIds("9007199254740993", "9007199254740992"), 1);
});

test("6B.1C-12 out-of-order notifications retain the maximum observed cursor", () => {
  assert.equal(maxHistoryId(["110", "108", "115", "110"]), "115");
});

test("6B.1C-13 duplicate notifications cannot lower observed state", async () => {
  const { migration } = await sources();
  assert.match(migration, /excluded\.observed_history_id > public\.gmail_ingestion_states\.observed_history_id/);
  assert.match(migration, /else public\.gmail_ingestion_states\.observed_history_id/);
});

test("6B.1C-14 concurrent notification upsert is atomic", async () => {
  const { migration } = await sources();
  assert.match(migration, /insert into public\.gmail_ingestion_states[\s\S]*on conflict on constraint gmail_ingestion_states_pkey do update/i);
});

test("6B.1C-15 only one worker can claim a connection", async () => {
  const { migration } = await sources();
  assert.match(migration, /for update of state skip locked/i);
  assert.match(migration, /lease_until is null or state\.lease_until <= clock_timestamp\(\)/i);
});

test("6B.1C-16 history.list starts from the successfully processed cursor", async () => {
  const { push } = await sources();
  assert.match(push, /startHistoryId", claim\.processed_history_id/);
  assert.doesNotMatch(push, /startHistoryId", claim\.observed_history_id/);
});

test("6B.1C-17 Gmail history pagination carries the page token", async () => {
  let calls = 0;
  const result = await readBoundedGmailHistory({
    processedHistoryId: "10",
    targetHistoryId: "12",
    fetchPage: async (token) => {
      calls += 1;
      return token ? { history: [{ id: "12", messagesAdded: [] }] } : { history: [{ id: "11", messagesAdded: [] }], nextPageToken: "next" };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.completedThrough, "12");
});

test("6B.1C-18 history page bound is enforced", async () => {
  let calls = 0;
  const result = await readBoundedGmailHistory({
    processedHistoryId: "1",
    targetHistoryId: "999",
    fetchPage: async () => ({ history: [{ id: String(++calls + 1), messagesAdded: [] }], nextPageToken: `p${calls}` }),
  });
  assert.equal(calls, GMAIL_PUSH_LIMITS.historyPages);
  assert.equal(result.targetCompleted, false);
});

test("6B.1C-19 history record bound is enforced without jumping the cursor", async () => {
  const records = Array.from({ length: GMAIL_PUSH_LIMITS.historyRecords + 1 }, (_, index) => ({ id: String(index + 2), messagesAdded: [] }));
  const result = await readBoundedGmailHistory({ processedHistoryId: "1", targetHistoryId: "999", fetchPage: async () => ({ history: records }) });
  assert.equal(result.recordsRead, GMAIL_PUSH_LIMITS.historyRecords);
  assert.equal(result.completedThrough, String(GMAIL_PUSH_LIMITS.historyRecords + 1));
  assert.equal(result.targetCompleted, false);
});

test("6B.1C-20 unique message bound stops before an unaccounted history record", async () => {
  const result = await readBoundedGmailHistory({
    processedHistoryId: "1",
    targetHistoryId: "5",
    maxUniqueMessageIds: 2,
    fetchPage: async () => ({ history: [2, 3, 4].map((id) => ({ id: String(id), messagesAdded: [{ message: { id: `m${id}` } }] })) }),
  });
  assert.deepEqual(result.entries.map((entry) => entry.messageId), ["m2", "m3"]);
  assert.equal(result.completedThrough, "3");
});

test("6B.1C-21 runtime message GET count has an explicit hard bound", async () => {
  const { push } = await sources();
  assert.match(push, /Math\.min\(GMAIL_PUSH_LIMITS\.messageFetches, maxMessages\)/);
  assert.match(push, /Math\.max\(1, Math\.min\(maxMessages, GMAIL_PUSH_LIMITS\.messageFetches\)\)/);
  assert.equal(GMAIL_PUSH_LIMITS.messageFetches, 100);
});

test("6B.1C-22 duplicate Gmail message IDs are emitted once across history records", async () => {
  const result = await readBoundedGmailHistory({
    processedHistoryId: "1",
    targetHistoryId: "3",
    fetchPage: async () => ({ history: [2, 3].map((id) => ({ id: String(id), messagesAdded: [{ message: { id: "same" } }] })) }),
  });
  assert.deepEqual(result.entries, [{ historyId: "2", messageId: "same" }]);
});

test("6B.1C-23 processed cursor advances only through lease-bound atomic completion", async () => {
  const { migration } = await sources();
  assert.match(migration, /v_state\.lease_token <> p_lease_token/);
  assert.match(migration, /v_state\.processed_history_id <> p_expected_processed_history_id/);
  assert.match(migration, /set processed_history_id = p_completed_history_id/);
});

test("6B.1C-24 partial provider failure cannot invoke completion", async () => {
  const { push } = await sources();
  assert.ok(push.indexOf("complete_gmail_ingestion") < push.indexOf("catch (error)", push.indexOf("async function processClaim")));
  assert.match(push, /catch \(error\)[\s\S]*deferClaim\(claim, category\)/);
});

test("6B.1C-25 provider 429 remains retryable durable work", async () => {
  const { push, migration } = await sources();
  assert.match(push, /return "transient"/);
  assert.match(migration, /status = case p_error_category[\s\S]*when p_error_category = 'transient'/i);
  assert.match(migration, /else 'pending'/);
});

test("6B.1C-26 provider 5xx remains retryable durable work", async () => {
  const { migration } = await sources();
  assert.match(migration, /next_attempt_at = case[\s\S]*least\(300/i);
  assert.doesNotMatch(migration, /delete from public\.gmail_push_receipts[\s\S]*p_error_category = 'transient'/i);
});

test("6B.1C-27 provider timeout retains processed and observed cursors", async () => {
  const { migration } = await sources();
  const deferFunction = migration.slice(migration.indexOf("create function public.defer_gmail_ingestion"), migration.indexOf("revoke all on function"));
  assert.doesNotMatch(deferFunction, /processed_history_id\s*=/);
  assert.doesNotMatch(deferFunction, /observed_history_id\s*=/);
});

test("6B.1C-28 authentication failure enters reconnect state without cursor movement", async () => {
  const { migration } = await sources();
  assert.match(migration, /when 'authentication' then 'reconnect_required'/);
  assert.match(migration, /last_error_category = p_error_category/);
  assert.doesNotMatch(migration, /status in \('processing', 'resync_required', 'reconnect_required'\)/);
});

test("6B.1C-29 history 404 is resync-required and never jumps to observed", async () => {
  const { push, migration } = await sources();
  assert.match(push, /response\.status === 404/);
  assert.match(push, /GmailHistoryResyncRequiredError/);
  assert.match(migration, /when 'resync_required' then 'resync_required'/);
  const deferFunction = migration.slice(migration.indexOf("create function public.defer_gmail_ingestion"), migration.indexOf("revoke all on function"));
  assert.doesNotMatch(deferFunction, /processed_history_id\s*=/);
  assert.ok(new GmailHistoryResyncRequiredError() instanceof Error);
});

test("6B.1C-30 crash after acknowledgement is recoverable through maintenance drain", async () => {
  const { route, maintenance } = await sources();
  assert.match(route, /queueGmailPushNotification\(payload\)/);
  assert.match(maintenance, /drainGmailIngestion\(5\)/);
});

test("6B.1C-31 mid-process crash leaves cursor unchanged until transactional completion", async () => {
  const { push } = await sources();
  assert.ok(push.indexOf("connector_event_receipts") < push.indexOf("complete_gmail_ingestion"));
  assert.doesNotMatch(push, /\.from\("gmail_ingestion_states"\)\.update/);
});

test("6B.1C-32 Gmail event retry uses a stable receipt key and workflow idempotency", async () => {
  const { push } = await sources();
  const dispatch = await readFile("lib/connectors/webhook-dispatch.ts", "utf8");
  assert.match(push, /provider_event_key: `gmail:\$\{entry\.messageId\}`/);
  assert.match(dispatch, /idempotencyKey: `connector:\$\{receipt\.subscription_id\}:\$\{receipt\.provider_event_key\}`/);
});

test("6B.1C-33 new-email trigger remains INBOX-only and deduped", async () => {
  const { push } = await sources();
  assert.match(push, /normalized\.message\.labels\.includes\("INBOX"\)/);
  assert.match(push, /subscription\.operation_key !== "new_email"/);
  assert.match(push, /seen\.has\(eventIdentity\)/);
});

test("6B.1C-34 matching-search work is bounded and intersects current message IDs", async () => {
  const { push } = await sources();
  assert.match(push, /search\.trim\(\)\.length === 0/);
  assert.match(push, /Gmail search subscription setup is invalid/);
  assert.match(push, /searches\.size > GMAIL_PUSH_LIMITS\.searchQueries/);
  assert.match(push, /searchPagesPerQuery/);
  assert.match(push, /allowedBySearch\.get\(search\)\?\.has\(entry\.messageId\)/);
});

test("6B.1C-35 provider bodies and credentials are absent from durable queue metadata", async () => {
  const { migration, push } = await sources();
  const queueSchema = migration.slice(migration.indexOf("create table public.gmail_push_receipts"), migration.indexOf("create index gmail_ingestion_states"));
  assert.doesNotMatch(queueSchema, /payload|credential|ciphertext|access_token|refresh_token/i);
  assert.doesNotMatch(push, /console\.(log|error)|response\.text\(/);
});

test("6B.1C-36 no Gmail provider request or workflow execution occurs before webhook 202", async () => {
  const { route } = await sources();
  const googleBlock = route.slice(route.indexOf('provider === "google_gmail"'), route.indexOf('provider === "slack"'));
  const beforeAfter = googleBlock.slice(0, googleBlock.indexOf("after("));
  assert.doesNotMatch(beforeAfter, /googleApiFetch|history|messages\.get|dispatchConnector|executeWorkflow|executeAi/);
});

test("6B.1C-37 decoded notification data has an independent 8 KiB bound", () => {
  assert.equal(GMAIL_PUSH_LIMITS.decodedDataBytes, 8 * 1024);
  const data = Buffer.alloc(GMAIL_PUSH_LIMITS.decodedDataBytes + 1, 65).toString("base64url");
  assert.throws(() => parseGmailPushPayload(envelope({ message: { data } })));
});

test("6B.1C-38 Pub/Sub identifiers and publish time are validated", () => {
  assert.throws(() => parseGmailPushPayload(envelope({ message: { messageId: "bad/id" } })));
  assert.throws(() => parseGmailPushPayload(envelope({ subscription: "not-a-subscription" })));
  assert.throws(() => parseGmailPushPayload(envelope({ message: { publishTime: "not-a-date" } })));
});

test("6B.1C-39 lease is bounded, reclaimable, and cannot become permanent", async () => {
  const { migration, push } = await sources();
  assert.match(migration, /p_lease_seconds < 15 or p_lease_seconds > 120/);
  assert.match(migration, /lease_until <= clock_timestamp\(\)/);
  assert.match(push, /GMAIL_INGESTION_LEASE_SECONDS = 120/);
});

test("6B.1C-40 background continuation is only an optimization over durable maintenance", async () => {
  const { route, maintenance } = await sources();
  assert.match(route, /after\(async \(\) =>/);
  assert.match(maintenance, /drainGmailIngestion/);
  assert.match(maintenance, /dispatchQueuedConnectorReceipts/);
});

test("6B.1C-41 database objects are service-only with forced RLS and invoker RPCs", async () => {
  const { migration } = await sources();
  assert.match(migration, /force row level security/g);
  assert.match(migration, /revoke all on public\.gmail_ingestion_states, public\.gmail_push_receipts[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /security invoker/g);
  assert.match(migration, /grant execute[\s\S]*to service_role/i);
});

test("6B.1C-42 observed and processed history cursors are separate durable columns", async () => {
  const { migration } = await sources();
  assert.match(migration, /processed_history_id text not null/);
  assert.match(migration, /observed_history_id text not null/);
  assert.match(migration, /length\(observed_history_id\) > length\(processed_history_id\)/);
});

test("6B.1C-43 Gmail watch renewal does not overwrite the processed cursor", async () => {
  const { push } = await sources();
  const renewalUpdate = push.slice(push.indexOf("if (input.persistActiveSubscriptions"), push.indexOf("await captureOperationalEvent", push.indexOf("if (input.persistActiveSubscriptions")));
  assert.doesNotMatch(renewalUpdate, /cursor_value/);
});

test("6B.1C-44 Gmail capabilities expose the accepted durable runtime", () => {
  for (const id of ["gmail_new_email", "gmail_new_email_matching_search", "gmail_send_email", "gmail_reply_to_email"] as const) {
    assert.equal(CAPABILITY_REGISTRY[id].maturity, "AVAILABLE");
    assert.equal(CAPABILITY_REGISTRY[id].onboarding.available, true);
    assert.equal(CAPABILITY_REGISTRY[id].availableInTest, true);
    assert.equal(CAPABILITY_REGISTRY[id].availableInProduction, true);
    assert.equal(assessCapability(id, "production").available, true);
  }
});

test("6B.1C-45 invalid pagination metadata and out-of-order provider history fail closed", async () => {
  await assert.rejects(() => readBoundedGmailHistory({
    processedHistoryId: "1",
    targetHistoryId: "10",
    fetchPage: async () => ({ history: [{ id: "2" }], nextPageToken: "" }),
  }));
  await assert.rejects(() => readBoundedGmailHistory({
    processedHistoryId: "1",
    targetHistoryId: "10",
    fetchPage: async () => ({ history: [{ id: "3" }, { id: "2" }] }),
  }));
});

test("6B.1C-46 account mismatch cannot kick unrelated provider work", async () => {
  const { route } = await sources();
  assert.match(route, /if \(queued\.connectionCount > 0\) \{[\s\S]*after\(async \(\) =>/);
});

test("6B.1C-47 connector maintenance preserves refreshable Google OAuth connections", async () => {
  const { migration } = await sources();
  const maintenance = migration.slice(migration.indexOf("create or replace function public.run_connector_maintenance"));
  assert.match(maintenance, /update public\.connector_connections connection/);
  assert.match(maintenance, /connection\.provider_family = 'google'/);
  assert.match(maintenance, /connection\.connector_id = 'google'/);
  assert.match(maintenance, /credential\.credential_key = 'refresh_token'/);
  assert.match(maintenance, /credential\.credential_type = 'oauth_refresh_token'/);
  assert.match(maintenance, /credential\.algorithm = 'aes-256-gcm'/);
  assert.match(maintenance, /credential\.encryption_version = 1/);
});
