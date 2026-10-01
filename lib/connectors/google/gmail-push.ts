import { OAuth2Client } from "google-auth-library";

import { ConnectorError } from "@/lib/connectors/errors";
import { googleApiFetch } from "@/lib/connectors/google/api";
import {
  GMAIL_PUSH_LIMITS,
  GmailHistoryResyncRequiredError,
  compareHistoryIds,
  normalizeHistoryId,
  parseGmailPushPayload,
  readBoundedGmailHistory,
  type GmailHistoryPage,
} from "@/lib/connectors/google/gmail-ingestion-core";
import { normalizeGmailMessage } from "@/lib/connectors/google/gmail-message";
import { readBoundedGmailMessagePayload } from "@/lib/connectors/google/gmail-read-core";
import { createGmailWorkItem } from "@/lib/connectors/google/gmail-work-items";
import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";
import { captureOperationalEvent } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

const auth = new OAuth2Client();
// This exceeds both serverless route budgets while remaining bounded in SQL,
// so a timed-out worker is reclaimed without overlapping a still-live worker.
const GMAIL_INGESTION_LEASE_SECONDS = 120;
const MAX_ACTIVE_SUBSCRIPTIONS_PER_CONNECTION = 100;

type GmailIngestionClaim = {
  connection_id: string;
  user_id: string;
  processed_history_id: string;
  observed_history_id: string;
  lease_token: string;
};

type GmailSubscription = {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  operation_key: string;
  cursor_value: string | null;
  safe_metadata: Json;
};

export async function verifyGooglePubSubRequest(request: Request) {
  const audience = process.env.GOOGLE_PUBSUB_AUDIENCE;
  const serviceAccount = process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT;
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!audience || !serviceAccount || !bearer) return false;
  try {
    const ticket = await auth.verifyIdToken({ idToken: bearer, audience });
    const payload = ticket.getPayload();
    const audienceMatches = payload?.aud === audience || (Array.isArray(payload?.aud) && payload.aud.includes(audience));
    return Boolean(
      audienceMatches &&
      payload?.email_verified === true &&
      payload.email === serviceAccount &&
      typeof payload.sub === "string" &&
      payload.sub.length > 0 &&
      typeof payload.exp === "number" &&
      payload.exp * 1000 > Date.now() &&
      ["accounts.google.com", "https://accounts.google.com"].includes(payload.iss ?? ""),
    );
  } catch {
    return false;
  }
}

export { parseGmailPushPayload } from "@/lib/connectors/google/gmail-ingestion-core";

export async function queueGmailPushNotification(payload: unknown) {
  const notification = parseGmailPushPayload(payload);
  const { data, error } = await createAdminClient().rpc("enqueue_gmail_push_notification", {
    p_email_address: notification.emailAddress,
    p_history_id: notification.historyId,
    p_pubsub_subscription: notification.pubsubSubscription,
    p_pubsub_message_id: notification.pubsubMessageId,
    p_publish_time: notification.publishTime,
  });
  if (error) throw new Error("Google notification could not be durably queued.");
  const rows = data ?? [];
  return {
    connectionCount: rows.length,
    insertedCount: rows.filter((row) => row.inserted).length,
    duplicate: rows.length > 0 && rows.every((row) => !row.inserted),
  };
}

export async function activateGmailWatch(input: {
  userId: string;
  connectionId: string;
  persistActiveSubscriptions?: boolean;
}) {
  const topicName = process.env.GOOGLE_GMAIL_PUBSUB_TOPIC;
  if (!topicName?.startsWith("projects/")) throw new Error("Google Gmail Pub/Sub topic is not configured.");
  const response = await googleApiFetch({
    userId: input.userId,
    connectionId: input.connectionId,
    requiredScopes: [GOOGLE_SCOPES.gmailReadonly],
    url: "https://gmail.googleapis.com/gmail/v1/users/me/watch",
    method: "POST",
    body: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "include" },
  });
  const watch = await response.json() as { historyId?: string; expiration?: string };
  const historyId = normalizeWatchHistoryId(watch.historyId);
  if (!watch.expiration) throw new Error("Gmail did not acknowledge the mailbox watch.");
  const expiresAt = new Date(Number(watch.expiration));
  if (!Number.isFinite(expiresAt.getTime())) throw new Error("Gmail returned an invalid watch expiration.");
  const renewAfter = new Date(expiresAt.getTime() - 24 * 60 * 60_000).toISOString();
  if (input.persistActiveSubscriptions !== false) {
    // Renewal must never replace the successfully processed cursor. Initial
    // publication stores the watch baseline from the returned value below.
    const { error } = await createAdminClient()
      .from("connector_subscriptions")
      .update({
        provider_subscription_id: input.connectionId,
        expires_at: expiresAt.toISOString(),
        renew_after: renewAfter,
        last_error_category: null,
        status: "active",
        updated_at: new Date().toISOString(),
      })
      .eq("connection_id", input.connectionId)
      .eq("user_id", input.userId)
      .eq("connector_id", "google_gmail")
      .eq("status", "active");
    if (error) throw new Error("Gmail watch state could not be stored.");
  }
  await captureOperationalEvent({ level: "info", event: "gmail_watch_created", userId: input.userId, status: "active" });
  return { historyId, expiresAt: expiresAt.toISOString(), renewAfter };
}

