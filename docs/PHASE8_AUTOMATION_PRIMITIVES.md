# Automation primitives

## Schedules

Schedules are configured in plain language and always persist an IANA timezone. Supported forms are hourly, every N hours (2–168), daily, weekdays, weekly, monthly on days 1–28, and a future one-time date/time. Users never enter cron syntax.

Supabase Cron calls the authenticated schedule dispatcher every minute. Each occurrence pins the active immutable workflow version and creates the same durable execution and step rows used by other triggers. The occurrence timestamp is part of the execution idempotency key, so parallel dispatch cannot create duplicate provider work.

Missed-run policy is bounded: the dispatcher collapses backlog to the most recent intended occurrence. It runs that occurrence only when it is at most 15 minutes late. Older occurrences are recorded as `missed` with the reason and are not replayed. Editing an active workflow moves future occurrences to the new version and recalculates the next run; an already-created execution stays on its original version. Unpublishing or archiving disables the schedule.

## If / Otherwise

Conditions are stored as a bounded structured comparison with a human label. Supported operators are equals, does not equal, contains, does not contain, exists, does not exist, greater than, less than, is true, and is false. Simple comparisons do not call AI. Natural classification requests add one AI classification step and then evaluate its persisted result.

Only the matching branch executes. Other branch steps are recorded as `SKIPPED — condition not matched`, which is neutral rather than failed. Retry reuses a completed condition decision from sanitized step metadata and does not repeat completed AI work.

## Preview and live test

Homepage Preview runs only the planner and compiler: it creates no execution and has no external side effects. `Test this loop` is a Live Test: it creates a durable execution marked `TEST` and runs real provider actions. Before a provider action or outbound request, the UI names the side effect and asks for confirmation. A simulated success is never substituted for provider acknowledgement. Scheduled triggers are simulated immediately in Live Test; users never wait for the next occurrence.

## Connector demand

Unsupported planner results offer one request button per classified capability. The service stores provider/capability classification, source, a one-way requester hash, optional authenticated owner ID, and separate unique/total counts. Full prompts and payload contents are not stored. Browser roles have no table or report access. Operators query the service-only `connector_request_demand_report` view.

## Human approval

Durable human approval is deferred. The planner remains truthful and reports approval as unsupported; it does not create a fake pause or approval link.
