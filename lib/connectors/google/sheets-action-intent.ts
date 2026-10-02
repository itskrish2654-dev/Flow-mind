export type SheetWriteIntent =
  | { kind: "add"; initialValue: string | null; assignments: Record<string, string> }
  | { kind: "update"; target: string; assignments: Record<string, string> }
  | "clarification";

function parseAssignments(text: string): Record<string, string> | null {
  const parts = text.replace(/[.!?]+\s*$/, "").split(/\s*,\s*|\s+and\s+/i);
  if (!parts.length || parts.length > 8) return null;
  const assignments: Record<string, string> = {};
  for (const part of parts) {
    const match = part.trim().match(/^([A-Za-z][A-Za-z0-9 _-]{0,79})\s*(?:=|:)\s*(.{1,180})$/);
    if (!match) return null;
    const key = match[1].trim();
    if (Object.keys(assignments).some((existing) => existing.toLowerCase() === key.toLowerCase())) return null;
    assignments[key] = match[2].trim();
  }
  return assignments;
}

/** A deliberately small grammar: provider rows and model text cannot become writes. */
export function parseSheetWriteIntent(question: string): SheetWriteIntent | null {
  const text = question.trim().replace(/^please\s+/i, "");
  if (/^(?:add|append)\b/i.test(text)) {
    if (!/\b(?:sheet|spreadsheet|worksheet|sheets)\b/i.test(text)) return null;
    const match = text.match(/^(?:add|append)\s+(.+?)\s+to\s+(?:the\s+)?(?:.+?)\s+(?:with|using)\s+(.+)$/i);
    if (!match) return "clarification";
    const assignments = parseAssignments(match[2]);
    if (!assignments) return "clarification";
    const initial = match[1].trim();
    return { kind: "add", initialValue: /^\s*(?:a\s+)?row\s*$/i.test(initial) ? null : initial, assignments };
  }
  if (/^(?:mark|update|change|set)\b/i.test(text)
    && /\b(?:sheet|spreadsheet|worksheet)\b|\b[A-Za-z]{2,}'s\s+(?:status|stage)\b/i.test(text)) {
    const possessive = text.match(/^(?:mark|set|change|update)\s+(.+?)['’]s\s+([A-Za-z][A-Za-z0-9 _-]{0,79})\s+(?:as|to|=)\s+(.+?)(?:\s+in\s+.+)?[.!?]?$/i);
    if (possessive) return { kind: "update", target: possessive[1].trim(), assignments: { [possessive[2].trim()]: possessive[3].trim().replace(/[.!?]+$/, "") } };
    const byRow = text.match(/^(?:update|change|set)\s+(row\s+\d{1,6})\b.+?\b(?:with|to)\s+(.+)$/i);
    if (!byRow) return "clarification";
    const assignments = parseAssignments(byRow[2]);
    return assignments ? { kind: "update", target: byRow[1], assignments } : "clarification";
  }
  return null;
}