/** Establishes a durable mailbox cursor for Work OS intake without inventing a workflow subscription. */
export async function initializeGmailWorkIntake(input: { userId: string; connectionId: string }) {
  const admin = createAdminClient();
  const { data: connection, error: connectionError } = await admin.from("connector_connections")
    .select("id,workspace_id,granted_scopes").eq("id", input.connectionId).eq("user_id", input.userId)
    .eq("provider_family", "google").eq("status", "connected").maybeSingle();
  if (connectionError || !connection || !connection.granted_scopes.includes(GOOGLE_SCOPES.gmailReadonly)) {
    throw new Error("Gmail intake requires an owned, readable Google connection.");
  }
  const { data: member, error: memberError } = await admin.from("workspace_memberships")
    .select("user_id").eq("workspace_id", connection.workspace_id).eq("user_id", input.userId).maybeSingle();
  if (memberError || !member) throw new Error("Gmail intake requires current workspace membership.");
  const { data: existing, error: existingError } = await admin.from("gmail_ingestion_states")
    .select("connection_id").eq("connection_id", input.connectionId).eq("user_id", input.userId).maybeSingle();
  if (existingError) throw new Error("Gmail intake state could not be checked.");
  if (existing) {
    await admin.from("connector_connections")
      .update({ last_error_category: null, updated_at: new Date().toISOString() })
      .eq("id", input.connectionId).eq("user_id", input.userId).eq("last_error_category", "gmail_intake_setup");
    return { configured: true as const, existing: true as const };
  }

  let historyId: string;
  if (process.env.GOOGLE_GMAIL_PUBSUB_TOPIC) {
    historyId = (await activateGmailWatch({ ...input, persistActiveSubscriptions: false })).historyId;
  } else {
    const profile = await googleApiFetch({
      userId: input.userId, connectionId: input.connectionId,
      requiredScopes: [GOOGLE_SCOPES.gmailReadonly],
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    });
    const data = await profile.json() as { historyId?: string };
    historyId = normalizeWatchHistoryId(data.historyId);
  }
  const { error } = await admin.from("gmail_ingestion_states").insert({
    connection_id: input.connectionId,
    user_id: input.userId,
    processed_history_id: historyId,
    observed_history_id: historyId,
    status: "idle",
    next_attempt_at: new Date().toISOString(),
    lease_token: null,
    lease_until: null,
    attempt_count: 0,
    last_error_category: null,
    updated_at: new Date().toISOString(),
  });
  if (error && error.code !== "23505") throw new Error("Gmail Work OS cursor could not be stored.");
  await admin.from("connector_connections")
    .update({ last_error_category: null, updated_at: new Date().toISOString() })
    .eq("id", input.connectionId).eq("user_id", input.userId).eq("last_error_category", "gmail_intake_setup");
  return { configured: true as const, existing: error?.code === "23505" };
}

/** Observe a durable history high-watermark; the separate ingestion claim does all message work. */
export async function pollGmailWorkIntake(limit = 3) {
  const admin = createAdminClient();
  let claimed = 0;
  let succeeded = 0;
  let failed = 0;
  for (let index = 0; index < Math.max(1, Math.min(limit, 5)); index += 1) {
    const { data, error } = await admin.rpc("claim_gmail_work_poll", { p_lease_seconds: 90 });
    if (error) throw new Error("Gmail work poll could not be claimed.");
    const claim = data?.[0];
    if (!claim) break;
    claimed += 1;
    try {
      const response = await googleApiFetch({
        userId: claim.user_id, connectionId: claim.connection_id,
        requiredScopes: [GOOGLE_SCOPES.gmailReadonly],
        url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      });
      const profile = await response.json() as { historyId?: string };
      const historyId = normalizeWatchHistoryId(profile.historyId);
      const completion = await admin.rpc("complete_gmail_work_poll", {
        p_connection_id: claim.connection_id, p_user_id: claim.user_id,
        p_lease_token: claim.lease_token, p_history_id: historyId,
      });
      if (completion.error || completion.data !== true) throw new Error("Gmail work poll could not be committed.");
      succeeded += 1;
    } catch (caught) {
      failed += 1;
      const category = caught instanceof ConnectorError
        && ["authentication", "authorization"].includes(caught.details.category)
        ? caught.details.category : "transient";
      await admin.rpc("defer_gmail_work_poll", {
        p_connection_id: claim.connection_id, p_user_id: claim.user_id,
        p_lease_token: claim.lease_token, p_error_category: category,
      });
      await captureOperationalEvent({ level: "warn", event: "gmail_work_poll_failed",
        userId: claim.user_id, status: "failed", errorCategory: category });
    }
  }
  return { claimed, succeeded, failed };
}

