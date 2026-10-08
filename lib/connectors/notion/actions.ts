import type { ConnectorActionHandler } from "@/lib/connectors/types";
import { NOTION_API_VERSION, NOTION_CAPABILITIES } from "@/lib/connectors/notion/constants";
import { notionApiErrorResult, notionApiFetch } from "@/lib/connectors/notion/api";
import { mapNotionProperties, normalizeNotionPage, notionExactMatchFilter, notionPageBelongsToDataSource } from "@/lib/connectors/notion/properties";
import { describeNotionResources, notionContainingDatabaseId } from "@/lib/connectors/notion/resources";
import { captureOperationalEvent } from "@/lib/observability";
import { ConnectorError, ambiguousAcknowledgement } from "@/lib/connectors/errors";

function uuid(value: unknown, label: string) {
  const id = String(value ?? "").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(id)) throw new Error(`Choose a valid Notion ${label}.`);
  return id;
}

function values(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Notion property values must be a named set of fields.");
  return value as Record<string, unknown>;
}

async function dataSourceSchema(userId: string, connectionId: string, dataSourceId: string) {
  const source = await notionApiFetch({ userId, connectionId, requiredCapabilities: [NOTION_CAPABILITIES.readContent], path: `/data_sources/${dataSourceId}` });
  const raw = source.properties && typeof source.properties === "object" && !Array.isArray(source.properties) ? source.properties as Record<string, { id?: unknown; name?: unknown; type?: unknown }> : {};
  return Object.entries(raw).map(([name, property]) => ({ id: String(property.id ?? name), name: String(property.name ?? name), type: String(property.type ?? "") }));
}

async function success(operation: string, context: Parameters<ConnectorActionHandler>[1]) {
  await captureOperationalEvent({ level: "info", event: "notion_action_success", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "succeeded", metadata: { operation } });
}
async function failure(context: Parameters<ConnectorActionHandler>[1]) {
  await captureOperationalEvent({ level: "warn", event: "notion_action_failure", userId: context.userId, workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId, status: "failed", errorCategory: "provider" });
}

export const notionCreatePage: ConnectorActionHandler = async (input, context) => {
  try {
    if (!context.connectionId) throw new Error("Choose a Notion workspace before creating a page.");
    const parentPageId = uuid(input.parentPageId, "parent page"); const title = String(input.title ?? "").trim(); const content = String(input.content ?? "").trim();
    if (!title) throw new Error("Page title is required.");
    const page = await notionApiFetch({ userId: context.userId, connectionId: context.connectionId, requiredCapabilities: [NOTION_CAPABILITIES.readContent, NOTION_CAPABILITIES.insertContent], path: "/pages", method: "POST", write: true, body: { parent: { type: "page_id", page_id: parentPageId }, properties: { title: { type: "title", title: [{ type: "text", text: { content: title.slice(0, 2_000) } }] } }, ...(content ? { children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: content.slice(0, 2_000) } }] } }] } : {}) } });
    const normalized = normalizeNotionPage(page); if (!normalized.page.id) throw new ConnectorError(ambiguousAcknowledgement("Notion did not acknowledge the created page; creation may have happened.")); await success("create_page", context);
    return { status: "succeeded", acknowledged: true, externallyDelivered: true, providerReferenceId: normalized.page.id, output: normalized, metadata: { operation: "create_page", apiVersion: NOTION_API_VERSION } };
  } catch (error) { await failure(context); return notionApiErrorResult(error); }
};

export const notionCreateDataSourceItem: ConnectorActionHandler = async (input, context) => {
  try {
    if (!context.connectionId) throw new Error("Choose a Notion workspace before creating an item.");
    const dataSourceId = uuid(input.dataSourceId, "data source"); const schema = await dataSourceSchema(context.userId, context.connectionId, dataSourceId); const properties = mapNotionProperties(schema, values(input.values));
    const page = await notionApiFetch({ userId: context.userId, connectionId: context.connectionId, requiredCapabilities: [NOTION_CAPABILITIES.readContent, NOTION_CAPABILITIES.insertContent], path: "/pages", method: "POST", write: true, body: { parent: { type: "data_source_id", data_source_id: dataSourceId }, properties } });
    const normalized = normalizeNotionPage(page); if (!normalized.page.id) throw new ConnectorError(ambiguousAcknowledgement("Notion did not acknowledge the created item; creation may have happened.")); await success("create_data_source_item", context);
    return { status: "succeeded", acknowledged: true, externallyDelivered: true, providerReferenceId: normalized.page.id, output: normalized, metadata: { operation: "create_data_source_item", apiVersion: NOTION_API_VERSION } };
  } catch (error) { await failure(context); return notionApiErrorResult(error); }
};

