const UINT64_MAX = BigInt("18446744073709551615");

export const GMAIL_PUSH_LIMITS = {
  envelopeBytes: 64 * 1024,
  encodedDataBytes: 12 * 1024,
  decodedDataBytes: 8 * 1024,
  historyIdDigits: 20,
  historyPages: 5,
  historyRecords: 500,
  uniqueMessageIds: 100,
  messageFetches: 100,
  executionFanout: 200,
  searchQueries: 20,
  searchPagesPerQuery: 2,
  searchResultsPerQuery: 200,
} as const;

const PUBSUB_RESOURCE = /^projects\/[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\/subscriptions\/[A-Za-z0-9][A-Za-z0-9._~+%-]{0,254}$/;
const PUBSUB_MESSAGE_ID = /^\d{1,30}$/;
const GMAIL_MESSAGE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export class GmailPushValidationError extends Error {
  constructor(public readonly code: string) {
    super("Google notification is permanently invalid.");
    this.name = "GmailPushValidationError";
  }
}

export class GmailHistoryResyncRequiredError extends Error {
  constructor() {
    super("Gmail history must be resynchronized.");
    this.name = "GmailHistoryResyncRequiredError";
  }
}

export function normalizeHistoryId(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || value.length > GMAIL_PUSH_LIMITS.historyIdDigits) {
    throw new GmailPushValidationError("GMAIL_HISTORY_ID_INVALID");
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new GmailPushValidationError("GMAIL_HISTORY_ID_INVALID");
  }
  if (parsed > UINT64_MAX) throw new GmailPushValidationError("GMAIL_HISTORY_ID_INVALID");
  return parsed.toString();
}

export function compareHistoryIds(left: string, right: string): -1 | 0 | 1 {
  const a = normalizeHistoryId(left);
  const b = normalizeHistoryId(right);
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function decodeBase64Url(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > GMAIL_PUSH_LIMITS.encodedDataBytes ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(value) ||
    value.length % 4 === 1
  ) {
    throw new GmailPushValidationError("GMAIL_PUSH_DATA_INVALID");
  }
  const unpadded = value.replace(/=+$/, "");
  const decoded = Buffer.from(unpadded, "base64url");
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > GMAIL_PUSH_LIMITS.decodedDataBytes ||
    decoded.toString("base64url") !== unpadded
  ) {
    throw new GmailPushValidationError("GMAIL_PUSH_DATA_INVALID");
  }
  return decoded;
}

export type GmailPushNotification = {
  pubsubMessageId: string;
  pubsubSubscription: string;
  publishTime: string | null;
  emailAddress: string;
  historyId: string;
};

export function parseGmailPushPayload(payload: unknown): GmailPushNotification {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new GmailPushValidationError("GMAIL_PUSH_ENVELOPE_INVALID");
  }
  const envelope = payload as {
    message?: { messageId?: unknown; publishTime?: unknown; data?: unknown };
    subscription?: unknown;
  };
  if (!envelope.message || typeof envelope.message !== "object" || Array.isArray(envelope.message)) {
    throw new GmailPushValidationError("GMAIL_PUSH_MESSAGE_INVALID");
  }
  if (typeof envelope.message.messageId !== "string" || !PUBSUB_MESSAGE_ID.test(envelope.message.messageId)) {
    throw new GmailPushValidationError("GMAIL_PUSH_MESSAGE_ID_INVALID");
  }
  if (typeof envelope.subscription !== "string" || !PUBSUB_RESOURCE.test(envelope.subscription)) {
    throw new GmailPushValidationError("GMAIL_PUSH_SUBSCRIPTION_INVALID");
  }
  let publishTime: string | null = null;
  if (envelope.message.publishTime !== undefined) {
    if (
      typeof envelope.message.publishTime !== "string" ||
      envelope.message.publishTime.length > 64 ||
      !Number.isFinite(Date.parse(envelope.message.publishTime))
    ) {
      throw new GmailPushValidationError("GMAIL_PUSH_PUBLISH_TIME_INVALID");
    }
    publishTime = new Date(envelope.message.publishTime).toISOString();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(decodeBase64Url(envelope.message.data)).toString("utf8"));
  } catch (error) {
    if (error instanceof GmailPushValidationError) throw error;
    throw new GmailPushValidationError("GMAIL_PUSH_DATA_JSON_INVALID");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new GmailPushValidationError("GMAIL_NOTIFICATION_INVALID");
  }
  const notification = decoded as { emailAddress?: unknown; historyId?: unknown };
  if (
    typeof notification.emailAddress !== "string" ||
    notification.emailAddress.length > 320 ||
    !EMAIL.test(notification.emailAddress)
  ) {
    throw new GmailPushValidationError("GMAIL_EMAIL_INVALID");
  }
  return {
    pubsubMessageId: envelope.message.messageId,
    pubsubSubscription: envelope.subscription,
    publishTime,
    emailAddress: notification.emailAddress.toLowerCase(),
    historyId: normalizeHistoryId(notification.historyId),
  };
}

