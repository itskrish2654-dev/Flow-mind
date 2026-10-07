import "server-only";

import { googleApiErrorResult, googleApiFetch } from "@/lib/connectors/google/api";
import { calendarEventFromProvider, calendarEventIdForAction, readBoundedCalendarJson, validCalendarEventId, validateCalendarTime } from "@/lib/connectors/google/calendar-core";
import { GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";
import { ConnectorError } from "@/lib/connectors/errors";
import type { ConnectorActionHandler } from "@/lib/connectors/types";
import { captureOperationalEvent } from "@/lib/observability";
import { createAdminClient } from "@/lib/supabase/admin";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const EVENT_SCOPE = [GOOGLE_SCOPES.calendarEventsOwned];
const MAX_EVENTS = 20;

type CalendarEvent = NonNullable<ReturnType<typeof calendarEventFromProvider>>;
type CalendarReadStatus = "ok" | "connection_required" | "reconnect_required" | "account_selection_required";

async function ownedCalendarConnections(userId: string, workspaceId: string) {
  const { data, error } = await createAdminClient().from("connector_connections")
    .select("id,status,granted_scopes,external_account_label")
    .eq("user_id", userId).eq("workspace_id", workspaceId).eq("provider_family", "google")
    .in("connector_id", ["google", "google_calendar"]).neq("status", "revoked")
    .order("created_at", { ascending: false }).limit(6);
  if (error) throw new Error("Calendar connection could not be checked.");
  return data ?? [];
}

export async function selectCalendarConnection(input: { userId: string; workspaceId: string; question?: string }): Promise<
  { status: CalendarReadStatus; connectionId?: string; accountLabel?: string }
> {
  const connections = await ownedCalendarConnections(input.userId, input.workspaceId);
  if (!connections.length) return { status: "connection_required" };
  const usable = connections.filter((item) => item.status === "connected"
    && item.granted_scopes.includes(GOOGLE_SCOPES.calendarEventsOwned));
  if (!usable.length) return { status: "reconnect_required" };
  const explicit = usable.filter((item) => item.external_account_label
    && input.question?.toLowerCase().includes(item.external_account_label.toLowerCase()));
  const selected = explicit.length === 1 ? explicit[0] : usable.length === 1 ? usable[0] : null;
  if (!selected) return { status: "account_selection_required" };
  return { status: "ok", connectionId: selected.id, accountLabel: selected.external_account_label ?? undefined };
}

async function assertOwnedCalendarConnection(input: { userId: string; workspaceId: string; connectionId: string; list?: boolean }) {
  const connection = (await ownedCalendarConnections(input.userId, input.workspaceId))
    .find((item) => item.id === input.connectionId);
  if (!connection || connection.status !== "connected"
    || !connection.granted_scopes.includes(input.list ? GOOGLE_SCOPES.calendarListReadonly : GOOGLE_SCOPES.calendarEventsOwned)) {
    throw new Error("Calendar access is unavailable for this account and workspace.");
  }
}

/** Shows only calendar metadata; no provider token is returned. */
export async function listGoogleCalendars(input: { userId: string; workspaceId: string; connectionId: string }) {
  await assertOwnedCalendarConnection({ ...input, list: true });
  const response = await googleApiFetch({ userId: input.userId, connectionId: input.connectionId,
    requiredScopes: [GOOGLE_SCOPES.calendarListReadonly],
    url: `${CALENDAR_API}/users/me/calendarList?maxResults=50&fields=items(id,summary,accessRole,primary),nextPageToken` });
  const data = await readBoundedCalendarJson(response) as { items?: unknown[]; nextPageToken?: unknown };
  const calendars = (Array.isArray(data.items) ? data.items : []).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    return typeof entry.id === "string" && entry.id.length <= 300 && typeof entry.summary === "string"
      ? [{ id: entry.id, summary: entry.summary.slice(0, 180), owned: entry.accessRole === "owner", primary: entry.primary === true }]
      : [];
  });
  return { calendars, complete: !data.nextPageToken };
}

/** Bounded owned-primary-calendar read for Ask. No attendee emails or descriptions are exposed. */
export async function readCalendarForAsk(input: { userId: string; workspaceId: string; question: string }): Promise<{
  status: CalendarReadStatus; connectionId?: string; events: CalendarEvent[]; complete: boolean;
}> {
  const connection = await selectCalendarConnection(input);
  if (connection.status !== "ok" || !connection.connectionId) return { status: connection.status, events: [], complete: true };
  const start = new Date();
  const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
  const url = new URL(`${CALENDAR_API}/calendars/primary/events`);
  url.searchParams.set("timeMin", start.toISOString());
  url.searchParams.set("timeMax", end.toISOString());
  url.searchParams.set("maxResults", String(MAX_EVENTS));
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("fields", "items(id,summary,etag,start,end,status,htmlLink),nextPageToken");
  const response = await googleApiFetch({ userId: input.userId, connectionId: connection.connectionId,
    requiredScopes: EVENT_SCOPE, url: url.toString() });
  const data = await readBoundedCalendarJson(response) as { items?: unknown[]; nextPageToken?: unknown };
  const events = (Array.isArray(data.items) ? data.items : []).flatMap((item) => {
    const event = calendarEventFromProvider(item); return event ? [event] : [];
  });
  return { status: "ok", connectionId: connection.connectionId, events, complete: !data.nextPageToken };
}

