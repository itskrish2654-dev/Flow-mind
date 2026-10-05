const CHANNEL_ID = /^C[A-Z0-9]{7,20}$/;
const MESSAGE_TS = /^\d{10,20}\.\d{1,10}$/;

/** A 2xx response alone is never proof of delivery to the approved channel. */
export function parseSlackPostAcknowledgement(body: Record<string, unknown>, expectedChannel: string, expectedThread?: string) {
  const ts = typeof body.ts === "string" ? body.ts : "";
  const channel = typeof body.channel === "string" ? body.channel : "";
  const returnedThread = typeof body.message === "object" && body.message && "thread_ts" in body.message
    ? String((body.message as { thread_ts?: unknown }).thread_ts ?? "") : "";
  if (body.ok !== true || !CHANNEL_ID.test(channel) || channel !== expectedChannel || !MESSAGE_TS.test(ts)
    || (expectedThread && returnedThread !== expectedThread)) return null;
  return { channelId: channel, messageTs: ts, ...(expectedThread ? { threadTs: returnedThread } : {}) };
}
