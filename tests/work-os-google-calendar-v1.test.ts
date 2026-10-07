import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { getCapability, getConnectorOnboarding } from "../lib/capability-registry";
import { selectAskTools } from "../lib/ask-core";
import { matchesConnectorSuccess } from "../lib/connectors/connection-success";
import { parseCalendarActionIntent } from "../lib/connectors/google/calendar-action-intent";
import { calendarConnectionAllowsEventSource, calendarEventFromProvider, calendarEventIdForAction, validCalendarEventId, validateCalendarTime } from "../lib/connectors/google/calendar-core";
import { GOOGLE_SCOPES, googleScopesForOperation } from "../lib/connectors/google/scopes";
import { unionGoogleScopes } from "../lib/connectors/google/oauth-finalization-core";
import { getConnector } from "../lib/connectors/registry";

test("Calendar OAuth asks only for owned-event/list scopes and preserves connector-specific separation", () => {
  const scopes = googleScopesForOperation("google_calendar", "create_event");
  assert.deepEqual(scopes, ["openid", "email", GOOGLE_SCOPES.calendarListReadonly, GOOGLE_SCOPES.calendarEventsOwned]);
  for (const unwanted of [GOOGLE_SCOPES.gmailReadonly, GOOGLE_SCOPES.gmailSend, GOOGLE_SCOPES.driveFile,
    "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/spreadsheets"]) assert.ok(!scopes.includes(unwanted));
  assert.ok(!googleScopesForOperation("google_gmail", "new_email").includes(GOOGLE_SCOPES.calendarEventsOwned));
  assert.ok(!googleScopesForOperation("google_sheets", "add_row").includes(GOOGLE_SCOPES.calendarEventsOwned));
  const union = unionGoogleScopes([GOOGLE_SCOPES.gmailReadonly, GOOGLE_SCOPES.gmailSend, GOOGLE_SCOPES.driveFile],
    scopes, "https://www.googleapis.com/auth/spreadsheets");
  for (const scope of [GOOGLE_SCOPES.gmailReadonly, GOOGLE_SCOPES.gmailSend, GOOGLE_SCOPES.driveFile,
    GOOGLE_SCOPES.calendarListReadonly, GOOGLE_SCOPES.calendarEventsOwned]) assert.ok(union.includes(scope));
});

test("Calendar registry and capability operations are exact while general workflow planning stays unsupported", () => {
  const connector = getConnector("google_calendar")!;
  assert.equal(connector.manifest.providerFamily, "google");
  assert.deepEqual(connector.manifest.actions.map((action) => action.key), ["create_event", "update_event"]);
  assert.deepEqual(connector.manifest.triggers, []);
  assert.equal(getConnectorOnboarding("google_calendar")?.available, true);
  for (const [id, operation] of [["google_calendar_create_event", "create_event"], ["google_calendar_update_event", "update_event"]]) {
    const capability = getCapability(id)!;
    assert.equal(capability.supported, true);
    assert.equal(capability.connectorOperation?.operationKey, operation);
    assert.equal(capability.plannerVisible, false);
    assert.equal(capability.builderVisible, false);
    assert.deepEqual(capability.requiredScopes, [GOOGLE_SCOPES.calendarEventsOwned]);
  }
  assert.equal(getCapability("google_calendar")?.supported, false);
});

test("Calendar times require explicit DST-correct offset, IANA zone, and ordered bounded duration", () => {
  assert.deepEqual(validateCalendarTime({ start: "2026-10-07T10:00:00+05:30", end: "2026-10-07T10:30:00+05:30", timeZone: "Asia/Kolkata" }),
    { start: "2026-10-07T10:00:00+05:30", end: "2026-10-07T10:30:00+05:30", timeZone: "Asia/Kolkata" });
  assert.throws(() => validateCalendarTime({ start: "2026-07-01T10:00:00+00:00", end: "2026-07-01T11:00:00+00:00", timeZone: "Europe/London" }), /offset/i);
  assert.throws(() => validateCalendarTime({ start: "2026-10-07T10:30:00+05:30", end: "2026-10-07T10:00:00+05:30", timeZone: "Asia/Kolkata" }), /valid start/i);
  assert.throws(() => validateCalendarTime({ start: "2026-02-31T10:00:00+05:30", end: "2026-02-31T10:30:00+05:30", timeZone: "Asia/Kolkata" }), /date is invalid/i);
  assert.throws(() => validateCalendarTime({ start: "tomorrow", end: "later", timeZone: "Asia/Kolkata" }), /exact start/i);
});

