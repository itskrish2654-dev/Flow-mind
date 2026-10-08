import "server-only";

import { listNotionResources } from "@/lib/connectors/notion/actions";
import { notionApiFetch } from "@/lib/connectors/notion/api";
import { NOTION_CAPABILITIES } from "@/lib/connectors/notion/constants";
import { notionBlockText } from "@/lib/connectors/notion/read-core";
import { normalizeNotionPage } from "@/lib/connectors/notion/properties";
import { notionLiveAcceptanceEnabled } from "@/lib/notion-live-acceptance";
import { createAdminClient } from "@/lib/supabase/admin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function ownedConnection(userId: string, workspaceId: string, connectionId?: string) {
  let query = createAdminClient().from("connector_connections")
    .select("id,status,granted_scopes,external_account_label")
    .eq("user_id", userId).eq("workspace_id", workspaceId)
    .eq("connector_id", "notion").eq("provider_family", "notion")
    .neq("status", "revoked");
  if (connectionId) query = query.eq("id", connectionId);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(6);
  if (error) throw new Error("Notion connection could not be checked.");
  return data ?? [];
}

export async function readNotionPage(input: { userId: string; workspaceId: string; connectionId: string; pageId: string }) {
  if (!notionLiveAcceptanceEnabled() || !UUID.test(input.connectionId) || !UUID.test(input.pageId)) return null;
  const connections = await ownedConnection(input.userId, input.workspaceId, input.connectionId);
  const connection = connections.find((row) => row.status === "connected" && row.granted_scopes.includes(NOTION_CAPABILITIES.readContent));
  if (!connection) return null;
  const resources = await listNotionResources({ userId: input.userId, connectionId: connection.id, resolveParentContext: false });
  const selected = resources.find((resource) => resource.type === "page"
    && resource.id.replace(/-/g, "").toLowerCase() === input.pageId.replace(/-/g, "").toLowerCase());
  if (!selected) return null;
  const page = await notionApiFetch({ userId: input.userId, connectionId: connection.id,
    requiredCapabilities: [NOTION_CAPABILITIES.readContent], path: `/pages/${input.pageId}` });
  if (String(page.id ?? "").replace(/-/g, "").toLowerCase() !== input.pageId.replace(/-/g, "").toLowerCase()) return null;
  const blocks = await notionApiFetch({ userId: input.userId, connectionId: connection.id,
    requiredCapabilities: [NOTION_CAPABILITIES.readContent], path: `/blocks/${input.pageId}/children?page_size=100` });
  const normalized = normalizeNotionPage(page).page;
  return { id: normalized.id, title: normalized.title || selected.title, content: notionBlockText(blocks),
    updatedAt: normalized.updatedAt, connectionId: connection.id };
}

export async function readNotionForAsk(input: { userId: string; workspaceId: string; question: string }) {
  if (!notionLiveAcceptanceEnabled()) return { status: "not_available" as const, page: null };
  const connections = await ownedConnection(input.userId, input.workspaceId);
  if (!connections.length) return { status: "connection_required" as const, page: null };
  const usable = connections.filter((row) => row.status === "connected" && row.granted_scopes.includes(NOTION_CAPABILITIES.readContent));
  if (!usable.length) return { status: "reconnect_required" as const, page: null };
  const candidates = await Promise.all(usable.map(async (connection) => ({ connection,
    resources: (await listNotionResources({ userId: input.userId, connectionId: connection.id, resolveParentContext: false })).filter((resource) => resource.type === "page"),
  })));
  const pages = candidates.flatMap(({ connection, resources }) => resources.map((resource) => ({ connection, resource })));
  const named = pages.filter(({ resource }) => resource.title.length > 1 && input.question.toLocaleLowerCase().includes(resource.title.toLocaleLowerCase()));
  const selected = named.length === 1 ? named[0] : named.length === 0 && pages.length === 1 ? pages[0] : null;
  if (!selected) return { status: "selection_required" as const, page: null };
  const page = await readNotionPage({ userId: input.userId, workspaceId: input.workspaceId,
    connectionId: selected.connection.id, pageId: selected.resource.id });
  return { status: "ok" as const, page };
}
