const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export function normalizeTelemetryUuid(value?: string | null): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

export function normalizeTelemetryRequestId(value?: string | null): string | null {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value) ? value : null;
}