/** Safely adds a cursor for pre-existing Gmail connections, without resetting a live cursor. */
export async function initializeExistingGmailWorkIntake(limit = 2) {
  const { data, error } = await createAdminClient().rpc("list_uninitialized_gmail_work_connections", {
    p_limit: Math.max(1, Math.min(limit, 5)),
  });
  if (error) throw new Error("Gmail connections awaiting intake could not be listed.");
  let initialized = 0;
  let failed = 0;
  for (const connection of data ?? []) {
    try {
      await initializeGmailWorkIntake({ userId: connection.user_id, connectionId: connection.connection_id });
      initialized += 1;
    } catch {
      failed += 1;
      await createAdminClient().from("connector_connections")
        .update({ last_error_category: "gmail_intake_setup", updated_at: new Date().toISOString() })
        .eq("id", connection.connection_id).eq("user_id", connection.user_id);
      await captureOperationalEvent({ level: "warn", event: "gmail_intake_initialization_failed",
        userId: connection.user_id, status: "failed", errorCategory: "provider_unavailable" });
    }
  }
  return { inspected: data?.length ?? 0, initialized, failed };
}

function normalizeWatchHistoryId(value: unknown) {
  try {
    return normalizeHistoryId(value);
  } catch {
    throw new Error("Gmail did not acknowledge the mailbox watch.");
  }
}

export async function stopGmailWatch(input: { userId: string; connectionId: string }) {
  try {
    await googleApiFetch({
      userId: input.userId,
      connectionId: input.connectionId,
      requiredScopes: [GOOGLE_SCOPES.gmailReadonly],
      url: "https://gmail.googleapis.com/gmail/v1/users/me/stop",
      method: "POST",
      body: {},
    });
  } catch {
    // Local revocation still proceeds; a Gmail watch naturally expires within seven days.
  }
}

export async function renewDueGmailWatches() {
  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { data, error } = await admin
    .from("connector_subscriptions")
    .select("user_id,connection_id")
    .eq("connector_id", "google_gmail")
    .eq("status", "active")
    .not("connection_id", "is", null)
    .lte("renew_after", now)
    .limit(100);
  if (error) throw new Error("Gmail watches due for renewal could not be loaded.");
  const unique = Array.from(new Map((data ?? []).map((item) => [`${item.user_id}:${item.connection_id}`, item])).values());
  let renewed = 0;
  let failed = 0;
  for (const item of unique) {
    if (!item.connection_id) continue;
    try {
      await activateGmailWatch({ userId: item.user_id, connectionId: item.connection_id });
      renewed += 1;
      await captureOperationalEvent({ level: "info", event: "gmail_watch_renewed", userId: item.user_id, status: "active" });
    } catch (error) {
      failed += 1;
      const reconnectRequired = error instanceof Error && /reconnect|permission|authentication/i.test(error.message);
      await admin
        .from("connector_subscriptions")
        .update({
          ...(reconnectRequired ? { status: "error" as const } : {}),
          last_error_category: reconnectRequired ? "authentication" : "provider_unavailable",
          updated_at: now,
        })
        .eq("connection_id", item.connection_id)
        .eq("user_id", item.user_id)
        .eq("connector_id", "google_gmail");
    }
  }
  return { inspected: unique.length, renewed, failed };
}

async function fetchHistoryPage(claim: GmailIngestionClaim, pageToken?: string): Promise<GmailHistoryPage> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
  url.searchParams.set("startHistoryId", claim.processed_history_id);
  url.searchParams.set("historyTypes", "messageAdded");
  url.searchParams.set("maxResults", "100");
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  const response = await googleApiFetch({
    userId: claim.user_id,
    connectionId: claim.connection_id,
    requiredScopes: [GOOGLE_SCOPES.gmailReadonly],
    url: url.toString(),
    allowNotFoundResponse: true,
  });
  if (response.status === 404) throw new GmailHistoryResyncRequiredError();
  return response.json() as Promise<GmailHistoryPage>;
}

