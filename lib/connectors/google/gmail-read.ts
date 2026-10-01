import "server-only";

import { googleApiFetch } from "@/lib/connectors/google/api";
import { normalizeGmailMessage } from "@/lib/connectors/google/gmail-message";
import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";
import { gmailSearchQuery, readBoundedGmailListPayload, readBoundedGmailMessagePayload } from "@/lib/connectors/google/gmail-read-core";
import { createAdminClient } from "@/lib/supabase/admin";

const MAX_RESULTS = 5;
export type GmailReadMessage = ReturnType<typeof normalizeGmailMessage>["message"];

export type GmailReadResult = {
  status: "ok" | "connection_required" | "reconnect_required" | "account_selection_required";
  connectionId?: string;
  messages: GmailReadMessage[];
};

async function ownedGmailConnection(userId: string, workspaceId: string, connectionId?: string) {
  let query = createAdminClient().from("connector_connections")
    .select("id,status,granted_scopes")
    .eq("user_id", userId)
    .eq("workspace_id", workspaceId)
    .eq("provider_family", "google")
    .in("connector_id", ["google", "google_gmail"])
    .neq("status", "revoked");
  if (connectionId) query = query.eq("id", connectionId);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Gmail connection could not be checked.");
  return data;
}

/** Owner-only message detail for internal Ask source links. No HTML or attachment bytes leave this boundary. */
export async function readGmailMessage(input: {
  userId: string;
  workspaceId: string;
  connectionId: string;
  messageId: string;
}): Promise<GmailReadMessage | null> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.messageId)) return null;
  const connection = await ownedGmailConnection(input.userId, input.workspaceId, input.connectionId);
  if (!connection || connection.status !== "connected"
    || !connection.granted_scopes.includes(GOOGLE_SCOPES.gmailReadonly)) return null;
  const response = await googleApiFetch({
    userId: input.userId,
    connectionId: connection.id,
    requiredScopes: [GOOGLE_SCOPES.gmailReadonly],
    url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(input.messageId)}?format=full`,
    allowNotFoundResponse: true,
  });
  if (response.status === 404) return null;
  const normalized = normalizeGmailMessage(await readBoundedGmailMessagePayload(response)).message;
  return { ...normalized,
    attachments: normalized.attachments.map(({ filename, mimeType, size }) => ({ filename, mimeType, size })) };
}

/** A bounded, owner-scoped read surface. The model never controls Gmail API parameters. */
export async function readGmailForAsk(input: {
  userId: string;
  workspaceId: string;
  question: string;
}): Promise<GmailReadResult> {
  const { data: connections, error } = await createAdminClient().from("connector_connections")
    .select("id,status,granted_scopes,external_account_label")
    .eq("user_id", input.userId).eq("workspace_id", input.workspaceId)
    .eq("provider_family", "google").in("connector_id", ["google", "google_gmail"])
    .neq("status", "revoked").order("created_at", { ascending: false }).limit(6);
  if (error) throw new Error("Gmail connection could not be checked.");
  if (!connections?.length) return { status: "connection_required", messages: [] };
  const usable = connections.filter((item) => item.status === "connected"
    && item.granted_scopes.includes(GOOGLE_SCOPES.gmailReadonly));
  if (!usable.length) return { status: "reconnect_required", messages: [] };
  const explicit = usable.filter((item) => item.external_account_label
    && input.question.toLowerCase().includes(item.external_account_label.toLowerCase()));
  const connection = explicit.length === 1 ? explicit[0]
    : usable.length === 1 ? usable[0] : null;
  if (!connection) return { status: "account_selection_required", messages: [] };

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("maxResults", String(MAX_RESULTS));
  const searchQuestion = connection.external_account_label
    ? input.question.toLowerCase().replaceAll(connection.external_account_label.toLowerCase(), "")
    : input.question;
  listUrl.searchParams.set("q", gmailSearchQuery(searchQuestion));
  const listResponse = await googleApiFetch({
    userId: input.userId,
    connectionId: connection.id,
    requiredScopes: [GOOGLE_SCOPES.gmailReadonly],
    url: listUrl.toString(),
  });
  const listed = await readBoundedGmailListPayload(listResponse) as { messages?: Array<{ id?: string }> };
  const ids = (listed.messages ?? [])
    .flatMap((message) => typeof message.id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(message.id) ? [message.id] : [])
    .slice(0, MAX_RESULTS);
  const messages = await Promise.all(ids.map(async (id): Promise<GmailReadMessage> => {
    const response = await googleApiFetch({
      userId: input.userId,
      connectionId: connection.id,
      requiredScopes: [GOOGLE_SCOPES.gmailReadonly],
      url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
    });
    const normalized = normalizeGmailMessage(await readBoundedGmailMessagePayload(response)).message;
    return {
      ...normalized,
      attachments: normalized.attachments.map(({ filename, mimeType, size }) => ({ filename, mimeType, size })),
    };
  }));
  return { status: "ok", connectionId: connection.id, messages };
}
