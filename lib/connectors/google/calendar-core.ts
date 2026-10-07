import { createHash } from "node:crypto";

import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";

export const MAX_CALENDAR_RESPONSE_BYTES = 128 * 1024;
const OFFSET_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/;
const EVENT_ID = /^[A-Za-z0-9_-]{5,1024}$/;

export function validCalendarEventId(value: unknown): value is string {
  return typeof value === "string" && EVENT_ID.test(value);
}

export function calendarConnectionAllowsEventSource(
  connection: { id: string; status: string; granted_scopes: string[] } | null | undefined,
  connectionId: string,
): boolean {
  return connection?.id === connectionId && connection.status === "connected"
    && connection.granted_scopes.includes(GOOGLE_SCOPES.calendarEventsOwned);
}

export function calendarEventIdForAction(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
}

export function validateCalendarTime(input: { start: unknown; end: unknown; timeZone: unknown }) {
  const { start, end, timeZone } = input;
  if (typeof start !== "string" || typeof end !== "string" || !OFFSET_DATE_TIME.test(start) || !OFFSET_DATE_TIME.test(end)
    || typeof timeZone !== "string" || timeZone.length > 100 || !/^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(timeZone)) {
    throw new Error("Use exact start and end times with UTC offsets and an IANA time zone.");
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  for (const value of [start, end]) {
    const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) {
      throw new Error("The event date is invalid.");
    }
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || endMs - startMs > 24 * 60 * 60 * 1000) {
    throw new Error("The event must have a valid start and end, no more than 24 hours apart.");
  }
  for (const [value, ms] of [[start, startMs], [end, endMs]] as const) {
    let zoneOffset: string;
    try {
      const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
        .formatToParts(new Date(ms)).find((item) => item.type === "timeZoneName")?.value;
      if (!part) throw new Error("Missing time zone offset");
      zoneOffset = part === "GMT" ? "+00:00" : part.slice(3);
    } catch {
      throw new Error("Use a recognized IANA time zone.");
    }
    const submittedOffset = value.endsWith("Z") ? "+00:00" : value.slice(-6);
    if (submittedOffset !== zoneOffset) throw new Error("The UTC offset does not match the time zone at the event date.");
  }
  return { start, end, timeZone };
}

export function calendarEventFromProvider(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (!validCalendarEventId(event.id) || typeof event.summary !== "string" || event.summary.length > 500
    || typeof event.etag !== "string" || event.etag.length > 300 || event.status === "cancelled") return null;
  const start = event.start && typeof event.start === "object" ? event.start as Record<string, unknown> : null;
  const end = event.end && typeof event.end === "object" ? event.end as Record<string, unknown> : null;
  const startAt = typeof start?.dateTime === "string" ? start.dateTime : typeof start?.date === "string" ? start.date : null;
  const endAt = typeof end?.dateTime === "string" ? end.dateTime : typeof end?.date === "string" ? end.date : null;
  if (!startAt || !endAt || startAt.length > 80 || endAt.length > 80) return null;
  return {
    id: event.id, summary: event.summary, etag: event.etag, startAt, endAt,
    timeZone: typeof start?.timeZone === "string" && start.timeZone.length <= 100 ? start.timeZone : null,
    htmlLink: typeof event.htmlLink === "string" && event.htmlLink.startsWith("https://www.google.com/calendar/") ? event.htmlLink : null,
  };
}

export async function readBoundedCalendarJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CALENDAR_RESPONSE_BYTES) throw new Error("Calendar response exceeded the read limit.");
  const body = await response.text();
  if (new TextEncoder().encode(body).length > MAX_CALENDAR_RESPONSE_BYTES) throw new Error("Calendar response exceeded the read limit.");
  return JSON.parse(body) as unknown;
}