async function searchMatches(claim: GmailIngestionClaim, search: string) {
  const matches = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < GMAIL_PUSH_LIMITS.searchPagesPerQuery; page += 1) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("q", search);
    url.searchParams.set("maxResults", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await googleApiFetch({
      userId: claim.user_id,
      connectionId: claim.connection_id,
      requiredScopes: [GOOGLE_SCOPES.gmailReadonly],
      url: url.toString(),
    });
    const data = await response.json() as { messages?: Array<{ id?: string }>; nextPageToken?: string };
    for (const message of data.messages ?? []) {
      if (typeof message.id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(message.id)) matches.add(message.id);
      if (matches.size >= GMAIL_PUSH_LIMITS.searchResultsPerQuery) return matches;
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return matches;
}

function metadataObject(value: Json): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Json | undefined>
    : {};
}

async function loadSubscriptions(claim: GmailIngestionClaim): Promise<GmailSubscription[]> {
  const { data, error } = await createAdminClient()
    .from("connector_subscriptions")
    .select("id,workflow_id,workflow_version_id,operation_key,cursor_value,safe_metadata")
    .eq("connection_id", claim.connection_id)
    .eq("user_id", claim.user_id)
    .eq("connector_id", "google_gmail")
    .eq("status", "active")
    .limit(MAX_ACTIVE_SUBSCRIPTIONS_PER_CONNECTION + 1);
  if (error) throw new Error("Gmail subscriptions could not be loaded.");
  if ((data?.length ?? 0) > MAX_ACTIVE_SUBSCRIPTIONS_PER_CONNECTION) {
    throw new Error("Gmail subscription processing limit was exceeded.");
  }
  return data ?? [];
}

async function deferClaim(claim: GmailIngestionClaim, category: "transient" | "authentication" | "resync_required") {
  await createAdminClient().rpc("defer_gmail_ingestion", {
    p_connection_id: claim.connection_id,
    p_user_id: claim.user_id,
    p_lease_token: claim.lease_token,
    p_error_category: category,
  });
}

function failureCategory(error: unknown): "transient" | "authentication" | "resync_required" {
  if (error instanceof GmailHistoryResyncRequiredError) return "resync_required";
  if (error instanceof ConnectorError && ["authentication", "authorization"].includes(error.details.category)) return "authentication";
  return "transient";
}

