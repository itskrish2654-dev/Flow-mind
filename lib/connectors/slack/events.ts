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
  event?: { type?: string; subtype?: string; channel?: string; user?: string; bot_id?: string; app_id?: string; text?: string; ts?: string; thread_ts?: string };
};

export function normalizeSlackMessage(payload: SlackEventEnvelope) {
  const event = payload.event;
  if (payload.type !== "event_callback" || event?.type !== "message" || event.subtype || event.bot_id || event.app_id || !payload.event_id || !payload.team_id || !event.channel || !event.ts) return null;
  return {
    eventId: payload.event_id,
    teamId: payload.team_id,
    channelId: event.channel,
    userId: event.user ?? "",
    text: String(event.text ?? "").slice(0, 40_000),
    threadTs: event.thread_ts ?? "",
    messageTs: event.ts,
    createdAt: payload.event_time ? new Date(payload.event_time * 1_000).toISOString() : new Date(Number(event.ts.split(".")[0]) * 1_000).toISOString(),
  };
}
