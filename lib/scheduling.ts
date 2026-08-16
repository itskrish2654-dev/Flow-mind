import type { CompiledWorkflow } from "@/lib/schemas/workflow";

export type ScheduleDefinition = NonNullable<
  NonNullable<CompiledWorkflow["steps"][number]["config"]>["schedule"]
>;

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value.includes("/") || value === "UTC";
  } catch {
    return false;
  }
}

export function extractTimeZone(prompt: string): string | null {
  if (/\bUTC\b/.test(prompt)) return "UTC";
  const candidate = prompt.match(/\b(?:timezone\s+)?([A-Z][A-Za-z_]+\/[A-Z][A-Za-z_]+(?:\/[A-Z][A-Za-z_]+)?)\b/)?.[1];
  return candidate && isValidTimeZone(candidate) ? candidate : null;
}

function parseLocalTime(prompt: string): string | null {
  const match = prompt.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (match) {
    let hour = Number(match[1]) % 12;
    if (match[3].toLowerCase() === "pm") hour += 12;
    return `${String(hour).padStart(2, "0")}:${match[2] ?? "00"}`;
  }
  const twentyFourHour = prompt.match(/\bat\s+([01]?\d|2[0-3]):([0-5]\d)\b/i);
  return twentyFourHour
    ? `${String(Number(twentyFourHour[1])).padStart(2, "0")}:${twentyFourHour[2]}`
    : null;
}

function humanTime(localTime: string): string {
  const [hour, minute] = localTime.split(":").map(Number);
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export type ParsedSchedule =
  | { ok: true; schedule: ScheduleDefinition }
  | { ok: false; questions: string[] };

export function parseScheduleLanguage(prompt: string, now = new Date()): ParsedSchedule | null {
  const scheduled = /\b(every|each|daily|weekly|monthly|weekday|weekdays|on\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2})\b/i.test(prompt);
  if (!scheduled) return null;

  const timezone = extractTimeZone(prompt);
  if (!timezone) return { ok: false, questions: ["What timezone should this schedule use? For example, Asia/Kolkata or America/New_York."] };

  const localTime = parseLocalTime(prompt);
  const interval = prompt.match(/\bevery\s+(\d{1,3})\s+hours?\b/i);
  if (interval) {
    const intervalHours = Number(interval[1]);
    if (intervalHours < 2 || intervalHours > 168) return { ok: false, questions: ["How many hours apart should each run be? Choose between 2 and 168 hours."] };
    return { ok: true, schedule: { kind: "interval_hours", intervalHours, timezone, humanLabel: `Every ${intervalHours} hours` } };
  }
  if (/\bevery\s+hour\b/i.test(prompt)) {
    return { ok: true, schedule: { kind: "hourly", timezone, humanLabel: "Every hour" } };
  }

  const oneTime = prompt.match(new RegExp(`\\bon\\s+(${Object.keys(MONTHS).join("|")})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?`, "i"));
  if (oneTime) {
    if (!localTime) return { ok: false, questions: ["What local time should this one-time loop run?"] };
    const month = MONTHS[oneTime[1].toLowerCase()];
    const day = Number(oneTime[2]);
    let year = oneTime[3] ? Number(oneTime[3]) : now.getUTCFullYear();
    let runAt = zonedLocalToUtc(year, month, day, localTime, timezone);
    if (runAt.getTime() <= now.getTime() && !oneTime[3]) {
      year += 1;
      runAt = zonedLocalToUtc(year, month, day, localTime, timezone);
    }
    if (Number.isNaN(runAt.getTime()) || runAt.getTime() <= now.getTime()) {
      return { ok: false, questions: ["Choose a future date and time for this one-time loop."] };
    }
    return { ok: true, schedule: { kind: "once", timezone, localTime, runAt: runAt.toISOString(), humanLabel: `Once on ${oneTime[1]} ${day}, ${year} at ${humanTime(localTime)}` } };
  }

  if (/\bevery\s+weekday\b|\bweekdays\b/i.test(prompt)) {
    if (!localTime) return { ok: false, questions: ["What local time should this run every weekday?"] };
    return { ok: true, schedule: { kind: "weekday", timezone, localTime, humanLabel: `Every weekday at ${humanTime(localTime)}` } };
  }

  const weekdayName = WEEKDAYS.find((day) => new RegExp(`\\bevery\\s+${day}\\b`, "i").test(prompt));
  if (weekdayName) {
    if (!localTime) return { ok: false, questions: [`What local time should this run every ${weekdayName[0].toUpperCase()}${weekdayName.slice(1)}?`] };
    const weekday = WEEKDAYS.indexOf(weekdayName) + 1;
    return { ok: true, schedule: { kind: "weekly", timezone, localTime, weekday, humanLabel: `Every ${weekdayName[0].toUpperCase()}${weekdayName.slice(1)} at ${humanTime(localTime)}` } };
  }

  if (/\bevery\s+(?:day|morning|evening)\b|\bdaily\b/i.test(prompt)) {
    if (!localTime) return { ok: false, questions: ["What local time should this run every day?"] };
    return { ok: true, schedule: { kind: "daily", timezone, localTime, humanLabel: `Every day at ${humanTime(localTime)}` } };
  }

  if (/\bevery\s+week\b|\bweekly\b/i.test(prompt)) {
    return { ok: false, questions: ["Which weekday and local time should this run each week?"] };
  }
  if (/\bevery\s+month\b|\bmonthly\b/i.test(prompt)) {
    const ordinalDayMatch = prompt.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/i);
    const explicitDayMatch = prompt.match(/\bon\s+(?:the\s+)?(\d{1,2})\b/i);
    const dayOfMonth = ordinalDayMatch
      ? Number(ordinalDayMatch[1])
      : explicitDayMatch
        ? Number(explicitDayMatch[1])
        : null;
    if (!dayOfMonth || dayOfMonth > 28 || !localTime) return { ok: false, questions: ["Which day (1–28) and local time should this run each month?"] };
    return { ok: true, schedule: { kind: "monthly", timezone, localTime, dayOfMonth, humanLabel: `Every month on day ${dayOfMonth} at ${humanTime(localTime)}` } };
  }

  return { ok: false, questions: ["How often should this loop run?"] };
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