async function processClaim(claim: GmailIngestionClaim, maxMessages: number) {
  const admin = createAdminClient();
  try {
    const subscriptions = await loadSubscriptions(claim);
    const { data: owner, error: ownerError } = await admin.from("connector_connections")
      .select("workspace_id,user_id,status,provider_family")
      .eq("id", claim.connection_id).eq("user_id", claim.user_id).maybeSingle();
    const { data: membership, error: membershipError } = owner
      ? await admin.from("workspace_memberships").select("user_id")
          .eq("workspace_id", owner.workspace_id).eq("user_id", claim.user_id).maybeSingle()
      : { data: null, error: null };
    if (ownerError || membershipError || !owner || !membership
      || owner.status !== "connected" || owner.provider_family !== "google") {
      throw new Error("Gmail Work OS ownership is no longer valid.");
    }
    const maxUniqueMessages = Math.max(
      1,
      Math.min(
        Math.min(GMAIL_PUSH_LIMITS.messageFetches, maxMessages),
        Math.floor(GMAIL_PUSH_LIMITS.executionFanout / Math.max(1, subscriptions.length)),
      ),
    );
    const history = await readBoundedGmailHistory({
      processedHistoryId: claim.processed_history_id,
      targetHistoryId: claim.observed_history_id,
      maxUniqueMessageIds: maxUniqueMessages,
      fetchPage: (pageToken) => fetchHistoryPage(claim, pageToken),
    });

    const searches = new Set(
      subscriptions.flatMap((subscription) => {
        if (subscription.operation_key !== "new_email_matching_search") return [];
        const search = metadataObject(subscription.safe_metadata).search;
        if (typeof search !== "string" || search.trim().length === 0 || search.length > 500) {
          throw new Error("Gmail search subscription setup is invalid.");
        }
        return [search];
      }),
    );
    if (searches.size > GMAIL_PUSH_LIMITS.searchQueries) throw new Error("Gmail search processing limit was exceeded.");
    const allowedBySearch = new Map<string, Set<string>>();
    for (const search of searches) allowedBySearch.set(search, await searchMatches(claim, search));

    const normalizedById = new Map<string, ReturnType<typeof normalizeGmailMessage>>();
    const messageIds = [...new Set(history.entries.map((entry) => entry.messageId))];
    for (let offset = 0; offset < messageIds.length; offset += 5) {
      const batch = await Promise.all(messageIds.slice(offset, offset + 5).map(async (messageId) => {
        const response = await googleApiFetch({
        userId: claim.user_id,
        connectionId: claim.connection_id,
        requiredScopes: [GOOGLE_SCOPES.gmailReadonly],
        url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
        });
        const message = await readBoundedGmailMessagePayload(response);
        return { messageId, normalized: normalizeGmailMessage(message) };
      }));
      for (const item of batch) normalizedById.set(item.messageId, item.normalized);
    }

    let fanout = 0;
    let workItemsCreated = 0;
    const seen = new Set<string>();
    for (const entry of history.entries) {
      const normalized = normalizedById.get(entry.messageId);
      if (!normalized || !normalized.message.labels.includes("INBOX")) continue;
      const workItem = await createGmailWorkItem({
        userId: claim.user_id,
        workspaceId: owner.workspace_id,
        connectionId: claim.connection_id,
        message: normalized.message,
      });
      if (workItem.created) workItemsCreated += 1;
      for (const subscription of subscriptions) {
        if (!subscription.cursor_value || compareHistoryIds(entry.historyId, subscription.cursor_value) <= 0) continue;
        if (subscription.operation_key === "new_email_matching_search") {
          const search = metadataObject(subscription.safe_metadata).search;
          if (typeof search !== "string" || !allowedBySearch.get(search)?.has(entry.messageId)) continue;
        } else if (subscription.operation_key !== "new_email") {
          continue;
        }
        const eventIdentity = `${subscription.id}:${entry.messageId}`;
        if (seen.has(eventIdentity)) continue;
        seen.add(eventIdentity);
        fanout += 1;
        if (fanout > GMAIL_PUSH_LIMITS.executionFanout) throw new Error("Gmail execution fanout limit was exceeded.");
        const { error } = await admin.from("connector_event_receipts").insert({
          subscription_id: subscription.id,
          workflow_id: subscription.workflow_id,
          workflow_version_id: subscription.workflow_version_id,
          provider_event_key: `gmail:${entry.messageId}`,
          payload: normalized as Json,
          safe_metadata: {
            connectorId: "google_gmail",
            operationKey: subscription.operation_key,
            gmailMessageId: entry.messageId,
          },
        });
        if (error && error.code !== "23505") throw new Error("Gmail event receipt could not be stored.");
      }
    }

    const { data: completed, error: completionError } = await admin.rpc("complete_gmail_ingestion", {
      p_connection_id: claim.connection_id,
      p_user_id: claim.user_id,
      p_lease_token: claim.lease_token,
      p_expected_processed_history_id: claim.processed_history_id,
      p_completed_history_id: history.completedThrough,
    });
    if (completionError || completed !== true) throw new Error("Gmail ingestion cursor could not be committed.");
    await captureOperationalEvent({
      level: "info",
      event: "gmail_event_received",
      userId: claim.user_id,
      status: history.targetCompleted ? "accepted" : "pending",
      metadata: { receiptCount: fanout, workItemsCreated, pagesRead: history.pagesRead, recordsRead: history.recordsRead },
    });
    return { receiptCount: fanout, workItemsCreated, targetCompleted: history.targetCompleted };
  } catch (error) {
    const category = failureCategory(error);
    await deferClaim(claim, category);
    await captureOperationalEvent({
      level: "warn",
      event: "gmail_history_error",
      userId: claim.user_id,
      status: "failed",
      errorCategory: category,
    });
    return { receiptCount: 0, targetCompleted: false, errorCategory: category };
  }
}

export async function drainGmailIngestion(limit = 2, maxMessages: number = GMAIL_PUSH_LIMITS.messageFetches) {
  const boundedLimit = Math.max(1, Math.min(limit, 5));
  let claimed = 0;
  let failed = 0;
  let receipts = 0;
  for (let index = 0; index < boundedLimit; index += 1) {
    const { data, error } = await createAdminClient().rpc("claim_gmail_ingestion", {
      p_lease_seconds: GMAIL_INGESTION_LEASE_SECONDS,
    });
    if (error) throw new Error("Gmail ingestion work could not be claimed.");
    const claim = data?.[0] as GmailIngestionClaim | undefined;
    if (!claim) break;
    claimed += 1;
    const result = await processClaim(claim, Math.max(1, Math.min(maxMessages, GMAIL_PUSH_LIMITS.messageFetches)));
    receipts += result.receiptCount;
    if ("errorCategory" in result) failed += 1;
  }
  return { claimed, failed, receipts };
}
