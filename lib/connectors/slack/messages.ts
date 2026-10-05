import type { ConnectorActionHandler } from "@/lib/connectors/types";
import { slackApiErrorResult, slackApiFetch } from "@/lib/connectors/slack/api";
import { parseSlackPostAcknowledgement } from "@/lib/connectors/slack/acknowledgement";
import { SLACK_SCOPES } from "@/lib/connectors/slack/scopes";
import { captureOperationalEvent } from "@/lib/observability";
import { ConnectorError, ambiguousAcknowledgement } from "@/lib/connectors/errors";

const CHANNEL_ID = /^[A-Z][A-Z0-9]{7,20}$/;
const MESSAGE_TS = /^\d{10,20}\.\d{1,10}$/;

function textValue(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("Slack message text is required.");
  if (text.length > 40_000) throw new Error("Slack message text must be 40,000 characters or fewer.");
  return text;
}

async function postSlackMessage(input: Record<string, unknown>, context: Parameters<ConnectorActionHandler>[1], thread: boolean) {
  try {
    if (!context.connectionId) throw new Error("Choose a Slack workspace before sending a message.");
    const channel = String(input.channel ?? "").trim();
    if (!CHANNEL_ID.test(channel)) throw new Error("Choose a valid Slack channel.");
    const threadTs = String(input.threadTs ?? "").trim();
    if (thread && !MESSAGE_TS.test(threadTs)) throw new Error("A valid Slack thread reference is required.");
    const body = await slackApiFetch({
      userId: context.userId,
      connectionId: context.connectionId,
      requiredScopes: [SLACK_SCOPES.chatWrite],
      method: "chat.postMessage",
      write: true,
      body: { channel, text: textValue(input.text), unfurl_links: false, unfurl_media: false, ...(thread ? { thread_ts: threadTs } : {}) },
    });
    const acknowledgement = parseSlackPostAcknowledgement(body, channel, thread ? threadTs : undefined);
    if (!acknowledgement) throw new ConnectorError(ambiguousAcknowledgement("Slack did not acknowledge the requested destination and thread; delivery may have happened."));
    await captureOperationalEvent({ level: "info", event: "slack_action_success", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "succeeded", metadata: { operation: thread ? "reply_in_thread" : "send_channel_message" } });
    return { status: "succeeded" as const, acknowledged: true, externallyDelivered: true,
      providerReferenceId: `${acknowledgement.channelId}:${acknowledgement.messageTs}`,
      output: { messageId: acknowledgement.messageTs, channelId: acknowledgement.channelId, ...(thread ? { threadTs: acknowledgement.threadTs } : {}) },
      metadata: { operation: thread ? "reply_in_thread" : "send_channel_message" } };
  } catch (error) {
    await captureOperationalEvent({ level: "warn", event: "slack_action_failure", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "failed", errorCategory: "provider" });
    return slackApiErrorResult(error);
  }
}

export const slackSendChannelMessage: ConnectorActionHandler = (input, context) => postSlackMessage(input, context, false);
export const slackReplyInThread: ConnectorActionHandler = (input, context) => postSlackMessage(input, context, true);

export async function verifySlackThread(input: { userId: string; workspaceId: string; connectionId: string; channelId: string; threadTs: string }) {
  if (!CHANNEL_ID.test(input.channelId) || !MESSAGE_TS.test(input.threadTs)) return false;
  const query = new URLSearchParams({ channel: input.channelId, ts: input.threadTs, limit: "1" });
  const result = await slackApiFetch({
    userId: input.userId, workspaceId: input.workspaceId, connectionId: input.connectionId,
    requiredScopes: [SLACK_SCOPES.channelsHistory], method: "conversations.replies", query,
  });
  const parent = Array.isArray(result.messages) ? result.messages[0] : null;
  return !!parent && typeof parent === "object" && "ts" in parent && parent.ts === input.threadTs;
}

export async function listSlackChannels(input: { userId: string; workspaceId?: string; connectionId: string }) {
  const channels: Array<{ id: string; name: string; isMember: boolean }> = [];
  let cursor = "";
  do {
    const query = new URLSearchParams({ types: "public_channel", exclude_archived: "true", limit: "200", ...(cursor ? { cursor } : {}) });
    const result = await slackApiFetch({ userId: input.userId, workspaceId: input.workspaceId, connectionId: input.connectionId, requiredScopes: [SLACK_SCOPES.channelsRead], method: "conversations.list", query });
    const items = Array.isArray(result.channels) ? result.channels : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const channel = item as { id?: unknown; name?: unknown; is_member?: unknown };
      if (typeof channel.id === "string" && typeof channel.name === "string") channels.push({ id: channel.id, name: channel.name, isMember: channel.is_member === true });
    }
    cursor = typeof result.response_metadata === "object" && result.response_metadata && "next_cursor" in result.response_metadata ? String((result.response_metadata as { next_cursor?: unknown }).next_cursor ?? "") : "";
  } while (cursor && channels.length < 1_000);
  return channels;
}
