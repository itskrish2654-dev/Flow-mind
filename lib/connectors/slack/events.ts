import { createHmac, timingSafeEqual } from "node:crypto";

const FIVE_MINUTES_SECONDS = 5 * 60;

export function verifySlackRequest(request: Request, rawBody: Uint8Array, nowSeconds = Math.floor(Date.now() / 1_000)) {
  const secret = process.env.FLOWMIND_CONNECTOR_SLACK_SIGNING_SECRET;
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";
  if (!secret || !/^\d+$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > FIVE_MINUTES_SECONDS || !/^v0=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(rawBody).digest("hex")}`;
  const left = Buffer.from(signature); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type SlackEventEnvelope = {
  type?: string;
  challenge?: string;
  event_id?: string;
  team_id?: string;
  event_time?: number;
  event?: { type?: string; subtype?: string; channel_type?: string; channel?: string; user?: string; bot_id?: string; app_id?: string; text?: string; ts?: string; thread_ts?: string };
};

export function getSlackUrlVerificationChallenge(payload: SlackEventEnvelope) {
  if (payload.type !== "url_verification" || typeof payload.challenge !== "string") return null;
  return payload.challenge.length > 0 && payload.challenge.length <= 512 ? payload.challenge : null;
}

export function normalizeSlackMessage(payload: SlackEventEnvelope) {
  const event = payload.event;
  const eventId = payload.event_id;
  const teamId = payload.team_id;
  const channelId = event?.channel;
  const userId = event?.user;
  const messageTs = event?.ts;
  if (payload.type !== "event_callback" || event?.type !== "message" || event.subtype || event.bot_id || event.app_id
    || (event.channel_type && event.channel_type !== "channel")
    || !eventId || !/^[A-Za-z0-9_-]{1,200}$/.test(eventId)
    || !teamId || !/^T[A-Z0-9]{7,20}$/.test(teamId)
    || !channelId || !/^C[A-Z0-9]{7,20}$/.test(channelId)
    || !userId || !/^[UW][A-Z0-9]{7,20}$/.test(userId)
    || !messageTs || !/^\d{10,20}\.\d{1,10}$/.test(messageTs)
    || (event.thread_ts && !/^\d{10,20}\.\d{1,10}$/.test(event.thread_ts))
    || typeof event.text !== "string" || !event.text.trim()) return null;
  const eventTime = payload.event_time && Number.isSafeInteger(payload.event_time)
    ? payload.event_time : Number(messageTs.split(".")[0]);
  if (!Number.isSafeInteger(eventTime) || eventTime < 1_000_000_000 || eventTime > 9_999_999_999) return null;
  return {
    eventId,
    teamId,
    channelId,
    userId,
    text: event.text.trim().slice(0, 4_000),
    threadTs: event.thread_ts ?? "",
    messageTs,
    createdAt: new Date(eventTime * 1_000).toISOString(),
  };
}