export async function readGoogleCalendarEvent(input: { userId: string; workspaceId: string; connectionId: string; eventId: string }) {
  if (!validCalendarEventId(input.eventId)) return null;
  await assertOwnedCalendarConnection(input);
  const response = await googleApiFetch({ userId: input.userId, connectionId: input.connectionId,
    requiredScopes: EVENT_SCOPE, url: `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(input.eventId)}?fields=id,summary,etag,start,end,status,htmlLink`,
    allowNotFoundResponse: true });
  if (response.status === 404) return null;
  const event = calendarEventFromProvider(await readBoundedCalendarJson(response));
  return event?.id === input.eventId ? event : null;
}

function invalid(message: string) {
  return new ConnectorError({ category: "validation", code: "CALENDAR_INPUT_INVALID", message, retryable: false });
}

function actionFailure(error: unknown, dispatched: boolean) {
  if (dispatched) return googleApiErrorResult(error);
  if (error instanceof ConnectorError) return googleApiErrorResult(error);
  return googleApiErrorResult(invalid(error instanceof Error ? error.message : "The Calendar request is invalid."));
}

export const calendarCreateEvent: ConnectorActionHandler = async (input, context) => {
  let dispatched = false;
  try {
    if (!context.connectionId) throw new Error("Choose a Google Calendar account.");
    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    if (!summary || summary.length > 180) throw new Error("Use an event title of 180 characters or fewer.");
    const times = validateCalendarTime({ start: input.start, end: input.end, timeZone: input.timeZone });
    const eventId = calendarEventIdForAction(context.idempotencyKey);
    const response = await googleApiFetch({ userId: context.userId, connectionId: context.connectionId,
      requiredScopes: EVENT_SCOPE, url: `${CALENDAR_API}/calendars/primary/events?sendUpdates=none&fields=id,summary,etag,start,end,status`,
      method: "POST", body: { id: eventId, summary, start: { dateTime: times.start, timeZone: times.timeZone }, end: { dateTime: times.end, timeZone: times.timeZone } },
      onDispatch: () => { dispatched = true; }, signal: context.signal });
    const event = calendarEventFromProvider(await readBoundedCalendarJson(response));
    if (!event || event.id !== eventId || event.summary !== summary
      || Date.parse(event.startAt) !== Date.parse(times.start) || Date.parse(event.endAt) !== Date.parse(times.end)) {
      throw new Error("Google Calendar did not acknowledge the exact event.");
    }
    await captureOperationalEvent({ level: "info", event: "calendar_action_success", userId: context.userId,
      workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId,
      status: "succeeded", metadata: { operation: "create_event" } });
    return { status: "succeeded", acknowledged: true, externallyDelivered: true, providerReferenceId: event.id,
      output: { eventId: event.id, etag: event.etag }, metadata: { operation: "create_event" } };
  } catch (error) {
    await captureOperationalEvent({ level: "warn", event: "calendar_action_failure", userId: context.userId,
      workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId,
      status: "failed", errorCategory: "provider", metadata: { operation: "create_event" } });
    return actionFailure(error, dispatched);
  }
};

export const calendarUpdateEvent: ConnectorActionHandler = async (input, context) => {
  let dispatched = false;
  try {
    if (!context.connectionId || !validCalendarEventId(input.eventId)) throw new Error("Choose one exact calendar event.");
    const summary = typeof input.summary === "string" ? input.summary.trim() : "";
    const etag = input.expectedEtag;
    if (!summary || summary.length > 180 || typeof etag !== "string" || !/^"[^"]{1,250}"$/.test(etag)) {
      throw new Error("A valid title and reviewed event version are required.");
    }
    const response = await googleApiFetch({ userId: context.userId, connectionId: context.connectionId,
      requiredScopes: EVENT_SCOPE, url: `${CALENDAR_API}/calendars/primary/events/${encodeURIComponent(input.eventId)}?sendUpdates=none&fields=id,summary,etag,start,end,status`,
      method: "PATCH", body: { summary }, headers: { "if-match": etag },
      onDispatch: () => { dispatched = true; }, signal: context.signal });
    const event = calendarEventFromProvider(await readBoundedCalendarJson(response));
    if (!event || event.id !== input.eventId || event.summary !== summary) throw new Error("Google Calendar did not acknowledge the exact update.");
    await captureOperationalEvent({ level: "info", event: "calendar_action_success", userId: context.userId,
      workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId,
      status: "succeeded", metadata: { operation: "update_event" } });
    return { status: "succeeded", acknowledged: true, externallyDelivered: true, providerReferenceId: event.id,
      output: { eventId: event.id, etag: event.etag }, metadata: { operation: "update_event" } };
  } catch (error) {
    await captureOperationalEvent({ level: "warn", event: "calendar_action_failure", userId: context.userId,
      workflowId: context.workflowId, executionId: context.executionId, stepId: context.stepId,
      status: "failed", errorCategory: "provider", metadata: { operation: "update_event" } });
    return actionFailure(error, dispatched);
  }
};