export const notionFindItem: ConnectorActionHandler = async (input, context) => {
  try {
    if (!context.connectionId) throw new Error("Choose a Notion workspace before finding an item.");
    const dataSourceId = uuid(input.dataSourceId, "data source"); const propertyName = String(input.matchProperty ?? "").trim(); const schema = await dataSourceSchema(context.userId, context.connectionId, dataSourceId); const property = schema.find((item) => item.name.toLowerCase() === propertyName.toLowerCase());
    if (!property) throw new Error(`Notion property ${propertyName} does not exist in the selected data source.`);
    const result = await notionApiFetch({ userId: context.userId, connectionId: context.connectionId, requiredCapabilities: [NOTION_CAPABILITIES.readContent], path: `/data_sources/${dataSourceId}/query`, method: "POST", body: { filter: notionExactMatchFilter(property, input.matchValue), page_size: 2 } });
    const matches = Array.isArray(result.results) ? result.results.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
    if (matches.length > 1) throw new ConnectorError({ category: "validation", code: "NOTION_AMBIGUOUS_MATCH", message: "More than one Notion item matched. Add a more specific exact-match condition.", retryable: false });
    await success("find_item", context);
    return { status: "succeeded", acknowledged: true, externallyDelivered: false, ...(matches[0]?.id ? { providerReferenceId: String(matches[0].id) } : {}), output: matches[0] ? { found: true, ...normalizeNotionPage(matches[0]) } : { found: false }, metadata: { operation: "find_item", matchCount: matches.length, apiVersion: NOTION_API_VERSION } };
  } catch (error) { await failure(context); return notionApiErrorResult(error); }
};

export const notionUpdateItem: ConnectorActionHandler = async (input, context) => {
  try {
    if (!context.connectionId) throw new Error("Choose a Notion workspace before updating an item.");
    const pageId = uuid(input.pageId, "page or item"); const dataSourceId = uuid(input.dataSourceId, "data source");
    const currentPage = await notionApiFetch({ userId: context.userId, connectionId: context.connectionId, requiredCapabilities: [NOTION_CAPABILITIES.readContent], path: `/pages/${pageId}` });
    if (!notionPageBelongsToDataSource(currentPage, dataSourceId)) {
      throw new Error("The selected Notion item does not belong to the selected data source.");
    }
    const schema = await dataSourceSchema(context.userId, context.connectionId, dataSourceId); const properties = mapNotionProperties(schema, values(input.values));
    const page = await notionApiFetch({ userId: context.userId, connectionId: context.connectionId, requiredCapabilities: [NOTION_CAPABILITIES.readContent, NOTION_CAPABILITIES.updateContent], path: `/pages/${pageId}`, method: "PATCH", write: true, body: { properties } });
    const normalized = normalizeNotionPage(page); if (normalized.page.id.replace(/-/g, "") !== pageId) throw new ConnectorError(ambiguousAcknowledgement("Notion did not acknowledge the requested item update; the change may have happened.")); await success("update_item", context);
    return { status: "succeeded", acknowledged: true, externallyDelivered: true, providerReferenceId: normalized.page.id, output: normalized, metadata: { operation: "update_item", apiVersion: NOTION_API_VERSION } };
  } catch (error) { await failure(context); return notionApiErrorResult(error); }
};

export async function listNotionResources(input: { userId: string; connectionId: string; resolveParentContext?: boolean }) {
  const searchResults: unknown[] = [];
  let cursor: string | undefined;
  do {
    const result = await notionApiFetch({ userId: input.userId, connectionId: input.connectionId, requiredCapabilities: [NOTION_CAPABILITIES.readContent], path: "/search", method: "POST", body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } });
    searchResults.push(...(Array.isArray(result.results) ? result.results : []));
    cursor = result.has_more === true && typeof result.next_cursor === "string" ? result.next_cursor : undefined;
  } while (cursor && searchResults.length < 1_000);

  const databases = new Map<string, unknown>();
  if (input.resolveParentContext !== false) {
    // Parent lookups are bounded. A source without a verified containing database
    // remains readable, but cannot be offered as a normal create target.
    const ids = [...new Set(searchResults.map(notionContainingDatabaseId).filter((id): id is string => Boolean(id)))].slice(0, 12);
    for (const id of ids) {
      try {
        databases.set(id, await notionApiFetch({ userId: input.userId, connectionId: input.connectionId,
          requiredCapabilities: [NOTION_CAPABILITIES.readContent], path: `/databases/${id}` }));
      } catch (error) {
        if (error instanceof ConnectorError && error.details.category === "authentication") throw error;
      }
    }
  }
  return describeNotionResources(searchResults, databases);
}

export async function inspectNotionDataSource(input: { userId: string; connectionId: string; dataSourceId: string }) {
  const id = uuid(input.dataSourceId, "data source");
  const properties = await dataSourceSchema(input.userId, input.connectionId, id);
  return { id, properties: properties.map((property) => ({ ...property, supported: ["title", "rich_text", "number", "checkbox", "select", "status", "date", "url", "email", "phone_number"].includes(property.type) })) };
}
