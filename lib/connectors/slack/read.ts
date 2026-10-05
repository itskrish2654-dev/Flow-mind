import "server-only";

import { listSlackChannels } from "@/lib/connectors/slack/messages";
import { SLACK_SCOPES } from "@/lib/connectors/slack/scopes";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

type SlackMessage = Database["public"]["Tables"]["slack_message_events"]["Row"];
type Availability = "ok" | "connection_required" | "reconnect_required" | "account_selection_required";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STOPWORDS = new Set(["what", "when", "where", "which", "about", "recently", "latest", "message", "messages", "slack", "channel", "channels", "team", "anyone", "someone", "say", "said", "did", "the", "for", "from", "with", "that", "this", "there", "reply", "replied", "update", "discussed", "discussion", "please", "show", "find", "search", "tell", "was", "were", "are", "has", "have", "our", "your"]);

function searchTerms(question: string): string[] {
  return [...new Set(question.toLowerCase().replace(/#[a-z0-9_-]+/g, " ")
    .match(/[a-z0-9]{3,}/g)?.filter((term) => !STOPWORDS.has(term)) ?? [])].slice(0, 4);
}

async function ownedConnections(userId: string, workspaceId: string) {
  const { data, error } = await createAdminClient().from("connector_connections")
    .select("id,status,external_account_label,granted_scopes")
    .eq("user_id", userId).eq("workspace_id", workspaceId)
    .eq("provider_family", "slack").eq("connector_id", "slack")
    .neq("status", "revoked").order("created_at", { ascending: false }).limit(6);
  if (error) throw new Error("Slack connection could not be checked.");
  return data ?? [];
}

/** Only owner-scoped, signed Events API records are Ask evidence; no history scrape. */
export async function readSlackForAsk(input: { userId: string; workspaceId: string; question: string }): Promise<{
  status: Availability; connectionId?: string; messages: SlackMessage[]; channelNames: Record<string, string>;
}> {
  const connections = await ownedConnections(input.userId, input.workspaceId);
  if (!connections.length) return { status: "connection_required", messages: [], channelNames: {} };
  const usable = connections.filter((row) => row.status === "connected"
    && row.granted_scopes.includes(SLACK_SCOPES.channelsHistory));
  if (!usable.length) return { status: "reconnect_required", messages: [], channelNames: {} };
  const selected = usable.length === 1 ? usable[0]
    : usable.find((row) => row.external_account_label
      && input.question.toLowerCase().includes(row.external_account_label.toLowerCase()));
  if (!selected) return { status: "account_selection_required", messages: [], channelNames: {} };

  const channelMention = input.question.match(/#([a-z0-9_-]{1,80})\b/i)?.[1]?.toLowerCase();
  let channelId: string | null = null;
  let channelNames: Record<string, string> = {};
  if (channelMention) {
    const channels = (await listSlackChannels({ userId: input.userId, workspaceId: input.workspaceId, connectionId: selected.id }))
      .filter((channel) => channel.isMember);
    channelNames = Object.fromEntries(channels.map((channel) => [channel.id, channel.name]));
    channelId = channels.find((channel) => channel.name.toLowerCase() === channelMention)?.id ?? null;
    if (!channelId) return { status: "ok", connectionId: selected.id, messages: [], channelNames };
  }

  let query = createAdminClient().from("slack_message_events").select("*")
    .eq("user_id", input.userId).eq("workspace_id", input.workspaceId)
    .eq("connection_id", selected.id).order("message_at", { ascending: false }).limit(200);
  if (channelId) query = query.eq("channel_id", channelId);
  const { data, error } = await query;
  if (error) throw new Error("Slack context is unavailable.");
  const terms = searchTerms(input.question);
  const messages = (data ?? []).filter((message) =>
    terms.length === 0 || terms.some((term) => message.message_text.toLowerCase().includes(term)),
  ).slice(0, 5);
  return { status: "ok", connectionId: selected.id, messages, channelNames };
}

export async function readSlackMessage(input: { userId: string; workspaceId: string; connectionId: string; eventId: string }): Promise<SlackMessage | null> {
  if (!UUID.test(input.connectionId) || !UUID.test(input.eventId)) return null;
  const connections = await ownedConnections(input.userId, input.workspaceId);
  if (!connections.some((row) => row.id === input.connectionId && row.status === "connected"
    && row.granted_scopes.includes(SLACK_SCOPES.channelsHistory))) return null;
  const { data, error } = await createAdminClient().from("slack_message_events").select("*")
    .eq("id", input.eventId).eq("connection_id", input.connectionId)
    .eq("user_id", input.userId).eq("workspace_id", input.workspaceId).maybeSingle();
  if (error) throw new Error("Slack source is unavailable.");
  return data;
}