function zonedParts(date: Date, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const weekdayName = parts.find((part) => part.type === "weekday")?.value.toLowerCase().slice(0, 3);
  const weekday = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].indexOf(weekdayName ?? "") + 1;
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute"), weekday };
}

function zonedLocalToUtc(year: number, month: number, day: number, localTime: string, timezone: string): Date {
  const [hour, minute] = localTime.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = new Date(target);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(candidate, timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    candidate = new Date(candidate.getTime() + target - actualAsUtc);
  }
  const actual = zonedParts(candidate, timezone);
  return actual.year === year && actual.month === month && actual.day === day && actual.hour === hour && actual.minute === minute
    ? candidate
    : new Date(Number.NaN);
}

function addUtcDays(parts: ZonedParts, amount: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: ((date.getUTCDay() + 6) % 7) + 1 };
}

export function nextScheduleOccurrence(schedule: ScheduleDefinition, after: Date, anchor = after): Date | null {
  if (!isValidTimeZone(schedule.timezone)) throw new Error("Schedule timezone is invalid.");
  if (schedule.kind === "once") {
    const once = new Date(schedule.runAt ?? "");
    return once.getTime() > after.getTime() ? once : null;
  }
  if (schedule.kind === "hourly" || schedule.kind === "interval_hours") {
    const hours = schedule.kind === "hourly" ? 1 : schedule.intervalHours ?? 2;
    const intervalMs = hours * 60 * 60_000;
    const elapsed = Math.max(0, after.getTime() - anchor.getTime());
    return new Date(anchor.getTime() + (Math.floor(elapsed / intervalMs) + 1) * intervalMs);
  }
  const local = zonedParts(after, schedule.timezone);
  for (let offset = 0; offset <= 400; offset += 1) {
    const date = addUtcDays(local, offset);
    const matches = schedule.kind === "daily"
      || (schedule.kind === "weekday" && date.weekday <= 5)
      || (schedule.kind === "weekly" && date.weekday === schedule.weekday)
      || (schedule.kind === "monthly" && date.day === schedule.dayOfMonth);
    if (!matches || !schedule.localTime) continue;
    const candidate = zonedLocalToUtc(date.year, date.month, date.day, schedule.localTime, schedule.timezone);
    if (!Number.isNaN(candidate.getTime()) && candidate.getTime() > after.getTime()) return candidate;
  }
  return null;
}

export function latestDueOccurrence(
  schedule: ScheduleDefinition,
  firstDue: Date,
  now: Date,
  anchor: Date,
): { scheduledFor: Date; nextRunAt: Date | null; skippedEarlier: number } {
  let scheduledFor = firstDue;
  let next = nextScheduleOccurrence(schedule, scheduledFor, anchor);
  let skippedEarlier = 0;
  while (next && next.getTime() <= now.getTime() && skippedEarlier < 500) {
    scheduledFor = next;
    skippedEarlier += 1;
    next = nextScheduleOccurrence(schedule, scheduledFor, anchor);
  }
  return { scheduledFor, nextRunAt: next, skippedEarlier };
}
