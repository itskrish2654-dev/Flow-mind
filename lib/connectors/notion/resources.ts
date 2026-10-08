import { normalizeNotionPage, plainNotionText } from "@/lib/connectors/notion/properties";

type NotionObject = Record<string, unknown>;

export type NotionResource = {
  id: string;
  type: "page" | "data_source";
  title: string;
  url?: string;
  containerTitle?: string;
  parentPageTitle?: string;
  locationVerified: boolean;
  canCreateItems: boolean;
};

function object(value: unknown): NotionObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as NotionObject : {};
}

function canonicalId(value: unknown): string | null {
  const id = String(value ?? "").replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(id) ? id : null;
}

export function notionContainingDatabaseId(resource: unknown): string | null {
  const item = object(resource);
  if (item.object !== "data_source") return null;
  const parent = object(item.parent);
  if (parent.type !== "database_id" && parent.type !== "data_source_id") return null;
  return canonicalId(parent.database_id);
}

export function describeNotionResources(searchResults: unknown[], databases: Map<string, unknown>): NotionResource[] {
  const pages = new Map<string, string>();
  for (const item of searchResults) {
    const resource = object(item);
    const id = canonicalId(resource.id);
    if (resource.object !== "page" || !id) continue;
    const title = normalizeNotionPage(resource).page.title.trim();
    if (title) pages.set(id, title);
  }

  const described: NotionResource[] = [];
  for (const item of searchResults) {
    const resource = object(item);
    const id = canonicalId(resource.id);
    if (!id || (resource.object !== "page" && resource.object !== "data_source") || resource.in_trash === true || resource.archived === true) continue;
    const url = typeof resource.url === "string" ? resource.url : undefined;
    if (resource.object === "page") {
      const page = normalizeNotionPage(resource).page;
      described.push({ id: String(resource.id), type: "page", title: page.title.trim() || "Untitled page",
        ...(url ? { url } : {}), locationVerified: false, canCreateItems: false });
      continue;
    }

    const title = plainNotionText(resource.title).trim();
    const databaseId = notionContainingDatabaseId(resource);
    const database = object(databaseId ? databases.get(databaseId) : null);
    const databaseTitle = database.object === "database" && canonicalId(database.id) === databaseId
      ? plainNotionText(database.title).trim() : "";
    const databaseParent = object(database.parent);
    const parentPageId = databaseParent.type === "page_id" ? canonicalId(databaseParent.page_id) : null;
    described.push({ id: String(resource.id), type: "data_source", title: title || "Untitled data source",
      ...(url ? { url } : {}), ...(databaseTitle ? { containerTitle: databaseTitle } : {}),
      ...(parentPageId && pages.has(parentPageId) ? { parentPageTitle: pages.get(parentPageId) } : {}),
      locationVerified: Boolean(databaseTitle), canCreateItems: Boolean(title && databaseTitle) });
  }
  return described;
}

export function notionResourceLabel(resource: NotionResource): string {
  if (resource.type === "page") return `${resource.title} · page`;
  const location = resource.containerTitle ? `in ${resource.containerTitle}` : "location not verified";
  const parent = resource.parentPageTitle ? ` · under ${resource.parentPageTitle}` : "";
  return `${resource.title} · data source ${location}${parent}${resource.canCreateItems ? "" : " · not available for new items"}`;
}