test("Calendar writes are parsed only from exact action text", () => {
  assert.deepEqual(parseCalendarActionIntent('Create Google Calendar event "Review" from 2026-10-07T10:00:00+05:30 to 2026-10-07T10:30:00+05:30 in Asia/Kolkata'),
    { kind: "create", summary: "Review", start: "2026-10-07T10:00:00+05:30", end: "2026-10-07T10:30:00+05:30", timeZone: "Asia/Kolkata" });
  assert.deepEqual(parseCalendarActionIntent('Update Google Calendar event abcdef123456 title to "Revised review"'),
    { kind: "update", eventId: "abcdef123456", summary: "Revised review" });
  assert.equal(parseCalendarActionIntent("Show my Google Calendar events"), null);
  assert.equal(parseCalendarActionIntent("Schedule something on my calendar"), "clarification");
  assert.equal(parseCalendarActionIntent("Delete all Calendar events"), null);
});

test("provider event IDs are deterministic, valid, and acknowledgements require exact event metadata", () => {
  const id = calendarEventIdForAction("approved-action-1");
  assert.equal(id, calendarEventIdForAction("approved-action-1"));
  assert.notEqual(id, calendarEventIdForAction("approved-action-2"));
  assert.ok(validCalendarEventId(id));
  const event = { id, summary: "Review", etag: '"abc"', start: { dateTime: "2026-10-07T10:00:00+05:30" }, end: { dateTime: "2026-10-07T10:30:00+05:30" } };
  assert.equal(calendarEventFromProvider(event)?.id, id);
  assert.equal(calendarEventFromProvider({ ...event, etag: undefined }), null);
  assert.equal(calendarEventFromProvider({ ...event, status: "cancelled" }), null);
});

test("Calendar event source hides absent, disconnected, and unscoped connections", () => {
  const connection = { id: "owner-connection", status: "connected", granted_scopes: [GOOGLE_SCOPES.calendarEventsOwned] };
  assert.equal(calendarConnectionAllowsEventSource(connection, connection.id), true);
  assert.equal(calendarConnectionAllowsEventSource(null, connection.id), false);
  assert.equal(calendarConnectionAllowsEventSource(connection, "other-connection"), false);
  assert.equal(calendarConnectionAllowsEventSource({ ...connection, status: "expired" }, connection.id), false);
  assert.equal(calendarConnectionAllowsEventSource({ ...connection, granted_scopes: [GOOGLE_SCOPES.calendarListReadonly] }, connection.id), false);
});

test("Ask Calendar reads route to bounded source and OAuth success requires actual Calendar grant", () => {
  assert.ok(selectAskTools("What meetings are on my Google Calendar this week?").includes("calendar_events"));
  assert.ok(!selectAskTools("Show my Gmail messages").includes("calendar_events"));
  assert.equal(matchesConnectorSuccess("google_calendar", { provider: "google", providerName: "Gmail", status: "connected", calendarAccess: false }), false);
  assert.equal(matchesConnectorSuccess("google_calendar", { provider: "google", providerName: "Gmail", status: "connected", calendarAccess: true }), true);
});

test("Calendar server path remains owner/workspace-scoped and conditional without exposing credentials to client", async () => {
  const calendar = await readFile("lib/connectors/google/calendar.ts", "utf8");
  const planner = await readFile("lib/ask-action-planner.ts", "utf8");
  const source = await readFile("app/dashboard/calendar/[connectionId]/[eventId]/page.tsx", "utf8");
  const connections = await readFile("components/connections-list.tsx", "utf8");
  assert.match(calendar, /\.eq\("user_id", userId\)\.eq\("workspace_id", workspaceId\)/);
  assert.match(calendar, /maxResults", String\(MAX_EVENTS\)/);
  assert.match(calendar, /"if-match": etag/);
  assert.match(calendar, /calendarEventIdForAction\(context\.idempotencyKey\)/);
  assert.match(planner, /ActionPreviewSchema\.safeParse/);
  assert.match(source, /readGoogleCalendarEvent\(\{ userId: auth\.user\.id, workspaceId: auth\.workspace\.id/);
  assert.match(calendar, /if \(!calendarConnectionAllowsEventSource\(connection, input\.connectionId\)\) return null;/);
  assert.match(source, /if \(!event\) notFound\(\)/);
  assert.doesNotMatch(connections, /access_token|refresh_token|client_secret/i);
});
