export const SUPPORTED_NOTION_PROPERTY_TYPES = ["title", "rich_text", "number", "checkbox", "select", "status", "date", "url", "email", "phone_number"] as const;
export type SupportedNotionPropertyType = (typeof SUPPORTED_NOTION_PROPERTY_TYPES)[number];

export type NotionPropertySchema = { id: string; name: string; type: string };

function richText(value: unknown) {
  return [{ type: "text", text: { content: String(value ?? "").slice(0, 2_000) } }];
}

export function encodeNotionProperty(property: NotionPropertySchema, value: unknown): Record<string, unknown> {
  switch (property.type) {
    case "title": return { title: richText(value) };
    case "rich_text": return { rich_text: richText(value) };
    case "number": {
      const number = Number(value); if (!Number.isFinite(number)) throw new Error(`${property.name} must be a number.`); return { number };
    }
    case "checkbox": return { checkbox: value === true || String(value).toLowerCase() === "true" };
    case "select": return { select: value === null || value === "" ? null : { name: String(value).slice(0, 100) } };
    case "status": return { status: value === null || value === "" ? null : { name: String(value).slice(0, 100) } };
    case "date": return { date: value === null || value === "" ? null : { start: new Date(String(value)).toISOString() } };
    case "url": return { url: value === null || value === "" ? null : new URL(String(value)).toString() };
    case "email": {
      const email = String(value ?? "").trim(); if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`${property.name} must be an email address.`); return { email: email || null };
    }
    case "phone_number": return { phone_number: String(value ?? "").trim() || null };
    default: throw new Error(`${property.name} uses unsupported Notion property type ${property.type}.`);
  }
}

export function mapNotionProperties(schema: NotionPropertySchema[], values: Record<string, unknown>) {
  const byName = new Map(schema.map((property) => [property.name.toLowerCase(), property]));
  const mapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    const property = byName.get(name.toLowerCase());
    if (!property) continue;
    mapped[property.name] = encodeNotionProperty(property, value);
  }
  const titleProperty = schema.find((property) => property.type === "title");
  if (titleProperty && mapped[titleProperty.name] === undefined) {
    const fallback = values.title ?? values.name ?? values.Summary ?? values.summary ?? values.text;
    if (fallback !== undefined && fallback !== "") mapped[titleProperty.name] = encodeNotionProperty(titleProperty, fallback);
  }
  if (Object.keys(mapped).length === 0) throw new Error("None of the submitted fields match supported properties in the selected Notion data source.");
  return mapped;
}

export function notionExactMatchFilter(property: NotionPropertySchema, value: unknown) {
  if (property.type === "title") return { property: property.name, title: { equals: String(value) } };
  if (property.type === "rich_text") return { property: property.name, rich_text: { equals: String(value) } };
  if (property.type === "number") return { property: property.name, number: { equals: Number(value) } };
  if (property.type === "checkbox") return { property: property.name, checkbox: { equals: value === true || String(value).toLowerCase() === "true" } };
  if (property.type === "select") return { property: property.name, select: { equals: String(value) } };
  if (property.type === "status") return { property: property.name, status: { equals: String(value) } };
  if (property.type === "date") return { property: property.name, date: { equals: String(value) } };
  if (property.type === "url") return { property: property.name, url: { equals: String(value) } };
  if (property.type === "email") return { property: property.name, email: { equals: String(value) } };
  if (property.type === "phone_number") return { property: property.name, phone_number: { equals: String(value) } };
  throw new Error(`${property.name} cannot be used for exact-match lookup.`);
}

export function plainNotionText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => item && typeof item === "object" && "plain_text" in item ? String((item as { plain_text?: unknown }).plain_text ?? "") : "").join("");
}

export function normalizeNotionPage(page: Record<string, unknown>) {
  const properties = page.properties && typeof page.properties === "object" && !Array.isArray(page.properties) ? page.properties as Record<string, Record<string, unknown>> : {};
  const title = Object.values(properties).find((property) => property.type === "title");
  const parent = page.parent && typeof page.parent === "object" && !Array.isArray(page.parent) ? page.parent as Record<string, unknown> : {};
  return { page: { id: String(page.id ?? ""), url: String(page.url ?? ""), title: title ? plainNotionText(title.title) : "", createdAt: String(page.created_time ?? ""), updatedAt: String(page.last_edited_time ?? ""), parentId: String(parent.page_id ?? parent.data_source_id ?? parent.database_id ?? ""), parentType: String(parent.type ?? ""), properties } };
}
