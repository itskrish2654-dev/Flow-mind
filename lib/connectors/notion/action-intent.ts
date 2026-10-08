const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export type NotionActionIntent =
  | { kind: "add"; dataSourceName: string; values: Record<string, unknown> }
  | { kind: "update"; pageId: string; dataSourceName: string; values: Record<string, unknown> };

/** Exact syntax prevents the model or vague prose from choosing a write target. */
export function parseNotionActionIntent(question: string): NotionActionIntent | "clarification" | null {
  const text = question.trim();
  if (!/^(?:please\s+)?(?:add|create|update|change)\b/i.test(text) || !/\bnotion\b/i.test(text)) return null;
  const add = text.match(/^(?:please\s+)?(?:add|create)\s+(?:a\s+)?notion\s+(?:data-source\s+)?item\s+to\s+[“"]([^”"]{1,180})[”"]\s+with\s+(\{[\s\S]{2,1000}\})\s*\.?$/i);
  const update = text.match(new RegExp(`^(?:please\\s+)?(?:update|change)\\s+notion\\s+item\\s+(${UUID})\\s+in\\s+[“\"]([^”\"]{1,180})[”\"]\\s+with\\s+(\\{[\\s\\S]{2,1000}\\})\\s*\\.?$`, "i"));
  const match = add ?? update;
  if (!match) return "clarification";
  try {
    const serialized = add ? add[2] : update![3];
    if (serialized.length > 500) return "clarification";
    const values: unknown = JSON.parse(serialized);
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length === 0) return "clarification";
    if (add) return { kind: "add", dataSourceName: add[1].trim(), values: values as Record<string, unknown> };
    return { kind: "update", pageId: update![1], dataSourceName: update![2].trim(), values: values as Record<string, unknown> };
  } catch { return "clarification"; }
}
