import { validCalendarEventId, validateCalendarTime } from "@/lib/connectors/google/calendar-core";

export type CalendarActionIntent =
  | { kind: "create"; summary: string; start: string; end: string; timeZone: string }
  | { kind: "update"; eventId: string; summary: string };

/** Deliberately narrow: an external calendar change is never inferred from vague prose. */
export function parseCalendarActionIntent(question: string): CalendarActionIntent | "clarification" | null {
  const text = question.trim();
  if (!/^(?:please\s+)?(?:create|schedule|update|change)\b/i.test(text)
    || !/\bcalendar\b/i.test(text)) return null;
  const create = text.match(/^(?:please\s+)?(?:create|schedule)\s+(?:a\s+)?(?:google calendar|calendar)\s+event\s+[“"]([^”"]{1,180})[”"]\s+from\s+(\S+)\s+to\s+(\S+)\s+in\s+([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\.?$/i);
  if (create) {
    try {
      const times = validateCalendarTime({ start: create[2], end: create[3], timeZone: create[4] });
      return { kind: "create", summary: create[1].trim(), ...times };
    } catch { return "clarification"; }
  }
  const update = text.match(/^(?:please\s+)?(?:update|change)\s+(?:google calendar|calendar)\s+event\s+([A-Za-z0-9_-]{5,1024})\s+title\s+to\s+[“"]([^”"]{1,180})[”"]\.?$/i);
  if (update && validCalendarEventId(update[1])) return { kind: "update", eventId: update[1], summary: update[2].trim() };
  return "clarification";
}
