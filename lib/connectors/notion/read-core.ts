import { plainNotionText } from "@/lib/connectors/notion/properties";

/** Keep only bounded, human-readable text from the page's first block page. */
export function notionBlockText(payload: Record<string, unknown>): string {
  const blocks = Array.isArray(payload.results) ? payload.results.slice(0, 100) : [];
  const lines: string[] = [];
  for (const item of blocks) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const block = item as Record<string, unknown>;
    const type = typeof block.type === "string" ? block.type : "";
    if (!["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "quote"].includes(type)) continue;
    const value = block[type];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const text = plainNotionText((value as Record<string, unknown>).rich_text).trim();
    if (text) lines.push(text.slice(0, 500));
  }
  return lines.join("\n").slice(0, 2_000);
}
