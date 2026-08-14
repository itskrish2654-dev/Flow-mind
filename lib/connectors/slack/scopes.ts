export const SLACK_SCOPES = {
  channelsRead: "channels:read",
  channelsHistory: "channels:history",
  chatWrite: "chat:write",
} as const;

export const SLACK_SCOPE_INVENTORY = [
  { operation: "new_channel_message", scope: SLACK_SCOPES.channelsRead, why: "List accessible public channels and retain the selected channel ID." },
  { operation: "new_channel_message", scope: SLACK_SCOPES.channelsHistory, why: "Receive messages from public channels where the CrazyLoops app is a member." },
  { operation: "send_channel_message / reply_in_thread", scope: SLACK_SCOPES.channelsRead, why: "List and validate the selected public channel." },
  { operation: "send_channel_message / reply_in_thread", scope: SLACK_SCOPES.chatWrite, why: "Post an acknowledged message or reply through the selected Slack installation." },
] as const;

export function slackScopesForOperation(operationKey?: string | null) {
  if (operationKey === "new_channel_message") return [SLACK_SCOPES.channelsRead, SLACK_SCOPES.channelsHistory];
  if (operationKey === "send_channel_message" || operationKey === "reply_in_thread") return [SLACK_SCOPES.channelsRead, SLACK_SCOPES.chatWrite];
  return [SLACK_SCOPES.channelsRead];
}