export type GmailHistoryRecord = {
  id?: unknown;
  messagesAdded?: Array<{ message?: { id?: unknown } }>;
};

export type GmailHistoryPage = {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
};

export type BoundedGmailHistory = {
  entries: Array<{ historyId: string; messageId: string }>;
  completedThrough: string;
  targetCompleted: boolean;
  pagesRead: number;
  recordsRead: number;
};

export async function readBoundedGmailHistory(input: {
  processedHistoryId: string;
  targetHistoryId: string;
  maxUniqueMessageIds?: number;
  fetchPage: (pageToken?: string) => Promise<GmailHistoryPage>;
}): Promise<BoundedGmailHistory> {
  const processed = normalizeHistoryId(input.processedHistoryId);
  const target = normalizeHistoryId(input.targetHistoryId);
  if (compareHistoryIds(target, processed) < 0) {
    throw new GmailPushValidationError("GMAIL_HISTORY_RANGE_INVALID");
  }
  const uniqueLimit = Math.max(1, Math.min(input.maxUniqueMessageIds ?? GMAIL_PUSH_LIMITS.uniqueMessageIds, GMAIL_PUSH_LIMITS.uniqueMessageIds));
  const entries: Array<{ historyId: string; messageId: string }> = [];
  const unique = new Set<string>();
  let pageToken: string | undefined;
  let pagesRead = 0;
  let recordsRead = 0;
  let completedThrough = processed;
  let lastSeenHistoryId = processed;

  while (pagesRead < GMAIL_PUSH_LIMITS.historyPages) {
    const page = await input.fetchPage(pageToken);
    pagesRead += 1;
    const records = page.history ?? [];
    if (!Array.isArray(records)) throw new Error("Gmail returned invalid history data.");

    for (const record of records) {
      const recordId = normalizeHistoryId(record.id);
      if (compareHistoryIds(recordId, lastSeenHistoryId) < 0) {
        throw new Error("Gmail returned history records out of order.");
      }
      lastSeenHistoryId = recordId;
      if (compareHistoryIds(recordId, processed) <= 0) continue;
      if (compareHistoryIds(recordId, target) > 0) {
        return { entries, completedThrough: target, targetCompleted: true, pagesRead, recordsRead };
      }
      if (recordsRead >= GMAIL_PUSH_LIMITS.historyRecords) {
        return { entries, completedThrough, targetCompleted: false, pagesRead, recordsRead };
      }
      const recordIds = new Set<string>();
      for (const added of record.messagesAdded ?? []) {
        const messageId = added?.message?.id;
        if (typeof messageId !== "string" || !GMAIL_MESSAGE_ID.test(messageId)) {
          throw new Error("Gmail returned an invalid message identifier.");
        }
        recordIds.add(messageId);
      }
      const additions = [...recordIds].filter((messageId) => !unique.has(messageId));
      if (unique.size + additions.length > uniqueLimit) {
        return { entries, completedThrough, targetCompleted: false, pagesRead, recordsRead };
      }
      for (const messageId of additions) {
        unique.add(messageId);
        entries.push({ historyId: recordId, messageId });
      }
      recordsRead += 1;
      completedThrough = recordId;
      if (compareHistoryIds(recordId, target) === 0) {
        return { entries, completedThrough: target, targetCompleted: true, pagesRead, recordsRead };
      }
    }

    if (
      page.nextPageToken !== undefined &&
      (typeof page.nextPageToken !== "string" || page.nextPageToken.length === 0 || page.nextPageToken.length > 2048)
    ) {
      throw new Error("Gmail returned an invalid history page token.");
    }
    pageToken = page.nextPageToken;
    if (!pageToken) {
      return { entries, completedThrough: target, targetCompleted: true, pagesRead, recordsRead };
    }
  }

  return { entries, completedThrough, targetCompleted: false, pagesRead, recordsRead };
}

export function maxHistoryId(values: string[]): string {
  if (values.length === 0) throw new GmailPushValidationError("GMAIL_HISTORY_ID_INVALID");
  return values.map(normalizeHistoryId).reduce((current, value) => compareHistoryIds(value, current) > 0 ? value : current);
}
